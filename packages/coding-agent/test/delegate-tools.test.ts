import { describe, expect, it } from "vitest";
import type { DelegateHost } from "../src/core/delegate/manager.ts";
import { DelegateManager } from "../src/core/delegate/manager.ts";
import type {
	DelegateAgentInfo,
	DelegateAnswer,
	DelegateModelList,
	DelegateRequest,
	DelegateState,
	DelegateTransport,
} from "../src/core/delegate/transport.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createDelegateTasksTool, createDelegateTool, resolveMode } from "../src/extensions/delegate/tools.ts";

function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

class FakeTransport implements DelegateTransport {
	states = new Map<string, DelegateState>();
	starts: DelegateRequest[][] = [];
	answers: { taskId: string; requestId: string; value: DelegateAnswer }[] = [];
	autoComplete = true;
	private counter = 0;

	complete(id: string, status = "completed", extra: Partial<DelegateState> = {}): DelegateState {
		const state = this.states.get(id)!;
		Object.assign(state, { status, finishedAt: 2000, durationMs: 1000, summary: `${status} summary`, ...extra });
		return state;
	}

	async run(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return { stdout: "", stderr: "", exitCode: 0 };
	}
	async start(requests: DelegateRequest[]): Promise<DelegateState[]> {
		this.starts.push(requests);
		return requests.map((request) => {
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
			if (this.autoComplete) this.complete(state.taskId);
			return { ...state, status: "running", summary: undefined };
		});
	}
	async status(id: string): Promise<DelegateState> {
		const state = this.states.get(id);
		if (!state) throw new Error("unknown task");
		return state;
	}
	async poll(id: string): Promise<DelegateState | undefined> {
		return this.states.get(id);
	}
	async answer(taskId: string, requestId: string, value: DelegateAnswer): Promise<void> {
		this.answers.push({ taskId, requestId, value });
	}
	async cancel(id: string): Promise<DelegateState> {
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
		return [{ provider: "pi", models: [{ id: "pi/glm", description: "GLM", efforts: ["high"] }], fetchedAt: 1 }];
	}
}

interface Harness {
	transport: FakeTransport;
	manager: DelegateManager;
	delegate: ReturnType<typeof createDelegateTool>;
	tasks: ReturnType<typeof createDelegateTasksTool>;
	ctx: ExtensionToolContext;
	entries: SessionEntry[];
}

function managerFor(transport: FakeTransport, entries: SessionEntry[]): DelegateManager {
	const manager = new DelegateManager({
		transport,
		appendEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data } as unknown as SessionEntry);
		},
		now: () => Date.now(),
	});
	manager.setHost({
		sessionId: "session-a",
		cwd: "/tmp/project",
		branchEntries: () => entries,
		ui: { available: false, ask: async () => undefined, notify: () => {} },
	});
	return manager;
}

function toolResultEntry(details: unknown): SessionEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-foreground",
			toolName: "delegate",
			content: [],
			details,
			isError: false,
			timestamp: 1,
		},
	} as unknown as SessionEntry;
}

function makeHarness(): Harness {
	const transport = new FakeTransport();
	const entries: SessionEntry[] = [];
	const manager = managerFor(transport, entries);
	const host: DelegateHost = {
		sessionId: "session-a",
		cwd: "/tmp/project",
		branchEntries: () => entries,
		ui: { available: false, ask: async () => undefined, notify: () => {} },
	};
	const deps = { manager, hostFrom: () => host };
	const ctx = { cwd: "/tmp/project" } as unknown as ExtensionToolContext;
	return {
		transport,
		manager,
		delegate: createDelegateTool(deps),
		tasks: createDelegateTasksTool(deps),
		ctx,
		entries,
	};
}

interface ToolResultShape {
	content: { type: string; text: string }[];
	details?: {
		views?: { taskId: string; agent: string; status: string }[];
		status?: string;
		taskId?: string;
		delegateReportIds?: string[];
	};
	isError?: boolean;
}

let callSeq = 0;

