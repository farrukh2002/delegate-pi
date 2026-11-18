import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	WebEngineError,
	type WebEngineFetchResult,
	type WebEngineGitIndexOptions,
	type WebEngineGitIndexRequest,
	type WebEngineGitIndexResult,
	type WebEngineGitReadOptions,
	type WebEngineGitReadRequest,
	type WebEngineGitReadResult,
	type WebEngineGitSearchOptions,
	type WebEngineGitSearchRequest,
	type WebEngineGitSearchResult,
	type WebEngineHttpResult,
	type WebEngineSearchResult,
} from "../src/core/web/client.ts";
import {
	createWebExtension,
	FETCH_TOOL_NAME,
	GIT_INDEX_TOOL_NAME,
	GIT_READ_TOOL_NAME,
	GIT_SEARCH_TOOL_NAME,
	type GitIndexInput,
	type GitReadInput,
	type GitSearchInput,
	HTTP_REQUEST_TOOL_NAME,
	WEB_SEARCH_TOOL_NAME,
	type WebExtensionClient,
	type WebExtensionOptions,
} from "../src/extensions/web/index.ts";

const GIT_INDEX_ID = "0123456789abcdef".repeat(4);
const GIT_COMMIT = "b".repeat(40);

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
	indexId: GIT_INDEX_ID,
	source: "/tmp/project/repo",
	scope: "history",
	revision: "HEAD~2",
	resolvedCommit: GIT_COMMIT,
	status: "partial",
	filesIndexed: 3,
	bytesIndexed: 42,
	commitsVisited: 4,
	downloadBytes: 0,
	skipped: {
		binary: 1,
		large: 0,
		nonUtf8: 0,
		unsafePath: 0,
		unreadable: 0,
		submodule: 0,
		duplicate: 2,
	},
	limitsReached: ["file_limit"],
	indexedAt: 1700000000,
};

const GIT_SEARCH_RESULT: WebEngineGitSearchResult = {
	indexId: GIT_INDEX_ID,
	query: "answer",
	status: "ok",
	results: [
		{
			path: "src/lib.rs",
			revision: GIT_COMMIT,
			line: 12,
			column: 4,
			snippet: "pub fn answer() -> u32 { 42 }",
		},
	],
	partial: true,
	truncated: false,
};

const GIT_READ_RESULT: WebEngineGitReadResult = {
	indexId: GIT_INDEX_ID,
	path: "src/lib.rs",
	revision: GIT_COMMIT,
	status: "ok",
	startLine: 2,
	startColumn: 3,
	endLine: 2,
	totalLines: 2,
	content: "日",
	truncated: true,
	next: { line: 2, column: 6 },
};

interface GitIndexCall {
	params: WebEngineGitIndexRequest;
	options: WebEngineGitIndexOptions | undefined;
}

interface GitSearchCall {
	params: WebEngineGitSearchRequest;
	options: WebEngineGitSearchOptions | undefined;
}

interface GitReadCall {
	params: WebEngineGitReadRequest;
	options: WebEngineGitReadOptions | undefined;
}

function fakeClient(
	gitIndex: WebExtensionClient["gitIndex"] = async () => GIT_INDEX_RESULT,
	gitSearch: WebExtensionClient["gitSearch"] = async () => GIT_SEARCH_RESULT,
	gitRead: WebExtensionClient["gitRead"] = async () => GIT_READ_RESULT,
	onClose: () => Promise<void> | void = () => {},
) {
	const indexCalls: GitIndexCall[] = [];
	const searchCalls: GitSearchCall[] = [];
	const readCalls: GitReadCall[] = [];
	const close = vi.fn(async () => {
		await onClose();
	});
	const client: WebExtensionClient = {
		async httpRequest() {
			return HTTP_RESULT;
		},
		async webSearch() {
			return SEARCH_RESULT;
		},
		async webFetch() {
			return FETCH_RESULT;
		},
		async gitIndex(params, options) {
			indexCalls.push({ params, options });
			return gitIndex(params, options);
		},
		async gitSearch(params, options) {
			searchCalls.push({ params, options });
			return gitSearch(params, options);
		},
		async gitRead(params, options) {
			readCalls.push({ params, options });
			return gitRead(params, options);
		},
		close,
	};
	return { client, indexCalls, searchCalls, readCalls, close };
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
	const indexTool = tools.get(GIT_INDEX_TOOL_NAME);
	const searchTool = tools.get(GIT_SEARCH_TOOL_NAME);
	const readTool = tools.get(GIT_READ_TOOL_NAME);
	if (!indexTool || !searchTool || !readTool) throw new Error("Git tools were not registered");
	return { tools, indexTool, searchTool, readTool, factory, handlers };
}

