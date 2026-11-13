#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".delegate-pi/agent/sessions");
const CHARS_PER_TOKEN = 4;
const STALE_AFTER_REQUESTS = 20;
const OVERSIZE_CHARS = 8000;
const EDIT_ANCHOR_CHARS = 300;
const BASH_READ =
	/^\s*(?:cd\s+\S+\s*&&\s*)?(cat|nl(?:\s+-ba)?|head(?:\s+-n\s*\d+|\s+-\d+)?|tail(?:\s+-n\s*\d+|\s+-\d+)?|sed\s+-n\s+'[^']*'|sed\s+-n\s+"[^"]*")\s+([^\s|;&<>]+)\s*$/;
const SUBCOMMAND_TOOLS = new Set(["git", "npm", "pnpm", "npx", "bun", "cargo", "gh", "docker", "adb", "flutter", "go", "uv", "pip", "systemctl", "journalctl"]);
const AGE_BUCKETS = [5, 20, 50, 100, Infinity];

const LEVERS = {
	"delta-reads": ["lossless", "Return 'unchanged' or a diff for file lines already in context"],
	"dedupe-repeats": ["lossless", "Collapse identical repeated tool results"],
	"cwd-prefix": ["lossless", "Print paths relative to the session cwd"],
	"grep-path-group": ["lossless", "Group consecutive grep/rg matches under one path header"],
	"dup-lines": ["lossless", "Collapse repeated lines inside one tool result"],
	"ansi-progress": ["lossless", "Strip ANSI codes and \\r progress redraws"],
	"trailing-ws": ["lossless", "Strip trailing whitespace in tool output"],
	"error-inputs": ["context", "Drop arguments of failed tool calls after the error"],
	"outdated-reads": ["context", "Drop read copies made outdated by a later edit/write of the file"],
	"stale-tool-results": ["recall", `Evict tool results older than ${STALE_AFTER_REQUESTS} requests behind a recall handle`],
	"oversized-results": ["recall", `Cap single tool results at ${OVERSIZE_CHARS} chars, rest behind a recall handle`],
};

function parseArgs(argv) {
	const options = { sessionsDir: DEFAULT_SESSIONS_DIR, top: 10, json: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--top") options.top = Number(argv[++i]);
		else options.sessionsDir = path.resolve(arg);
	}
	return options;
}