type ToolExecute = (
	id: string,
	params: unknown,
	signal: undefined,
	onUpdate: undefined,
	ctx: ExtensionToolContext,
) => Promise<ToolResultShape>;

async function run(tool: { execute: unknown }, ctx: ExtensionToolContext, input: unknown): Promise<ToolResultShape> {
	const execute = tool.execute as ToolExecute;
	return execute(`call-${++callSeq}`, input, undefined, undefined, ctx);
}

describe("delegate tool modes", () => {
	it("resolves single, parallel and chain modes and rejects mixed input", () => {
		expect(resolveMode({ agent: "worker", task: "x" }, "/p").mode).toBe("single");
		expect(
			resolveMode(
				{
					tasks: [
						{ agent: "a", task: "1" },
						{ agent: "b", task: "2" },
					],
				},
				"/p",
			).mode,
		).toBe("parallel");
		expect(resolveMode({ chain: [{ agent: "a", task: "1 {previous}" }] }, "/p").mode).toBe("chain");
		expect(resolveMode({ agent: "a", task: "x", tasks: [{ agent: "b", task: "y" }] }, "/p").ok).toBe(false);
		expect(resolveMode({}, "/p").ok).toBe(false);
	});

	it("starts a single background task with the brief mapped to the view", async () => {
		const h = makeHarness();
		const result = await run(h.delegate, h.ctx, { agent: "worker", task: "do work" });
		expect(result.content[0]!.text).toContain("Started in the background");
		expect(result.details!.views![0]!.agent).toBe("worker");
		h.manager.dispose();
	});

	it("runs a chain array in order, threading {previous}", async () => {
		const h = makeHarness();
		const result = await run(h.delegate, h.ctx, {
			chain: [
				{ agent: "a", task: "first" },
				{ agent: "b", task: "then {previous}" },
			],
		});
		expect(result.content[0]!.text).toContain("2/2 completed");
		expect(h.transport.starts[1]![0]!.task).toContain("completed summary");
		h.manager.dispose();
	});

	it("waits and returns the report for a foreground call", async () => {
		const h = makeHarness();
		const result = await run(h.delegate, h.ctx, { agent: "worker", task: "sync", background: false });
		expect(result.details!.views).toHaveLength(1);
		expect(result.content[0]!.text).toContain("completed");
		h.manager.dispose();
	});
});

