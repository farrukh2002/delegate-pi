import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PI_DEPS_MOUNT, prepareHome, sandboxInvocation } from "../core/sandbox.ts";
import { git, gitMounts, scopeLayout } from "../core/workspace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = fs.realpathSync(path.resolve(HERE, "..", ".."));
const BUNDLE = path.join(PACKAGE_DIR, "dist", "bundle", "cli.js");
const JITI = jitiDir();

const SKIP = spawnSync("bwrap", ["--version"]).status !== 0 || !fs.existsSync(BUNDLE);

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

function jitiDir(): string | undefined {
	try {
		return path.dirname(createRequire(path.join(PACKAGE_DIR, "index.js")).resolve("jiti/package.json"));
	} catch {
		return undefined;
	}
}

function tempDir(prefix = "delegate-bundle-"): string {
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

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
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

function packageEnv(sourceAgent: string): Record<string, string> {
	return { ...NO_KEYS, DELEGATE_PI_ENTRY: BUNDLE, DELEGATE_PI_PACKAGE_DIR: PACKAGE_DIR, DELEGATE_PI_CONFIG_DIR: ".delegate-pi", DELEGATE_PI_CODING_AGENT_DIR: sourceAgent };
}

function makeTaskDir(): { taskDir: string; privateHome: string } {
	const taskDir = tempDir();
	fs.mkdirSync(path.join(taskDir, "ipc"), { recursive: true });
	return { taskDir, privateHome: path.join(taskDir, "home") };
}

function invocationFor(extensions: string[], provider: string, model: string): { command: string; args: string[]; flagOffset: number } {
	const args = [BUNDLE, "--mode", "json", "--no-mcp", "--no-extensions", "--no-session"];
	for (const extension of extensions) args.push("--extension", extension);
	args.push("--provider", provider, "--model", model, "-p", "test");
	return { command: process.execPath, args, flagOffset: 1 };
}

function runAsync(command: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, output }));
	});
}

function fixtureProvider(url: string): string {
	return `export default function (pi) {
  pi.registerProvider("offline-fake", {
    name: "Offline Fake",
    baseUrl: ${JSON.stringify(url)},
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        type: "chat",
        id: "offline-model",
        name: "Offline Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
`;
}

