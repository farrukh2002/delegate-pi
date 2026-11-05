import type { SessionEntry } from "../session-manager.ts";
import type {
	DelegateAgentInfo,
	DelegateAnswer,
	DelegateModelList,
	DelegatePending,
	DelegateRequest,
	DelegateState,
	DelegateTransport,
} from "./transport.ts";
import {
	APPROVAL,
	type CallView,
	isTerminal,
	type LiveRow,
	noticeText,
	permissionText,
	REPORT_TAG,
	reportId,
	reportText,
	STATUS_EVERY,
	short,
	type TaskView,
	toLiveRows,
	toTaskView,
} from "./view.ts";

export const TASKS_ENTRY = "delegate.tasks";
export const CALLS_ENTRY = "delegate.calls";
export const REPORTS_ENTRY = "delegate.reports";

const DEFAULT_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 1000;
const MAX_MISSES = 60;
const MAX_STATUS_MISSES = 3;

export interface DelegateUI {
	readonly available: boolean;
	ask(question: string, options?: string[]): Promise<string | undefined>;
	confirmPermission?(pending: DelegatePending): Promise<boolean | undefined>;
	confirmProjectAgent?(agent: DelegateAgentInfo): Promise<boolean | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface DelegateHost {
	sessionId: string;
	cwd: string;
	branchEntries: () => SessionEntry[];
	ui: DelegateUI;
}

export interface DelegateManagerOptions {
	transport: DelegateTransport;
	appendEntry: (customType: string, data: unknown) => void;
	now?: () => number;
	intervalMs?: number;
	requestRender?: () => void;
}

export interface WaitOutcome {
	report?: string;
	reportIds?: string[];
	running: TaskView[];
}

export interface StartOptions {
	signal?: AbortSignal;
	onStart?: (views: TaskView[]) => void;
}

interface DialogItem {
	taskId: string;
	pending: DelegatePending;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function taskIdOf(reportKey: string): string {
	return reportKey.split(":")[0] ?? reportKey;
}

function receiptIdsOf(entry: SessionEntry): string[] {
	if (entry.type === "custom_message") {
		if (entry.customType !== REPORT_TAG) return [];
		return asStringArray(asRecord(entry.details).delegateReportIds);
	}
	if (entry.type === "message") {
		const message = asRecord(entry.message);
		if (message.role !== "toolResult") return [];
		return asStringArray(asRecord(message.details).delegateReportIds);
	}
	return [];
}

export class DelegateManager {
	private readonly transport: DelegateTransport;
	private readonly appendEntry: (customType: string, data: unknown) => void;
	private readonly now: () => number;
	private readonly intervalMs: number;
	private readonly requestRender: () => void;
	private host: DelegateHost | undefined;
	private sessionId: string | undefined;
	private generation = 0;
	private readonly owners = new Map<string, string>();
	private tasks = new Map<string, TaskView>();
	private calls = new Map<string, CallView>();
	private callOf = new Map<string, string>();
	private watching = new Set<string>();
	private inbox: string[][] = [];
	private queued = new Set<string>();
	private inflight = new Set<string>();
	private delivered = new Set<string>();
	private answered = new Set<string>();
	private dismissed = new Set<string>();
	private misses = new Map<string, number>();
	private statusMisses = new Map<string, number>();
	private ticks = new Map<string, number>();
	private dialogQueue: DialogItem[] = [];
	private queuedPending = new Set<string>();
	private dialogActive = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private ticking = false;
	private disposed = false;
	private failSeq = 0;
	private approvedAgents = new Set<string>();

	constructor(options: DelegateManagerOptions) {
		this.transport = options.transport;
		this.appendEntry = options.appendEntry;
		this.now = options.now ?? (() => Date.now());
		this.intervalMs = Math.min(Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 100), MAX_INTERVAL_MS);
		this.requestRender = options.requestRender ?? (() => {});
	}

