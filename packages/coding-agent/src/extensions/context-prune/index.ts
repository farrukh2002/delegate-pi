import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";

export const RECALL_TOOL_NAME = "recall";
export const PRUNE_AGE = 20;
export const PRUNE_ENTRY_TYPE = "context-prune";
export const THINKING_FREE_MODELS = new Set(["zai/glm-5.3"]);
export const COLD_GAP_MS: Record<string, number> = { zai: 3_600_000 };
const MIN_RESULT_CHARS = 300;
const MIN_ARG_CHARS = 200;
export const CUT_TOOLS = new Set(["bash", "powershell"]);
export const CUT_MAX_CHARS = 8000;
export const CUT_LINE_CHARS = 400;
const CUT_HEAD_LINES = 40;
const CUT_TAIL_LINES = 30;

const RECALL_DESCRIPTION =
	"Old tool outputs, long write/edit texts and the middle of long command outputs are removed from the context to save space. Each removed item shows a marker with a ref. recall(ref) returns the exact original text at once, without running anything. When you need the exact content of a removed item, call recall instead of running the tool again. Run the tool again only when the content may have changed since then (for example, a file edited later or a command whose output changes).";

export type RecallStore = Map<string, string[]>;

function describeCall(call: ToolCall | undefined): string {
	if (!call) return "";
	const args: Record<string, unknown> = call.arguments ?? {};
	const main =
		args.path ??
		args.command ??
		args.pattern ??
		args.query ??
		Object.values(args).find((v) => typeof v === "string") ??
		"";
	return ` ${call.name}(${String(main).replace(/\s+/g, " ").slice(0, 120)})`;
}

function shrinkArgs(value: unknown, removed: string[], ref: string, key?: string): unknown {
	if (typeof value === "string") {
		if (key === "path" || value.length <= MIN_ARG_CHARS) return value;
		removed.push(key ? `${key}:\n${value}` : value);
		return `[Removed ${value.length} chars. recall({"ref":"${ref}"}) returns the exact text.]`;
	}
	if (Array.isArray(value)) return value.map((v) => shrinkArgs(v, removed, ref));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrinkArgs(v, removed, ref, k)]));
	}
	return value;
}

export function cutOutput(text: string, ref: string): string | undefined {
	let shortened = false;
	const lines = text.split("\n").map((line) => {
		if (line.length <= CUT_LINE_CHARS) return line;
		shortened = true;
		return `${line.slice(0, CUT_LINE_CHARS)}…[+${line.length - CUT_LINE_CHARS} chars]`;
	});
	const recall = `recall({"ref":"${ref}"}) returns the full output.`;
	let out = lines.join("\n");
	if (out.length > CUT_MAX_CHARS) {
		if (lines.length > CUT_HEAD_LINES + CUT_TAIL_LINES) {
			const removed = lines.length - CUT_HEAD_LINES - CUT_TAIL_LINES;
			return [
				...lines.slice(0, CUT_HEAD_LINES),
				`[${removed} lines removed here. ${recall}]`,
				...lines.slice(-CUT_TAIL_LINES),
			].join("\n");
		}
		const half = CUT_MAX_CHARS / 2;
		return `${out.slice(0, half)}\n[${out.length - CUT_MAX_CHARS} chars removed here. ${recall}]\n${out.slice(-half)}`;
	}
	if (!shortened) return undefined;
	out += `\n[Long lines were shortened. ${recall}]`;
	return out;
}

export function nextCut(messages: AgentMessage[]): number {
	const assistants = messages.filter((m) => m.role === "assistant");
	return assistants.length > PRUNE_AGE ? assistants[assistants.length - PRUNE_AGE].timestamp : 0;
}

export function isCold(messages: AgentMessage[], model: string, now: number): boolean {
	const gap = COLD_GAP_MS[model.split("/")[0]];
	const last = messages.findLast((m) => m.role === "assistant");
	return gap !== undefined && last !== undefined && now - last.timestamp > gap;
}

