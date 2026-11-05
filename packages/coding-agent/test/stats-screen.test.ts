import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseColor, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { FileEntry } from "../src/core/session-manager.ts";
import { createStatsScreen, loadYearSessions } from "../src/extensions/stats/index.ts";
import { activityCalendar, gatherStats, generalizeModelName, statsNumber } from "../src/extensions/stats/stats.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const NOW = new Date("2026-06-15T12:00:00").getTime();

function entry(timestamp: string, tokens?: { input: number; output: number }): FileEntry {
	return {
		type: "message",
		id: `e-${timestamp}`,
		parentId: null,
		timestamp,
		message: tokens
			? {
					role: "assistant",
					provider: "zai",
					model: "glm-4.6",
					usage: { input: tokens.input, output: tokens.output, cacheRead: 0, cacheWrite: 0 },
				}
			: { role: "user" },
	} as unknown as FileEntry;
}

describe("gatherStats", () => {
	it("counts tokens, sessions, active days and streak", () => {
		const files: FileEntry[][] = [
			[
				entry("2026-06-10T10:00:00Z"),
				entry("2026-06-10T10:05:00Z", { input: 1000, output: 500 }),
				entry("2026-06-11T09:00:00Z", { input: 2000, output: 1000 }),
			],
			[entry("2026-06-12T09:00:00Z", { input: 500, output: 500 })],
			[entry("2025-06-01T09:00:00Z", { input: 90000, output: 90000 })],
		];
		const stats = gatherStats(files, NOW);
		expect(stats.tokens).toBe(5500);
		expect(stats.sessions).toBe(2);
		expect(stats.activeDays).toBe(3);
		expect(stats.streak).toBe(3);
		expect(stats.activity).toHaveLength(3);
	});

	it("skips gaps in the streak", () => {
		const files: FileEntry[][] = [
			[entry("2026-06-01T09:00:00Z"), entry("2026-06-02T09:00:00Z"), entry("2026-06-05T09:00:00Z")],
		];
		expect(gatherStats(files, NOW).streak).toBe(2);
	});

	it("returns an empty summary without sessions", () => {
		const stats = gatherStats([], NOW);
		expect(stats.sessions).toBe(0);
		expect(stats.tokens).toBe(0);
		expect(stats.activeDays).toBe(0);
	});
});

describe("statsNumber", () => {
	it("formats compact numbers", () => {
		expect(statsNumber(999)).toBe("999");
		expect(statsNumber(12_400)).toBe("12.4K");
		expect(statsNumber(1_250_000)).toBe("1.3M");
	});
});

describe("activityCalendar", () => {
	it("grades levels by relative daily tokens", () => {
		const from = new Date("2026-06-01").getTime();
		const to = new Date("2026-06-08").getTime();
		const calendar = activityCalendar({
			activity: [
				{ date: "2026-06-01", tokens: 100 },
				{ date: "2026-06-02", tokens: 900 },
			],
			from,
			to,
			maxWeeks: 10,
		});
		const flat = calendar.weeks.flat();
		const low = flat.find((cell) => cell.date === "2026-06-01");
		const high = flat.find((cell) => cell.date === "2026-06-02");
		const empty = flat.find((cell) => cell.date === "2026-06-03");
		expect(low?.level).toBe(2);
		expect(high?.level).toBe(4);
		expect(empty?.level).toBe(0);
		expect(calendar.months[0].label).toBe("Jun");
	});
});

function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		style: (text: string) => text,
		bold: (text: string) => text,
		colors: { accent: parseColor("#7aa2f7") } as unknown as Theme["colors"],
		mode: "256",
		appearance: "dark" as Theme["appearance"],
	} as unknown as Theme;
}