	get disposedState(): boolean {
		return this.disposed;
	}

	setHost(host: DelegateHost): void {
		const changed = this.sessionId !== undefined && this.sessionId !== host.sessionId;
		this.host = host;
		if (changed) {
			this.generation += 1;
			this.resetSessionState();
		}
		this.sessionId = host.sessionId;
	}

	clearHost(): void {
		this.host = undefined;
	}

	private resetSessionState(): void {
		this.approvedAgents.clear();
		this.owners.clear();
		this.tasks.clear();
		this.calls.clear();
		this.callOf.clear();
		this.watching.clear();
		this.inbox = [];
		this.queued.clear();
		this.inflight.clear();
		this.delivered.clear();
		this.answered.clear();
		this.dismissed.clear();
		this.misses.clear();
		this.statusMisses.clear();
		this.ticks.clear();
		this.dialogQueue = [];
		this.queuedPending.clear();
		this.dialogActive = false;
		this.stopTimer();
	}

	private stopTimer(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private nextFailedId(): string {
		this.failSeq += 1;
		let id = `start-failed-${this.failSeq}`;
		while (this.tasks.has(id)) {
			this.failSeq += 1;
			id = `start-failed-${this.failSeq}`;
		}
		return id;
	}

	private owns(taskId: string): boolean {
		return this.sessionId !== undefined && this.owners.get(taskId) === this.sessionId;
	}

	restore(): void {
		const sessionId = this.sessionId;
		if (sessionId === undefined) return;
		const entries = this.host?.branchEntries() ?? [];
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			const data = asRecord(entry.data);
			if (data.owner !== sessionId) continue;
			if (entry.customType === TASKS_ENTRY) {
				for (const [id, value] of Object.entries(asRecord(data.tasks))) {
					const task = value as TaskView;
					if (task && typeof task.taskId === "string") {
						this.tasks.set(id, task);
						this.owners.set(id, sessionId);
					}
				}
			} else if (entry.customType === CALLS_ENTRY) {
				for (const [id, value] of Object.entries(asRecord(data.calls))) {
					const call = value as CallView;
					if (call && Array.isArray(call.tasks)) {
						this.calls.set(id, call);
						for (const taskId of call.tasks) this.callOf.set(taskId, id);
					}
				}
			} else if (entry.customType === REPORTS_ENTRY) {
				for (const key of asStringArray(data.delivered)) this.delivered.add(key);
				for (const key of asStringArray(data.queued)) this.queued.add(key);
				for (const key of asStringArray(data.inflight)) this.queued.add(key);
			}
		}
		this.observeReceipts();
		for (const task of this.tasks.values()) {
			if (isTerminal(task.status) && !this.delivered.has(reportId(task))) this.queued.add(reportId(task));
			else if (!isTerminal(task.status)) this.watching.add(task.taskId);
		}
		this.rebuildInbox();
		if (this.watching.size) this.startTimer();
	}

	private rebuildInbox(): void {
		this.inbox = [];
		const groups = new Map<string, string[]>();
		for (const key of this.queued) {
			if (this.delivered.has(key) || this.inflight.has(key)) continue;
			const task = this.taskForReport(key);
			if (!task) {
				this.queued.delete(key);
				continue;
			}
			const group = this.callOf.get(task.taskId) ?? `#${key}`;
			const bucket = groups.get(group) ?? [];
			bucket.push(key);
			groups.set(group, bucket);
		}
		for (const ids of groups.values()) this.inbox.push(ids);
	}

	private taskForReport(reportKey: string): TaskView | undefined {
		return this.tasks.get(taskIdOf(reportKey));
	}

	private observeReceipts(): void {
		const entries = this.host?.branchEntries() ?? [];
		let changed = false;
		for (const entry of entries) {
			for (const key of receiptIdsOf(entry)) {
				if (!this.delivered.has(key)) {
					this.delivered.add(key);
					changed = true;
				}
				this.inflight.delete(key);
				this.queued.delete(key);
			}
		}
		if (changed) {
			this.rebuildInbox();
			this.persistReports();
		}
	}

