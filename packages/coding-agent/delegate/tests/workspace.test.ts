import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireScope, diff, diffstat, git, gitMounts, listParents, normalizeScope, overlaps, prepareScope, releaseScope, scopeLayout, scratchPaths, snapshot, strayFiles, undo } from "../core/workspace.ts";
import { sandboxInvocation } from "../core/sandbox.ts";

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
	fs.mkdirSync(path.join(dir, "src/auth"), { recursive: true });
	fs.mkdirSync(path.join(dir, "src/export"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src/auth/login.ts"), "login v1\n");
	fs.writeFileSync(path.join(dir, "src/export/csv.ts"), "csv v1\n");
	fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
	fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

test("overlaps", () => {
	assert.equal(overlaps("src", "src/auth"), true);
	assert.equal(overlaps("src/auth", "src/authx"), false);
	assert.equal(overlaps(".", "package.json"), true);
	assert.equal(overlaps("src/auth", "src/export"), false);
});

test("normalizeScope", () => {
	const dir = repo();
	assert.deepEqual(normalizeScope(dir, undefined), []);
	assert.deepEqual(normalizeScope(dir, ["src/auth/", "src", "package.json"]), ["package.json", "src"]);
	assert.deepEqual(normalizeScope(dir, "src/auth,."), ["."]);
	assert.throws(() => normalizeScope(dir, ["../x"]));
	assert.throws(() => normalizeScope(dir, ["/etc"]));
	assert.throws(() => normalizeScope(dir, [".git"]));
	assert.throws(() => normalizeScope(dir, [".git/refs/new"]));
	assert.deepEqual(normalizeScope(dir, ["missing"]), ["missing"]);
	assert.deepEqual(normalizeScope(dir, ["src/auth/new.ts", "src"]), ["src"]);
	assert.deepEqual(normalizeScope(dir, ["src/newmod/index.ts"]), ["src/newmod/index.ts"]);
	assert.throws(() => normalizeScope(dir, ["package.json/x"]));
	fs.symlinkSync("/tmp", path.join(dir, "out"));
	assert.throws(() => normalizeScope(dir, ["out"]));
});

test("prepareScope creates only the parent of a missing scope path", () => {
	const dir = repo();
	prepareScope(dir, ["new.txt", "src/auth/new.ts", "src/newmod/index.ts", "."]);
	assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
	assert.equal(fs.existsSync(path.join(dir, "src/auth/new.ts")), false);
	assert.equal(fs.statSync(path.join(dir, "src/newmod")).isDirectory(), true);
});

test("scopeLayout treats a missing scope path as a file with its parent writable", () => {
	const dir = repo();
	prepareScope(dir, ["src/newmod/index.ts"]);
	assert.deepEqual(scopeLayout(dir, normalizeScope(dir, ["src/newmod/index.ts"])), { parents: ["src/newmod"], siblings: [], folders: [] });
	const root = scopeLayout(dir, normalizeScope(dir, ["new.txt"]));
	assert.deepEqual(root.parents, ["."]);
	assert.ok(root.siblings.includes("package.json"));
	assert.ok(!root.siblings.includes("new.txt"));
});

test("scratchPaths skips missing paths and scope paths", () => {
	const dir = repo();
	fs.mkdirSync(path.join(dir, ".cache"));
	fs.mkdirSync(path.join(dir, "src/auth/coverage"));
	assert.deepEqual(scratchPaths(dir, [], ["src/auth/coverage", "nope", "nope/deep"]), [".cache", "src/auth/coverage"]);
	assert.deepEqual(scratchPaths(dir, ["src/auth"], ["src/auth/coverage"]), [".cache"]);
});

test("snapshot, diff and undo restore only the scope", () => {
	const dir = repo();
	const id = "11111111-1111-1111-1111-111111111111";
	const temp = tempDir();
	fs.writeFileSync(path.join(dir, "src/auth/login.ts"), "login dirty\n");
	fs.writeFileSync(path.join(dir, "src/auth/untracked.ts"), "user file\n");
	const indexBefore = fs.readFileSync(path.join(dir, ".git/index"));
	snapshot(dir, ["src/auth"], id, "before", temp);
	assert.deepEqual(fs.readFileSync(path.join(dir, ".git/index")), indexBefore);
	fs.writeFileSync(path.join(dir, "src/auth/login.ts"), "login child\n");
	fs.writeFileSync(path.join(dir, "src/auth/new.ts"), "new\n");
	fs.rmSync(path.join(dir, "src/auth/untracked.ts"));
	fs.writeFileSync(path.join(dir, "src/export/csv.ts"), "csv user edit\n");
	snapshot(dir, ["src/auth"], id, "after", temp);
	const stat = diffstat(dir, id, ["src/auth"]);
	assert.match(stat, /login\.ts/);
	assert.match(stat, /new\.ts/);
	assert.doesNotMatch(stat, /csv/);
	assert.match(diff(dir, id, ["src/auth"]), /\+login child/);
	const restored = undo(dir, id, ["src/auth"], temp, false);
	assert.deepEqual(restored, ["src/auth/login.ts", "src/auth/new.ts", "src/auth/untracked.ts"]);
	assert.equal(fs.readFileSync(path.join(dir, "src/auth/login.ts"), "utf8"), "login dirty\n");
	assert.equal(fs.readFileSync(path.join(dir, "src/auth/untracked.ts"), "utf8"), "user file\n");
	assert.equal(fs.existsSync(path.join(dir, "src/auth/new.ts")), false);
	assert.equal(fs.readFileSync(path.join(dir, "src/export/csv.ts"), "utf8"), "csv user edit\n");
	assert.equal(git(dir, ["for-each-ref", "refs/delegate"]), "");
});

test("undo from a subdirectory of the repository", () => {
	const root = repo();
	const dir = path.join(root, "src");
	const id = "22222222-2222-2222-2222-222222222222";
	const temp = tempDir();
	snapshot(dir, ["auth"], id, "before", temp);
	fs.writeFileSync(path.join(dir, "auth/login.ts"), "changed\n");
	snapshot(dir, ["auth"], id, "after", temp);
	assert.deepEqual(undo(dir, id, ["auth"], temp, false), ["auth/login.ts"]);
	assert.equal(fs.readFileSync(path.join(dir, "auth/login.ts"), "utf8"), "login v1\n");
});

test("snapshot and undo accept a scope path that does not exist yet", () => {
	const dir = repo();
	const id = "66666666-6666-6666-6666-666666666666";
	const temp = tempDir();
	snapshot(dir, ["src/newmod/index.ts"], id, "before", temp);
	fs.mkdirSync(path.join(dir, "src/newmod"));
	fs.writeFileSync(path.join(dir, "src/newmod/index.ts"), "new\n");
	snapshot(dir, ["src/newmod/index.ts"], id, "after", temp);
	assert.match(diff(dir, id, ["src/newmod/index.ts"]), /\+new/);
	assert.deepEqual(undo(dir, id, ["src/newmod/index.ts"], temp, false), ["src/newmod/index.ts"]);
	assert.equal(fs.existsSync(path.join(dir, "src/newmod/index.ts")), false);
});

test("undo refuses files changed after the task, unless forced", () => {
	const dir = repo();
	const id = "33333333-3333-3333-3333-333333333333";
	const temp = tempDir();
	snapshot(dir, ["src/auth"], id, "before", temp);
	fs.writeFileSync(path.join(dir, "src/auth/login.ts"), "child\n");
	snapshot(dir, ["src/auth"], id, "after", temp);
	fs.writeFileSync(path.join(dir, "src/auth/login.ts"), "user later\n");
	assert.throws(() => undo(dir, id, ["src/auth"], temp, false), /changed after the task/);
	assert.equal(fs.readFileSync(path.join(dir, "src/auth/login.ts"), "utf8"), "user later\n");
	assert.deepEqual(undo(dir, id, ["src/auth"], temp, true), ["src/auth/login.ts"]);
	assert.equal(fs.readFileSync(path.join(dir, "src/auth/login.ts"), "utf8"), "login v1\n");
});

test("scope locks block overlap and release", async () => {
	const dir = repo();
	const taskA = tempDir();
	const taskB = tempDir();
	fs.writeFileSync(path.join(taskA, "state.json"), "{}");
	fs.writeFileSync(path.join(taskB, "state.json"), "{}");
	const a = "44444444-4444-4444-4444-444444444444";
	const b = "55555555-5555-5555-5555-555555555555";
	assert.deepEqual(await acquireScope(dir, a, ["src"], taskA), []);
	assert.deepEqual(await acquireScope(dir, b, ["src/auth"], taskB), [a]);
	assert.deepEqual(await acquireScope(dir, b, ["package.json"], taskB), []);
	releaseScope(dir, b);
	fs.rmSync(taskA, { recursive: true });
	assert.deepEqual(await acquireScope(dir, b, ["src/auth"], taskB), []);
	releaseScope(dir, b);
});

test("sandbox mounts: scope writable, rest and .git read-only, scratch discarded", { skip: spawnSync("bwrap", ["--version"]).status !== 0 }, () => {
	const dir = repo();
	fs.mkdirSync(path.join(dir, ".cache"));
	const task = tempDir();
	fs.mkdirSync(path.join(task, "home"));
	fs.mkdirSync(path.join(task, "ipc"));
	const script = [
		"echo ok > src/auth/a.txt && echo auth-ok",
		"echo no > src/export/a.txt 2>/dev/null || echo export-ro",
		"echo no > package.json 2>/dev/null || echo root-ro",
		"touch .git/x 2>/dev/null || echo git-ro",
		"echo tmp > .cache/x && echo scratch-ok",
	].join("; ");
	const run = (scope: string[], script: string) => {
		const wrapped = sandboxInvocation({ command: "/bin/sh", args: ["-c", script] }, { project: dir, layout: scopeLayout(dir, scope), scratch: scratchPaths(dir, scope, []), git: gitMounts(dir) }, task, "codex", "full-access");
		const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });
		return result.stdout.trim().split("\n").join(",");
	};
	assert.equal(run(["src/auth"], script), "auth-ok,export-ro,root-ro,git-ro,scratch-ok");
	assert.equal(fs.readFileSync(path.join(dir, "src/auth/a.txt"), "utf8"), "ok\n");
	assert.equal(fs.existsSync(path.join(dir, ".cache/x")), false);
	assert.equal(run([], "touch src/auth/b 2>/dev/null || echo ro"), "ro");
});

