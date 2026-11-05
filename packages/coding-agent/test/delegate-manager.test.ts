import { describe, expect, it } from "vitest";
import { type DelegateHost, DelegateManager, type DelegateUI, type WaitOutcome } from "../src/core/delegate/manager.ts";
import type {
	DelegateAgentInfo,
	DelegateAnswer,
	DelegateModelList,
	DelegatePending,
	DelegateRequest,
	DelegateState,
	DelegateTransport,
} from "../src/core/delegate/transport.ts";
import { detailText } from "../src/core/delegate/view.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function customEntry(customType: string, data: unknown): SessionEntry {
	return { type: "custom", customType, data } as unknown as SessionEntry;
}

function receiptEntry(reportIds: string[]): SessionEntry {
	return {
		type: "custom_message",
		customType: "delegate-report",
		content: "notice",
		details: { delegateReportIds: reportIds },
		display: true,
	} as unknown as SessionEntry;
}

class FakeTransport implements DelegateTransport {
	states = new Map<string, DelegateState>();
	starts: DelegateRequest[][] = [];
	answers: { taskId: string; requestId: string; value: DelegateAnswer }[] = [];
	cancels: string[] = [];
	absent = new Set<string>();
	completeStatus = "completed";
	autoFinish = false;
	private counter = 0;

	private assign(request: DelegateRequest, status = "running"): DelegateState {
		const state: DelegateState = {
			taskId: uuid(++this.counter),
			agent: request.agent ?? "worker",
			provider: request.provider ?? "pi",
			status,
			scope: request.scope ?? [],
			task: request.task,
			startedAt: 1000,
			activity: [],
		};
		this.states.set(state.taskId, state);
		return state;
	}

	private finish(id: string): DelegateState {
		const state = this.states.get(id)!;
		state.status = this.completeStatus;
		state.finishedAt = 2000;
		state.durationMs = 1000;
		state.summary = `summary-${state.taskId}`;
		return state;
	}

	async run(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return { stdout: "", stderr: "", exitCode: 0 };
	}
	async start(requests: DelegateRequest[]): Promise<DelegateState[]> {
		this.starts.push(requests);
		return requests.map((request) => {
			const view = this.assign(request);
			if (this.autoFinish) {
				this.finish(view.taskId);
				return { ...view, status: "running", summary: undefined };
			}
			return view;
		});
	}
	async status(id: string): Promise<DelegateState> {
		const state = this.states.get(id);
		if (!state || this.absent.has(id)) throw new Error("unknown task");
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
		const state = this.states.get(id)!;
		state.status = "cancelled";
		return state;
	}
	async diff(): Promise<string> {
		return "diff body";
	}
	async accept(id: string): Promise<DelegateState> {
		const state = this.states.get(id)!;
		state.status = "accepted";
		return state;
	}
	async undo(id: string): Promise<DelegateState> {
		const state = this.states.get(id)!;
		state.status = "undone";
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

function makeHost(entries: SessionEntry[], sessionId: string, ui: DelegateUI): DelegateHost {
	return {
		sessionId,
		cwd: "/tmp/project",
		branchEntries: () => entries,
		ui,
	};
}

const SILENT_UI: DelegateUI = { available: false, ask: async () => undefined, notify: () => {} };

function makeManager(transport: FakeTransport, entries: SessionEntry[], sessionId = "session-a"): DelegateManager {
	const manager = new DelegateManager({
		transport,
		appendEntry: (customType, data) => {
			entries.push(customEntry(customType, data));
		},
		now: () => 1000,
	});
	manager.setHost(makeHost(entries, sessionId, SILENT_UI));
	return manager;
}

function entriesOf(entries: SessionEntry[], customType: string): unknown[] {
	return entries
		.filter((entry) => (entry as { customType?: string }).customType === customType)
		.map((entry) => (entry as { data?: unknown }).data);
}

class RecordingUI implements DelegateUI {
	available = true;
	asked: string[] = [];
	confirmed: DelegatePending[] = [];
	reply: string | undefined = undefined;
	approve: boolean | undefined = false;
	ask = async (question: string): Promise<string | undefined> => {
		this.asked.push(question);
		return this.reply;
	};
	confirmPermission = async (pending: DelegatePending): Promise<boolean | undefined> => {
		this.confirmed.push(pending);
		return this.approve;
	};
	notify(): void {}
}

describe("delegate manager ownership and persistence", () => {
	it("persists tasks under the owner session and validates ownership", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries, "session-a");
		const [view] = await manager.start([{ agent: "worker", task: "do a thing", cwd: "/tmp/project" }]);
		const envelopes = entriesOf(entries, "delegate.tasks") as { owner?: string; tasks?: Record<string, unknown> }[];
		expect(envelopes[0]!.owner).toBe("session-a");
		expect(Object.keys(envelopes[0]!.tasks!)).toEqual([view.taskId]);
		expect(manager.get(view.taskId)).toBeDefined();
		await expect(manager.answer("nope", "q", { answer: "x" })).rejects.toThrow(/not started by this session/);
		manager.dispose();
	});

	it("does not restore or control tasks owned by a foreign or forked session", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const owner = makeManager(transport, entries, "session-a");
		const [view] = await owner.start([{ agent: "worker", task: "owned", cwd: "/tmp/project" }]);
		owner.dispose();

		const forked = makeManager(transport, entries, "session-b");
		forked.restore();
		expect(forked.allTasks()).toHaveLength(0);
		expect(forked.get(view.taskId)).toBeUndefined();
		await expect(forked.cancel(view.taskId)).rejects.toThrow(/not started by this session/);
		forked.dispose();
	});

