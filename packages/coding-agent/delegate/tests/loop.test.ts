import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopGuard } from "../core/loop.ts";

test("a repeated call steers once, then stops, and a file change clears it", () => {
	const guard = createLoopGuard();
	const call = () => guard.observe("bash", { command: "npm test" });
	assert.equal(call().action, "none");
	assert.equal(call().action, "none");
	const steer = call();
	assert.ok(steer.action === "steer");
	assert.equal(steer.count, 3);
	assert.match(steer.message!, /npm test/);
	assert.equal(call().action, "none");
	const stop = call();
	assert.ok(stop.action === "stop");
	assert.equal(stop.count, 5);

	guard.progress();
	assert.equal(call().action, "none");
});

test("duplicate reports of the same tool call do not count, even after progress", () => {
	const guard = createLoopGuard();
	for (let i = 0; i < 6; i++) assert.equal(guard.observe("read", { path: "file" }, "t1").action, "none");
	guard.progress();
	assert.equal(guard.observe("read", { path: "file" }, "t1").action, "none");
	assert.equal(guard.observe("read", { path: "file" }, "t2").action, "none");
	assert.equal(guard.observe("read", { path: "file" }, "t3").action, "none");
	assert.equal(guard.observe("read", { path: "file" }, "t4").action, "steer");
});

test("the same arguments count even when the order of keys differs", () => {
	const guard = createLoopGuard();
	assert.equal(guard.observe("search", { nested: { a: 1, b: 2 } }).action, "none");
	assert.equal(guard.observe("search", { nested: { b: 2, a: 1 } }).action, "none");
	assert.equal(guard.observe("search", { nested: { a: 1, b: 2 } }).action, "steer");
});

test("different calls are not a loop", () => {
	const guard = createLoopGuard();
	for (const command of ["npm test", "npm run lint", "npm run build", "npm test", "npm run lint"]) {
		assert.equal(guard.observe("bash", { command }).action, "none");
	}
});
