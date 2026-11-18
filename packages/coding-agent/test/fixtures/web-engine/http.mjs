#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { frame, keepAlive, readFrames, ready, statusResult } from "./harness.mjs";

const delays = (process.env.PI_WEB_TEST_DELAYS ?? "")
	.split(",")
	.map((value) => (value.length === 0 ? 0 : Number(value)));
const holdFirst = process.env.PI_WEB_TEST_HOLD === "1";
const requestLog = process.env.PI_WEB_TEST_REQUEST_LOG;
const errorCode = process.env.PI_WEB_TEST_HTTP_ERROR_CODE;
const resultText = process.env.PI_WEB_TEST_HTTP_RESULT;
let requestCount = 0;

function logRequest(message) {
	if (requestLog) appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
}

function defaultResult(message) {
	return {
		url: message.params?.url ?? "http://example.test/items",
		status: 200,
		headers: { "content-type": "application/json" },
		body: '{"name":"example"}',
		truncated: false,
		bytesReceived: 18,
		missingPointers: [],
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
			frame(statusResult(message.id));
			return;
		}
		if (message.operation !== "http_request") {
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
