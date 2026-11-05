import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createUsageScreen } from "../src/extensions/usage/index.ts";
import { fetchProviderUsage, parseDeepSeekBalance, parseZaiQuota } from "../src/extensions/usage/providers.ts";
import { aggregateSessionUsage, formatDollars, formatTokens, spendLevel } from "../src/extensions/usage/usage.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: {
			input: cost / 4,
			output: cost / 4,
			cacheRead: cost / 4,
			cacheWrite: cost / 4,
			total: cost,
		},
	};
}

function assistantEntry(provider: string, model: string, cost: number): SessionEntry {
	return {
		type: "message",
		id: `a-${provider}-${model}-${cost}`,
		time: { created: 0, updated: 0 },
		message: {
			role: "assistant",
			provider,
			model,
			usage: usage(1000, 500, 20000, 2000, cost),
		},
	} as unknown as SessionEntry;
}

function userEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		time: { created: 0, updated: 0 },
		message: { role: "user" },
	} as unknown as SessionEntry;
}

describe("usage formatters", () => {
	it("formats dollars like opencode", () => {
		expect(formatDollars(0.004)).toBe("<$0.01");
		expect(formatDollars(1.236)).toBe("$1.24");
		expect(formatDollars(3)).toBe("$3");
	});

	it("formats token counts with K and M", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1500)).toBe("1.5K");
		expect(formatTokens(1_250_000)).toBe("1.3M");
	});

	it("grades spend levels by share of the session", () => {
		expect(spendLevel(0.9, 1)).toBe("dominant");
		expect(spendLevel(0.6, 1)).toBe("high");
		expect(spendLevel(0.3, 1)).toBe("normal");
		expect(spendLevel(1, 0)).toBe("normal");
	});
});

describe("aggregateSessionUsage", () => {
	it("groups usage per model and counts messages", () => {
		const entries: SessionEntry[] = [
			userEntry("u1"),
			assistantEntry("anthropic", "claude-sonnet-4.5", 1),
			userEntry("u2"),
			assistantEntry("anthropic", "claude-sonnet-4.5", 0.5),
			assistantEntry("openai", "gpt-5", 0.2),
		];
		const summary = aggregateSessionUsage(entries);
		expect(summary.messages).toBe(2);
		expect(summary.models).toBe(2);
		expect(summary.totalCost).toBeCloseTo(1.7);
		expect(summary.rows[0].key).toBe("anthropic/claude-sonnet-4.5");
		expect(summary.rows[0].requests).toBe(2);
		expect(summary.rows[0].input).toBe(2000);
		expect(summary.rows[0].cacheRead).toBe(40000);
	});

	it("collects tool and summary usage separately", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "t1",
				time: { created: 0, updated: 0 },
				message: { role: "toolResult", usage: usage(10, 20, 0, 0, 0.02) },
			} as unknown as SessionEntry,
		];
		const summary = aggregateSessionUsage(entries);
		expect(summary.rows).toHaveLength(1);
		expect(summary.rows[0].key).toBe("Tools/summaries");
		expect(summary.rows[0].cost).toBeCloseTo(0.02);
		expect(summary.models).toBe(0);
	});

	it("returns an empty summary without entries", () => {
		const summary = aggregateSessionUsage([]);
		expect(summary.rows).toEqual([]);
		expect(summary.totalCost).toBe(0);
	});
});

function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		style: (text: string) => text,
		bold: (text: string) => `**${text}**`,
	} as unknown as Theme;
}

describe("usage screen", () => {
	const entries: SessionEntry[] = [
		userEntry("u1"),
		assistantEntry("anthropic", "claude-sonnet-4.5", 1),
		assistantEntry("openai", "gpt-5", 0.2),
	];

	beforeAll(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders the list with totals", () => {
		const screen = createUsageScreen(entries, plainTheme(), () => {}, {});
		const lines = screen.render(60);
		expect(lines[0]).toBe("Usage");
		expect(lines[1]).toContain("Session this session · 1 messages · 2 models");
		const listLine = lines.find((line) => line.includes("claude-sonnet-4.5"));
		expect(listLine).toContain("$1");
		expect(listLine).toContain("▸");
		expect(lines.some((line) => line.includes("Total"))).toBe(true);
	});

	it("renders the detail view after enter", () => {
		const screen = createUsageScreen(entries, plainTheme(), () => {}, {});
		screen.handleInput("\r");
		const lines = screen.render(60);
		expect(lines[0]).toContain("Usage › anthropic/claude-sonnet-4.5");
		expect(lines.some((line) => line.includes("spent"))).toBe(true);
		expect(lines.some((line) => line.includes("input tokens"))).toBe(true);
		expect(lines.some((line) => line.includes("cache read tokens"))).toBe(true);
	});

	it("closes on escape and goes back from detail", () => {
		let closed = 0;
		const screen = createUsageScreen(entries, plainTheme(), () => closed++, {});
		screen.handleInput("\x1b");
		expect(closed).toBe(1);
		screen.handleInput("\r");
		screen.handleInput("\x1b");
		expect(closed).toBe(1);
		expect(screen.render(60)[0]).toBe("Usage");
	});
});

describe("provider usage", () => {
	const zaiPayload = {
		code: 200,
		data: {
			level: "lite",
			limits: [
				{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 25, remaining: 75, percentage: 25 },
				{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 60 },
			],
		},
	};

	it("parses z.ai quota limits", () => {
		const usage = parseZaiQuota(zaiPayload);
		expect(usage.kind).toBe("windows");
		if (usage.kind !== "windows") return;
		expect(usage.plan).toBe("lite");
		expect(usage.windows).toEqual([
			{ label: "prompt limit", percent: 25, resetsAt: undefined },
			{ label: "token limit", percent: 60, resetsAt: undefined },
		]);
	});

	it("rejects a malformed z.ai payload", () => {
		expect(parseZaiQuota({ code: 500 }).kind).toBe("unavailable");
	});

	it("parses the DeepSeek balance", () => {
		const usage = parseDeepSeekBalance({
			is_available: true,
			balance_infos: [{ currency: "USD", total_balance: "23.28" }],
		});
		expect(usage.kind).toBe("balance");
		if (usage.kind !== "balance") return;
		expect(usage.items).toEqual([{ currency: "USD", total: 23.28 }]);
	});

	it("reports missing credentials without a request", async () => {
		let called = 0;
		const fake = (async () => {
			called++;
			return { ok: true, status: 200, json: async () => ({}) };
		}) as never;
		const usage = await fetchProviderUsage("zai", undefined, fake);
		expect(usage.kind).toBe("unavailable");
		expect(called).toBe(0);
	});

	it("reports an HTTP failure", async () => {
		const fake = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as never;
		const usage = await fetchProviderUsage("zai", { key: "k" }, fake);
		expect(usage.kind).toBe("unavailable");
		if (usage.kind !== "unavailable") return;
		expect(usage.reason).toBe("HTTP 401");
	});

	it("returns parsed data on success", async () => {
		const fake = (async () => ({ ok: true, status: 200, json: async () => zaiPayload })) as never;
		const usage = await fetchProviderUsage("zai", { key: "k" }, fake);
		expect(usage.kind).toBe("windows");
	});
});
