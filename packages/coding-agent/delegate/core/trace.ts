/**
 * Claude-shaped JSONL for a delegated child, so TokenEconomizer can fold the child's work.
 *
 * A child runs a different provider in another process and is launched without a session log.
 * Its parsed events are the only record, so this writes the subset TE's trajectory reader uses:
 * the task prompt, assistant text/tool_use with usage, and tool results. The parent session's
 * usage entries carry the child's cost; this trace is for learning from its commands and
 * failures, not for billing.
 */
import * as fs from "node:fs";
import type { ChildEvent, UsageDelta } from "./types.ts";

const MAX_RESULT = 200_000;

export interface TraceWriter {
	event(event: ChildEvent): void;
	close(): void;
}

function claudeUsage(usage: UsageDelta) {
	return {
		input_tokens: usage.input ?? 0,
		output_tokens: usage.output ?? 0,
		cache_read_input_tokens: usage.cacheRead ?? 0,
		cache_creation_input_tokens: usage.cacheWrite ?? 0,
	};
}

/**
 * Open `file` for appending and return a writer for the child's events.
 *
 * `model` supplies the model for providers whose events do not name one (Codex reports usage on
 * a turn event, not on the message). A failed write disables the writer: a trace must never fail
 * the child.
 */
export function traceWriter(file: string, task: string, model?: () => string | undefined): TraceWriter {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "a", 0o600);
	} catch {
		fd = undefined;
	}
	let anon = 0;
	const seenTools = new Set<string>();
	const seenResults = new Set<string>();
	const write = (line: unknown) => {
		if (fd === undefined) return;
		try {
			fs.writeSync(fd, `${JSON.stringify(line)}\n`);
		} catch {
			fd = undefined;
		}
	};

	if (task.trim()) {
		write({ type: "user", message: { role: "user", content: task } });
	}

	return {
		event(event) {
			if (event.kind === "toolResult") {
				const key = event.toolCallId || `${event.name}\0${event.content}`;
				if (seenResults.has(key)) return;
				seenResults.add(key);
				write({
					type: "user",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: event.toolCallId ?? "",
								content: event.content.slice(-MAX_RESULT),
								...(event.isError ? { is_error: true } : {}),
							},
						],
					},
				});
				return;
			}
			if (event.kind !== "message") return;
			if (event.role === "assistant") {
				const content: unknown[] = [];
				for (const part of event.content) {
					if (part.type === "text") {
						if (part.text.trim()) content.push({ type: "text", text: part.text });
					} else if (part.type === "toolCall") {
						if (part.id && seenTools.has(part.id)) continue;
						if (part.id) seenTools.add(part.id);
						content.push({
							type: "tool_use",
							id: part.id ?? `toolu_${++anon}`,
							name: part.name,
							input: part.arguments,
						});
					}
				}
				if (!content.length && !event.usage) return;
				const name = event.model ?? model?.();
				write({
					type: "assistant",
					message: {
						role: "assistant",
						id: event.id ?? `assistant-${++anon}`,
						...(name ? { model: name } : {}),
						content,
						...(event.usage ? { usage: claudeUsage(event.usage) } : {}),
					},
				});
				return;
			}
			const text = event.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text.trim()) write({ type: "user", message: { role: "user", content: text } });
		},
		close() {
			if (fd === undefined) return;
			try {
				fs.closeSync(fd);
			} catch {
				// ignore
			}
			fd = undefined;
		},
	};
}
