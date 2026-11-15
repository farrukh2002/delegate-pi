import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const self = path.dirname(fileURLToPath(import.meta.url));
const script = JSON.parse(fs.readFileSync(path.join(self, "script.json"), "utf8"));
const out = (value) => fs.writeSync(1, `${JSON.stringify(value)}\n`);
const err = (text) => fs.writeSync(2, `${text}\n`);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (const step of script.steps) {
	if (step.sleep) pause(step.sleep);
	if (step.stderr) err(step.stderr);
	if (step.emit) out(step.emit);
	if (step.write) {
		const file = path.resolve(process.cwd(), step.write);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, step.text ?? "");
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
	if (step.exit !== undefined) process.exit(step.exit);
}
