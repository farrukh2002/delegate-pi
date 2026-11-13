#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSessionProjection, convertToLlm, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { activePath, DEFAULT_SESSIONS_DIR, listSessionFiles, loadEntries, tokens } from "./read-audit.mjs";

const AGE = 10;
const BATCH = 50;
const STUB_MIN_TOKENS = 75;
const STUB_ARG_CHARS = 200;
const TOKEN_RE = /[A-Za-z_$][\w$./-]{7,}/g;
const ARMS = ["F", "R", "T", "P"];
const RECALL_TOOL = {
	name: "recall",
	description:
		"Old tool outputs and long write/edit texts are removed from the context to save space. Each removed item shows a marker with a ref. recall(ref) returns the exact original text at once, without running anything. When you need the exact content of a removed item, call recall instead of running the tool again. Run the tool again only when the content may have changed since then (for example, a file edited later or a command whose output changes).",
	parameters: { type: "object", properties: { ref: { type: "string", description: "The ref shown in the removed-item marker" } }, required: ["ref"] },
};

function describeCall(call) {
	if (!call) return "";
	const a = call.arguments ?? {};
	const main = a.path ?? a.command ?? a.pattern ?? a.query ?? Object.values(a).find((v) => typeof v === "string") ?? "";
	return ` ${call.name}(${String(main).replace(/\s+/g, " ").slice(0, 120)})`;
}

function parseArgs(argv) {
	const o = { models: [], arms: ARMS, perModel: 2, runs: 1, out: "prune-replay.jsonl", dryRun: false, report: false, sessionsDir: DEFAULT_SESSIONS_DIR };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--model") o.models.push(argv[++i]);
		else if (a === "--per-model") o.perModel = Number(argv[++i]);
		else if (a === "--arms") o.arms = argv[++i].split(",");
		else if (a === "--runs") o.runs = Number(argv[++i]);
		else if (a === "--out") o.out = path.resolve(argv[++i]);
		else if (a === "--dry-run") o.dryRun = true;
		else if (a === "--distinct") o.distinct = true;
		else if (a === "--report") o.report = true;
		else o.sessionsDir = path.resolve(a);
	}
	return o;
}

const wordsOf = (text) => new Set(text.match(TOKEN_RE) ?? []);

function messageText(m) {
	if (typeof m.content === "string") return m.content;
	return (m.content ?? [])
		.map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? JSON.stringify(c.arguments ?? {}) : c.type === "thinking" ? c.thinking ?? "" : ""))
		.join("\n");
}

function actionOf(m) {
	const calls = (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => ({ name: c.name, arguments: c.arguments ?? {} }));
	const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
	return { calls, text };
}

function requestNumbers(pathEntries) {
	const born = new Map();
	let n = 0;
	for (const e of pathEntries) {
		born.set(e.id, n);
		if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) n++;
	}
	return born;
}