	async start(input: DelegateRequest[], options: StartOptions = {}): Promise<TaskView[]> {
		const generation = this.generation;
		const requests = await this.withProjectAgentTrust(input);
		if (generation !== this.generation) return [];
		const states = await this.transport.start(requests, { signal: options.signal, timeoutMs: 30000 });
		if (generation !== this.generation) return [];
		const views: TaskView[] = [];
		requests.forEach((request, index) => {
			const state = states[index];
			if (state && typeof state.taskId === "string") {
				const view = toTaskView(state, { task: short(request.task, 300) });
				this.tasks.set(view.taskId, view);
				if (this.sessionId !== undefined) this.owners.set(view.taskId, this.sessionId);
				this.watching.add(view.taskId);
				views.push(view);
				return;
			}
			const taskId = this.nextFailedId();
			const view: TaskView = {
				taskId,
				agent: request.agent ?? "",
				provider: request.provider ?? "",
				status: "failed",
				scope: request.scope ?? [],
				task: short(request.task ?? "", 300),
				summary: short(state?.error ?? "The child did not start.", 600),
				fullSummary: String(state?.error ?? "The child did not start."),
				activity: [],
			};
			this.tasks.set(taskId, view);
			if (this.sessionId !== undefined) this.owners.set(taskId, this.sessionId);
			views.push(view);
		});
		if (views.length) this.persistTasks(views);
		options.onStart?.(views);
		for (const view of views) {
			if (isTerminal(view.status)) this.terminalize(view);
		}
		if (this.watching.size) this.startTimer();
		if (options.signal?.aborted) {
			for (const view of views) {
				if (!isTerminal(view.status)) void this.cancel(view.taskId).catch(() => undefined);
			}
		}
		return views;
	}

