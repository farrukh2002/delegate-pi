import { type Component, colorToHex, setKeybindings, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DelegateManager } from "../src/core/delegate/manager.ts";
import type {
	DelegateAgentInfo,
	DelegateAnswer,
	DelegateModelList,
	DelegatePending,
	DelegateRequest,
	DelegateState,
	DelegateTransport,
} from "../src/core/delegate/transport.ts";
import type { TaskView } from "../src/core/delegate/view.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createDelegateExtension } from "../src/extensions/delegate/index.ts";
import {
	managerLiveSource,
	renderDelegateCall,
	renderDelegateResult,
	renderDelegateTasksCall,
	renderDelegateTasksResult,
	renderReportMessage,
} from "../src/extensions/delegate/renderers.ts";
import { createTasksScreen } from "../src/extensions/delegate/screen.ts";
import { DELEGATE_TOOL_NAME } from "../src/extensions/delegate/tools.ts";
import type { DelegateBand } from "../src/modes/interactive/components/delegate-band.ts";
import { DEFAULT_DELEGATE_STYLE } from "../src/modes/interactive/components/delegate-style.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;
type BandComponent = Component & { focused?: boolean; dispose?(): void };

function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

let viewCounter = 0;

function makeView(agent: string, status: string, extra: Partial<TaskView> = {}): TaskView {
	viewCounter += 1;
	return {
		taskId: extra.taskId ?? uuid(viewCounter),
		agent,
		provider: "pi",
		status,
		scope: [],
		task: "x",
		...extra,
	};
}

function collapsedLine(views: TaskView[]): string {
	const source = { viewsFor: () => views };
	return stripAnsi(
		renderDelegateCall({ agent: views[0]!.agent, task: "x" }, theme, {
			toolCallId: "call-1",
			source,
		}).render(120)[0]!,
	);
}

function mouseEvent(y: number): TuiMouseEvent {
	return {
		type: "press",
		button: "left",
		x: 0,
		y,
		screenX: 0,
		screenY: y,
		width: 120,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

class FakeTransport implements DelegateTransport {
	states = new Map<string, DelegateState>();
	answers: { taskId: string; requestId: string; value: DelegateAnswer }[] = [];
	private counter = 0;

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

	complete(id: string, status = "completed", extra: Partial<DelegateState> = {}): DelegateState {
		const state = this.states.get(id)!;
		Object.assign(state, {
			status,
			finishedAt: 6000,
			durationMs: 5000,
			summary: `${status} summary`,
			diffstat: "1 file changed, 3 insertions(+), 1 deletion(-)",
			...extra,
		});
		return state;
	}

	async run(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return { stdout: "", stderr: "", exitCode: 0 };
	}
	async start(requests: DelegateRequest[]): Promise<DelegateState[]> {
		return requests.map((request) => this.assign(request));
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
		const state = this.states.get(id)!;
		state.status = "cancelled";
		return state;
	}
	async diff(): Promise<string> {
		return "";
	}
	async accept(id: string): Promise<DelegateState> {
		return this.states.get(id)!;
	}
	async undo(id: string): Promise<DelegateState> {
		return this.states.get(id)!;
	}
	async prune(): Promise<{ removed: string[]; kept: { taskId: string; reason: string }[] }> {
		return { removed: [], kept: [] };
	}
	agentList: DelegateAgentInfo[] = [];

	async agents(): Promise<DelegateAgentInfo[]> {
		return this.agentList;
	}

	async listModels(): Promise<DelegateModelList[]> {
		return [];
	}
}

interface FocusableComponent extends Component {
	focused?: boolean;
}

class FakeTui {
	terminal = { rows: 24, columns: 80 };
	renders = 0;
	private focus: FocusableComponent | null;

	constructor(editor: FocusableComponent) {
		this.focus = editor;
	}

	requestRender(): void {
		this.renders += 1;
	}
	getFocusedComponent(): Component | null {
		return this.focus;
	}
	setFocus(component: Component | null): void {
		if (this.focus && "focused" in this.focus) this.focus.focused = false;
		this.focus = (component as FocusableComponent | null) ?? null;
		if (this.focus && "focused" in this.focus) this.focus.focused = true;
	}
}

interface FakePi {
	handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]>;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	entries: SessionEntry[];
	entryRenderers: string[];
}

function makeFakePi(): FakePi {
	const handlers: FakePi["handlers"] = {};
	const tools: FakePi["tools"] = new Map();
	const entries: SessionEntry[] = [];
	const entryRenderers: string[] = [];
	return { handlers, tools, entries, entryRenderers };
}

function installFakePi(pi: FakePi): unknown {
	return {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			let list = pi.handlers[event];
			if (!list) {
				list = [];
				pi.handlers[event] = list;
			}
			list.push(handler);
			return () => {};
		},
		registerTool(tool: { name: string }) {
			pi.tools.set(tool.name, tool as unknown as { execute: (...args: unknown[]) => Promise<unknown> });
		},
		registerCommand() {},
		registerMessageRenderer() {},
		registerEntryRenderer(customType: string) {
			pi.entryRenderers.push(customType);
		},
		appendEntry(customType: string, data: unknown) {
			pi.entries.push({ type: "custom", customType, data } as unknown as SessionEntry);
		},
	};
}

