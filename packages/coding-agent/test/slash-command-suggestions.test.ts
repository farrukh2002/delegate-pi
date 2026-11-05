import { describe, expect, it } from "vitest";
import { commandWord, editDistance, suggestCommand, unknownCommandTip } from "../src/core/slash-command-suggestions.ts";

const COMMANDS = ["exit", "quit", "settings", "model", "compact", "resume", "skill:review", "delegate-tasks"];

describe("commandWord", () => {
	it("reads the command name", () => {
		expect(commandWord("/exit")).toBe("exit");
		expect(commandWord("/model gpt-5")).toBe("model");
		expect(commandWord("  /compact now")).toBe("compact");
	});

	it("ignores text that is not a command", () => {
		expect(commandWord("hello /exit")).toBeUndefined();
		expect(commandWord("/")).toBeUndefined();
		expect(commandWord("/usr/bin/env")).toBeUndefined();
		expect(commandWord("/2fast")).toBeUndefined();
	});
});

describe("editDistance", () => {
	it("counts edits", () => {
		expect(editDistance("exit", "exit")).toBe(0);
		expect(editDistance("exiy", "exit")).toBe(1);
		expect(editDistance("exot", "exit")).toBe(1);
		expect(editDistance("ex", "exit")).toBe(2);
	});
});

describe("suggestCommand", () => {
	it("finds a close command", () => {
		expect(suggestCommand("exiy", COMMANDS)).toBe("exit");
		expect(suggestCommand("setings", COMMANDS)).toBe("settings");
		expect(suggestCommand("compcat", COMMANDS)).toBe("compact");
	});

	it("stays quiet when nothing is close", () => {
		expect(suggestCommand("usr", COMMANDS)).toBeUndefined();
		expect(suggestCommand("home", COMMANDS)).toBeUndefined();
	});
});

describe("unknownCommandTip", () => {
	it("suggests the intended command", () => {
		expect(unknownCommandTip("/exiy", COMMANDS)).toBe("Unknown command /exiy. Did you mean /exit?");
		expect(unknownCommandTip("/exiy now please", COMMANDS)).toBe("Unknown command /exiy. Did you mean /exit?");
		expect(unknownCommandTip("/setings", COMMANDS)).toBe("Unknown command /setings. Did you mean /settings?");
	});

	it("accepts known commands, including skills and extension commands", () => {
		expect(unknownCommandTip("/exit", COMMANDS)).toBeUndefined();
		expect(unknownCommandTip("/skill:review src/a.ts", COMMANDS)).toBeUndefined();
		expect(unknownCommandTip("/delegate-tasks", COMMANDS)).toBeUndefined();
	});

	it("leaves paths and prose as prompts", () => {
		expect(unknownCommandTip("/usr/bin/env node", COMMANDS)).toBeUndefined();
		expect(unknownCommandTip("/home/farrukh/project", COMMANDS)).toBeUndefined();
		expect(unknownCommandTip("what is /exit", COMMANDS)).toBeUndefined();
	});
});
