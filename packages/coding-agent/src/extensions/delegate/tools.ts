import { type Static, Type } from "typebox";
import type { DelegateHost, DelegateManager } from "../../core/delegate/manager.ts";
import type { DelegateRequest } from "../../core/delegate/transport.ts";
import { detailText, MAX_TASKS, REPORT_TAG, reportText, type TaskView } from "../../core/delegate/view.ts";
import { defineTool, type ExtensionToolContext, type ToolDefinition } from "../../core/extensions/types.ts";
import {
	renderDelegateCall,
	renderDelegateResult,
	renderDelegateTasksCall,
	renderDelegateTasksResult,
} from "./renderers.ts";

export const DELEGATE_TOOL_NAME = "delegate";
export const DELEGATE_TASKS_TOOL_NAME = "delegate_tasks";
export const DEFAULT_TIMEOUT_MS = 900000;
export const DEFAULT_BACKGROUND_WAIT_MS = 300000;
export const DEFAULT_TASKS_WAIT_MS = 120000;
export const MAX_TASKS_WAIT_MS = 300000;

const requestSchema = Type.Object({
	agent: Type.String({ description: "Agent name from the Agents list." }),
	task: Type.String({ description: "Task brief. State the return format. Keep it under 1500 characters." }),
	provider: Type.Optional(Type.String({ description: "Child provider." })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override. Use delegate_tasks action models for the full list. An unknown model fails at start.",
		}),
	),
	runtimeMode: Type.Optional(
		Type.String({ description: "full-access or approval-required. Default approval-required." }),
	),
	scope: Type.Optional(Type.Array(Type.String(), { description: "Project paths this child may change." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Stop this child after this time. Default 15 minutes." })),
	noProgressMs: Type.Optional(
		Type.Number({ description: "Stop this child after this long without progress. 0 is off." }),
	),
	contextBudget: Type.Optional(
		Type.Number({
			description:
				"Leave unset (off). Set it only when the user asks for a token limit: it stops a child when one request carries more tokens than this, and writing workers often need more than 100000.",
		}),
	),
});

const chainItemSchema = Type.Object({
	agent: Type.String({ description: "Agent name for this step." }),
	task: Type.String({ description: "Task for this step. Use the {previous} placeholder for the prior step result." }),
	provider: Type.Optional(Type.String({ description: "Child provider for this step." })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for this step. Use delegate_tasks action models for the full list. An unknown model fails at start.",
		}),
	),
	runtimeMode: Type.Optional(Type.String({ description: "full-access or approval-required for this step." })),
	scope: Type.Optional(Type.Array(Type.String(), { description: "Project paths this step may change." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Stop this step after this time." })),
	noProgressMs: Type.Optional(Type.Number({ description: "Stop this step after this long without progress." })),
	contextBudget: Type.Optional(
		Type.Number({
			description:
				"Leave unset (off). Set it only when the user asks for a token limit: it stops a child when one request carries more tokens than this, and writing workers often need more than 100000.",
		}),
	),
});

const delegateSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name for a single task, from the Agents list." })),
	task: Type.Optional(Type.String({ description: "Task brief for a single task." })),
	tasks: Type.Optional(Type.Array(requestSchema, { description: "Two or more tasks for parallel mode." })),
	chain: Type.Optional(
		Type.Array(chainItemSchema, {
			description: "Steps for chain mode. Each step may use the {previous} placeholder.",
		}),
	),
	provider: Type.Optional(Type.String({ description: "Child provider, for example pi, commandcode or codex." })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for the children. Use delegate_tasks action models for the full list. An unknown model fails at start.",
		}),
	),
	runtimeMode: Type.Optional(
		Type.String({ description: "full-access or approval-required. Default approval-required." }),
	),
	scope: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Project paths the children may change. ["."] is the whole project, [] is read-only.',
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Project directory. Defaults to the session working directory." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Stop a child after this time. Default 15 minutes." })),
	noProgressMs: Type.Optional(
		Type.Number({ description: "Stop a child after this long without progress. 0 is off." }),
	),
	background: Type.Optional(
		Type.Boolean({ description: "Default true: return at once and report later. false: wait for the report." }),
	),
	waitMs: Type.Optional(
		Type.Number({ description: "With background false: return the report after this long. Default 300000." }),
	),
	contextBudget: Type.Optional(
		Type.Number({
			description:
				"Leave unset (off). Set it only when the user asks for a token limit: it stops a child when one request carries more tokens than this, and writing workers often need more than 100000.",
		}),
	),
});

