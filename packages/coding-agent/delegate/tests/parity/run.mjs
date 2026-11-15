import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { diff } from "./compare.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i < 0 ? fallback : process.argv[i + 1];
};
const impl = arg("--impl", "js");
const only = arg("--only");
const writeGolden = process.argv.includes("--golden");
const keep = process.argv.includes("--keep");

const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled", "timed_out"]);
const VOLATILE = new Set([
	"createdAt",
	"startedAt",
	"durationMs",
	"finishedAt",
	"heartbeat",
	"workerPid",
	"childPid",
	"lastOutputAt",
	"logPath",
	"cwd",
	"queuedBehind",
]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-parity-")));
const data = path.join(base, "data");
process.env.DELEGATE_DATA = data;
process.env.PATH = "/usr/bin:/bin";
for (const key of Object.keys(process.env)) {
	if (/_API_KEY$|_OAUTH_TOKEN$|^ANTHROPIC_|^OPENAI_|^ZAI_|^COMMANDCODE_|^GEMINI_/.test(key)) delete process.env[key];
	delete process.env.DELEGATE_AGENTS_DIR;
	delete process.env.DELEGATE_DEFAULT_AGENTS_DIR;
}

const core = await import("../../core/core.ts");
const workspace = await import("../../core/workspace.ts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scenarios = JSON.parse(fs.readFileSync(path.join(here, "scenarios.json"), "utf8"));

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

function clean(value, roots) {
	if (typeof value === "string") {
		const text = value
			.split(roots.data)
			.join("<data>")
			.split(roots.project)
			.join("<project>")
			.split(roots.base)
			.join("<base>");
		return text.replace(UUID, "<uuid>");
	}
	if (Array.isArray(value)) return value.map((item) => clean(item, roots));
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			if (VOLATILE.has(key)) continue;
			out[key] = clean(value[key], roots);
		}
		return out;
	}
	return value;
}

function setup(name, scenario) {
	const dir = fs.mkdtempSync(path.join(base, `s-${name}-`));
	const project = path.join(dir, "project");
	const pkg = path.join(dir, "pkg");
	fs.mkdirSync(project);
	fs.mkdirSync(pkg);
	git(project, ["init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(project, "README.md"), "project\n");
	for (const [rel, text] of Object.entries(scenario.files ?? {})) {
		fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
		fs.writeFileSync(path.join(project, rel), text);
	}
	git(project, ["add", "-A"]);
	git(project, ["commit", "-q", "-m", "init"]);
	if (scenario.preclaim) {
		const holder = path.join(data, "tasks", scenario.preclaim.taskId);
		fs.mkdirSync(holder, { recursive: true });
		fs.writeFileSync(
			path.join(holder, "state.json"),
			JSON.stringify({
				taskId: scenario.preclaim.taskId,
				status: "running",
				workerPid: process.pid,
				heartbeat: Date.now(),
				createdAt: Date.now(),
			}),
		);
		workspace.claimPaths(project, scenario.preclaim.taskId, "other", [scenario.preclaim.path]);
	}
	const fake = path.join(pkg, "cli.mjs");
	fs.copyFileSync(path.join(here, "fake-pi.mjs"), fake);
	if (scenario.fake) {
		const wrapper = path.join(pkg, scenario.fake);
		fs.writeFileSync(wrapper, `#!/bin/sh\nexec node "$(dirname "$0")/cli.mjs" "$@"\n`);
		fs.chmodSync(wrapper, 0o755);
	}
	process.env.PATH = `${pkg}:/usr/bin:/bin`;
	const script = path.join(pkg, "script.json");
	fs.writeFileSync(script, JSON.stringify({ steps: scenario.steps }));
	process.env.DELEGATE_PI_ENTRY = fake;
	process.env.DELEGATE_PI_PACKAGE_DIR = pkg;
	process.env.DELEGATE_WORKER = impl;
	return { dir, project };
}

async function run(name, scenario) {
	const where = setup(name, scenario);
	const roots = { base, data, project: where.project };
	const started = core.start({
		task: `parity ${name}`,
		provider: scenario.provider ?? "pi",
		scope: scenario.scope,
		runtimeMode: scenario.runtimeMode,
		cwd: where.project,
		timeoutMs: 60000,
		noProgressMs: scenario.noProgressMs,
	});
	const trace = [];
	const t0 = Date.now();
	let answered = false;
	let cancelled = false;
	try {
		for (;;) {
			const state = core.status(started.taskId);
			const snap = clean(state, roots);
			if (!trace.length || JSON.stringify(trace.at(-1).state) !== JSON.stringify(snap)) {
				trace.push({ step: trace.length, state: snap });
			}
			if (state.pending?.length && scenario.answer && !answered) {
				try {
					core.answer(started.taskId, state.pending[0].id, scenario.answer);
					answered = true;
				} catch {}
			}
			if (scenario.cancelAfterMs && !cancelled && Date.now() - t0 >= scenario.cancelAfterMs) {
				cancelled = true;
				try {
					await core.cancel(started.taskId);
				} catch {}
			}
			if (TERMINAL.has(state.status)) break;
			if (Date.now() - t0 > (scenario.maxMs ?? 90000)) throw new Error(`timeout: ${JSON.stringify(state)}`);
			await sleep(100);
		}
	} catch (error) {
		try {
			await core.cancel(started.taskId);
		} catch {}
		throw error;
	}
	const last = trace.at(-1).state;
	const statuses = [];
	for (const entry of trace) if (!statuses.includes(entry.state.status)) statuses.push(entry.state.status);
	return {
		scenario: name,
		impl,
		statuses,
		status: last.status,
		turns: last.usage?.turns,
		input: last.usage?.input,
		output: last.usage?.output,
		costUsd: last.costUsd,
		diffstat: last.diffstat,
		final: last,
		trace,
	};
}

const results = [];
let failures = 0;
for (const [name, scenario] of Object.entries(scenarios)) {
	if (only && name !== only) continue;
	const result = await run(name, scenario);
	results.push(result);
	const file = path.join(here, writeGolden ? "golden" : "trace", `${writeGolden ? name : `${impl}-${name}`}.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(result, null, "\t")}\n`);
	if (!writeGolden) {
		const goldenFile = path.join(here, "golden", `${name}.json`);
		if (fs.existsSync(goldenFile)) {
			const golden = JSON.parse(fs.readFileSync(goldenFile, "utf8"));
			const lines = diff({ statuses: golden.statuses, final: golden.final }, { statuses: result.statuses, final: result.final });
			if (lines.length) {
				failures += 1;
				console.log(`\n${name}: ${lines.length} differences`);
				for (const line of lines.slice(0, 20)) console.log(`  ${line}`);
			}
		}
	}
}

console.log("");
console.log(["scenario", "statuses", "status", "turns", "in", "out", "cost", "changes"].join("\t"));
for (const result of results) {
	console.log(
		[
			result.scenario,
			result.statuses.join(">"),
			result.status,
			result.turns ?? "",
			result.input ?? "",
			result.output ?? "",
			result.costUsd ?? "",
			result.diffstat ?? "",
		].join("\t"),
	);
}

if (!keep) fs.rmSync(base, { recursive: true, force: true });
if (failures) {
	console.log(`\n${failures} scenario(s) differ from golden`);
	process.exitCode = 1;
} else if (!writeGolden && results.length) {
	console.log("\nall scenarios match golden");
}
