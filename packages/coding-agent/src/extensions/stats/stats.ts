import type { FileEntry } from "../../core/session-manager.ts";

export const DIGITS: Record<string, string[]> = {
	"0": ["111", "101", "101", "101", "111"],
	"1": ["010", "110", "010", "010", "111"],
	"2": ["111", "001", "111", "100", "111"],
	"3": ["111", "001", "111", "001", "111"],
	"4": ["101", "101", "111", "001", "001"],
	"5": ["111", "100", "111", "001", "111"],
	"6": ["111", "100", "111", "101", "111"],
	"7": ["111", "001", "010", "010", "010"],
	"8": ["111", "101", "111", "101", "111"],
	"9": ["111", "101", "111", "001", "111"],
	".": ["0", "0", "0", "0", "1"],
	K: ["101", "110", "100", "110", "101"],
	M: ["10001", "11011", "10101", "10001", "10001"],
	B: ["110", "101", "110", "101", "110"],
	T: ["111", "010", "010", "010", "010"],
};

export interface DayActivity {
	date: string;
	tokens: number;
}

export interface ModelUsageTotal {
	name: string;
	tokens: number;
}

export interface StatsSummary {
	from: number;
	to: number;
	tokens: number;
	sessions: number;
	activeDays: number;
	streak: number;
	activity: DayActivity[];
	models: ModelUsageTotal[];
}

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function entryTokens(entry: FileEntry): number {
	if (
		entry.type !== "message" &&
		entry.type !== "usage" &&
		entry.type !== "compaction" &&
		entry.type !== "branch_summary"
	) {
		return 0;
	}
	const usage = (entry as { usage?: UsageLike }).usage;
	if (usage) return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const message = (entry as { message?: { role: string; usage?: UsageLike } }).message;
	if (message?.usage)
		return message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
	return 0;
}