interface FakeUi {
	widgetFactory: ((tui: unknown, thm: unknown) => BandComponent) | undefined;
	widgetRemoved: number;
	inputs: InputHandler[];
	confirmCalls: Array<[string, string]>;
	selectCalls: Array<{ title: string; options: string[] }>;
	inputCalls: Array<{ title: string; placeholder?: string }>;
	selectReply: string | undefined;
	inputReply: string | undefined;
	confirmReply: boolean;
}

function makeUi(): FakeUi {
	return {
		widgetFactory: undefined,
		widgetRemoved: 0,
		inputs: [],
		confirmCalls: [],
		selectCalls: [],
		inputCalls: [],
		selectReply: undefined,
		inputReply: undefined,
		confirmReply: true,
	};
}

function makeExtCtx(entries: SessionEntry[], tui: FakeTui, ui: FakeUi): unknown {
	return {
		cwd: "/tmp/project",
		hasUI: true,
		mode: "tui",
		ui: {
			select: async (title: string, options: string[]) => {
				ui.selectCalls.push({ title, options });
				return ui.selectReply;
			},
			input: async (title: string, placeholder?: string) => {
				ui.inputCalls.push({ title, placeholder });
				return ui.inputReply;
			},
			confirm: async (title: string, message: string) => {
				ui.confirmCalls.push([title, message]);
				return ui.confirmReply;
			},
			notify: () => {},
			custom: async () => undefined,
			setWidget: (key: string, content: unknown) => {
				if (key !== "delegate-band") return;
				if (content === undefined) {
					ui.widgetRemoved += 1;
					ui.widgetFactory = undefined;
					return;
				}
				ui.widgetFactory = content as FakeUi["widgetFactory"];
				ui.widgetFactory?.(tui, theme);
			},
			onTerminalInput: (handler: InputHandler) => {
				ui.inputs.push(handler);
				return () => {
					const index = ui.inputs.indexOf(handler);
					if (index >= 0) ui.inputs.splice(index, 1);
				};
			},
		},
		sessionManager: { getBranch: () => entries, getSessionId: () => "session-1" },
	};
}

async function setupExtension(options: { now?: () => number; agents?: DelegateAgentInfo[] } = {}): Promise<{
	transport: FakeTransport;
	pi: FakePi;
	manager: DelegateManager;
	editor: FocusableComponent;
	tui: FakeTui;
	ui: FakeUi;
	ctx: unknown;
}> {
	const transport = new FakeTransport();
	transport.agentList = options.agents ?? [];
	let manager: DelegateManager | undefined;
	const pi = makeFakePi();
	createDelegateExtension({
		transport,
		intervalMs: 100000,
		now: options.now ?? (() => 6000),
		onManager: (value) => {
			manager = value;
		},
	})(installFakePi(pi) as never);
	const editor: FocusableComponent = { render: () => [], invalidate: () => {}, focused: true };
	const tui = new FakeTui(editor);
	const ui = makeUi();
	const ctx = makeExtCtx(pi.entries, tui, ui);
	await pi.handlers.session_start![0]!({ type: "session_start", reason: "startup" }, ctx);
	return { transport, pi, manager: manager!, editor, tui, ui, ctx };
}

