import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

const onPath = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const provider = ["pi", "claude", "codex", "commandcode"].find(onPath);
const canStart = onPath("bwrap") && provider !== undefined;

function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-")));
	created.push(dir);
	return dir;
}

function repo(): string {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "file.txt"), "v1\n");
	spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
	spawnSync("git", ["-C", dir, "add", "-A"]);
	spawnSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
	return dir;
}

function startMany(tasks: unknown[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(
		process.execPath,
		[path.join(ROOT, "core/delegate.mjs"), "start-many", "--json", JSON.stringify(tasks)],
		{ cwd: ROOT, encoding: "utf8" },
	);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("start-many returns one entry per item and exits 0 when an item fails", () => {
	const result = startMany([
		{ task: "" },
		{ task: "two", sandbox: "none" },
		{ task: "three", isolation: "worktree" },
	]);
	assert.equal(result.status, 0, result.stderr);
	const entries = JSON.parse(result.stdout);
	assert.equal(Array.isArray(entries), true);
	assert.equal(entries.length, 3);
	for (const entry of entries) {
		assert.equal(entry.status, "failed");
		assert.equal(typeof entry.error, "string");
		assert.ok(entry.error.length > 0);
	}
});

test("start-many keeps the later entries when an earlier one fails", () => {
	const result = startMany([{ task: "" }, { task: "second", sandbox: "none" }]);
	assert.equal(result.status, 0, result.stderr);
	const entries = JSON.parse(result.stdout);
	assert.equal(entries.length, 2);
	assert.match(entries[0].error, /Task must contain/);
	assert.match(entries[1].error, /Sandbox bypass is not supported/);
});

test("start-many gives a per-entry error for a bad scope next to a valid entry", { skip: !canStart }, () => {
	const dir = repo();
	const result = startMany([
		{ task: "write config", provider, runtimeMode: "full-access", scope: ["/etc/hosts"], cwd: dir },
		{ task: "second", provider, runtimeMode: "full-access", scope: ["file.txt"], cwd: dir, timeoutMs: 5 },
	]);
	assert.equal(result.status, 0, result.stderr);
	const entries = JSON.parse(result.stdout);
	assert.equal(entries.length, 2);
	for (const entry of entries) {
		assert.equal(typeof entry.error, "string");
		assert.ok(entry.error.length > 0);
		assert.equal(entry.taskId, undefined);
	}
	assert.match(entries[0].error, /must be relative to the project/);
	assert.match(entries[1].error, /timeoutMs/);
});

test("start accepts a scope path that does not exist yet", { skip: !canStart }, () => {
	const dir = repo();
	const result = spawnSync(
		process.execPath,
		[path.join(ROOT, "core/delegate.mjs"), "start", "--json", JSON.stringify({ task: "add the module", provider, runtimeMode: "full-access", scope: ["src/newmod/index.ts"], cwd: dir, timeoutMs: 5 })],
		{ cwd: ROOT, encoding: "utf8" },
	);
	assert.doesNotMatch(result.stdout, /ENOENT/, result.stderr);
	assert.match(JSON.parse(result.stdout).error, /timeoutMs/);
	assert.equal(fs.statSync(path.join(dir, "src/newmod")).isDirectory(), true);
});