async function listSessionFiles(dir) {
	const out = [];
	for (const item of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, item.name);
		if (item.isDirectory()) out.push(...(await listSessionFiles(full)));
		else if (item.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

async function loadEntries(file) {
	const entries = [];
	for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {}
	}
	return entries;
}

const tokens = (chars) => chars / CHARS_PER_TOKEN;
const bump = (obj, k, v) => {
	obj[k] = (obj[k] ?? 0) + v;
};

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function activePath(entries) {
	const byId = new Map();
	let leaf;
	for (const e of entries) {
		if (!e.id) continue;
		byId.set(e.id, e);
		leaf = e;
	}
	const out = [];
	for (let e = leaf; e; e = e.parentId ? byId.get(e.parentId) : undefined) out.push(e);
	return out.reverse();
}

function modelKey(msg) {
	return `${msg.provider}/${msg.model}`;
}

function collectRates(entries, rates) {
	for (const e of entries) {
		const msg = e.message;
		if (e.type !== "message" || msg?.role !== "assistant" || !msg.usage) continue;
		const u = msg.usage;
		const r = (rates[modelKey(msg)] ??= { input: [0, 0], cacheRead: [0, 0], output: [0, 0] });
		for (const k of ["input", "cacheRead", "output"]) {
			if ((u[k] ?? 0) > 0 && (u.cost?.[k] ?? 0) > 0) {
				r[k][0] += u.cost[k];
				r[k][1] += u[k];
			}
		}
	}
}

function rateOf(rates, msg, kind) {
	const r = rates[modelKey(msg)]?.[kind];
	return r && r[1] > 0 ? r[0] / r[1] : 0;
}

function bashFamily(command) {
	let cmd = command.trim();
	for (;;) {
		const next = cmd
			.replace(/^cd\s+\S+\s*(&&|;)\s*/, "")
			.replace(/^[A-Z_][A-Z0-9_]*=\S*\s+/, "")
			.replace(/^(timeout\s+\S+|sudo|env|time|nice)\s+/, "");
		if (next === cmd) break;
		cmd = next;
	}
	const first = cmd.split(/\s*(?:\||&&|;)\s*/)[0];
	const words = first.split(/\s+/).filter(Boolean);
	if (words.length === 0) return "(empty)";
	const tool = path.basename(words[0]);
	if (!SUBCOMMAND_TOOLS.has(tool)) return tool;
	let i = 1;
	while (i < words.length && words[i].startsWith("-")) i += words[i] === "-C" || words[i] === "--prefix" ? 2 : 1;
	return words[i] ? `${tool} ${words[i]}` : tool;
}

function outputLevers(text, cwd) {
	const save = {};
	if (cwd && cwd !== "/") {
		const needle = `${cwd}/`;
		let n = 0;
		for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
		if (n > 0) save["cwd-prefix"] = n * needle.length;
	}
	const lines = text.split("\n");
	let groupChars = 0;
	let prevPath;
	const counts = new Map();
	let ws = 0;
	let ansi = 0;
	for (const line of lines) {
		const m = /^([^\s:]+):\d+[:-]/.exec(line);
		if (m && m[1] === prevPath) groupChars += m[1].length + 1;
		prevPath = m?.[1];
		const t = line.trim();
		if (t.length >= 8) counts.set(t, (counts.get(t) ?? 0) + 1);
		const tw = /[ \t]+$/.exec(line);
		if (tw) ws += tw[0].length;
		for (const a of line.matchAll(/\x1b\[[0-9;?]*[A-Za-z]/g)) ansi += a[0].length;
		const cr = line.lastIndexOf("\r");
		if (cr > 0) ansi += cr;
	}
	let dup = 0;
	for (const [t, n] of counts) if (n > 1) dup += (n - 1) * (t.length + 1);
	if (groupChars) save["grep-path-group"] = groupChars;
	if (dup) save["dup-lines"] = dup;
	if (ws) save["trailing-ws"] = ws;
	if (ansi) save["ansi-progress"] = ansi;
	if (text.length > OVERSIZE_CHARS) save["oversized-results"] = text.length - OVERSIZE_CHARS;
	for (const k of Object.keys(save)) save[k] = tokens(save[k]);
	return save;
}

function readTarget(toolName, args, cwd) {
	if (toolName === "read" && typeof args?.path === "string") {
		return { kind: "read", file: path.resolve(cwd, args.path), stripNumbers: false };
	}
	if (toolName === "bash" && typeof args?.command === "string") {
		const m = BASH_READ.exec(args.command);
		if (m) return { kind: "bash-read", file: path.resolve(cwd, m[2]), stripNumbers: m[1].startsWith("nl") };
	}
	return undefined;
}

function newResult() {
	return {
		stats: {},
		exposure: {},
		exposureCost: {},
		inserted: {},
		saveTokens: {},
		saveCost: {},
		ageCost: {},
		bash: {},
		output: {},
		cache: {},
	};
}

function analyzeSession(entries, rates) {
	const header = entries.find((e) => e.type === "session");
	const cwd = header?.cwd ?? "/";
	const pathEntries = activePath(entries);
	const indexOf = new Map(pathEntries.map((e, i) => [e.id, i]));
	const r = newResult();
	const s = r.stats;
	const calls = new Map();
	const callOwner = new Map();
	const live = new Map();
	const liveTotals = {};
	const liveSave = {};
	const seen = new Map();
	const liveKeys = new Map();
	const knownFiles = new Set();
	let requestNo = 0;
	let prev;
	let compactedSinceRequest = false;

	const changeLines = (file, lines, sign) => {
		let m = seen.get(file);
		if (!m) seen.set(file, (m = new Map()));
		for (const line of lines) {
			const n = (m.get(line) ?? 0) + sign;
			if (n > 0) m.set(line, n);
			else m.delete(line);
		}
	};
	const add = (id, idx, cats, extra = {}) => {
		const block = { idx, cats, save: {}, born: requestNo, ...extra };
		live.set(id, block);
		for (const [cat, t] of Object.entries(cats)) {
			bump(liveTotals, cat, t);
			bump(r.inserted, cat, t);
		}
		if (block.file) changeLines(block.file, block.lines, 1);
		if (block.key) bump(liveKeys, block.key, 1);
		return block;
	};
	const addSave = (id, lever, t) => {
		const block = live.get(id);
		if (!block || t <= 0) return;
		const add = Math.min(t, block.tokens ?? t) - (block.save[lever] ?? 0);
		if (add <= 0) return;
		block.save[lever] = (block.save[lever] ?? 0) + add;
		bump(liveSave, lever, add);
	};
	const remove = (id) => {
		const block = live.get(id);
		if (!block) return;
		live.delete(id);
		for (const [cat, t] of Object.entries(block.cats)) bump(liveTotals, cat, -t);
		for (const [lever, t] of Object.entries(block.save)) bump(liveSave, lever, -t);
		if (block.file) changeLines(block.file, block.lines, -1);
		if (block.key) bump(liveKeys, block.key, -1);
	};
	const markOutdated = (file) => {
		for (const [id, block] of live) if (block.file === file) addSave(id, "outdated-reads", block.tokens);
	};

	for (const [idx, e] of pathEntries.entries()) {
		if (e.type === "compaction") {
			const keptIdx = indexOf.get(e.firstKeptEntryId) ?? idx;
			for (const [id, block] of [...live]) if (block.idx < keptIdx) remove(id);
			add(e.id, idx, { summary: tokens((e.summary ?? "").length) });
			if (e.usage?.cost) bump(r.cache, "compaction LLM calls", e.usage.cost.total ?? 0);
			compactedSinceRequest = true;
			continue;
		}
		if (e.type === "context_edit") {
			if (e.replacement === null) remove(e.targetId);
			continue;
		}
		if (e.type === "custom_message") {
			add(e.id, idx, { custom: tokens(textOf(e.content).length) });
			continue;
		}
		if (e.type !== "message") continue;
		const msg = e.message;

		if (msg.role === "assistant") {
			const u = msg.usage;
			if (u) {
				const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				const promptCost = (u.cost?.input ?? 0) + (u.cost?.cacheRead ?? 0) + (u.cost?.cacheWrite ?? 0);
				const rate = prompt > 0 ? promptCost / prompt : 0;
				requestNo++;
				bump(s, "requests", 1);
				bump(s, "promptTokens", prompt);
				bump(s, "promptCost", promptCost);
				bump(s, "outputCost", u.cost?.output ?? 0);
				bump(s, "cacheWriteCost", u.cost?.cacheWrite ?? 0);
				for (const [cat, t] of Object.entries(liveTotals)) {
					if (t <= 0) continue;
					bump(r.exposure, cat, t);
					bump(r.exposureCost, cat, t * rate);
					bump(s, "estLive", t);
				}
				for (const [lever, t] of Object.entries(liveSave)) {
					if (t <= 0) continue;
					bump(r.saveTokens, lever, t);
					bump(r.saveCost, lever, t * rate);
				}
				for (const block of live.values()) {
					const levers = Object.values(block.save).reduce((a, b) => a + b, 0) + (block.stub ?? 0);
					const stale = block.tool && requestNo - block.born > STALE_AFTER_REQUESTS;
					const best = stale ? block.tokens : Math.min(block.tokens ?? 0, levers);
					bump(s, "bestTokens", best);
					bump(s, "bestCost", best * rate);
					if (!block.tool) continue;
					const age = requestNo - block.born;
					const bucket = AGE_BUCKETS.find((b) => age <= b);
					bump(r.ageCost, String(bucket), block.tokens * rate);
					if (block.fam) r.bash[block.fam].cost += block.tokens * rate;
					if (age > STALE_AFTER_REQUESTS) {
						bump(r.saveTokens, "stale-tool-results", block.tokens);
						bump(r.saveCost, "stale-tool-results", block.tokens * rate);
					}
				}

				const outRate = rateOf(rates, msg, "output");
				const reasoning = u.reasoning ?? 0;
				bump(r.output, "reasoning tokens", reasoning * outRate);
				bump(r.output, "visible output tokens", Math.max(0, (u.output ?? 0) - reasoning) * outRate);

				if (prev && prev.model === modelKey(msg)) {
					const missed = Math.max(0, Math.min(prev.prompt, prompt) - (u.cacheRead ?? 0));
					const extra = missed * Math.max(0, rateOf(rates, msg, "input") - rateOf(rates, msg, "cacheRead"));
					if (missed > 0) {
						const gap = (msg.timestamp ?? 0) - prev.time;
						const cause = compactedSinceRequest
							? "after compaction"
							: gap > 3600_000
								? "idle > 1h"
								: gap > 300_000
									? "idle 5m-1h"
									: "unexplained";
						bump(r.cache, `miss: ${cause}`, extra);
					}
				} else if (prev) {
					bump(r.cache, "miss: model switch", (u.input ?? 0) * Math.max(0, rateOf(rates, msg, "input") - rateOf(rates, msg, "cacheRead")));
				}
				prev = { model: modelKey(msg), prompt, time: msg.timestamp ?? 0 };
				compactedSinceRequest = false;
			}

			const cats = {};
			let text = 0;
			for (const c of msg.content ?? []) {
				if (c.type === "text") text += c.text.length;
				if (c.type !== "toolCall") continue;
				calls.set(c.id, c);
				callOwner.set(c.id, e.id);
				const argChars = JSON.stringify(c.arguments ?? {}).length;
				bump(cats, `assistant:args:${c.name}`, tokens(argChars));
				const outRate = u ? rateOf(rates, msg, "output") : 0;
				const a = c.arguments ?? {};
				if (c.name === "write" && typeof a.content === "string") {
					const file = path.resolve(cwd, a.path ?? "");
					const kind = knownFiles.has(file) ? "write over a known file" : "write of a new file";
					bump(r.output, kind, tokens(a.content.length) * outRate);
				}
				if (c.name === "edit") {
					const edits = Array.isArray(a.edits) ? a.edits : [a];
					for (const ed of edits) {
						const len = typeof ed.oldText === "string" ? ed.oldText.length : typeof ed.old_string === "string" ? ed.old_string.length : 0;
						if (len > EDIT_ANCHOR_CHARS) bump(r.output, `edit anchor chars over ${EDIT_ANCHOR_CHARS}`, tokens(len - EDIT_ANCHOR_CHARS) * outRate);
					}
				}
			}
			if (text) cats["assistant:text"] = tokens(text);
			const block = add(e.id, idx, cats);
			block.tokens = Object.values(cats).reduce((a, b) => a + b, 0);
			const stubbable = (cats["assistant:args:write"] ?? 0) + (cats["assistant:args:edit"] ?? 0);
			if (stubbable > 0) block.stub = Math.max(0, stubbable - 20);
			continue;
		}

		if (msg.role === "system") {
			remove("system");
			const text = msg.content || Object.values(msg.sections ?? {}).join("\n");
			add("system", Number.MAX_SAFE_INTEGER, { system: tokens(text.length) });
			continue;
		}

		if (msg.role === "user") {
			add(e.id, idx, { user: tokens(textOf(msg.content).length) });
			continue;
		}

		if (msg.role !== "toolResult") continue;
		const call = calls.get(msg.toolCallId);
		const args = call?.arguments ?? {};
		const text = textOf(msg.content);
		const resultTokens = tokens(text.length);
		const target = msg.isError ? undefined : readTarget(msg.toolName, args, cwd);

		if (msg.isError && callOwner.has(msg.toolCallId)) {
			addSave(callOwner.get(msg.toolCallId), "error-inputs", tokens(JSON.stringify(args).length));
		}

		if ((msg.toolName === "edit" || msg.toolName === "write") && !msg.isError && typeof args.path === "string") {
			const file = path.resolve(cwd, args.path);
			markOutdated(file);
			knownFiles.add(file);
		}

		if (msg.toolName === "bash" && typeof args.command === "string") {
			const fam = (r.bash[bashFamily(args.command)] ??= { calls: 0, chars: 0, max: 0, piped: 0, cost: 0 });
			fam.calls++;
			fam.chars += text.length;
			fam.max = Math.max(fam.max, text.length);
			if (/\|\s*(head|tail)\b/.test(args.command)) fam.piped++;
		}

		let block;
		if (!target) {
			const key = `${msg.toolName}\0${JSON.stringify(args)}\0${text}`;
			const repeat = (liveKeys.get(key) ?? 0) > 0;
			block = add(e.id, idx, { [repeat ? `${msg.toolName}:repeat` : msg.toolName]: resultTokens }, { key, tool: msg.toolName, tokens: resultTokens });
			if (repeat) addSave(e.id, "dedupe-repeats", resultTokens);
			else for (const [lever, t] of Object.entries(outputLevers(text, cwd))) addSave(e.id, lever, t);
		} else {
			knownFiles.add(target.file);
			const lines = text.split("\n").map((l) => (target.stripNumbers ? l.replace(/^\s*\d+\t/, "") : l));
			const known = new Map(seen.get(target.file) ?? []);
			let redundantChars = 0;
			for (const line of lines) {
				const n = known.get(line) ?? 0;
				if (n > 0) {
					known.set(line, n - 1);
					redundantChars += line.length + 1;
				}
			}
			const redundant = tokens(redundantChars);
			block = add(
				e.id,
				idx,
				{ [`${target.kind}:new`]: resultTokens - redundant, [`${target.kind}:redundant`]: redundant },
				{ file: target.file, lines, tool: msg.toolName, tokens: resultTokens },
			);
			addSave(e.id, "delta-reads", redundant);
			if (text.length > OVERSIZE_CHARS) addSave(e.id, "oversized-results", tokens(text.length - OVERSIZE_CHARS));
		}
		if (msg.toolName === "bash" && typeof args.command === "string") block.fam = bashFamily(args.command);
	}

	return r;
}

function merge(total, part) {
	for (const k of ["stats", "exposure", "exposureCost", "inserted", "saveTokens", "saveCost", "ageCost", "output", "cache"]) {
		for (const [key, v] of Object.entries(part[k])) total[k][key] = (total[k][key] ?? 0) + v;
	}
	for (const [fam, f] of Object.entries(part.bash)) {
		const t = (total.bash[fam] ??= { calls: 0, chars: 0, max: 0, piped: 0, cost: 0 });
		t.calls += f.calls;
		t.cost += f.cost;
		t.chars += f.chars;
		t.max = Math.max(t.max, f.max);
		t.piped += f.piped;
	}
}

const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "-");
const num = (n) => Math.round(n).toLocaleString("en-US");
const usd = (n) => `$${n.toFixed(2)}`;
const pad = (v, n) => String(v).padStart(n);

function printReport(total, sessions, top) {
	const s = total.stats;
	const allCost = s.promptCost + s.outputCost;
	console.log(`Sessions: ${sessions.length}   Requests: ${num(s.requests)}`);
	console.log(`Prompt: ${num(s.promptTokens)} tok, ${usd(s.promptCost)}   Output: ${usd(s.outputCost)}   Total: ${usd(allCost)}`);
	console.log(`Logged content covers ${pct(s.estLive, s.promptTokens)} of billed prompt tokens (rest: tool schemas, reasoning items, estimate error)`);

	console.log("\n== Prompt content by kind (re-billed on every request while in context; 4 chars/token)");
	console.log(`${"kind".padEnd(26)}${pad("inserted tok", 14)}${pad("re-billed tok", 16)}${pad("% prompt", 10)}${pad("est $", 10)}`);
	const cats = Object.keys(total.exposure).sort((a, b) => total.exposureCost[b] - total.exposureCost[a]);
	for (const cat of cats) {
		if (total.exposureCost[cat] < 0.01) continue;
		console.log(
			`${cat.padEnd(26)}${pad(num(total.inserted[cat] ?? 0), 14)}${pad(num(total.exposure[cat]), 16)}${pad(pct(total.exposure[cat], s.promptTokens), 10)}${pad(usd(total.exposureCost[cat]), 10)}`,
		);
	}

	console.log("\n== Bash output by command family");
	console.log(`${"family".padEnd(22)}${pad("calls", 7)}${pad("tok", 11)}${pad("avg tok", 9)}${pad("max tok", 9)}${pad("|head", 7)}${pad("re-billed $", 13)}${pad("% bash $", 10)}`);
	const bashCost = Object.values(total.bash).reduce((a, f) => a + f.cost, 0);
	for (const [fam, f] of Object.entries(total.bash).sort((a, b) => b[1].cost - a[1].cost).slice(0, 30)) {
		console.log(
			`${fam.slice(0, 21).padEnd(22)}${pad(f.calls, 7)}${pad(num(tokens(f.chars)), 11)}${pad(num(tokens(f.chars / f.calls)), 9)}${pad(num(tokens(f.max)), 9)}${pad(pct(f.piped, f.calls), 7)}${pad(usd(f.cost), 13)}${pad(pct(f.cost, bashCost), 10)}`,
		);
	}

	console.log("\n== Prompt-side saving levers (upper bounds, they overlap, do not add them up)");
	console.log(`${"lever".padEnd(20)}${pad("type", 10)}${pad("re-billed tok", 16)}${pad("est $", 10)}${pad("% total", 9)}  what`);
	for (const [lever, cost] of Object.entries(total.saveCost).sort((a, b) => b[1] - a[1])) {
		const [type, what] = LEVERS[lever] ?? ["?", ""];
		console.log(`${lever.padEnd(20)}${pad(type, 10)}${pad(num(total.saveTokens[lever]), 16)}${pad(usd(cost), 10)}${pad(pct(cost, allCost), 9)}  ${what}`);
	}
	console.log("types: lossless = same information; context = drop info the model no longer needs; recall = lossy unless the model fetches it back");
	console.log(
		`Best case, all levers plus write/edit argument stubs, no overlap: ${num(s.bestTokens)} tok (${pct(s.bestTokens, s.promptTokens)} of prompt), ${usd(s.bestCost)} (${pct(s.bestCost, allCost)} of total cost)`,
	);

	console.log("\n== Tool-result prompt cost by age (requests since the result arrived)");
	let lo = 0;
	const ageTotal = Object.values(total.ageCost).reduce((a, b) => a + b, 0);
	for (const b of AGE_BUCKETS) {
		const v = total.ageCost[String(b)] ?? 0;
		console.log(`${`${lo}-${b === Infinity ? "..." : b}`.padEnd(12)}${pad(usd(v), 10)}${pad(pct(v, ageTotal), 9)}`);
		lo = b + 1;
	}

	console.log("\n== Output side (billed once at output rate)");
	for (const [k, v] of Object.entries(total.output).sort((a, b) => b[1] - a[1])) {
		console.log(`${k.padEnd(34)}${pad(usd(v), 10)}${pad(pct(v, allCost), 9)}`);
	}

	console.log("\n== Cache (extra cost of missed prefix = missed tokens x (input rate - cache-read rate))");
	console.log(`${"cache writes billed".padEnd(34)}${pad(usd(s.cacheWriteCost ?? 0), 10)}${pad(pct(s.cacheWriteCost ?? 0, allCost), 9)}`);
	for (const [k, v] of Object.entries(total.cache).sort((a, b) => b[1] - a[1])) {
		console.log(`${k.padEnd(34)}${pad(usd(v), 10)}${pad(pct(v, allCost), 9)}`);
	}

	if (top > 0) {
		console.log(`\n== Top ${top} sessions by prompt cost`);
		const levers = ["stale-tool-results", "delta-reads", "cwd-prefix", "dup-lines"];
		console.log(`${pad("prompt $", 10)}${pad("req", 6)}${levers.map((l) => pad(l.slice(0, 11), 13)).join("")}  session`);
		for (const r of sessions.sort((a, b) => b.stats.promptCost - a.stats.promptCost).slice(0, top)) {
			console.log(
				`${pad(usd(r.stats.promptCost), 10)}${pad(r.stats.requests, 6)}${levers.map((l) => pad(pct(r.saveCost[l] ?? 0, r.stats.promptCost), 13)).join("")}  ${r.name}`,
			);
		}
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log("Usage: node scripts/read-audit.mjs [sessionsDir] [--top N] [--json]");
		console.log(`Default sessionsDir: ${DEFAULT_SESSIONS_DIR}`);
		return;
	}
	const files = await listSessionFiles(options.sessionsDir);
	const rates = {};
	const loaded = [];
	for (const file of files) {
		const entries = await loadEntries(file);
		collectRates(entries, rates);
		loaded.push([file, entries]);
	}
	const total = newResult();
	total.bash = {};
	const sessions = [];
	for (const [file, entries] of loaded) {
		const result = analyzeSession(entries, rates);
		if (!result.stats.requests) continue;
		result.name = path.relative(options.sessionsDir, file);
		sessions.push(result);
		merge(total, result);
	}
	if (options.json) console.log(JSON.stringify({ total, sessions }, null, 2));
	else printReport(total, sessions, options.top);
}

export { activePath, collectRates, listSessionFiles, loadEntries, rateOf, textOf, tokens, DEFAULT_SESSIONS_DIR };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
