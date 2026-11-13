#!/usr/bin/env node

import path from "node:path";
import {
	activePath,
	collectRates,
	DEFAULT_SESSIONS_DIR,
	listSessionFiles,
	loadEntries,
	rateOf,
	textOf,
	tokens,
} from "./read-audit.mjs";

const STUB_TOKENS = 25;
const MIN_EVICT_TOKENS = 50;
const RECALL_CALL_OUTPUT_TOKENS = 30;
const MAX_INDEX_PER_BLOCK = 300;
const TOKEN_RE = /[A-Za-z_$][\w$./-]{7,}/g;
const RESENT_THINKING_SIGNATURES = new Set(["reasoning_content", "reasoning", "reasoning_text"]);
const LEVER_SETS = {
	"tools+stubs": ["tool", "stub"],
	thinking: ["think"],
	all: ["tool", "stub", "think"],
};
const AGES = process.env.AGES ? process.env.AGES.split(",").map(Number) : [10, 20, 50];
const BATCHES = process.env.BATCHES ? process.env.BATCHES.split(",").map((b) => (/^\d+$/.test(b) ? Number(b) : b)) : [50, 100, "cold", "50+cold", "100+cold"];
const SAFE_GAP_MS = { zai: 3600_000 };

function wordsOf(text) {
	return new Set(text.match(TOKEN_RE) ?? []);
}

function assistantText(content) {
	return (content ?? [])
		.map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? JSON.stringify(c.arguments ?? {}) : ""))
		.join("\n");
}

function isBatch(batch, requestNo, cold, safe) {
	if (batch === "safe") return safe;
	if (batch === "each") return true;
	const [every, onCold] = String(batch).includes("+") ? [Number(String(batch).split("+")[0]), true] : batch === "cold" ? [Infinity, true] : [batch, false];
	return (onCold && cold) || requestNo % every === 0;
}

function simulate(entries, rates, { age, batch, levers }) {
	const pathEntries = activePath(entries);
	const indexOf = new Map(pathEntries.map((e, i) => [e.id, i]));
	const enabled = new Set(levers);
	const live = new Map();
	const tokIndex = new Map();
	const seenTok = new Set();
	const r = { baseCost: 0, simCost: 0, baseTokens: 0, simTokens: 0, recalls: 0, missCost: 0, evictedTools: 0, recallCost: 0 };
	const savedBy = { tool: 0, stub: 0, think: 0 };
	let liveSum = 0;
	let requestNo = 0;
	let prevPrompt = 0;
	let prevTime = 0;
	let compacted = false;

	const add = (id, block) => {
		live.set(id, { born: requestNo, parts: {}, evicted: new Set(), ...block });
		liveSum += block.tokens;
	};
	const remove = (id) => {
		const b = live.get(id);
		if (!b) return;
		liveSum -= b.tokens;
		live.delete(id);
	};
	const savedOf = (b) => {
		let s = 0;
		for (const p of b.evicted) s += b.parts[p];
		return s;
	};
	const learn = (text) => {
		for (const w of wordsOf(text)) seenTok.add(w);
	};

	for (const [idx, e] of pathEntries.entries()) {
		if (e.type === "compaction") {
			const keptIdx = indexOf.get(e.firstKeptEntryId) ?? idx;
			for (const [id, b] of [...live]) if (b.idx < keptIdx) remove(id);
			compacted = true;
			add(e.id, { idx, tokens: tokens((e.summary ?? "").length) });
			continue;
		}
		if (e.type === "context_edit") {
			if (e.replacement === null) remove(e.targetId);
			continue;
		}
		if (e.type === "custom_message") {
			const text = textOf(e.content);
			learn(text);
			add(e.id, { idx, tokens: tokens(text.length) });
			continue;
		}
		if (e.type !== "message") continue;
		const msg = e.message;

		if (msg.role === "assistant") {
			const u = msg.usage;
			const text = assistantText(msg.content);
			if (u) {
				requestNo++;
				const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				const baseCost = (u.cost?.input ?? 0) + (u.cost?.cacheRead ?? 0) + (u.cost?.cacheWrite ?? 0);
				const inRate = rateOf(rates, msg, "input");
				const crRate = rateOf(rates, msg, "cacheRead") || inRate;
				const outRate = rateOf(rates, msg, "output");
				const unlogged = Math.max(0, prompt - liveSum);
				const cold = prevPrompt > 0 && (u.cacheRead ?? 0) < 0.5 * Math.min(prevPrompt, prompt);
				prevPrompt = prompt;
				const gapLimit = SAFE_GAP_MS[msg.provider];
				const safe = compacted || (gapLimit !== undefined && prevTime > 0 && msg.timestamp - prevTime > gapLimit);
				compacted = false;
				prevTime = msg.timestamp;

				const evictedNow = [];
				if (isBatch(batch, requestNo, cold, safe)) {
					for (const b of live.values()) {
						if (requestNo - b.born <= age) continue;
						let any = false;
						for (const [part, t] of Object.entries(b.parts)) {
							if (!enabled.has(part) || b.evicted.has(part) || t < MIN_EVICT_TOKENS) continue;
							b.evicted.add(part);
							any = true;
							if (part === "tool") r.evictedTools++;
						}
						if (any) evictedNow.push(b);
					}
				}

				let saved = 0;
				for (const b of live.values()) {
					for (const p of b.evicted) {
						saved += b.parts[p];
						savedBy[p] += b.parts[p] * (cold ? inRate : crRate);
					}
				}
				const simPrompt = Math.max(0, prompt - saved);
				let cost = baseCost - saved * (cold ? inRate : crRate);

				if (evictedNow.length > 0 && !cold) {
					const firstIdx = Math.min(...evictedNow.map((b) => b.idx));
					let prefix = unlogged;
					for (const b of live.values()) if (b.idx < firstIdx) prefix += b.tokens - savedOf(b);
					const miss = Math.max(0, simPrompt - prefix) * Math.max(0, inRate - crRate);
					cost += miss;
					r.missCost += miss;
				}

				const used = wordsOf(text);
				let recalledTokens = 0;
				for (const w of used) {
					for (const id of tokIndex.get(w) ?? []) {
						const b = live.get(id);
						if (!b || !b.evicted.has("tool")) continue;
						b.evicted.delete("tool");
						b.born = requestNo;
						recalledTokens += b.parts.tool;
						r.recalls++;
					}
				}
				for (const w of used) tokIndex.delete(w);
				if (recalledTokens > 0) {
					const extra = simPrompt * crRate + recalledTokens * inRate + RECALL_CALL_OUTPUT_TOKENS * outRate;
					cost += extra;
					r.recallCost += extra;
				}

				r.baseCost += baseCost;
				r.simCost += cost;
				r.baseTokens += prompt;
				r.simTokens += simPrompt + (recalledTokens > 0 ? simPrompt + recalledTokens : 0);
			}
			learn(text);
			let all = 0;
			let stub = 0;
			let think = 0;
			for (const c of msg.content ?? []) {
				if (c.type === "text") all += tokens(c.text.length);
				if (c.type === "thinking" && RESENT_THINKING_SIGNATURES.has(c.thinkingSignature)) think += tokens((c.thinking ?? "").length);
				if (c.type !== "toolCall") continue;
				const t = tokens(JSON.stringify(c.arguments ?? {}).length);
				all += t;
				if (c.name === "write" || c.name === "edit") stub += t;
			}
			const parts = {};
			if (stub > STUB_TOKENS) parts.stub = stub - STUB_TOKENS;
			if (think > 0) parts.think = think;
			add(e.id, { idx, tokens: all + think, parts });
			continue;
		}

		if (msg.role === "system") {
			remove("system");
			const text = msg.content || Object.values(msg.sections ?? {}).join("\n");
			learn(text);
			add("system", { idx: -1, tokens: tokens(text.length) });
			continue;
		}

		const text = textOf(msg.content);
		if (msg.role === "user") {
			learn(text);
			add(e.id, { idx, tokens: tokens(text.length) });
			continue;
		}
		if (msg.role !== "toolResult") continue;
		let n = 0;
		for (const w of wordsOf(text)) {
			if (seenTok.has(w)) continue;
			seenTok.add(w);
			const ids = tokIndex.get(w) ?? [];
			ids.push(e.id);
			tokIndex.set(w, ids);
			if (++n >= MAX_INDEX_PER_BLOCK) break;
		}
		const t = tokens(text.length);
		add(e.id, { idx, tokens: t, parts: t > STUB_TOKENS ? { tool: t - STUB_TOKENS } : {} });
	}
	r.savedBy = savedBy;
	return r;
}

