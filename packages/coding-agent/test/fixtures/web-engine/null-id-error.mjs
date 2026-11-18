#!/usr/bin/env node
import { keepAlive, readFrames, ready } from "./harness.mjs";

ready();
readFrames((message) => {
	if (message.type === "shutdown") process.exit(0);
	if (message.type !== "request") return;
	process.stdout.write(`${JSON.stringify({ type: "error", id: null, code: "invalid_request", message: "bad frame" })}\n`);
});
keepAlive();
