import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkScopeTracked, defaultDataDir, git, ignoredPaths, snapshot, undo } from "../core/workspace.ts";
import { gitValue, passEnvNames, toolMount } from "../core/sandbox.ts";
import { loadAgents } from "../core/agents.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
	fs.writeFileSync(path.join(dir, "src/app.ts"), "app\n");
	fs.writeFileSync(path.join(dir, ".gitignore"), "*.local\nbuild/\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

test("the default data folder follows XDG_STATE_HOME", () => {
	assert.equal(defaultDataDir({ XDG_STATE_HOME: "/state" }), "/state/delegate");
	assert.equal(defaultDataDir({ XDG_STATE_HOME: "relative" }), path.join(os.homedir(), ".local/state/delegate"));
	assert.equal(defaultDataDir({}), path.join(os.homedir(), ".local/state/delegate"));
});

test("the child git identity comes from git config, also after other sections", () => {
	const home = tempDir();
	fs.writeFileSync(path.join(home, ".gitconfig"), "[core]\n\teditor = vim\n[user]\n\temail = me@example.com\n\tname = \"Ada \\\"Q\\\" Lovelace\"\n");
	const script = `import { hostGitConfig } from ${JSON.stringify(path.join(ROOT, "core/sandbox.ts"))}; console.log(JSON.stringify([hostGitConfig("user.name"), hostGitConfig("user.email"), hostGitConfig("user.signingkey")]));`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, HOME: home, DELEGATE_DATA: home }, encoding: "utf8" });
	assert.deepEqual(JSON.parse(result.stdout), ["Ada \"Q\" Lovelace", "me@example.com", null], result.stderr);
	assert.equal(gitValue("Ada \"Q\" \\ L"), "\"Ada \\\"Q\\\" \\\\ L\"");
});

test("tool mounts use the install prefix and never a broad or secret folder", () => {
	const home = os.homedir();
	assert.equal(toolMount(path.join(home, ".nvm/versions/node/v24.1.0/bin/node")), path.join(home, ".nvm/versions/node/v24.1.0"));
	assert.equal(toolMount(path.join(home, ".local/bin/pi")), path.join(home, ".local/bin"));
	assert.equal(toolMount(path.join(home, "pi")), path.join(home, "pi"));
	assert.equal(toolMount("/usr/bin/node"), undefined);
	assert.equal(toolMount(path.join(home, ".pi/agent/bin/pi")), undefined);
	assert.equal(toolMount(path.join(home, ".claude/local/claude")), undefined);
	assert.equal(toolMount("/opt/node/bin/node"), "/opt/node");
	assert.equal(toolMount("/opt/bin/node"), "/opt/bin");
});

test("DELEGATE_PASS_ENV adds valid names only", () => {
	const old = process.env.DELEGATE_PASS_ENV;
	process.env.DELEGATE_PASS_ENV = "HTTPS_PROXY, bad-name DELEGATE_DATA,PATH";
	try {
		const names = passEnvNames("codex", { PATH: "/bin" });
		assert.ok(names.includes("OPENAI_API_KEY"));
		assert.ok(names.includes("HTTPS_PROXY"));
		assert.ok(!names.includes("bad-name"));
		assert.ok(!names.includes("DELEGATE_DATA"));
		assert.ok(!names.includes("PATH"));
	} finally {
		if (old === undefined) delete process.env.DELEGATE_PASS_ENV;
		else process.env.DELEGATE_PASS_ENV = old;
	}
});

test("undo restores ignored files and removes empty folders", () => {
	const dir = repo();
	const id = "55555555-5555-5555-5555-555555555555";
	const temp = tempDir();
	fs.writeFileSync(path.join(dir, "src/config.local"), "user secret\n");
	fs.mkdirSync(path.join(dir, "src/build"));
	fs.writeFileSync(path.join(dir, "src/build/out.js"), "old build\n");
	snapshot(dir, ["src"], id, "before", temp);
	assert.deepEqual(ignoredPaths(dir, ["src"]).skipped, ["src/build/"]);
	fs.writeFileSync(path.join(dir, "src/config.local"), "child edit\n");
	fs.mkdirSync(path.join(dir, "src/deep/er"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src/deep/er/new.ts"), "new\n");
	fs.writeFileSync(path.join(dir, "src/deep/new.local"), "new ignored\n");
	snapshot(dir, ["src"], id, "after", temp);
	const restored = undo(dir, id, ["src"], temp, false);
	assert.ok(restored.includes("src/config.local"));
	assert.equal(fs.readFileSync(path.join(dir, "src/config.local"), "utf8"), "user secret\n");
	assert.equal(fs.existsSync(path.join(dir, "src/deep")), false);
	assert.equal(fs.existsSync(path.join(dir, "src")), true);
	assert.equal(fs.readFileSync(path.join(dir, "src/build/out.js"), "utf8"), "old build\n");
	assert.equal(git(dir, ["status", "--porcelain"]), "");
});

test("a scope folder that git ignores is refused, a small ignored file is allowed", () => {
	const dir = repo();
	fs.mkdirSync(path.join(dir, "src/build"));
	fs.writeFileSync(path.join(dir, "src/x.local"), "x\n");
	assert.throws(() => checkScopeTracked(dir, ["src/build"]), /ignored by git/);
	assert.doesNotThrow(() => checkScopeTracked(dir, ["src/x.local", "src"]));
});

test("undo keeps a new file scope's own folder and folders outside the scope", () => {
	const dir = repo();
	const id = "66666666-6666-6666-6666-666666666666";
	const temp = tempDir();
	const scope = ["src/mod/a/index.ts"];
	fs.mkdirSync(path.join(dir, "src/mod/a"), { recursive: true });
	snapshot(dir, scope, id, "before", temp);
	fs.writeFileSync(path.join(dir, "src/mod/a/index.ts"), "x\n");
	snapshot(dir, scope, id, "after", temp);
	undo(dir, id, scope, temp, false);
	assert.equal(fs.existsSync(path.join(dir, "src/mod/a/index.ts")), false);
	assert.equal(fs.existsSync(path.join(dir, "src/mod/a")), true);
});

test("project agents stop at the git root", () => {
	const outer = tempDir();
	const agent = (dir: string, name: string) => {
		fs.mkdirSync(path.join(dir, ".pi/agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi/agents", `${name}.md`), `---\nname: ${name}\ndescription: test\n---\nbody\n`);
	};
	agent(outer, "outer-agent");
	const project = path.join(outer, "project");
	fs.mkdirSync(path.join(project, "sub"), { recursive: true });
	git(project, ["init", "-q"]);
	const names = (cwd: string) => loadAgents(cwd).filter(item => item.source === "project").map(item => item.name);
	assert.deepEqual(names(path.join(project, "sub")), []);
	agent(project, "inner-agent");
	assert.deepEqual(names(path.join(project, "sub")), ["inner-agent"]);
	const loose = path.join(outer, "loose");
	fs.mkdirSync(loose);
	assert.deepEqual(names(loose), []);
});

test("run exits with code 1 on an error and accepts --scratch in the usage", () => {
	const result = spawnSync(process.execPath, [path.join(ROOT, "core/delegate.mjs"), "nope"], { encoding: "utf8", env: process.env });
	assert.equal(result.status, 1);
	assert.match(result.stdout, /--scratch/);
});
