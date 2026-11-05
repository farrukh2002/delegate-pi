import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TASKS, claimMessage, claimNotes, claimPaths, git, listClaims, releaseClaims, strayFiles } from "../core/workspace.ts";

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-")));
	created.push(dir);
	return dir;
}

function repo(): string {
	const dir = tempDir();
	git(dir, ["init", "-q", "-b", "main"]);
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src/a.ts"), "a v1\n");
	fs.writeFileSync(path.join(dir, "src/b.ts"), "b v1\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

function liveTask(): string {
	const id = `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
	const dir = path.join(TASKS, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "state.json"), "{}");
	created.push(dir);
	return id;
}

test("claim and deny", () => {
	const dir = repo();
	const one = liveTask();
	const two = liveTask();
	assert.deepEqual(claimPaths(dir, one, "alpha", ["src/a.ts", "src/new.ts"]), []);
	assert.deepEqual(claimPaths(dir, two, "beta", ["src/a.ts", "src/b.ts"]), [{ path: "src/a.ts", taskId: one, agent: "alpha" }]);
	const claims = listClaims(dir);
	assert.deepEqual(claims.map(c => [c.path, c.taskId]), [["src/a.ts", one], ["src/b.ts", two], ["src/new.ts", one]]);
	assert.equal(claims[0].baseHash, git(dir, ["hash-object", "src/a.ts"]));
	assert.equal(claims[2].baseHash, null);
});

test("same task claims again", () => {
	const dir = repo();
	const one = liveTask();
	assert.deepEqual(claimPaths(dir, one, "alpha", ["src/a.ts"]), []);
	assert.deepEqual(claimPaths(dir, one, "alpha", ["src/a.ts"]), []);
	assert.equal(listClaims(dir).length, 1);
});

test("stale claim is replaced", () => {
	const dir = repo();
	const one = liveTask();
	const two = liveTask();
	claimPaths(dir, one, "alpha", ["src/a.ts"]);
	fs.rmSync(path.join(TASKS, one), { recursive: true, force: true });
	assert.deepEqual(claimNotes(dir, two, ["src/a.ts"]), []);
	claimPaths(dir, one, "alpha", ["src/a.ts"]);
	fs.rmSync(path.join(TASKS, one), { recursive: true, force: true });
	assert.deepEqual(claimPaths(dir, two, "beta", ["src/a.ts"]), []);
	assert.deepEqual(listClaims(dir).map(c => c.taskId), [two]);
});

test("release", () => {
	const dir = repo();
	const one = liveTask();
	const two = liveTask();
	claimPaths(dir, one, "alpha", ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(releaseClaims(dir, two, ["src/a.ts"]), []);
	assert.deepEqual(releaseClaims(dir, one, ["src/a.ts"]), ["src/a.ts"]);
	assert.deepEqual(claimPaths(dir, two, "beta", ["src/a.ts"]), []);
	assert.deepEqual(releaseClaims(dir, one), ["src/b.ts"]);
	assert.deepEqual(listClaims(dir).map(c => c.taskId), [two]);
});

test("notes", () => {
	const dir = repo();
	const one = liveTask();
	const two = liveTask();
	claimPaths(dir, one, "alpha", ["src/a.ts"]);
	assert.deepEqual(claimNotes(dir, two, ["src/a.ts", "src/b.ts"]), [{ path: "src/a.ts", taskId: one, agent: "alpha" }]);
	assert.deepEqual(claimNotes(dir, one, ["src/a.ts"]), []);
});

test("stray files skip claims by other tasks", () => {
	const dir = repo();
	const one = liveTask();
	const two = liveTask();
	fs.writeFileSync(path.join(dir, "src/claimed.ts"), "claimed\n");
	claimPaths(dir, one, "alpha", ["src/claimed.ts"]);
	fs.writeFileSync(path.join(dir, "src/loose.ts"), "loose\n");
	const before = { src: ["a.ts", "b.ts"] };
	assert.deepEqual(strayFiles(dir, ["src/a.ts"], before, two), ["src/loose.ts"]);
});

test("claimMessage maps sandbox paths", () => {
	const dir = repo();
	const one = liveTask();
	const two = liveTask();
	assert.deepEqual(claimMessage(dir, one, "alpha", { kind: "claim", paths: ["/workspace/src/a.ts", "src/b.ts", "/etc/passwd", "../x", "/workspace/.git/config"] }), { denied: [] });
	assert.deepEqual(listClaims(dir).map(c => c.path), ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(claimMessage(dir, two, "beta", { kind: "claim", paths: ["/workspace/src/a.ts"] }), { denied: [{ path: "src/a.ts", taskId: one, agent: "alpha" }] });
	assert.deepEqual(claimMessage(dir, two, "beta", { kind: "notify", paths: ["src/b.ts"] }), { notes: [{ path: "src/b.ts", taskId: one, agent: "alpha" }] });
	assert.deepEqual(claimMessage(dir, one, "alpha", { kind: "release", paths: ["/workspace/src/a.ts", "/etc/passwd"] }), { released: ["src/a.ts"] });
	assert.throws(() => claimMessage(dir, one, "alpha", { kind: "other", paths: [] }));
});
