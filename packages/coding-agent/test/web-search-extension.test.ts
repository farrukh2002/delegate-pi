import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	WebEngineError,
	type WebEngineFetchResult,
	type WebEngineGitIndexResult,
	type WebEngineGitReadResult,
	type WebEngineGitSearchResult,
	type WebEngineHttpResult,
	type WebEngineSearchOptions,
	type WebEngineSearchRequest,
	type WebEngineSearchResult,
} from "../src/core/web/client.ts";
import {
	createWebExtension,
	HTTP_REQUEST_TOOL_NAME,
	type HttpRequestInput,
	WEB_SEARCH_TOOL_NAME,
	type WebExtensionClient,
	type WebExtensionOptions,
	type WebSearchInput,
} from "../src/extensions/web/index.ts";

const HTTP_RESULT: WebEngineHttpResult = {
	url: "http://localhost:3000/items",
	status: 200,
	headers: { "content-type": "application/json" },
	body: '{"name":"example"}',
	truncated: false,
	bytesReceived: 18,
	missingPointers: [],
};

const SEARCH_RESULT: WebEngineSearchResult = {
	query: "ownership",
	site: "doc.rust-lang.org",
	status: "ok",
	results: [
		{
			title: "What is Ownership?",
			url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
			snippet: "Ownership is a set of rules.",
			source: "yahoo",
		},
	],
	attempts: [{ provider: "yahoo", status: "ok" }],
	truncated: false,
};

const FETCH_RESULT: WebEngineFetchResult = {
	url: "https://example.com/article",
	status: 200,
	contentType: "text/html",
	title: "Example article",
	content: "# Example\n\nReadable content.",
	format: "markdown",
	access: "ok",
	extraction: "readability",
	truncated: false,
	bytesReceived: 1200,
};

const GIT_INDEX_RESULT: WebEngineGitIndexResult = {
	indexId: "0".repeat(64),
	source: "/tmp/project",
	scope: "worktree",
	revision: null,
	resolvedCommit: null,
	status: "ok",
	filesIndexed: 0,
	bytesIndexed: 0,
	commitsVisited: 0,
	downloadBytes: 0,
	skipped: {
		binary: 0,
		large: 0,
		nonUtf8: 0,
		unsafePath: 0,
		unreadable: 0,
		submodule: 0,
		duplicate: 0,
	},
	limitsReached: [],
	indexedAt: 1700000000,
};

const GIT_SEARCH_RESULT: WebEngineGitSearchResult = {
	indexId: "0".repeat(64),
	query: "answer",
	status: "empty",
	results: [],
	partial: false,
	truncated: false,
};

const GIT_READ_RESULT: WebEngineGitReadResult = {
	indexId: "0".repeat(64),
	path: "src/lib.rs",
	revision: null,
	status: "not_found",
	startLine: 1,
	startColumn: 1,
	endLine: 0,
	totalLines: 0,
	content: "",
	truncated: false,
	next: null,
};

interface SearchCall {
	params: WebEngineSearchRequest;
	options: WebEngineSearchOptions | undefined;
}

function fakeClient(
	webSearch: WebExtensionClient["webSearch"] = async () => SEARCH_RESULT,
	onClose: () => Promise<void> | void = () => {},
) {
	const searchCalls: SearchCall[] = [];
	const close = vi.fn(async () => {
		await onClose();
	});
	const client: WebExtensionClient = {
		async httpRequest() {
			return HTTP_RESULT;
		},
		async webSearch(params, options) {
			searchCalls.push({ params, options });
			return webSearch(params, options);
		},
		async webFetch() {
			return FETCH_RESULT;
		},
		async gitIndex() {
			return GIT_INDEX_RESULT;
		},
		async gitSearch() {
			return GIT_SEARCH_RESULT;
		},
		async gitRead() {
			return GIT_READ_RESULT;
		},
		close,
	};
	return { client, searchCalls, close };
}

function setup(options: { client?: WebExtensionClient } = {}) {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const factory = vi.fn(() => options.client ?? fakeClient().client);
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
			return () => {};
		},
		registerTool(definition: ToolDefinition) {
			tools.set(definition.name, definition);
		},
	};
	createWebExtension({ clientFactory: factory } satisfies WebExtensionOptions)(pi as never);
	const httpTool = tools.get(HTTP_REQUEST_TOOL_NAME);
	const searchTool = tools.get(WEB_SEARCH_TOOL_NAME);
	if (!httpTool || !searchTool) throw new Error("web tools were not registered");
	return { tools, httpTool, searchTool, factory, handlers };
}

function makeContext(options: { hasUI?: boolean; confirm?: boolean; onConfirm?: () => void } = {}) {
	const confirm = vi.fn(async (_title: string, _message: string, _options?: { signal?: AbortSignal }) => {
		options.onConfirm?.();
		return options.confirm ?? true;
	});
	const context = {
		cwd: "/tmp/project",
		hasUI: options.hasUI ?? true,
		ui: { confirm },
	} as never;
	return { context, confirm };
}

function runSearch(
	tool: ToolDefinition,
	input: Partial<WebSearchInput>,
	context: ExtensionToolContext,
	signal?: AbortSignal,
) {
	return tool.execute("call", input as WebSearchInput, signal, undefined, context);
}

