import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBudget } from "../core/budget.ts";

test("the last allowed turn can finish but cannot start another", () => {
	assert.equal(checkBudget({}, { turns: 99, contextTokens: 0 }, undefined, true).stop, undefined);
	const limits = { maxTurns: 4 };
	const usage = { turns: 4, contextTokens: 0 };
	assert.equal(checkBudget(limits, usage).stop, undefined);
	assert.match(checkBudget(limits, usage, undefined, true).stop!, /ran 4 turns, the limit is 4/);
	assert.match(checkBudget(limits, { ...usage, turns: 5 }).stop!, /ran 5 turns, the limit is 4/);
});

test("the context budget warns at 80 percent and stops above the limit", () => {
	assert.equal(checkBudget({ contextBudget: 1000 }, { turns: 1, contextTokens: 500 }).notice, undefined);
	assert.match(
		checkBudget({ contextBudget: 1000 }, { turns: 1, contextTokens: 800 }).notice!,
		/800 of 1000 tokens/,
	);
	assert.equal(checkBudget({ contextBudget: 1000 }, { turns: 1, contextTokens: 1000 }, "already warned").notice, undefined);
	assert.match(
		checkBudget({ contextBudget: 1000 }, { turns: 1, contextTokens: 1001 }, "already warned").stop!,
		/above the budget of 1000/,
	);
});
