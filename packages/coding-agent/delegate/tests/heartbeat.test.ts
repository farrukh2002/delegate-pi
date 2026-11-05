import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { HEARTBEAT_STALE_MS, MAX_PARALLEL, MAX_TASKS, status } from "../core/core.ts";
import { TASKS, acquireScope, releaseScope } from "../core/workspace.ts";

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

function makeTask(state: Record<string, unknown>): string {
	const id = randomUUID();
	const dir = path.join(TASKS, id);
	fs.mkdirSync(dir, { recursive: true });
	created.push(dir);
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ taskId: id, ...state }));
	return id;
}

test("limits stay at 4 parallel children and 8 batch tasks", () => {
	assert.equal(MAX_PARALLEL, 4);
	assert.equal(MAX_TASKS, 8);
});

test("a hidden PID stays running while the heartbeat is recent", () => {
	const id = makeTask({ status: "running", workerPid: 999999, createdAt: Date.now() - 60_000, heartbeat: Date.now() });
	assert.equal(status(id).status, "running");
});

test("a hidden PID fails once the heartbeat is stale", () => {
	const id = makeTask({ status: "running", workerPid: 999999, createdAt: Date.now() - 60_000, heartbeat: Date.now() - HEARTBEAT_STALE_MS - 1000 });
	assert.equal(status(id).status, "failed");
});

test("a worker without a PID or heartbeat fails after the stale window", () => {
	const id = makeTask({ status: "starting", createdAt: Date.now() - HEARTBEAT_STALE_MS - 1000 });
	assert.equal(status(id).status, "failed");
});

test("a fresh start without a heartbeat is not failed early", () => {
	const id = makeTask({ status: "starting", createdAt: Date.now() });
	assert.equal(status(id).status, "starting");
});

const DEAD = { status: "running", workerPid: 999999, createdAt: Date.now() - 60_000, heartbeat: Date.now() - HEARTBEAT_STALE_MS - 1000 };

test("status removes the private home of a dead worker", () => {
	const id = makeTask(DEAD);
	const home = path.join(TASKS, id, "home");
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
	assert.equal(status(id).status, "failed");
	assert.equal(fs.existsSync(home), false);
});

function project(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-scope-")));
	created.push(dir);
	return dir;
}

test("a dead blocker without a snapshot frees its scope at once", async () => {
	const cwd = project();
	const blocker = makeTask(DEAD);
	assert.deepEqual(await acquireScope(cwd, blocker, ["src"], path.join(TASKS, blocker)), []);
	const next = randomUUID();
	assert.deepEqual(await acquireScope(cwd, next, ["src/a.ts"], path.join(TASKS, next)), []);
	releaseScope(cwd, next);
});

test("a dead blocker with a snapshot keeps its scope for review and is marked failed", async () => {
	const cwd = project();
	const blocker = makeTask({ ...DEAD, snapshot: true });
	assert.deepEqual(await acquireScope(cwd, blocker, ["src"], path.join(TASKS, blocker)), []);
	const next = randomUUID();
	assert.deepEqual(await acquireScope(cwd, next, ["src/a.ts"], path.join(TASKS, next)), [blocker]);
	const state = JSON.parse(fs.readFileSync(path.join(TASKS, blocker, "state.json"), "utf8"));
	assert.equal(state.status, "failed");
	releaseScope(cwd, blocker);
});

test("a live blocker keeps its scope", async () => {
	const cwd = project();
	const blocker = makeTask({ status: "running", workerPid: process.pid, createdAt: Date.now(), heartbeat: Date.now() });
	assert.deepEqual(await acquireScope(cwd, blocker, ["src"], path.join(TASKS, blocker)), []);
	const next = randomUUID();
	assert.deepEqual(await acquireScope(cwd, next, ["src/a.ts"], path.join(TASKS, next)), [blocker]);
	releaseScope(cwd, blocker);
});
