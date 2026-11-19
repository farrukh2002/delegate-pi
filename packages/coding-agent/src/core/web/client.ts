import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { getWebEngineBinaryPath } from "../../config.ts";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 65_536;
const MAX_ACTIVE_REQUESTS = 32;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface WebEngineClientOptions {
	binaryPath?: string;
	startupTimeoutMs?: number;
	shutdownTimeoutMs?: number;
}

export interface WebEngineStatusOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface WebEngineHttpOptions extends WebEngineStatusOptions {}

export interface WebEngineSearchOptions extends WebEngineStatusOptions {}

export interface WebEngineFetchOptions extends WebEngineStatusOptions {}

export interface WebEngineGitIndexOptions extends WebEngineStatusOptions {}

export interface WebEngineGitSearchOptions extends WebEngineStatusOptions {}

export interface WebEngineGitReadOptions extends WebEngineStatusOptions {}

export interface WebEngineStatus {
	engineVersion: string;
	protocolVersion: number;
	operations: string[];
}

export type WebEngineHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export interface WebEngineHttpRequest {
	url: string;
	method?: WebEngineHttpMethod;
	headers?: Record<string, string>;
	body?: string;
	credential?: string;
	select?: string[];
	maxResponseBytes?: number;
	maxOutputBytes?: number;
	maxRedirects?: number;
}

export interface WebEngineHttpResult {
	url: string;
	status: number;
	headers: Record<string, string>;
	body: string;
	truncated: boolean;
	bytesReceived: number;
	missingPointers: string[];
}

export interface WebEngineFetchRequest {
	url: string;
	credential?: string;
	maxResponseBytes?: number;
	maxOutputBytes?: number;
	maxRedirects?: number;
}

export type WebEngineFetchFormat = "markdown" | "text";

export type WebEngineFetchAccess = "ok" | "blocked" | "auth_required" | "http_error" | "requires_javascript" | "empty";

export type WebEngineFetchExtraction = "readability" | "fallback" | "text" | "none";

export interface WebEngineFetchResult {
	url: string;
	status: number;
	contentType: string;
	title: string;
	content: string;
	format: WebEngineFetchFormat;
	access: WebEngineFetchAccess;
	extraction: WebEngineFetchExtraction;
	truncated: boolean;
	bytesReceived: number;
}

export const WEB_ENGINE_SEARCH_PROVIDERS = ["exa", "parallel", "firecrawl", "tavily"] as const;

export type WebEngineSearchProvider = (typeof WEB_ENGINE_SEARCH_PROVIDERS)[number];

export type WebEngineSearchStatus = "ok" | "empty" | "unavailable";

export const WEB_ENGINE_SEARCH_ATTEMPT_STATUSES = [
	"ok",
	"empty",
	"blocked",
	"http_error",
	"network_error",
	"timeout",
	"unsupported_response",
	"response_limit",
	"cooling_down",
] as const;

export type WebEngineSearchAttemptStatus = (typeof WEB_ENGINE_SEARCH_ATTEMPT_STATUSES)[number];

export interface WebEngineSearchRequest {
	query: string;
	site?: string;
	maxResults?: number;
	maxOutputBytes?: number;
}

export type WebEngineSearchResultItem = {
	title: string;
	url: string;
	snippet: string;
	source: WebEngineSearchProvider;
};

export const WEB_ENGINE_SEARCH_ATTEMPT_REASONS = ["connect", "body_read", "provider_error", "invalid_payload"] as const;

export type WebEngineSearchAttemptReason = (typeof WEB_ENGINE_SEARCH_ATTEMPT_REASONS)[number];

export type WebEngineSearchAttempt = {
	provider: WebEngineSearchProvider;
	status: WebEngineSearchAttemptStatus;
	httpStatus?: number;
	reason?: WebEngineSearchAttemptReason;
};

export interface WebEngineSearchResult {
	query: string;
	site?: string;
	status: WebEngineSearchStatus;
	results: WebEngineSearchResultItem[];
	attempts: WebEngineSearchAttempt[];
	truncated: boolean;
}

export type WebEngineGitScope = "worktree" | "head" | "history";

export type WebEngineGitIndexStatus = "ok" | "partial";

export type WebEngineGitIndexLimit =
	| "file_limit"
	| "byte_limit"
	| "commit_limit"
	| "entry_limit"
	| "shallow_history"
	| "sparse_checkout";

export interface WebEngineGitIndexRequest {
	source: string;
	scope?: WebEngineGitScope;
	revision?: string;
	maxCommits?: number;
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
	maxDownloadBytes?: number;
	maxOutputBytes?: number;
}

export type WebEngineGitIndexSkipped = {
	binary: number;
	large: number;
	nonUtf8: number;
	unsafePath: number;
	unreadable: number;
	submodule: number;
	duplicate: number;
};

export interface WebEngineGitIndexResult {
	indexId: string;
	source: string;
	scope: WebEngineGitScope;
	revision: string | null;
	resolvedCommit: string | null;
	status: WebEngineGitIndexStatus;
	filesIndexed: number;
	bytesIndexed: number;
	commitsVisited: number;
	downloadBytes: number;
	skipped: WebEngineGitIndexSkipped;
	limitsReached: WebEngineGitIndexLimit[];
	indexedAt: number;
}

export interface WebEngineGitSearchRequest {
	indexId: string;
	query: string;
	regex?: boolean;
	caseSensitive?: boolean;
	path?: string;
	maxResults?: number;
	maxOutputBytes?: number;
}

export type WebEngineGitSearchStatus = "ok" | "empty";

export type WebEngineGitSearchResultItem = {
	path: string;
	revision: string | null;
	line: number;
	column: number;
	snippet: string;
};

