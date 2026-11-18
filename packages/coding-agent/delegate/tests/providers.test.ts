import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../core/providers.ts";

test("the Pi child runs RPC, keeps stdin open for steering, and sends no prompt argument", () => {
	assert.equal(PROVIDERS.pi.stdin, "rpc");
	const invocation = PROVIDERS.pi.build({ prompt: "the task" });
	const mode = invocation.args.indexOf("--mode");
	assert.equal(invocation.args[mode + 1], "rpc");
	assert.ok(!invocation.args.includes("-p"));
	assert.ok(!invocation.args.includes("the task"));
});

test("the other providers still take the prompt as their last argument", () => {
	for (const id of ["claude", "codex", "commandcode"] as const) {
		const invocation = PROVIDERS[id].build({ prompt: "the task" });
		assert.equal(invocation.args.at(-1), "the task", id);
		assert.equal(PROVIDERS[id].stdin, undefined, id);
	}
});
