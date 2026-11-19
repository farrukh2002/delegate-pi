import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebEngineFetchResult } from "../../src/core/web/client.ts";
import { createWebExtension, type WebExtensionClient } from "../../src/extensions/web/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const URL = "https://example.com/";
const FETCH_RESULT: WebEngineFetchResult = {
	url: URL,
	status: 200,
	contentType: "text/html",
	title: "Example",
	content: "Example text",
	format: "markdown",
	access: "ok",
	extraction: "readability",
	truncated: false,
	bytesReceived: 100,
};

const OPERATIONS = ["http_request", "web_fetch", "web_search", "git_index", "git_search", "git_read"];

const toolCall = (args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage([fauxToolCall("web_tools", args)], { stopReason: "toolUse" });

function modelPrefix(context: TranscriptContext) {
	return {
		prompt: getCurrentSystemPrompt(context.messages),
		system: context.messages.filter((message) => message.role === "system"),
		tools: getCurrentTools(context.messages),
	};
}

describe("AgentSession web tool gateway", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: Pick<HarnessOptions, "allowedToolNames" | "excludedToolNames"> = {}) {
		const client = {
			httpRequest: vi.fn<WebExtensionClient["httpRequest"]>(),
			webSearch: vi.fn<WebExtensionClient["webSearch"]>(),
			webFetch: vi.fn<WebExtensionClient["webFetch"]>().mockResolvedValue(FETCH_RESULT),
			gitIndex: vi.fn<WebExtensionClient["gitIndex"]>(),
			gitSearch: vi.fn<WebExtensionClient["gitSearch"]>(),
			gitRead: vi.fn<WebExtensionClient["gitRead"]>(),
			close: vi.fn<WebExtensionClient["close"]>().mockResolvedValue(undefined),
		};
		const clientFactory = vi.fn(() => client);
		const harness = await createHarness({ ...options, extensionFactories: [createWebExtension({ clientFactory })] });
		harnesses.push(harness);
		return { harness, client, clientFactory };
	}

	it("keeps declarations and system instructions unchanged across discovery, execution, and a later request", async () => {
		const { harness, client, clientFactory } = await setup();
		const prefixes: ReturnType<typeof modelPrefix>[] = [];
		const observe = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
			prefixes.push(modelPrefix(context));
			return response;
		};
		harness.setResponses([
			observe(toolCall({ operation: "web_fetch", describe: true })),
			(context) => {
				expect(clientFactory).not.toHaveBeenCalled();
				const result = getMessageText(getToolResult(harness, "web_tools"));
				expect(JSON.parse(result)).toMatchObject({
					parameters: { properties: { url: { type: "string" }, maxOutputBytes: { type: "integer" } } },
				});
				return observe(toolCall({ operation: "web_fetch", args: { url: URL, maxOutputBytes: 1800 } }))(context);
			},
			observe(fauxAssistantMessage("Fetched")),
			observe(fauxAssistantMessage("Done")),
		]);
		await harness.session.prompt("Fetch a page");
		await harness.session.prompt("Now answer without tools");

		expect(prefixes).toHaveLength(4);
		const [initial, ...later] = prefixes;
		expect(initial.tools.map((tool) => tool.name)).toContain("web_tools");
		for (const operation of OPERATIONS) {
			expect(initial.tools.map((tool) => tool.name)).not.toContain(operation);
			expect(initial.prompt).not.toContain(`\n- ${operation}:`);
		}
		for (const prefix of later) expect(prefix).toEqual(initial);
		expect(client.webFetch).toHaveBeenCalledExactlyOnceWith({ url: URL, maxOutputBytes: 1800 }, expect.anything());
		const result = getToolResult(harness, "web_tools");
		expect(result.isError).toBe(false);
		expect(JSON.parse(getMessageText(result))).toEqual(FETCH_RESULT);
		expect(result.nestedCalls?.calls).toEqual([expect.objectContaining({ name: "web_fetch" })]);
	});

	it("declares an operation directly when explicitly selected without the gateway", async () => {
		const { harness, client } = await setup({ allowedToolNames: ["web_fetch"] });
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["web_fetch"]);
				return fauxAssistantMessage([fauxToolCall("web_fetch", { url: URL })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Fetch a page");

		expect(getToolResult(harness, "web_fetch").isError).toBe(false);
		expect(client.webFetch).toHaveBeenCalledOnce();
	});

	it("does not reach a disabled operation through the gateway", async () => {
		const { harness, clientFactory } = await setup({ excludedToolNames: ["web_fetch"] });
		harness.setResponses([
			toolCall({ operation: "web_fetch", describe: true }),
			toolCall({ operation: "web_fetch", args: { url: URL } }),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Fetch a page");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => [result.isError, getMessageText(result)])).toEqual([
			[true, "web_fetch is not available in this session."],
			[true, "web_fetch is not available in this session."],
		]);
		expect(clientFactory).not.toHaveBeenCalled();
	});

	it("validates operation arguments and still requires approval for HTTP POST", async () => {
		const { harness, clientFactory } = await setup();
		harness.setResponses([
			toolCall({ operation: "web_fetch", args: { url: URL, maxOutputBytes: 1 } }),
			toolCall({ operation: "http_request", args: { url: URL, method: "POST" } }),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Try both requests");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => result.isError)).toEqual([true, true]);
		expect(getMessageText(results[0])).toContain("maxOutputBytes");
		expect(getMessageText(results[1])).toContain("require user approval");
		expect(clientFactory).not.toHaveBeenCalled();
	});
});