export interface WebEngineGitSearchResult {
	indexId: string;
	query: string;
	status: WebEngineGitSearchStatus;
	results: WebEngineGitSearchResultItem[];
	partial: boolean;
	truncated: boolean;
}

export interface WebEngineGitReadRequest {
	indexId: string;
	path: string;
	revision?: string;
	startLine?: number;
	startColumn?: number;
	maxLines?: number;
	maxOutputBytes?: number;
}

export type WebEngineGitReadStatus = "ok" | "not_found";

export interface WebEngineGitReadResult {
	indexId: string;
	path: string;
	revision: string | null;
	status: WebEngineGitReadStatus;
	startLine: number;
	startColumn: number;
	endLine: number;
	totalLines: number;
	content: string;
	truncated: boolean;
	next: { line: number; column: number } | null;
}

export type WebEngineErrorCode =
	| "aborted"
	| "binary_unavailable"
	| "busy"
	| "cancelled"
	| "closed"
	| "engine_exit"
	| "index_incompatible"
	| "index_not_found"
	| "internal"
	| "invalid_argument"
	| "invalid_json"
	| "invalid_params"
	| "invalid_request"
	| "network_error"
	| "output_limit"
	| "protocol_error"
	| "redirect_limit"
	| "credential_error"
	| "repository_error"
	| "resource_limit"
	| "response_limit"
	| "unsupported_response"
	| "spawn_failed"
	| "startup_timeout"
	| "timeout"
	| "unsupported_operation"
	| "unsupported_platform"
	| "write_failed";

export class WebEngineError extends Error {
	readonly code: WebEngineErrorCode;

	constructor(code: WebEngineErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WebEngineError";
		this.code = code;
	}
}

interface PendingRequest {
	result: (value: unknown) => void;
	reject: (error: WebEngineError) => void;
}

interface Connection {
	child: ChildProcessWithoutNullStreams;
	pending: Map<string, PendingRequest>;
	firstRequestId: number;
	lastRequestId: number;
	buffer: Buffer;
	ready: boolean;
	stopped: boolean;
	startup: Promise<void>;
	startupTimer: NodeJS.Timeout | undefined;
	resolveStartup: () => void;
	rejectStartup: (error: WebEngineError) => void;
	exited: Promise<void>;
}

type RequestOperation =
	| { operation: "status" }
	| { operation: "http_request"; params: WebEngineHttpRequest }
	| { operation: "web_search"; params: WebEngineSearchRequest }
	| { operation: "web_fetch"; params: WebEngineFetchRequest }
	| { operation: "git_index"; params: WebEngineGitIndexRequest }
	| { operation: "git_search"; params: WebEngineGitSearchRequest }
	| { operation: "git_read"; params: WebEngineGitReadRequest };

type OutgoingFrame =
	| { type: "request"; id: string; operation: "status"; timeoutMs: number }
	| {
			type: "request";
			id: string;
			operation: "http_request";
			timeoutMs: number;
			params: WebEngineHttpRequest;
	  }
	| {
			type: "request";
			id: string;
			operation: "web_search";
			timeoutMs: number;
			params: WebEngineSearchRequest;
	  }
	| {
			type: "request";
			id: string;
			operation: "web_fetch";
			timeoutMs: number;
			params: WebEngineFetchRequest;
	  }
	| {
			type: "request";
			id: string;
			operation: "git_index";
			timeoutMs: number;
			params: WebEngineGitIndexRequest;
	  }
	| {
			type: "request";
			id: string;
			operation: "git_search";
			timeoutMs: number;
			params: WebEngineGitSearchRequest;
	  }
	| {
			type: "request";
			id: string;
			operation: "git_read";
			timeoutMs: number;
			params: WebEngineGitReadRequest;
	  }
	| { type: "cancel"; id: string }
	| { type: "shutdown" };

export class WebEngineClient {
	private readonly binaryPath: string | undefined;
	private readonly startupTimeoutMs: number;
	private readonly shutdownTimeoutMs: number;
	private connection: Connection | undefined;
	private startPromise: Promise<Connection> | undefined;
	private closePromise: Promise<void> | undefined;
	private requestCounter = 0;
	private closed = false;

	constructor(options: WebEngineClientOptions = {}) {
		this.binaryPath = options.binaryPath;
		this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	}

	status(options: WebEngineStatusOptions = {}): Promise<WebEngineStatus> {
		return this.request({ operation: "status" }, parseStatusResult, options);
	}

	httpRequest(params: WebEngineHttpRequest, options: WebEngineHttpOptions = {}): Promise<WebEngineHttpResult> {
		return this.request({ operation: "http_request", params }, parseHttpResult, options);
	}

	webSearch(params: WebEngineSearchRequest, options: WebEngineSearchOptions = {}): Promise<WebEngineSearchResult> {
		return this.request({ operation: "web_search", params }, parseSearchResult, options);
	}

	webFetch(params: WebEngineFetchRequest, options: WebEngineFetchOptions = {}): Promise<WebEngineFetchResult> {
		return this.request({ operation: "web_fetch", params }, parseFetchResult, options);
	}

	gitIndex(
		params: WebEngineGitIndexRequest,
		options: WebEngineGitIndexOptions = {},
	): Promise<WebEngineGitIndexResult> {
		return this.request({ operation: "git_index", params }, parseGitIndexResult, options);
	}

	gitSearch(
		params: WebEngineGitSearchRequest,
		options: WebEngineGitSearchOptions = {},
	): Promise<WebEngineGitSearchResult> {
		return this.request({ operation: "git_search", params }, parseGitSearchResult, options);
	}

