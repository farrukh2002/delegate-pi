#!/usr/bin/env node
import { keepAlive, readFrames, ready } from "./harness.mjs";

ready();
readFrames((message) => {
	if (message.type === "shutdown") process.exit(0);
	if (message.type !== "request") return;
	process.stdout.end();
});
keepAlive();
