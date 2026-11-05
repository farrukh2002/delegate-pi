import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildEvent, ProviderId, UsageDelta } from "./types.ts";

interface InvokeOptions {
	prompt: string;
	model?: string;
	tools?: string[];
	maxTurns?: number;
}

export interface Invocation {
	command: string;
	args: string[];
	flagOffset?: number;
}

export function insertInvocationFlags(invocation: Invocation, flags: string[]): Invocation {
	if (!flags.length) return invocation;
	const at = Math.min(Math.max(invocation.flagOffset ?? 0, 0), invocation.args.length);
	return { ...invocation, args: [...invocation.args.slice(0, at), ...flags, ...invocation.args.slice(at)] };
}

interface Provider {
	id: ProviderId;
	binary: string;
	describe: string;
	build(opts: InvokeOptions): Invocation;
	parse(event: unknown): ChildEvent[];
}

export function resolveOnPath(name: string): string | null {
	if (name.includes("/")) return fs.existsSync(name) ? name : null;
	const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

function piEntry(): string | undefined {
	const entry = process.env.DELEGATE_PI_ENTRY;
	return entry && entry.trim() ? entry.trim() : undefined;
}

export function piEntryProblem(): string | undefined {
	const entry = piEntry();
	if (!entry) return undefined;
	try {
		if (fs.statSync(entry).isFile()) return undefined;
		return `DELEGATE_PI_ENTRY is not a file: ${entry}`;
	} catch {
		return `DELEGATE_PI_ENTRY does not exist: ${entry}`;
	}
}

export function providerAvailable(id: ProviderId): boolean {
	if (id === "pi") {
		if (piEntryProblem()) return false;
		if (piEntry()) return true;
	}
	return resolveOnPath(PROVIDERS[id].binary) !== null;
}

function getPiInvocation(args: string[]): Invocation {
	const entry = piEntry();
	if (entry && fs.existsSync(entry)) {
		return { command: process.execPath, args: [entry, ...args], flagOffset: 1 };
	}

	const explicit = process.env.PI_BIN;
	if (explicit && fs.existsSync(explicit)) {
		return { command: explicit, args, flagOffset: 0 };
	}

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const looksLikePiEntry =
		Boolean(currentScript) &&
		(/(^|\/)pi-coding-agent\//.test(currentScript) || /(^|\/)bin\/pi$/.test(currentScript));
	if (currentScript && !isBunVirtualScript && looksLikePiEntry && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args], flagOffset: 1 };
	}

	return { command: "pi", args, flagOffset: 0 };
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, any> {
	return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				const p = asRecord(part);
				if (typeof p.text === "string") return p.text;
				if (typeof p.content === "string") return p.content;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (value && typeof value === "object") {
		const record = asRecord(value);
		if (typeof record.text === "string") return record.text;
		return JSON.stringify(value);
	}
	return "";
}

const piProvider: Provider = {
	id: "pi",
	binary: "pi",
	describe: "pi CLI, NDJSON event stream",
	build(opts) {
		const args = ["--mode", "json", "-p", "--no-mcp", "--no-extensions", "--no-session"];
		if (opts.model) args.push("--model", opts.model);
		if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
		args.push(opts.prompt);
		return getPiInvocation(args);
	},
	parse(event) {
		const e = asRecord(event);
		if (e.type === "message_end" && e.message) {
			const msg = asRecord(e.message);
			const role = msg.role === "user" ? "user" : "assistant";
			const content = Array.isArray(msg.content)
				? msg.content
						.map((part: any) => {
							const p = asRecord(part);
							if (p.type === "text" && typeof p.text === "string") return { type: "text" as const, text: p.text };
							if (p.type === "toolCall") {
								return {
									type: "toolCall" as const,
									name: String(p.name || "unknown"),
									arguments: asRecord(p.arguments),
								};
							}
							return null;
						})
						.filter((part): part is NonNullable<typeof part> => part !== null)
				: [];
			const usage = asRecord(msg.usage);
			const delta: UsageDelta | undefined =
				msg.usage && role === "assistant"
					? {
							input: num(usage.input),
							output: num(usage.output),
							cacheRead: num(usage.cacheRead),
							cacheWrite: num(usage.cacheWrite),
							cost: num(asRecord(usage.cost).total),
							contextTokens: num(usage.totalTokens),
						}
					: undefined;
			const events: ChildEvent[] = [
				{
					kind: "message",
					id: str(msg.id) ?? str(msg.responseId),
					role,
					content,
					usage: delta,
					model: str(msg.model),
					stopReason: str(msg.stopReason),
					errorMessage: str(msg.errorMessage),
				},
			];
			return events;
		}
		if (e.type === "tool_result_end" && e.message) {
			const text = textOf(asRecord(e.message).content);
			if (!text) return [];
			return [{ kind: "message", role: "user", content: [{ type: "text", text }] }];
		}
		return [];
	},
};

const claudeProvider: Provider = {
	id: "claude",
	binary: "claude",
	describe: "Claude Code, stream-json with exact cost",
	build(opts) {
		const args = [
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--strict-mcp-config",
			"--disallowedTools",
			"Task",
			"--no-session-persistence",
			"--dangerously-skip-permissions",
		];
		if (opts.model) args.push("--model", opts.model);
		if (opts.tools && opts.tools.length > 0) args.push("--allowedTools", opts.tools.join(","));
		if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
		args.push(opts.prompt);
		return { command: "claude", args };
	},
	parse(event) {
		const e = asRecord(event);
		if (e.type === "assistant" && e.message) {
			const msg = asRecord(e.message);
			const content = Array.isArray(msg.content)
				? msg.content
						.map((part: any) => {
							const p = asRecord(part);
							if (p.type === "text" && typeof p.text === "string") return { type: "text" as const, text: p.text };
							if (p.type === "tool_use") {
								return {
									type: "toolCall" as const,
									name: String(p.name || "unknown"),
									arguments: asRecord(p.input),
								};
							}
							return null;
						})
						.filter((part): part is NonNullable<typeof part> => part !== null)
				: [];
			const usage = asRecord(msg.usage);
			const delta: UsageDelta = {
				input: num(usage.input_tokens),
				output: num(usage.output_tokens),
				cacheRead: num(usage.cache_read_input_tokens),
				cacheWrite: num(usage.cache_creation_input_tokens),
				contextTokens:
					num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
			};
			return [
				{
					kind: "message",
					id: str(msg.id),
					role: "assistant",
					content,
					usage: delta,
					model: str(msg.model),
					stopReason: str(msg.stop_reason),
				},
			];
		}
		if (e.type === "user" && e.message) {
			const msg = asRecord(e.message);
			const text = textOf(
				Array.isArray(msg.content)
					? msg.content.map((part: any) => asRecord(part).content).filter(Boolean)
					: msg.content,
			);
			if (!text) return [];
			return [{ kind: "message", role: "user", content: [{ type: "text", text }] }];
		}
		if (e.type === "result") {
			const events: ChildEvent[] = [];
			const cost = num(e.total_cost_usd);
			if (cost > 0) events.push({ kind: "cost", costUsd: cost });
			if (e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success")) {
				events.push({
					kind: "info",
					text: str(e.result) || str(asRecord(e.error).message) || `stopped: ${String(e.subtype)}`,
				});
			}
			return events;
		}
		return [];
	},
};

const codexProvider: Provider = {
	id: "codex",
	binary: "codex",
	describe: "Codex exec, JSONL events, token totals only",
	build(opts) {
		const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox"];
		if (opts.model) args.push("--model", opts.model);
		args.push(opts.prompt);
		return { command: "codex", args };
	},
	parse(event) {
		const e = asRecord(event);
		if (e.type === "item.completed" || e.type === "item.started") {
			const item = asRecord(e.item);
			const itemType = str(item.type) || "item";
			if (itemType === "agent_message" && e.type === "item.completed") {
				const text = str(item.text) || "";
				if (!text) return [];
				return [{ kind: "message", role: "assistant", content: [{ type: "text", text }] }];
			}
			if (itemType === "reasoning") return [];
			const name = itemType === "command_execution" ? "bash" : itemType;
			const args = itemType === "command_execution" ? { command: str(item.command) || "" } : item;
			return [{ kind: "message", role: "assistant", content: [{ type: "toolCall", name, arguments: args }] }];
		}
		if (e.type === "turn.completed") {
			const usage = asRecord(e.usage);
			return [
				{
					kind: "message",
					role: "assistant",
					content: [],
					usage: {
						input: Math.max(0, num(usage.input_tokens) - num(usage.cached_input_tokens)),
						output: num(usage.output_tokens),
						cacheRead: num(usage.cached_input_tokens),
						cacheWrite: num(usage.cache_write_input_tokens),
						contextTokens: num(usage.input_tokens),
					},
				},
			];
		}
		if (e.type === "turn.failed" || e.type === "error") {
			const message = str(asRecord(e.error).message) || str(e.message) || "codex turn failed";
			return [{ kind: "message", role: "assistant", content: [], stopReason: "error", errorMessage: message }];
		}
		return [];
	},
};

const commandcodeProvider: Provider = {
	id: "commandcode",
	binary: "commandcode",
	describe: "Command Code, NDJSON events plus final result",
	build(opts) {
		const args = [
			"-p",
			"--output-format",
			"json",
			"--trust",
			"--skip-onboarding",
			"--no-auto-update",
			"--no-session",
			"--yolo",
			"--tools-all",
		];
		if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
		if (opts.model) args.push("--model", opts.model);
		args.push(opts.prompt);
		return { command: "commandcode", args };
	},
	parse(event) {
		const e = asRecord(event);
		if (e.type === "result") {
			const text = str(e.finalText) || "";
			const events: ChildEvent[] = [];
			if (text) events.push({ kind: "message", role: "assistant", content: [{ type: "text", text }] });
			events.push({
				kind: "message",
				role: "assistant",
				content: [],
				stopReason: e.subtype === "error" ? "error" : undefined,
				errorMessage: e.subtype === "error" ? text || "commandcode error" : undefined,
			});
			return events;
		}
		if (e.type === "event") {
			const inner = asRecord(e.event);
			const innerType = str(inner.type) || "";
			if (innerType === "run_end") return [];
			if (innerType === "model_request_end") {
				const usage = asRecord(inner.usage);
				const cached = num(usage.cacheReadTokens);
				const total = num(usage.inputTokens);
				return [
					{
						kind: "message",
						role: "assistant",
						content: [],
						usage: {
							input: Math.max(0, total - cached),
							output: num(usage.outputTokens),
							cacheRead: cached,
							cacheWrite: num(usage.cacheWriteTokens),
							contextTokens: total,
						},
					},
				];
			}
			if (innerType === "message_end" && Array.isArray(inner.content)) {
				const content = inner.content.flatMap((part: any): Extract<ChildEvent, { kind: "message" }>["content"] =>
					part?.type === "tool_use"
						? [{ type: "toolCall" as const, name: str(part.name) || "tool", arguments: asRecord(part.input) }]
						: part?.type === "text" && str(part.text)
							? [{ type: "text" as const, text: String(part.text) }]
							: [],
				);
				return content.length ? [{ kind: "message", role: "assistant", content }] : [];
			}
			if (innerType === "run_error" || innerType === "error") {
				const message = str(asRecord(inner.error).message) || "commandcode run error";
				return [{ kind: "message", role: "assistant", content: [], stopReason: "error", errorMessage: message }];
			}
			if (innerType === "agent_message" || innerType === "assistant_message") {
				const text = str(inner.text) || textOf(inner.content);
				if (text) return [{ kind: "message", role: "assistant", content: [{ type: "text", text }] }];
			}
			return [];
		}
		return [];
	},
};

export const PROVIDERS: Record<ProviderId, Provider> = {
	pi: piProvider,
	claude: claudeProvider,
	codex: codexProvider,
	commandcode: commandcodeProvider,
};

export const PROVIDER_IDS: ProviderId[] = ["pi", "claude", "codex", "commandcode"];

export function isProviderId(value: string): value is ProviderId {
	return (PROVIDER_IDS as string[]).includes(value);
}

export function describeProviders(): string {
	return PROVIDER_IDS.map((id) => {
		const provider = PROVIDERS[id];
		const state = providerAvailable(id) ? "ready" : "not found";
		return `${id} (${state}): ${provider.describe}`;
	}).join("; ");
}