	gitRead(params: WebEngineGitReadRequest, options: WebEngineGitReadOptions = {}): Promise<WebEngineGitReadResult> {
		return this.request({ operation: "git_read", params }, parseGitReadResult, options);
	}

	close(): Promise<void> {
		this.closed = true;
		this.closePromise ??= this.shutdown();
		return this.closePromise;
	}

	private async request<T>(
		request: RequestOperation,
		parseResult: (value: unknown) => T,
		options: WebEngineStatusOptions,
	): Promise<T> {
		if (this.closed) throw new WebEngineError("closed", "Web engine client is closed");
		const timeoutMs = resolveRequestTimeout(options.timeoutMs);
		const signal = options.signal;
		if (signal?.aborted) throw abortedError();
		const deadline = Date.now() + timeoutMs;
		const connection = await this.waitForConnection(deadline, signal);
		if (this.closed) throw new WebEngineError("closed", "Web engine client is closed");
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw timeoutError();
		return this.sendRequest(connection, request, parseResult, remainingMs, signal);
	}

	private ensureConnection(): Promise<Connection> {
		if (this.closed) return Promise.reject(new WebEngineError("closed", "Web engine client is closed"));
		if (this.connection?.ready) return Promise.resolve(this.connection);
		if (this.startPromise) return this.startPromise;
		const promise = this.launch();
		this.startPromise = promise;
		const clear = (): void => {
			if (this.startPromise === promise) this.startPromise = undefined;
		};
		promise.then(clear, clear);
		return promise;
	}

