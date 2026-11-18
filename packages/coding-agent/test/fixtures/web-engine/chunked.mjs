#!/usr/bin/env node
import { keepAlive, statusResult } from "./harness.mjs";

const version = "é✓-0.1.0";
const readyBytes = Buffer.from(
	`${JSON.stringify({ type: "ready", protocolVersion: 1, engineVersion: version })}\n`,
);
const readySplit = readyBytes.indexOf(Buffer.from(version)) + 1;
process.stdout.write(readyBytes.subarray(0, readySplit));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.length === 0) continue;
		const message = JSON.parse(line);
		if (message.type === "shutdown") process.exit(0);
		if (message.type !== "request") continue;
		const resultBytes = Buffer.from(`${JSON.stringify(statusResult(message.id, version))}\n`);
		const split = resultBytes.indexOf(Buffer.from(version)) + 1;
		process.stdout.write(resultBytes.subarray(0, split));
		setTimeout(() => process.stdout.write(resultBytes.subarray(split)), 10);
	}
});
process.stdin.resume();

setTimeout(() => process.stdout.write(readyBytes.subarray(readySplit)), 10);
keepAlive();
