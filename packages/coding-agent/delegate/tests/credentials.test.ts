import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { closeHome, returnCredentials } from "../core/sandbox.ts";

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

const BEFORE = JSON.stringify({ tokens: { account_id: "acct-1", refresh_token: "r1" }, last_refresh: "t1" });
const REFRESHED = JSON.stringify({ tokens: { account_id: "acct-1", refresh_token: "r2" }, last_refresh: "t2" });

function setup(childContent: string | null = REFRESHED) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-cred-")));
	created.push(root);
	const host = path.join(root, "host-auth.json");
	fs.writeFileSync(host, BEFORE, { mode: 0o600 });
	const taskDir = path.join(root, "task");
	const rel = ".codex/auth.json";
	fs.mkdirSync(path.join(taskDir, "home", ".codex"), { recursive: true });
	if (childContent !== null) fs.writeFileSync(path.join(taskDir, "home", rel), childContent);
	const hash = createHash("sha256").update(BEFORE).digest("hex");
	fs.writeFileSync(path.join(taskDir, "credentials.json"), JSON.stringify([{ rel, from: host, hash }]));
	return { root, host, taskDir, rel };
}

test("a refreshed token goes back to the host file", () => {
	const { host, taskDir } = setup();
	assert.deepEqual(returnCredentials(taskDir), [host]);
	assert.equal(fs.readFileSync(host, "utf8"), REFRESHED);
	assert.equal(fs.statSync(host).mode & 0o777, 0o600);
});

test("an unchanged child copy does not touch the host file", () => {
	const { host, taskDir } = setup(BEFORE);
	const before = fs.statSync(host).mtimeMs;
	assert.deepEqual(returnCredentials(taskDir), []);
	assert.equal(fs.statSync(host).mtimeMs, before);
});

test("a host file that changed after the copy wins", () => {
	const { host, taskDir } = setup();
	const newer = JSON.stringify({ tokens: { account_id: "acct-1", refresh_token: "host" }, last_refresh: "t3" });
	fs.writeFileSync(host, newer);
	assert.deepEqual(returnCredentials(taskDir), []);
	assert.equal(fs.readFileSync(host, "utf8"), newer);
});

test("a child copy for another account is not written back", () => {
	const { host, taskDir } = setup(JSON.stringify({ tokens: { account_id: "attacker", refresh_token: "x" }, last_refresh: "t2" }));
	assert.deepEqual(returnCredentials(taskDir), []);
	assert.equal(fs.readFileSync(host, "utf8"), BEFORE);
});

test("a child copy with other top-level keys or bad JSON is not written back", () => {
	for (const content of [JSON.stringify({ tokens: { account_id: "acct-1" } }), "not json", "[]"]) {
		const { host, taskDir } = setup(content);
		assert.deepEqual(returnCredentials(taskDir), []);
		assert.equal(fs.readFileSync(host, "utf8"), BEFORE);
	}
});

test("a symlink in the child home is not followed", () => {
	const { root, host, taskDir, rel } = setup(null);
	const outside = path.join(root, "outside.json");
	fs.writeFileSync(outside, REFRESHED);
	fs.symlinkSync(outside, path.join(taskDir, "home", rel));
	assert.deepEqual(returnCredentials(taskDir), []);
	fs.rmSync(path.join(taskDir, "home", ".codex"), { recursive: true });
	fs.symlinkSync(root, path.join(taskDir, "home", ".codex"));
	fs.writeFileSync(path.join(root, "auth.json"), REFRESHED);
	assert.deepEqual(returnCredentials(taskDir), []);
	assert.equal(fs.readFileSync(host, "utf8"), BEFORE);
});

test("closeHome writes back, then removes the home and the record", () => {
	const { host, taskDir } = setup();
	closeHome(taskDir);
	assert.equal(fs.readFileSync(host, "utf8"), REFRESHED);
	assert.equal(fs.existsSync(path.join(taskDir, "home")), false);
	assert.equal(fs.existsSync(path.join(taskDir, "credentials.json")), false);
});
