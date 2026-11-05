import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../core/providers.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { agentProblem, enabledProviders, toToolList } from "../core/agents.ts";
import { readyAgents, unavailableText } from "../core/view.ts";
import { activityLine } from "../core/core.ts";

test("toToolList normalizes strings, bracket lists and arrays", () => {
	assert.deepEqual(toToolList("read, edit"), ["read", "edit"]);
	assert.deepEqual(toToolList("[read,edit]"), ["read", "edit"]);
	assert.deepEqual(toToolList(["read", " edit "]), ["read", "edit"]);
	assert.equal(toToolList(undefined), undefined);
	assert.equal(toToolList(""), undefined);
	assert.equal(toToolList([]), undefined);
	assert.equal(toToolList("  , "), undefined);
});

test("pi maps the tools list to --tools", () => {
	const invocation = PROVIDERS.pi.build({ prompt: "p", tools: ["read", "edit"] });
	const index = invocation.args.indexOf("--tools");
	assert.ok(index > -1);
	assert.equal(invocation.args[index + 1], "read,edit");
});

test("claude maps the tools list to --allowedTools", () => {
	const invocation = PROVIDERS.claude.build({ prompt: "p", tools: ["Read", "Edit"] });
	const index = invocation.args.indexOf("--allowedTools");
	assert.ok(index > -1);
	assert.equal(invocation.args[index + 1], "Read,Edit");
});

test("no tool flag is added when the list is empty", () => {
	for (const id of ["pi", "claude", "codex", "commandcode"] as const) {
		const invocation = PROVIDERS[id].build({ prompt: "p", tools: [] });
		assert.equal(invocation.args.includes("--tools"), false);
		assert.equal(invocation.args.includes("--allowedTools"), false);
	}
});

test("commandcode tool calls and text become activity", () => {
	const events = PROVIDERS.commandcode.parse({
		type: "event",
		event: {
			type: "message_end",
			content: [
				{ type: "text", text: "Reading the module." },
				{ type: "tool_use", id: "c1", name: "read_file", input: { file_path: "/workspace/go.mod" } },
				{ type: "thinking", thinking: "x" },
			],
		},
	});
	assert.equal(events.length, 1);
	const event = events[0]!;
	assert.ok(event.kind === "message");
	assert.deepEqual(event.content.map(activityLine), ["Reading the module.", "read_file /workspace/go.mod"]);
	assert.deepEqual(PROVIDERS.commandcode.parse({ type: "event", event: { type: "message_end", content: [] } }), []);
});

test("codex and commandcode have no tools flag to map", () => {
	for (const id of ["codex", "commandcode"] as const) {
		const invocation = PROVIDERS[id].build({ prompt: "p", tools: ["read", "edit"] });
		assert.equal(invocation.args.includes("--tools"), false);
		assert.equal(invocation.args.includes("--allowedTools"), false);
		assert.equal(invocation.args.includes("read,edit"), false);
	}
});

test("agents whose CLI is missing or not chosen at install are not ready", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-path-"));
	const oldPath = process.env.PATH;
	try {
		fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
		process.env.PATH = dir;
		const all = ["pi", "claude", "codex", "commandcode"] as const;
		assert.equal(agentProblem({ provider: "codex" }, [...all]), undefined);
		assert.equal(agentProblem({ provider: "claude" }, [...all]), "the claude CLI is not installed");
		assert.equal(agentProblem({ provider: "codex" }, ["pi"]), "codex was not chosen at install (providers.json)");
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("providers.json limits the enabled providers and falls back to all", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-providers-"));
	try {
		const file = path.join(dir, "providers.json");
		fs.writeFileSync(file, JSON.stringify({ providers: ["pi", "codex", "bogus"] }));
		assert.deepEqual(enabledProviders(file), ["pi", "codex"]);
		fs.writeFileSync(file, JSON.stringify({ providers: [] }));
		assert.deepEqual(enabledProviders(file), ["pi", "claude", "codex", "commandcode"]);
		assert.deepEqual(enabledProviders(path.join(dir, "missing.json")), ["pi", "claude", "codex", "commandcode"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the agents command marks each agent ready or not", () => {
	const cli = path.join(import.meta.dirname, "..", "core", "delegate.mjs");
	const env = { ...process.env, PATH: path.dirname(process.execPath), DELEGATE_PROVIDERS_FILE: "/nonexistent" };
	const agents = JSON.parse(execFileSync(process.execPath, [cli, "agents"], { encoding: "utf8", env }));
	const worker = agents.find((agent: any) => agent.name === "cx-worker");
	assert.equal(worker.ready, false);
	assert.equal(worker.problem, "the codex CLI is not installed");
});

test("hosts list only ready agents and name the missing ones", () => {
	const agents = [
		{ name: "cmd-worker", ready: true },
		{ name: "cx-worker", ready: false, problem: "the codex CLI is not installed" },
		{ name: "old-host" },
	];
	assert.deepEqual(readyAgents(agents).map((agent) => agent.name), ["cmd-worker", "old-host"]);
	assert.match(unavailableText(agents), /^Not available on this machine: cx-worker \(the codex CLI is not installed\)\./);
	assert.equal(unavailableText([{ name: "cmd-worker", ready: true }]), "");
});
