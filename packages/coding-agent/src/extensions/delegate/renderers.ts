import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
	agentsLabel,
	changes,
	clock,
	elapsed,
	GOOD,
	isTerminal,
	MARKS,
	statusText,
	type TaskView,
} from "../../core/delegate/view.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { DEFAULT_DELEGATE_STYLE, type DelegateStyle } from "../../modes/interactive/components/delegate-style.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { DelegateTaskDetails } from "./tools.ts";

export interface DelegateCallArg {
	agent?: string;
	task?: string;
}

export interface DelegateCallArgs {
	agent?: string;
	task?: string;
	chain?: boolean;
	tasks?: (DelegateCallArg | DelegateCallArg[])[];
}

export interface DelegateLiveSource {
	viewsFor(toolCallId: string): TaskView[] | undefined;
}

export interface DelegateRenderContext {
	toolCallId?: string;
	source?: DelegateLiveSource;
}

export interface DelegateTaskLookup {
	callTasks(toolCallId: string): string[];
	get(taskId: string): TaskView | undefined;
}

export function managerLiveSource(lookup: DelegateTaskLookup): DelegateLiveSource {
	return {
		viewsFor(toolCallId: string): TaskView[] | undefined {
			const ids = lookup.callTasks(toolCallId);
			if (ids.length === 0) return undefined;
			const views = ids.map((id) => lookup.get(id)).filter((view): view is TaskView => Boolean(view));
			return views.length > 0 ? views : undefined;
		},
	};
}

function emptyComponent(): Component {
	return {
		render: () => [],
		invalidate: () => {},
	};
}

function lineComponent(render: (width: number) => string): Component {
	return {
		render: (width: number) => [render(width)],
		invalidate: () => {},
	};
}

function linesComponent(render: (width: number) => string[]): Component {
	return {
		render,
		invalidate: () => {},
	};
}

function bound(text: string, width: number): string {
	return truncateToWidth(text, width, "…");
}

function dim(theme: Theme, color: ThemeColor, text: string): string {
	return theme.style(text, { fg: color, dim: true });
}

function markStyle(value: string, style: DelegateStyle): ThemeColor {
	switch (value) {
		case "accent":
			return style.accent;
		case "warning":
			return style.warning;
		case "success":
			return style.success;
		case "error":
			return style.error;
		default:
			return style.muted;
	}
}

function plainText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.map((part) => part.text ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function liveViews(details: DelegateTaskDetails | undefined, context?: DelegateRenderContext): TaskView[] {
	const id = context?.toolCallId;
	if (id && context?.source) return context.source.viewsFor(id) ?? details?.views ?? [];
	return details?.views ?? [];
}

function isOpen(view: TaskView): boolean {
	return !isTerminal(view.status) && view.status !== "stopped";
}

function startedLine(views: TaskView[], theme: Theme, style: DelegateStyle): string {
	return [
		theme.fg(style.inactive, "◌"),
		dim(theme, style.muted, "started"),
		theme.fg(style.text, agentsLabel(views)),
		dim(theme, style.muted, "in the background"),
	].join(" ");
}

function doneLine(views: TaskView[], theme: Theme, style: DelegateStyle): string {
	const longest = Math.max(0, ...views.map((view) => elapsed(view)));
	const [added, removed] = views.reduce<[number, number]>(
		(acc, view) => {
			const [a, r] = changes(view.diffstat);
			return [acc[0] + a, acc[1] + r];
		},
		[0, 0],
	);
	const failed = views.filter((view) => !GOOD.includes(view.status));
	const verb = views.length > 1 && failed.length < views.length ? "delegated" : statusText(views[0]!);
	const parts = [
		theme.fg(failed.length ? style.warning : style.inactive, failed.length ? "!" : "✓"),
		dim(theme, style.muted, verb),
	];
	for (const view of views) {
		const [mark, color] = MARKS[view.status] ?? ["·", "muted"];
		const label = views.length > 1 ? `${theme.fg(markStyle(color, style), mark)} ${view.agent}` : view.agent;
		parts.push(theme.fg(style.text, label));
	}
	if (longest > 0) parts.push(dim(theme, style.muted, clock(longest)));
	if (added > 0) parts.push(theme.fg("toolDiffAdded", `+${added}`));
	if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `−${removed}`));
	return parts.join(" ");
}

function statusLine(views: TaskView[], theme: Theme, style: DelegateStyle, width: number): string {
	const line = views.some(isOpen) ? startedLine(views, theme, style) : doneLine(views, theme, style);
	return bound(line, width);
}