describe("stats screen", () => {
	beforeAll(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders the poster with digits, calendar and metrics", () => {
		const stats = gatherStats([[entry("2026-06-10T10:00:00Z", { input: 400_000, output: 100_000 })]], NOW);
		const screen = createStatsScreen(stats, plainTheme(), () => {}, {});
		const lines = screen.render(80);
		const title = lines.find((line) => line.includes("/ stats"));
		expect(title).toBeDefined();
		expect(title).toContain("Jun 2026");
		expect(lines.some((line) => line.includes("TOKENS"))).toBe(true);
		expect(lines.some((line) => line.includes("best streak"))).toBe(true);
		expect(lines.some((line) => line.includes("active days"))).toBe(true);
		expect(lines.some((line) => line.includes("sessions"))).toBe(true);
	});

	it("renders block digits for the token count", () => {
		const stats = gatherStats([[entry("2026-06-10T10:00:00Z", { input: 400_000, output: 100_000 })]], NOW);
		const screen = createStatsScreen(stats, plainTheme(), () => {}, {});
		const lines = screen.render(80);
		const tokensIndex = lines.findIndex((line) => line.includes("TOKENS"));
		const start = tokensIndex - 2;
		const digitRows = lines.slice(start, start + 5);
		expect(digitRows).toHaveLength(5);
		expect(digitRows.join("")).toContain("█");
		expect(digitRows.join("")).not.toContain("░");
	});

	it("renders a zero poster without sessions", () => {
		const screen = createStatsScreen(gatherStats([], NOW), plainTheme(), () => {}, {});
		const lines = screen.render(80);
		expect(lines.some((line) => line.includes("/ stats"))).toBe(true);
		expect(lines.some((line) => line.includes("TOKENS"))).toBe(true);
		expect(lines.some((line) => line.includes("██"))).toBe(true);
		expect(lines.some((line) => line.includes("sessions"))).toBe(true);
	});

	it("closes on escape", () => {
		let closed = 0;
		const screen = createStatsScreen(gatherStats([], NOW), plainTheme(), () => closed++, {});
		screen.handleInput("\x1b");
		expect(closed).toBe(1);
	});
});

describe("loadYearSessions", () => {
	it("reads sessions inside per-project directories", () => {
		const root = mkdtempSync(join(tmpdir(), "stats-sessions-"));
		try {
			const project = join(root, "--home-me-project--");
			mkdirSync(project, { recursive: true });
			const lines = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "01a18b5a-f61e-7666-9a41-eeaf9490496f",
					timestamp: "2026-06-10T10:00:00.000Z",
					cwd: "/home/me/project",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-06-10T10:00:05.000Z",
					message: {
						role: "assistant",
						provider: "zai",
						model: "glm-4.6",
						usage: {
							input: 1000,
							output: 500,
							cacheRead: 2000,
							cacheWrite: 0,
							totalTokens: 3500,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
						},
					},
				}),
			];
			writeFileSync(join(project, "2026-06-10T10-00-00-000Z_01a18b5a.jsonl"), `${lines.join("\n")}\n`);
			writeFileSync(join(root, "top-level.jsonl"), `${lines.join("\n")}\n`);

			const files = loadYearSessions(root);
			expect(files).toHaveLength(2);
			const stats = gatherStats(files, NOW);
			expect(stats.sessions).toBe(2);
			expect(stats.tokens).toBe(7000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns nothing for a missing directory", () => {
		expect(loadYearSessions(join(tmpdir(), "does-not-exist-stats"))).toEqual([]);
	});
});

