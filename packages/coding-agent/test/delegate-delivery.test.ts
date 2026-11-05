import { describe, expect, it } from "vitest";
import { DelegateManager, type DelegateUI } from "../src/core/delegate/manager.ts";
import type {
	DelegateAgentInfo,
	DelegateAnswer,
	DelegateModelList,
	DelegateRequest,
	DelegateState,
	DelegateTransport,
} from "../src/core/delegate/transport.ts";
import { isTerminal, REPORT_TAG } from "../src/core/delegate/view.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createDelegateExtension } from "../src/extensions/delegate/index.ts";
import { DELEGATE_TASKS_TOOL_NAME, DELEGATE_TOOL_NAME } from "../src/extensions/delegate/tools.ts";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function customEntry(customType: string, data: unknown): SessionEntry {
	return { type: "custom", customType, data } as unknown as SessionEntry;
}

function storedResultEntry(details: unknown, content: unknown[], toolCallId: string, toolName: string): SessionEntry {
	return {
		type: "message",
		message: { role: "toolResult", toolCallId, toolName, content, details, isError: false, timestamp: 1 },
	} as unknown as SessionEntry;
}

class FakeTransport implements DelegateTransport {
	states = new Map<string, DelegateState>();
	starts: DelegateRequest[][] = [];
	answers: { taskId: string; requestId: string; value: DelegateAnswer }[] = [];
	absent = new Set<string>();
	statusGone = new Set<string>();
	cancels: string[] = [];
	private counter = 0;

	complete(id: string, status = "completed", extra: Partial<DelegateState> = {}): DelegateState {
		const state = this.states.get(id)!;
		Object.assign(state, { status, finishedAt: 2000, durationMs: 1000, summary: `${status} summary`, ...extra });
		return state;
	}

	private assign(request: DelegateRequest): DelegateState {
		const state: DelegateState = {
			taskId: uuid(++this.counter),
			agent: request.agent ?? "worker",
			provider: request.provider ?? "pi",
			status: "running",
			scope: request.scope ?? [],
			task: request.task,
			startedAt: 1000,
			activity: [],
		};
		this.states.set(state.taskId, state);
		return state;
	}

	async run(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return { stdout: "", stderr: "", exitCode: 0 };
	}
	async start(requests: DelegateRequest[]): Promise<DelegateState[]> {
		this.starts.push(requests);
		return requests.map((request) => this.assign(request));
	}
	async status(id: string): Promise<DelegateState> {
		if (this.absent.has(id) || this.statusGone.has(id)) throw new Error("unknown task");
		const state = this.states.get(id);
		if (!state) throw new Error("unknown task");
		return state;
	}
	async poll(id: string): Promise<DelegateState | undefined> {
		if (this.absent.has(id)) return undefined;
		return this.states.get(id);
	}
	async answer(taskId: string, requestId: string, value: DelegateAnswer): Promise<void> {
		this.answers.push({ taskId, requestId, value });
	}
	async cancel(id: string): Promise<DelegateState> {
		this.cancels.push(id);
		return this.complete(id, "cancelled");
	}
	async diff(): Promise<string> {
		return "diff body";
	}
	async accept(id: string): Promise<DelegateState> {
		return this.complete(id, "accepted");
	}
	async undo(id: string): Promise<DelegateState> {
		const state = this.complete(id, "undone");
		state.restored = ["src/a.ts"];
		return state;
	}
	async prune(): Promise<{ removed: string[]; kept: { taskId: string; reason: string }[] }> {
		return { removed: [], kept: [] };
	}
	async agents(): Promise<DelegateAgentInfo[]> {
		return [];
	}

