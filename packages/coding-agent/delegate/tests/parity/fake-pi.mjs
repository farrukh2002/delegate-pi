import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const self = path.dirname(fileURLToPath(import.meta.url));
const script = JSON.parse(fs.readFileSync(path.join(self, "script.json"), "utf8"));
const out = (value) => fs.writeSync(1, `${JSON.stringify(value)}\n`);
const err = (text) => fs.writeSync(2, `${text}\n`);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const modeIndex = process.argv.indexOf("--mode");
const rpc = modeIndex >= 0 && process.argv[modeIndex + 1] === "rpc";
const commands = rpc ? createInterface({ input: process.stdin })[Symbol.asyncIterator]() : undefined;
if (script.maxTurns) {
	const limit = rpc ? process.env.DELEGATE_MAX_TURNS : process.argv[process.argv.indexOf("--max-turns") + 1];
	if (Number(limit) !== script.maxTurns) throw new Error("Expected the configured turn limit");
}
if (commands) {
	const prompt = JSON.parse((await commands.next()).value);
	if (prompt.type !== "prompt" || !prompt.message.includes("Task: parity")) throw new Error("Expected the task prompt");
	out({ type: "response", id: prompt.id, command: "prompt", success: true });
}

for (const step of script.steps) {
	if (step.sleep) pause(step.sleep);
	if (step.stderr) err(step.stderr);
	if (step.emit) out(step.emit);
	if (step.assistant) out({ type: "message_end", message: { role: "assistant", content: [], ...step.assistant } });
	for (const id of step.calls ?? []) {
		out({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "check-fixture" } }] },
		});
	}
	if (step.write) {
		const file = path.resolve(process.cwd(), step.write);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, step.text ?? "");
		if (step.mtime) fs.utimesSync(file, step.mtime, step.mtime);
	}
	if (step.writeHome) {
		const file = path.join(process.env.HOME, step.writeHome);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, step.text ?? "");
	}
	if (step.ask) {
		const result = spawnSync(process.execPath, ["/delegate/ask.mjs", JSON.stringify(step.ask)], { encoding: "utf8" });
		if (step.echo) {
			out({
				type: "message_end",
				message: {
					id: "m-ask",
					role: "assistant",
					content: [{ type: "text", text: `ANSWER ${result.stdout.trim()} ${result.stderr.trim()}`.trim() }],
				},
			});
		}
	}
	if (step.expectSteer || step.expectGuard) {
		const steer = JSON.parse((await commands.next()).value);
		const expected = step.expectGuard
			? steer.message.startsWith("The parent guard saw bash: check-fixture repeated 3 times")
			: steer.message === step.expectSteer;
		if (steer.type !== "steer" || !expected) throw new Error("Expected the steering message");
		out({ type: "response", id: steer.id, command: "steer", success: true });
	}
	if (step.exit !== undefined) {
		if (!commands || step.exit !== 0) process.exit(step.exit);
		break;
	}
}
if (commands) {
	out({ type: "agent_settled", aborted: false });
	if (!(await commands.next()).done) throw new Error("Expected input to close after the task settled");
}