export type DelegateInput = Static<typeof delegateSchema>;

const tasksSchema = Type.Object({
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("wait"),
				Type.Literal("status"),
				Type.Literal("answer"),
				Type.Literal("cancel"),
				Type.Literal("diff"),
				Type.Literal("accept"),
				Type.Literal("undo"),
				Type.Literal("prune"),
				Type.Literal("models"),
			],
			{ description: "Default status." },
		),
	),
	provider: Type.Optional(
		Type.String({
			description: "For action models: list models for this provider. Leave empty to list all providers.",
		}),
	),
	taskId: Type.Optional(Type.String({ description: "The task ID from the delegate report." })),
	requestId: Type.Optional(Type.String({ description: "For answer: the pending question id." })),
	answer: Type.Optional(Type.String({ description: "For answer: the answer to a question." })),
	approved: Type.Optional(Type.Boolean({ description: "For answer: approve or deny a permission request." })),
	approve: Type.Optional(Type.Boolean({ description: "For answer: alias for approved." })),
	waitMs: Type.Optional(
		Type.Number({
			description: "For wait: return after this long when children still run. Default 120000, max 300000.",
		}),
	),
	olderThan: Type.Optional(Type.String({ description: "For prune: an age such as 30m, 12h or 7d. Default 7d." })),
	force: Type.Optional(Type.Boolean({ description: "For undo: also overwrite edits made after the task stopped." })),
});

export type DelegateTasksInput = Static<typeof tasksSchema>;

export interface DelegateTaskDetails {
	views: TaskView[];
	mode: "single" | "parallel" | "chain";
	delegateReportIds?: string[];
}

export interface DelegateTasksDetails {
	taskId?: string;
	status?: string;
	delegateReportIds?: string[];
}

export interface DelegateToolDeps {
	manager: DelegateManager;
	hostFrom: (ctx: ExtensionToolContext) => DelegateHost;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(value, min), max);
}

interface ResolvedMode {
	ok: boolean;
	error?: string;
	mode: "single" | "parallel" | "chain";
	requests: DelegateRequest[];
}

function overrides(
	item: {
		provider?: string;
		model?: string;
		scope?: string[];
		runtimeMode?: string;
		timeoutMs?: number;
		noProgressMs?: number;
		contextBudget?: number;
	},
	base: DelegateRequest,
): Partial<DelegateRequest> {
	return {
		provider: item.provider ?? base.provider,
		model: item.model ?? base.model,
		scope: item.scope ?? base.scope,
		runtimeMode: item.runtimeMode ?? base.runtimeMode,
		timeoutMs: item.timeoutMs ?? base.timeoutMs,
		noProgressMs: item.noProgressMs ?? base.noProgressMs,
		contextBudget: item.contextBudget ?? base.contextBudget,
	};
}

