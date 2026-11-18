#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { frame, keepAlive, logRequest, readFrames, ready, statusResult } from "./harness.mjs";

const stateFile = process.env.PI_WEB_TEST_STATE_FILE;
const firstLaunch = stateFile ? !existsSync(stateFile) : false;
if (stateFile && firstLaunch) writeFileSync(stateFile, "started\n");
const crashAfterReady = process.env.PI_WEB_TEST_CRASH_AFTER_READY === "1";

if (firstLaunch && !crashAfterReady) process.exit(23);
ready("0.1.0-crash");
readFrames((message) => {
	if (message.type === "shutdown") process.exit(0);
	if (message.type !== "request") return;
	logRequest(message.id);
	if (firstLaunch && crashAfterReady) process.exit(24);
	frame(statusResult(message.id, "0.1.0-crash"));
});
keepAlive();