	it("does not append a task entry when its state did not change", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		await manager.start([{ agent: "worker", task: "stable", cwd: "/tmp/project" }]);
		const before = entriesOf(entries, "delegate.tasks").length;
		transport.states.values().next().value!.status = "running";
		await manager.tick();
		await manager.tick();
		expect(entriesOf(entries, "delegate.tasks").length).toBe(before);
		manager.dispose();
	});
});

describe("delegate manager report lifecycle", () => {
	it("maps partial start-many failures to visible failed views in input order", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		transport.start = async (requests: DelegateRequest[]): Promise<DelegateState[]> => {
			transport.starts.push(requests);
			return [
				{ taskId: uuid(99), agent: requests[0]!.agent!, status: "running", scope: [], startedAt: 1000 },
				{ status: "failed", error: "no worker for agent b" } as unknown as DelegateState,
			];
		};
		const views = await manager.start([
			{ agent: "a", task: "one", cwd: "/tmp/project" },
			{ agent: "b", task: "two", cwd: "/tmp/project" },
		]);
		expect(views).toHaveLength(2);
		expect(views[0]!.agent).toBe("a");
		expect(views[1]!.status).toBe("failed");
		expect(views[1]!.task).toBe("two");
		expect(views[1]!.fullSummary).toContain("no worker");
		manager.dispose();
	});

	it("keeps a call's notice pending until every task of that call stops", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const views = await manager.start([
			{ agent: "worker", task: "a", cwd: "/tmp/project" },
			{ agent: "worker", task: "b", cwd: "/tmp/project" },
		]);
		manager.recordCall(
			"call-1",
			views.map((view) => view.taskId),
		);
		const first = transport.states.get(views[0]!.taskId)!;
		Object.assign(first, { status: "completed", summary: "done" });
		await manager.tick();
		expect(manager.takeReportWithIds()).toBeUndefined();
		const second = transport.states.get(views[1]!.taskId)!;
		Object.assign(second, { status: "failed", summary: "boom" });
		await manager.tick();
		const report = manager.takeReportWithIds();
		expect(report).toBeDefined();
		expect(report!.reportIds).toHaveLength(2);
		expect(report!.content).toContain(views[0]!.taskId);
		expect(report!.content).toContain(views[1]!.taskId);
		manager.dispose();
	});

	it("keeps a report pending until its persisted receipt is observed", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const [view] = await manager.start([{ agent: "worker", task: "a", cwd: "/tmp/project" }]);
		manager.recordCall("call-1", [view.taskId]);
		Object.assign(transport.states.get(view.taskId)!, { status: "completed", summary: "done" });
		await manager.tick();
		const report = manager.takeReportWithIds()!;
		expect(report.reportIds).toEqual([`${view.taskId}:completed`]);
		expect(manager.takeReportWithIds()).toBeUndefined();

		entries.push(receiptEntry(report.reportIds));
		await manager.tick();
		const reports = entriesOf(entries, "delegate.reports") as { delivered?: string[] }[];
		expect(reports.at(-1)!.delivered).toContain(report.reportIds[0]);
		manager.dispose();

		const restored = makeManager(transport, entries);
		restored.restore();
		expect(restored.takeReportWithIds()).toBeUndefined();
		restored.dispose();
	});

	it("turns a vanished worker into a visible failure", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const [view] = await manager.start([{ agent: "worker", task: "ghost", cwd: "/tmp/project" }]);
		transport.absent.add(view.taskId);
		for (let i = 0; i < 60; i++) await manager.tick();
		const failed = manager.get(view.taskId);
		expect(failed?.status).toBe("failed");
		expect(failed?.fullSummary).toContain("stopped responding");
		expect(manager.takeReportWithIds()?.content).toContain(view.taskId);
		manager.dispose();
	});

	it("waits only for the given task IDs", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const [mine] = await manager.start([{ agent: "worker", task: "mine", cwd: "/tmp/project" }]);
		const [other] = await manager.start([{ agent: "worker", task: "other", cwd: "/tmp/project" }]);
		Object.assign(transport.states.get(other.taskId)!, { status: "completed", summary: "other-done" });
		Object.assign(transport.states.get(mine.taskId)!, { status: "completed", summary: "mine-done" });
		await manager.tick();
		const outcome: WaitOutcome = await manager.waitForReport(1000, undefined, new Set([mine.taskId]));
		expect(outcome.reportIds).toEqual([`${mine.taskId}:completed`]);
		expect(outcome.report).toContain(mine.taskId);
		expect(outcome.report).not.toContain(other.taskId);
		manager.dispose();
	});
});

