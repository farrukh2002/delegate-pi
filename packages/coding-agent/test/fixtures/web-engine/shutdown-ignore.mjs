#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { frame, keepAlive, readFrames, ready, statusResult } from "./harness.mjs";

const pidFile = process.env.PI_WEB_TEST_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));
ready("0.1.0-stubborn");
readFrames((message) => {
	if (message.type !== "request") return;
	frame(statusResult(message.id, "0.1.0-stubborn"));
});
keepAlive();