	async startForeground(
		requests: DelegateRequest[],
		options: { waitMs: number; signal?: AbortSignal; onStart?: (views: TaskView[]) => void },
	): Promise<{ views: TaskView[]; report?: string; reportIds?: string[] }> {
		const views = await this.start(requests, { signal: options.signal, onStart: options.onStart });
		if (!views.length) return { views };
		const ids = new Set(views.map((view) => view.taskId));
		const onAbort = (): void => {
			for (const view of views) void this.cancel(view.taskId).catch(() => undefined);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const outcome = await this.waitForReport(options.waitMs, options.signal, ids);
			return { views, report: outcome.report, reportIds: outcome.reportIds };
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async chain(
		requests: DelegateRequest[],
		options: { waitMs: number; signal?: AbortSignal; onStart?: (views: TaskView[]) => void },
	): Promise<{ views: TaskView[]; report: string; stopped?: boolean; reportIds: string[] }> {
		const views: TaskView[] = [];
		const reportIds: string[] = [];
		let previous = "";
		let stopped = false;
		for (const request of requests) {
			if (options.signal?.aborted) {
				stopped = true;
				break;
			}
			const task = (request.task ?? "").replace(/\{previous\}/g, previous);
			const started = await this.start([{ ...request, task }], { signal: options.signal, onStart: options.onStart });
			if (!started.length) continue;
			views.push(...started);
			const id = started[0].taskId;
			if (isTerminal(started[0].status)) {
				const taken = this.takeForIds(new Set([id]));
				if (taken) reportIds.push(...taken.reportIds);
				previous = started[0].fullSummary ?? started[0].summary ?? "";
				if (started[0].status !== "completed") {
					stopped = true;
					break;
				}
				continue;
			}
			const outcome = await this.waitForReport(options.waitMs, options.signal, new Set([id]));
			if (outcome.reportIds) reportIds.push(...outcome.reportIds);
			const finished = this.tasks.get(id);
			previous = finished?.fullSummary ?? finished?.summary ?? outcome.report ?? "";
			if (!finished || finished.status !== "completed") {
				stopped = true;
				break;
			}
		}
		return { views, report: reportTextFromManager(views, this.tasks, this.now), stopped, reportIds };
	}

	private startTimer(): void {
		if (this.timer !== undefined || this.disposed) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	private stopTimerIfIdle(): void {
		if (this.watching.size > 0) return;
		this.stopTimer();
	}

	async tick(): Promise<void> {
		if (this.ticking || this.disposed) return;
		this.ticking = true;
		const generation = this.generation;
		try {
			this.observeReceipts();
			for (const id of [...this.watching]) {
				if (generation !== this.generation) break;
				await this.tickOne(id);
			}
		} finally {
			this.ticking = false;
		}
		this.requestRender();
	}

	private async tickOne(id: string): Promise<void> {
		const generation = this.generation;
		const count = (this.ticks.get(id) ?? 0) + 1;
		this.ticks.set(id, count);
		const refresh = count % STATUS_EVERY === 0;
		let state: DelegateState | undefined;
		try {
			if (refresh) state = await this.transport.status(id, { timeoutMs: 30000 });
			else state = await this.transport.poll(id);
		} catch {
			state = undefined;
		}
		if (generation !== this.generation) return;
		if (!state || typeof state.taskId !== "string") {
			const misses = (this.misses.get(id) ?? 0) + 1;
			this.misses.set(id, misses);
			if (misses >= MAX_MISSES) {
				try {
					state = await this.transport.status(id, { timeoutMs: 30000 });
				} catch {
					state = undefined;
				}
				if (generation !== this.generation) return;
				if (state && typeof state.taskId === "string") {
					this.misses.set(id, 0);
					this.statusMisses.set(id, 0);
				} else {
					this.watching.delete(id);
					this.stopTimerIfIdle();
					this.failWorker(id);
					return;
				}
			} else if (refresh) {
				const statusMisses = (this.statusMisses.get(id) ?? 0) + 1;
				this.statusMisses.set(id, statusMisses);
				if (statusMisses >= MAX_STATUS_MISSES) {
					this.watching.delete(id);
					this.stopTimerIfIdle();
					this.failWorker(id);
				}
				return;
			} else {
				return;
			}
		}
		this.misses.set(id, 0);
		if (refresh) this.statusMisses.set(id, 0);
		const previous = this.tasks.get(id);
		const view = toTaskView(state, previous);
		this.tasks.set(id, view);
		if (this.sessionId !== undefined) this.owners.set(id, this.sessionId);
		if (!previous || JSON.stringify(previous) !== JSON.stringify(view)) this.persistTasks([view]);
		this.handlePending(view, state);
		if (isTerminal(view.status)) {
			this.watching.delete(id);
			this.stopTimerIfIdle();
			this.terminalize(view);
		}
	}

	private failWorker(id: string): void {
		const previous = this.tasks.get(id);
		const view: TaskView = {
			...(previous ?? { taskId: id, agent: "", provider: "", scope: [], task: "" }),
			taskId: id,
			status: "failed",
			summary: "The worker stopped responding.",
			fullSummary: "The worker stopped responding.",
		};
		this.tasks.set(id, view);
		this.persistTasks([view]);
		this.terminalize(view);
	}

	private terminalize(view: TaskView): void {
		const call = this.callOf.get(view.taskId);
		if (call) {
			const group = this.calls.get(call)?.tasks ?? [view.taskId];
			const groupViews = group.map((taskId) => this.tasks.get(taskId));
			if (!groupViews.every((task) => task && isTerminal(task.status))) return;
			this.enqueueBatch(group.map((taskId) => reportId(this.tasks.get(taskId)!)));
			return;
		}
		this.enqueueBatch([reportId(view)]);
	}

	private enqueueBatch(reportIds: string[]): void {
		const fresh = reportIds.filter(
			(key) => !this.delivered.has(key) && !this.queued.has(key) && !this.inflight.has(key),
		);
		if (!fresh.length) return;
		for (const key of fresh) this.queued.add(key);
		this.inbox.push(fresh);
		this.persistReports();
	}

	private handlePending(view: TaskView, state: DelegateState): void {
		const ui = this.host?.ui;
		if (!ui?.available) return;
		for (const pending of state.pending ?? []) {
			if (this.answered.has(pending.id) || this.queuedPending.has(pending.id) || this.dismissed.has(pending.id)) {
				continue;
			}
			this.queuedPending.add(pending.id);
			this.dialogQueue.push({ taskId: view.taskId, pending });
		}
		void this.drainDialogs();
	}

	private async promptPending(pending: DelegatePending, ui: DelegateUI): Promise<boolean | string | undefined> {
		if (pending.kind === "permission" && ui.confirmPermission) {
			return await ui.confirmPermission(pending);
		}
		const options = (pending.options ?? [])
			.map((option) => option.label)
			.filter((label): label is string => typeof label === "string" && label.length > 0);
		const question = pending.kind === "permission" ? permissionText(pending) : pending.question;
		const reply = await ui.ask(question, options.length ? options : undefined);
		if (reply === undefined) return undefined;
		const trimmed = reply.trim();
		if (trimmed === "") return undefined;
		return pending.kind === "permission" ? APPROVAL.test(trimmed) : trimmed;
	}

	private async drainDialogs(): Promise<void> {
		if (this.dialogActive || this.disposed) return;
		const ui = this.host?.ui;
		if (!ui?.available) return;
		const next = this.dialogQueue.shift();
		if (!next) return;
		this.dialogActive = true;
		const generation = this.generation;
		try {
			const reply = await this.promptPending(next.pending, ui);
			if (this.disposed || generation !== this.generation) return;
			if (reply === undefined) {
				this.dismissed.add(next.pending.id);
				return;
			}
			const value: DelegateAnswer = typeof reply === "boolean" ? { approved: reply } : { answer: reply };
			await this.transport.answer(next.taskId, next.pending.id, value);
			if (generation !== this.generation) return;
			this.answered.add(next.pending.id);
		} catch {
			if (this.disposed || generation !== this.generation) return;
			this.queuedPending.delete(next.pending.id);
		} finally {
			if (!this.disposed) {
				this.queuedPending.delete(next.pending.id);
				this.dialogActive = false;
				if (this.dialogQueue.length) void this.drainDialogs();
			}
		}
	}

	takeReportWithIds(): { content: string; reportIds: string[] } | undefined {
		return this.takeBatch();
	}

	takeReport(): string | undefined {
		return this.takeBatch()?.content;
	}

	private takeKeys(keys: string[]): { content: string; reportIds: string[] } {
		const taken = new Set(keys);
		for (const key of keys) {
			this.queued.delete(key);
			this.inflight.add(key);
		}
		this.inbox = this.inbox
			.map((batch) => batch.filter((key) => !taken.has(key)))
			.filter((batch) => batch.length > 0);
		this.persistReports();
		const tasks = keys.map((key) => this.taskForReport(key)).filter((task): task is TaskView => Boolean(task));
		return { content: noticeText(tasks, this.now()), reportIds: keys };
	}

	private takeBatch(): { content: string; reportIds: string[] } | undefined {
		const batch = this.inbox.shift();
		return batch ? this.takeKeys(batch) : undefined;
	}

	private takeForIds(ids: Set<string>): { content: string; reportIds: string[] } | undefined {
		const keys: string[] = [];
		for (const batch of this.inbox) {
			for (const key of batch) {
				if (ids.has(taskIdOf(key))) keys.push(key);
			}
		}
		return keys.length ? this.takeKeys(keys) : undefined;
	}

	private settled(ids: Set<string>): boolean {
		for (const id of ids) {
			const task = this.tasks.get(id);
			if (task && !isTerminal(task.status)) return false;
		}
		return true;
	}

	async waitForReport(waitMs: number, signal?: AbortSignal, ids?: Set<string>): Promise<WaitOutcome> {
		const deadline = this.now() + Math.max(0, waitMs);
		const attempt = (): { content: string; reportIds: string[] } | undefined => {
			if (ids) return this.settled(ids) ? this.takeForIds(ids) : undefined;
			return this.takeBatch();
		};
		await this.tick();
		for (;;) {
			const taken = attempt();
			if (taken) return { report: taken.content, reportIds: taken.reportIds, running: this.activeTasks() };
			if (this.disposed || signal?.aborted) break;
			if (this.watching.size === 0 && this.inbox.length === 0) break;
			const remaining = deadline - this.now();
			if (remaining <= 0) break;
			await sleep(Math.min(1000, remaining));
			await this.tick();
		}
		const taken = attempt();
		if (taken) return { report: taken.content, reportIds: taken.reportIds, running: this.activeTasks() };
		return { running: this.activeTasks() };
	}

	recordCall(toolCallId: string, taskIds: string[]): void {
		this.calls.set(toolCallId, { tasks: taskIds });
		for (const taskId of taskIds) this.callOf.set(taskId, toolCallId);
		this.persistCalls();
		const groupViews = taskIds.map((taskId) => this.tasks.get(taskId));
		if (groupViews.length && groupViews.every((task) => task && isTerminal(task.status))) {
			this.enqueueBatch(taskIds.map((taskId) => reportId(this.tasks.get(taskId)!)));
		}
	}

	callTasks(toolCallId: string): string[] {
		return this.calls.get(toolCallId)?.tasks ?? [];
	}

	allTasks(): TaskView[] {
		return [...this.tasks.values()]
			.filter((task) => this.owns(task.taskId))
			.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	}

	activeTasks(): TaskView[] {
		return this.allTasks().filter((task) => !isTerminal(task.status));
	}

	get(taskId: string): TaskView | undefined {
		return this.owns(taskId) ? this.tasks.get(taskId) : undefined;
	}

	liveRows(): LiveRow[] {
		return toLiveRows(this.activeTasks());
	}

	async cancel(taskId: string): Promise<TaskView> {
		this.assertOwner(taskId);
		const generation = this.generation;
		const state = await this.transport.cancel(taskId);
		if (generation !== this.generation) throw new Error(`Task ${taskId} is no longer owned by this session.`);
		return this.applyState(state, taskId);
	}

	async diff(taskId: string): Promise<string> {
		this.assertOwner(taskId);
		return this.transport.diff(taskId);
	}

	async refresh(taskId: string): Promise<TaskView> {
		this.assertOwner(taskId);
		const generation = this.generation;
		const state = await this.transport.status(taskId, { timeoutMs: 30000 });
		if (generation !== this.generation) throw new Error(`Task ${taskId} is no longer owned by this session.`);
		return this.applyState(state, taskId);
	}

	async answer(taskId: string, requestId: string, value: DelegateAnswer): Promise<void> {
		this.assertOwner(taskId);
		await this.transport.answer(taskId, requestId, value);
		this.answered.add(requestId);
	}

	async accept(taskId: string): Promise<TaskView> {
		this.assertOwner(taskId);
		const generation = this.generation;
		const state = await this.transport.accept(taskId);
		if (generation !== this.generation) throw new Error(`Task ${taskId} is no longer owned by this session.`);
		this.watching.delete(taskId);
		this.stopTimerIfIdle();
		const view = { ...toTaskView(state, this.tasks.get(taskId)), status: "accepted" };
		this.tasks.set(taskId, view);
		this.persistTasks([view]);
		return view;
	}

	async undo(taskId: string, force: boolean): Promise<TaskView> {
		this.assertOwner(taskId);
		const generation = this.generation;
		const state = await this.transport.undo(taskId, force);
		if (generation !== this.generation) throw new Error(`Task ${taskId} is no longer owned by this session.`);
		this.watching.delete(taskId);
		this.stopTimerIfIdle();
		const view = {
			...toTaskView(state, this.tasks.get(taskId)),
			status: "undone",
			diffstat: undefined,
			restored: state.restored ?? [],
		};
		this.tasks.set(taskId, view);
		this.persistTasks([view]);
		return view;
	}

	async prune(olderThan: string): Promise<{ removed: string[]; kept: { taskId: string; reason: string }[] }> {
		return this.transport.prune(olderThan);
	}

	async agents(cwd: string): Promise<DelegateAgentInfo[]> {
		return this.transport.agents(cwd);
	}

	private async withProjectAgentTrust(requests: DelegateRequest[]): Promise<DelegateRequest[]> {
		const cleared = requests.map(({ trustProjectAgents: _ignored, ...request }) => request);
		const ui = this.host?.ui;
		if (!ui?.available || !ui.confirmProjectAgent) return cleared;
		const listed = new Map<string, DelegateAgentInfo[]>();
		const result: DelegateRequest[] = [];
		for (const request of cleared) {
			const cwd = request.cwd ?? this.host?.cwd ?? "";
			if (!request.agent || !cwd) {
				result.push(request);
				continue;
			}
			if (!listed.has(cwd)) listed.set(cwd, await this.transport.agents(cwd).catch(() => []));
			const agent = listed.get(cwd)?.find((item) => item.name === request.agent);
			if (agent?.source !== "project") {
				result.push(request);
				continue;
			}
			const key = `${cwd}\0${agent.filePath ?? agent.name}`;
			if (!this.approvedAgents.has(key) && (await ui.confirmProjectAgent(agent)) === true)
				this.approvedAgents.add(key);
			result.push(this.approvedAgents.has(key) ? { ...request, trustProjectAgents: true } : request);
		}
		return result;
	}

	async listModels(provider?: string): Promise<DelegateModelList[]> {
		return this.transport.listModels(provider);
	}

	private assertOwner(taskId: string): void {
		if (!this.owns(taskId)) throw new Error(`Unknown task ${taskId}. It was not started by this session.`);
	}

	private applyState(state: DelegateState, fallbackId: string): TaskView {
		const id = typeof state.taskId === "string" ? state.taskId : fallbackId;
		const view = toTaskView(state, this.tasks.get(id));
		this.tasks.set(id, view);
		if (this.sessionId !== undefined) this.owners.set(id, this.sessionId);
		this.persistTasks([view]);
		if (isTerminal(view.status)) {
			this.watching.delete(id);
			this.stopTimerIfIdle();
			this.terminalize(view);
		}
		return view;
	}

	private persistTasks(views: TaskView[]): void {
		if (!views.length) return;
		const tasks = Object.fromEntries(views.map((view) => [view.taskId, view]));
		this.appendEntry(TASKS_ENTRY, { owner: this.sessionId, tasks });
	}

	private persistCalls(): void {
		this.appendEntry(CALLS_ENTRY, { owner: this.sessionId, calls: Object.fromEntries(this.calls) });
	}

	private persistReports(): void {
		this.appendEntry(REPORTS_ENTRY, {
			owner: this.sessionId,
			queued: [...this.queued],
			inflight: [...this.inflight],
			delivered: [...this.delivered],
		});
	}

	dispose(): void {
		this.disposed = true;
		this.stopTimer();
		this.dialogQueue = [];
		this.queuedPending.clear();
		this.watching.clear();
		this.host = undefined;
	}
}

function reportTextFromManager(views: TaskView[], tasks: Map<string, TaskView>, now: () => number): string {
	const latest = views.map((view) => tasks.get(view.taskId) ?? view);
	return reportText(latest, now());
}
