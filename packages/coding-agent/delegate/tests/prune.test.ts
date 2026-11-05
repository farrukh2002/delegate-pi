import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { TASKS, git, snapshot } from "../core/workspace.ts";
import { accept, parseOlderThan, prune, status } from "../core/core.ts";

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-")));
	created.push(dir);
	return dir;
}

function makeTask(id: string, state?: unknown, input?: unknown, mtimeMs?: number): void {
	const dir = path.join(TASKS, id);
	fs.mkdirSync(dir, { recursive: true });
	created.push(dir);
	if (state !== undefined) fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
	if (input !== undefined) fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify(input));
	if (mtimeMs !== undefined) { const t = new Date(mtimeMs); fs.utimesSync(dir, t, t); }
}

test("parseOlderThan reads m, h and d", () => {
	assert.equal(parseOlderThan(undefined), 7 * 86400000);
	assert.equal(parseOlderThan("30m"), 30 * 60000);
	assert.equal(parseOlderThan("12h"), 12 * 3600000);
	assert.equal(parseOlderThan("2d"), 2 * 86400000);
	assert.throws(() => parseOlderThan("7w"));
	assert.throws(() => parseOlderThan("soon"));
});

test("prune removes old finished tasks and keeps active and held-scope tasks", () => {
	const now = Date.now();
	const old = now - 10 * 86400000;

	const done = randomUUID();
	makeTask(done, { taskId: done, status: "completed", scopeHeld: false, finishedAt: old }, undefined, old);

	const held = randomUUID();
	makeTask(held, { taskId: held, status: "failed", scopeHeld: true, finishedAt: old }, undefined, old);

	const active = randomUUID();
	makeTask(active, { taskId: active, status: "running", createdAt: now });

	const stale = randomUUID();
	makeTask(stale, undefined, undefined, old);

	const result = prune(7 * 86400000);

	assert.deepEqual(result.removed.sort(), [done, stale].sort());
	const kept = Object.fromEntries(result.kept.map((item) => [item.taskId, item.reason]));
	assert.equal(kept[held], "holds scope; accept or undo it");
	assert.equal(kept[active], "active");
	assert.equal(fs.existsSync(path.join(TASKS, done)), false);
	assert.equal(fs.existsSync(path.join(TASKS, stale)), false);
	assert.equal(fs.existsSync(path.join(TASKS, held)), true);
	assert.equal(fs.existsSync(path.join(TASKS, active)), true);
});

test("prune drops the git refs of a removed task", () => {
	const cwd = tempDir();
	git(cwd, ["init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-q", "-m", "init"]);
	const id = randomUUID();
	const old = Date.now() - 10 * 86400000;
	makeTask(id, { taskId: id, status: "completed", scopeHeld: false, finishedAt: old }, { cwd, scope: ["a.txt"] }, old);
	snapshot(cwd, ["a.txt"], id, "before", path.join(TASKS, id));
	snapshot(cwd, ["a.txt"], id, "after", path.join(TASKS, id));
	assert.notEqual(git(cwd, ["for-each-ref", `refs/delegate/${id}`]), "");

	assert.ok(prune(7 * 86400000).removed.includes(id));
	assert.equal(git(cwd, ["for-each-ref", `refs/delegate/${id}`]), "");
});

test("accept removes the task folder and the id becomes unknown", () => {
	const cwd = tempDir();
	const id = randomUUID();
	makeTask(id, { taskId: id, status: "completed", scope: [], scopeHeld: false, pending: [] }, { cwd, scope: [] });

	const state = accept(id);
	assert.equal(state.accepted, true);
	assert.equal(fs.existsSync(path.join(TASKS, id)), false);
	assert.throws(() => status(id));
});