test("file scopes allow temp file and rename, and keep siblings read-only", { skip: spawnSync("bwrap", ["--version"]).status !== 0 }, () => {
	const dir = repo();
	const task = tempDir();
	fs.mkdirSync(path.join(task, "home"));
	fs.mkdirSync(path.join(task, "ipc"));
	const scope = normalizeScope(dir, ["package.json", "src/export/csv.ts", "src/auth"]);
	const layout = scopeLayout(dir, scope);
	const listing = listParents(dir, layout);
	const script = [
		"echo '{\"a\":1}' > .package.tmp && mv .package.tmp package.json && echo pkg-ok",
		"echo x > .gitignore 2>/dev/null || echo sibling-ro",
		"mv .gitignore gone 2>/dev/null || echo sibling-rename-blocked",
		"echo n > src/export/csv.tmp && mv src/export/csv.tmp src/export/csv.ts && echo csv-ok",
		"echo y > src/auth/login.ts && echo auth-ok",
		"touch .git/x 2>/dev/null || echo git-ro",
	].join("; ");
	const wrapped = sandboxInvocation({ command: "/bin/sh", args: ["-c", script] }, { project: dir, layout, scratch: [], git: gitMounts(dir) }, task, "codex", "full-access");
	const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });
	assert.equal(result.stdout.trim().split("\n").join(","), "pkg-ok,sibling-ro,sibling-rename-blocked,csv-ok,auth-ok,git-ro", result.stderr);
	assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), "{\"a\":1}\n");
	assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "dist/\n");
	assert.deepEqual(strayFiles(dir, scope, listing), []);
	fs.writeFileSync(path.join(dir, "stray.txt"), "x");
	assert.deepEqual(strayFiles(dir, scope, listing), ["stray.txt"]);
});