async function startFakeOpenAI(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
		req.resume();
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
			`data: ${JSON.stringify({ id: "chatcmpl-offline", object: "chat.completion.chunk", created: 0, model: "offline-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
		res.write(chunk({ role: "assistant", content: "offline-ok" }, null));
		res.write(chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1 }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the bundled pi loads the child bridge from the mounted package with its external jiti dependency", { skip: SKIP }, async () => {
	assert.ok(JITI, "the installed jiti dependency must resolve from the package");
	const project = repo();
	const { taskDir, privateHome } = makeTaskDir();
	const sourceAgent = tempDir();
	await withEnv(packageEnv(sourceAgent), () => {
		prepareHome(privateHome, "pi");
		const mounted = { project, layout: scopeLayout(project, []), scratch: [], git: gitMounts(project) };
		const wrapped = sandboxInvocation(invocationFor(["/delegate/child-pi.ts"], "offline-missing-provider", "offline-missing-model"), mounted, taskDir, "pi", "full-access");
		assert.ok(wrapped.args.includes(path.join(PI_DEPS_MOUNT, "node_modules/jiti")), "the external jiti dependency is mounted");
		assert.equal(wrapped.env.NODE_PATH, path.join(PI_DEPS_MOUNT, "node_modules"));
		const run = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8", timeout: 120000 });
		const output = `${run.stdout}\n${run.stderr}`;
		assert.doesNotMatch(output, /Failed to load extension/);
		assert.doesNotMatch(output, /Cannot find module 'jiti'/);
		assert.match(output, /Unknown provider "offline-missing-provider"/);
	});
});

test("the bundled pi completes an offline prompt through the child bridge and a fixture provider", { skip: SKIP, timeout: 120000 }, async () => {
	const project = repo();
	const { taskDir, privateHome } = makeTaskDir();
	const sourceAgent = tempDir();
	const server = await startFakeOpenAI();
	try {
		fs.writeFileSync(path.join(project, "offline-provider.ts"), fixtureProvider(server.url));
		await withEnv(packageEnv(sourceAgent), async () => {
			prepareHome(privateHome, "pi");
			const mounted = { project, layout: scopeLayout(project, []), scratch: [], git: gitMounts(project) };
			const wrapped = sandboxInvocation(invocationFor(["/delegate/child-pi.ts", "/workspace/offline-provider.ts"], "offline-fake", "offline-model"), mounted, taskDir, "pi", "full-access");
			const run = await runAsync(wrapped.command, wrapped.args, wrapped.env);
			assert.doesNotMatch(run.output, /Failed to load extension/);
			assert.match(run.output, /offline-ok/);
		});
	} finally {
		await server.close();
	}
});

test("sandboxInvocation resolves the external dependency for hoisted and installed package layouts", { skip: SKIP }, async () => {
	const hoistedRoot = tempDir();
	fs.mkdirSync(path.join(hoistedRoot, "node_modules", "jiti"), { recursive: true });
	fs.writeFileSync(path.join(hoistedRoot, "node_modules", "jiti", "package.json"), JSON.stringify({ name: "jiti", version: "2.7.0" }));
	const hoistedPkg = path.join(hoistedRoot, "pkg");
	fs.mkdirSync(path.join(hoistedPkg, "node_modules"), { recursive: true });
	fs.mkdirSync(path.join(hoistedPkg, "dist", "bundle"), { recursive: true });
	fs.writeFileSync(path.join(hoistedPkg, "dist", "bundle", "cli.js"), "");

	const installedPkg = tempDir();
	fs.mkdirSync(path.join(installedPkg, "node_modules", "jiti"), { recursive: true });
	fs.writeFileSync(path.join(installedPkg, "node_modules", "jiti", "package.json"), JSON.stringify({ name: "jiti", version: "2.7.0" }));
	fs.mkdirSync(path.join(installedPkg, "dist", "bundle"), { recursive: true });
	fs.writeFileSync(path.join(installedPkg, "dist", "bundle", "cli.js"), "");

	const cases: Array<[string, string, string]> = [
		[hoistedPkg, path.join(hoistedRoot, "node_modules", "jiti"), "hoisted"],
		[installedPkg, path.join(installedPkg, "node_modules", "jiti"), "installed"],
	];
	for (const [pkg, expected, label] of cases) {
		const { taskDir } = makeTaskDir();
		await withEnv({ ...NO_KEYS, DELEGATE_PI_ENTRY: path.join(pkg, "dist", "bundle", "cli.js"), DELEGATE_PI_PACKAGE_DIR: pkg, DELEGATE_PI_CONFIG_DIR: ".delegate-pi" }, () => {
			const mounted = { project: pkg, layout: scopeLayout(pkg, []), scratch: [], git: gitMounts(pkg) };
			const wrapped = sandboxInvocation(invocationFor(["/delegate/child-pi.ts"], "offline-missing-provider", "offline-missing-model"), mounted, taskDir, "pi", "full-access");
			assert.ok(wrapped.args.includes(expected), `the ${label} jiti dependency is mounted`);
			assert.equal(wrapped.env.NODE_PATH, path.join(PI_DEPS_MOUNT, "node_modules"));
		});
	}
});

test("prepareHome copies pi assets from the fork agent dir into an isolated child dir", async () => {
	const source = tempDir();
	fs.writeFileSync(path.join(source, "auth.json"), JSON.stringify({ marker: "source" }));
	fs.writeFileSync(path.join(source, "models.json"), JSON.stringify({ models: [] }));
	fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({ defaultProvider: "fake-provider", defaultModel: "fake-model" }));
	const home = tempDir();
	await withEnv({ DELEGATE_PI_CONFIG_DIR: ".delegate-pi", DELEGATE_PI_CODING_AGENT_DIR: source }, () => {
		prepareHome(home, "pi");
	});
	const childDir = path.join(home, ".delegate-pi", "agent");
	assert.notEqual(fs.realpathSync(childDir), fs.realpathSync(source));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(childDir, "auth.json"), "utf8")), { marker: "source" });
	assert.equal(fs.existsSync(path.join(childDir, "models.json")), true);
	const settings = JSON.parse(fs.readFileSync(path.join(childDir, "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, "fake-provider");
	assert.equal(settings.defaultModel, "fake-model");
	assert.equal(fs.existsSync(path.join(home, ".pi")), false);
});
