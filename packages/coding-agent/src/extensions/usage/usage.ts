import type { SessionEntry } from "../../core/session-manager.ts";

export interface ModelUsageEntry {
	key: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	cost: number;
}

export interface SessionUsageSummary {
	rows: ModelUsageEntry[];
	totalCost: number;
	messages: number;
	models: number;
}

function createRow(key: string): ModelUsageEntry {
	return {
		key,
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		cost: 0,
	};
}

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

function addUsage(row: ModelUsageEntry, usage: UsageLike): void {
	row.input += usage.input;
	row.output += usage.output;
	row.cacheRead += usage.cacheRead;
	row.cacheWrite += usage.cacheWrite;
	row.costInput += usage.cost.input;
	row.costOutput += usage.cost.output;
	row.costCacheRead += usage.cost.cacheRead;
	row.costCacheWrite += usage.cost.cacheWrite;
	row.cost += usage.cost.total;
}

export function aggregateSessionUsage(entries: SessionEntry[]): SessionUsageSummary {
	const rows = new Map<string, ModelUsageEntry>();
	let messages = 0;

	const row = (key: string): ModelUsageEntry => {
		let value = rows.get(key);
		if (!value) {
			value = createRow(key);
			rows.set(key, value);
		}
		return value;
	};

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			messages++;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage as UsageLike | undefined;
			if (usage) {
				const target = row(`${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`);
				target.requests++;
				addUsage(target, usage);
			}
			continue;
		}
		if (entry.type === "usage") {
			const usage = entry.usage as UsageLike;
			addUsage(row(`${entry.provider}/${entry.model}`), usage);
			continue;
		}
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			addUsage(row("Tools/summaries"), entry.message.usage as UsageLike);
			continue;
		}
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(row("Tools/summaries"), entry.usage as UsageLike);
		}
	}

	const list = [...rows.values()].sort((a, b) => b.cost - a.cost);
	return {
		rows: list,
		totalCost: list.reduce((sum, item) => sum + item.cost, 0),
		messages,
		models: list.filter((item) => item.key !== "Tools/summaries").length,
	};
}

export function formatDollars(value: number): string {
	if (value > 0 && value < 0.01) return "<$0.01";
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
		maximumFractionDigits: 2,
	}).format(value);
}

export function formatTokens(num: number): string {
	if (num >= 999_950) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
	return String(num);
}

export type SpendLevel = "dominant" | "high" | "normal";

export function spendLevel(cost: number, totalCost: number): SpendLevel {
	if (totalCost <= 0) return "normal";
	if (cost / totalCost >= 0.8) return "dominant";
	if (cost / totalCost >= 0.5) return "high";
	return "normal";
}