function runHttp(
	tool: ToolDefinition,
	input: Partial<HttpRequestInput>,
	context: ExtensionToolContext,
	signal?: AbortSignal,
) {
	return tool.execute("call", input as HttpRequestInput, signal, undefined, context);
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

async function shutdown(handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>, context: unknown) {
	const registered = handlers.get("session_shutdown") ?? [];
	expect(registered).toHaveLength(1);
	await registered[0]({ reason: "quit" }, context);
}

describe("web_search tool", () => {
	it("registers a read-only tool and creates its client only on first use", async () => {
		const fake = fakeClient();
		const { searchTool, factory } = setup({ client: fake.client });
		expect(searchTool.name).toBe(WEB_SEARCH_TOOL_NAME);
		expect(searchTool.outputSchema).toBeDefined();
		expect(factory).not.toHaveBeenCalled();
		const { context, confirm } = makeContext({ hasUI: false });
		const result = await runSearch(searchTool, { query: "ownership" }, context);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.searchCalls).toHaveLength(1);
		expect(fake.searchCalls[0].params).toEqual({ query: "ownership" });
		expect(fake.searchCalls[0].options?.signal).toBeUndefined();
		expect(text(result)).toBe(JSON.stringify(SEARCH_RESULT));
		expect(result.structuredContent).toEqual(SEARCH_RESULT);
		expect(result.details).toMatchObject({ kind: "search" });
		expect(result.isError).toBeUndefined();
	});

	it.each(["empty", "unavailable"] as const)("returns a structured %s outcome", async (status) => {
		const outcome: WebEngineSearchResult = {
			query: "rust",
			status,
			results: [],
			attempts: [{ provider: "yahoo", status: status === "empty" ? "empty" : "blocked" }],
			truncated: false,
		};
		const fake = fakeClient(async () => outcome);
		const { searchTool } = setup({ client: fake.client });
		const { context } = makeContext({ hasUI: false });
		const result = await runSearch(searchTool, { query: "rust" }, context);
		expect(result.structuredContent).toEqual(outcome);
		expect(JSON.parse(text(result))).toEqual(outcome);
	});

	it("forwards all search parameters", async () => {
		const fake = fakeClient();
		const { searchTool } = setup({ client: fake.client });
		const { context, confirm } = makeContext();
		const params = {
			query: "ownership",
			site: "doc.rust-lang.org",
			maxResults: 3,
			maxOutputBytes: 4_096,
		};
		await runSearch(searchTool, params, context);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.searchCalls[0].params).toEqual(params);
	});

	it("returns a static engine error without its cause", async () => {
		const fake = fakeClient(async () => {
			throw new WebEngineError(
				"output_limit",
				"Search result exceeds the output limit",
				new Error("secret https://token@example.com"),
			);
		});
		const { searchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runSearch(searchTool, { query: "ownership" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("output_limit: Search result exceeds the output limit");
		expect(text(result)).not.toContain("secret");
		expect(text(result)).not.toContain("token@example.com");
	});

	it("does not expose an unknown error message", async () => {
		const fake = fakeClient(async () => {
			throw new Error("secret https://token@example.com");
		});
		const { searchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runSearch(searchTool, { query: "ownership" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("The web search failed.");
		expect(text(result)).not.toContain("secret");
	});

	it("cancels an in-flight search through the shared client", async () => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const fake = fakeClient(
			(_params, options) =>
				new Promise((_resolve, reject) => {
					received = options?.signal;
					options?.signal?.addEventListener(
						"abort",
						() => reject(new WebEngineError("aborted", "Web engine request aborted")),
						{ once: true },
					);
				}),
		);
		const { searchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = runSearch(searchTool, { query: "ownership" }, context, controller.signal);
		await vi.waitFor(() => expect(received).toBe(controller.signal));
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Cancelled.");
	});

	it("cancels before creating a client", async () => {
		const controller = new AbortController();
		controller.abort();
		const { searchTool, factory } = setup();
		const { context } = makeContext();
		const result = await runSearch(searchTool, { query: "ownership" }, context, controller.signal);
		expect(text(result)).toBe("Cancelled.");
		expect(factory).not.toHaveBeenCalled();
	});
});

describe("web_search lifecycle", () => {
	it("shares one lazy client with http_request and closes it on session shutdown", async () => {
		const fake = fakeClient();
		const { httpTool, searchTool, handlers, factory } = setup({ client: fake.client });
		const { context } = makeContext({ hasUI: false });
		await runSearch(searchTool, { query: "ownership" }, context);
		await runHttp(httpTool, { url: "http://localhost:3000/items" }, context);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(fake.close).not.toHaveBeenCalled();
		await shutdown(handlers, context);
		expect(fake.close).toHaveBeenCalledTimes(1);
		await shutdown(handlers, context);
		expect(fake.close).toHaveBeenCalledTimes(1);
	});

	it("does not create a client after its extension has shut down", async () => {
		const { httpTool, searchTool, handlers, factory } = setup();
		const { context } = makeContext();
		await shutdown(handlers, context);
		const searchResult = await runSearch(searchTool, { query: "ownership" }, context);
		expect(searchResult.isError).toBe(true);
		expect(text(searchResult)).toBe("closed: Web engine client is closed");
		const httpResult = await runHttp(httpTool, { url: "http://localhost:3000/items" }, context);
		expect(httpResult.isError).toBe(true);
		expect(text(httpResult)).toBe("closed: Web engine client is closed");
		expect(factory).not.toHaveBeenCalled();
	});

	it("rejects a pending search when the session shuts down", async () => {
		let rejectPending: ((error: WebEngineError) => void) | undefined;
		const fake = fakeClient(
			() =>
				new Promise((_resolve, reject) => {
					rejectPending = reject;
				}),
			() => rejectPending?.(new WebEngineError("closed", "Web engine client is closed")),
		);
		const { searchTool, handlers } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = runSearch(searchTool, { query: "ownership" }, context);
		await vi.waitFor(() => expect(rejectPending).toBeDefined());
		await shutdown(handlers, context);
		const result = await pending;
		expect(fake.close).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("closed: Web engine client is closed");
	});
});