	private launch(): Promise<Connection> {
		if (process.platform !== "linux") {
			return Promise.reject(new WebEngineError("unsupported_platform", "Web engine is only supported on Linux"));
		}
		const binaryPath = this.binaryPath ?? getWebEngineBinaryPath();
		if (!binaryPath) {
			return Promise.reject(new WebEngineError("binary_unavailable", "Web engine binary is not available"));
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		} catch (error) {
			return Promise.reject(new WebEngineError("spawn_failed", "Failed to start web engine", error));
		}
		let resolveStartup: () => void = () => {};
		let rejectStartup: (error: WebEngineError) => void = () => {};
		const startup = new Promise<void>((resolve, reject) => {
			resolveStartup = resolve;
			rejectStartup = reject;
		});
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		const connection: Connection = {
			child,
			pending: new Map(),
			firstRequestId: this.requestCounter + 1,
			lastRequestId: this.requestCounter,
			buffer: Buffer.alloc(0),
			ready: false,
			stopped: false,
			startup,
			startupTimer: undefined,
			resolveStartup,
			rejectStartup,
			exited,
		};
		connection.startupTimer = setTimeout(
			() =>
				this.failConnection(
					connection,
					new WebEngineError("startup_timeout", "Web engine did not become ready in time"),
				),
			this.startupTimeoutMs,
		);
		connection.startupTimer.unref();
		this.connection = connection;
		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(connection, chunk));
		child.stdout.on("end", () =>
			this.failConnection(
				connection,
				connection.buffer.length > 0
					? new WebEngineError("protocol_error", "Web engine output ended within a frame")
					: new WebEngineError("engine_exit", "Web engine output closed"),
			),
		);
		child.stderr.resume();
		child.stdin.on("error", (error) =>
			this.failConnection(connection, new WebEngineError("write_failed", "Failed to write to web engine", error)),
		);
		child.once("error", (error) =>
			this.failConnection(connection, new WebEngineError("spawn_failed", "Failed to start web engine", error)),
		);
		child.once("exit", (code, signal) => {
			this.failConnection(
				connection,
				new WebEngineError("engine_exit", `Web engine exited (code=${code} signal=${signal})`),
				false,
			);
		});
		return startup.then(() => connection);
	}

	private handleStdout(connection: Connection, chunk: Buffer): void {
		if (connection.stopped) return;
		connection.buffer = connection.buffer.length === 0 ? chunk : Buffer.concat([connection.buffer, chunk]);
		for (;;) {
			if (connection.stopped) return;
			const newline = connection.buffer.indexOf(0x0a);
			if (newline < 0) {
				if (connection.buffer.length > MAX_FRAME_BYTES) {
					this.failConnection(
						connection,
						new WebEngineError("protocol_error", "Web engine frame exceeds 65536 bytes"),
					);
				}
				return;
			}
			if (newline > MAX_FRAME_BYTES) {
				this.failConnection(
					connection,
					new WebEngineError("protocol_error", "Web engine frame exceeds 65536 bytes"),
				);
				return;
			}
			const frameBytes = connection.buffer.subarray(0, newline);
			connection.buffer = connection.buffer.subarray(newline + 1);
			this.handleFrame(connection, frameBytes);
		}
	}

	private handleFrame(connection: Connection, bytes: Buffer): void {
		try {
			const frame = parseFrame(bytes);
			if (!connection.ready) {
				validateReadyFrame(frame);
				connection.ready = true;
				if (connection.startupTimer) clearTimeout(connection.startupTimer);
				connection.resolveStartup();
				return;
			}
			dispatchFrame(connection, frame);
		} catch (error) {
			this.failConnection(connection, toWebEngineError("protocol_error", "Web engine sent an invalid frame", error));
		}
	}

	private failConnection(connection: Connection, error: WebEngineError, terminate = true): void {
		if (connection.stopped) return;
		connection.stopped = true;
		if (connection.startupTimer) clearTimeout(connection.startupTimer);
		if (this.connection === connection) {
			this.connection = undefined;
			this.startPromise = undefined;
		}
		connection.rejectStartup(error);
		for (const pending of [...connection.pending.values()]) pending.reject(error);
		connection.pending.clear();
		if (terminate) {
			connection.child.kill("SIGKILL");
			this.disposeConnection(connection);
		}
	}

	private waitForConnection(deadline: number, signal: AbortSignal | undefined): Promise<Connection> {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return Promise.reject(timeoutError());
		const startup = this.ensureConnection();
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			function cleanup(): void {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
			function finish(error?: WebEngineError, connection?: Connection): void {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else if (connection) resolve(connection);
			}
			function onAbort(): void {
				finish(abortedError());
			}
			timer = setTimeout(() => finish(timeoutError()), remainingMs);
			timer.unref();
			startup.then(
				(connection) => finish(undefined, connection),
				(error: unknown) => finish(toWebEngineError("engine_exit", "Web engine failed to start", error)),
			);
			if (signal?.aborted) {
				finish(abortedError());
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private sendRequest<T>(
		connection: Connection,
		request: RequestOperation,
		parseResult: (value: unknown) => T,
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<T> {
		if (signal?.aborted) return Promise.reject(abortedError());
		if (connection.pending.size >= MAX_ACTIVE_REQUESTS) {
			return Promise.reject(new WebEngineError("busy", "Too many active web engine requests"));
		}
		return new Promise((resolve, reject) => {
			const id = String(this.requestCounter + 1);
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			const settle = (error?: WebEngineError, cancelRequest = false): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				connection.pending.delete(id);
				if (error) {
					if (cancelRequest) writeFrame(connection, { type: "cancel", id });
					reject(error);
				}
			};
			function onAbort(): void {
				settle(abortedError(), true);
			}
			timer = setTimeout(() => settle(timeoutError(), true), timeoutMs);
			timer.unref();
			connection.pending.set(id, {
				result: (value) => {
					const result = parseResult(value);
					settle();
					resolve(result);
				},
				reject: (error) => settle(error),
			});
			const writeError = writeFrame(connection, requestFrame(id, request, timeoutMs));
			if (writeError) {
				settle(writeError);
				if (writeError.code !== "invalid_argument") this.failConnection(connection, writeError);
				return;
			}
			connection.lastRequestId = ++this.requestCounter;
			if (signal?.aborted) {
				settle(abortedError(), true);
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private async shutdown(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		this.startPromise = undefined;
		if (!connection) return;
		if (!connection.stopped) writeFrame(connection, { type: "shutdown" });
		this.failConnection(connection, new WebEngineError("closed", "Web engine client is closed"), false);
		await this.stopProcess(connection);
	}

	private async stopProcess(connection: Connection): Promise<void> {
		if (!connection.child.stdin.destroyed) {
			try {
				connection.child.stdin.end();
			} catch {}
		}
		if (await waitForExit(connection, this.shutdownTimeoutMs)) {
			this.disposeConnection(connection);
			return;
		}
		connection.child.kill("SIGKILL");
		await waitForExit(connection, this.shutdownTimeoutMs);
		this.disposeConnection(connection);
	}

	private disposeConnection(connection: Connection): void {
		connection.child.stdin.destroy();
		connection.child.stdout.destroy();
		connection.child.stderr.destroy();
	}
}

function requestFrame(id: string, request: RequestOperation, timeoutMs: number): OutgoingFrame {
	switch (request.operation) {
		case "status":
			return { type: "request", id, operation: "status", timeoutMs };
		case "http_request":
			return { type: "request", id, operation: "http_request", timeoutMs, params: request.params };
		case "web_search":
			return { type: "request", id, operation: "web_search", timeoutMs, params: request.params };
		case "web_fetch":
			return { type: "request", id, operation: "web_fetch", timeoutMs, params: request.params };
		case "git_index":
			return { type: "request", id, operation: "git_index", timeoutMs, params: request.params };
		case "git_search":
			return { type: "request", id, operation: "git_search", timeoutMs, params: request.params };
		case "git_read":
			return { type: "request", id, operation: "git_read", timeoutMs, params: request.params };
	}
}

function writeFrame(connection: Connection, frame: OutgoingFrame): WebEngineError | undefined {
	if (connection.stopped) return new WebEngineError("engine_exit", "Web engine is not running");
	let payload: string;
	try {
		payload = JSON.stringify(frame);
	} catch (error) {
		return new WebEngineError("invalid_argument", "Web engine request frame is not encodable", error);
	}
	if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) {
		return new WebEngineError("invalid_argument", "Web engine request frame exceeds 65536 bytes");
	}
	try {
		connection.child.stdin.write(`${payload}\n`);
		return undefined;
	} catch (error) {
		return new WebEngineError("write_failed", "Failed to write to web engine", error);
	}
}

function waitForExit(connection: Connection, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		function finish(exited: boolean): void {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(exited);
		}
		timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref();
		connection.exited.then(() => finish(true));
	});
}

function dispatchFrame(connection: Connection, frame: Record<string, unknown>): void {
	if (frame.type === "result") {
		const id = parseResponseId(connection, frame.id);
		connection.pending.get(id)?.result(frame.result);
		return;
	}
	if (frame.type === "error") {
		const code = parseErrorCode(frame.code);
		const message = parseErrorMessage(frame.message);
		if (frame.id === null) {
			throw new WebEngineError("protocol_error", `Web engine reported a connection error: ${message}`);
		}
		const id = parseResponseId(connection, frame.id);
		connection.pending.get(id)?.reject(new WebEngineError(code, message));
		return;
	}
	throw new WebEngineError("protocol_error", "Web engine sent an unexpected frame type");
}

function parseResponseId(connection: Connection, value: unknown): string {
	if (typeof value !== "string") {
		throw new WebEngineError("protocol_error", "Web engine response has an invalid request ID");
	}
	const id = Number(value);
	if (
		!Number.isSafeInteger(id) ||
		String(id) !== value ||
		id < connection.firstRequestId ||
		id > connection.lastRequestId
	) {
		throw new WebEngineError("protocol_error", "Web engine response has an unissued request ID");
	}
	return value;
}

function parseFrame(bytes: Buffer): Record<string, unknown> {
	let text: string;
	try {
		text = UTF8_DECODER.decode(bytes);
	} catch {
		throw new WebEngineError("protocol_error", "Web engine frame is not valid UTF-8");
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new WebEngineError("protocol_error", "Web engine frame is not valid JSON");
	}
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine frame is not a JSON object");
	}
	return value;
}

function validateReadyFrame(frame: Record<string, unknown>): void {
	if (frame.type !== "ready") {
		throw new WebEngineError("protocol_error", "Web engine did not send a ready frame");
	}
	if (typeof frame.engineVersion !== "string" || frame.engineVersion.length === 0) {
		throw new WebEngineError("protocol_error", "Web engine ready frame has no engine version");
	}
	if (typeof frame.protocolVersion !== "number" || frame.protocolVersion !== PROTOCOL_VERSION) {
		throw new WebEngineError(
			"protocol_error",
			`Web engine protocol version ${String(frame.protocolVersion)} is not supported`,
		);
	}
}

function parseStatusResult(value: unknown): WebEngineStatus {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine status result is not an object");
	}
	if (typeof value.engineVersion !== "string" || value.engineVersion.length === 0) {
		throw new WebEngineError("protocol_error", "Web engine status result has no engine version");
	}
	if (typeof value.protocolVersion !== "number" || value.protocolVersion !== PROTOCOL_VERSION) {
		throw new WebEngineError(
			"protocol_error",
			`Web engine protocol version ${String(value.protocolVersion)} is not supported`,
		);
	}
	if (!isStringArray(value.operations)) {
		throw new WebEngineError("protocol_error", "Web engine status result has invalid operations");
	}
	return {
		engineVersion: value.engineVersion,
		protocolVersion: value.protocolVersion,
		operations: value.operations,
	};
}

function parseHttpResult(value: unknown): WebEngineHttpResult {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine HTTP result is not an object");
	}
	if (typeof value.url !== "string" || value.url.length === 0) {
		throw new WebEngineError("protocol_error", "Web engine HTTP result has no URL");
	}
	if (
		typeof value.status !== "number" ||
		!Number.isInteger(value.status) ||
		value.status < 100 ||
		value.status > 599
	) {
		throw new WebEngineError("protocol_error", "Web engine HTTP result has an invalid status");
	}
	if (!isStringRecord(value.headers)) {
		throw new WebEngineError("protocol_error", "Web engine HTTP result has invalid headers");
	}
	if (typeof value.body !== "string") {
		throw new WebEngineError("protocol_error", "Web engine HTTP result has no body");
	}
	if (typeof value.truncated !== "boolean") {
		throw new WebEngineError("protocol_error", "Web engine HTTP result has no truncation flag");
	}
	if (
		typeof value.bytesReceived !== "number" ||
		!Number.isSafeInteger(value.bytesReceived) ||
		value.bytesReceived < 0
	) {
		throw new WebEngineError("protocol_error", "Web engine HTTP result has an invalid byte count");
	}
	if (!isStringArray(value.missingPointers)) {
		throw new WebEngineError("protocol_error", "Web engine HTTP result has invalid missing pointers");
	}
	return {
		url: value.url,
		status: value.status,
		headers: value.headers,
		body: value.body,
		truncated: value.truncated,
		bytesReceived: value.bytesReceived,
		missingPointers: value.missingPointers,
	};
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function parseFetchResult(value: unknown): WebEngineFetchResult {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine fetch result is not an object");
	}
	if (typeof value.url !== "string" || value.url.length === 0) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has no URL");
	}
	if (
		typeof value.status !== "number" ||
		!Number.isInteger(value.status) ||
		value.status < 100 ||
		value.status > 599
	) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has an invalid status");
	}
	if (typeof value.contentType !== "string" || value.contentType.length === 0) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has no content type");
	}
	if (typeof value.title !== "string" || Buffer.byteLength(value.title) > 256) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has an invalid title");
	}
	if (typeof value.content !== "string") {
		throw new WebEngineError("protocol_error", "Web engine fetch result has no content");
	}
	const format = parseFetchFormat(value.format);
	const access = parseFetchAccess(value.access);
	const extraction = parseFetchExtraction(value.extraction);
	if ((access === "ok") !== (extraction !== "none")) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has an inconsistent extraction mode");
	}
	if ((extraction === "readability" || extraction === "fallback") && format !== "markdown") {
		throw new WebEngineError("protocol_error", "Web engine fetch result has an inconsistent content format");
	}
	if (access === "ok" && (value.status < 200 || value.status >= 300)) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has an inconsistent HTTP status");
	}
	if (access === "ok" && value.content.trim().length === 0) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has blank content for an ok access status");
	}
	if (access !== "ok" && value.content.length > 0) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has content for a failed access status");
	}
	if (typeof value.truncated !== "boolean") {
		throw new WebEngineError("protocol_error", "Web engine fetch result has no truncation flag");
	}
	if (
		typeof value.bytesReceived !== "number" ||
		!Number.isSafeInteger(value.bytesReceived) ||
		value.bytesReceived < 0
	) {
		throw new WebEngineError("protocol_error", "Web engine fetch result has an invalid byte count");
	}
	return {
		url: value.url,
		status: value.status,
		contentType: value.contentType,
		title: value.title,
		content: value.content,
		format,
		access,
		extraction,
		truncated: value.truncated,
		bytesReceived: value.bytesReceived,
	};
}

