import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	type Component,
	foregroundAnsi,
	getKeybindings,
	getTerminalColorMode,
	mixColors,
	parseColor,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { APP_NAME, getSessionsDir } from "../../config.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { type FileEntry, loadEntriesFromFile } from "../../core/session-manager.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { themeBackgroundColor } from "../../modes/interactive/theme/theme.ts";
import { formatTokens } from "../usage/usage.ts";
import { activityCalendar, DIGITS, gatherStats, type StatsSummary, statsNumber } from "./stats.ts";

export interface StatsScreenOptions {
	tui?: TUI;
}

const CANVAS_BACKGROUND = "#0a0a0a";

function bigNumberLines(number: string, width: number): string[] | undefined {
	const letters = Array.from(number).map((char) => DIGITS[char]);
	if (letters.some((letter) => !letter)) return undefined;
	const totalWidth = letters.reduce((sum, letter) => sum + letter[0].length * 2 + 2, -2);
	if (totalWidth > width - 8) return undefined;
	return [0, 1, 2, 3, 4].map((row) =>
		letters.map((letter) => letter[row].replaceAll("1", "██").replaceAll("0", "  ")).join("  "),
	);
}

function pad(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - line.length));
}

function padStartPlain(text: string, targetLength: number): string {
	return " ".repeat(Math.max(0, targetLength - text.length)) + text;
}