describe("delegate manager chain and abort", () => {
	it("replaces {previous} and stops the chain when a step fails", async () => {
		const transport = new FakeTransport();
		transport.autoFinish = true;
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const chain = await manager.chain(
			[
				{ agent: "a", task: "first", cwd: "/tmp/project" },
				{ agent: "b", task: "use {previous}", cwd: "/tmp/project" },
			],
			{ waitMs: 1000 },
		);
		expect(chain.views).toHaveLength(2);
		expect(chain.stopped).toBe(false);
		expect(transport.starts[1]![0]!.task).toContain("summary-");

		transport.completeStatus = "failed";
		const failing = await manager.chain(
			[
				{ agent: "a", task: "first", cwd: "/tmp/project" },
				{ agent: "b", task: "second", cwd: "/tmp/project" },
			],
			{ waitMs: 1000 },
		);
		expect(failing.views).toHaveLength(1);
		expect(failing.stopped).toBe(true);
		manager.dispose();
	});

	it("cancels known children when the signal aborts during start", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const controller = new AbortController();
		controller.abort();
		await manager.start([{ agent: "worker", task: "bg", cwd: "/tmp/project" }], { signal: controller.signal });
		await flush();
		expect(transport.cancels).toHaveLength(1);
		manager.dispose();
	});
});

