import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { WebEngineFetchResult } from "../src/core/web/client.ts";
import { askRenderers } from "../src/extensions/ask/renderers.ts";
import { createWebExtension, type WebExtensionClient } from "../src/extensions/web/index.ts";
import { webRenderers } from "../src/extensions/web/renderers.ts";
import type { WebToolSummary } from "../src/extensions/web/summary.ts";
import { keyHint } from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

function renderWeb(
	summary: WebToolSummary | undefined,
	options: { output?: string; expanded?: boolean; isError?: boolean } = {},
): string {
	const component = webRenderers.renderResult!(
		{ content: [{ type: "text", text: options.output ?? '{"raw":"json"}' }], details: summary },
		{ expanded: options.expanded ?? false, isPartial: false },
		theme,
		{ showImages: false, isError: options.isError ?? false, keyHint } as never,
	);
	return component
		.render(100)
		.map((line) => stripAnsi(line).trimEnd())
		.join("\n");
}

function renderAsk(details: { asked: boolean; answer?: string; dismissed?: boolean }): string {
	const component = askRenderers.renderResult!(
		{ content: [{ type: "text", text: "model text" }], details },
		{ expanded: false, isPartial: false },
		theme,
		{ showImages: false, isError: false } as never,
	);
	return component
		.render(100)
		.map((line) => stripAnsi(line).trimEnd())
		.join("\n");
}

describe("web tool result labels", () => {
	it("labels a fetched page with the HTTP status", () => {
		const output = renderWeb({ kind: "fetch", status: 200, access: "ok", truncated: false });
		expect(output).toContain("Page fetched · 200 OK");
		expect(output).toContain("to expand");
		expect(output).not.toContain("raw");
	});

	it.each([
		["blocked", 403, "Page blocked · 403 Forbidden"],
		["auth_required", 401, "Login required · 401 Unauthorized"],
		["http_error", 404, "Page not available · 404 Not Found"],
		["requires_javascript", 200, "Needs JavaScript · 200 OK"],
		["empty", 200, "Page is empty · 200 OK"],
	] as const)("labels a %s page", (access, status, label) => {
		expect(renderWeb({ kind: "fetch", status, access, truncated: false })).toContain(label);
	});

	it("marks truncated output", () => {
		expect(renderWeb({ kind: "fetch", status: 200, access: "ok", truncated: true })).toContain(
			"Page fetched · 200 OK · truncated",
		);
	});

	it("labels HTTP requests", () => {
		expect(renderWeb({ kind: "http", status: 201, truncated: false })).toContain("Request sent · 201 Created");
		expect(renderWeb({ kind: "http", status: 500, truncated: false })).toContain(
			"Request failed · 500 Internal Server Error",
		);
	});

	it.each([
		[{ status: "ok", count: 3 }, "Found 3 results"],
		[{ status: "ok", count: 1 }, "Found 1 result"],
		[{ status: "empty", count: 0 }, "No results"],
		[{ status: "unavailable", count: 0 }, "Search unavailable"],
	] as const)("labels a search %j", (fields, label) => {
		expect(renderWeb({ kind: "search", truncated: false, ...fields })).toContain(label);
	});

	it("labels Git results", () => {
		expect(renderWeb({ kind: "git_index", status: "ok", filesIndexed: 12 })).toContain(
			"Repository indexed · 12 files",
		);
		expect(renderWeb({ kind: "git_index", status: "partial", filesIndexed: 1 })).toContain(
			"Repository partly indexed · 1 file",
		);
		expect(renderWeb({ kind: "git_search", status: "ok", count: 2, partial: false, truncated: false })).toContain(
			"Found 2 matches",
		);
		expect(renderWeb({ kind: "git_search", status: "empty", count: 0, partial: true, truncated: false })).toContain(
			"No matches · partial index",
		);
		expect(
			renderWeb({
				kind: "git_read",
				status: "ok",
				startLine: 1,
				endLine: 200,
				totalLines: 540,
				truncated: false,
			}),
		).toContain("File read · lines 1-200 of 540");
		expect(
			renderWeb({
				kind: "git_read",
				status: "not_found",
				startLine: 1,
				endLine: 0,
				totalLines: 0,
				truncated: false,
			}),
		).toContain("File not found");
	});

	it("shows the raw output under the label when expanded", () => {
		const output = renderWeb({ kind: "fetch", status: 200, access: "ok", truncated: false }, { expanded: true });
		expect(output).toContain("Page fetched · 200 OK");
		expect(output).toContain('{"raw":"json"}');
		expect(output).not.toContain("to expand");
	});

	it("shows the error text instead of a label for a failed call", () => {
		const output = renderWeb(undefined, { output: "timeout: The request timed out.", isError: true });
		expect(output).toBe("timeout: The request timed out.");
	});

	it("shows the output when there is no summary", () => {
		expect(renderWeb(undefined, { output: '{"operation":"web_fetch"}' })).toBe('{"operation":"web_fetch"}');
	});
});

