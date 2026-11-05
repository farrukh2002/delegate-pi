import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID = "11111111-1111-4111-8111-111111111111";

function run(depth: string) {
	return spawnSync(process.execPath, [path.join(ROOT, "core/delegate.mjs"), "status", "--task-id", ID], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, DELEGATE_DEPTH: depth },
	});
}

test("a delegated child cannot delegate again", () => {
	const nested = run("1");
	assert.equal(nested.status, 1);
	assert.match(nested.stdout, /Nested delegation is disabled/);
});

test("the parent CLI is not blocked by the nested-delegation guard", () => {
	const parent = run("0");
	assert.equal(parent.stdout.includes("Nested delegation is disabled"), false);
});