function parseFetchFormat(value: unknown): WebEngineFetchFormat {
	switch (value) {
		case "markdown":
		case "text":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine fetch result has an invalid format");
	}
}

function parseFetchAccess(value: unknown): WebEngineFetchAccess {
	switch (value) {
		case "ok":
		case "blocked":
		case "auth_required":
		case "http_error":
		case "requires_javascript":
		case "empty":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine fetch result has an invalid access status");
	}
}

function parseFetchExtraction(value: unknown): WebEngineFetchExtraction {
	switch (value) {
		case "readability":
		case "fallback":
		case "text":
		case "none":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine fetch result has an invalid extraction mode");
	}
}

function parseSearchResult(value: unknown): WebEngineSearchResult {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine search result is not an object");
	}
	if (typeof value.query !== "string" || value.query.trim().length === 0 || Buffer.byteLength(value.query) > 512) {
		throw new WebEngineError("protocol_error", "Web engine search result has no query");
	}
	const status = parseSearchStatus(value.status);
	if (!Array.isArray(value.results) || value.results.length > 10) {
		throw new WebEngineError("protocol_error", "Web engine search result has invalid results");
	}
	const results = value.results.map(parseSearchResultItem);
	if (status === "ok" && results.length === 0) {
		throw new WebEngineError("protocol_error", "Web engine search result has no results for an ok status");
	}
	if (status !== "ok" && results.length > 0) {
		throw new WebEngineError("protocol_error", "Web engine search result has results for a non-ok status");
	}
	if (
		!Array.isArray(value.attempts) ||
		value.attempts.length < 1 ||
		value.attempts.length > WEB_ENGINE_SEARCH_PROVIDERS.length
	) {
		throw new WebEngineError("protocol_error", "Web engine search result has invalid attempts");
	}
	const attempts = value.attempts.map(parseSearchAttempt);
	if (typeof value.truncated !== "boolean") {
		throw new WebEngineError("protocol_error", "Web engine search result has no truncation flag");
	}
	const result: WebEngineSearchResult = {
		query: value.query,
		status,
		results,
		attempts,
		truncated: value.truncated,
	};
	if (value.site !== undefined) result.site = parseSearchSite(value.site);
	return result;
}