describe("generalizeModelName", () => {
	it("drops provider prefixes and date stamps", () => {
		expect(generalizeModelName("anthropic", "claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5");
		expect(generalizeModelName("anthropic", "claude-opus-4-1")).toBe("Claude Opus 4.1");
		expect(generalizeModelName("openrouter", "qwen/qwen3-coder")).toBe("Qwen3 Coder");
		expect(generalizeModelName("moonshot", "kimi-k2-0905")).toBe("Kimi K2");
	});

	it("uses the acronym table", () => {
		expect(generalizeModelName("zai", "glm-4.6")).toBe("GLM-4.6");
		expect(generalizeModelName("openai", "gpt-5-codex")).toBe("GPT-5 Codex");
		expect(generalizeModelName("openai", "gpt-5.1-codex-max")).toBe("GPT-5.1 Codex Max");
		expect(generalizeModelName("deepseek", "deepseek-reasoner")).toBe("DeepSeek Reasoner");
	});

	it("falls back to the provider when the model name is empty", () => {
		expect(generalizeModelName("zai", "")).toBe("Zai");
	});
});

describe("models in the summary", () => {
	it("sums tokens per model and merges generalized names", () => {
		const entries: FileEntry[] = [
			{
				type: "message",
				id: "a",
				parentId: null,
				timestamp: "2026-06-10T10:00:00Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet-4-5-20250929",
					usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			} as unknown as FileEntry,
			{
				type: "message",
				id: "b",
				parentId: null,
				timestamp: "2026-06-11T10:00:00Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			} as unknown as FileEntry,
			{
				type: "message",
				id: "c",
				parentId: null,
				timestamp: "2026-06-12T10:00:00Z",
				message: {
					role: "assistant",
					provider: "zai",
					model: "glm-4.6",
					usage: { input: 8000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			} as unknown as FileEntry,
		];
		const stats = gatherStats([entries], NOW);
		expect(stats.models).toEqual([
			{ name: "GLM-4.6", tokens: 8000 },
			{ name: "Claude Sonnet 4.5", tokens: 1500 },
		]);
	});

	it("renders the model section with bars and shares", () => {
		const entries: FileEntry[] = [
			{
				type: "message",
				id: "a",
				parentId: null,
				timestamp: "2026-06-10T10:00:00Z",
				message: {
					role: "assistant",
					provider: "zai",
					model: "glm-4.6",
					usage: { input: 750_000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			} as unknown as FileEntry,
			{
				type: "message",
				id: "b",
				parentId: null,
				timestamp: "2026-06-11T10:00:00Z",
				message: {
					role: "assistant",
					provider: "deepseek",
					model: "deepseek-chat",
					usage: { input: 250_000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			} as unknown as FileEntry,
		];
		const screen = createStatsScreen(gatherStats([entries], NOW), plainTheme(), () => {}, {
			tui: { terminal: { rows: 40 } } as never,
		});
		const lines = screen.render(80);
		const section = lines.findIndex((line) => line.includes("Models"));
		expect(section).toBeGreaterThan(-1);
		expect(lines[section + 1]).toContain("GLM-4.6");
		expect(lines[section + 1]).toContain("750.0K");
		expect(lines[section + 1]).toContain("75%");
		expect(lines[section + 1]).toContain("█");
		expect(lines[section + 2]).toContain("DeepSeek Chat");
		expect(lines[section + 2]).toContain("25%");
	});
});

describe("synthetic providers", () => {
	it("ignores faux test sessions in tokens, models and session count", () => {
		const real: FileEntry[] = [
			{
				type: "message",
				id: "r1",
				parentId: null,
				timestamp: "2026-06-10T10:00:00Z",
				message: {
					role: "assistant",
					provider: "zai",
					model: "glm-4.6",
					usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			} as unknown as FileEntry,
			{
				type: "message",
				id: "r2",
				parentId: null,
				timestamp: "2026-06-10T10:00:05Z",
				message: { role: "user" },
			} as unknown as FileEntry,
		];
		const fake: FileEntry[] = [
			{
				type: "model_change",
				id: "f0",
				parentId: null,
				timestamp: "2026-06-10T11:00:00Z",
				provider: "faux",
			} as unknown as FileEntry,
			{
				type: "message",
				id: "f1",
				parentId: null,
				timestamp: "2026-06-10T11:00:01Z",
				message: {
					role: "assistant",
					provider: "faux",
					model: "faux-1",
					usage: { input: 999_999, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			} as unknown as FileEntry,
		];
		const stats = gatherStats([real, fake], NOW);
		expect(stats.sessions).toBe(1);
		expect(stats.tokens).toBe(1000);
		expect(stats.models).toEqual([{ name: "GLM-4.6", tokens: 1000 }]);
		expect(stats.activeDays).toBe(1);
	});
});