function makeContext(options: { cwd?: string; hasUI?: boolean } = {}) {
	const confirm = vi.fn(async () => true);
	const context = {
		cwd: options.cwd ?? "/tmp/project",
		hasUI: options.hasUI ?? true,
		ui: { confirm },
	} as never;
	return { context, confirm };
}

function runIndex(
	tool: ToolDefinition,
	input: Partial<GitIndexInput>,
	context: ExtensionToolContext,
	signal?: AbortSignal,
) {
	return tool.execute("call", input as GitIndexInput, signal, undefined, context);
}

function runSearch(
	tool: ToolDefinition,
	input: Partial<GitSearchInput>,
	context: ExtensionToolContext,
	signal?: AbortSignal,
) {
	return tool.execute("call", input as GitSearchInput, signal, undefined, context);
}

function runRead(
	tool: ToolDefinition,
	input: Partial<GitReadInput>,
	context: ExtensionToolContext,
	signal?: AbortSignal,
) {
	return tool.execute("call", input as GitReadInput, signal, undefined, context);
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

async function shutdown(handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>, context: unknown) {
	const registered = handlers.get("session_shutdown") ?? [];
	expect(registered).toHaveLength(1);
	await registered[0]({ reason: "quit" }, context);
}

describe("git_index tool", () => {
	it("registers a read-only tool and creates its client only on first use", async () => {
		const fake = fakeClient();
		const { indexTool, factory } = setup({ client: fake.client });
		expect(indexTool.name).toBe(GIT_INDEX_TOOL_NAME);
		expect(indexTool.outputSchema).toBeDefined();
		expect(indexTool.promptGuidelines?.some((line) => line.includes("untrusted"))).toBe(true);
		expect(indexTool.promptGuidelines?.some((line) => line.includes("partial"))).toBe(true);
		expect(factory).not.toHaveBeenCalled();
		const { context, confirm } = makeContext({ hasUI: false });
		const result = await runIndex(indexTool, { source: "repo" }, context);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.indexCalls).toHaveLength(1);
		expect(fake.indexCalls[0].params).toEqual({ source: "/tmp/project/repo" });
		expect(fake.indexCalls[0].options?.signal).toBeUndefined();
		expect(text(result)).toBe(JSON.stringify(GIT_INDEX_RESULT));
		expect(result.structuredContent).toEqual(GIT_INDEX_RESULT);
		expect(result.details).toBeUndefined();
		expect(result.isError).toBeUndefined();
	});

	it("resolves relative local sources against the session directory only", async () => {
		const fake = fakeClient();
		const { indexTool } = setup({ client: fake.client });
		const { context } = makeContext({ cwd: "/tmp/project" });
		for (const source of [
			"repo",
			"./nested/repo",
			"/srv/repo",
			"https://example.com/owner/repo.git",
			"http://example.com/owner/repo.git",
			"file:///tmp/repo",
		]) {
			await runIndex(indexTool, { source }, context);
		}
		expect(fake.indexCalls.map((call) => call.params.source)).toEqual([
			"/tmp/project/repo",
			"/tmp/project/nested/repo",
			"/srv/repo",
			"https://example.com/owner/repo.git",
			"http://example.com/owner/repo.git",
			"file:///tmp/repo",
		]);
	});

	it("forwards scope, revision, and index limits", async () => {
		const fake = fakeClient();
		const { indexTool } = setup({ client: fake.client });
		const { context, confirm } = makeContext();
		const params = {
			source: "/srv/repo",
			scope: "history" as const,
			revision: "HEAD~2",
			maxCommits: 25,
			maxFiles: 100,
			maxFileBytes: 2_048,
			maxTotalBytes: 1_048_576,
			maxDownloadBytes: 1_048_576,
			maxOutputBytes: 2_048,
		};
		await runIndex(indexTool, params, context);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.indexCalls[0].params).toEqual(params);
	});

	it("returns a static engine error without its cause", async () => {
		const fake = fakeClient(async () => {
			throw new WebEngineError(
				"repository_error",
				"The repository could not be read",
				new Error("secret https://token@example.com"),
			);
		});
		const { indexTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runIndex(indexTool, { source: "/srv/repo" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("repository_error: The repository could not be read");
		expect(text(result)).not.toContain("secret");
		expect(text(result)).not.toContain("token@example.com");
	});

	it("does not expose an unknown error message", async () => {
		const fake = fakeClient(async () => {
			throw new Error("secret https://token@example.com");
		});
		const { indexTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runIndex(indexTool, { source: "/srv/repo" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("The Git index failed.");
		expect(text(result)).not.toContain("secret");
	});

	it("cancels an in-flight index through the shared client", async () => {
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
		const { indexTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = runIndex(indexTool, { source: "/srv/repo" }, context, controller.signal);
		await vi.waitFor(() => expect(received).toBe(controller.signal));
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Cancelled.");
	});

	it("cancels before creating a client", async () => {
		const controller = new AbortController();
		controller.abort();
		const { indexTool, factory } = setup();
		const { context } = makeContext();
		const result = await runIndex(indexTool, { source: "/srv/repo" }, context, controller.signal);
		expect(text(result)).toBe("Cancelled.");
		expect(factory).not.toHaveBeenCalled();
	});
});

describe("git_search tool", () => {
	it("forwards all search parameters as structured output", async () => {
		const fake = fakeClient();
		const { searchTool } = setup({ client: fake.client });
		const { context, confirm } = makeContext();
		const params = {
			indexId: GIT_INDEX_ID,
			query: "answer",
			regex: true,
			caseSensitive: false,
			path: "src/",
			maxResults: 5,
			maxOutputBytes: 2_048,
		};
		const result = await runSearch(searchTool, params, context);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.searchCalls[0].params).toEqual(params);
		expect(text(result)).toBe(JSON.stringify(GIT_SEARCH_RESULT));
		expect(result.structuredContent).toEqual(GIT_SEARCH_RESULT);
		expect(result.isError).toBeUndefined();
	});

	it("returns an empty search as structured output", async () => {
		const outcome: WebEngineGitSearchResult = {
			indexId: GIT_INDEX_ID,
			query: "missing",
			status: "empty",
			results: [],
			partial: false,
			truncated: false,
		};
		const fake = fakeClient(undefined, async () => outcome);
		const { searchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runSearch(searchTool, { indexId: GIT_INDEX_ID, query: "missing" }, context);
		expect(result.structuredContent).toEqual(outcome);
		expect(JSON.parse(text(result))).toEqual(outcome);
		expect(result.isError).toBeUndefined();
	});

	it("returns the static search error fallback", async () => {
		const fake = fakeClient(undefined, async () => {
			throw new Error("secret");
		});
		const { searchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runSearch(searchTool, { indexId: GIT_INDEX_ID, query: "answer" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("The Git search failed.");
	});

	it("cancels an in-flight search through the shared client", async () => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const fake = fakeClient(
			undefined,
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
		const pending = runSearch(searchTool, { indexId: GIT_INDEX_ID, query: "answer" }, context, controller.signal);
		await vi.waitFor(() => expect(received).toBe(controller.signal));
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Cancelled.");
	});
});

describe("git_read tool", () => {
	it("forwards the start position and exposes the continuation", async () => {
		const fake = fakeClient();
		const { readTool } = setup({ client: fake.client });
		const { context, confirm } = makeContext();
		const params = {
			indexId: GIT_INDEX_ID,
			path: "src/lib.rs",
			revision: GIT_COMMIT,
			startLine: 2,
			startColumn: 3,
			maxLines: 100,
			maxOutputBytes: 2_048,
		};
		const result = await runRead(readTool, params, context);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.readCalls[0].params).toEqual(params);
		expect(fake.readCalls[0].options?.signal).toBeUndefined();
		expect(text(result)).toBe(JSON.stringify(GIT_READ_RESULT));
		expect(result.structuredContent).toEqual(GIT_READ_RESULT);
		expect(result.isError).toBeUndefined();
	});

	it("returns not_found as structured output", async () => {
		const outcome: WebEngineGitReadResult = {
			indexId: GIT_INDEX_ID,
			path: "src/missing.rs",
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
		const fake = fakeClient(undefined, undefined, async () => outcome);
		const { readTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runRead(readTool, { indexId: GIT_INDEX_ID, path: "src/missing.rs" }, context);
		expect(result.structuredContent).toEqual(outcome);
		expect(JSON.parse(text(result))).toEqual(outcome);
		expect(result.isError).toBeUndefined();
	});

	it("returns a static engine error without its cause", async () => {
		const fake = fakeClient(undefined, undefined, async () => {
			throw new WebEngineError("index_not_found", "The index is not available", new Error("secret /private/cache"));
		});
		const { readTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runRead(readTool, { indexId: GIT_INDEX_ID, path: "src/lib.rs" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("index_not_found: The index is not available");
		expect(text(result)).not.toContain("secret");
	});

	it("cancels an in-flight read through the shared client", async () => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const fake = fakeClient(
			undefined,
			undefined,
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
		const { readTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = runRead(readTool, { indexId: GIT_INDEX_ID, path: "src/lib.rs" }, context, controller.signal);
		await vi.waitFor(() => expect(received).toBe(controller.signal));
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Cancelled.");
	});
});

describe("Git tool lifecycle", () => {
	it("shares one lazy client with every web tool and closes it on session shutdown", async () => {
		const fake = fakeClient();
		const { tools, indexTool, searchTool, readTool, handlers, factory } = setup({ client: fake.client });
		const { context } = makeContext({ hasUI: false });
		await runIndex(indexTool, { source: "/srv/repo" }, context);
		await runSearch(searchTool, { indexId: GIT_INDEX_ID, query: "answer" }, context);
		await runRead(readTool, { indexId: GIT_INDEX_ID, path: "src/lib.rs" }, context);
		await tools
			.get(HTTP_REQUEST_TOOL_NAME)
			?.execute("call", { url: "http://localhost:3000/items" }, undefined, undefined, context);
		await tools.get(WEB_SEARCH_TOOL_NAME)?.execute("call", { query: "ownership" }, undefined, undefined, context);
		await tools
			.get(FETCH_TOOL_NAME)
			?.execute("call", { url: "https://example.com/article" }, undefined, undefined, context);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(fake.close).not.toHaveBeenCalled();
		await shutdown(handlers, context);
		expect(fake.close).toHaveBeenCalledTimes(1);
		await shutdown(handlers, context);
		expect(fake.close).toHaveBeenCalledTimes(1);
	});

	it("does not create a client after its extension has shut down", async () => {
		const { indexTool, searchTool, readTool, handlers, factory } = setup();
		const { context } = makeContext();
		await shutdown(handlers, context);
		for (const result of [
			await runIndex(indexTool, { source: "/srv/repo" }, context),
			await runSearch(searchTool, { indexId: GIT_INDEX_ID, query: "answer" }, context),
			await runRead(readTool, { indexId: GIT_INDEX_ID, path: "src/lib.rs" }, context),
		]) {
			expect(result.isError).toBe(true);
			expect(text(result)).toBe("closed: Web engine client is closed");
		}
		expect(factory).not.toHaveBeenCalled();
	});

	it("rejects a pending Git search when the session shuts down", async () => {
		let rejectPending: ((error: WebEngineError) => void) | undefined;
		const fake = fakeClient(
			undefined,
			() =>
				new Promise((_resolve, reject) => {
					rejectPending = reject;
				}),
			undefined,
			() => rejectPending?.(new WebEngineError("closed", "Web engine client is closed")),
		);
		const { searchTool, handlers } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = runSearch(searchTool, { indexId: GIT_INDEX_ID, query: "answer" }, context);
		await vi.waitFor(() => expect(rejectPending).toBeDefined());
		await shutdown(handlers, context);
		const result = await pending;
		expect(fake.close).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("closed: Web engine client is closed");
	});
});
