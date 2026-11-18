import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebEngineClient, type WebEngineClientOptions, WebEngineError } from "../src/core/web/client.ts";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "web-engine");
const GIT_INDEX_ID = "0123456789abcdef".repeat(4);
const GIT_COMMIT = "b".repeat(40);
const GIT_SKIPPED = {
	binary: 0,
	large: 0,
	nonUtf8: 0,
	unsafePath: 0,
	unreadable: 0,
	submodule: 0,
	duplicate: 0,
};
const GIT_INDEX_RESULT = {
	indexId: GIT_INDEX_ID,
	source: "/tmp/repo",
	scope: "history",
	revision: "HEAD~2",
	resolvedCommit: GIT_COMMIT,
	status: "ok",
	filesIndexed: 3,
	bytesIndexed: 42,
	commitsVisited: 4,
	downloadBytes: 0,
	skipped: GIT_SKIPPED,
	limitsReached: [],
	indexedAt: 1700000000,
};
const clients: WebEngineClient[] = [];
const tempDirs: string[] = [];

function fixture(name: string): string {
	return join(FIXTURE_DIR, name);
}

function createClient(options: WebEngineClientOptions = {}): WebEngineClient {
	const client = new WebEngineClient({
		binaryPath: fixture("ready.mjs"),
		startupTimeoutMs: 2_000,
		shutdownTimeoutMs: 200,
		...options,
	});
	clients.push(client);
	return client;
}

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-engine-"));
	tempDirs.push(dir);
	return dir;
}