describe("delegate manager dialogs", () => {
	async function waiting(
		manager: DelegateManager,
		transport: FakeTransport,
		pending: DelegatePending,
	): Promise<string> {
		const [view] = await manager.start([{ agent: "worker", task: "ask", cwd: "/tmp/project" }]);
		const state = transport.states.get(view.taskId)!;
		state.status = "waiting";
		state.pending = [pending];
		return view.taskId;
	}

	it("confirms a permission through confirmPermission with the tool and arguments", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = new DelegateManager({
			transport,
			appendEntry: (t, d) => entries.push(customEntry(t, d)),
			now: () => 1000,
		});
		const ui = new RecordingUI();
		ui.approve = false;
		manager.setHost(makeHost(entries, "session-a", ui));
		const taskId = await waiting(manager, transport, {
			id: "p1",
			kind: "permission",
			question: "Write src/a.ts?",
			tool: "write",
			input: { path: "src/a.ts" },
		});
		await manager.tick();
		await flush();
		expect(ui.confirmed[0]!.tool).toBe("write");
		expect(transport.answers).toEqual([{ taskId, requestId: "p1", value: { approved: false } }]);
		manager.dispose();
	});

	it("does not ask a dismissed dialog again", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = new DelegateManager({
			transport,
			appendEntry: (t, d) => entries.push(customEntry(t, d)),
			now: () => 1000,
		});
		const ui = new RecordingUI();
		ui.approve = undefined;
		manager.setHost(makeHost(entries, "session-a", ui));
		await waiting(manager, transport, { id: "p1", kind: "permission", question: "Write?" });
		await manager.tick();
		await flush();
		await manager.tick();
		await flush();
		expect(ui.confirmed).toHaveLength(1);
		expect(transport.answers).toHaveLength(0);
		manager.dispose();
	});

	it("sends no reply after disposal", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = new DelegateManager({
			transport,
			appendEntry: (t, d) => entries.push(customEntry(t, d)),
			now: () => 1000,
		});
		let release: (value: boolean | undefined) => void = () => {};
		const gate = new Promise<boolean | undefined>((resolve) => {
			release = resolve;
		});
		const ui: DelegateUI = {
			available: true,
			ask: async () => undefined,
			confirmPermission: async () => gate,
			notify: () => {},
		};
		manager.setHost(makeHost(entries, "session-a", ui));
		await waiting(manager, transport, { id: "p1", kind: "permission", question: "Write?" });
		await manager.tick();
		manager.dispose();
		release(true);
		await flush();
		expect(transport.answers).toHaveLength(0);
	});

	it("leaves a pending request when no UI is available", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const [view] = await manager.start([{ agent: "worker", task: "ask", cwd: "/tmp/project" }]);
		transport.states.get(view.taskId)!.pending = [{ id: "q1", kind: "question", question: "Which file?" }];
		await manager.tick();
		await flush();
		expect(transport.answers).toHaveLength(0);
		expect(manager.get(view.taskId)?.pending).toBe(1);
		manager.dispose();
	});

	it("routes a question through ask and preserves the answer", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = new DelegateManager({
			transport,
			appendEntry: (t, d) => entries.push(customEntry(t, d)),
			now: () => 1000,
		});
		const ui = new RecordingUI();
		ui.reply = "src/a.ts";
		manager.setHost(makeHost(entries, "session-a", ui));
		const taskId = await waiting(manager, transport, { id: "q1", kind: "question", question: "Which file?" });
		await manager.tick();
		await flush();
		expect(ui.asked).toEqual(["Which file?"]);
		expect(transport.answers).toEqual([{ taskId, requestId: "q1", value: { answer: "src/a.ts" } }]);
		manager.dispose();
	});
});

describe("delegate manager full status", () => {
	it("reports the raw summary and the log path", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const [view] = await manager.start([{ agent: "worker", task: "long", cwd: "/tmp/project" }]);
		const long = "x".repeat(1200);
		Object.assign(transport.states.get(view.taskId)!, {
			status: "completed",
			summary: long,
			logPath: "/tmp/delegate/tasks/one/log.txt",
		});
		const refreshed = await manager.refresh(view.taskId);
		expect(refreshed.fullSummary).toBe(long);
		expect(refreshed.logPath).toBe("/tmp/delegate/tasks/one/log.txt");
		expect(refreshed.summary!.length).toBeLessThan(long.length);
		const detail = detailText(refreshed);
		expect(detail).toContain(long);
		expect(detail).toContain("/tmp/delegate/tasks/one/log.txt");
		manager.dispose();
	});
});

