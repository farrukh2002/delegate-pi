export type ProviderId = "pi" | "claude" | "codex" | "commandcode";

export type RuntimeMode = "inherit" | "full-access" | "approval-required";

export interface UsageDelta {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	contextTokens?: number;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
	costEstimated: boolean;
}

type ContentPart =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; arguments: Record<string, unknown> };

export type ChildEvent =
	| {
			kind: "message";
			id?: string;
			role: "assistant" | "user";
			content: ContentPart[];
			usage?: UsageDelta;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
	  }
	| { kind: "cost"; costUsd: number }
	| { kind: "info"; text: string };

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, costEstimated: false };
}