	async listModels(): Promise<DelegateModelList[]> {
		return [];
	}
}

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ToolLike {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface FakePi {
	handlers: Record<string, Handler[]>;
	tools: Map<string, ToolLike>;
	entries: SessionEntry[];
}

function installFakePi(pi: FakePi): unknown {
	return {
		on(event: string, handler: Handler) {
			const list = pi.handlers[event] ?? [];
			list.push(handler);
			pi.handlers[event] = list;
			return () => {};
		},
		registerTool(tool: unknown) {
			const value = tool as ToolLike;
			pi.tools.set(value.name, value);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		appendEntry(customType: string, data: unknown) {
			pi.entries.push(customEntry(customType, data));
		},
	};
}

const SILENT_UI: DelegateUI = { available: false, ask: async () => undefined, notify: () => {} };

function makeCtx(entries: SessionEntry[], sessionId: string, ui: DelegateUI): unknown {
	return {
		cwd: "/tmp/project",
		hasUI: ui.available,
		mode: "print",
		ui: {
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => undefined,
			notify: () => {},
			custom: async () => undefined,
			setWidget: () => {},
			onTerminalInput: () => () => {},
		},
		sessionManager: { getBranch: () => entries, getSessionId: () => sessionId },
	};
}

interface Boot {
	pi: FakePi;
	ctx: unknown;
	manager: DelegateManager;
}

async function boot(options: {
	transport: DelegateTransport;
	entries: SessionEntry[];
	sessionId?: string;
	ui?: DelegateUI;
}): Promise<Boot> {
	const pi: FakePi = { handlers: {}, tools: new Map(), entries: options.entries };
	let manager: DelegateManager | undefined;
	createDelegateExtension({
		transport: options.transport,
		intervalMs: 100000,
		now: () => 1000,
		onManager: (value) => {
			manager = value;
		},
	})(installFakePi(pi) as never);
	const ctx = makeCtx(options.entries, options.sessionId ?? "session-a", options.ui ?? SILENT_UI);
	await pi.handlers.session_start![0]!({ type: "session_start", reason: "startup" }, ctx);
	return { pi, ctx, manager: manager! };
}

interface ToolResultShape {
	content: { type: string; text?: string }[];
	details?: { views?: { taskId: string }[]; delegateReportIds?: string[]; taskId?: string; status?: string };
	isError?: boolean;
}

async function runTool(pi: FakePi, name: string, input: unknown, ctx: unknown): Promise<ToolResultShape> {
	const tool = pi.tools.get(name)!;
	return (await tool.execute("call-run", input, undefined, undefined, ctx)) as ToolResultShape;
}

interface Delivery {
	text: string;
	ids: string[];
}

type ToolResultHandlerOutput =
	| { content: { type: string; text?: string }[]; details?: { delegateReportIds?: string[] } }
	| undefined;

function toolResultHandler(pi: FakePi): ToolResultHandlerOutput {
	const handler = pi.handlers.tool_result![0]!;
	return handler(
		{
			content: [{ type: "text", text: "base" }],
			details: {},
			structuredContent: undefined,
			parentToolCallId: undefined,
		},
		{},
	) as ToolResultHandlerOutput;
}

function deliverReport(pi: FakePi, toolCallId: string): Delivery | undefined {
	const outcome = toolResultHandler(pi);
	if (!outcome) return undefined;
	pi.entries.push(storedResultEntry(outcome.details, outcome.content, toolCallId, "some_tool"));
	return {
		text: outcome.content.map((part) => part.text ?? "").join("\n"),
		ids: outcome.details?.delegateReportIds ?? [],
	};
}

function countTag(text: string): number {
	return text.split(`<${REPORT_TAG}>`).length - 1;
}

interface HostUi {
	sessionId: string;
	cwd: string;
	branchEntries: () => SessionEntry[];
	ui: DelegateUI;
}

function rawManager(transport: FakeTransport, entries: SessionEntry[], ui: DelegateUI): DelegateManager {
	const manager = new DelegateManager({
		transport,
		appendEntry: (customType, data) => entries.push(customEntry(customType, data)),
		now: () => 1000,
	});
	const host: HostUi = {
		sessionId: "session-a",
		cwd: "/tmp/project",
		branchEntries: () => entries,
		ui,
	};
	manager.setHost(host);
	return manager;
}

describe("delegate report delivery", () => {
	it("attaches a report to the next tool result exactly once", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const { pi, ctx, manager } = await boot({ transport, entries });
		const started = await runTool(pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "work" }, ctx);
		const taskId = started.details!.views![0]!.taskId;
		transport.complete(taskId);
		await manager.tick();

		const first = deliverReport(pi, "call-1");
		expect(first).toBeDefined();
		expect(first!.text).toContain(taskId);
		expect(countTag(first!.text)).toBe(1);
		expect(first!.ids).toEqual([`${taskId}:completed`]);
		await manager.tick();

		const second = deliverReport(pi, "call-2");
		expect(second).toBeUndefined();
		manager.dispose();
	});

	it("does not deliver a wait report again on a later tool result", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const { pi, ctx, manager } = await boot({ transport, entries });
		const started = await runTool(pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "work" }, ctx);
		const taskId = started.details!.views![0]!.taskId;
		transport.complete(taskId);
		await manager.tick();

		const waited = await runTool(pi, DELEGATE_TASKS_TOOL_NAME, { action: "wait", waitMs: 5000 }, ctx);
		expect(waited.content[0]!.text).toContain(taskId);
		expect(waited.details!.delegateReportIds).toEqual([`${taskId}:completed`]);
		pi.entries.push(storedResultEntry(waited.details, waited.content, "call-wait", DELEGATE_TASKS_TOOL_NAME));
		await manager.tick();

		const later = deliverReport(pi, "call-2");
		expect(later).toBeUndefined();
		manager.dispose();
	});
});