function labelLine(args: DelegateCallArgs, theme: Theme, style: DelegateStyle, width: number): string {
	const groups = (args.tasks ?? []).map((item) => (Array.isArray(item) ? item : [item]));
	const count = groups.reduce((total, group) => total + group.length, 0);
	const names = groups
		.flat()
		.map((item) => item?.agent ?? "?")
		.join(", ");
	const parallel = count > 1;
	const label = parallel
		? args.chain
			? `chain ${count}`
			: `parallel ${count}`
		: (args.agent ?? groups[0]?.[0]?.agent ?? "task");
	const head = theme.fg(style.accent, "◌");
	const verb = theme.fg(style.muted, parallel ? (args.chain ? "chain" : "delegated") : "delegate");
	const body = theme.fg(style.text, label);
	return bound(`${head} ${verb} ${body}${names ? ` ${theme.fg(style.subtle, names)}` : ""}`, width);
}

export function renderDelegateCall(
	args: DelegateCallArgs,
	theme: Theme,
	context?: DelegateRenderContext,
	style: DelegateStyle = DEFAULT_DELEGATE_STYLE,
): Component {
	return lineComponent((width) => {
		const id = context?.toolCallId;
		const views = id && context?.source ? context.source.viewsFor(id) : undefined;
		if (views && views.length > 0) return statusLine(views, theme, style, width);
		return labelLine(args, theme, style, width);
	});
}

export function renderDelegateResult(
	result: { content: { type: string; text?: string }[]; isError?: boolean },
	options: { expanded: boolean },
	theme: Theme,
	details?: DelegateTaskDetails,
	context?: DelegateRenderContext,
	style: DelegateStyle = DEFAULT_DELEGATE_STYLE,
): Component {
	const views = liveViews(details, context);
	const live = Boolean(context?.toolCallId && context?.source);

	if (!options.expanded) {
		if (live && views.length > 0) return emptyComponent();
		return lineComponent((width) =>
			views.length === 0
				? bound(theme.fg(style.muted, plainText(result)), width)
				: statusLine(views, theme, style, width),
		);
	}

	return linesComponent((width) => {
		if (views.length === 0) return [bound(theme.fg(style.muted, plainText(result)), width)];
		const lines: string[] = [];
		for (const view of views) {
			const [mark, markColor] = MARKS[view.pending ? "waiting" : view.status] ?? ["·", "muted"];
			const meta = `${statusText(view)} · ${clock(elapsed(view))}${view.scope.length ? ` · ${view.scope.join(", ")}` : " · read-only"}`;
			lines.push(
				bound(
					`${theme.fg(markStyle(markColor, style), mark)} ${view.agent} ${dim(theme, style.muted, meta)}`,
					width,
				),
			);
			for (const action of view.activity ?? []) {
				lines.push(bound(dim(theme, style.subtle, `  ⎿ ${action}`), width));
			}
		}
		return lines;
	});
}

export function renderDelegateTasksCall(
	args: { action?: string; taskId?: string; olderThan?: string },
	theme: Theme,
	lookup?: Pick<DelegateTaskLookup, "get">,
	style: DelegateStyle = DEFAULT_DELEGATE_STYLE,
): Component {
	return lineComponent((width) => {
		const action = args.action ?? "status";
		const glyph = { accept: "✓", undo: "↺", cancel: "–", diff: "±", prune: "⌫" }[action] ?? "·";
		const known = args.taskId ? lookup?.get(args.taskId) : undefined;
		const subject =
			action === "prune"
				? `older than ${args.olderThan ?? "7d"}`
				: known
					? known.agent
					: args.taskId
						? args.taskId.slice(0, 8)
						: "all tasks";
		return bound(
			`${theme.fg(style.inactive, glyph)} ${dim(theme, style.muted, action)} ${theme.fg(style.text, subject)}`,
			width,
		);
	});
}

export function renderDelegateTasksResult(
	result: { content: { type: string; text?: string }[] },
	options: { expanded: boolean },
	theme: Theme,
	style: DelegateStyle = DEFAULT_DELEGATE_STYLE,
): Component {
	if (!options.expanded) return emptyComponent();
	return linesComponent((width) =>
		result.content
			.flatMap((part) => (part.type === "text" && part.text ? part.text.split("\n") : []))
			.map((line) => bound(theme.fg(style.text, line), width)),
	);
}

export function renderReportMessage(
	message: CustomMessage,
	theme: Theme,
	style: DelegateStyle = DEFAULT_DELEGATE_STYLE,
): Component {
	return lineComponent((width) => {
		const text = typeof message.content === "string" ? message.content : "";
		const rows = [...text.matchAll(/^\S (\S+) [0-9a-f-]{36} (\w+)/gm)].map((match) => ({
			agent: match[1] ?? "",
			status: match[2] ?? "",
		}));
		if (rows.length === 0) return bound(theme.fg(style.subtle, text), width);
		const marks = rows
			.map((row) => {
				const [mark, markColor] = MARKS[row.status] ?? ["·", "muted"];
				return `${theme.fg(markStyle(markColor, style), mark)} ${row.agent}`;
			})
			.join(" ");
		return bound(`${theme.fg(style.muted, "↳")} ${theme.fg(style.muted, "report")} ${marks}`, width);
	});
}
