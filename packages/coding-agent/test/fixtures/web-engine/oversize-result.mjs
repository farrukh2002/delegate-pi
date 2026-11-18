#!/usr/bin/env node
import { frame, keepAlive, readFrames, ready } from "./harness.mjs";

ready();
readFrames((message) => {
	if (message.type === "shutdown") process.exit(0);
	if (message.type !== "request") return;
	frame({
		type: "result",
		id: message.id,
		result: { engineVersion: "x".repeat(70_000), protocolVersion: 1, operations: ["status"] },
	});
});
keepAlive();