describe("ask_user result labels", () => {
	it("shows the answer", () => {
		expect(renderAsk({ asked: true, answer: "use option B" })).toBe("Answered · use option B");
	});

	it("says the question was dismissed", () => {
		expect(renderAsk({ asked: true, dismissed: true })).toBe("Question dismissed");
	});

	it("says no user was available", () => {
		expect(renderAsk({ asked: false })).toBe("No user available to answer");
	});
});

describe("web tools attach a summary for the result label", () => {
	const fetched: WebEngineFetchResult = {
		url: "https://example.com/a",
		status: 200,
		contentType: "text/html",
		title: "A",
		content: "body",
		format: "markdown",
		access: "ok",
		extraction: "readability",
		truncated: false,
		bytesReceived: 4,
	};

	function setup() {
		const tools = new Map<string, ToolDefinition>();
		const client: WebExtensionClient = {
			async httpRequest() {
				return {
					url: "http://localhost/x",
					status: 404,
					headers: {},
					body: "",
					truncated: false,
					bytesReceived: 0,
					missingPointers: [],
				};
			},
			async webSearch() {
				return {
					query: "q",
					status: "ok",
					results: [
						{ title: "t", url: "https://example.com", snippet: "s", source: "exa" },
						{ title: "u", url: "https://example.org", snippet: "s", source: "tavily" },
					],
					attempts: [],
					truncated: true,
				};
			},
			async webFetch() {
				return fetched;
			},
			async gitIndex() {
				throw new Error("not used");
			},
			async gitSearch() {
				throw new Error("not used");
			},
			async gitRead() {
				throw new Error("not used");
			},
			async close() {},
		};
		createWebExtension({ clientFactory: () => client })({
			on: () => () => {},
			registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
		} as never);
		return tools;
	}

	const baseContext = { cwd: "/tmp", hasUI: false };
	const context = baseContext as never;

	it("summarizes web_fetch, http_request and web_search", async () => {
		const tools = setup();
		const run = (name: string, params: object) =>
			tools.get(name)!.execute("call", params as never, undefined, undefined, context);

		expect((await run("web_fetch", { url: "https://example.com/a" })).details).toEqual({
			kind: "fetch",
			status: 200,
			access: "ok",
			truncated: false,
		});
		expect((await run("http_request", { url: "http://localhost/x" })).details).toEqual({
			kind: "http",
			status: 404,
			truncated: false,
		});
		expect((await run("web_search", { query: "q" })).details).toEqual({
			kind: "search",
			status: "ok",
			count: 2,
			truncated: true,
		});
	});

	it("passes the summary of the called operation through web_tools", async () => {
		const tools = setup();
		const details: WebToolSummary = { kind: "fetch", status: 200, access: "ok", truncated: false };
		const result = await tools
			.get("web_tools")!
			.execute(
				"call",
				{ operation: "web_fetch", args: { url: "https://example.com/a" } } as never,
				undefined,
				undefined,
				{
					...baseContext,
					tools: [{ name: "web_fetch" }],
					executeTool: async () => ({
						result: { content: [{ type: "text", text: "{}" }], details, structuredContent: {} },
						isError: false,
					}),
				} as never,
			);
		expect(result.details).toEqual(details);
	});
});