export function resolveMode(input: DelegateInput, cwd: string): ResolvedMode {
	const hasTasks = Array.isArray(input.tasks) && input.tasks.length > 0;
	const hasChain = Array.isArray(input.chain) && input.chain.length > 0;
	const hasSingle = typeof input.agent === "string" && input.agent.trim() !== "" && typeof input.task === "string";
	const modes = Number(hasTasks) + Number(hasChain) + Number(hasSingle);
	if (modes !== 1) {
		return {
			ok: false,
			error: "Give exactly one mode: {agent, task}, {tasks: [...]}, or {chain: [...]}.",
			mode: "single",
			requests: [],
		};
	}
	const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
	if ((input.tasks?.length ?? 0) > MAX_TASKS || (input.chain?.length ?? 0) > MAX_TASKS) {
		return { ok: false, error: `Use at most ${MAX_TASKS} tasks.`, mode, requests: [] };
	}

	const base: DelegateRequest = {
		provider: input.provider,
		model: input.model,
		runtimeMode: input.runtimeMode,
		scope: input.scope,
		timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		noProgressMs: input.noProgressMs,
		contextBudget: input.contextBudget,
		cwd: input.cwd || cwd,
	};
	const requests: DelegateRequest[] = hasChain
		? (input.chain ?? []).map((item) => ({ ...base, ...overrides(item, base), agent: item.agent, task: item.task }))
		: hasTasks
			? (input.tasks ?? []).map((item) => ({
					...base,
					...overrides(item, base),
					agent: item.agent,
					task: item.task,
				}))
			: [{ ...base, agent: input.agent, task: input.task ?? "" }];

	for (const request of requests) {
		if (typeof request.agent !== "string" || request.agent.trim() === "")
			return { ok: false, error: "Every request needs a non-empty agent.", mode, requests: [] };
		if (typeof request.task !== "string" || request.task.trim() === "")
			return { ok: false, error: "Every request needs a non-empty task.", mode, requests: [] };
	}
	return { ok: true, mode, requests };
}

function textResult<T>(text: string, details: T): { content: { type: "text"; text: string }[]; details: T } {
	return { content: [{ type: "text", text }], details };
}

function errorResult<T>(
	text: string,
	details: T,
): { content: { type: "text"; text: string }[]; details: T; isError: boolean } {
	return { content: [{ type: "text", text }], details, isError: true };
}

function unknownTask(taskId: string): ReturnType<typeof errorResult<DelegateTasksDetails>> {
	return errorResult(`Unknown task ${taskId}. It was not started by this session.`, { taskId });
}