export function pruneContext(messages: AgentMessage[], store: RecallStore, cut: number, model: string): void {
	const stripAllThinking = THINKING_FREE_MODELS.has(model);
	const calls = new Map<string, ToolCall>();
	for (const message of messages) {
		const old = message.timestamp < cut;
		if (message.role === "assistant") {
			for (const c of message.content) if (c.type === "toolCall") calls.set(c.id, c);
			if (!old && !stripAllThinking) continue;
			const kept: AssistantMessage["content"] = [];
			for (const c of message.content) {
				if (c.type === "thinking") continue;
				if (old && c.type === "toolCall" && (c.name === "write" || c.name === "edit")) {
					const removed: string[] = [];
					const args = shrinkArgs(c.arguments, removed, c.id) as ToolCall["arguments"];
					if (removed.length > 0) {
						store.set(c.id, [...(store.get(c.id) ?? []), ...removed]);
						kept.push({ ...c, arguments: args });
						continue;
					}
				}
				kept.push(c);
			}
			if (kept.length > 0) message.content = kept;
			continue;
		}
		if (message.role !== "toolResult") continue;
		const full = (message.details as { fullOutput?: string } | undefined)?.fullOutput;
		if (full !== undefined) store.set(message.toolCallId, [...(store.get(message.toolCallId) ?? []), full]);
		if (!old) continue;
		const parts = message.content;
		if (parts.some((c) => c.type !== "text")) continue;
		const text = parts.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		if (text.length < MIN_RESULT_CHARS) continue;
		if (full === undefined) store.set(message.toolCallId, [...(store.get(message.toolCallId) ?? []), text]);
		const lines = text.split("\n");
		const first = lines.find((l) => l.trim()) ?? "";
		message.content = [
			{
				type: "text",
				text: `[Removed output of${describeCall(calls.get(message.toolCallId))}: ${lines.length} lines, first line: ${first.slice(0, 100)}. recall({"ref":"${message.toolCallId}"}) returns the exact text without running anything.]`,
			},
		];
	}
}

export function createContextPruneExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		if (process.env.PI_CONTEXT_PRUNE === "0") return;
		let store: RecallStore = new Map();
		let cut = 0;
		let compacted = false;
		pi.on("session_start", (_event, ctx) => {
			const saved = ctx.sessionManager
				.getBranch()
				.findLast((e) => e.type === "custom" && e.customType === PRUNE_ENTRY_TYPE);
			cut = saved?.type === "custom" ? ((saved.data as { cut?: number })?.cut ?? 0) : 0;
		});
		pi.on("session_compact", () => {
			compacted = true;
		});
		pi.on("tool_result", (event) => {
			if (!CUT_TOOLS.has(event.toolName) || event.parentToolCallId) return;
			const removed: string[] = [];
			const content = event.content.map((c) => {
				if (c.type !== "text") return c;
				const cut = cutOutput(c.text, event.toolCallId);
				if (cut === undefined) return c;
				removed.push(c.text);
				return { ...c, text: cut };
			});
			if (removed.length === 0) return;
			return {
				content,
				details: { ...(event.details as object | undefined), fullOutput: removed.join("\n") },
				structuredContent: event.structuredContent,
			};
		});
		pi.on("context", (event, ctx) => {
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			if (compacted || isCold(event.messages, model, Date.now())) {
				compacted = false;
				const next = nextCut(event.messages);
				if (next > cut) {
					cut = next;
					pi.appendEntry(PRUNE_ENTRY_TYPE, { cut });
				}
			}
			store = new Map();
			pruneContext(event.messages, store, cut, model);
		});
		pi.registerTool({
			name: RECALL_TOOL_NAME,
			label: RECALL_TOOL_NAME,
			description: RECALL_DESCRIPTION,
			parameters: Type.Object({ ref: Type.String({ description: "The ref shown in the removed-item marker" }) }),
			async execute(_toolCallId, params) {
				const texts = store.get(params.ref);
				const text = texts ? texts.join("\n\n") : `No removed item has the ref ${params.ref}.`;
				return { content: [{ type: "text", text }], details: undefined };
			},
		});
	};
}

export default createContextPruneExtension();