async function startTask(pi: FakePi, manager: DelegateManager, ctx: unknown): Promise<void> {
	const tool = pi.tools.get(DELEGATE_TOOL_NAME)!;
	await tool.execute("call-1", { agent: "worker", task: "do work" }, undefined, undefined, ctx);
	await manager.tick();
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function askPending(
	setup: Awaited<ReturnType<typeof setupExtension>>,
	pending: DelegatePending,
): Promise<string> {
	await startTask(setup.pi, setup.manager, setup.ctx);
	const taskId = setup.manager.activeTasks()[0]!.taskId;
	const state = setup.transport.states.get(taskId)!;
	state.status = "waiting";
	state.pending = [pending];
	await setup.manager.tick();
	await flush();
	return taskId;
}

describe("delegate ui", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("maps the Delegate style to the reference palette colors", () => {
		expect(DEFAULT_DELEGATE_STYLE).toMatchObject({
			accent: "accent",
			inactive: "muted",
			subtle: "dim",
			track: "borderMuted",
			muted: "muted",
			text: "text",
			success: "success",
			error: "error",
			warning: "warning",
		});
		expect(colorToHex(theme.colors.accent).toLowerCase()).toBe("#d77757");
		expect(colorToHex(theme.colors.text).toLowerCase()).toBe("#ffffff");
		expect(colorToHex(theme.colors.success).toLowerCase()).toBe("#4eba65");
		expect(colorToHex(theme.colors.error).toLowerCase()).toBe("#ff6b80");
		expect(colorToHex(theme.colors.warning).toLowerCase()).toBe("#ffc107");
		expect(colorToHex(theme.colors.muted).toLowerCase()).toBe("#999999");
		expect(colorToHex(theme.colors.dim).toLowerCase()).toBe("#505050");
	});

	it("renders a chain-array delegate call and single/parallel labels", () => {
		const chain = stripAnsi(
			renderDelegateCall({ tasks: [[{ agent: "a" }, { agent: "b" }]], chain: true }, theme).render(120)[0]!,
		);
		expect(chain).toContain("chain 2");
		expect(chain).toContain("a, b");
		const parallel = stripAnsi(
			renderDelegateCall({ tasks: [{ agent: "a" }, { agent: "b" }] }, theme).render(120)[0]!,
		);
		expect(parallel).toContain("parallel 2");
		const single = stripAnsi(renderDelegateCall({ agent: "cmd-worker", task: "x" }, theme).render(120)[0]!);
		expect(single).toContain("cmd-worker");
	});

	it("renders the started line while a child runs and the done line once all stop", () => {
		const running = {
			viewsFor: () => [makeView("worker", "running", { startedAt: 1000, taskId: uuid(1) })],
		};
		const line = stripAnsi(
			renderDelegateCall({ agent: "worker", task: "x" }, theme, { toolCallId: "call-1", source: running }).render(
				120,
			)[0]!,
		);
		expect(line).toBe("◌ started worker in the background");
		expect(line).not.toMatch(/\d+s/);

		const done = {
			viewsFor: () => [
				{
					taskId: uuid(1),
					agent: "worker",
					provider: "pi",
					status: "completed",
					scope: [],
					task: "x",
					durationMs: 5000,
				},
			],
		};
		const finished = stripAnsi(
			renderDelegateCall({ agent: "worker", task: "x" }, theme, { toolCallId: "call-1", source: done }).render(
				120,
			)[0]!,
		);
		expect(finished).toContain("✓");
		expect(finished).toContain("5s");
	});

	it("keeps the started line while any child is open, even when another one failed", () => {
		const line = collapsedLine([
			makeView("scout", "failed", { durationMs: 46000 }),
			makeView("scout", "running", { startedAt: 1000 }),
		]);
		expect(line).toBe("◌ started scout in the background");
		expect(line).not.toContain("✗");
		expect(line).not.toContain("running");
	});

	it("labels parallel agents like the reference agentsLabel", () => {
		expect(collapsedLine([makeView("a", "running"), makeView("b", "running")])).toBe(
			"◌ started a and b in the background",
		);
		expect(collapsedLine([makeView("a", "running"), makeView("b", "running"), makeView("a", "running")])).toBe(
			"◌ started a and b in the background",
		);
		expect(collapsedLine([makeView("a", "running"), makeView("b", "running"), makeView("c", "running")])).toBe(
			"◌ started 3 agents in the background",
		);
	});

	it("renders the done line for a single row with the row status as the verb", () => {
		const view = makeView("scout", "completed", {
			durationMs: 5000,
			diffstat: "1 file changed, 3 insertions(+), 1 deletion(-)",
		});
		expect(collapsedLine([view])).toBe("✓ completed scout 5s +3 −1");
		const raw = renderDelegateCall({ agent: "scout", task: "x" }, theme, {
			toolCallId: "call-1",
			source: { viewsFor: () => [view] },
		}).render(120)[0]!;
		expect(raw).toContain(theme.fg("muted", "✓"));
		expect(raw).toContain(theme.fg("toolDiffAdded", "+3"));
		expect(raw).toContain(theme.fg("toolDiffRemoved", "−1"));
		const warningRaw = renderDelegateCall({ agent: "scout", task: "x" }, theme, {
			toolCallId: "call-1",
			source: { viewsFor: () => [makeView("scout", "failed", { durationMs: 5000 })] },
		}).render(120)[0]!;
		expect(warningRaw).toContain(theme.fg("warning", "!"));
	});

	it("uses the first row status as the verb only when every row failed or there is one row", () => {
		expect(collapsedLine([makeView("scout", "failed", { durationMs: 5000 })])).toBe("! failed scout 5s");
		expect(collapsedLine([makeView("scout", "timed_out", { durationMs: 91000 })])).toBe("! timed out scout 1m31s");
		expect(
			collapsedLine([
				makeView("scout", "failed", { durationMs: 5000 }),
				makeView("worker", "failed", { durationMs: 9000 }),
			]),
		).toBe("! failed ✗ scout ✗ worker 9s");
	});

	it("renders per-row marks and totals on the done line for parallel rows", () => {
		const line = collapsedLine([
			makeView("scout", "completed", { durationMs: 30000, diffstat: "3 insertions(+), 2 deletions(-)" }),
			makeView("worker", "completed", { durationMs: 90000, diffstat: "2 insertions(+), 4 deletions(-)" }),
		]);
		expect(line).toBe("✓ delegated ✓ scout ✓ worker 1m30s +5 −6");
	});

	it("shows a warning mark on the done line when any row is not good", () => {
		const line = collapsedLine([
			makeView("scout", "completed", { durationMs: 30000 }),
			makeView("worker", "cancelled", { durationMs: 90000 }),
		]);
		expect(line).toBe("! delegated ✓ scout – worker 1m30s");
	});

	it("omits the clock and zero deltas on the done line", () => {
		const line = collapsedLine([makeView("scout", "accepted")]);
		expect(line).toBe("✓ accepted scout");
		expect(line).not.toContain("+");
		expect(line).not.toContain("−");
	});

	it("suppresses the collapsed result renderer when the call carries status", () => {
		const source = {
			viewsFor: () => [
				{
					taskId: uuid(1),
					agent: "worker",
					provider: "pi",
					status: "completed",
					scope: [],
					task: "x",
					durationMs: 1000,
				},
			],
		};
		const component = renderDelegateResult(
			{ content: [{ type: "text", text: "done" }] },
			{ expanded: false },
			theme,
			undefined,
			{ toolCallId: "call-1", source },
		);
		expect(component.render(120)).toEqual([]);
	});

	it("renders details as separate physical lines within the width", () => {
		const details = {
			views: [
				{
					taskId: uuid(1),
					agent: "worker",
					provider: "pi",
					status: "completed",
					scope: ["src"],
					task: "x",
					durationMs: 5000,
					diffstat: "1 file changed, 3 insertions(+), 1 deletion(-)",
					activity: ["a", "b", "c", "d", "e", "f"],
				},
			],
			mode: "single" as const,
		};
		const component = renderDelegateResult(
			{ content: [{ type: "text", text: "done" }] },
			{ expanded: true },
			theme,
			details,
		);
		for (const width of [30, 120]) {
			const lines = component.render(width);
			expect(lines.length).toBeGreaterThan(1);
			for (const line of lines) {
				expect(line.includes("\n")).toBe(false);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("renders the delegate_tasks call row per action", () => {
		const known = makeView("scout", "running", { taskId: uuid(1) });
		const line = (
			args: { action?: string; taskId?: string; olderThan?: string },
			lookup?: { get(taskId: string): TaskView | undefined },
		) => stripAnsi(renderDelegateTasksCall(args, theme, lookup).render(120)[0]!);
		expect(line({})).toBe("· status all tasks");
		expect(line({ action: "wait" })).toBe("· wait all tasks");
		expect(line({ action: "accept", taskId: uuid(1) }, { get: (id) => (id === uuid(1) ? known : undefined) })).toBe(
			"✓ accept scout",
		);
		expect(line({ action: "undo", taskId: uuid(2) })).toBe("↺ undo 00000000");
		expect(line({ action: "cancel", taskId: "unknown-task-id" })).toBe("– cancel unknown-");
		expect(line({ action: "diff", taskId: "unknown-task-id" })).toBe("± diff unknown-");
		expect(line({ action: "prune" })).toBe("⌫ prune older than 7d");
		expect(line({ action: "prune", olderThan: "30m" })).toBe("⌫ prune older than 30m");
	});

	it("hides the collapsed delegate_tasks result and shows every line when expanded", () => {
		const result = { content: [{ type: "text", text: "<delegate-report>\n✓ scout done\n</delegate-report>" }] };
		expect(renderDelegateTasksResult(result, { expanded: false }, theme).render(120)).toEqual([]);
		expect(renderDelegateTasksResult(result, { expanded: true }, theme).render(120).map(stripAnsi)).toEqual([
			"<delegate-report>",
			"✓ scout done",
			"</delegate-report>",
		]);
	});

	it("renders the expanded view with waiting marks, meta and activity lines", () => {
		const details = {
			views: [
				makeView("worker", "running", {
					taskId: uuid(1),
					durationMs: 5000,
					scope: ["src", "docs"],
					pending: 2,
					activity: ["one", "two", "three", "four", "five", "six"],
				}),
				makeView("scout", "completed", { taskId: uuid(2), durationMs: 90000, scope: [] }),
			],
			mode: "single" as const,
		};
		const lines = renderDelegateResult(
			{ content: [{ type: "text", text: "done" }] },
			{ expanded: true },
			theme,
			details,
		)
			.render(120)
			.map(stripAnsi);
		expect(lines).toEqual([
			"? worker asking · 5s · src, docs",
			"  ⎿ one",
			"  ⎿ two",
			"  ⎿ three",
			"  ⎿ four",
			"  ⎿ five",
			"  ⎿ six",
			"✓ scout completed · 1m30s · read-only",
		]);
	});

	it("maps tool call ids to live views through the manager source", async () => {
		const transport = new FakeTransport();
		const manager = new DelegateManager({ transport, appendEntry: () => {} });
		manager.setHost({
			sessionId: "session-1",
			cwd: "/p",
			branchEntries: () => [],
			ui: { available: false, ask: async () => undefined, notify: () => {} },
		});
		const views = await manager.start([{ agent: "worker", task: "x", cwd: "/p" }]);
		manager.recordCall(
			"call-1",
			views.map((view) => view.taskId),
		);
		const source = managerLiveSource({
			callTasks: (id) => manager.callTasks(id),
			get: (id) => manager.get(id),
		});
		expect(source.viewsFor("call-1")?.length).toBe(1);
		expect(source.viewsFor("missing")).toBeUndefined();
		manager.dispose();
	});

	it("registers no entry renderer for delegate custom entries", async () => {
		const { pi } = await setupExtension();
		expect(pi.entryRenderers).toEqual([]);
	});

	it("renders the delegate report notice with status marks", () => {
		const text = `<delegate-report>\n✓ worker ${uuid(1)} completed 2s, read-only\n✗ worker ${uuid(2)} failed 3s, read-only\n</delegate-report>`;
		const line = stripAnsi(
			renderReportMessage(
				{ role: "custom", customType: "delegate-report", content: text, display: true } as never,
				theme,
			).render(120)[0]!,
		);
		expect(line).toContain("report");
		expect(line).toContain("worker");
		const plain = stripAnsi(
			renderReportMessage(
				{ role: "custom", customType: "delegate-report", content: "no rows here", display: true } as never,
				theme,
			).render(120)[0]!,
		);
		expect(plain).toContain("no rows here");
	});

	it("bounds and scrolls the tasks screen and re-renders on cursor moves", async () => {
		const transport = new FakeTransport();
		const manager = new DelegateManager({ transport, appendEntry: () => {} });
		manager.setHost({
			sessionId: "session-1",
			cwd: "/p",
			branchEntries: () => [],
			ui: { available: false, ask: async () => undefined, notify: () => {} },
		});
		const views = await manager.start(
			Array.from({ length: 20 }, (_, index) => ({ agent: "worker", task: `t${index}`, cwd: "/p" })),
		);
		const done = vi.fn();
		const tui = new FakeTui({ render: () => [], invalidate: () => {} });
		const screen = createTasksScreen(manager, theme, done, { tui: tui as never });
		const lines = screen.render(120);
		expect(lines.length).toBeLessThanOrEqual(tui.terminal.rows);
		expect(lines[0]).toContain("Delegate tasks");
		const before = tui.renders;
		screen.handleInput?.("\x1b[B");
		expect(tui.renders).toBeGreaterThan(before);
		screen.handleInput?.("\x1b[B");
		screen.handleInput?.("\x1b[A");
		screen.handleInput?.("\x1b");
		expect(done).toHaveBeenCalledTimes(1);
		manager.dispose();
		expect(views.length).toBe(20);
	});

	it("offers only ready agents and names the missing ones", async () => {
		const { pi } = await setupExtension({
			agents: [
				{ name: "cmd-worker", provider: "commandcode", ready: true },
				{ name: "cx-worker", provider: "codex", ready: false, problem: "the codex CLI is not installed" },
			],
		});
		const description = (pi.tools.get("delegate") as unknown as { description: string }).description;
		expect(description).toContain("Agents: cmd-worker.");
		expect(description).not.toMatch(/prefer/i);
		expect(description).toContain("Not available on this machine: cx-worker (the codex CLI is not installed).");
	});

	it("creates the band only while tasks run and restores editor focus", async () => {
		const { manager, pi, ui, tui, editor, ctx } = await setupExtension();
		expect(pi.tools.has(DELEGATE_TOOL_NAME)).toBe(true);
		expect(ui.widgetFactory).toBeUndefined();

		await startTask(pi, manager, ctx);
		expect(ui.widgetFactory).toBeDefined();
		const band = ui.widgetFactory!(tui, theme);
		expect(band.focused).toBe(false);

		ui.inputs[0]!("\x1bd");
		expect(tui.getFocusedComponent()).toBe(band);
		expect(band.focused).toBe(true);
		expect(editor.focused).toBe(false);

		expect(ui.inputs[0]!("\x1b")).toEqual({ consume: true });
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editor.focused).toBe(true);
		expect(band.focused).toBe(false);

		ui.inputs[0]!("\x1bd");
		expect(ui.inputs[0]!("x")).toBeUndefined();
		expect(editor.focused).toBe(true);

		const taskId = manager.activeTasks()[0]!.taskId;
		expect(taskId).toBeDefined();
		manager.dispose();
	});

	it("saves focus on a band mouse press and restores it on escape", async () => {
		const { manager, pi, ui, tui, editor, ctx } = await setupExtension();
		await startTask(pi, manager, ctx);
		const band = ui.widgetFactory!(tui, theme) as unknown as DelegateBand;
		band.render(120);
		expect(band.handleMouse(mouseEvent(0))).toEqual({ handled: true, focus: true });
		tui.setFocus(band);
		expect(band.focused).toBe(true);
		expect(editor.focused).toBe(false);
		expect(ui.inputs[0]!("\x1b")).toEqual({ consume: true });
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editor.focused).toBe(true);
		manager.dispose();
	});

	it("restores editor focus when the last task ends while the band is focused", async () => {
		const { transport, manager, pi, ui, tui, editor, ctx } = await setupExtension();
		await startTask(pi, manager, ctx);
		const band = ui.widgetFactory!(tui, theme) as unknown as DelegateBand;
		band.render(120);
		band.handleMouse(mouseEvent(0));
		tui.setFocus(band);
		expect(band.focused).toBe(true);

		const taskId = manager.activeTasks()[0]!.taskId;
		transport.complete(taskId);
		await manager.tick();
		expect(ui.widgetRemoved).toBeGreaterThan(0);
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editor.focused).toBe(true);
		expect(band.focused).toBe(false);
		manager.dispose();
	});

	it("shows the tool and full arguments in the permission confirm", async () => {
		const { transport, manager, pi, ui, ctx } = await setupExtension();
		await pi.tools
			.get(DELEGATE_TOOL_NAME)!
			.execute("call-p", { agent: "worker", task: "work" }, undefined, undefined, ctx);
		const taskId = manager.activeTasks()[0]!.taskId;
		transport.states.get(taskId)!.pending = [
			{
				id: "req-1",
				kind: "permission",
				question: "Run this command?",
				tool: "bash",
				input: { command: "rm -rf /tmp/x" },
			},
		];
		await manager.tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ui.confirmCalls.length).toBe(1);
		const [title, message] = ui.confirmCalls[0]!;
		expect(title).toBe("bash");
		expect(message).toContain("Run this command?");
		expect(message).toContain("bash");
		expect(message).toContain("rm -rf /tmp/x");
		manager.dispose();
	});

	it("keeps one collapsed row for a delegate call before and after completion", async () => {
		const { transport, manager, pi, ui, tui, ctx } = await setupExtension();
		const tool = pi.tools.get(DELEGATE_TOOL_NAME)!;
		const component = new ToolExecutionComponent(
			DELEGATE_TOOL_NAME,
			"call-1",
			{ agent: "worker", task: "do work" },
			{},
			tool as never,
			tui as never,
			"/tmp/project",
		);
		const countRows = (rows: string[]): number =>
			rows.map((line) => stripAnsi(line)).filter((line) => line.trim() !== "").length;
		expect(countRows(component.render(120))).toBe(1);

		const result = await tool.execute("call-1", { agent: "worker", task: "do work" }, undefined, undefined, ctx);
		await manager.tick();
		component.updateResult(result as never, false);
		expect(countRows(component.render(120))).toBe(1);
		expect(ui.widgetFactory).toBeDefined();

		const taskId = manager.activeTasks()[0]!.taskId;
		transport.complete(taskId);
		await manager.tick();
		component.updateResult(result as never, false);
		const rendered = component.render(120).map((line) => stripAnsi(line));
		expect(rendered.filter((line) => line.trim() !== "").length).toBe(1);
		expect(rendered.join("\n")).toContain("✓");
		manager.dispose();
	});

	it("recreates a usable manager after session shutdown and restart", async () => {
		const transport = new FakeTransport();
		let manager: DelegateManager | undefined;
		const pi = makeFakePi();
		createDelegateExtension({
			transport,
			intervalMs: 100000,
			now: () => 6000,
			onManager: (value) => {
				manager = value;
			},
		})(installFakePi(pi) as never);
		const editor: FocusableComponent = { render: () => [], invalidate: () => {}, focused: true };
		const tui = new FakeTui(editor);
		const ui = makeUi();
		const ctx = makeExtCtx(pi.entries, tui, ui);

		await pi.handlers.session_start![0]!({ type: "session_start", reason: "startup" }, ctx);
		const first = manager!;
		pi.handlers.session_shutdown![0]!({ type: "session_shutdown", reason: "resume" }, ctx);
		expect(first.disposedState).toBe(true);

		await pi.handlers.session_start![0]!({ type: "session_start", reason: "resume" }, ctx);
		expect(manager).not.toBe(first);
		expect(manager!.disposedState).toBe(false);

		await startTask(pi, manager!, ctx);
		expect(manager!.activeTasks().length).toBe(1);
		manager!.dispose();
	});

	describe("pending child questions", () => {
		const OTHER_CHOICE = "Other — type your answer";

		it("appends an Other choice and sends a picked regular choice", async () => {
			const setup = await setupExtension();
			setup.ui.selectReply = "alpha";
			const taskId = await askPending(setup, {
				id: "q1",
				kind: "question",
				question: "Which file?",
				options: [{ label: "alpha" }, { label: "beta" }],
			});
			expect(setup.ui.selectCalls).toEqual([{ title: "Which file?", options: ["alpha", "beta", OTHER_CHOICE] }]);
			expect(setup.ui.inputCalls).toEqual([]);
			expect(setup.transport.answers).toEqual([{ taskId, requestId: "q1", value: { answer: "alpha" } }]);
			setup.manager.dispose();
		});

		it("opens input for the Other choice and sends the typed answer", async () => {
			const setup = await setupExtension();
			setup.ui.selectReply = OTHER_CHOICE;
			setup.ui.inputReply = "the custom answer";
			const taskId = await askPending(setup, {
				id: "q1",
				kind: "question",
				question: "Which file?",
				options: [{ label: "alpha" }, { label: "beta" }],
			});
			expect(setup.ui.selectCalls[0]!.options).toEqual(["alpha", "beta", OTHER_CHOICE]);
			expect(setup.ui.inputCalls.map((call) => call.title)).toEqual(["Which file?"]);
			expect(setup.transport.answers).toEqual([{ taskId, requestId: "q1", value: { answer: "the custom answer" } }]);
			setup.manager.dispose();
		});

		it("asks a question without options through input alone", async () => {
			const setup = await setupExtension();
			setup.ui.inputReply = "typed answer";
			const taskId = await askPending(setup, { id: "q1", kind: "question", question: "Which file?" });
			expect(setup.ui.selectCalls).toEqual([]);
			expect(setup.ui.inputCalls.map((call) => call.title)).toEqual(["Which file?"]);
			expect(setup.transport.answers).toEqual([{ taskId, requestId: "q1", value: { answer: "typed answer" } }]);
			setup.manager.dispose();
		});

		it("does not answer when the selector is cancelled", async () => {
			const setup = await setupExtension();
			setup.ui.selectReply = undefined;
			await askPending(setup, {
				id: "q1",
				kind: "question",
				question: "Which file?",
				options: [{ label: "alpha" }, { label: "beta" }],
			});
			expect(setup.ui.selectCalls).toHaveLength(1);
			expect(setup.ui.inputCalls).toEqual([]);
			expect(setup.transport.answers).toEqual([]);
			setup.manager.dispose();
		});

		it("does not answer when the Other input is cancelled", async () => {
			const setup = await setupExtension();
			setup.ui.selectReply = OTHER_CHOICE;
			setup.ui.inputReply = undefined;
			await askPending(setup, {
				id: "q1",
				kind: "question",
				question: "Which file?",
				options: [{ label: "alpha" }, { label: "beta" }],
			});
			expect(setup.ui.inputCalls.map((call) => call.title)).toEqual(["Which file?"]);
			expect(setup.transport.answers).toEqual([]);
			setup.manager.dispose();
		});

		it("keeps the permission confirm unchanged without an Other choice", async () => {
			const setup = await setupExtension();
			setup.ui.confirmReply = false;
			const taskId = await askPending(setup, {
				id: "req-1",
				kind: "permission",
				question: "Run this command?",
				tool: "bash",
				input: { command: "rm -rf /tmp/x" },
			});
			expect(setup.ui.confirmCalls).toHaveLength(1);
			const [title, message] = setup.ui.confirmCalls[0]!;
			expect(title).toBe("bash");
			expect(message).toContain("Run this command?");
			expect(setup.ui.selectCalls).toEqual([]);
			expect(setup.ui.inputCalls).toEqual([]);
			expect(setup.transport.answers).toEqual([{ taskId, requestId: "req-1", value: { approved: false } }]);
			setup.manager.dispose();
		});
	});
});
