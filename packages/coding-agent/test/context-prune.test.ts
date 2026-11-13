import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	CUT_LINE_CHARS,
	CUT_MAX_CHARS,
	cutOutput,
	isCold,
	nextCut,
	PRUNE_AGE,
	pruneContext,
	type RecallStore,
} from "../src/extensions/context-prune/index.ts";

const big = (label: string) => `${label}\n${"x".repeat(400)}`;
const HOUR = 3_600_000;

function turn(i: number, tool = "read"): AgentMessage[] {
	const args = tool === "write" ? { path: `f${i}.ts`, content: big(`content ${i}`) } : { path: `f${i}.ts` };
	return [
		{
			role: "assistant",
			timestamp: i * 10,
			content: [
				{ type: "thinking", thinking: `think ${i}` },
				{ type: "toolCall", id: `c${i}`, name: tool, arguments: args },
			],
		},
		{
			role: "toolResult",
			timestamp: i * 10 + 5,
			toolCallId: `c${i}`,
			toolName: tool,
			content: [{ type: "text", text: big(`result ${i}`) }],
		},
	] as unknown as AgentMessage[];
}

function session(turns: number, tool?: (i: number) => string): AgentMessage[] {
	const messages = [{ role: "user", timestamp: -1, content: "go" }] as unknown as AgentMessage[];
	for (let i = 0; i < turns; i++) messages.push(...turn(i, tool?.(i)));
	return messages;
}

const resultText = (m: AgentMessage) => (m as unknown as { content: { text: string }[] }).content[0].text;
const types = (m: AgentMessage) => (m as unknown as { content: { type: string }[] }).content.map((c) => c.type);

describe("nextCut", () => {
	it("returns 0 until the context has more than PRUNE_AGE assistant messages", () => {
		expect(nextCut(session(PRUNE_AGE))).toBe(0);
		expect(nextCut(session(PRUNE_AGE + 7))).toBe(70);
	});
});

describe("isCold", () => {
	it("is true only after a long pause on a provider with a known cache lifetime", () => {
		const messages = session(3);
		expect(isCold(messages, "zai/glm-5.3", 20 + HOUR + 1)).toBe(true);
		expect(isCold(messages, "zai/glm-5.3", 20 + HOUR - 1)).toBe(false);
		expect(isCold(messages, "deepseek/deepseek-flash", 20 + 10 * HOUR)).toBe(false);
	});
});

describe("cutOutput", () => {
	const numbered = (n: number, width = 150) => Array.from({ length: n }, (_, i) => `line ${i} ${"y".repeat(width)}`);

	it("keeps short outputs unchanged", () => {
		expect(cutOutput(numbered(30).join("\n"), "r1")).toBeUndefined();
	});

	it("keeps the first 40 and last 30 lines of a long output", () => {
		const lines = numbered(200);
		const out = cutOutput(lines.join("\n"), "r1")?.split("\n") ?? [];
		expect(out.slice(0, 40)).toEqual(lines.slice(0, 40));
		expect(out[40]).toBe('[130 lines removed here. recall({"ref":"r1"}) returns the full output.]');
		expect(out.slice(41)).toEqual(lines.slice(-30));
	});

	it("shortens long lines and says so", () => {
		const out = cutOutput(`ok\n${"z".repeat(CUT_LINE_CHARS + 50)}`, "r2") ?? "";
		expect(out).toContain(`${"z".repeat(CUT_LINE_CHARS)}…[+50 chars]`);
		expect(out.endsWith('[Long lines were shortened. recall({"ref":"r2"}) returns the full output.]')).toBe(true);
	});

	it("cuts the middle of a long output with few lines", () => {
		const out = cutOutput(numbered(60, 300).join("\n"), "r3") ?? "";
		expect(out.length).toBeLessThan(CUT_MAX_CHARS + 200);
		expect(out).toContain('chars removed here. recall({"ref":"r3"})');
	});
});

describe("pruneContext", () => {
	it("serves the full text of a cut output from details, also after a stub", () => {
		const messages = session(30);
		const result = messages[2] as unknown as { details?: unknown; content: { text: string }[] };
		result.details = { fullOutput: "FULL" };
		const store: RecallStore = new Map();
		pruneContext(messages, store, 0, "deepseek/deepseek-flash");
		expect(store.get("c0")).toEqual(["FULL"]);
		const later: RecallStore = new Map();
		pruneContext(messages, later, nextCut(messages), "deepseek/deepseek-flash");
		expect(later.get("c0")).toEqual(["FULL"]);
		expect(result.content[0].text).toContain("[Removed output");
	});

	it("changes nothing without a cut on a model that keeps reasoning", () => {
		const messages = session(30);
		const before = structuredClone(messages);
		pruneContext(messages, new Map(), 0, "deepseek/deepseek-flash");
		expect(messages).toEqual(before);
	});

	it("stubs results older than the cut, keeps newer ones, and stores the originals", () => {
		const messages = session(30);
		const store: RecallStore = new Map();
		pruneContext(messages, store, nextCut(messages), "deepseek/deepseek-flash");
		expect(resultText(messages[2])).toContain(
			'[Removed output of read(f0.ts): 2 lines, first line: result 0. recall({"ref":"c0"})',
		);
		expect(store.get("c0")).toEqual([big("result 0")]);
		expect(resultText(messages[2 * 9 + 2])).toContain("[Removed output");
		expect(resultText(messages[2 * 10 + 2])).toBe(big("result 10"));
		expect(store.size).toBe(10);
		expect(types(messages[1])).toEqual(["toolCall"]);
		expect(types(messages[2 * 10 + 1])).toEqual(["thinking", "toolCall"]);
	});

	it("removes all reasoning on glm-5.3 but keeps recent tool results", () => {
		const messages = session(5);
		pruneContext(messages, new Map(), 0, "zai/glm-5.3");
		for (let i = 0; i < 5; i++) {
			expect(types(messages[2 * i + 1])).toEqual(["toolCall"]);
			expect(resultText(messages[2 * i + 2])).toBe(big(`result ${i}`));
		}
	});

	it("shrinks long write arguments but keeps the path", () => {
		const messages = session(30, () => "write");
		const store: RecallStore = new Map();
		pruneContext(messages, store, nextCut(messages), "deepseek/deepseek-flash");
		const call = (messages[1] as unknown as { content: { arguments: Record<string, string> }[] }).content[0];
		expect(call.arguments.path).toBe("f0.ts");
		expect(call.arguments.content).toBe('[Removed 410 chars. recall({"ref":"c0"}) returns the exact text.]');
		expect(store.get("c0")).toEqual([`content:\n${big("content 0")}`, big("result 0")]);
	});

	it("keeps the sent prefix byte-identical as new messages arrive under the same cut", () => {
		for (const model of ["zai/glm-5.3", "deepseek/deepseek-flash"]) {
			const cut = nextCut(session(30));
			const a = session(30);
			const b = session(45);
			pruneContext(a, new Map(), cut, model);
			pruneContext(b, new Map(), cut, model);
			expect(JSON.stringify(b.slice(0, a.length))).toBe(JSON.stringify(a));
		}
	});
});