export function createDelegateTool(
	deps: DelegateToolDeps,
	agents: string[] = [],
	unavailable = "",
): ToolDefinition<typeof delegateSchema, DelegateTaskDetails> {
	return defineTool({
		name: DELEGATE_TOOL_NAME,
		label: DELEGATE_TOOL_NAME,
		description: [
			"Run child coding agents in a fixed Linux filesystem sandbox with an isolated context.",
			"Modes: single ({agent, task}), parallel ({tasks: [...]}, max 8), or chain ({chain: [...]}) which runs steps in order, replacing the {previous} placeholder in each step with the prior result.",
			agents.length ? `Agents: ${agents.join(", ")}.` : "Use an agent name from the agent files.",
			...(unavailable ? [unavailable] : []),
			"A child that asks a question shows the question in this session, and your answer goes back to that child.",
			"Children work in the project directly. scope lists the paths a child may change; everything else is read-only, and .git is always read-only. No scope means read-only.",
			"Tasks with overlapping scopes run one after the other, so give parallel tasks separate scopes.",
			`By default the tool returns at once and the children run in the background. When all children of the call stop, a short <${REPORT_TAG}> notice comes with the result of your next tool call. Do not end your turn while your children run: with no other work, call delegate_tasks with action wait.`,
			"Set background false when you cannot go on without the result; then the tool waits and returns the report.",
			"After a write task, review the changes, then call delegate_tasks with action accept, or undo to restore the scope.",
		].join(" "),
		parameters: delegateSchema,
		renderShell: "self",
		reachesTools: () => [],
		async execute(toolCallId, input, signal, _onUpdate, ctx) {
			const manager = deps.manager;
			manager.setHost(deps.hostFrom(ctx));
			const resolved = resolveMode(input, ctx.cwd);
			if (!resolved.ok)
				return errorResult(resolved.error ?? "Invalid delegate call.", { views: [], mode: resolved.mode });

			try {
				const onStart = (startedViews: TaskView[]): void => {
					manager.recordCall(
						toolCallId,
						startedViews.map((view) => view.taskId),
					);
				};

				if (resolved.mode === "chain") {
					const waitMs = clamp(input.waitMs ?? DEFAULT_BACKGROUND_WAIT_MS, 5000, 3600000);
					const started: string[] = [];
					const { views, report, stopped, reportIds } = await manager.chain(resolved.requests, {
						waitMs,
						signal,
						onStart: (startedViews) => {
							started.push(...startedViews.map((view) => view.taskId));
							manager.recordCall(toolCallId, [...started]);
						},
					});
					if (views.length === 0)
						return errorResult("delegate could not start any task.", { views: [], mode: resolved.mode });
					if (stopped) return errorResult(report, { views, mode: "chain", delegateReportIds: reportIds });
					return textResult(report, { views, mode: "chain", delegateReportIds: reportIds });
				}

				if (input.background === false) {
					const waitMs = clamp(input.waitMs ?? DEFAULT_BACKGROUND_WAIT_MS, 5000, 3600000);
					const { views, report, reportIds } = await manager.startForeground(resolved.requests, {
						waitMs,
						signal,
						onStart,
					});
					if (views.length === 0)
						return errorResult("delegate could not start any task.", { views: [], mode: resolved.mode });
					return textResult(report ?? reportText(views), {
						views,
						mode: resolved.mode,
						delegateReportIds: reportIds,
					});
				}

				const views = await manager.start(resolved.requests, { signal, onStart });
				if (views.length === 0)
					return errorResult("delegate could not start any task.", { views: [], mode: resolved.mode });
				const names = views.map((view) => `${view.taskId} (${view.agent})`).join(", ");
				return textResult(
					`Started in the background: ${names}. Go on with other work; the <${REPORT_TAG}> notice comes with a later tool result. Do not end your turn while they run: with no other work, call delegate_tasks with action wait.`,
					{ views, mode: resolved.mode },
				);
			} catch (error) {
				return errorResult(`delegate failed: ${error instanceof Error ? error.message : String(error)}`, {
					views: [],
					mode: resolved.mode,
				});
			}
		},
		renderCall: (args, theme) =>
			renderDelegateCall(
				{
					agent: args.agent,
					task: args.task,
					tasks: args.tasks,
					chain: Array.isArray(args.chain) && args.chain.length > 0,
				},
				theme,
			),
		renderResult: (result, options, theme) =>
			renderDelegateResult(
				result as { content: { type: string; text?: string }[] },
				options,
				theme,
				(result as { details?: DelegateTaskDetails }).details,
			),
	});
}