describe("delegate manager session isolation", () => {
	it("resets state and ignores a late session-A poll after a session change", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries, "session-a");
		const [view] = await manager.start([{ agent: "worker", task: "a", cwd: "/tmp/project" }]);

		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const realPoll = transport.poll.bind(transport);
		transport.poll = async (id: string) => {
			await gate;
			return realPoll(id);
		};
		const ticking = manager.tick();
		manager.setHost(makeHost(entries, "session-b", SILENT_UI));
		release();
		await ticking;

		expect(manager.allTasks()).toHaveLength(0);
		expect(manager.get(view.taskId)).toBeUndefined();
		const forB = (
			entriesOf(entries, "delegate.tasks") as { owner?: string; tasks?: Record<string, unknown> }[]
		).filter((entry) => entry.owner === "session-b");
		expect(forB).toHaveLength(0);

		manager.setHost(makeHost(entries, "session-a", SILENT_UI));
		manager.restore();
		expect(manager.get(view.taskId)).toBeDefined();
		manager.dispose();
	});

	it("does not send a dialog reply that belongs to the previous session", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		let release: (value: boolean | undefined) => void = () => {};
		const gate = new Promise<boolean | undefined>((resolve) => {
			release = resolve;
		});
		const ui: DelegateUI = {
			available: true,
			ask: async () => undefined,
			confirmPermission: async () => gate,
			notify: () => {},
		};
		const manager = new DelegateManager({
			transport,
			appendEntry: (t, d) => entries.push(customEntry(t, d)),
			now: () => 1000,
		});
		manager.setHost(makeHost(entries, "session-a", ui));
		const [view] = await manager.start([{ agent: "worker", task: "ask", cwd: "/tmp/project" }]);
		const state = transport.states.get(view.taskId)!;
		state.status = "waiting";
		state.pending = [{ id: "p1", kind: "permission", question: "Write?" }];
		await manager.tick();
		await flush();

		manager.setHost(makeHost(entries, "session-b", SILENT_UI));
		release(true);
		await flush();
		expect(transport.answers).toHaveLength(0);
		manager.dispose();
	});

	it("keeps synthetic failure IDs unique across a restore", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		entries.push(
			customEntry("delegate.tasks", {
				owner: "session-a",
				tasks: {
					"start-failed-1": {
						taskId: "start-failed-1",
						agent: "x",
						provider: "pi",
						status: "failed",
						scope: [],
						task: "old",
					},
				},
			}),
		);
		const manager = makeManager(transport, entries, "session-a");
		manager.restore();
		transport.start = async (requests: DelegateRequest[]): Promise<DelegateState[]> =>
			requests.map(() => ({ status: "failed", error: "boom" }) as unknown as DelegateState);
		const views = await manager.start([{ agent: "a", task: "t", cwd: "/tmp/project" }]);
		expect(views[0]!.taskId).toBe("start-failed-2");
		expect(manager.get("start-failed-1")).toBeDefined();
		manager.dispose();
	});

	it("stops watching a task that a refresh reports as terminal", async () => {
		const transport = new FakeTransport();
		const entries: SessionEntry[] = [];
		const manager = makeManager(transport, entries);
		const [view] = await manager.start([{ agent: "worker", task: "r", cwd: "/tmp/project" }]);
		Object.assign(transport.states.get(view.taskId)!, { status: "completed", summary: "done" });
		const refreshed = await manager.refresh(view.taskId);
		expect(refreshed.status).toBe("completed");
		expect(manager.takeReportWithIds()?.reportIds).toEqual([`${view.taskId}:completed`]);
		transport.absent.add(view.taskId);
		for (let i = 0; i < 70; i++) await manager.tick();
		expect(manager.get(view.taskId)?.status).toBe("completed");
		manager.dispose();
	});
});

describe("delegate manager project agent trust", () => {
	function trustSetup(answer: boolean | undefined, available = true) {
		const transport = new FakeTransport();
		transport.agents = async () => [
			{ name: "local", provider: "pi", source: "project", filePath: "/tmp/project/.pi/agents/local.md" },
			{ name: "worker", provider: "pi", source: "bundled" },
		];
		const asked: string[] = [];
		const ui: DelegateUI = {
			available,
			ask: async () => undefined,
			notify: () => {},
			confirmProjectAgent: async (agent) => {
				asked.push(agent.name);
				return answer;
			},
		};
		const manager = new DelegateManager({ transport, appendEntry: () => {}, now: () => 1000 });
		manager.setHost(makeHost([], "session-a", ui));
		return { transport, manager, asked };
	}

	it("drops a trust flag that the model set and asks the user for a project agent", async () => {
		const { transport, manager, asked } = trustSetup(false);
		await manager.start([
			{ agent: "local", task: "a", cwd: "/tmp/project", trustProjectAgents: true },
			{ agent: "worker", task: "b", cwd: "/tmp/project", trustProjectAgents: true },
		]);
		expect(asked).toEqual(["local"]);
		expect(transport.starts[0]!.map((request) => request.trustProjectAgents)).toEqual([undefined, undefined]);
		manager.dispose();
	});

	it("trusts a project agent after the user approves it, and asks only once", async () => {
		const { transport, manager, asked } = trustSetup(true);
		await manager.start([{ agent: "local", task: "a", cwd: "/tmp/project" }]);
		await manager.start([{ agent: "local", task: "b", cwd: "/tmp/project" }]);
		expect(asked).toEqual(["local"]);
		expect(transport.starts.map((batch) => batch[0]!.trustProjectAgents)).toEqual([true, true]);
		manager.dispose();
	});

	it("never trusts a project agent without a UI", async () => {
		const { transport, manager, asked } = trustSetup(true, false);
		await manager.start([{ agent: "local", task: "a", cwd: "/tmp/project", trustProjectAgents: true }]);
		expect(asked).toEqual([]);
		expect(transport.starts[0]![0]!.trustProjectAgents).toBeUndefined();
		manager.dispose();
	});
});
