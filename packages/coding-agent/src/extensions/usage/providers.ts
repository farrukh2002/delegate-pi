import { readStoredCredential } from "../../core/auth-storage.ts";

export interface UsageWindow {
	label: string;
	percent: number;
	resetsAt?: number;
}

export type ProviderUsage =
	| { kind: "windows"; provider: string; label: string; plan?: string; windows: UsageWindow[] }
	| { kind: "balance"; provider: string; label: string; items: Array<{ currency: string; total: number }> }
	| { kind: "unavailable"; provider: string; label: string; reason: string };

export type FetchLike = (
	url: string,
	init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

const TIMEOUT_MS = 6000;

function withTimeout(): AbortSignal | undefined {
	return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseZaiQuota(payload: unknown): ProviderUsage {
	const data = asRecord(asRecord(payload)?.data);
	const limits = data?.limits;
	const plan = typeof data?.level === "string" ? data.level : undefined;
	if (!Array.isArray(limits)) {
		return { kind: "unavailable", provider: "zai", label: "Z.AI", reason: "Unexpected response" };
	}
	const windows: UsageWindow[] = [];
	for (const raw of limits) {
		const limit = asRecord(raw);
		if (!limit) continue;
		const percentage = asNumber(limit.percentage);
		if (percentage === undefined) continue;
		const type = typeof limit.type === "string" ? limit.type : "";
		const label = type === "TIME_LIMIT" ? "prompt limit" : type === "TOKENS_LIMIT" ? "token limit" : "limit";
		windows.push({ label, percent: percentage, resetsAt: asNumber(limit.nextResetTime) });
	}
	if (windows.length === 0) {
		return { kind: "unavailable", provider: "zai", label: "Z.AI", reason: "No limits reported" };
	}
	return { kind: "windows", provider: "zai", label: "Z.AI", plan, windows };
}

export function parseDeepSeekBalance(payload: unknown): ProviderUsage {
	const record = asRecord(payload);
	const infos = record?.balance_infos;
	if (!Array.isArray(infos)) {
		return { kind: "unavailable", provider: "deepseek", label: "DeepSeek", reason: "Unexpected response" };
	}
	const items = infos
		.map((raw) => asRecord(raw))
		.filter((raw): raw is Record<string, unknown> => raw !== undefined)
		.map((raw) => ({
			currency: typeof raw.currency === "string" ? raw.currency : "USD",
			total: Number.parseFloat(String(raw.total_balance ?? "0")),
		}))
		.filter((item) => Number.isFinite(item.total));
	if (items.length === 0) {
		return { kind: "unavailable", provider: "deepseek", label: "DeepSeek", reason: "No balance reported" };
	}
	return { kind: "balance", provider: "deepseek", label: "DeepSeek", items };
}

interface CredentialLike {
	type?: string;
	key?: string;
	access?: string;
}

export async function fetchProviderUsage(
	provider: string,
	credential: CredentialLike | undefined,
	fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<ProviderUsage> {
	const label = provider === "zai" ? "Z.AI" : provider === "deepseek" ? "DeepSeek" : provider;
	if (!credential) {
		return { kind: "unavailable", provider, label, reason: "Not signed in" };
	}
	try {
		if (provider === "zai") {
			if (!credential.key) return { kind: "unavailable", provider, label, reason: "No API key" };
			const response = await fetchImpl("https://api.z.ai/api/monitor/usage/quota/limit", {
				headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
				signal: withTimeout(),
			});
			if (!response.ok) {
				return { kind: "unavailable", provider, label, reason: `HTTP ${response.status}` };
			}
			return parseZaiQuota(await response.json());
		}
		if (provider === "deepseek") {
			if (!credential.key) return { kind: "unavailable", provider, label, reason: "No API key" };
			const response = await fetchImpl("https://api.deepseek.com/user/balance", {
				headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
				signal: withTimeout(),
			});
			if (!response.ok) {
				return { kind: "unavailable", provider, label, reason: `HTTP ${response.status}` };
			}
			return parseDeepSeekBalance(await response.json());
		}
		return { kind: "unavailable", provider, label, reason: "No usage endpoint" };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Request failed";
		return { kind: "unavailable", provider, label, reason: message.slice(0, 40) };
	}
}

export const PROVIDER_ORDER = ["zai", "deepseek"] as const;

export async function collectProviderUsage(
	fetchImpl?: FetchLike,
	logins: ReadonlyArray<string> = PROVIDER_ORDER,
): Promise<ProviderUsage[]> {
	return Promise.all(
		logins.map((provider) => {
			const credential = readStoredCredential(provider) as CredentialLike | undefined;
			return fetchProviderUsage(provider, credential, fetchImpl);
		}),
	);
}
