import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CACHED_SUMMARY_PROMPT,
	requestTail,
	type SessionRequest,
	summarizeFromRequest,
} from "../src/core/compaction/cached-summary.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const usage = (input: number) => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function reply(model: Model<any>, message: Partial<AssistantMessage> = {}) {
	const stream = createAssistantMessageEventStream();
	void Promise.resolve().then(() => {
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				...fauxAssistantMessage("cached summary"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usage(5),
				...message,
			},
		});
	});
	return stream;
}

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(model: Model<any>, text: string, timestamp: number, input = 100): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(input),
		stopReason: "stop",
		timestamp,
	};
}

describe("summarizeFromRequest", () => {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const sent: Context = {
		messages: [
			{ role: "system", content: "sys", timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		],
	};
	const first = user("hi", 1);
	const request: SessionRequest = {
		model,
		context: sent,
		options: { sessionId: "s1", cacheRetention: "short" },
		messages: [first],
	};

	it("keeps the sent prefix and options and appends the tail and the prompt", async () => {
		const stream = vi.fn((m: Model<any>, _c: Context, _o: unknown) => reply(m));
		const signal = new AbortController().signal;
		const tail = [assistant(model, "hello", 2)];
		const result = await summarizeFromRequest(request, tail, stream, signal, "focus on tests");
		expect(result.text).toBe("cached summary");
		const [, context, options] = stream.mock.calls[0];
		expect(context.messages.slice(0, 2)).toEqual(sent.messages);
		expect(context.messages[2].role).toBe("assistant");
		const last = context.messages.at(-1)!;
		expect(last.role).toBe("user");
		expect(JSON.stringify(last.content)).toContain("focus on tests");
		expect(JSON.stringify(last.content)).toContain(CACHED_SUMMARY_PROMPT.slice(0, 40));
		expect(options).toMatchObject({ sessionId: "s1", cacheRetention: "short", signal });
	});

	it("rejects a tool call", async () => {
		const stream = (m: Model<any>) =>
			reply(m, { content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }], stopReason: "toolUse" });
		await expect(summarizeFromRequest(request, [], stream)).rejects.toThrow();
	});

	it("finds the tail only when the sent messages are still the prefix", () => {
		const next = assistant(model, "x", 3);
		expect(requestTail(request, [first, next])).toEqual([next]);
		expect(requestTail(request, [user("hi", 1), next])).toBeUndefined();
		expect(requestTail(request, [])).toBeUndefined();
	});
});

describe("AgentSession cached compaction", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let runtime: ModelRuntime;
	let tempDir: string;
	let lastRequest: SessionRequest | undefined;
	const model = getModel("anthropic", "claude-sonnet-4-5")!;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-cached-compaction-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const agent = new Agent({ streamFn: streamSimple, initialState: { model, systemPrompt: "Test", tools: [] } });
		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: model.contextWindow - 100 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		runtime = getModelRuntime(await createModelRegistry(authStorage, tempDir));
		lastRequest = undefined;
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
			getLastSessionRequest: () => lastRequest,
		});
		const now = Date.now();
		for (const message of [user("old work", now - 3000), assistant(model, "old answer", now - 2000)]) {
			sessionManager.appendMessage(message as never);
		}
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		lastRequest = {
			model,
			context: { messages: [{ role: "system", content: "Test", timestamp: 0 }] },
			options: { sessionId: sessionManager.getSessionId() },
			messages: session.agent.state.messages.slice(0, 1),
		};
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	const internals = () =>
		session as unknown as {
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			_startPrecompute: () => void;
		};

	it("summarizes through the cached request instead of a new context", async () => {
		const cached = vi.spyOn(runtime, "streamSimple").mockImplementation((m) => reply(m));
		const fresh = vi.fn((m: Model<any>) => reply(m, { content: [{ type: "text", text: "fresh summary" }] }));
		session.agent.streamFunction = fresh as never;
		await internals()._runAutoCompaction("threshold", false);
		expect(cached).toHaveBeenCalledTimes(1);
		expect(fresh).not.toHaveBeenCalled();
		const entry = sessionManager.getEntries().find((e) => e.type === "compaction");
		expect(entry?.type === "compaction" && entry.summary).toContain("cached summary");
	});

	it("falls back to the old summary when the model changed", async () => {
		lastRequest = { ...lastRequest!, model: { ...model, id: "other-model" } };
		const cached = vi.spyOn(runtime, "streamSimple").mockImplementation((m) => reply(m));
		session.agent.streamFunction = ((m: Model<any>) =>
			reply(m, { content: [{ type: "text", text: "fresh summary" }] })) as never;
		await internals()._runAutoCompaction("threshold", false);
		expect(cached).not.toHaveBeenCalled();
		const entry = sessionManager.getEntries().find((e) => e.type === "compaction");
		expect(entry?.type === "compaction" && entry.summary).toContain("fresh summary");
	});

	it("uses the precomputed summary at the threshold and keeps the newer turn", async () => {
		const cached = vi.spyOn(runtime, "streamSimple").mockImplementation((m) => reply(m));
		internals()._startPrecompute();
		expect(cached).toHaveBeenCalledTimes(1);
		const now = Date.now();
		const nextUser = user("new work", now);
		const nextAnswer = assistant(model, "new answer", now + 1);
		const userEntryId = sessionManager.appendMessage(nextUser as never);
		sessionManager.appendMessage(nextAnswer as never);
		session.agent.state.messages = [...session.agent.state.messages, nextUser, nextAnswer];
		await internals()._runAutoCompaction("threshold", false);
		expect(cached).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().find((e) => e.type === "compaction");
		expect(entry?.type === "compaction" && entry.firstKeptEntryId).toBe(userEntryId);
	});
});
