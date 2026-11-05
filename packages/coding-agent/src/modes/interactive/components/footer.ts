import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function spread(left: string, rights: string[], width: number): string {
	for (const right of rights) {
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap >= 2) return left + " ".repeat(gap) + right;
	}
	const right = rights[rights.length - 1] ?? "";
	const leftRoom = width - visibleWidth(right) - 2;
	if (leftRoom < 16) return truncateToWidth(left, width, theme.fg("dim", "…"));
	const fitted = truncateToWidth(left, leftRoom, theme.fg("dim", "…"));
	return fitted + " ".repeat(Math.max(2, width - visibleWidth(fitted) - visibleWidth(right))) + right;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		return this.withExtensionStatuses([this.renderLocationLine(width), this.renderStatsLine(width)], width);
	}

	private renderLocationLine(width: number): string {
		const state = this.session.state;
		const pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		const sessionName = this.session.sessionManager.getSessionName();
		const left =
			theme.fg("muted", pwd) +
			(branch ? `  ${theme.fg("accent", branch)}` : "") +
			(sessionName ? theme.fg("dim", ` • ${sanitizeStatusText(sessionName)}`) : "");

		let model = state.model?.id || "no-model";
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			model += theme.fg("dim", thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`);
		}
		const routed = this.session.routedModel;
		if (routed) {
			model += theme.fg("dim", ` → ${routed.model.id}${routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : ""}`);
		}
		const rights =
			this.footerData.getAvailableProviderCount() > 1 && state.model
				? [`${theme.fg("dim", `(${state.model.provider})`)} ${model}`, model]
				: [model];
		return spread(left, rights, width);
	}

	private renderStatsLine(width: number): string {
		const state = this.session.state;
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const known = contextUsage?.percent !== null;
		const percent = Math.min(100, Math.max(0, contextUsage?.percent ?? 0));
		const color = percent > 90 ? "error" : percent > 70 ? "warning" : "success";
		const barWidth = width >= 100 ? 14 : width >= 70 ? 10 : 6;
		const filled = known ? Math.round((percent / 100) * barWidth) : 0;
		const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
		const label = (text: string) => theme.fg("dim", text);
		const value = (text: string) => theme.fg("muted", text);

		const segments: Array<{ text: string; priority: number }> = [
			{
				text: `${label("ctx")} ${bar} ${theme.fg(color, known ? `${percent.toFixed(1)}%` : "?")}${label(` of ${formatTokens(contextWindow)}${this.autoCompactEnabled ? " auto" : ""}`)}`,
				priority: 0,
			},
		];
		if (usageTotals.input)
			segments.push({ text: `${label("in")} ${value(formatTokens(usageTotals.input))}`, priority: 2 });
		if (usageTotals.output) {
			segments.push({ text: `${label("out")} ${value(formatTokens(usageTotals.output))}`, priority: 2 });
		}
		if (usageTotals.cacheRead) {
			segments.push({ text: `${label("cached")} ${value(formatTokens(usageTotals.cacheRead))}`, priority: 4 });
		}
		if (usageTotals.cacheWrite) {
			segments.push({ text: `${label("written")} ${value(formatTokens(usageTotals.cacheWrite))}`, priority: 5 });
		}
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			segments.push({ text: `${label("hit")} ${value(`${latestCacheHitRate.toFixed(1)}%`)}`, priority: 3 });
		}
		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			segments.push({
				text: theme.fg("accent", `$${usageTotals.cost.toFixed(3)}`) + (usingSubscription ? label(" sub") : ""),
				priority: 1,
			});
		}
		if (areExperimentalFeaturesEnabled()) segments.push({ text: theme.bold(theme.fg("warning", "xp")), priority: 1 });

		const join = () => segments.map((part) => part.text).join("   ");
		while (segments.length > 1 && visibleWidth(join()) > width) {
			const lowest = Math.max(...segments.map((part) => part.priority));
			segments.splice(
				segments.findLastIndex((part) => part.priority === lowest),
				1,
			);
		}
		return truncateToWidth(join(), width, theme.fg("dim", "…"));
	}

	private withExtensionStatuses(lines: string[], width: number): string[] {
		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
