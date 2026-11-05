import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { cancel, start, status } from "../core/core.ts";
import { acquireScope, acquireSlot, git, releaseSlot, sleep } from "../core/workspace.ts";

const SKIP = spawnSync("bwrap", ["--version"]).status !== 0;
const created: string[] = [];

after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix = "delegate-test-"): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

function repo(): string {
	const dir = tempDir();
	git(dir, ["init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(dir, "README.md"), "host project\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

const WORKER = [
	'import * as fs from "node:fs";',
	'import * as path from "node:path";',
	'import { fileURLToPath } from "node:url";',
	'const self = path.dirname(fileURLToPath(import.meta.url));',
	'let asset = "ASSET_RW";',
	'try { fs.writeFileSync(path.join(self, "evil.txt"), "x"); } catch { asset = "ASSET_RO"; }',
	'let wrote = "no-write";',
	'try { fs.writeFileSync("child.txt", "written\\n"); wrote = "wrote-child"; } catch {}',
	'const packages = fs.existsSync("/workspace/packages") ? "PRESENT" : "absent";',
	'const entry = process.argv[1] === "/delegate-pi-package/cli.mjs" ? "mount" : "host";',
	'const text = `FAKE_PI ${asset} ${wrote} entry=${entry} packages=${packages}`;',
	'fs.writeSync(1, JSON.stringify({ type: "session", id: "fake-session" }) + "\\n");',
	'fs.writeSync(1, JSON.stringify({ type: "message_end", message: { id: "m1", role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } }) + "\\n");',
	"",
].join("\n");

function packageDir(): string {
	const dir = tempDir("delegate-pkg-");
	fs.writeFileSync(path.join(dir, "cli.mjs"), WORKER);
	return dir;
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await sleep(100);
	}
	return check();
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try { return await fn(); } finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const NO_KEYS = { ZAI_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, COMMANDCODE_API_KEY: undefined };

test("bundled pi runs offline from the mounted package without installed pi", { skip: SKIP }, async () => {
	const project = repo();
	const pkg = packageDir();
	await withEnv({ ...NO_KEYS, DELEGATE_PI_ENTRY: path.join(pkg, "cli.mjs"), DELEGATE_PI_PACKAGE_DIR: pkg, PATH: "/usr/bin:/bin" }, async () => {
		const started = start({ task: "report the sandbox state", provider: "pi", scope: ".", cwd: project, timeoutMs: 60000 });
		const done = await until(() => ["completed", "failed", "cancelled"].includes(status(started.taskId).status), 60000);
		const state = status(started.taskId);
		assert.ok(done, `task did not finish: ${JSON.stringify(state)}`);
		assert.equal(state.status, "completed", JSON.stringify(state));
		assert.match(state.summary, /FAKE_PI ASSET_RO wrote-child entry=mount packages=absent/);
		assert.equal(fs.readFileSync(path.join(project, "child.txt"), "utf8"), "written\n");
		assert.equal(fs.existsSync(path.join(pkg, "evil.txt")), false);
		assert.equal(fs.existsSync(path.join(project, "packages")), false);
	});
});

test("a task queued for a slot releases its scope when cancelled", { skip: SKIP }, async () => {
	const project = repo();
	const pkg = packageDir();
	for (let i = 0; i < 4; i++) {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ taskId: `holder-${i}`, status: "running", workerPid: process.pid, heartbeat: Date.now() }));
		await acquireSlot(project, `holder-${i}`, dir, 4);
	}
	await withEnv({ ...NO_KEYS, DELEGATE_PI_ENTRY: path.join(pkg, "cli.mjs"), DELEGATE_PI_PACKAGE_DIR: pkg, PATH: "/usr/bin:/bin" }, async () => {
		const started = start({ task: "wait for a slot", provider: "pi", scope: ".", cwd: project, timeoutMs: 60000 });
		const queued = await until(() => status(started.taskId).status === "queued", 20000);
		assert.ok(queued, `task did not queue: ${JSON.stringify(status(started.taskId))}`);
		assert.equal(status(started.taskId).scopeHeld, true);
		await cancel(started.taskId);
		assert.equal(status(started.taskId).status, "cancelled");
		const other = tempDir();
		fs.writeFileSync(path.join(other, "state.json"), "{}");
		assert.deepEqual(await acquireScope(project, "00000000-0000-4000-8000-0000000000aa", ["."], other), []);
	});
});

test("a task queued for a scope holds no execution slot", { skip: SKIP }, async () => {
	const project = repo();
	const pkg = packageDir();
	const holder = tempDir();
	fs.writeFileSync(path.join(holder, "state.json"), JSON.stringify({ taskId: "scope-holder", status: "running", workerPid: process.pid, heartbeat: Date.now() }));
	await acquireScope(project, "scope-holder", ["."], holder);
	await withEnv({ ...NO_KEYS, DELEGATE_PI_ENTRY: path.join(pkg, "cli.mjs"), DELEGATE_PI_PACKAGE_DIR: pkg, PATH: "/usr/bin:/bin" }, async () => {
		const started = start({ task: "wait for the scope", provider: "pi", scope: ".", cwd: project, timeoutMs: 60000 });
		assert.ok(await until(() => status(started.taskId).status === "queued", 20000), JSON.stringify(status(started.taskId)));
		assert.ok(!status(started.taskId).scopeHeld);
		const probe = tempDir();
		fs.writeFileSync(path.join(probe, "state.json"), "{}");
		assert.deepEqual(await acquireSlot(project, "00000000-0000-4000-8000-0000000000bb", probe, 1), []);
		releaseSlot(project, "00000000-0000-4000-8000-0000000000bb");
		await cancel(started.taskId);
	});
});