function parseSearchResultItem(value: unknown): WebEngineSearchResultItem {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine search result has an invalid item");
	}
	if (typeof value.title !== "string" || value.title.length === 0 || Buffer.byteLength(value.title) > 256) {
		throw new WebEngineError("protocol_error", "Web engine search result item has no title");
	}
	if (typeof value.snippet !== "string" || Buffer.byteLength(value.snippet) > 512) {
		throw new WebEngineError("protocol_error", "Web engine search result item has no snippet");
	}
	return {
		title: value.title,
		url: parseSearchResultUrl(value.url),
		snippet: value.snippet,
		source: parseSearchProvider(value.source),
	};
}

function parseSearchAttempt(value: unknown): WebEngineSearchAttempt {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine search result has an invalid attempt");
	}
	const attempt: WebEngineSearchAttempt = {
		provider: parseSearchProvider(value.provider),
		status: parseSearchAttemptStatus(value.status),
	};
	if (value.httpStatus !== undefined) attempt.httpStatus = parseSearchAttemptHttpStatus(value.httpStatus);
	if (value.reason !== undefined) attempt.reason = parseSearchAttemptReason(value.reason);
	return attempt;
}

function parseSearchAttemptHttpStatus(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) {
		throw new WebEngineError("protocol_error", "Web engine search result has an invalid attempt HTTP status");
	}
	return value;
}

function parseSearchAttemptReason(value: unknown): WebEngineSearchAttemptReason {
	const reason = WEB_ENGINE_SEARCH_ATTEMPT_REASONS.find((candidate) => candidate === value);
	if (reason === undefined) {
		throw new WebEngineError("protocol_error", "Web engine search result has an invalid attempt reason");
	}
	return reason;
}

function parseSearchSite(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new WebEngineError("protocol_error", "Web engine search result has an invalid site");
	}
	return value;
}

function parseSearchResultUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4_096) {
		throw new WebEngineError("protocol_error", "Web engine search result item has no URL");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WebEngineError("protocol_error", "Web engine search result item has an invalid URL");
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username.length > 0 || url.password.length > 0) {
		throw new WebEngineError("protocol_error", "Web engine search result item has an unsafe URL");
	}
	return value;
}

function parseSearchStatus(value: unknown): WebEngineSearchStatus {
	switch (value) {
		case "ok":
		case "empty":
		case "unavailable":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine search result has an invalid status");
	}
}

function parseSearchProvider(value: unknown): WebEngineSearchProvider {
	const provider = WEB_ENGINE_SEARCH_PROVIDERS.find((candidate) => candidate === value);
	if (provider === undefined) {
		throw new WebEngineError("protocol_error", "Web engine search result has an invalid provider");
	}
	return provider;
}

function parseSearchAttemptStatus(value: unknown): WebEngineSearchAttemptStatus {
	const status = WEB_ENGINE_SEARCH_ATTEMPT_STATUSES.find((candidate) => candidate === value);
	if (status === undefined) {
		throw new WebEngineError("protocol_error", "Web engine search result has an invalid attempt status");
	}
	return status;
}

