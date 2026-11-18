#!/usr/bin/env node
import { frame, keepAlive, logRequest, readFrames, ready, statusResult } from "./harness.mjs";

const delays = (process.env.PI_WEB_TEST_DELAYS ?? "")
	.split(",")
	.map((value) => (value.length === 0 ? 0 : Number(value)));
const holdFirst = process.env.PI_WEB_TEST_HOLD === "1";
const ignoreShutdown = process.env.PI_WEB_TEST_IGNORE_SHUTDOWN === "1";
const errorCode = process.env.PI_WEB_TEST_ERROR_CODE;
let requestCount = 0;

if (process.env.PI_WEB_TEST_STDERR === "1") {
	process.stderr.write("secret diagnostic output\n".repeat(2_000));
}

ready();
readFrames((message) => {
	if (message.type === "shutdown") {
		if (!ignoreShutdown) process.exit(0);
		return;
	}
	if (message.type === "cancel") {
		frame({ type: "error", id: message.id, code: "cancelled", message: "Request cancelled" });
		return;
	}
	if (message.type !== "request") return;
	const index = requestCount++;
	logRequest(message.id);
	if (holdFirst && index === 0) return;
	const respond = () => {
		if (errorCode) {
			frame({ type: "error", id: message.id, code: errorCode, message: "Injected failure" });
			return;
		}
		frame(statusResult(message.id));
	};
	const delay = delays[index];
	if (delay > 0) setTimeout(respond, delay);
	else respond();
});
keepAlive();