function readLines(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.length > 0);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function captureError(promise: Promise<unknown>): Promise<WebEngineError> {
	return promise.then(
		() => {
			throw new Error("Expected the promise to reject");
		},
		(error: unknown) => {
			if (error instanceof WebEngineError) return error;
			throw error;
		},
	);
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("startup", () => {
	test("starts lazily and returns a validated status", async () => {
		const client = createClient();
		await expect(client.status()).resolves.toEqual({
			engineVersion: "0.1.0-test",
			protocolVersion: 1,
			operations: ["status"],
		});
	});

	test("rejects an unsupported protocol version", async () => {
		const client = createClient({ binaryPath: fixture("bad-version.mjs") });
		const error = await captureError(client.status());
		expect(error.code).toBe("protocol_error");
		expect(error.message).toMatch(/protocol version 2 is not supported/);
	});

	test("rejects a malformed startup frame", async () => {
		const client = createClient({ binaryPath: fixture("malformed-startup.mjs") });
		const error = await captureError(client.status());
		expect(error.code).toBe("protocol_error");
		expect(error.message).toMatch(/not valid JSON/);
	});

	test("rejects a startup frame with a missing version", async () => {
		const client = createClient({ binaryPath: fixture("missing-version.mjs") });
		const error = await captureError(client.status());
		expect(error.code).toBe("protocol_error");
		expect(error.message).toMatch(/no engine version/);
	});

	test("rejects an oversized startup frame without reading a full line", async () => {
		const client = createClient({ binaryPath: fixture("oversize-startup.mjs") });
		const started = Date.now();
		const error = await captureError(client.status());
		expect(error.code).toBe("protocol_error");
		expect(error.message).toMatch(/exceeds 65536 bytes/);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("rejects when the engine does not become ready in time", async () => {
		const client = createClient({ binaryPath: fixture("silent.mjs"), startupTimeoutMs: 100 });
		const started = Date.now();
		const error = await captureError(client.status());
		expect(error.code).toBe("startup_timeout");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("decodes frames split across chunks and inside UTF-8 sequences", async () => {
		const client = createClient({ binaryPath: fixture("chunked.mjs") });
		const status = await client.status();
		expect(status.engineVersion).toBe("é✓-0.1.0");
	});

	test("shares one startup between concurrent requests", async () => {
		vi.stubEnv("PI_WEB_TEST_READY_DELAY_MS", "100");
		const client = createClient({ binaryPath: fixture("late-ready.mjs") });
		const [first, second] = await Promise.all([client.status(), client.status()]);
		expect(first.engineVersion).toBe("0.1.0-late");
		expect(second.engineVersion).toBe("0.1.0-late");
	});

	test("aborting one request during startup does not fail the shared engine", async () => {
		vi.stubEnv("PI_WEB_TEST_READY_DELAY_MS", "200");
		const client = createClient({ binaryPath: fixture("late-ready.mjs") });
		const controller = new AbortController();
		const pending = captureError(client.status({ signal: controller.signal }));
		setTimeout(() => controller.abort(), 30);
		const error = await pending;
		expect(error.code).toBe("aborted");
		await expect(client.status({ timeoutMs: 2_000 })).resolves.toMatchObject({ engineVersion: "0.1.0-late" });
	});

	test("timing out one request during startup does not fail the shared engine", async () => {
		vi.stubEnv("PI_WEB_TEST_READY_DELAY_MS", "200");
		const client = createClient({ binaryPath: fixture("late-ready.mjs") });
		const started = Date.now();
		const error = await captureError(client.status({ timeoutMs: 50 }));
		expect(error.code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(250);
		await expect(client.status({ timeoutMs: 2_000 })).resolves.toMatchObject({ engineVersion: "0.1.0-late" });
	});

	test("closing during startup rejects the waiter and bounds the shutdown", async () => {
		const client = createClient({
			binaryPath: fixture("silent.mjs"),
			startupTimeoutMs: 5_000,
			shutdownTimeoutMs: 100,
		});
		const pending = captureError(client.status());
		const started = Date.now();
		await client.close();
		const error = await pending;
		expect(error.code).toBe("closed");
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe("status requests", () => {
	test("bounds concurrent pending requests before writing to the engine", async () => {
		const client = createClient();
		const results = await Promise.allSettled(Array.from({ length: 33 }, () => client.status()));
		expect(results.slice(0, 32).every((result) => result.status === "fulfilled")).toBe(true);
		expect(results[32]).toMatchObject({ status: "rejected", reason: { code: "busy" } });
	});

	test("rejects a response for a request ID that was never issued", async () => {
		const client = createClient({ binaryPath: fixture("unknown-id.mjs") });
		const error = await captureError(client.status({ timeoutMs: 1_000 }));
		expect(error.code).toBe("protocol_error");
	});

	test("rejects promptly when stdout closes but the process remains alive", async () => {
		const client = createClient({ binaryPath: fixture("stdout-end.mjs") });
		const error = await captureError(client.status({ timeoutMs: 1_000 }));
		expect(error.code).toBe("engine_exit");
	});

	test("resolves concurrent requests out of order", async () => {
		vi.stubEnv("PI_WEB_TEST_DELAYS", "80,0");
		const client = createClient();
		const order: string[] = [];
		const first = client.status().then((status) => {
			order.push("first");
			return status;
		});
		const second = client.status().then((status) => {
			order.push("second");
			return status;
		});
		const [firstStatus, secondStatus] = await Promise.all([first, second]);
		expect(order).toEqual(["second", "first"]);
		expect(firstStatus.engineVersion).toBe("0.1.0-test");
		expect(secondStatus.engineVersion).toBe("0.1.0-test");
	});

	test("aborting one request leaves the process and other requests alive", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_HOLD", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient();
		const controller = new AbortController();
		const held = captureError(client.status({ signal: controller.signal, timeoutMs: 5_000 }));
		await waitFor(() => readLines(log).length === 1);
		await expect(client.status({ timeoutMs: 1_000 })).resolves.toMatchObject({ engineVersion: "0.1.0-test" });
		controller.abort();
		const error = await held;
		expect(error.code).toBe("aborted");
		await expect(client.status({ timeoutMs: 1_000 })).resolves.toMatchObject({ engineVersion: "0.1.0-test" });
		expect(readLines(log)).toEqual(["1", "2", "3"]);
	});

	test("a timed out request does not replay and leaves the process alive", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_HOLD", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient();
		const held = captureError(client.status({ timeoutMs: 1_000 }));
		await waitFor(() => readLines(log).length === 1);
		await expect(client.status({ timeoutMs: 1_000 })).resolves.toMatchObject({ engineVersion: "0.1.0-test" });
		const error = await held;
		expect(error.code).toBe("timeout");
		await expect(client.status({ timeoutMs: 1_000 })).resolves.toMatchObject({ engineVersion: "0.1.0-test" });
		expect(readLines(log)).toEqual(["1", "2", "3"]);
	});

	test("rejects invalid request timeouts without starting the engine", async () => {
		const client = createClient();
		for (const timeoutMs of [0, -1, 120_001, 1.5]) {
			const error = await captureError(client.status({ timeoutMs }));
			expect(error.code).toBe("invalid_argument");
		}
	});

	test("maps engine error frames to typed errors", async () => {
		vi.stubEnv("PI_WEB_TEST_ERROR_CODE", "busy");
		const client = createClient();
		const error = await captureError(client.status());
		expect(error.code).toBe("busy");
		expect(error.message).toBe("Injected failure");
	});

	test("rejects an invalid result frame", async () => {
		const client = createClient({ binaryPath: fixture("bad-result.mjs") });
		const error = await captureError(client.status());
		expect(error.code).toBe("protocol_error");
		expect(error.message).toMatch(/no engine version/);
	});

	test("rejects an oversized result frame", async () => {
		const client = createClient({ binaryPath: fixture("oversize-result.mjs") });
		const error = await captureError(client.status());
		expect(error.code).toBe("protocol_error");
		expect(error.message).toMatch(/exceeds 65536 bytes/);
	});

	test("treats a null-ID error frame as a connection failure", async () => {
		const client = createClient({ binaryPath: fixture("null-id-error.mjs") });
		const error = await captureError(client.status());
		expect(error.code).toBe("protocol_error");
		expect(error.message).toMatch(/reported a connection error: bad frame/);
	});

	test("rejects pending requests when writing fails", async () => {
		const client = createClient({ binaryPath: fixture("closed-stdin.mjs") });
		const error = await captureError(client.status({ timeoutMs: 1_000 }));
		expect(error.code).toBe("write_failed");
	});

	test("drains stderr without exposing its contents", async () => {
		vi.stubEnv("PI_WEB_TEST_STDERR", "1");
		const client = createClient();
		await expect(client.status()).resolves.toMatchObject({ engineVersion: "0.1.0-test" });
	});

	test("does not expose stderr in connection errors", async () => {
		const client = createClient({ binaryPath: fixture("stderr-exit.mjs"), startupTimeoutMs: 2_000 });
		const error = await captureError(client.status());
		expect(error.code).toBe("engine_exit");
		expect(error.message).not.toContain("secret diagnostic output");
	});
});

describe("http requests", () => {
	test("releases capacity after each successful operation", async () => {
		const client = createClient({ binaryPath: fixture("http.mjs") });
		for (let index = 0; index < 40; index++) {
			await expect(client.status()).resolves.toMatchObject({ protocolVersion: 1 });
			await expect(client.httpRequest({ url: "http://localhost/items" })).resolves.toMatchObject({ status: 200 });
		}
	});

	test("sends typed parameters and parses the HTTP result", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("http.mjs") });
		const params = {
			url: "http://localhost:3000/api/items",
			method: "POST" as const,
			headers: { "content-type": "application/json" },
			body: '{"name":"example"}',
			select: ["/name"],
			maxResponseBytes: 2_048,
			maxOutputBytes: 2_048,
			maxRedirects: 2,
		};
		await expect(client.httpRequest(params)).resolves.toEqual({
			url: "http://localhost:3000/api/items",
			status: 200,
			headers: { "content-type": "application/json" },
			body: '{"name":"example"}',
			truncated: false,
			bytesReceived: 18,
			missingPointers: [],
		});
		expect(JSON.parse(readLines(log)[0] ?? "null")).toMatchObject({
			type: "request",
			id: "1",
			operation: "http_request",
			timeoutMs: expect.any(Number),
			params,
		});
	});

	test("dispatches out-of-order operation results to their own parsers", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		vi.stubEnv("PI_WEB_TEST_DELAYS", "80,0");
		const client = createClient({ binaryPath: fixture("http.mjs") });
		const order: string[] = [];
		const status = client.status().then((result) => {
			order.push("status");
			return result;
		});
		const http = client.httpRequest({ url: "http://localhost:3000/items" }).then((result) => {
			order.push("http");
			return result;
		});
		const [statusResult, httpResult] = await Promise.all([status, http]);
		expect(order).toEqual(["http", "status"]);
		expect(statusResult.operations).toEqual(["status"]);
		expect(httpResult.status).toBe(200);
		expect(readLines(log).map((line) => JSON.parse(line).operation)).toEqual(["status", "http_request"]);
	});

	test("maps operation error frames to typed errors", async () => {
		vi.stubEnv("PI_WEB_TEST_HTTP_ERROR_CODE", "invalid_params");
		const client = createClient({ binaryPath: fixture("http.mjs") });
		const error = await captureError(client.httpRequest({ url: "http://localhost:3000/items" }));
		expect(error.code).toBe("invalid_params");
		expect(error.message).toBe("Injected failure");
	});

	test("rejects an invalid HTTP result frame", async () => {
		vi.stubEnv(
			"PI_WEB_TEST_HTTP_RESULT",
			JSON.stringify({
				url: "http://localhost:3000/items",
				status: 200,
				headers: "invalid",
				body: "",
				truncated: false,
				bytesReceived: 0,
				missingPointers: [],
			}),
		);
		const client = createClient({ binaryPath: fixture("http.mjs") });
		const error = await captureError(client.httpRequest({ url: "http://localhost:3000/items" }));
		expect(error.code).toBe("protocol_error");
		expect(error.message).toMatch(/invalid headers/);
	});

	test("rejects an oversized outgoing frame without failing other requests", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_HOLD", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("http.mjs") });
		const controller = new AbortController();
		const held = captureError(client.status({ signal: controller.signal, timeoutMs: 5_000 }));
		await waitFor(() => readLines(log).length === 1);
		const error = await captureError(client.httpRequest({ url: `http://localhost/${"x".repeat(70_000)}` }));
		expect(error.code).toBe("invalid_argument");
		expect(error.message).toMatch(/exceeds 65536 bytes/);
		await expect(client.status({ timeoutMs: 1_000 })).resolves.toMatchObject({ engineVersion: "0.1.0-test" });
		controller.abort();
		expect((await held).code).toBe("aborted");
		await expect(client.status({ timeoutMs: 1_000 })).resolves.toMatchObject({ engineVersion: "0.1.0-test" });
		expect(readLines(log).map((line) => JSON.parse(line).operation)).toEqual(["status", "status", "status"]);
		expect(readLines(log).map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3"]);
	});
});

describe("search requests", () => {
	test("reports web_search in the engine operations", async () => {
		const client = createClient({ binaryPath: fixture("search.mjs") });
		await expect(client.status()).resolves.toEqual({
			engineVersion: "0.1.0-test",
			protocolVersion: 1,
			operations: ["status", "web_search"],
		});
	});

	test("sends typed search parameters and parses the result", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("search.mjs") });
		const params = {
			query: "ownership",
			site: "doc.rust-lang.org",
			maxResults: 3,
			maxOutputBytes: 4_096,
		};
		await expect(client.webSearch(params)).resolves.toEqual({
			query: "ownership",
			site: "doc.rust-lang.org",
			status: "ok",
			results: [
				{
					title: "Rust async book",
					url: "https://doc.rust-lang.org/book/ch17-00-async-await.html",
					snippet: "Asynchronous programming in Rust.",
					source: "yahoo",
				},
				{
					title: "Async Rust",
					url: "https://doc.rust-lang.org/async/",
					snippet: "Async support in the standard library.",
					source: "yahoo",
				},
			],
			attempts: [{ provider: "yahoo", status: "ok" }],
			truncated: false,
		});
		expect(JSON.parse(readLines(log)[0] ?? "null")).toMatchObject({
			type: "request",
			id: "1",
			operation: "web_search",
			timeoutMs: expect.any(Number),
			params,
		});
	});

	test("omits site when the search result has none", async () => {
		const client = createClient({ binaryPath: fixture("search.mjs") });
		const result = await client.webSearch({ query: "rust async" });
		expect(result).not.toHaveProperty("site");
		expect(result.query).toBe("rust async");
	});

	test("dispatches out-of-order search results to their own parser", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		vi.stubEnv("PI_WEB_TEST_DELAYS", "80,0");
		const client = createClient({ binaryPath: fixture("search.mjs") });
		const order: string[] = [];
		const status = client.status().then((result) => {
			order.push("status");
			return result;
		});
		const search = client.webSearch({ query: "rust async" }).then((result) => {
			order.push("search");
			return result;
		});
		const [statusResult, searchResult] = await Promise.all([status, search]);
		expect(order).toEqual(["search", "status"]);
		expect(statusResult.operations).toEqual(["status", "web_search"]);
		expect(searchResult.status).toBe("ok");
		expect(readLines(log).map((line) => JSON.parse(line).operation)).toEqual(["status", "web_search"]);
	});

	test("keeps valid empty results separate from provider unavailability", async () => {
		for (const status of ["empty", "unavailable"] as const) {
			const result = {
				query: "rust",
				status,
				results: [],
				attempts: [{ provider: "yahoo", status: status === "empty" ? "empty" : "blocked" }],
				truncated: false,
			};
			vi.stubEnv("PI_WEB_TEST_SEARCH_RESULT", JSON.stringify(result));
			const client = createClient({ binaryPath: fixture("search.mjs") });
			await expect(client.webSearch({ query: "rust" })).resolves.toEqual(result);
		}
	});

	test("rejects an invalid search result frame", async () => {
		const item = {
			title: "Rust async book",
			url: "https://rust-lang.github.io/async-book/",
			snippet: "Asynchronous programming in Rust.",
			source: "yahoo",
		};
		const base = {
			query: "rust async",
			status: "ok",
			results: [item],
			attempts: [{ provider: "yahoo", status: "ok" }],
			truncated: false,
		};
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ ...base, query: "" }, /no query/],
			[{ ...base, query: 1 }, /no query/],
			[{ ...base, status: "blocked" }, /invalid status/],
			[{ ...base, results: [] }, /no results for an ok status/],
			[{ ...base, status: "empty" }, /results for a non-ok status/],
			[{ ...base, results: [{ ...item, source: "google" }] }, /invalid provider/],
			[{ ...base, results: [{ ...item, url: "ftp://example.com/" }] }, /unsafe URL/],
			[{ ...base, results: [{ ...item, url: "https://user:pass@example.com/" }] }, /unsafe URL/],
			[{ ...base, results: [{ ...item, url: "/relative" }] }, /invalid URL/],
			[{ ...base, attempts: [{ provider: "yahoo", status: "captcha" }] }, /invalid attempt status/],
			[{ ...base, attempts: "none" }, /invalid attempts/],
			[{ ...base, attempts: [] }, /invalid attempts/],
			[{ ...base, attempts: Array.from({ length: 3 }, () => base.attempts[0]) }, /invalid attempts/],
			[{ ...base, results: Array.from({ length: 11 }, () => item) }, /invalid results/],
			[{ ...base, results: [{ ...item, title: "é".repeat(129) }] }, /no title/],
			[{ ...base, results: [{ ...item, snippet: "é".repeat(257) }] }, /no snippet/],
			[{ ...base, truncated: "no" }, /no truncation flag/],
		];
		for (const [result, message] of cases) {
			vi.stubEnv("PI_WEB_TEST_SEARCH_RESULT", JSON.stringify(result));
			const client = createClient({ binaryPath: fixture("search.mjs") });
			const error = await captureError(client.webSearch({ query: "rust async" }));
			expect(error.code).toBe("protocol_error");
			expect(error.message).toMatch(message);
		}
	});

	test("maps search error frames to typed errors", async () => {
		for (const code of ["invalid_params", "output_limit"]) {
			vi.stubEnv("PI_WEB_TEST_SEARCH_ERROR_CODE", code);
			const client = createClient({ binaryPath: fixture("search.mjs") });
			const error = await captureError(client.webSearch({ query: "rust async" }));
			expect(error.code).toBe(code);
			expect(error.message).toBe("Injected failure");
		}
	});
});