const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "-");
const usd = (n) => `$${n.toFixed(2)}`;
const pad = (v, n) => String(v).padStart(n);

async function main() {
	const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SESSIONS_DIR;
	const files = await listSessionFiles(dir);
	const rates = {};
	const sessions = [];
	let outputCost = 0;
	for (const file of files) {
		const entries = await loadEntries(file);
		collectRates(entries, rates);
		sessions.push(entries);
		for (const e of entries) if (e.type === "message" && e.message?.role === "assistant") outputCost += e.message.usage?.cost?.output ?? 0;
	}

	console.log("Batched eviction of parts older than A requests, at batch points B (N = every N requests, cold = when the cache already missed).");
	console.log("Evicted content saves the cache-read rate (input rate on cold requests); each warm batch re-writes the cache after the");
	console.log("first evicted block; each tool-result recall costs one extra request plus the result at the input rate.\n");
	console.log(
		`${"levers".padEnd(13)}${pad("A", 4)}${pad("B", 10)}${pad("prompt tok", 12)}${pad("saved $", 10)}${pad("% total", 9)}${pad("miss $", 9)}${pad("recall $", 10)}${pad("recalls", 9)}`,
	);
	const best = {};
	for (const [name, levers] of Object.entries(LEVER_SETS)) {
		for (const age of AGES) {
			for (const batch of BATCHES) {
				const t = { baseCost: 0, simCost: 0, baseTokens: 0, simTokens: 0, recalls: 0, missCost: 0, recallCost: 0 };
				const by = { tool: 0, stub: 0, think: 0 };
				for (const entries of sessions) {
					const r = simulate(entries, rates, { age, batch, levers });
					for (const k of Object.keys(t)) t[k] += r[k];
					for (const k of Object.keys(by)) by[k] += r.savedBy[k];
				}
				const saved = t.baseCost - t.simCost;
				const total = t.baseCost + outputCost;
				if (!best[name] || saved > best[name].saved) best[name] = { age, batch, saved, total, by, t };
				console.log(
					`${name.padEnd(13)}${pad(age, 4)}${pad(batch, 10)}${pad(pct(t.baseTokens - t.simTokens, t.baseTokens), 12)}${pad(usd(saved), 10)}${pad(pct(saved, total), 9)}${pad(usd(t.missCost), 9)}${pad(usd(t.recallCost), 10)}${pad(t.recalls, 9)}`,
				);
			}
		}
	}
	console.log("\nBest policy per lever set:");
	for (const [name, b] of Object.entries(best)) {
		console.log(
			`  ${name.padEnd(12)} A=${b.age} B=${b.batch}: ${usd(b.saved)} of ${usd(b.total)} (${pct(b.saved, b.total)} of total cost); gross by part: tool ${usd(b.by.tool)}, stub ${usd(b.by.stub)}, thinking ${usd(b.by.think)}`,
		);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
