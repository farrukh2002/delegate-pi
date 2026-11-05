export const REPORT_TAG = "delegate-report";
export const MAX_TASKS = 8;
export const STATUS_EVERY = 20;
export const HEARTBEAT_STALE_MS = 15000;
export const NO_ANSWER = "The user gave no answer. Stop and report BLOCKED with the question.";
export const APPROVAL = /^(y|yes|allow|approve|ok)$/i;

export const STOPPED: readonly string[] = ["completed", "failed", "blocked", "cancelled", "timed_out"];
export const TERMINAL: readonly string[] = [...STOPPED, "accepted", "undone"];
export const GOOD: readonly string[] = ["completed", "accepted", "undone"];

export type Tone = "muted" | "accent" | "warning" | "success" | "error";

export const MARKS: Record<string, readonly [string, Tone]> = {
	starting: ["◌", "muted"],
	queued: ["◌", "muted"],
	running: ["✻", "accent"],
	waiting: ["?", "warning"],
	completed: ["✓", "success"],
	accepted: ["✓", "success"],
	undone: ["↺", "muted"],
	blocked: ["!", "warning"],
	failed: ["✗", "error"],
	timed_out: ["✗", "error"],
	cancelled: ["–", "muted"],
	stopped: ["–", "muted"],
};

export interface DelegatePending {
	id: string;
	kind: "question" | "permission" | string;
	question: string;
	options?: { label?: string }[];
	multiSelect?: boolean;
	tool?: string;
	input?: unknown;
}

export interface DelegateState {
	taskId: string;
	agent?: string;
	provider?: string;
	status: string;
	scope?: string[];
	task?: string;
	summary?: string;
	createdAt?: number;
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
	heartbeat?: number;
	diffstat?: string;
	logPath?: string;
	costUsd?: number | null;
	usage?: { turns?: number; contextTokens?: number; cost?: number };
	activity?: string[];
	pending?: DelegatePending[];
	restored?: string[];
	error?: string;
}

export type TaskView = {
	taskId: string;
	agent: string;
	provider: string;
	status: string;
	scope: string[];
	task: string;
	startedAt?: number;
	durationMs?: number;
	turns?: number;
	contextTokens?: number;
	costUsd?: number;
	summary?: string;
	fullSummary?: string;
	logPath?: string;
	error?: string;
	diffstat?: string;
	pending?: number;
	activity?: string[];
	restored?: string[];
};

export type CallView = { tasks: string[] };

export type LiveRow = {
	id: string;
	agent: string;
	status: string;
	startedAt: number;
	asking: boolean;
	activity: string[];
};

export function isTerminal(status: string): boolean {
	return TERMINAL.includes(status);
}

export function short(text: unknown, size: number): string {
	const line = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > size ? `${line.slice(0, Math.max(0, size - 1))}…` : line;
}

