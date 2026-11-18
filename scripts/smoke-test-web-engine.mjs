#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebEngineClient } from "../packages/coding-agent/src/core/web/client.ts";
import webExtension from "../packages/coding-agent/src/extensions/web/index.ts";

let requestCount = 0;
const server = createServer(async (request, response) => {
	requestCount++;
	const url = new URL(request.url, "http://localhost");
	if (url.pathname === "/redirect") {
		response.writeHead(302, { location: "/items?limit=1" }).end();
		return;
	}
	if (url.pathname === "/page") {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>Native page</title><nav>Navigation noise</nav><main><p>Readable native content with <a href='/docs'>a link</a>.</p></main>");
		return;
	}
	if (url.pathname === "/slow") {
		response.writeHead(200, { "content-type": "text/plain" });
		response.write("waiting");
		const timer = setTimeout(() => response.end("done"), 2_000);
		response.on("close", () => clearTimeout(timer));
		return;
	}
	response.setHeader("content-type", "application/json");
	if (url.pathname === "/error") {
		response.writeHead(429, { "retry-after": "1" }).end(JSON.stringify({ error: "limited" }));
		return;
	}
	if (url.pathname === "/echo") {
		let body = "";
		for await (const chunk of request) body += chunk.toString("utf8");
		response.end(JSON.stringify({ method: request.method, body, header: request.headers["x-test"] }));
		return;
	}
	response.end(
		JSON.stringify({ items: [{ name: "example" }], query: url.searchParams.get("limit"), noise: "unused ".repeat(2_000) }),
	);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const scratch = mkdtempSync(join(tmpdir(), "pi-web-smoke-"));
process.env.PI_WEB_CACHE_DIR = join(scratch, "cache");
const client = new WebEngineClient();
const shutdownHandlers = [];
try {
	const tools = new Map();
	await webExtension({
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		on(event, handler) {
			assert.equal(event, "session_shutdown");
			shutdownHandlers.push(handler);
		},
	});
	const toolNames = ["http_request", "web_search", "web_fetch", "git_index", "git_search", "git_read"];
	assert.deepEqual([...tools.keys()], toolNames);
	const tool = tools.get("http_request");
	const searchTool = tools.get("web_search");
	const fetchTool = tools.get("web_fetch");
	const status = await client.status({ timeoutMs: 5_000 });
	assert.equal(status.protocolVersion, 1);
	assert.deepEqual(status.operations, ["status", ...toolNames]);
	assert.ok(status.engineVersion.length > 0);
	const responses = await Promise.all(Array.from({ length: 16 }, () => client.status({ timeoutMs: 5_000 })));
	for (const response of responses) assert.deepEqual(response, status);
	await assert.rejects(client.status({ signal: AbortSignal.abort() }), { code: "aborted" });

	const selected = await client.httpRequest({
		url: `${origin}/redirect`,
		select: ["/items/0/name", "/query", "/missing"],
	});
	assert.equal(selected.status, 200);
	assert.equal(selected.url, `${origin}/items?limit=1`);
	assert.deepEqual(JSON.parse(selected.body), { "/items/0/name": "example", "/query": "1" });
	assert.deepEqual(selected.missingPointers, ["/missing"]);
	assert.equal(selected.truncated, false);
	assert.ok(selected.bytesReceived > 8_192);
	assert.ok(Buffer.byteLength(JSON.stringify(selected)) < 8_192);

	const posted = await client.httpRequest({
		url: `${origin}/echo`,
		method: "POST",
		headers: { "x-test": "echo-value", "content-type": "application/json" },
		body: JSON.stringify({ value: 1 }),
	});
	assert.equal(posted.status, 200);
	const echo = JSON.parse(posted.body);
	assert.equal(echo.method, "POST");
	assert.equal(echo.body, JSON.stringify({ value: 1 }));
	assert.ok(!posted.body.includes("echo-value"));

	const limited = await client.httpRequest({ url: `${origin}/items`, maxOutputBytes: 1_024 });
	assert.equal(limited.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(limited)) <= 1_024);
	const rejected = await client.httpRequest({ url: `${origin}/error` });
	assert.equal(rejected.status, 429);
	assert.equal(rejected.headers["retry-after"], "1");

	const controller = new AbortController();
	const slow = client.httpRequest({ url: `${origin}/slow` }, { signal: controller.signal });
	const timer = setTimeout(() => controller.abort(), 50);
	try {
		await assert.rejects(slow, { code: "aborted" });
		assert.deepEqual(await client.status(), status);
	} finally {
		clearTimeout(timer);
	}

	const page = await client.webFetch({ url: `${origin}/page` });
	assert.equal(page.access, "ok");
	assert.equal(page.title, "Native page");
	assert.equal(page.extraction, "fallback");
	assert.match(page.content, /Readable native content/);
	assert.ok(!page.content.includes("Navigation noise"));
	assert.ok(page.content.includes(`${origin}/docs`));
	const blockedPage = await client.webFetch({ url: `${origin}/error` });
	assert.equal(blockedPage.status, 429);
	assert.equal(blockedPage.access, "blocked");
	assert.equal(blockedPage.content, "");
	const beforeUnsafeFetch = requestCount;
	await assert.rejects(client.webFetch({ url: `${origin}/echo`, method: "POST" }), { code: "invalid_params" });
	assert.equal(requestCount, beforeUnsafeFetch);
	const fetched = await fetchTool.execute("page", { url: `${origin}/page` }, undefined, undefined, { hasUI: false });
	assert.equal(fetched.isError, undefined);
	assert.deepEqual(fetched.structuredContent, page);
	assert.deepEqual(JSON.parse(fetched.content[0].text), page);

	const repo = join(scratch, "repo");
	execFileSync("git", ["init", "--quiet", "--template=", repo], {
		env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	const line = '日\\"'.repeat(200);
	const path = "long.txt";
	writeFileSync(join(repo, path), line);
	const index = await client.gitIndex({ source: repo });
	assert.equal(index.status, "ok");
	const read = { indexId: index.indexId, path, maxOutputBytes: 1_024 };
	const first = await client.gitRead(read);
	assert.equal(first.truncated, true);
	assert.equal(first.next?.line, 1);
	const second = await client.gitRead({ ...read, startLine: first.next.line, startColumn: first.next.column });
	assert.equal(second.next, null);
	assert.equal(first.content + second.content, line);

	await assert.rejects(client.webSearch({ query: "" }), { code: "invalid_params" });
	const invalidSearch = await searchTool.execute("invalid-search", { query: "" }, undefined, undefined, { hasUI: false });
	assert.equal(invalidSearch.isError, true);
	assert.match(invalidSearch.content[0].text, /invalid_params/);
	const toolResult = await tool.execute(
		"read",
		{ url: `${origin}/items`, select: ["/items/0/name"] },
		undefined,
		undefined,
		{ hasUI: false },
	);
	assert.equal(toolResult.isError, undefined);
	assert.deepEqual(JSON.parse(toolResult.structuredContent.body), { "/items/0/name": "example" });
	const countBeforeApproval = requestCount;
	const mutation = { url: `${origin}/echo?private=query-value`, method: "POST", body: "approved payload" };
	const noUi = await tool.execute("no-ui", mutation, undefined, undefined, { hasUI: false });
	assert.equal(noUi.isError, true);
	const denied = await tool.execute("denied", mutation, undefined, undefined, {
		hasUI: true,
		ui: { confirm: async () => false },
	});
	assert.equal(denied.isError, true);
	assert.equal(requestCount, countBeforeApproval);
	let approvals = 0;
	const approved = await tool.execute("approved", mutation, undefined, undefined, {
		hasUI: true,
		ui: {
			confirm: async (title, message) => {
				approvals++;
				assert.ok(title.includes("POST"));
				assert.ok(message.includes(`${origin}/echo`));
				assert.ok(!message.includes("query-value"));
				return true;
			},
		},
	});
	assert.equal(approvals, 1);
	assert.equal(approved.isError, undefined);
	assert.equal(JSON.parse(approved.structuredContent.body).body, "approved payload");
	assert.equal(requestCount, countBeforeApproval + 1);
	await Promise.all(shutdownHandlers.map((handler) => handler()));
	const afterShutdown = await tool.execute("closed", { url: `${origin}/items` }, undefined, undefined, { hasUI: false });
	assert.equal(afterShutdown.isError, true);
	const searchAfterShutdown = await searchTool.execute("closed-search", { query: "rust" }, undefined, undefined, { hasUI: false });
	assert.equal(searchAfterShutdown.isError, true);
	const fetchAfterShutdown = await fetchTool.execute("closed-fetch", { url: `${origin}/page` }, undefined, undefined, { hasUI: false });
	assert.equal(fetchAfterShutdown.isError, true);
	assert.equal(requestCount, countBeforeApproval + 1);
	await client.close();
	await assert.rejects(client.status(), { code: "closed" });
	console.log(`pi-web ${status.engineVersion}: native HTTP, page extraction, Git paging, Pi tools, approval, limits, redaction, and shutdown passed`);
} finally {
	await Promise.all(shutdownHandlers.map((handler) => handler()));
	await client.close();
	rmSync(scratch, { recursive: true, force: true });
	server.closeAllConnections();
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
