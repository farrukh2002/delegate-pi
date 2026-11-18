#!/usr/bin/env node
import assert from "node:assert/strict";
import { WebEngineClient } from "../packages/coding-agent/src/core/web/client.ts";
import { createWebExtension } from "../packages/coding-agent/src/extensions/web/index.ts";

const client = new WebEngineClient();
const tools = new Map();
const shutdownHandlers = [];
await createWebExtension({ clientFactory: () => client })({
	registerTool(definition) { tools.set(definition.name, definition); },
	on(event, handler) {
		assert.equal(event, "session_shutdown");
		shutdownHandlers.push(handler);
	},
});
try {
	const status = await client.status();
	assert.ok(status.operations.includes("web_search"));
	const tool = tools.get("web_search");
	assert.ok(tool);
	for (const params of [
		{ query: "Rust async book", maxResults: 3 },
		{ query: "ownership", site: "doc.rust-lang.org", maxResults: 3 },
		{ query: "James Webb Space Telescope NASA", maxResults: 3 },
	]) {
		const response = await tool.execute("live-search", params, undefined, undefined, { hasUI: false });
		assert.notEqual(response.isError, true);
		const result = response.structuredContent;
		assert.deepEqual(JSON.parse(response.content[0].text), result);
		console.log(JSON.stringify({ ...result, outputBytes: Buffer.byteLength(JSON.stringify(result)) }));
		assert.equal(result.status, "ok", "Live search providers did not supply results");
		assert.ok(result.results.length > 0 && result.results.length <= 3);
		if (params.site) {
			for (const item of result.results) {
				const host = new URL(item.url).hostname;
				assert.ok(host === params.site || host.endsWith(`.${params.site}`));
			}
		}
	}
} finally {
	await Promise.all(shutdownHandlers.map((handler) => handler()));
	await client.close();
}