describe("fetch requests", () => {
	test("reports web_fetch in the engine operations", async () => {
		const client = createClient({ binaryPath: fixture("fetch.mjs") });
		await expect(client.status()).resolves.toEqual({
			engineVersion: "0.1.0-test",
			protocolVersion: 1,
			operations: ["status", "web_fetch"],
		});
	});

	test("sends typed fetch parameters and parses the result", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("fetch.mjs") });
		const params = {
			url: "https://example.com/article",
			credential: "docs",
			maxResponseBytes: 4_096,
			maxOutputBytes: 2_048,
			maxRedirects: 2,
		};
		await expect(client.webFetch(params)).resolves.toEqual({
			url: "https://example.com/article",
			status: 200,
			contentType: "text/html",
			title: "Example article",
			content: "# Example\n\nReadable content with [a link](https://example.com/docs).",
			format: "markdown",
			access: "ok",
			extraction: "readability",
			truncated: false,
			bytesReceived: 1200,
		});
		expect(JSON.parse(readLines(log)[0] ?? "null")).toMatchObject({
			type: "request",
			id: "1",
			operation: "web_fetch",
			timeoutMs: expect.any(Number),
			params,
		});
	});

	test("dispatches out-of-order fetch and status results to their own parsers", async () => {
		vi.stubEnv("PI_WEB_TEST_DELAYS", "70,10");
		const client = createClient({ binaryPath: fixture("fetch.mjs") });
		const [page, status] = await Promise.all([
			client.webFetch({ url: "https://example.com/article" }),
			client.status(),
		]);
		expect(page).toMatchObject({ access: "ok", title: "Example article" });
		expect(status.operations).toEqual(["status", "web_fetch"]);
	});

	test("accepts redacted URL metadata without parsing it", async () => {
		const result = {
			url: "REDACTED",
			status: 200,
			contentType: "text/plain",
			title: "",
			content: "readable text",
			format: "text",
			access: "ok",
			extraction: "text",
			truncated: false,
			bytesReceived: 13,
		};
		vi.stubEnv("PI_WEB_TEST_FETCH_RESULT", JSON.stringify(result));
		const client = createClient({ binaryPath: fixture("fetch.mjs") });
		await expect(client.webFetch({ url: "https://example.com/" })).resolves.toEqual(result);
	});

	test.each([
		["blocked", 403, "none"],
		["auth_required", 401, "none"],
		["http_error", 500, "none"],
		["requires_javascript", 200, "none"],
		["empty", 200, "none"],
	] as const)("returns a %s access failure as a result with empty content", async (access, status, extraction) => {
		const result = {
			url: "https://example.com/private",
			status,
			contentType: "text/html",
			title: "",
			content: "",
			format: "markdown",
			access,
			extraction,
			truncated: false,
			bytesReceived: 42,
		};
		vi.stubEnv("PI_WEB_TEST_FETCH_RESULT", JSON.stringify(result));
		const client = createClient({ binaryPath: fixture("fetch.mjs") });
		await expect(client.webFetch({ url: "https://example.com/private" })).resolves.toEqual(result);
	});

	test("rejects an invalid fetch result frame", async () => {
		const base = {
			url: "https://example.com/article",
			status: 200,
			contentType: "text/html",
			title: "Example article",
			content: "# Example",
			format: "markdown",
			access: "ok",
			extraction: "readability",
			truncated: false,
			bytesReceived: 1200,
		};
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ ...base, url: "" }, /no URL/],
			[{ ...base, url: 1 }, /no URL/],
			[{ ...base, status: 99 }, /invalid status/],
			[{ ...base, status: 600 }, /invalid status/],
			[{ ...base, status: 200.5 }, /invalid status/],
			[{ ...base, contentType: "" }, /no content type/],
			[{ ...base, contentType: 1 }, /no content type/],
			[{ ...base, title: "é".repeat(129) }, /invalid title/],
			[{ ...base, title: 1 }, /invalid title/],
			[{ ...base, content: "" }, /blank content/],
			[{ ...base, content: " \n\t" }, /blank content/],
			[{ ...base, content: 1 }, /no content/],
			[{ ...base, access: "blocked", extraction: "none" }, /content for a failed access status/],
			[{ ...base, extraction: "none" }, /inconsistent extraction mode/],
			[{ ...base, access: "blocked", content: "" }, /inconsistent extraction mode/],
			[{ ...base, format: "text" }, /inconsistent content format/],
			[{ ...base, status: 403 }, /inconsistent HTTP status/],
			[{ ...base, format: "html" }, /invalid format/],
			[{ ...base, access: "timeout" }, /invalid access status/],
			[{ ...base, extraction: "reader" }, /invalid extraction mode/],
			[{ ...base, truncated: "no" }, /no truncation flag/],
			[{ ...base, bytesReceived: -1 }, /invalid byte count/],
			[{ ...base, bytesReceived: 1.5 }, /invalid byte count/],
		];
		for (const [result, message] of cases) {
			vi.stubEnv("PI_WEB_TEST_FETCH_RESULT", JSON.stringify(result));
			const client = createClient({ binaryPath: fixture("fetch.mjs") });
			const error = await captureError(client.webFetch({ url: "https://example.com/article" }));
			expect(error.code).toBe("protocol_error");
			expect(error.message).toMatch(message);
		}
	});

	test("maps fetch error frames to typed errors", async () => {
		for (const code of [
			"invalid_params",
			"network_error",
			"redirect_limit",
			"credential_error",
			"unsupported_response",
			"response_limit",
			"output_limit",
		] as const) {
			vi.stubEnv("PI_WEB_TEST_FETCH_ERROR_CODE", code);
			const client = createClient({ binaryPath: fixture("fetch.mjs") });
			const error = await captureError(client.webFetch({ url: "https://example.com/article" }));
			expect(error.code).toBe(code);
			expect(error.message).toBe("Injected failure");
		}
	});

	test("cancels an in-flight fetch and keeps the engine alive", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_HOLD", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("fetch.mjs") });
		const controller = new AbortController();
		const held = captureError(
			client.webFetch({ url: "https://example.com/held" }, { signal: controller.signal, timeoutMs: 5_000 }),
		);
		await waitFor(() => readLines(log).length === 1);
		await expect(client.status({ timeoutMs: 1_000 })).resolves.toMatchObject({ protocolVersion: 1 });
		controller.abort();
		expect((await held).code).toBe("aborted");
		await expect(client.webFetch({ url: "https://example.com/next" })).resolves.toMatchObject({ status: 200 });
		expect(readLines(log).map((line) => JSON.parse(line).operation)).toEqual(["web_fetch", "status", "web_fetch"]);
	});

	test("rejects a pending fetch when the client closes", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_HOLD", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("fetch.mjs"), shutdownTimeoutMs: 100 });
		const pending = captureError(client.webFetch({ url: "https://example.com/held" }, { timeoutMs: 5_000 }));
		await waitFor(() => readLines(log).length === 1);
		await client.close();
		expect((await pending).code).toBe("closed");
	});
});