function localDayKey(time: number): string {
	const date = new Date(time);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function dayOrdinal(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	return Date.UTC(year, month - 1, day) / 86_400_000;
}

function bestStreak(days: Set<string>): number {
	const ordinals = [...days].map(dayOrdinal).sort((a, b) => a - b);
	let best = 0;
	let run = 0;
	let previous: number | undefined;
	for (const ordinal of ordinals) {
		run = previous !== undefined && ordinal - previous === 1 ? run + 1 : 1;
		best = Math.max(best, run);
		previous = ordinal;
	}
	return best;
}

const ACRONYMS: Record<string, string> = {
	gpt: "GPT",
	glm: "GLM",
	llm: "LLM",
	api: "API",
	tts: "TTS",
	vl: "VL",
	it: "IT",
	oss: "OSS",
	minimax: "MiniMax",
	deepseek: "DeepSeek",
	qwen: "Qwen",
	kimi: "Kimi",
	mimo: "MiMo",
	grok: "Grok",
	gemini: "Gemini",
	llama: "Llama",
	claude: "Claude",
	codex: "Codex",
	flash: "Flash",
	pro: "Pro",
	lite: "Lite",
	air: "Air",
	mini: "Mini",
	max: "Max",
	turbo: "Turbo",
	chat: "Chat",
	instruct: "Instruct",
	reasoner: "Reasoner",
	preview: "Preview",
	nano: "Nano",
};

/** Human-readable model name: no provider prefix, no date stamp, no separators. */
export function generalizeModelName(provider: string, model: string): string {
	const base = model.includes("/") ? (model.split("/").pop() ?? model) : model;
	const withoutDate = base
		.replace(/[-_]\d{8}$/, "")
		.replace(/-\d{4}-\d{2}-\d{2}$/, "")
		.replace(/[-_]\d{4}-\d{2}$/, "")
		.replace(/-0\d{3}$/, "");
	const parts = withoutDate.split(/[-_]+/).filter(Boolean);
	const nameParts: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		const next = parts[index + 1];
		const acronym = ACRONYMS[part.toLowerCase()];
		const isNumber = /^\d{1,2}$/.test(part);
		const isVersion = /^\d+(\.\d+)?$/.test(part);
		if (isNumber && next !== undefined && /^\d{1,2}$/.test(next)) {
			nameParts.push(`${part}.${next}`);
			index++;
			continue;
		}
		if (acronym) {
			nameParts.push(acronym);
			continue;
		}
		if (isVersion) {
			const previous = nameParts[nameParts.length - 1];
			if (previous !== undefined && !previous.endsWith(".")) {
				nameParts[nameParts.length - 1] = `${previous}-${part}`;
			} else {
				nameParts.push(part);
			}
			continue;
		}
		nameParts.push(part.charAt(0).toUpperCase() + part.slice(1));
	}
	const name = nameParts.join(" ").trim();
	if (name.length > 0) return name;
	const vendor = provider.split("/").pop() ?? provider;
	return vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

/** Providers that only exist in tests. Their sessions are not real usage. */
const SYNTHETIC_PROVIDERS: ReadonlySet<string> = new Set(["faux"]);

function entryProvider(entry: FileEntry): string | undefined {
	const provider = (entry as { provider?: unknown }).provider;
	if (typeof provider === "string") return provider;
	const message = (entry as { message?: { provider?: unknown } }).message;
	return typeof message?.provider === "string" ? message.provider : undefined;
}

function isSyntheticEntry(entry: FileEntry): boolean {
	const provider = entryProvider(entry);
	return provider !== undefined && SYNTHETIC_PROVIDERS.has(provider);
}

function modelKeyOf(entry: FileEntry): string | undefined {
	if (entry.type === "message") {
		const message = (entry as { message?: { role?: string; provider?: string; model?: string } }).message;
		if (message?.role !== "assistant" || !message.model) return undefined;
		return `${message.provider ?? ""}/${message.model}`;
	}
	if (entry.type === "usage") {
		const usageEntry = entry as { provider?: string; model?: string };
		if (!usageEntry.model) return undefined;
		return `${usageEntry.provider ?? ""}/${usageEntry.model}`;
	}
	return undefined;
}

export function gatherStats(files: FileEntry[][], now = Date.now()): StatsSummary {
	const year = new Date(now).getFullYear();
	const from = new Date(year, 0, 1).getTime();
	const tokensByDay = new Map<string, number>();
	const activeDaysSet = new Set<string>();
	const perModel = new Map<string, number>();
	let tokens = 0;
	let sessions = 0;

	for (const entries of files) {
		let sessionCounted = false;
		for (const entry of entries) {
			const time = Date.parse(entry.timestamp);
			if (!Number.isFinite(time) || time < from || time > now) continue;
			if (isSyntheticEntry(entry)) continue;
			// A session counts only when it holds a real model call, so headers and bookkeeping rows do not inflate it.
			const modelKey = modelKeyOf(entry);
			if (modelKey !== undefined && !sessionCounted) {
				sessionCounted = true;
				sessions++;
			}
			const key = localDayKey(time);
			activeDaysSet.add(key);
			const value = entryTokens(entry);
			if (value > 0) {
				tokens += value;
				tokensByDay.set(key, (tokensByDay.get(key) ?? 0) + value);
				if (modelKey) perModel.set(modelKey, (perModel.get(modelKey) ?? 0) + value);
			}
		}
	}

	const byName = new Map<string, number>();
	for (const [key, value] of perModel) {
		const separator = key.indexOf("/");
		const provider = separator === -1 ? "" : key.slice(0, separator);
		const model = separator === -1 ? key : key.slice(separator + 1);
		const name = generalizeModelName(provider, model);
		byName.set(name, (byName.get(name) ?? 0) + value);
	}

	return {
		from,
		to: now,
		tokens,
		sessions,
		activeDays: activeDaysSet.size,
		streak: bestStreak(activeDaysSet),
		activity: [...tokensByDay.entries()].map(([date, value]) => ({ date, tokens: value })),
		models: [...byName.entries()]
			.map(([name, value]) => ({ name, tokens: value }))
			.sort((a, b) => b.tokens - a.tokens),
	};
}

export function statsNumber(value: number): string {
	return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export interface CalendarCell {
	date: string;
	level: number;
}

export interface ActivityCalendar {
	weeks: CalendarCell[][];
	months: Array<{ label: string; span: number }>;
	clipped: boolean;
}

export function activityCalendar(input: {
	activity: DayActivity[];
	from: number;
	to: number;
	maxWeeks: number;
}): ActivityCalendar {
	const ordinal = (time: number) => {
		const date = new Date(time);
		return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
	};
	const from = ordinal(input.from);
	const to = ordinal(input.to - 1);
	const monday = from - ((new Date(from * 86_400_000).getUTCDay() + 6) % 7);
	const total = input.to <= input.from ? 0 : Math.floor((to - monday) / 7) + 1;
	const count = Math.min(total, 53, Math.max(1, Math.floor(input.maxWeeks)));
	const start = monday + Math.max(0, total - count) * 7;
	const stepsByDay = new Map(input.activity.filter((day) => day.tokens > 0).map((day) => [day.date, day.tokens]));
	const levels = [...new Set(stepsByDay.values())].sort((a, b) => a - b);
	const weeks = Array.from({ length: count }, (_, week) =>
		Array.from({ length: 7 }, (_, day) => {
			const date = start + week * 7 + day;
			const key = new Date(date * 86_400_000).toISOString().slice(0, 10);
			const steps = stepsByDay.get(key) ?? 0;
			return {
				date: key,
				level:
					date < from || date > to
						? -1
						: steps === 0
							? 0
							: Math.max(1, Math.ceil(((levels.indexOf(steps) + 1) / levels.length) * 4)),
			};
		}),
	);
	const formatter = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
	const months = weeks
		.map((_, week) => ({
			week,
			label: formatter.format(Math.min(to, Math.max(from, start + week * 7 + 3)) * 86_400_000),
		}))
		.filter((month, index, months) => index === 0 || month.label !== months[index - 1].label);
	return {
		weeks,
		months: months.map((month, index) => ({ ...month, span: (months[index + 1]?.week ?? count) - month.week })),
		clipped: count < total,
	};
}