test("a scope file that does not exist yet is writable through its parent mount", { skip: spawnSync("bwrap", ["--version"]).status !== 0 }, () => {
	const dir = repo();
	const task = tempDir();
	fs.mkdirSync(path.join(task, "home"));
	fs.mkdirSync(path.join(task, "ipc"));
	const run = (scope: string[], script: string) => {
		const wrapped = sandboxInvocation({ command: "/bin/sh", args: ["-c", script] }, { project: dir, layout: scopeLayout(dir, scope), scratch: [], git: gitMounts(dir) }, task, "codex", "full-access");
		return spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" }).stdout.trim();
	};
	const existing = normalizeScope(dir, ["src/auth/new.ts"]);
	prepareScope(dir, existing);
	assert.equal(run(existing, "echo auth > src/auth/new.ts && echo made"), "made");
	assert.equal(fs.readFileSync(path.join(dir, "src/auth/new.ts"), "utf8"), "auth\n");
	assert.equal(run(existing, "echo no > src/auth/login.ts 2>/dev/null || echo ro"), "ro");
	const nested = normalizeScope(dir, ["src/newmod/index.ts"]);
	prepareScope(dir, nested);
	assert.equal(run(nested, "echo idx > src/newmod/index.ts && echo made"), "made");
	assert.equal(fs.readFileSync(path.join(dir, "src/newmod/index.ts"), "utf8"), "idx\n");
	assert.equal(run(nested, "echo no > package.json 2>/dev/null || echo ro"), "ro");
});
