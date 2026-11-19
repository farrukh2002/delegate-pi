import type {
	WebEngineFetchAccess,
	WebEngineGitIndexStatus,
	WebEngineGitReadStatus,
	WebEngineGitSearchStatus,
	WebEngineSearchStatus,
} from "../../core/web/client.ts";

export type WebToolSummary =
	| { kind: "fetch"; status: number; access: WebEngineFetchAccess; truncated: boolean }
	| { kind: "http"; status: number; truncated: boolean }
	| { kind: "search"; status: WebEngineSearchStatus; count: number; truncated: boolean }
	| { kind: "git_index"; status: WebEngineGitIndexStatus; filesIndexed: number }
	| { kind: "git_search"; status: WebEngineGitSearchStatus; count: number; partial: boolean; truncated: boolean }
	| {
			kind: "git_read";
			status: WebEngineGitReadStatus;
			startLine: number;
			endLine: number;
			totalLines: number;
			truncated: boolean;
	  };