describe("delegate_tasks actions", () => {
	it("sends an approved answer and an alias answer", async () => {
		const h = makeHarness();
		const view = (await run(h.delegate, h.ctx, { agent: "worker", task: "x" })).details!.views![0]!.taskId;
		await run(h.tasks, h.ctx, { action: "answer", taskId: view, requestId: "p1", approved: true });
		await run(h.tasks, h.ctx, { action: "answer", taskId: view, requestId: "q1", answer: "src/a.ts" });
		await run(h.tasks, h.ctx, { action: "answer", taskId: view, requestId: "p2", approve: false });
		expect(h.transport.answers).toEqual([
			{ taskId: view, requestId: "p1", value: { approved: true } },
			{ taskId: view, requestId: "q1", value: { answer: "src/a.ts" } },
			{ taskId: view, requestId: "p2", value: { approved: false } },
		]);
		h.manager.dispose();
	});

	it("returns the raw summary and log path for a task status", async () => {
		const h = makeHarness();
		h.transport.autoComplete = false;
		const view = (await run(h.delegate, h.ctx, { agent: "worker", task: "x" })).details!.views![0]!.taskId;
		const long = "y".repeat(900);
		h.transport.complete(view, "completed", { summary: long, logPath: "/tmp/log.txt" });
		const result = await run(h.tasks, h.ctx, { action: "status", taskId: view });
		expect(result.content[0]!.text).toContain(long);
		expect(result.content[0]!.text).toContain("/tmp/log.txt");
		h.manager.dispose();
	});

	it("waits only for the named task", async () => {
		const h = makeHarness();
		const first = (await run(h.delegate, h.ctx, { agent: "worker", task: "first" })).details!.views![0]!.taskId;
		await run(h.delegate, h.ctx, { agent: "worker", task: "second" });
		const result = await run(h.tasks, h.ctx, { action: "wait", taskId: first, waitMs: 5000 });
		expect(result.content[0]!.text).toContain(first);
		h.manager.dispose();
	});

	it("runs cancel, diff, undo, accept and prune", async () => {
		const h = makeHarness();
		const id = (await run(h.delegate, h.ctx, { agent: "worker", task: "x" })).details!.views![0]!.taskId;
		expect((await run(h.tasks, h.ctx, { action: "diff", taskId: id })).content[0]!.text).toContain("diff body");
		expect((await run(h.tasks, h.ctx, { action: "cancel", taskId: id })).content[0]!.text).toContain("cancelled");
		expect((await run(h.tasks, h.ctx, { action: "undo", taskId: id })).content[0]!.text).toContain("src/a.ts");
		expect((await run(h.tasks, h.ctx, { action: "accept", taskId: id })).content[0]!.text).toContain("Accepted");
		expect((await run(h.tasks, h.ctx, { action: "prune" })).content[0]!.text).toContain("Removed 0");
		h.manager.dispose();
	});

	it("lists models through the models action", async () => {
		const h = makeHarness();
		const result = await run(h.tasks, h.ctx, { action: "models" });
		expect(result.content[0]!.text).toContain("pi");
		expect(result.content[0]!.text).toContain("pi/glm");
		expect(result.content[0]!.text).toContain("GLM");
		expect(result.content[0]!.text).toContain("[high]");
		const one = await run(h.tasks, h.ctx, { action: "models", provider: "pi" });
		expect(one.content[0]!.text).toContain("pi/glm");
		h.manager.dispose();
	});

	it("reports an unknown task and lists active tasks", async () => {
		const h = makeHarness();
		const unknown = await run(h.tasks, h.ctx, { action: "status", taskId: "nope" });
		expect(unknown.content[0]!.text).toContain("Unknown task");
		h.transport.autoComplete = false;
		await run(h.delegate, h.ctx, { agent: "worker", task: "running" });
		const list = await run(h.tasks, h.ctx, { action: "status" });
		expect(list.content[0]!.text).toContain("Active tasks");
		h.manager.dispose();
	});
});

describe("delegate receipt persistence", () => {
	it("does not repeat a foreground notice once its toolResult receipt is stored", async () => {
		const h = makeHarness();
		const result = await run(h.delegate, h.ctx, { agent: "worker", task: "sync", background: false });
		const ids = result.details!.delegateReportIds ?? [];
		expect(ids.length).toBeGreaterThan(0);
		h.entries.push(toolResultEntry(result.details));
		h.manager.dispose();

		const restored = managerFor(h.transport, h.entries);
		restored.restore();
		expect(restored.takeReportWithIds()).toBeUndefined();
		restored.dispose();
	});

	it("re-queues an unstored notice after a crash before the receipt is persisted", async () => {
		const h = makeHarness();
		const result = await run(h.delegate, h.ctx, { agent: "worker", task: "sync", background: false });
		expect((result.details!.delegateReportIds ?? []).length).toBeGreaterThan(0);
		h.manager.dispose();

		const restored = managerFor(h.transport, h.entries);
		restored.restore();
		const report = restored.takeReportWithIds();
		expect(report).toBeDefined();
		expect(report!.reportIds.length).toBeGreaterThan(0);
		restored.dispose();
	});

	it("aggregates chain step IDs without leaving an orphan notice", async () => {
		const h = makeHarness();
		const result = await run(h.delegate, h.ctx, {
			chain: [
				{ agent: "a", task: "first" },
				{ agent: "b", task: "then {previous}" },
			],
		});
		expect(result.details!.delegateReportIds).toHaveLength(2);
		expect(h.manager.takeReportWithIds()).toBeUndefined();
		h.manager.dispose();
	});
});