describe("delegate report recovery", () => {
	it("survives a reload from persisted entries and is delivered once", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const first = await boot({ transport, entries });
		const started = await runTool(first.pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "work" }, first.ctx);
		const taskId = started.details!.views![0]!.taskId;
		transport.complete(taskId);
		await first.manager.tick();
		first.manager.dispose();

		const second = await boot({ transport, entries });
		const delivered = deliverReport(second.pi, "call-1");
		expect(delivered).toBeDefined();
		expect(delivered!.ids).toEqual([`${taskId}:completed`]);
		await second.manager.tick();
		expect(deliverReport(second.pi, "call-2")).toBeUndefined();
		second.manager.dispose();
	});

	it("does not deliver a report again after a reload once it was delivered", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const first = await boot({ transport, entries });
		const started = await runTool(first.pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "work" }, first.ctx);
		const taskId = started.details!.views![0]!.taskId;
		transport.complete(taskId);
		await first.manager.tick();

		const delivered = deliverReport(first.pi, "call-1");
		expect(delivered).toBeDefined();
		await first.manager.tick();
		first.manager.dispose();

		const second = await boot({ transport, entries });
		expect(deliverReport(second.pi, "call-2")).toBeUndefined();
		second.manager.dispose();
	});
});

describe("delegate session isolation and restart safety", () => {
	it("never delivers a report owned by session A to session B", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const first = await boot({ transport, entries, sessionId: "session-a" });
		const started = await runTool(first.pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "work" }, first.ctx);
		const taskId = started.details!.views![0]!.taskId;
		transport.complete(taskId);
		await first.manager.tick();

		const ctxB = makeCtx(entries, "session-b", SILENT_UI);
		await first.pi.handlers.session_start![0]!({ type: "session_start", reason: "switch" }, ctxB);
		expect(first.manager.allTasks()).toHaveLength(0);
		expect(deliverReport(first.pi, "call-b")).toBeUndefined();

		await first.pi.handlers.session_start![0]!({ type: "session_start", reason: "switch" }, first.ctx);
		const back = deliverReport(first.pi, "call-a");
		expect(back).toBeDefined();
		expect(back!.ids).toEqual([`${taskId}:completed`]);
		first.manager.dispose();
	});

	it("does not start a finished or stopped task again after a reload", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const first = await boot({ transport, entries });
		const done = await runTool(first.pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "done" }, first.ctx);
		const doneId = done.details!.views![0]!.taskId;
		transport.complete(doneId);
		const stopped = await runTool(first.pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "stopped" }, first.ctx);
		const stoppedId = stopped.details!.views![0]!.taskId;
		await runTool(first.pi, DELEGATE_TASKS_TOOL_NAME, { action: "cancel", taskId: stoppedId }, first.ctx);
		await first.manager.tick();
		const startsBefore = transport.starts.length;
		first.manager.dispose();

		const second = await boot({ transport, entries });
		expect(transport.starts.length).toBe(startsBefore);
		expect(second.manager.activeTasks()).toHaveLength(0);
		expect(second.manager.get(doneId)!.status).toBe("completed");
		expect(second.manager.get(stoppedId)!.status).toBe("cancelled");
		second.manager.dispose();
	});
});

