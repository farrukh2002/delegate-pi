import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { answer, start, status } from "../core/core.ts";
import { git, sleep } from "../core/workspace.ts";

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

const ASKING_CHILD = [
	'import * as fs from "node:fs";',
	'import { spawnSync } from "node:child_process";',
	'const asked = spawnSync(process.execPath, ["/delegate/ask.mjs", JSON.stringify({ question: "Continue?" })], { encoding: "utf8" });',
	'const reply = asked.status === 0 ? JSON.parse(asked.stdout).answer : `ASK_FAILED ${asked.stderr}`;',
	'fs.writeSync(1, JSON.stringify({ type: "message_end", message: { id: "m1", role: "assistant", content: [{ type: "text", text: `ANSWER ${reply}` }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } }) + "\\n");',
	"",
].join("\n");

const SPLIT_CHILD = [
	'import * as fs from "node:fs";',
	'const line = Buffer.from(JSON.stringify({ type: "message_end", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Ergebnis: 日本語 ✓ grüß" }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } }) + "\\n");',
	'const cut = line.indexOf(Buffer.from("本")) + 1;',
	"fs.writeSync(1, line.subarray(0, cut));",
	"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);",
	"fs.writeSync(1, line.subarray(cut));",
	"",
].join("\n");

async function withPiChild<T>(script: string, fn: () => Promise<T>): Promise<T> {
	const pkg = tempDir("delegate-pkg-");
	fs.writeFileSync(path.join(pkg, "cli.mjs"), script);
	const saved = { entry: process.env.DELEGATE_PI_ENTRY, dir: process.env.DELEGATE_PI_PACKAGE_DIR, pathEnv: process.env.PATH };
	process.env.DELEGATE_PI_ENTRY = path.join(pkg, "cli.mjs");
	process.env.DELEGATE_PI_PACKAGE_DIR = pkg;
	process.env.PATH = "/usr/bin:/bin";
	try {
		return await fn();
	} finally {
		for (const [key, value] of [["DELEGATE_PI_ENTRY", saved.entry], ["DELEGATE_PI_PACKAGE_DIR", saved.dir], ["PATH", saved.pathEnv]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const DONE = ["completed", "failed", "timed_out", "cancelled"];

async function until(check: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await sleep(100);
	}
	return check();
}

test("time spent waiting for the user counts against neither the timeout nor the no-progress limit", { skip: SKIP }, async () => {
	const project = repo();
	await withPiChild(ASKING_CHILD, async () => {
		const started = start({ task: "ask, then report", provider: "pi", cwd: project, timeoutMs: 1500, noProgressMs: 1000 });
		assert.ok(await until(() => status(started.taskId).pending?.length > 0, 30000), JSON.stringify(status(started.taskId)));
		await sleep(2500);
		const waiting = status(started.taskId);
		assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
		answer(started.taskId, waiting.pending[0].id, { answer: "yes" });
		assert.ok(await until(() => DONE.includes(status(started.taskId).status), 30000));
		const done = status(started.taskId);
		assert.equal(done.status, "completed", JSON.stringify(done));
		assert.match(done.summary, /ANSWER yes/);
	});
});

test("a multi-byte character split across two output chunks stays intact", { skip: SKIP }, async () => {
	const project = repo();
	await withPiChild(SPLIT_CHILD, async () => {
		const started = start({ task: "report", provider: "pi", cwd: project });
		assert.ok(await until(() => DONE.includes(status(started.taskId).status), 30000));
		const done = status(started.taskId);
		assert.equal(done.status, "completed", JSON.stringify(done));
		assert.match(done.summary, /Ergebnis: 日本語 ✓ grüß/);
		assert.doesNotMatch(done.summary, /�/);
	});
});