describe("git operations", () => {
	test("reports the Git operations in the engine status", async () => {
		const client = createClient({ binaryPath: fixture("git.mjs") });
		await expect(client.status()).resolves.toEqual({
			engineVersion: "0.1.0-test",
			protocolVersion: 1,
			operations: ["status", "git_index", "git_search", "git_read"],
		});
	});

	test("sends typed Git index parameters and parses the result", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("git.mjs") });
		const params = {
			source: "/tmp/repo",
			scope: "history" as const,
			revision: "HEAD~2",
			maxCommits: 25,
			maxFiles: 100,
			maxFileBytes: 2_048,
			maxTotalBytes: 1_048_576,
			maxDownloadBytes: 1_048_576,
			maxOutputBytes: 2_048,
		};
		await expect(client.gitIndex(params)).resolves.toEqual(GIT_INDEX_RESULT);
		expect(JSON.parse(readLines(log)[0] ?? "null")).toMatchObject({
			type: "request",
			id: "1",
			operation: "git_index",
			timeoutMs: expect.any(Number),
			params,
		});
	});

	test("parses a partial index with skipped counts and limits", async () => {
		const result = {
			...GIT_INDEX_RESULT,
			scope: "head",
			revision: "main",
			status: "partial",
			skipped: {
				...GIT_SKIPPED,
				binary: 2,
				large: 1,
				nonUtf8: 1,
				unsafePath: 3,
				unreadable: 1,
				submodule: 1,
				duplicate: 4,
			},
			limitsReached: ["file_limit", "byte_limit", "shallow_history"],
		};
		vi.stubEnv("PI_WEB_TEST_GIT_INDEX_RESULT", JSON.stringify(result));
		const client = createClient({ binaryPath: fixture("git.mjs") });
		await expect(client.gitIndex({ source: "/tmp/repo", scope: "head" })).resolves.toEqual(result);
	});

	test("dispatches out-of-order Git results to their own parsers", async () => {
		vi.stubEnv("PI_WEB_TEST_DELAYS", "70,10");
		const client = createClient({ binaryPath: fixture("git.mjs") });
		const [index, status] = await Promise.all([client.gitIndex({ source: "/tmp/repo" }), client.status()]);
		expect(index).toMatchObject({ indexId: GIT_INDEX_ID, scope: "worktree", revision: null });
		expect(status.operations).toEqual(["status", "git_index", "git_search", "git_read"]);
	});

	test("rejects an invalid Git index result frame", async () => {
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ ...GIT_INDEX_RESULT, indexId: GIT_INDEX_ID.toUpperCase() }, /invalid index ID/],
			[{ ...GIT_INDEX_RESULT, indexId: "a".repeat(63) }, /invalid index ID/],
			[{ ...GIT_INDEX_RESULT, source: "" }, /invalid source/],
			[{ ...GIT_INDEX_RESULT, source: "x".repeat(4_097) }, /invalid source/],
			[{ ...GIT_INDEX_RESULT, source: "repo\u0000" }, /invalid source/],
			[{ ...GIT_INDEX_RESULT, scope: "tree" }, /invalid scope/],
			[{ ...GIT_INDEX_RESULT, scope: "worktree" }, /inconsistent revision/],
			[{ ...GIT_INDEX_RESULT, scope: "head", resolvedCommit: null }, /inconsistent resolved commit/],
			[{ ...GIT_INDEX_RESULT, scope: "head", revision: null }, /inconsistent revision/],
			[{ ...GIT_INDEX_RESULT, revision: "x".repeat(257) }, /invalid revision/],
			[{ ...GIT_INDEX_RESULT, resolvedCommit: "not-a-commit" }, /invalid resolved commit/],
			[{ ...GIT_INDEX_RESULT, status: "complete" }, /invalid status/],
			[{ ...GIT_INDEX_RESULT, filesIndexed: -1 }, /invalid filesIndexed count/],
			[{ ...GIT_INDEX_RESULT, filesIndexed: 1.5 }, /invalid filesIndexed count/],
			[{ ...GIT_INDEX_RESULT, bytesIndexed: -1 }, /invalid bytesIndexed count/],
			[{ ...GIT_INDEX_RESULT, commitsVisited: -1 }, /invalid commitsVisited count/],
			[{ ...GIT_INDEX_RESULT, downloadBytes: -1 }, /invalid downloadBytes count/],
			[{ ...GIT_INDEX_RESULT, skipped: "none" }, /invalid skipped counts/],
			[{ ...GIT_INDEX_RESULT, skipped: { ...GIT_SKIPPED, binary: -1 } }, /invalid binary skip count/],
			[{ ...GIT_INDEX_RESULT, limitsReached: "none" }, /invalid limits/],
			[{ ...GIT_INDEX_RESULT, limitsReached: ["size_limit"] }, /invalid limit/],
			[{ ...GIT_INDEX_RESULT, limitsReached: ["file_limit", "file_limit"] }, /duplicate limit/],
			[{ ...GIT_INDEX_RESULT, indexedAt: -1 }, /invalid indexedAt time/],
		];
		for (const [result, message] of cases) {
			vi.stubEnv("PI_WEB_TEST_GIT_INDEX_RESULT", JSON.stringify(result));
			const client = createClient({ binaryPath: fixture("git.mjs") });
			const error = await captureError(client.gitIndex({ source: "/tmp/repo" }));
			expect(error.code).toBe("protocol_error");
			expect(error.message).toMatch(message);
		}
	});

	test("sends typed Git search parameters and parses the result", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("git.mjs") });
		const params = {
			indexId: GIT_INDEX_ID,
			query: "answer",
			regex: true,
			caseSensitive: false,
			path: "src/",
			maxResults: 5,
			maxOutputBytes: 2_048,
		};
		await expect(client.gitSearch(params)).resolves.toEqual({
			indexId: GIT_INDEX_ID,
			query: "answer",
			status: "ok",
			results: [
				{
					path: "src/lib.rs",
					revision: null,
					line: 1,
					column: 1,
					snippet: "pub fn answer() -> u32 { 42 }",
				},
			],
			partial: false,
			truncated: false,
		});
		expect(JSON.parse(readLines(log)[0] ?? "null")).toMatchObject({
			type: "request",
			id: "1",
			operation: "git_search",
			timeoutMs: expect.any(Number),
			params,
		});
	});

	test("rejects an invalid Git search result frame", async () => {
		const item = {
			path: "src/lib.rs",
			revision: null,
			line: 1,
			column: 1,
			snippet: "pub fn answer() -> u32 { 42 }",
		};
		const base = {
			indexId: GIT_INDEX_ID,
			query: "answer",
			status: "ok",
			results: [item],
			partial: false,
			truncated: false,
		};
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ ...base, indexId: "A".repeat(64) }, /invalid index ID/],
			[{ ...base, query: "" }, /no query/],
			[{ ...base, query: "   " }, /no query/],
			[{ ...base, query: "x".repeat(513) }, /no query/],
			[{ ...base, query: "answer\u0000" }, /no query/],
			[{ ...base, status: "partial" }, /invalid status/],
			[{ ...base, results: [] }, /no results for an ok status/],
			[{ ...base, status: "empty" }, /results for an empty status/],
			[{ ...base, results: "none" }, /invalid results/],
			[{ ...base, results: Array.from({ length: 51 }, () => item) }, /invalid results/],
			[{ ...base, results: [{ ...item, path: "" }] }, /invalid path/],
			[{ ...base, results: [{ ...item, path: "/etc/passwd" }] }, /invalid path/],
			[{ ...base, results: [{ ...item, path: "é".repeat(513) }] }, /invalid path/],
			[{ ...base, results: [{ ...item, revision: "HEAD" }] }, /invalid revision/],
			[{ ...base, results: [{ ...item, line: 0 }] }, /invalid line/],
			[{ ...base, results: [{ ...item, line: 1.5 }] }, /invalid line/],
			[{ ...base, results: [{ ...item, column: 0 }] }, /invalid column/],
			[{ ...base, results: [{ ...item, snippet: "é".repeat(257) }] }, /invalid snippet/],
			[{ ...base, results: [{ ...item, snippet: 1 }] }, /invalid snippet/],
			[{ ...base, partial: "no" }, /no partial flag/],
			[{ ...base, truncated: "no" }, /no truncation flag/],
		];
		for (const [result, message] of cases) {
			vi.stubEnv("PI_WEB_TEST_GIT_SEARCH_RESULT", JSON.stringify(result));
			const client = createClient({ binaryPath: fixture("git.mjs") });
			const error = await captureError(client.gitSearch({ indexId: GIT_INDEX_ID, query: "answer" }));
			expect(error.code).toBe("protocol_error");
			expect(error.message).toMatch(message);
		}
	});

	test("sends typed Git read parameters and parses the result", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("git.mjs") });
		const params = {
			indexId: GIT_INDEX_ID,
			path: "src/lib.rs",
			revision: GIT_COMMIT,
			startLine: 1,
			startColumn: 1,
			maxLines: 100,
			maxOutputBytes: 2_048,
		};
		await expect(client.gitRead(params)).resolves.toEqual({
			indexId: GIT_INDEX_ID,
			path: "src/lib.rs",
			revision: GIT_COMMIT,
			status: "ok",
			startLine: 1,
			startColumn: 1,
			endLine: 1,
			totalLines: 1,
			content: "pub fn answer() -> u32 { 42 }\n",
			truncated: false,
			next: null,
		});
		expect(JSON.parse(readLines(log)[0] ?? "null")).toMatchObject({
			type: "request",
			id: "1",
			operation: "git_read",
			timeoutMs: expect.any(Number),
			params,
		});
	});

	test("parses a continuation within a UTF-8 line", async () => {
		const page = {
			indexId: GIT_INDEX_ID,
			path: "src/lib.rs",
			revision: null,
			status: "ok",
			startLine: 2,
			startColumn: 7,
			endLine: 2,
			totalLines: 2,
			content: "日本",
			truncated: true,
			next: { line: 2, column: 13 },
		};
		vi.stubEnv("PI_WEB_TEST_GIT_READ_RESULT", JSON.stringify(page));
		const client = createClient({ binaryPath: fixture("git.mjs") });
		await expect(
			client.gitRead({ indexId: GIT_INDEX_ID, path: page.path, startLine: 2, startColumn: 7 }),
		).resolves.toEqual(page);
	});

	test("accepts not_found and past-EOF read results", async () => {
		const notFound = {
			indexId: GIT_INDEX_ID,
			path: "src/missing.rs",
			revision: null,
			status: "not_found",
			startLine: 5,
			startColumn: 1,
			endLine: 0,
			totalLines: 0,
			content: "",
			truncated: false,
			next: null,
		};
		vi.stubEnv("PI_WEB_TEST_GIT_READ_RESULT", JSON.stringify(notFound));
		const notFoundClient = createClient({ binaryPath: fixture("git.mjs") });
		await expect(notFoundClient.gitRead({ indexId: GIT_INDEX_ID, path: "src/missing.rs" })).resolves.toEqual(
			notFound,
		);

		const pastEof = { ...notFound, path: "src/lib.rs", status: "ok", totalLines: 2 };
		vi.stubEnv("PI_WEB_TEST_GIT_READ_RESULT", JSON.stringify(pastEof));
		const pastEofClient = createClient({ binaryPath: fixture("git.mjs") });
		await expect(pastEofClient.gitRead({ indexId: GIT_INDEX_ID, path: "src/lib.rs", startLine: 5 })).resolves.toEqual(
			pastEof,
		);
	});

	test("rejects an invalid Git read result frame", async () => {
		const base = {
			indexId: GIT_INDEX_ID,
			path: "src/lib.rs",
			revision: null,
			status: "ok",
			startLine: 1,
			startColumn: 1,
			endLine: 1,
			totalLines: 1,
			content: "fn main() {}\n",
			truncated: false,
			next: null,
		};
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ ...base, indexId: "c".repeat(63) }, /invalid index ID/],
			[{ ...base, path: "" }, /invalid path/],
			[{ ...base, path: "/etc/passwd" }, /invalid path/],
			[{ ...base, path: "x".repeat(1_025) }, /invalid path/],
			[{ ...base, revision: "HEAD" }, /invalid revision/],
			[{ ...base, status: "missing" }, /invalid status/],
			[{ ...base, startLine: 0 }, /invalid start line/],
			[{ ...base, startLine: 10_000_001 }, /invalid start line/],
			[{ ...base, startColumn: 4_194_305 }, /invalid start column/],
			[{ ...base, endLine: -1 }, /invalid end line/],
			[{ ...base, totalLines: -1 }, /invalid total line count/],
			[{ ...base, status: "not_found" }, /content for a not_found status/],
			[{ ...base, status: "not_found", content: "" }, /line counts for a not_found status/],
			[{ ...base, content: "", endLine: 1 }, /line counts for empty content/],
			[{ ...base, content: "a\n", endLine: 0 }, /inconsistent line counts/],
			[{ ...base, endLine: 2, totalLines: 1 }, /inconsistent line counts/],
			[{ ...base, content: "x".repeat(49_153) }, /invalid content/],
			[{ ...base, truncated: "no" }, /no truncation flag/],
			[{ ...base, truncated: true }, /invalid continuation/],
			[{ ...base, next: { line: 2, column: 1 } }, /invalid continuation/],
			[{ ...base, truncated: true, content: "日", next: { line: 1, column: 2 } }, /invalid continuation/],
		];
		for (const [result, message] of cases) {
			vi.stubEnv("PI_WEB_TEST_GIT_READ_RESULT", JSON.stringify(result));
			const client = createClient({ binaryPath: fixture("git.mjs") });
			const error = await captureError(client.gitRead({ indexId: GIT_INDEX_ID, path: "src/lib.rs" }));
			expect(error.code).toBe("protocol_error");
			expect(error.message).toMatch(message);
		}
	});

	test("maps Git error frames to typed errors", async () => {
		for (const code of ["repository_error", "index_not_found", "index_incompatible", "resource_limit"] as const) {
			vi.stubEnv("PI_WEB_TEST_GIT_ERROR_CODE", code);
			const client = createClient({ binaryPath: fixture("git.mjs") });
			const error = await captureError(client.gitIndex({ source: "/tmp/repo" }));
			expect(error.code).toBe(code);
			expect(error.message).toBe("Injected failure");
		}
	});

	test("cancels an in-flight Git index and keeps the shared engine alive", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_HOLD", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("git.mjs") });
		const controller = new AbortController();
		const held = captureError(
			client.gitIndex({ source: "/tmp/repo" }, { signal: controller.signal, timeoutMs: 5_000 }),
		);
		await waitFor(() => readLines(log).length === 1);
		await expect(client.gitRead({ indexId: GIT_INDEX_ID, path: "src/lib.rs" })).resolves.toMatchObject({
			status: "ok",
		});
		controller.abort();
		expect((await held).code).toBe("aborted");
		await expect(client.gitSearch({ indexId: GIT_INDEX_ID, query: "answer" })).resolves.toMatchObject({
			status: "ok",
		});
		expect(readLines(log).map((line) => JSON.parse(line).operation)).toEqual(["git_index", "git_read", "git_search"]);
	});

	test("rejects a pending Git read when the client closes", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_HOLD", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("git.mjs"), shutdownTimeoutMs: 100 });
		const pending = captureError(client.gitRead({ indexId: GIT_INDEX_ID, path: "src/lib.rs" }, { timeoutMs: 5_000 }));
		await waitFor(() => readLines(log).length === 1);
		await client.close();
		expect((await pending).code).toBe("closed");
	});
});

