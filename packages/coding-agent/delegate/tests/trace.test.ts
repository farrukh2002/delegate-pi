import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { traceWriter } from "../core/trace.ts";

test("the child trace is Claude-shaped, deduplicated, and keeps tool failures", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-trace-"));
	const file = path.join(dir, "trace.jsonl");
	const trace = traceWriter(file, "fix the failing test", () => "gpt-test");
	trace.event({
		kind: "message",
		id: "m1",
		role: "assistant",
		model: "gpt-test",
		usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
		content: [
			{ type: "text", text: "I will run the test." },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pytest -q" } },
		],
	});
	trace.event({
		kind: "toolResult",
		toolCallId: "t1",
		name: "bash",
		content: "FAILED tests/test_a.py::test_x - AssertionError",
		isError: true,
	});
	// A provider that reports the same call and result twice must not double the evidence.
	trace.event({
		kind: "message",
		role: "assistant",
		content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pytest -q" } }],
	});
	trace.event({
		kind: "toolResult",
		toolCallId: "t1",
		name: "bash",
		content: "FAILED tests/test_a.py::test_x - AssertionError",
		isError: true,
	});
	// Usage on a turn event with no content still belongs to the session.
	trace.event({ kind: "message", role: "assistant", content: [], usage: { input: 1, output: 2 } });
	trace.close();

	const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	fs.rmSync(dir, { recursive: true, force: true });

	assert.equal(lines[0].type, "user");
	assert.equal(lines[0].message.content, "fix the failing test");
	assert.equal(lines[1].type, "assistant");
	assert.equal(lines[1].message.id, "m1");
	assert.equal(lines[1].message.model, "gpt-test");
	assert.deepEqual(lines[1].message.usage, {
		input_tokens: 10,
		output_tokens: 5,
		cache_read_input_tokens: 100,
		cache_creation_input_tokens: 20,
	});
	assert.deepEqual(lines[1].message.content[1], {
		type: "tool_use",
		id: "t1",
		name: "bash",
		input: { command: "pytest -q" },
	});
	assert.equal(lines[2].type, "user");
	assert.equal(lines[2].message.content[0].type, "tool_result");
	assert.equal(lines[2].message.content[0].tool_use_id, "t1");
	assert.equal(lines[2].message.content[0].is_error, true);
	assert.match(lines[2].message.content[0].content, /AssertionError/);
	assert.equal(lines.length, 4);
	assert.equal(lines[3].message.content.length, 0);
	assert.equal(lines[3].message.usage.input_tokens, 1);
});