export function clock(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function changes(diffstat?: string): [number, number] {
	const text = diffstat ?? "";
	return [Number(/(\d+) insertion/.exec(text)?.[1] ?? 0), Number(/(\d+) deletion/.exec(text)?.[1] ?? 0)];
}

export function elapsed(task: Pick<TaskView, "durationMs" | "startedAt">, now = Date.now()): number {
	if (task.durationMs !== undefined) return task.durationMs;
	return task.startedAt ? Math.max(0, now - task.startedAt) : 0;
}

export function statusText(task: Pick<TaskView, "pending" | "status">): string {
	return task.pending ? "asking" : task.status.replace("_", " ");
}

export function reportId(task: Pick<TaskView, "taskId" | "status">): string {
	return `${task.taskId}:${task.status}`;
}

export function agentsLabel(rows: Pick<TaskView, "agent">[]): string {
	const names = [...new Set(rows.map((row) => row.agent))];
	return names.length > 2 ? `${rows.length} agents` : names.join(" and ");
}

export function toTaskView(state: DelegateState, previous?: Partial<TaskView>): TaskView {
	return {
		taskId: state.taskId,
		agent: state.agent ?? previous?.agent ?? "",
		provider: state.provider ?? previous?.provider ?? "",
		status: state.status ?? previous?.status ?? "starting",
		scope: state.scope ?? previous?.scope ?? [],
		task: previous?.task ?? short(state.task, 300),
		startedAt: state.startedAt ?? previous?.startedAt,
		durationMs: state.durationMs ?? previous?.durationMs,
		turns: state.usage?.turns || previous?.turns,
		contextTokens: state.usage?.contextTokens || previous?.contextTokens,
		costUsd: state.costUsd ?? previous?.costUsd,
		summary: state.summary ? short(state.summary, 600) : previous?.summary,
		fullSummary: state.summary ? String(state.summary) : previous?.fullSummary,
		logPath: state.logPath ?? previous?.logPath,
		error: state.error ?? previous?.error,
		diffstat: state.diffstat ? String(state.diffstat).trim().split("\n").pop() : previous?.diffstat,
		pending: state.pending?.length || undefined,
		activity: state.activity ?? previous?.activity,
		restored: state.restored ?? previous?.restored,
	};
}

export function toLiveRows(rows: TaskView[]): LiveRow[] {
	return rows.map((row) => ({
		id: row.taskId,
		agent: row.agent,
		status: row.status,
		startedAt: row.startedAt ?? 0,
		asking: Boolean(row.pending),
		activity: row.activity ?? [],
	}));
}

export function detailText(task: TaskView, now = Date.now()): string {
	const meta = [
		task.status,
		`${Math.round(elapsed(task, now) / 1000)}s`,
		task.turns ? `${task.turns} turns` : null,
		task.contextTokens ? `peak context ${task.contextTokens}` : null,
		task.costUsd != null ? `$${Number(task.costUsd).toFixed(4)}` : null,
		task.taskId,
	]
		.filter(Boolean)
		.join(" | ");
	const parts = [`[${task.agent} / ${task.provider}] ${meta}`];
	const summary = task.fullSummary ?? task.summary;
	if (summary) parts.push(summary.trim());
	if (task.scope.length) parts.push(`Scope: ${task.scope.join(", ")}`);
	if (task.diffstat) parts.push(`Changes:\n${task.diffstat}`);
	if (task.logPath) parts.push(`Output log: ${task.logPath}`);
	if (task.scope.length && STOPPED.includes(task.status)) {
		parts.push(`Review the changes, then call delegate_tasks with action accept or undo, taskId ${task.taskId}.`);
	}
	return parts.join("\n");
}

export function reportText(results: TaskView[], now = Date.now()): string {
	const open = results.filter((task) => !STOPPED.includes(task.status)).length;
	const completed = results.filter((task) => task.status === "completed").length;
	const body = results.map((task) => detailText(task, now)).join("\n\n");
	return `${completed}/${results.length} completed\n\n${body}${open > 0 ? `\n\n${open} still running. Use delegate_tasks to check or cancel it.` : ""}`;
}

export function noticeText(results: TaskView[], now = Date.now()): string {
	const lines = results.map((task) => {
		const [added, removed] = changes(task.diffstat);
		const work = task.scope.length
			? task.diffstat
				? `changed ${task.scope.join(", ")} +${added} -${removed}, accept or undo`
				: `no changes in ${task.scope.join(", ")}, accept or undo`
			: "read-only";
		return `${MARKS[task.status]?.[0] ?? "·"} ${task.agent} ${task.taskId} ${task.status} ${Math.round(elapsed(task, now) / 1000)}s, ${work}`;
	});
	return `<${REPORT_TAG}>\n${lines.join("\n")}\n</${REPORT_TAG}>`;
}

export function pendingText(state: Pick<DelegateState, "pending">): string {
	return (state.pending ?? []).map((item) => `${item.id} [${item.kind}] ${item.question}`).join("\n");
}

export function permissionText(pending: DelegatePending): string {
	const parts = [pending.question];
	if (pending.tool) parts.push(`Tool: ${pending.tool}`);
	if (pending.input !== undefined) {
		let args = "";
		try {
			args = JSON.stringify(pending.input);
		} catch {
			args = String(pending.input);
		}
		parts.push(`Arguments: ${short(args, 400)}`);
	}
	return parts.join("\n");
}

export function optionLabels(pending: DelegatePending): string[] {
	return (pending.options ?? [])
		.map((option) => option.label)
		.filter((label): label is string => typeof label === "string" && label.length > 0);
}

export function modelDescription(agents: { name: string; provider: string; model?: string }[]): string {
	const defaults = agents.map((agent) => `${agent.name}=${agent.model || `${agent.provider} default`}`);
	return `Model override. ${defaults.length ? `Agent defaults: ${defaults.join(", ")}. ` : ""}Use delegate_tasks action models for the full list. An unknown model fails at start.`;
}

export function readyAgents<T extends { ready?: boolean }>(agents: T[]): T[] {
	return agents.filter((agent) => agent.ready !== false);
}

export function unavailableText(agents: { name: string; ready?: boolean; problem?: string }[]): string {
	const missing = agents.filter((agent) => agent.ready === false);
	if (!missing.length) return "";
	const list = missing.map((agent) => `${agent.name} (${agent.problem ?? "not available"})`).join(", ");
	return `Not available on this machine: ${list}. If the user asks for one of these, tell them what to install; it shows up in the next session.`;
}

export function agentEntry(content: string): { name: string; provider: string; model?: string } | undefined {
	const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim();
	if (!name) return undefined;
	const provider = /^provider:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "pi";
	const model = /^model:\s*(.+)$/m.exec(content)?.[1]?.trim();
	return { name, provider, model };
}

export function dataDir(env: Record<string, string | undefined>, home: string): string {
	if (env.DELEGATE_DATA) return env.DELEGATE_DATA;
	const state = env.XDG_STATE_HOME?.startsWith("/") ? env.XDG_STATE_HOME : `${home}/.local/state`;
	return `${state}/delegate`;
}

export function cliPath(env: Record<string, string | undefined>, home: string): string {
	return `${env.DELEGATE_PREFIX || `${home}/.local/share/delegate`}/delegate.mjs`;
}
