import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { agentEntry, APPROVAL, cliPath, dataDir, detailText, modelDescription, noticeText, permissionText, reportText, toTaskView } from "../core/view.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("each host copy of view.ts is the same as core/view.ts", () => {
	const copies = ["hosts/claude/hooks/view.ts", "../src/core/delegate/view.ts"].map(rel => path.join(ROOT, rel)).filter(file => fs.existsSync(file));
	assert.ok(copies.length > 0);
	const source = fs.readFileSync(path.join(ROOT, "core/view.ts"), "utf8");
	for (const file of copies) assert.equal(fs.readFileSync(file, "utf8"), source, file);
});

test("the view keeps old values and shows the full summary and peak context", () => {
	const first = toTaskView({ taskId: "t1", agent: "pi-worker", provider: "pi", status: "running", scope: ["src"], task: "do it", startedAt: 1000 });
	const done = toTaskView({ taskId: "t1", status: "completed", durationMs: 4000, summary: "x".repeat(700), usage: { turns: 3, contextTokens: 9000 }, diffstat: " 1 file changed, 2 insertions(+), 1 deletion(-)", costUsd: 0.5 }, first);
	assert.equal(done.agent, "pi-worker");
	assert.equal(done.summary?.length, 600);
	const detail = detailText(done);
	assert.match(detail, /\[pi-worker \/ pi\] completed \| 4s \| 3 turns \| peak context 9000 \| \$0\.5000 \| t1/);
	assert.ok(detail.includes("x".repeat(700)));
	assert.match(detail, /accept or undo, taskId t1/);
	assert.match(reportText([done]), /^1\/1 completed/);
	assert.match(noticeText([done]), /✓ pi-worker t1 completed 4s, changed src \+2 -1, accept or undo/);
});

test("answers, agents and paths use one rule for all hosts", () => {
	assert.ok(APPROVAL.test("Yes") && !APPROVAL.test("no"));
	assert.equal(permissionText({ id: "p", kind: "permission", question: "Run?", tool: "bash", input: { command: "ls" } }), "Run?\nTool: bash\nArguments: {\"command\":\"ls\"}");
	assert.deepEqual(agentEntry("---\nname: cx-worker\nprovider: codex\n---\n"), { name: "cx-worker", provider: "codex", model: undefined });
	assert.equal(agentEntry("no name"), undefined);
	assert.match(modelDescription([{ name: "a", provider: "pi" }]), /Agent defaults: a=pi default\./);
	assert.equal(dataDir({ XDG_STATE_HOME: "/s" }, "/h"), "/s/delegate");
	assert.equal(dataDir({ XDG_STATE_HOME: "rel" }, "/h"), "/h/.local/state/delegate");
	assert.equal(dataDir({ DELEGATE_DATA: "/d" }, "/h"), "/d");
	assert.equal(cliPath({}, "/h"), "/h/.local/share/delegate/delegate.mjs");
});