function parseGitIndexResult(value: unknown): WebEngineGitIndexResult {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine Git index result is not an object");
	}
	const indexId = parseGitIndexId(value.indexId);
	const source = parseGitSource(value.source);
	const scope = parseGitScope(value.scope);
	const revision = parseGitIndexRevision(value.revision);
	if ((scope === "worktree") !== (revision === null)) {
		throw new WebEngineError("protocol_error", "Web engine Git index result has an inconsistent revision");
	}
	const resolvedCommit = parseGitNullableObjectId(value.resolvedCommit, "resolved commit");
	if (scope !== "worktree" && resolvedCommit === null) {
		throw new WebEngineError("protocol_error", "Web engine Git index result has an inconsistent resolved commit");
	}
	const status = parseGitIndexStatus(value.status);
	const filesIndexed = parseGitCount(value.filesIndexed, "filesIndexed count");
	const bytesIndexed = parseGitCount(value.bytesIndexed, "bytesIndexed count");
	const commitsVisited = parseGitCount(value.commitsVisited, "commitsVisited count");
	const downloadBytes = parseGitCount(value.downloadBytes, "downloadBytes count");
	const skipped = parseGitIndexSkipped(value.skipped);
	const limitsReached = parseGitIndexLimits(value.limitsReached);
	const indexedAt = parseGitCount(value.indexedAt, "indexedAt time");
	return {
		indexId,
		source,
		scope,
		revision,
		resolvedCommit,
		status,
		filesIndexed,
		bytesIndexed,
		commitsVisited,
		downloadBytes,
		skipped,
		limitsReached,
		indexedAt,
	};
}

function parseGitIndexSkipped(value: unknown): WebEngineGitIndexSkipped {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine Git index result has invalid skipped counts");
	}
	return {
		binary: parseGitCount(value.binary, "binary skip count"),
		large: parseGitCount(value.large, "large skip count"),
		nonUtf8: parseGitCount(value.nonUtf8, "non-UTF-8 skip count"),
		unsafePath: parseGitCount(value.unsafePath, "unsafe path skip count"),
		unreadable: parseGitCount(value.unreadable, "unreadable skip count"),
		submodule: parseGitCount(value.submodule, "submodule skip count"),
		duplicate: parseGitCount(value.duplicate, "duplicate skip count"),
	};
}

function parseGitIndexLimits(value: unknown): WebEngineGitIndexLimit[] {
	if (!Array.isArray(value) || value.length > 4) {
		throw new WebEngineError("protocol_error", "Web engine Git index result has invalid limits");
	}
	const limits = value.map(parseGitIndexLimit);
	if (new Set(limits).size !== limits.length) {
		throw new WebEngineError("protocol_error", "Web engine Git index result has a duplicate limit");
	}
	return limits;
}

function parseGitIndexLimit(value: unknown): WebEngineGitIndexLimit {
	switch (value) {
		case "file_limit":
		case "byte_limit":
		case "commit_limit":
		case "entry_limit":
		case "shallow_history":
		case "sparse_checkout":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine Git index result has an invalid limit");
	}
}

function parseGitIndexStatus(value: unknown): WebEngineGitIndexStatus {
	switch (value) {
		case "ok":
		case "partial":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine Git index result has an invalid status");
	}
}

function parseGitScope(value: unknown): WebEngineGitScope {
	switch (value) {
		case "worktree":
		case "head":
		case "history":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine Git index result has an invalid scope");
	}
}

function parseGitIndexRevision(value: unknown): string | null {
	if (value === null) return null;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value) > 256 ||
		hasControlCharacter(value)
	) {
		throw new WebEngineError("protocol_error", "Web engine Git index result has an invalid revision");
	}
	return value;
}

function parseGitSearchResult(value: unknown): WebEngineGitSearchResult {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine Git search result is not an object");
	}
	const indexId = parseGitIndexId(value.indexId);
	const query = parseGitQuery(value.query);
	const status = parseGitSearchStatus(value.status);
	if (!Array.isArray(value.results) || value.results.length > 50) {
		throw new WebEngineError("protocol_error", "Web engine Git search result has invalid results");
	}
	const results = value.results.map(parseGitSearchResultItem);
	if (status === "ok" && results.length === 0) {
		throw new WebEngineError("protocol_error", "Web engine Git search result has no results for an ok status");
	}
	if (status === "empty" && results.length > 0) {
		throw new WebEngineError("protocol_error", "Web engine Git search result has results for an empty status");
	}
	if (typeof value.partial !== "boolean") {
		throw new WebEngineError("protocol_error", "Web engine Git search result has no partial flag");
	}
	if (typeof value.truncated !== "boolean") {
		throw new WebEngineError("protocol_error", "Web engine Git search result has no truncation flag");
	}
	return { indexId, query, status, results, partial: value.partial, truncated: value.truncated };
}

function parseGitSearchResultItem(value: unknown): WebEngineGitSearchResultItem {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine Git search result has an invalid item");
	}
	const snippet = value.snippet;
	if (typeof snippet !== "string" || Buffer.byteLength(snippet) > 512) {
		throw new WebEngineError("protocol_error", "Web engine Git search result item has an invalid snippet");
	}
	return {
		path: parseGitPath(value.path),
		revision: parseGitNullableObjectId(value.revision, "revision"),
		line: parseGitPositiveInteger(value.line, "line"),
		column: parseGitPositiveInteger(value.column, "column"),
		snippet,
	};
}

function parseGitSearchStatus(value: unknown): WebEngineGitSearchStatus {
	switch (value) {
		case "ok":
		case "empty":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine Git search result has an invalid status");
	}
}

