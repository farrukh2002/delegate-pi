#!/usr/bin/env node
import { appendFileSync } from "node:fs";

export function frame(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function ready(engineVersion = "0.1.0-test", protocolVersion = 1) {
	frame({ type: "ready", protocolVersion, engineVersion });
}

export function statusResult(id, engineVersion = "0.1.0-test", operations = ["status"]) {
	return { type: "result", id, result: { engineVersion, protocolVersion: 1, operations } };
}

export function logRequest(id) {
	const path = process.env.PI_WEB_TEST_REQUEST_LOG;
	if (path) appendFileSync(path, `${id}\n`);
}

export function readFrames(onFrame) {
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
			try {
				onFrame(JSON.parse(line));
			} catch {}
		}
	});
	process.stdin.resume();
}

export function keepAlive() {
	setInterval(() => {}, 1_000);
}