describe("delegate dead worker detection", () => {
	it("marks a vanished worker terminal and delivers its report", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const { pi, ctx, manager } = await boot({ transport, entries });
		const started = await runTool(pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "ghost" }, ctx);
		const taskId = started.details!.views![0]!.taskId;
		transport.absent.add(taskId);
		for (let i = 0; i < 65; i++) await manager.tick();

		const view = manager.get(taskId)!;
		expect(isTerminal(view.status)).toBe(true);
		expect(view.status).toBe("failed");
		expect(manager.takeReportWithIds()?.content).toContain(taskId);
		manager.dispose();
	});

	it("marks a worker terminal when its process is gone but its state file stays running", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const { pi, ctx, manager } = await boot({ transport, entries });
		const started = await runTool(pi, DELEGATE_TOOL_NAME, { agent: "worker", task: "zombie" }, ctx);
		const taskId = started.details!.views![0]!.taskId;
		transport.statusGone.add(taskId);
		for (let i = 0; i < 200; i++) await manager.tick();

		const view = manager.get(taskId)!;
		expect(isTerminal(view.status)).toBe(true);
		expect(view.status).toBe("failed");
		expect(manager.takeReportWithIds()?.content).toContain(taskId);
		manager.dispose();
	});
});

class SerialUI implements DelegateUI {
	available = true;
	asked: string[] = [];
	maxConcurrent = 0;
	private active = 0;
	private resolvers: ((value: string | undefined) => void)[] = [];

	ask = (question: string): Promise<string | undefined> => {
		this.asked.push(question);
		this.active += 1;
		this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
		return new Promise<string | undefined>((resolve) => {
			this.resolvers.push((value) => {
				this.active -= 1;
				resolve(value);
			});
		});
	};

	reply(value: string | undefined): void {
		this.resolvers.shift()?.(value);
	}

	notify(): void {}
}

describe("delegate dialog serialization", () => {
	it("serializes two children's dialogs and routes each answer to its child", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const ui = new SerialUI();
		const manager = rawManager(transport, entries, ui);
		const [childA] = await manager.start([{ agent: "worker", task: "A", cwd: "/tmp/project" }]);
		const [childB] = await manager.start([{ agent: "worker", task: "B", cwd: "/tmp/project" }]);
		const stateA = transport.states.get(childA.taskId)!;
		stateA.status = "waiting";
		stateA.pending = [{ id: "qA", kind: "question", question: "question A" }];
		const stateB = transport.states.get(childB.taskId)!;
		stateB.status = "waiting";
		stateB.pending = [{ id: "qB", kind: "question", question: "question B" }];

		await manager.tick();
		await flush();
		expect(ui.asked).toEqual(["question A"]);
		expect(ui.maxConcurrent).toBe(1);

		ui.reply("answer A");
		await flush();
		expect(transport.answers).toContainEqual({
			taskId: childA.taskId,
			requestId: "qA",
			value: { answer: "answer A" },
		});
		expect(ui.asked).toEqual(["question A", "question B"]);
		expect(ui.maxConcurrent).toBe(1);

		ui.reply("answer B");
		await flush();
		expect(transport.answers).toContainEqual({
			taskId: childB.taskId,
			requestId: "qB",
			value: { answer: "answer B" },
		});
		expect(transport.answers).toHaveLength(2);

		await manager.tick();
		await flush();
		expect(transport.answers).toHaveLength(2);
		expect(ui.asked).toHaveLength(2);
		manager.dispose();
	});
});