function buildArm(projection, born, k, arm) {
	const kind = arm[0];
	const cut = Math.floor(k / BATCH) * BATCH - (Number(arm.slice(1)) || AGE);
	const evictTools = kind === "T" || kind === "P";
	const stripThinking = kind === "R" || kind === "P" || kind === "E";
	const evicted = [];
	const kept = [];
	const calls = new Map();
	let addedRecall = false;
	const messages = [];
	for (const pe of projection.entries) {
		const id = pe.sourceEntry.id;
		const old = (born.get(id) ?? Infinity) < cut;
		for (const m of pe.messages) {
			let msg = m;
			if (msg.role === "assistant") for (const c of msg.content ?? []) if (c.type === "toolCall") calls.set(c.id, c);
			if (msg.role === "system" && !addedRecall) {
				msg = { ...msg, toolsAdded: [...(msg.toolsAdded ?? []), RECALL_TOOL] };
				addedRecall = true;
			} else if (old && msg.role === "toolResult" && evictTools) {
				const text = messageText(msg);
				if (tokens(text.length) >= STUB_MIN_TOKENS) {
					evicted.push(text);
					const first = text.split("\n").find((l) => l.trim()) ?? "";
					const stub = `[Removed output of${describeCall(calls.get(msg.toolCallId))}: ${text.split("\n").length} lines, first line: ${first.slice(0, 100)}. recall({"ref":"${id}"}) returns the exact text without running anything.]`;
					msg = { ...msg, content: [{ type: "text", text: stub }] };
				}
			} else if ((old || kind === "E") && msg.role === "assistant" && (evictTools || stripThinking)) {
				const content = [];
				for (const c of msg.content ?? []) {
					if (c.type === "thinking" && stripThinking) {
						evicted.push(c.thinking ?? "");
						continue;
					}
					if (c.type === "toolCall" && evictTools && (c.name === "write" || c.name === "edit")) {
						const args = JSON.parse(JSON.stringify(c.arguments ?? {}));
						const shrink = (v) => {
							if (typeof v === "string" && v.length > STUB_ARG_CHARS) {
								evicted.push(v);
								return `[Removed ${v.length} chars. recall({"ref":"${id}"}) returns the exact text.]`;
							}
							if (Array.isArray(v)) return v.map(shrink);
							if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, kk === "path" ? vv : shrink(vv)]));
							return v;
						};
						content.push({ ...c, arguments: shrink(args) });
						continue;
					}
					content.push(c);
				}
				msg = { ...msg, content };
			}
			messages.push(msg);
			kept.push(messageText(msg));
		}
	}
	return { messages, evictedText: evicted.join("\n"), keptText: kept.join("\n") };
}

