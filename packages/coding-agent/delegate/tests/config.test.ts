import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultAgentsDir, findAgent, loadAgents, projectConfigDir, userAgentsDir } from "../core/agents.ts";
import { prepareHome } from "../core/sandbox.ts";

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-")));
	created.push(dir);
	return dir;
}

function agentFile(dir: string, name: string, provider = "codex"): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\nprovider: ${provider}\n---\n${name} prompt\n`);
}

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try { fn(); } finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("agent and project config directories have stable defaults", () => {
	withEnv({ DELEGATE_DEFAULT_AGENTS_DIR: undefined, DELEGATE_AGENTS_DIR: undefined, DELEGATE_PROJECT_CONFIG_DIR: undefined }, () => {
		assert.equal(projectConfigDir(), ".pi");
		assert.equal(userAgentsDir(), path.join(os.homedir(), ".pi", "agent", "agents"));
		assert.equal(path.basename(defaultAgentsDir()), "agents");
		assert.equal(fs.existsSync(defaultAgentsDir()), true);
		assert.ok(loadAgents(tempDir()).length > 0);
	});
});

test("agents fall back from bundled to user to project", () => {
	const cwd = tempDir();
	const bundled = tempDir();
	const user = tempDir();
	agentFile(bundled, "solo");
	agentFile(bundled, "shared", "codex");
	agentFile(user, "shared", "claude");
	withEnv({ DELEGATE_DEFAULT_AGENTS_DIR: bundled, DELEGATE_AGENTS_DIR: user, DELEGATE_PROJECT_CONFIG_DIR: ".delegate" }, () => {
		assert.equal(projectConfigDir(), ".delegate");
		agentFile(path.join(cwd, ".delegate", "agents"), "shared", "pi");
		const agents = loadAgents(cwd);
		const shared = agents.find(agent => agent.name === "shared")!;
		assert.equal(shared.provider, "pi");
		assert.equal(shared.source, "project");
		const solo = findAgent("solo", cwd)!;
		assert.equal(solo.source, "bundled");

		const other = loadAgents(tempDir());
		const userShared = other.find(agent => agent.name === "shared")!;
		assert.equal(userShared.provider, "claude");
		assert.equal(userShared.source, "user");
	});
});

test("prepareHome does not crash when settings.json is missing", () => {
	const home = tempDir();
	withEnv({ DELEGATE_PI_CONFIG_DIR: undefined }, () => {
		prepareHome(home, "pi");
		const settings = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"));
		assert.equal(typeof settings, "object");
		assert.equal(fs.existsSync(path.join(home, ".pi", "agent")), true);
	});
});

test("prepareHome honors DELEGATE_PI_CONFIG_DIR", () => {
	const home = tempDir();
	withEnv({ DELEGATE_PI_CONFIG_DIR: ".delegate-pi" }, () => {
		prepareHome(home, "pi");
		assert.equal(fs.existsSync(path.join(home, ".delegate-pi", "agent", "settings.json")), true);
		assert.equal(fs.existsSync(path.join(home, ".pi", "agent", "settings.json")), false);
	});
});
