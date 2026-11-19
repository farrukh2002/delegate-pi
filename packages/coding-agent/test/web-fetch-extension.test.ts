import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	WebEngineError,
	type WebEngineFetchOptions,
	type WebEngineFetchRequest,
	type WebEngineFetchResult,
	type WebEngineGitIndexResult,
	type WebEngineGitReadResult,
	type WebEngineGitSearchResult,
	type WebEngineHttpResult,
	type WebEngineSearchResult,
} from "../src/core/web/client.ts";
import {
	createWebExtension,
	FETCH_TOOL_NAME,
	HTTP_REQUEST_TOOL_NAME,
	WEB_SEARCH_TOOL_NAME,
	type WebExtensionClient,
	type WebExtensionOptions,
	type WebFetchInput,
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

interface FetchCall {
	params: WebEngineFetchRequest;
	options: WebEngineFetchOptions | undefined;
}

function fakeClient(
	webFetch: WebExtensionClient["webFetch"] = async () => FETCH_RESULT,
	onClose: () => Promise<void> | void = () => {},
) {
	const fetchCalls: FetchCall[] = [];
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
		async webFetch(params, options) {
			fetchCalls.push({ params, options });
			return webFetch(params, options);
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
	return { client, fetchCalls, close };
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
	const fetchTool = tools.get(FETCH_TOOL_NAME);
	if (!fetchTool) throw new Error("web_fetch was not registered");
	return { tools, fetchTool, factory, handlers };
}

function makeContext(options: { hasUI?: boolean } = {}) {
	const confirm = vi.fn(async () => true);
	const context = {
		cwd: "/tmp/project",
		hasUI: options.hasUI ?? true,
		ui: { confirm },
	} as never;
	return { context, confirm };
}

function runFetch(
	tool: ToolDefinition,
	input: Partial<WebFetchInput>,
	context: ExtensionToolContext,
	signal?: AbortSignal,
) {
	return tool.execute("call", input as WebFetchInput, signal, undefined, context);
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

async function shutdown(handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>, context: unknown) {
	const registered = handlers.get("session_shutdown") ?? [];
	expect(registered).toHaveLength(1);
	await registered[0]({ reason: "quit" }, context);
}

describe("web_fetch tool", () => {
	it("registers a read-only tool and creates its client only on first use", async () => {
		const fake = fakeClient();
		const { fetchTool, factory } = setup({ client: fake.client });
		expect(fetchTool.name).toBe(FETCH_TOOL_NAME);
		expect(fetchTool.outputSchema).toBeDefined();
		expect(fetchTool.promptGuidelines?.some((line) => line.includes("untrusted"))).toBe(true);
		expect(fetchTool.promptGuidelines?.some((line) => line.includes("access status"))).toBe(true);
		expect(factory).not.toHaveBeenCalled();
		const { context, confirm } = makeContext({ hasUI: false });
		const result = await runFetch(fetchTool, { url: "https://example.com/article" }, context);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.fetchCalls).toHaveLength(1);
		expect(fake.fetchCalls[0].params).toEqual({ url: "https://example.com/article" });
		expect(fake.fetchCalls[0].options?.signal).toBeUndefined();
		expect(text(result)).toBe(JSON.stringify(FETCH_RESULT));
		expect(result.structuredContent).toEqual(FETCH_RESULT);
		expect(result.details).toEqual({ kind: "fetch", status: 200, access: "ok", truncated: false });
		expect(result.isError).toBeUndefined();
	});

	it("forwards all fetch parameters without an approval prompt", async () => {
		const fake = fakeClient();
		const { fetchTool } = setup({ client: fake.client });
		const { context, confirm } = makeContext();
		const params = {
			url: "https://example.com/article",
			credential: "docs",
			maxResponseBytes: 4_096,
			maxOutputBytes: 2_048,
			maxRedirects: 2,
		};
		await runFetch(fetchTool, params, context);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.fetchCalls[0].params).toEqual(params);
	});

	it.each([
		["blocked", 403],
		["auth_required", 401],
		["http_error", 500],
		["requires_javascript", 200],
		["empty", 200],
	] as const)("returns a %s access failure as structured output", async (access, status) => {
		const outcome: WebEngineFetchResult = {
			url: "https://example.com/private",
			status,
			contentType: "text/html",
			title: "",
			content: "",
			format: "markdown",
			access,
			extraction: "none",
			truncated: false,
			bytesReceived: 42,
		};
		const fake = fakeClient(async () => outcome);
		const { fetchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runFetch(fetchTool, { url: "https://example.com/private" }, context);
		expect(result.structuredContent).toEqual(outcome);
		expect(JSON.parse(text(result))).toEqual(outcome);
		expect(result.isError).toBeUndefined();
	});

	it("returns a static engine error without its cause", async () => {
		const fake = fakeClient(async () => {
			throw new WebEngineError(
				"response_limit",
				"Response size limit exceeded",
				new Error("secret https://token@example.com"),
			);
		});
		const { fetchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runFetch(fetchTool, { url: "https://example.com/article" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("response_limit: Response size limit exceeded");
		expect(text(result)).not.toContain("secret");
		expect(text(result)).not.toContain("token@example.com");
	});

	it("does not expose an unknown error message", async () => {
		const fake = fakeClient(async () => {
			throw new Error("secret https://token@example.com");
		});
		const { fetchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await runFetch(fetchTool, { url: "https://example.com/article" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("The web fetch failed.");
		expect(text(result)).not.toContain("secret");
	});

	it("cancels an in-flight fetch through the shared client", async () => {
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
		const { fetchTool } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = runFetch(fetchTool, { url: "https://example.com/article" }, context, controller.signal);
		await vi.waitFor(() => expect(received).toBe(controller.signal));
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Cancelled.");
	});

	it("cancels before creating a client", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetchTool, factory } = setup();
		const { context } = makeContext();
		const result = await runFetch(fetchTool, { url: "https://example.com/article" }, context, controller.signal);
		expect(text(result)).toBe("Cancelled.");
		expect(factory).not.toHaveBeenCalled();
	});
});

describe("web_fetch lifecycle", () => {
	it("shares one lazy client with http_request and web_search and closes it on session shutdown", async () => {
		const fake = fakeClient();
		const { tools, fetchTool, handlers, factory } = setup({ client: fake.client });
		const { context } = makeContext({ hasUI: false });
		await runFetch(fetchTool, { url: "https://example.com/article" }, context);
		await tools
			.get(HTTP_REQUEST_TOOL_NAME)
			?.execute("call", { url: "http://localhost:3000/items" }, undefined, undefined, context);
		await tools.get(WEB_SEARCH_TOOL_NAME)?.execute("call", { query: "ownership" }, undefined, undefined, context);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(fake.close).not.toHaveBeenCalled();
		await shutdown(handlers, context);
		expect(fake.close).toHaveBeenCalledTimes(1);
		await shutdown(handlers, context);
		expect(fake.close).toHaveBeenCalledTimes(1);
	});

	it("does not create a client after its extension has shut down", async () => {
		const { fetchTool, handlers, factory } = setup();
		const { context } = makeContext();
		await shutdown(handlers, context);
		const result = await runFetch(fetchTool, { url: "https://example.com/article" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("closed: Web engine client is closed");
		expect(factory).not.toHaveBeenCalled();
	});

	it("rejects a pending fetch when the session shuts down", async () => {
		let rejectPending: ((error: WebEngineError) => void) | undefined;
		const fake = fakeClient(
			() =>
				new Promise((_resolve, reject) => {
					rejectPending = reject;
				}),
			() => rejectPending?.(new WebEngineError("closed", "Web engine client is closed")),
		);
		const { fetchTool, handlers } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = runFetch(fetchTool, { url: "https://example.com/article" }, context);
		await vi.waitFor(() => expect(rejectPending).toBeDefined());
		await shutdown(handlers, context);
		const result = await pending;
		expect(fake.close).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("closed: Web engine client is closed");
	});
});
