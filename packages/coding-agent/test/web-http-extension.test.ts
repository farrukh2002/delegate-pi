import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	WebEngineError,
	type WebEngineFetchResult,
	type WebEngineGitIndexResult,
	type WebEngineGitReadResult,
	type WebEngineGitSearchResult,
	type WebEngineHttpOptions,
	type WebEngineHttpRequest,
	type WebEngineHttpResult,
	type WebEngineSearchResult,
} from "../src/core/web/client.ts";
import {
	createWebExtension,
	HTTP_REQUEST_TOOL_NAME,
	type HttpRequestInput,
	type WebExtensionClient,
	type WebExtensionOptions,
} from "../src/extensions/web/index.ts";

const RESULT: WebEngineHttpResult = {
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

interface ClientCall {
	params: WebEngineHttpRequest;
	options: WebEngineHttpOptions | undefined;
}

function fakeClient(
	httpRequest: WebExtensionClient["httpRequest"] = async () => RESULT,
	onClose: () => Promise<void> | void = () => {},
) {
	const calls: ClientCall[] = [];
	const close = vi.fn(async () => {
		await onClose();
	});
	const client: WebExtensionClient = {
		async httpRequest(params, options) {
			calls.push({ params, options });
			return httpRequest(params, options);
		},
		async webSearch() {
			return SEARCH_RESULT;
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
	return { client, calls, close };
}

function setup(options: { client?: WebExtensionClient } = {}) {
	let tool: ToolDefinition | undefined;
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
			if (definition.name === HTTP_REQUEST_TOOL_NAME) tool = definition;
		},
	};
	createWebExtension({ clientFactory: factory } satisfies WebExtensionOptions)(pi as never);
	if (!tool) throw new Error("http_request was not registered");
	return { tool, factory, handlers };
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

function run(
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

describe("http_request tool", () => {
	it("registers the tool and creates its client only on first use", async () => {
		const fake = fakeClient();
		const { tool, factory } = setup({ client: fake.client });
		expect(tool.name).toBe(HTTP_REQUEST_TOOL_NAME);
		expect(factory).not.toHaveBeenCalled();
		const { context, confirm } = makeContext();
		const result = await run(tool, { url: "http://localhost:3000/items" }, context);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].params).toEqual({ url: "http://localhost:3000/items" });
		expect(text(result)).toBe(JSON.stringify(RESULT));
		expect(result.details).toBeUndefined();
	});

	it("does not ask for approval for GET or HEAD", async () => {
		const fake = fakeClient();
		const { tool } = setup({ client: fake.client });
		const { context, confirm } = makeContext();
		await run(tool, { url: "http://localhost:3000/items", method: "GET" }, context);
		await run(tool, { url: "http://localhost:3000/items", method: "HEAD" }, context);
		expect(confirm).not.toHaveBeenCalled();
		expect(fake.calls).toHaveLength(2);
	});

	it("asks before a mutating request reaches the engine", async () => {
		const fake = fakeClient();
		const { tool, factory } = setup({ client: fake.client });
		const { context, confirm } = makeContext({
			onConfirm: () => expect(factory).not.toHaveBeenCalled(),
		});
		const params = {
			url: "https://api.example.com/items",
			method: "POST" as const,
			body: '{"name":"example"}',
		};
		const result = await run(tool, params, context);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toContain("POST");
		expect(confirm.mock.calls[0][1]).toContain("https://api.example.com");
		expect(fake.calls[0].params).toEqual(params);
		expect(text(result)).toBe(JSON.stringify(RESULT));
		expect(result.isError).toBeUndefined();
	});

	it("fails before engine access when a mutating request has no UI", async () => {
		const fake = fakeClient();
		const { tool, factory } = setup({ client: fake.client });
		const { context, confirm } = makeContext({ hasUI: false });
		const result = await run(tool, { url: "http://localhost:3000/items", method: "DELETE" }, context);
		expect(confirm).not.toHaveBeenCalled();
		expect(factory).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/require user approval/);
	});

	it("does not access the engine when the user declines", async () => {
		const fake = fakeClient();
		const { tool, factory } = setup({ client: fake.client });
		const { context } = makeContext({ confirm: false });
		const result = await run(tool, { url: "http://localhost:3000/items", method: "PATCH" }, context);
		expect(factory).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/did not approve/);
	});

	it("returns all HTTP status codes as transport results", async () => {
		const missing = { ...RESULT, status: 404, body: "not found", bytesReceived: 9 };
		const fake = fakeClient(async () => missing);
		const { tool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await run(tool, { url: missing.url }, context);
		expect(JSON.parse(text(result))).toEqual(missing);
		expect(result.isError).toBeUndefined();
	});

	it("returns a static engine error without its cause", async () => {
		const fake = fakeClient(async () => {
			throw new WebEngineError("network_error", "Request failed", new Error("secret https://token@example.com"));
		});
		const { tool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await run(tool, { url: "http://localhost:3000/items" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("network_error: Request failed");
		expect(text(result)).not.toContain("secret");
		expect(text(result)).not.toContain("token@example.com");
	});

	it("does not expose an unknown error message", async () => {
		const fake = fakeClient(async () => {
			throw new Error("secret https://token@example.com");
		});
		const { tool } = setup({ client: fake.client });
		const { context } = makeContext();
		const result = await run(tool, { url: "http://localhost:3000/items" }, context);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("The HTTP request failed.");
		expect(text(result)).not.toContain("secret");
	});

	it("cancels an in-flight request through the shared client", async () => {
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
		const { tool } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = run(tool, { url: "http://localhost:3000/items" }, context, controller.signal);
		await vi.waitFor(() => expect(received).toBe(controller.signal));
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Cancelled.");
	});

	it("cancels during approval without creating a client", async () => {
		const controller = new AbortController();
		const { tool, factory } = setup();
		const { context } = makeContext({ onConfirm: () => controller.abort() });
		const result = await run(tool, { url: "http://localhost:3000/items", method: "PUT" }, context, controller.signal);
		expect(text(result)).toBe("Cancelled.");
		expect(factory).not.toHaveBeenCalled();
	});
});

describe("http_request lifecycle", () => {
	it("does not create a client after its extension has shut down", async () => {
		const { tool, handlers, factory } = setup();
		const { context } = makeContext();
		await shutdown(handlers, context);
		const result = await run(tool, { url: "http://localhost:3000/items" }, context);
		expect(result.isError).toBe(true);
		expect(factory).not.toHaveBeenCalled();
	});

	it("does not send an approval completed after session shutdown", async () => {
		const { tool, handlers, factory } = setup();
		const approval = Promise.withResolvers<boolean>();
		const context = { hasUI: true, ui: { confirm: () => approval.promise } } as never;
		const pending = run(tool, { url: "http://localhost:3000/items", method: "POST" }, context);
		await shutdown(handlers, context);
		approval.resolve(true);
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(factory).not.toHaveBeenCalled();
	});

	it("closes one lazy client on session shutdown", async () => {
		const fake = fakeClient();
		const { tool, handlers } = setup({ client: fake.client });
		const { context } = makeContext();
		await run(tool, { url: "http://localhost:3000/items" }, context);
		expect(fake.close).not.toHaveBeenCalled();
		await shutdown(handlers, context);
		expect(fake.close).toHaveBeenCalledTimes(1);
		await shutdown(handlers, context);
		expect(fake.close).toHaveBeenCalledTimes(1);
	});

	it("does not create a client on session shutdown before first use", async () => {
		const { handlers, factory } = setup();
		const { context } = makeContext();
		await shutdown(handlers, context);
		expect(factory).not.toHaveBeenCalled();
	});

	it("rejects a pending request when the session shuts down", async () => {
		let rejectPending: ((error: WebEngineError) => void) | undefined;
		const fake = fakeClient(
			() =>
				new Promise((_resolve, reject) => {
					rejectPending = reject;
				}),
			() => rejectPending?.(new WebEngineError("closed", "Web engine client is closed")),
		);
		const { tool, handlers } = setup({ client: fake.client });
		const { context } = makeContext();
		const pending = run(tool, { url: "http://localhost:3000/items" }, context);
		await vi.waitFor(() => expect(rejectPending).toBeDefined());
		await shutdown(handlers, context);
		const result = await pending;
		expect(fake.close).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("closed: Web engine client is closed");
	});
});