export function createDelegateTasksTool(
	deps: DelegateToolDeps,
): ToolDefinition<typeof tasksSchema, DelegateTasksDetails> {
	return defineTool({
		name: DELEGATE_TASKS_TOOL_NAME,
		label: DELEGATE_TASKS_TOOL_NAME,
		description: `Wait for, check, answer, cancel, review, accept or undo a child task that the delegate tool started. wait blocks until the running children stop and returns the <${REPORT_TAG}> notice, or says the tasks are still running after waitMs; then call it again or do other work. After a write task stops, diff shows its changes, accept keeps them and frees the scope, and undo restores the scope. Accept and undo also remove the task folder. prune removes old folders of stopped tasks. Use action models to discover available models, optionally for one provider.`,
		parameters: tasksSchema,
		renderShell: "self",
		reachesTools: () => [],
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const manager = deps.manager;
			manager.setHost(deps.hostFrom(ctx));
			const action = input.action ?? "status";
			try {
				if (action === "wait") {
					const waitMs = clamp(input.waitMs ?? DEFAULT_TASKS_WAIT_MS, 5000, MAX_TASKS_WAIT_MS);
					if (input.taskId && !manager.get(input.taskId)) return unknownTask(input.taskId);
					const ids = input.taskId ? new Set([input.taskId]) : undefined;
					const outcome = await manager.waitForReport(waitMs, signal, ids);
					if (outcome.report)
						return textResult(outcome.report, {
							taskId: input.taskId,
							status: "report",
							delegateReportIds: outcome.reportIds,
						});
					if (outcome.running.length === 0)
						return textResult("No child task is running, and no report is waiting.", { status: "idle" });
					const running = outcome.running.map((task) => `${task.taskId} (${task.agent})`).join(", ");
					return textResult(`Still running: ${running}. Call wait again, or go on with other work.`, {
						status: "running",
					});
				}

				if (action === "prune") {
					const age =
						typeof input.olderThan === "string" && /^\d+[mhd]$/.test(input.olderThan) ? input.olderThan : "7d";
					const result = await manager.prune(age);
					const kept = result.kept.map((item) => `kept ${item.taskId}: ${item.reason}`).join("\n");
					return textResult(`Removed ${result.removed.length} task folders.${kept ? `\n${kept}` : ""}`, {
						status: "pruned",
					});
				}

				if (action === "models") {
					const lists = await manager.listModels(input.provider);
					const blocks = lists.map((list) => {
						const head = `${list.provider}${list.error ? ` (error: ${list.error})` : ""}`;
						const lines = list.models.length
							? list.models.map(
									(model) =>
										`  ${model.id}${model.description ? ` — ${model.description}` : ""}${model.efforts?.length ? ` [${model.efforts.join(", ")}]` : ""}`,
								)
							: ["  No models available"];
						return [head, ...lines].join("\n");
					});
					return textResult(blocks.join("\n\n"), { status: "models" });
				}

				if (!input.taskId) {
					const open = manager.activeTasks();
					if (open.length === 0)
						return textResult("No task started by this session is active.", { status: "idle" });
					const list = open.map((task) => `${task.taskId} (${task.agent}, ${task.status})`).join(", ");
					return textResult(`Active tasks: ${list}`, { status: "list" });
				}

				const taskId = input.taskId;
				if (action === "answer") {
					if (!manager.get(taskId)) return unknownTask(taskId);
					if (!input.requestId) return errorResult("answer needs a requestId.", { taskId });
					const approved = input.approved ?? input.approve;
					const value = approved !== undefined ? { approved } : { answer: input.answer ?? "" };
					await manager.answer(taskId, input.requestId, value);
					return textResult(`Answer sent to ${taskId} for ${input.requestId}.`, { taskId, status: "answered" });
				}
				if (action === "cancel") {
					if (!manager.get(taskId)) return unknownTask(taskId);
					const view = await manager.cancel(taskId);
					return textResult(`Cancel sent to ${taskId}. Status: ${view.status}.`, { taskId, status: view.status });
				}
				if (action === "diff") {
					if (!manager.get(taskId)) return unknownTask(taskId);
					const diff = await manager.diff(taskId);
					return textResult(diff ? diff.slice(0, 60000) : "No changes.", { taskId });
				}
				if (action === "accept") {
					if (!manager.get(taskId)) return unknownTask(taskId);
					await manager.accept(taskId);
					return textResult(`Accepted ${taskId}. The scope is free.`, { taskId, status: "accepted" });
				}
				if (action === "undo") {
					if (!manager.get(taskId)) return unknownTask(taskId);
					const view = await manager.undo(taskId, input.force === true);
					return textResult(`Undone ${taskId}. Restored: ${(view.restored ?? []).join(", ") || "nothing"}.`, {
						taskId,
						status: "undone",
					});
				}

				if (!manager.get(taskId)) return unknownTask(taskId);
				const view = await manager.refresh(taskId);
				return textResult(detailText(view), { taskId, status: view.status });
			} catch (error) {
				return errorResult(`delegate_tasks failed: ${error instanceof Error ? error.message : String(error)}`, {});
			}
		},
		renderCall: (args, theme) => renderDelegateTasksCall(args, theme, deps.manager),
		renderResult: (result, options, theme) =>
			renderDelegateTasksResult(result as { content: { type: string; text?: string }[] }, options, theme),
	});
}
