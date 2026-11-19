#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { frame, keepAlive, readFrames, ready, statusResult } from "./harness.mjs";

const delays = (process.env.PI_WEB_TEST_DELAYS ?? "")
	.split(",")
	.map((value) => (value.length === 0 ? 0 : Number(value)));
const holdFirst = process.env.PI_WEB_TEST_HOLD === "1";
const requestLog = process.env.PI_WEB_TEST_REQUEST_LOG;
const errorCode = process.env.PI_WEB_TEST_SEARCH_ERROR_CODE;
const resultText = process.env.PI_WEB_TEST_SEARCH_RESULT;
let requestCount = 0;

function logRequest(message) {
	if (requestLog) appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
}

function defaultResult(message) {
	const result = {
		query: message.params?.query ?? "rust async",
		status: "ok",
		results: [
			{
				title: "Rust async book",
				url: "https://doc.rust-lang.org/book/ch17-00-async-await.html",
				snippet: "Asynchronous programming in Rust.",
				source: "exa",
			},
			{
				title: "Async Rust",
				url: "https://doc.rust-lang.org/async/",
				snippet: "Async support in the standard library.",
				source: "exa",
			},
		],
		attempts: [{ provider: "exa", status: "ok" }],
		truncated: false,
	};
	if (typeof message.params?.site === "string") result.site = message.params.site;
	return result;
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
			frame(statusResult(message.id, undefined, ["status", "web_search"]));
			return;
		}
		if (message.operation !== "web_search") {
			frame({ type: "error", id: message.id, code: "unsupported_operation", message: "Unsupported operation" });
			return;
		}
		if (errorCode) {
			frame({ type: "error", id: message.id, code: errorCode, message: "Injected failure" });
			return;
		}
		frame({ type: "result", id: message.id, result: resultText ? JSON.parse(resultText) : defaultResult(message) });
	};
	const delay = delays[index];
	if (delay > 0) setTimeout(respond, delay);
	else respond();
});
keepAlive();
