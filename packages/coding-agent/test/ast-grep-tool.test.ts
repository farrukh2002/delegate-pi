import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAstGrepToolDefinition } from "../src/core/tools/ast-grep.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

const binary = getToolPath("ast-grep");

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe.skipIf(!binary)("ast_grep tool", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "ast-grep-tool-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(
			join(dir, "src", "a.ts"),
			[
				"export function add(a: number, b: number) {",
				"\treturn a + b;",
				"}",
				"",
				"const total = add(1, 2);",
				"console.log(add(3, 4));",
			].join("\n"),
		);
		writeFileSync(
			join(dir, "src", "b.ts"),
			[
				'import { add } from "./a.ts";',
				"",
				"export class Counter {",
				"\tcount = 0;",
				"\tstep() {",
				"\t\tthis.count = add(this.count, 1);",
				"\t\treturn this;",
				"\t}",
				"}",
				"",
				"new Counter().step();",
			].join("\n"),
		);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const run = (input: Record<string, unknown>) =>
		createAstGrepToolDefinition(dir, { binaryPath: binary! }).execute(
			"id",
			input as never,
			undefined,
			undefined,
			undefined as never,
		);

	it("groups pattern matches by file with relative paths", async () => {
		const output = text(await run({ pattern: "add($A, $B)", lang: "ts", path: "src/a.ts" }));
		expect(output.split("\n")).toEqual(["src/a.ts", "  5: const total = add(1, 2);", "  6: console.log(add(3, 4));"]);
	});

	it("shows the line range of multi-line matches", async () => {
		const output = text(await run({ kind: "function_declaration", lang: "ts" }));
		expect(output).toBe("src/a.ts\n  1-3: export function add(a: number, b: number) {");
	});

	it("shows whole matches with body", async () => {
		const output = text(await run({ kind: "function_declaration", lang: "ts", body: true }));
		expect(output.split("\n")).toEqual([
			"src/a.ts",
			"  1: export function add(a: number, b: number) {",
			"  2: \treturn a + b;",
			"  3: }",
		]);
	});

	it("returns the full definition of a symbol and of a class member", async () => {
		const fn = text(await run({ symbol: "add" }));
		expect(fn).toContain("src/a.ts\n  1: export function add(a: number, b: number) {\n  2: \treturn a + b;\n  3: }");
		expect(fn).not.toContain("src/b.ts");

		const method = text(await run({ symbol: "Counter.step" }));
		expect(method.split("\n")).toEqual([
			"src/b.ts",
			"  5: \tstep() {",
			"  6: \t\tthis.count = add(this.count, 1);",
			"  7: \t\treturn this;",
			"  8: \t}",
		]);
	});

	it("lists callers with the function that contains each call", async () => {
		const output = text(await run({ callers: "add" }));
		expect(output.split("\n")).toEqual([
			"src/a.ts",
			"  5 in total: const total = add(1, 2);",
			"  6: console.log(add(3, 4));",
			"src/b.ts",
			"  6 in Counter.step: this.count = add(this.count, 1);",
		]);
		expect(text(await run({ callers: "step" }))).toBe("src/b.ts\n  11: new Counter().step();");
		expect(text(await run({ callers: "Counter" }))).toBe("src/b.ts\n  11: new Counter().step();");
	});

	it("outlines files", async () => {
		const output = text(await run({ outline: true, path: "src/a.ts" }));
		expect(output).toContain("src/a.ts");
		expect(output).toContain("add");
	});

	it("stops at the match limit", async () => {
		const output = text(await run({ pattern: "add($$$)", lang: "ts", limit: 1 }));
		expect(output).toContain("1 matches limit reached");
	});

	it("reports no matches and rejects bad queries", async () => {
		expect(text(await run({ pattern: "missing()", lang: "ts" }))).toBe("No matches found");
		expect(text(await run({ symbol: "missing" }))).toBe("No matches found");
		await expect(run({})).rejects.toThrow("Give symbol, callers, pattern, kind, or outline");
		await expect(run({ kind: "function_declaration" })).rejects.toThrow("kind needs lang");
		await expect(run({ callers: "a b" })).rejects.toThrow("Not a valid name");
	});
});
