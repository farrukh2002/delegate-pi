import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { steer } from "../core/core.ts";
import { TASKS } from "../core/workspace.ts";

function task(id: string, state: Record<string, unknown>): string {
	const dir = path.join(TASKS, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "state.json"),
		JSON.stringify({ taskId: id, status: "running", workerPid: process.pid, heartbeat: Date.now(), ...state }),
	);
	return dir;
}

test("steering writes only to a running, steerable child", () => {
	const id = "00000000-0000-4000-8000-000000000001";
	const dir = task(id, { provider: "pi" });
	assert.deepEqual(steer(id, "  try the other test runner  "), { taskId: id, steered: true });
	assert.throws(() => steer(id, "do not replace the first message"), /already pending/);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "steer.json"), "utf8")).message, "try the other test runner");
	assert.throws(() => steer(id, " "), /nonempty message/);

	const claude = "00000000-0000-4000-8000-000000000002";
	task(claude, { provider: "claude" });
	assert.throws(() => steer(claude, "change approach"), /do not support steering/);

	const done = "00000000-0000-4000-8000-000000000003";
	task(done, { provider: "pi", status: "completed" });
	assert.throws(() => steer(done, "change approach"), /already stopped/);
});
