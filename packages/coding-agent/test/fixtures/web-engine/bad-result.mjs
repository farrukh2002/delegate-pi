#!/usr/bin/env node
import { keepAlive, readFrames, ready } from "./harness.mjs";

ready();
readFrames((message) => {
	if (message.type === "shutdown") process.exit(0);
	if (message.type !== "request") return;
	process.stdout.write(
		`${JSON.stringify({ type: "result", id: message.id, result: { engineVersion: 42, protocolVersion: 1, operations: ["status"] } })}\n`,
	);
});
keepAlive();
