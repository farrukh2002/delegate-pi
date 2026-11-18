#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { frame, keepAlive, readFrames, ready, statusResult } from "./harness.mjs";

const delays = (process.env.PI_WEB_TEST_DELAYS ?? "")
	.split(",")
	.map((value) => (value.length === 0 ? 0 : Number(value)));
const holdFirst = process.env.PI_WEB_TEST_HOLD === "1";
const requestLog = process.env.PI_WEB_TEST_REQUEST_LOG;
const errorCode = process.env.PI_WEB_TEST_GIT_ERROR_CODE;
const indexResultText = process.env.PI_WEB_TEST_GIT_INDEX_RESULT;
const searchResultText = process.env.PI_WEB_TEST_GIT_SEARCH_RESULT;
const readResultText = process.env.PI_WEB_TEST_GIT_READ_RESULT;
const INDEX_ID = "0123456789abcdef".repeat(4);
const COMMIT = "b".repeat(40);
let requestCount = 0;

function logRequest(message) {
	if (requestLog) appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
}

function defaultIndexResult(message) {
	const scope = message.params?.scope ?? "worktree";
	return {
		indexId: INDEX_ID,
		source: message.params?.source ?? ".",
		scope,
		revision: scope === "worktree" ? null : (message.params?.revision ?? "HEAD"),
		resolvedCommit: scope === "worktree" ? null : COMMIT,
		status: "ok",
		filesIndexed: scope === "history" ? 3 : 2,
		bytesIndexed: 42,
		commitsVisited: scope === "history" ? 4 : 1,
		downloadBytes: 0,
		skipped: {
			binary: 0,
			large: 0,
			nonUtf8: 0,
			unsafePath: 0,
			unreadable: 0,
			submodule: 0,
			duplicate: 0,
		},
		limitsReached: [],
		indexedAt: 1700000000,
	};
}

function defaultSearchResult(message) {
	return {
		indexId: message.params?.indexId ?? INDEX_ID,
		query: message.params?.query ?? "answer",
		status: "ok",
		results: [
			{
				path: "src/lib.rs",
				revision: null,
				line: 1,
				column: 1,
				snippet: "pub fn answer() -> u32 { 42 }",
			},
		],
		partial: false,
		truncated: false,
	};
}

function defaultReadResult(message) {
	const startLine = message.params?.startLine ?? 1;
	return {
		indexId: message.params?.indexId ?? INDEX_ID,
		path: message.params?.path ?? "src/lib.rs",
		revision: message.params?.revision ?? null,
		status: "ok",
		startLine,
		startColumn: message.params?.startColumn ?? 1,
		endLine: startLine,
		totalLines: 1,
		content: "pub fn answer() -> u32 { 42 }\n",
		truncated: false,
		next: null,
	};
}

ready();
readFrames((message) => {
	if (message.type === "shutdown") process.exit(0);
	if (message.type === "cancel") {
		frame({ type: "error", id: message.id, code: "cancelled", message: "Request cancelled" });
		return;
	}
	if (message.type !== "request") return;
	const index = requestCount++;
	logRequest(message);
	if (holdFirst && index === 0) return;
	const respond = () => {
		if (message.operation === "status") {
			frame(statusResult(message.id, undefined, ["status", "git_index", "git_search", "git_read"]));
			return;
		}
		if (
			message.operation !== "git_index" &&
			message.operation !== "git_search" &&
			message.operation !== "git_read"
		) {
			frame({ type: "error", id: message.id, code: "unsupported_operation", message: "Unsupported operation" });
			return;
		}
		if (errorCode) {
			frame({ type: "error", id: message.id, code: errorCode, message: "Injected failure" });
			return;
		}
		const override =
			message.operation === "git_index"
				? indexResultText
				: message.operation === "git_search"
					? searchResultText
					: readResultText;
		const result =
			message.operation === "git_index"
				? defaultIndexResult(message)
				: message.operation === "git_search"
					? defaultSearchResult(message)
					: defaultReadResult(message);
		frame({ type: "result", id: message.id, result: override ? JSON.parse(override) : result });
	};
	const delay = delays[index];
	if (delay > 0) setTimeout(respond, delay);
	else respond();
});
keepAlive();
