#!/usr/bin/env node
import { frame, keepAlive, readFrames, ready, statusResult } from "./harness.mjs";

ready();
readFrames((message) => {
	if (message.type === "shutdown") process.exit(0);
	if (message.type !== "request") return;
	frame(statusResult("never-issued"));
});
keepAlive();
