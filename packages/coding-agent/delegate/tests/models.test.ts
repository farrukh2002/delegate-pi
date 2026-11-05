import "./setup.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { DATA } from "../core/workspace.ts";
import { checkModel, listModels, parseCodexModels, parseCommandcodeModels, parsePiModels } from "../core/models.ts";

const piFixture = `provider model context max-out thinking images
openai gpt-test 128K 16K yes yes
anthropic claude-test 200K 8K no yes`;

test("parsePiModels returns provider-qualified ids and thinking efforts", () => {
	assert.deepEqual(parsePiModels(piFixture), [
		{ id: "openai/gpt-test", efforts: ["off", "minimal", "low", "medium", "high", "xhigh"] },
		{ id: "anthropic/claude-test" },
	]);
});

test("parseCodexModels skips hidden models and preserves descriptions and efforts", () => {
	const input = JSON.stringify({ models: [
		{ slug: "gpt-codex", description: "Coding model", visibility: "show", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "low" }] },
		{ slug: "hidden", description: "Hidden", visibility: "hide", supported_reasoning_levels: [] },
	] });
	assert.deepEqual(parseCodexModels(input), [{ id: "gpt-codex", description: "Coding model", efforts: ["low", "high"] }]);
});

test("parseCommandcodeModels filters headings and accepts model descriptions", () => {
	assert.deepEqual(parseCommandcodeModels("Available models\nOpen Source\nAnthropic\nqwen-3  Open source Qwen\nclaude-sonnet  Anthropic Sonnet"), [
		{ id: "qwen-3", description: "Open source Qwen" },
		{ id: "claude-sonnet", description: "Anthropic Sonnet" },
	]);
});

test("listModels caches successful discovery results for 24 hours", () => {
	const cache = path.join(DATA, "models", "pi.json");
	fs.rmSync(cache, { force: true });
	let calls = 0;
	const run = (command: string, args: string[], timeoutMs: number) => {
		calls++;
		assert.equal(command, "pi");
		assert.deepEqual(args, ["--list-models"]);
		assert.equal(timeoutMs, 30000);
		return piFixture;
	};
	const first = listModels("pi", { refresh: true, run });
	const cached = listModels("pi", { run: () => { throw new Error("cache miss"); } });
	assert.equal(calls, 1);
	assert.deepEqual(cached, first);
	assert.equal(cached.models.length, 2);
});

test("checkModel validates exact provider models and pi effort suffixes", () => {
	const run = (_command: string, _args: string[], _timeoutMs: number) => piFixture;
	checkModel("pi", "openai/gpt-test:high", { run });
	checkModel("pi", "gpt-test:medium", { run });
	assert.throws(() => checkModel("pi", "openai/gpt-test:invalid", { run }), /Unknown model openai\/gpt-test:invalid for provider pi/);

	const codexRun = () => JSON.stringify({ models: [{ slug: "gpt-codex", visibility: "show" }, { slug: "gpt-codex-mini", visibility: "show" }] });
	checkModel("codex", "gpt-codex", { run: codexRun });
	assert.throws(() => checkModel("codex", "gpt", { run: codexRun }), error => {
		assert.match(String(error), /Close matches: gpt-codex, gpt-codex-mini/);
		assert.match(String(error), /Run delegate models --provider codex for the list\./);
		return true;
	});
});

test("listModels returns an empty error result for failed CLIs", () => {
	const result = listModels("commandcode", { refresh: true, run: () => { throw new Error("CLI unavailable"); } });
	assert.deepEqual(result.models, []);
	assert.match(result.error ?? "", /CLI unavailable/);
	assert.equal(fs.existsSync(path.join(DATA, "models", "commandcode.json")), false);
	const next = listModels("commandcode", { run: () => "vendor/model-a  First model" });
	assert.deepEqual(next.models, [{ id: "vendor/model-a", description: "First model" }]);
});

test("checkModel finds close matches for a pi model with an effort suffix", () => {
	const run = () => piFixture;
	assert.throws(() => checkModel("pi", "openai/gpt-tes:high", { run }), /Close matches: openai\/gpt-test\./);
});
