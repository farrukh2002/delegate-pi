import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireSlot, releaseSlot } from "../core/workspace.ts";

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-")));
	created.push(dir);
	return dir;
}

function liveTask(): { id: string; dir: string } {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "state.json"), "{}");
	return { id: randomUUID(), dir };
}

test("slots cap actual children per workspace", async () => {
	const cwd = tempDir();
	const max = 4;
	const tasks = Array.from({ length: 5 }, () => liveTask());
	for (const task of tasks.slice(0, max)) assert.deepEqual(await acquireSlot(cwd, task.id, task.dir, max), []);
	const blocked = await acquireSlot(cwd, tasks[4].id, tasks[4].dir, max);
	assert.equal(blocked.length, max);
	assert.equal(blocked.includes(tasks[4].id), false);
	assert.deepEqual(await acquireSlot(cwd, tasks[0].id, tasks[0].dir, max), []);
});

test("slots recover stale entries when the task folder is gone", async () => {
	const cwd = tempDir();
	const max = 2;
	const tasks = Array.from({ length: 3 }, () => liveTask());
	await acquireSlot(cwd, tasks[0].id, tasks[0].dir, max);
	await acquireSlot(cwd, tasks[1].id, tasks[1].dir, max);
	assert.equal((await acquireSlot(cwd, tasks[2].id, tasks[2].dir, max)).length, max);
	fs.rmSync(path.join(tasks[0].dir, "state.json"));
	assert.deepEqual(await acquireSlot(cwd, tasks[2].id, tasks[2].dir, max), []);
});

test("releasing a slot frees capacity", async () => {
	const cwd = tempDir();
	const tasks = Array.from({ length: 5 }, () => liveTask());
	for (const task of tasks.slice(0, 4)) await acquireSlot(cwd, task.id, task.dir, 4);
	releaseSlot(cwd, tasks[0].id);
	assert.deepEqual(await acquireSlot(cwd, tasks[4].id, tasks[4].dir, 4), []);
});

function holder(state: Record<string, unknown>): { id: string; dir: string } {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
	return { id: randomUUID(), dir };
}

test("slots recover a holder whose task reached a terminal state", async () => {
	const cwd = tempDir();
	const done = holder({ status: "completed", heartbeat: Date.now() });
	await acquireSlot(cwd, done.id, done.dir, 1);
	assert.deepEqual(await acquireSlot(cwd, randomUUID(), tempDir(), 1), []);
});

test("slots recover a holder whose worker died", async () => {
	const cwd = tempDir();
	const dead = holder({ status: "running", workerPid: 999999999, heartbeat: Date.now() - 60000 });
	await acquireSlot(cwd, dead.id, dead.dir, 1);
	assert.deepEqual(await acquireSlot(cwd, randomUUID(), tempDir(), 1), []);
});

test("slots keep a holder with a fresh heartbeat", async () => {
	const cwd = tempDir();
	const live = holder({ status: "running", workerPid: 999999999, heartbeat: Date.now() });
	await acquireSlot(cwd, live.id, live.dir, 1);
	assert.equal((await acquireSlot(cwd, randomUUID(), tempDir(), 1)).length, 1);
});