async function selectPoints(options) {
	const byModel = new Map();
	for (const file of await listSessionFiles(options.sessionsDir)) {
		const entries = await loadEntries(file);
		const pathEntries = activePath(entries);
		const born = requestNumbers(pathEntries);
		for (const e of pathEntries) {
			const m = e.message;
			if (e.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
			const k = born.get(e.id);
			if (k < BATCH || k % BATCH > 3) continue;
			const key = `${m.provider}/${m.model}`;
			if (options.models.length && !options.models.includes(key)) continue;
			if (!byModel.has(key)) byModel.set(key, []);
			byModel.get(key).push({ file, entries, pathEntries, born, entry: e, k, key });
		}
	}
	const points = [];
	for (const [key, cands] of byModel) {
		const scored = [];
		for (const c of cands) {
			const projection = buildSessionProjection(c.entries, c.entry.parentId);
			const t = buildArm(projection, c.born, c.k, "T");
			const evictedWords = wordsOf(t.evictedText);
			const keptWords = wordsOf(t.keptText);
			const used = [...wordsOf(messageText(c.entry.message))].filter((w) => evictedWords.has(w) && !keptWords.has(w));
			scored.push({ ...c, projection, hard: used.length > 0, hardWords: used.slice(0, 10), evictedTokens: tokens(t.evictedText.length) });
		}
		const hard = scored.filter((s) => s.hard).sort((a, b) => b.evictedTokens - a.evictedTokens);
		const easy = scored.filter((s) => !s.hard && s.evictedTokens > 2000).sort((a, b) => b.evictedTokens - a.evictedTokens);
		const pick = [];
		const add = (c) => {
			if (!c || pick.length >= options.perModel || (options.distinct && pick.some((p) => p.file === c.file))) return;
			pick.push(c);
		};
		for (let i = 0; pick.length < options.perModel && (i < hard.length || i < easy.length); i++) {
			add(hard[i]);
			add(easy[i]);
		}
		points.push(...pick);
		if (pick.length < options.perModel) console.log(`${key}: only ${pick.length} points found`);
	}
	return points;
}

async function run(options) {
	const points = await selectPoints(options);
	const runtime = options.dryRun ? undefined : await ModelRuntime.create();
	let estCost = 0;
	for (const p of points) {
		const [provider, ...rest] = p.key.split("/");
		const modelId = rest.join("/");
		const u = p.entry.message.usage;
		const inRate = u.input > 0 ? u.cost.input / u.input : 0;
		console.log(`\n${p.key} k=${p.k} ${p.hard ? "HARD" : "easy"} ${path.basename(p.file)} evicted~${Math.round(p.evictedTokens)} tok words=${p.hardWords.join(",")}`);
		for (const arm of options.arms) {
			const built = buildArm(p.projection, p.born, p.k, arm);
			const promptTok = tokens(built.keptText.length);
			estCost += promptTok * inRate * options.runs;
			console.log(`  arm ${arm}: ~${Math.round(promptTok)} tok in logged content, worst-case cost ~$${(promptTok * inRate).toFixed(3)} per run`);
			if (options.dryRun) continue;
			const model = runtime.getModel(provider, modelId);
			if (!model) throw new Error(`model not found: ${p.key}`);
			for (let runNo = 0; runNo < options.runs; runNo++) {
				const started = Date.now();
				let res;
				try {
					res = await runtime.completeSimple(model, { messages: convertToLlm(built.messages) }, { reasoning: p.projection.thinkingLevel === "off" ? undefined : p.projection.thinkingLevel });
				} catch (error) {
					res = { content: [], stopReason: "error", errorMessage: String(error) };
				}
				const record = {
					model: p.key,
					file: path.basename(p.file),
					k: p.k,
					hard: p.hard,
					hardWords: p.hardWords,
					arm,
					run: runNo,
					ms: Date.now() - started,
					original: actionOf(p.entry.message),
					action: actionOf(res),
					stopReason: res.stopReason,
					error: res.errorMessage,
					usage: res.usage,
					evictedWords: [...wordsOf(built.evictedText)].filter((w) => !wordsOf(built.keptText).has(w)).slice(0, 4000),
				};
				await fs.appendFile(options.out, `${JSON.stringify(record)}\n`);
				const calls = record.action.calls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 80)})`).join(" ");
				console.log(`    run ${runNo}: ${res.stopReason} $${(res.usage?.cost?.total ?? 0).toFixed(4)} ${calls || record.action.text.slice(0, 100)}`);
			}
		}
	}
	console.log(`\nWorst-case estimate (all uncached): $${estCost.toFixed(2)}`);
	if (runtime) await runtime.settleCredentialWrites();
}

function similarity(a, b) {
	const wa = wordsOf(JSON.stringify(a));
	const wb = wordsOf(JSON.stringify(b));
	if (wa.size === 0 && wb.size === 0) return 1;
	let inter = 0;
	for (const w of wa) if (wb.has(w)) inter++;
	return inter / (wa.size + wb.size - inter);
}

async function report(options) {
	const rows = (await fs.readFile(options.out, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const stats = {};
	let cost = 0;
	for (const r of rows) {
		cost += r.usage?.cost?.total ?? 0;
		const s = (stats[r.arm] ??= { n: 0, sameTool: 0, sim: 0, recall: 0, guessed: 0, errors: 0 });
		s.n++;
		if (r.stopReason === "error") s.errors++;
		const o = r.original.calls.map((c) => c.name).join(",");
		const a = r.action.calls.map((c) => c.name).join(",");
		if (o === a) s.sameTool++;
		s.sim += similarity(r.original, r.action);
		if (r.action.calls.some((c) => c.name === "recall")) s.recall++;
		const ev = new Set(r.evictedWords);
		const out = wordsOf(JSON.stringify(r.action));
		if (r.arm !== "F" && !r.action.calls.some((c) => c.name === "recall") && [...out].some((w) => ev.has(w))) s.guessed++;
	}
	console.log(`rows ${rows.length}, spent $${cost.toFixed(2)}`);
	console.log(`${"arm".padEnd(5)}${"n".padStart(4)}${"same tool".padStart(11)}${"arg sim".padStart(9)}${"recall".padStart(8)}${"guessed".padStart(9)}${"errors".padStart(8)}`);
	for (const arm of Object.keys(stats)) {
		const s = stats[arm];
		if (!s) continue;
		console.log(
			`${arm.padEnd(5)}${String(s.n).padStart(4)}${`${Math.round((100 * s.sameTool) / s.n)}%`.padStart(11)}${(s.sim / s.n).toFixed(2).padStart(9)}${String(s.recall).padStart(8)}${String(s.guessed).padStart(9)}${String(s.errors).padStart(8)}`,
		);
	}
}

const options = parseArgs(process.argv.slice(2));
(options.report ? report(options) : run(options)).catch((error) => {
	console.error(error);
	process.exit(1);
});
