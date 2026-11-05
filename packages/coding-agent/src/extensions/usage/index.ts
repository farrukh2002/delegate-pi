import { type Component, getKeybindings, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import { collectProviderUsage, type ProviderUsage } from "./providers.ts";
import { aggregateSessionUsage, formatDollars, formatTokens, type ModelUsageEntry, spendLevel } from "./usage.ts";

export interface UsageScreenOptions {
	tui?: TUI;
	sessionLabel?: string;
	providers?: ProviderUsage[];
}

const DETAIL_MARKS = [
	{ mark: "•", color: "warning" as ThemeColor, key: "input" as const },
	{ mark: "•", color: "warning" as ThemeColor, key: "output" as const },
	{ mark: "-", color: "muted" as ThemeColor, key: "cacheRead" as const },
	{ mark: "-", color: "muted" as ThemeColor, key: "cacheWrite" as const },
];

function detailLine(row: ModelUsageEntry, key: (typeof DETAIL_MARKS)[number]["key"]): string {
	const tokens = formatTokens(row[key]);
	const cost = formatDollars(
		key === "input"
			? row.costInput
			: key === "output"
				? row.costOutput
				: key === "cacheRead"
					? row.costCacheRead
					: row.costCacheWrite,
	);
	const label =
		key === "cacheRead" ? "cache read" : key === "cacheWrite" ? "cache write" : key === "input" ? "input" : "output";
	return `${tokens} ${label} tokens · ${cost}`;
}

function padTo(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - text.length));
}

