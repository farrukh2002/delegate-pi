#!/usr/bin/env node
import { keepAlive } from "./harness.mjs";

const delay = Number(process.env.PI_WEB_TEST_READY_DELAY_MS ?? "300");
setTimeout(() => {
	process.stdout.write(
		`${JSON.stringify({ type: "ready", protocolVersion: 1, engineVersion: "0.1.0-late" })}\n`,
	);
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
			process.stdout.write(
				`${JSON.stringify({ type: "result", id: message.id, result: { engineVersion: "0.1.0-late", protocolVersion: 1, operations: ["status"] } })}\n`,
			);
		}
	});
	process.stdin.resume();
}, delay);
keepAlive();