export function createStatsScreen(
	summary: StatsSummary,
	theme: Theme,
	done: () => void,
	options: StatsScreenOptions = {},
): Component & { handleInput(data: string): void; dispose?(): void } {
	let closed = false;
	const canvas = parseColor(CANVAS_BACKGROUND);
	const paint = (line: string, width: number): string => {
		const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
		return theme.style(line + padding, { bg: canvas });
	};

	const shades = (): string[] => {
		const background = themeBackgroundColor(theme);
		const accent = theme.colors.accent;
		const mode = getTerminalColorMode();
		return [
			theme.fg("muted", "·"),
			...[0.3, 0.5, 0.75, 1].map((alpha) => foregroundAnsi(mixColors(background, accent, alpha, "srgb"), mode)),
		];
	};

	const renderPoster = (width: number, maxModels: number): string[] => {
		const lines: string[] = [];
		const padX = 2;
		const inner = Math.max(12, width - padX * 2);
		const left = " ".repeat(padX);
		const dates = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).formatRange(
			new Date(summary.from),
			new Date(Math.max(summary.from, summary.to - 1)),
		);
		const title = `${APP_NAME} / stats`;
		const titleGap = Math.max(1, inner - title.length - dates.length);
		lines.push(`${left}${theme.bold(theme.fg("text", title))}${" ".repeat(titleGap)}${theme.fg("muted", dates)}`);
		lines.push("");

		const number = statsNumber(summary.tokens);
		const big = bigNumberLines(number, inner);
		if (big) {
			const digitWidth = big.reduce((max, row) => Math.max(max, visibleWidth(row)), 0);
			const indent = " ".repeat(padX + Math.max(0, Math.floor((inner - digitWidth) / 2)));
			big.forEach((row, index) => {
				lines.push(indent + (index === 2 ? `${row}  ${theme.fg("muted", "TOKENS")}` : row));
			});
		} else {
			const plain = `${number} TOKENS`;
			lines.push(
				" ".repeat(padX + Math.max(0, Math.floor((inner - plain.length) / 2))) +
					theme.bold(theme.fg("text", number)) +
					theme.fg("muted", " TOKENS"),
			);
		}
		lines.push("");

		const calendarWidth = Math.min(inner, 4 + Math.floor((inner - 4) / 2) * 2);
		const calendar = activityCalendar({
			activity: summary.activity,
			from: summary.from,
			to: summary.to,
			maxWeeks: Math.floor((calendarWidth - 4) / 2),
		});
		const blockWidth = 4 + calendar.weeks.length * 2;
		const blockLeft = " ".repeat(padX + Math.max(0, Math.floor((inner - blockWidth) / 2)));
		const palette = shades();
		const monthsLine = calendar.months
			.map((month) => (month.label.length <= month.span * 2 ? month.label : "").padEnd(month.span * 2))
			.join("");
		lines.push(`${blockLeft}    ${theme.fg("muted", monthsLine)}`);
		const dayLabels = ["M", "T", "W", "T", "F", "S", "S"];
		dayLabels.forEach((day, index) => {
			let row = `${theme.fg("muted", `${day}   `)}`;
			for (const week of calendar.weeks) {
				const cell = week[index];
				if (cell.level < 0) row += "  ";
				else if (cell.level === 0) row += `${palette[0]} `;
				else row += `${palette[cell.level]}█ `;
			}
			lines.push(blockLeft + row);
		});
		if (calendar.clipped) {
			lines.push(`${blockLeft}    ${theme.fg("muted", `Your last ${calendar.weeks.length} weeks`)}`);
		}
		lines.push("");

		const metrics = [
			{ value: summary.streak === 1 ? "1 day" : `${statsNumber(summary.streak)} days`, label: "best streak" },
			{ value: statsNumber(summary.activeDays), label: "active days" },
			{ value: statsNumber(summary.sessions), label: "sessions" },
		];
		const columnWidth = Math.floor(blockWidth / metrics.length);
		const centered = (text: string) => padStartPlain(text, Math.floor((columnWidth + text.length) / 2));
		const valuesLine = metrics.map((metric) => theme.bold(theme.fg("text", centered(metric.value)))).join("");
		const labelsLine = metrics.map((metric) => theme.fg("muted", centered(metric.label))).join("");
		lines.push(blockLeft + truncateToWidth(valuesLine, blockWidth, "…"));
		lines.push(blockLeft + truncateToWidth(labelsLine, blockWidth, "…"));
		const models = summary.models;
		if (models.length > 0 && maxModels > 0) {
			const shown = models.slice(0, maxModels);
			const rest = models.slice(maxModels);
			const restTokens = rest.reduce((sum, model) => sum + model.tokens, 0);
			if (restTokens > 0) shown.push({ name: `${rest.length} more`, tokens: restTokens });
			const nameWidth = Math.min(22, Math.max(...shown.map((model) => model.name.length)));
			const tokenWidth = Math.max(...shown.map((model) => formatTokens(model.tokens).length));
			const gap = 2;
			const barWidth = Math.max(0, blockWidth - nameWidth - tokenWidth - 10);
			lines.push(`${blockLeft}${theme.fg("muted", "Models")}`);
			for (const model of shown) {
				const share = summary.tokens > 0 ? model.tokens / summary.tokens : 0;
				const filled = Math.max(share > 0 ? 1 : 0, Math.round(share * barWidth));
				const bar =
					barWidth > 0
						? `${theme.fg("accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(Math.max(0, barWidth - filled)))}  `
						: "";
				const name = truncateToWidth(model.name, nameWidth, "…");
				const tokensText = formatTokens(model.tokens).padStart(tokenWidth);
				const percent = `${Math.round(share * 100)}%`.padStart(4);
				lines.push(
					`${blockLeft}${theme.fg("text", pad(name, nameWidth))}${" ".repeat(gap)}${bar}${theme.fg("text", tokensText)}  ${theme.fg("muted", percent)}`,
				);
			}
		}

		const signature = theme.fg("text", APP_NAME);
		lines.push(" ".repeat(Math.max(padX, width - padX - APP_NAME.length)) + signature);
		return lines;
	};

	return {
		render(width: number): string[] {
			const height = Math.max(3, options.tui?.terminal.rows ?? 24);
			const content = renderPoster(width, Math.max(0, Math.min(5, height - 23)));
			const area = Math.max(0, height - 1);
			const top = Math.max(0, Math.floor((area - content.length) / 2));
			const lines: string[] = Array.from({ length: top }, () => "");
			lines.push(...content.slice(0, area));
			while (lines.length < area) lines.push("");
			lines.push(`  ${theme.fg("muted", "esc to close")}`);
			return lines.slice(0, height).map((line) => paint(truncateToWidth(line, width, "…"), width));
		},
		handleInput(data: string): void {
			if (closed) return;
			if (getKeybindings().matches(data, "app.stats.close")) {
				closed = true;
				done();
			}
		},
		invalidate(): void {},
		dispose(): void {
			closed = true;
		},
	};
}

export function loadYearSessions(dir: string = getSessionsDir()): FileEntry[][] {
	const files: string[] = [];
	const projectDirs: string[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) projectDirs.push(join(dir, entry.name));
			else if (entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
		}
	} catch {
		return [];
	}
	for (const projectDir of projectDirs) {
		try {
			for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(projectDir, entry.name));
			}
		} catch {}
	}
	return files.map((path) => {
		try {
			return loadEntriesFromFile(path);
		} catch {
			return [];
		}
	});
}

export function createStatsExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("stats", {
			description: "Show this year's token and session stats",
			handler: async (_args, ctx) => {
				const summary = gatherStats(loadYearSessions());
				await ctx.ui.custom<undefined>(
					(tui, theme, _keybindings, done) => createStatsScreen(summary, theme, () => done(undefined), { tui }),
					{
						overlay: true,
						overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "top-left", row: 0, col: 0 },
					},
				);
			},
		});
	};
}

export default createStatsExtension();
