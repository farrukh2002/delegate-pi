import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, valid } from "semver";
import { RELEASE_REPOSITORY } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export type InstallChannel = "stable" | "rc" | "dev";

export function installHome(): string {
	const configured = process.env.DELEGATE_PI_HOME?.trim();
	return configured ? configured : join(homedir(), ".delegate-pi");
}

export function installedChannel(): InstallChannel {
	try {
		const value = readFileSync(join(installHome(), "channel"), "utf8").trim();
		if (value === "dev" || value === "rc") return value;
	} catch {}
	return "stable";
}

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;
	if (RELEASE_REPOSITORY) return getLatestRepositoryRelease(RELEASE_REPOSITORY, currentVersion, options);

	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

async function getLatestRepositoryRelease(
	repository: string,
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean },
): Promise<LatestPiRelease | undefined> {
	const response = await fetchWithRetry(
		`https://api.github.com/repos/${repository}/releases/latest`,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/vnd.github+json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;
	const data = (await response.json()) as { tag_name?: unknown };
	if (typeof data.tag_name !== "string") return undefined;
	const version = data.tag_name.trim().replace(/^v/, "");
	return version ? { version } : undefined;
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

interface ChannelRelease {
	version: string;
	commit?: string;
}

async function getRepositoryReleaseByTag(
	repository: string,
	tag: string,
	currentVersion: string,
): Promise<ChannelRelease | undefined> {
	const response = await fetchWithRetry(
		`https://api.github.com/repos/${repository}/releases/tags/${tag}`,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/vnd.github+json",
			},
		},
		{ maxRetries: 0, timeoutMs: DEFAULT_VERSION_CHECK_TIMEOUT_MS },
	);
	if (!response.ok) return undefined;
	const data = (await response.json()) as { tag_name?: unknown; name?: unknown; target_commitish?: unknown };
	const tagName = typeof data.tag_name === "string" ? data.tag_name.trim().replace(/^v/, "") : "";
	const title = typeof data.name === "string" ? data.name.trim().replace(/^delegate-pi\s+/, "") : "";
	const version = valid(title) ? title : valid(tagName) ? tagName : undefined;
	if (!version) return undefined;
	const commit = typeof data.target_commitish === "string" ? data.target_commitish.trim() : undefined;
	return { version, ...(commit ? { commit } : {}) };
}

async function getNewestReleaseCandidate(repository: string, currentVersion: string): Promise<string | undefined> {
	const response = await fetchWithRetry(
		`https://api.github.com/repos/${repository}/releases?per_page=50`,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/vnd.github+json",
			},
		},
		{ maxRetries: 0, timeoutMs: DEFAULT_VERSION_CHECK_TIMEOUT_MS },
	);
	if (!response.ok) return undefined;
	const list = (await response.json()) as Array<{ tag_name?: unknown }>;
	for (const item of Array.isArray(list) ? list : []) {
		const tag = typeof item.tag_name === "string" ? item.tag_name.trim() : "";
		if (!/-rc\.\d+$/.test(tag)) continue;
		const version = tag.replace(/^v/, "");
		if (valid(version)) return version;
	}
	return undefined;
}

async function checkChannelRelease(
	repository: string,
	channel: InstallChannel,
	currentVersion: string,
): Promise<LatestPiRelease | undefined> {
	if (channel === "dev") {
		const release = await getRepositoryReleaseByTag(repository, "dev", currentVersion);
		if (!release) return undefined;
		const sha = /-dev\.([0-9a-f]{7,40})$/.exec(currentVersion.trim())?.[1];
		if (release.commit && sha) {
			return release.commit.startsWith(sha) ? undefined : { version: release.version };
		}
		return release.version === currentVersion.trim() ? undefined : { version: release.version };
	}
	const version = await getNewestReleaseCandidate(repository, currentVersion);
	if (!version) return undefined;
	return isNewerPackageVersion(version, currentVersion) ? { version } : undefined;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		if (RELEASE_REPOSITORY) {
			const channel = installedChannel();
			if (channel !== "stable") {
				return (await checkChannelRelease(RELEASE_REPOSITORY, channel, currentVersion)) ?? undefined;
			}
		}
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
