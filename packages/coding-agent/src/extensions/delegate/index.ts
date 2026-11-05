import { type Component, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { askUserQuestion } from "../../core/ask-user.ts";
import { delegateCliPath, delegateEnv } from "../../core/delegate/config.ts";
import { type DelegateHost, DelegateManager, type DelegateUI } from "../../core/delegate/manager.ts";
import {
	createCliTransport,
	type DelegateAgentInfo,
	type DelegatePending,
	type DelegateTransport,
} from "../../core/delegate/transport.ts";
import { permissionText, REPORT_TAG, readyAgents, unavailableText } from "../../core/delegate/view.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { DelegateBand } from "../../modes/interactive/components/delegate-band.ts";
import { managerLiveSource, renderDelegateCall, renderDelegateResult, renderReportMessage } from "./renderers.ts";
import { createTasksScreen } from "./screen.ts";
import {
	createDelegateTasksTool,
	createDelegateTool,
	DELEGATE_TASKS_TOOL_NAME,
	DELEGATE_TOOL_NAME,
	type DelegateTaskDetails,
	type DelegateToolDeps,
} from "./tools.ts";

export interface DelegateExtensionOptions {
	transport?: DelegateTransport;
	now?: () => number;
	intervalMs?: number;
	defaultAgents?: string[];
	onManager?: (manager: DelegateManager) => void;
}

const DEFAULT_AGENTS = ["pi-scout", "pi-worker", "cx-worker", "cmd-worker"];

function uiFromContext(ctx: ExtensionContext): DelegateUI {
	return {
		available: ctx.hasUI,
		ask: async (question, options) => {
			if (!ctx.hasUI) return undefined;
			return askUserQuestion(ctx.ui, question, options, undefined, { signal: ctx.signal });
		},
		notify: (message, type) => ctx.ui.notify(message, type),
		confirmPermission: ctx.hasUI
			? (pending: DelegatePending) => ctx.ui.confirm(pending.tool ?? "Permission", permissionText(pending))
			: undefined,
		confirmProjectAgent: ctx.hasUI
			? (agent: DelegateAgentInfo) =>
					ctx.ui.confirm(
						"Run a project agent?",
						`The agent "${agent.name}" comes from this project${agent.filePath ? `: ${agent.filePath}` : ""}\n\nThe project sets its prompt and settings. Run it only if you trust this project.`,
					)
			: undefined,
	};
}

function hostFromContext(ctx: ExtensionContext): DelegateHost {
	return {
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		branchEntries: () => ctx.sessionManager.getBranch(),
		ui: uiFromContext(ctx),
	};
}

function takeReport(manager: DelegateManager): { content: string; reportIds: string[] } | undefined {
	return manager.takeReportWithIds();
}

function mergeReportIds(details: unknown, reportIds: string[]): Record<string, unknown> {
	const base = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
	return { ...base, delegateReportIds: reportIds };
}

export function createDelegateExtension(options: DelegateExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const transport =
			options.transport ??
			createCliTransport({ cliPath: delegateCliPath(), env: delegateEnv(), cwd: process.cwd() });

		let manager: DelegateManager;
		let band: DelegateBand | undefined;
		let uiCtx: ExtensionContext | undefined;
		let tuiRef: TUI | undefined;
		let requestTui: ((force?: boolean) => void) | undefined;
		let unsubscribeInput: (() => void) | undefined;
		let savedFocus: Component | null = null;

		const restoreFocus = (): void => {
			const target = savedFocus;
			savedFocus = null;
			tuiRef?.setFocus(target ?? null);
			requestTui?.();
		};

		const teardownBand = (): void => {
			unsubscribeInput?.();
			unsubscribeInput = undefined;
			if (band?.focused) {
				tuiRef?.setFocus(savedFocus ?? null);
				savedFocus = null;
				requestTui?.();
			} else {
				savedFocus = null;
			}
			if (uiCtx?.mode === "tui") uiCtx.ui.setWidget("delegate-band", undefined);
			band?.dispose();
			band = undefined;
			requestTui = undefined;
			tuiRef = undefined;
		};

		const setupBand = (ctx: ExtensionContext): void => {
			const currentBand = new DelegateBand({
				now: options.now,
				intervalMs: options.intervalMs,
				terminalRows: () => tuiRef?.terminal.rows ?? 24,
				requestRender: () => requestTui?.(),
				onFocusRequest: () => {
					if (!currentBand.focused && tuiRef) savedFocus = tuiRef.getFocusedComponent();
				},
			});
			band = currentBand;
			ctx.ui.setWidget(
				"delegate-band",
				(tui) => {
					tuiRef = tui;
					requestTui = (force?: boolean) => tui.requestRender(force);
					return currentBand;
				},
				{ placement: "aboveEditor" },
			);
			const keybindings = getKeybindings();
			unsubscribeInput = ctx.ui.onTerminalInput((data) => {
				const active = band;
				if (!active || !tuiRef) return undefined;
				if (!active.focused) {
					if (keybindings.matches(data, "app.delegate.focus")) {
						savedFocus = tuiRef.getFocusedComponent();
						tuiRef.setFocus(active);
						requestTui?.();
						return { consume: true };
					}
					return undefined;
				}
				if (keybindings.matches(data, "app.delegate.escape")) {
					restoreFocus();
					return { consume: true };
				}
				if (keybindings.matches(data, "app.delegate.up")) {
					active.moveCursor(-1);
					return { consume: true };
				}
				if (keybindings.matches(data, "app.delegate.down")) {
					active.moveCursor(1);
					return { consume: true };
				}
				if (keybindings.matches(data, "app.delegate.toggle")) {
					active.toggleSelected();
					return { consume: true };
				}
				restoreFocus();
				return undefined;
			});
		};

		const syncBand = (): void => {
			const rows = manager.liveRows();
			if (rows.length === 0) {
				if (band) teardownBand();
				return;
			}
			if (!band) {
				if (!uiCtx || uiCtx.mode !== "tui") return;
				setupBand(uiCtx);
			}
			band?.setRows(rows);
			requestTui?.();
		};

		const createManager = (): DelegateManager =>
			new DelegateManager({
				transport,
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				now: options.now,
				intervalMs: options.intervalMs,
				requestRender: syncBand,
			});

		manager = createManager();
		options.onManager?.(manager);

		const toolDeps: DelegateToolDeps = { manager, hostFrom: hostFromContext };
		const source = managerLiveSource({
			callTasks: (toolCallId) => manager.callTasks(toolCallId),
			get: (taskId) => manager.get(taskId),
		});

		const registeredAgents = options.defaultAgents ?? DEFAULT_AGENTS;

		const registerTools = (agents: string[], unavailable = ""): void => {
			const delegateTool = createDelegateTool(toolDeps, agents, unavailable);
			pi.registerTool({
				...delegateTool,
				renderCall: (args, theme, context) =>
					renderDelegateCall(
						{
							agent: args.agent,
							task: args.task,
							tasks: args.tasks,
							chain: Array.isArray(args.chain) && args.chain.length > 0,
						},
						theme,
						{ toolCallId: context.toolCallId, source },
					),
				renderResult: (result, renderOptions, theme, context) =>
					renderDelegateResult(
						result as { content: { type: string; text?: string }[] },
						renderOptions,
						theme,
						(result as { details?: DelegateTaskDetails }).details,
						{ toolCallId: context.toolCallId, source },
					),
			});
			pi.registerTool(createDelegateTasksTool(toolDeps));
		};

		registerTools(registeredAgents);

		pi.registerMessageRenderer(REPORT_TAG, (message, _renderOptions, theme) => renderReportMessage(message, theme));

		pi.registerCommand("delegate-tasks", {
			description: "Show the delegate child tasks of this session",
			handler: async (_args, ctx) => {
				await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) =>
					createTasksScreen(manager, theme, () => done(undefined), { tui }),
				);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			if (manager.disposedState) {
				manager = createManager();
				toolDeps.manager = manager;
				options.onManager?.(manager);
			}
			uiCtx = ctx;
			manager.setHost(hostFromContext(ctx));
			manager.restore();
			try {
				void transport.run(["models"]).catch(() => undefined);
			} catch {}
			try {
				const discovered = (await manager.agents(ctx.cwd)).filter((agent) => agent.name);
				const ready = readyAgents(discovered);
				const names = (ready.length > 0 ? ready : discovered).map((agent) => agent.name);
				registerTools(names.length > 0 ? names : registeredAgents, unavailableText(discovered));
			} catch {}
			syncBand();
		});

		pi.on("session_shutdown", () => {
			teardownBand();
			manager.dispose();
			uiCtx = undefined;
		});

		pi.on("tool_result", (event) => {
			if (event.parentToolCallId) return;
			const batch = takeReport(manager);
			if (!batch) return;
			return {
				content: [...event.content, { type: "text" as const, text: batch.content }],
				details: mergeReportIds(event.details, batch.reportIds),
				structuredContent: event.structuredContent,
			};
		});

		pi.on("before_agent_start", () => {
			const batch = takeReport(manager);
			if (!batch) return;
			return {
				message: {
					customType: REPORT_TAG,
					content: batch.content,
					display: true,
					details: { delegateReportIds: batch.reportIds },
				},
			};
		});
	};
}

export { DELEGATE_TASKS_TOOL_NAME, DELEGATE_TOOL_NAME };
export default createDelegateExtension();