describe("connection failures", () => {
	test("rejects when the binary cannot be spawned", async () => {
		const client = createClient({ binaryPath: join(tempDir(), "missing-web-engine") });
		const error = await captureError(client.status());
		expect(error.code).toBe("spawn_failed");
	});

	test("rejects startup when the child exits and restarts on the next call", async () => {
		const state = join(tempDir(), "state");
		vi.stubEnv("PI_WEB_TEST_STATE_FILE", state);
		const client = createClient({ binaryPath: fixture("crash-once.mjs") });
		const error = await captureError(client.status());
		expect(error.code).toBe("engine_exit");
		await expect(client.status()).resolves.toMatchObject({ engineVersion: "0.1.0-crash" });
	});

	test("rejects a pending request when the child exits and restarts on the next call", async () => {
		const state = join(tempDir(), "state");
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_STATE_FILE", state);
		vi.stubEnv("PI_WEB_TEST_CRASH_AFTER_READY", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ binaryPath: fixture("crash-once.mjs") });
		const error = await captureError(client.status());
		expect(error.code).toBe("engine_exit");
		await expect(client.status()).resolves.toMatchObject({ engineVersion: "0.1.0-crash" });
		expect(readLines(log)).toEqual(["1", "2"]);
	});
});

describe("close", () => {
	test("rejects pending requests and permanently disposes the client", async () => {
		const log = join(tempDir(), "requests.log");
		vi.stubEnv("PI_WEB_TEST_HOLD", "1");
		vi.stubEnv("PI_WEB_TEST_REQUEST_LOG", log);
		const client = createClient({ shutdownTimeoutMs: 100 });
		const pending = captureError(client.status({ timeoutMs: 5_000 }));
		await waitFor(() => readLines(log).length === 1);
		const started = Date.now();
		await client.close();
		const error = await pending;
		expect(error.code).toBe("closed");
		expect(Date.now() - started).toBeLessThan(1_000);
		const afterClose = await captureError(client.status());
		expect(afterClose.code).toBe("closed");
		await expect(client.close()).resolves.toBeUndefined();
	});

	test("closes without starting an engine and stays idempotent", async () => {
		const client = createClient();
		await expect(client.close()).resolves.toBeUndefined();
		const error = await captureError(client.status());
		expect(error.code).toBe("closed");
		await expect(client.close()).resolves.toBeUndefined();
	});

	test("kills an engine that ignores shutdown within the bound", async () => {
		const pidFile = join(tempDir(), "pid");
		vi.stubEnv("PI_WEB_TEST_PID_FILE", pidFile);
		const client = createClient({ binaryPath: fixture("shutdown-ignore.mjs"), shutdownTimeoutMs: 100 });
		await expect(client.status()).resolves.toMatchObject({ engineVersion: "0.1.0-stubborn" });
		const pid = Number(readFileSync(pidFile, "utf-8"));
		const started = Date.now();
		await client.close();
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
