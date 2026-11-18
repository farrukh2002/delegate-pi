#!/usr/bin/env node
import assert from "node:assert/strict";
import webExtension from "../packages/coding-agent/src/extensions/web/index.ts";

const tools = new Map();
const shutdownHandlers = [];
await webExtension({
	registerTool(definition) {
		tools.set(definition.name, definition);
	},
	on(event, handler) {
		assert.equal(event, "session_shutdown");
		shutdownHandlers.push(handler);
	},
});
const tool = tools.get("web_fetch");
assert.ok(tool);
const checks = [
	{ url: "https://example.com", expected: /example domain/i },
	{ url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html", expected: /ownership/i },
	{ url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API", expected: /fetch/i },
	{ url: "https://github.com/spider-rs/spider" },
	{ url: "https://en.wikipedia.org/wiki/Rust_(programming_language)" },
	{ url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array" },
	{ url: "https://www.reuters.com/world/" },
];
try {
	for (const [index, check] of checks.entries()) {
		const started = performance.now();
		const result = await tool.execute(`live-fetch-${index}`, { url: check.url, maxOutputBytes: 8_192 }, undefined, undefined, { hasUI: false });
		if (result.isError) {
			console.log(JSON.stringify({ host: new URL(check.url).hostname, error: result.content[0].text, elapsedMs: Math.round(performance.now() - started) }));
			assert.equal(check.expected, undefined, "a required public page could not be read");
			continue;
		}
		const page = result.structuredContent;
		assert.deepEqual(JSON.parse(result.content[0].text), page);
		const bytes = Buffer.byteLength(JSON.stringify(page));
		assert.ok(bytes <= 8_192);
		if (check.expected) {
			assert.equal(page.access, "ok");
			assert.match(`${page.title}\n${page.content}`, check.expected);
		} else if (page.access !== "ok") {
			assert.equal(page.content, "");
			assert.equal(page.extraction, "none");
		}
		console.log(JSON.stringify({ host: new URL(check.url).hostname, status: page.status, access: page.access, extraction: page.extraction, title: page.title, truncated: page.truncated, downloadBytes: page.bytesReceived, outputBytes: bytes, elapsedMs: Math.round(performance.now() - started) }));
	}
} finally {
	await Promise.all(shutdownHandlers.map((handler) => handler()));
}