export function createUsageScreen(
	entries: SessionEntry[],
	theme: Theme,
	done: () => void,
	options: UsageScreenOptions = {},
): Component & { handleInput(data: string): void; dispose?(): void } {
	const summary = aggregateSessionUsage(entries);
	const sessionLabel = options.sessionLabel ?? "this session";
	const providers = options.providers ?? [];
	let closed = false;
	let cursor = 0;
	let detail = false;

	const costColor = (cost: number): ThemeColor => {
		const level = spendLevel(cost, summary.totalCost);
		return level === "dominant" ? "error" : level === "high" ? "warning" : "text";
	};

	const rowLine = (row: ModelUsageEntry, selected: boolean, width: number): string => {
		const cost = formatDollars(row.cost);
		const pad = Math.max(1, width - row.key.length - cost.length - 4);
		const colored = `${theme.fg("text", row.key)}${" ".repeat(pad)}${theme.fg(costColor(row.cost), cost)}`;
		return truncateToWidth(selected ? theme.style(colored, { underline: true }) : colored, width, "…");
	};

	const providerLines = (provider: ProviderUsage, width: number): string[] => {
		const name = padTo(provider.label, 14);
		if (provider.kind === "unavailable") {
			return [truncateToWidth(`${theme.fg("text", name)}${theme.fg("dim", provider.reason)}`, width, "…")];
		}
		if (provider.kind === "balance") {
			const value = provider.items
				.map((item) =>
					item.currency === "USD" ? formatDollars(item.total) : `${item.total.toFixed(2)} ${item.currency}`,
				)
				.join(" · ");
			return [truncateToWidth(`${theme.fg("text", name)}${theme.fg("text", `${value} left`)}`, width, "…")];
		}
		const worst = Math.max(...provider.windows.map((window) => window.percent));
		const color: ThemeColor = worst >= 100 ? "error" : worst >= 80 ? "warning" : "text";
		const value = provider.windows.map((window) => `${window.label} ${Math.round(window.percent)}%`).join(" · ");
		return [truncateToWidth(`${theme.fg("text", name)}${theme.fg(color, value)}`, width, "…")];
	};

	return {
		render(width: number): string[] {
			const height = Math.max(3, options.tui?.terminal.rows ?? 24);
			const lines: string[] = [];

			if (detail && summary.rows[cursor]) {
				const row = summary.rows[cursor];
				lines.push(truncateToWidth(`${theme.fg("muted", "Usage › ")}${theme.fg("text", row.key)}`, width, "…"), "");
				const spent = `${formatDollars(row.cost)} spent`;
				lines.push(truncateToWidth(theme.fg(costColor(row.cost), theme.bold(spent)), width, "…"));
				const share = summary.totalCost > 0 ? Math.round((row.cost / summary.totalCost) * 100) : 0;
				const requests = row.requests > 0 ? `${row.requests} requests` : "background usage";
				lines.push(truncateToWidth(theme.fg("muted", `${requests} · ${share}% of session spend`), width, "…"));
				lines.push("", truncateToWidth(theme.fg("muted", "Breakdown"), width, "…"));
				for (const mark of DETAIL_MARKS) {
					const line = detailLine(row, mark.key);
					lines.push(truncateToWidth(`${theme.fg(mark.color, mark.mark)} ${theme.fg("text", line)}`, width, "…"));
				}
				lines.push("", truncateToWidth(theme.fg("dim", "esc to close · enter for the list"), width, "…"));
				return lines.slice(0, height);
			}

			lines.push(truncateToWidth(theme.fg("accent", "Usage"), width, "…"));
			const meta = `Session ${sessionLabel} · ${summary.messages} messages · ${summary.models} models`;
			lines.push(truncateToWidth(theme.fg("muted", meta), width, "…"), "");

			if (summary.rows.length === 0) {
				lines.push(truncateToWidth(theme.fg("muted", "No usage recorded yet."), width, "…"));
			} else {
				if (cursor >= summary.rows.length) cursor = summary.rows.length - 1;
				for (let index = 0; index < summary.rows.length; index++) {
					const row = summary.rows[index];
					if (index === cursor) {
						const prefix = theme.fg("accent", "▸ ");
						const rest = rowLine(row, true, width - 2);
						lines.push(truncateToWidth(prefix + rest.replace(/^\s*/, ""), width, "…"));
					} else {
						lines.push(rowLine(row, false, width));
					}
				}
				lines.push("");
				const total = formatDollars(summary.totalCost);
				const pad = Math.max(1, width - 5 - total.length - 4);
				lines.push(
					truncateToWidth(
						`${theme.bold("Total")}${" ".repeat(pad)}${theme.bold(theme.fg("text", total))}`,
						width,
						"…",
					),
				);
			}
			if (providers.length > 0) {
				lines.push("", truncateToWidth(theme.fg("muted", "Providers"), width, "…"));
				for (const provider of providers) {
					lines.push(...providerLines(provider, width));
				}
			}
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", "esc to close · up/down to move · enter for detail"), width, "…"));
			return lines.slice(0, height).map((line) => truncateToWidth(line, width, "…"));
		},
		handleInput(data: string): void {
			if (closed) return;
			const keybindings = getKeybindings();
			if (keybindings.matches(data, "app.usage.escape")) {
				if (detail) {
					detail = false;
					options.tui?.requestRender();
				} else {
					closed = true;
					done();
				}
				return;
			}
			if (keybindings.matches(data, "app.usage.down") && summary.rows.length > 0) {
				cursor = Math.min(cursor + 1, summary.rows.length - 1);
				options.tui?.requestRender();
			} else if (keybindings.matches(data, "app.usage.up")) {
				cursor = Math.max(cursor - 1, 0);
				options.tui?.requestRender();
			} else if (keybindings.matches(data, "app.usage.select") && summary.rows.length > 0) {
				detail = true;
				options.tui?.requestRender();
			}
		},
		invalidate(): void {},
		dispose(): void {
			closed = true;
		},
	};
}

export function createUsageExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("usage", {
			description: "Show token usage and spend for this session",
			handler: async (_args, ctx) => {
				const providers = await collectProviderUsage();
				await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) =>
					createUsageScreen(ctx.sessionManager.getEntries(), theme, () => done(undefined), {
						tui,
						sessionLabel: ctx.sessionManager.getSessionId().slice(0, 8),
						providers,
					}),
				);
			},
		});
	};
}

export default createUsageExtension();
