import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activityLine, makeSave } from "../core/core.ts";

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-")));
	created.push(dir);
	return dir;
}

test("save writes state.json only when the state changes", () => {
	const dir = tempDir();
	const file = path.join(dir, "state.json");
	const state = { status: "running", usage: { turns: 0 } };
	const save = makeSave(file, state);
	save();
	assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(state));
	const first = fs.statSync(file).mtimeMs;
	save();
	assert.equal(fs.statSync(file).mtimeMs, first);
	state.usage.turns = 1;
	save();
	assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(state));
	assert.equal(state.usage.turns, 1);
});

test("activityLine names the tool and its target, or the first text line", () => {
	assert.equal(activityLine({ type: "toolCall", name: "edit", arguments: { path: "core/core.ts", old: "a" } }), "edit core/core.ts");
	assert.equal(activityLine({ type: "toolCall", name: "bash", arguments: { command: "npm  test\n" } }), "bash npm test");
	assert.equal(activityLine({ type: "toolCall", name: "list", arguments: {} }), "list");
	assert.equal(activityLine({ type: "text", text: "\n  Done. All pass.\nmore" }), "Done. All pass.");
	assert.equal(activityLine({ type: "text", text: "  " }), undefined);
});