function parseGitReadResult(value: unknown): WebEngineGitReadResult {
	if (!isRecord(value)) {
		throw new WebEngineError("protocol_error", "Web engine Git read result is not an object");
	}
	const indexId = parseGitIndexId(value.indexId);
	const path = parseGitPath(value.path);
	const revision = parseGitNullableObjectId(value.revision, "revision");
	const status = parseGitReadStatus(value.status);
	const startLine = parseGitPositiveInteger(value.startLine, "start line");
	const startColumn = parseGitPositiveInteger(value.startColumn, "start column");
	if (startLine > 10_000_000) {
		throw new WebEngineError("protocol_error", "Web engine Git read result has an invalid start line");
	}
	if (startColumn > 4_194_304) {
		throw new WebEngineError("protocol_error", "Web engine Git read result has an invalid start column");
	}
	const endLine = parseGitCount(value.endLine, "end line");
	const totalLines = parseGitCount(value.totalLines, "total line count");
	const content = value.content;
	if (typeof content !== "string" || Buffer.byteLength(content) > 49_152) {
		throw new WebEngineError("protocol_error", "Web engine Git read result has invalid content");
	}
	if (status === "not_found") {
		if (content.length > 0) {
			throw new WebEngineError("protocol_error", "Web engine Git read result has content for a not_found status");
		}
		if (endLine !== 0 || totalLines !== 0) {
			throw new WebEngineError(
				"protocol_error",
				"Web engine Git read result has line counts for a not_found status",
			);
		}
	} else if (content.length === 0) {
		if (endLine !== 0) {
			throw new WebEngineError("protocol_error", "Web engine Git read result has line counts for empty content");
		}
	}
	const lines = content.split("\n");
	const nextLine = startLine + lines.length - 1;
	if (content.length > 0 && (endLine !== nextLine - Number(content.endsWith("\n")) || endLine > totalLines)) {
		throw new WebEngineError("protocol_error", "Web engine Git read result has inconsistent line counts");
	}
	if (typeof value.truncated !== "boolean") {
		throw new WebEngineError("protocol_error", "Web engine Git read result has no truncation flag");
	}
	let next: WebEngineGitReadResult["next"] = null;
	if (value.truncated) {
		const nextColumn =
			lines.length === 1 ? startColumn + Buffer.byteLength(content) : 1 + Buffer.byteLength(lines.at(-1) ?? "");
		if (
			!isRecord(value.next) ||
			content.length === 0 ||
			nextLine > totalLines ||
			nextColumn > 4_194_304 ||
			value.next.line !== nextLine ||
			value.next.column !== nextColumn
		) {
			throw new WebEngineError("protocol_error", "Web engine Git read result has an invalid continuation");
		}
		next = { line: nextLine, column: nextColumn };
	} else if (value.next !== null || (content.length > 0 && endLine !== totalLines)) {
		throw new WebEngineError("protocol_error", "Web engine Git read result has an invalid continuation");
	}
	return {
		indexId,
		path,
		revision,
		status,
		startLine,
		startColumn,
		endLine,
		totalLines,
		content,
		truncated: value.truncated,
		next,
	};
}

function parseGitReadStatus(value: unknown): WebEngineGitReadStatus {
	switch (value) {
		case "ok":
		case "not_found":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine Git read result has an invalid status");
	}
}

function parseGitIndexId(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		throw new WebEngineError("protocol_error", "Web engine Git result has an invalid index ID");
	}
	return value;
}

function parseGitObjectId(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
		throw new WebEngineError("protocol_error", `Web engine Git result has an invalid ${field}`);
	}
	return value;
}

function parseGitNullableObjectId(value: unknown, field: string): string | null {
	if (value === null) return null;
	return parseGitObjectId(value, field);
}

function parseGitSource(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value) > 4_096 ||
		hasControlCharacter(value)
	) {
		throw new WebEngineError("protocol_error", "Web engine Git index result has an invalid source");
	}
	return value;
}

function parseGitQuery(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		Buffer.byteLength(value) > 512 ||
		hasControlCharacter(value)
	) {
		throw new WebEngineError("protocol_error", "Web engine Git search result has no query");
	}
	return value;
}

function parseGitPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.startsWith("/") ||
		Buffer.byteLength(value) > 1_024 ||
		hasControlCharacter(value)
	) {
		throw new WebEngineError("protocol_error", "Web engine Git result has an invalid path");
	}
	return value;
}

function parseGitCount(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new WebEngineError("protocol_error", `Web engine Git result has an invalid ${field}`);
	}
	return value;
}

function parseGitPositiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new WebEngineError("protocol_error", `Web engine Git result has an invalid ${field}`);
	}
	return value;
}

function hasControlCharacter(value: string): boolean {
	return /[\u0000-\u001f\u007f]/.test(value);
}

function parseErrorCode(value: unknown): WebEngineErrorCode {
	switch (value) {
		case "invalid_request":
		case "invalid_params":
		case "unsupported_operation":
		case "busy":
		case "cancelled":
		case "timeout":
		case "internal":
		case "network_error":
		case "redirect_limit":
		case "credential_error":
		case "unsupported_response":
		case "response_limit":
		case "output_limit":
		case "invalid_json":
		case "repository_error":
		case "index_not_found":
		case "index_incompatible":
		case "resource_limit":
			return value;
		default:
			throw new WebEngineError("protocol_error", "Web engine error frame has an invalid code");
	}
}

function parseErrorMessage(value: unknown): string {
	if (typeof value !== "string") {
		throw new WebEngineError("protocol_error", "Web engine error frame has no message");
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function resolveRequestTimeout(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	if (!Number.isInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
		throw new WebEngineError(
			"invalid_argument",
			`Web engine request timeout must be an integer between 1 and ${MAX_REQUEST_TIMEOUT_MS} milliseconds`,
		);
	}
	return value;
}

function toWebEngineError(code: WebEngineErrorCode, message: string, cause: unknown): WebEngineError {
	return cause instanceof WebEngineError ? cause : new WebEngineError(code, message, cause);
}

function abortedError(): WebEngineError {
	return new WebEngineError("aborted", "Web engine request aborted");
}

function timeoutError(): WebEngineError {
	return new WebEngineError("timeout", "Web engine request timed out");
}
