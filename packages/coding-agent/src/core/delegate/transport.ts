import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { delegateDataDir } from "./config.ts";
import type { DelegatePending, DelegateState } from "./view.ts";

export type { DelegatePending, DelegateState };

export interface DelegateRequest {
	agent?: string;
	task?: string;
	provider?: string;
	model?: string;
	runtimeMode?: string;
	scope?: string[];
	scratch?: string[];
	tools?: string[];
	cwd?: string;
	timeoutMs?: number;
	noProgressMs?: number;
	contextBudget?: number;
	trustProjectAgents?: boolean;
}

export interface DelegateAnswer {
	approved?: boolean;
	answer?: string;
}

export interface DelegateAgentInfo {
	name: string;
	provider: string;
	model?: string;
	scope?: string[];
	source?: string;
	description?: string;
	filePath?: string;
	ready?: boolean;
	problem?: string;
}

export interface DelegateModelInfo {
	id: string;
	description?: string;
	efforts?: string[];
}

export interface DelegateModelList {
	provider: string;
	models: DelegateModelInfo[];
	fetchedAt?: number;
	error?: string;
}

export interface DelegatePruneResult {
	removed: string[];
	kept: { taskId: string; reason: string }[];
}

export interface DelegateRunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface DelegateRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface DelegateTransport {
	run(args: string[], options?: DelegateRunOptions): Promise<DelegateRunResult>;
	start(requests: DelegateRequest[], options?: DelegateRunOptions): Promise<DelegateState[]>;
	status(taskId: string, options?: DelegateRunOptions): Promise<DelegateState>;
	poll(taskId: string): Promise<DelegateState | undefined>;
	answer(taskId: string, requestId: string, value: DelegateAnswer): Promise<void>;
	cancel(taskId: string, options?: DelegateRunOptions): Promise<DelegateState>;
	diff(taskId: string, options?: DelegateRunOptions): Promise<string>;
	accept(taskId: string): Promise<DelegateState>;
	undo(taskId: string, force: boolean): Promise<DelegateState>;
	prune(olderThan: string): Promise<DelegatePruneResult>;
	agents(cwd: string): Promise<DelegateAgentInfo[]>;
	listModels(provider?: string): Promise<DelegateModelList[]>;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function parseJson<T>(stdout: string): T {
	const parsed = JSON.parse(stdout) as T & { error?: string };
	if (parsed && typeof parsed === "object" && typeof parsed.error === "string") throw new Error(parsed.error);
	return parsed;
}

export function assertTaskId(taskId: unknown): string {
	if (typeof taskId !== "string" || !TASK_ID.test(taskId)) throw new Error(`Invalid task ID: ${String(taskId)}`);
	if (taskId === "." || taskId === "..") throw new Error(`Invalid task ID: ${taskId}`);
	return taskId;
}

function checked(result: DelegateRunResult, command: string): DelegateRunResult {
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
		throw new Error(`Delegate ${command} failed: ${detail}`);
	}
	return result;
}

export interface CliTransportOptions {
	cliPath: string;
	env: Record<string, string>;
	cwd?: string;
	nodePath?: string;
	dataDir?: string;
}

export function createCliTransport(options: CliTransportOptions): DelegateTransport {
	const node = options.nodePath ?? process.execPath;
	const baseEnv = { ...process.env, ...options.env };
	const dataDir = options.dataDir ?? options.env.DELEGATE_DATA ?? delegateDataDir();

	const run = (args: string[], runOptions: DelegateRunOptions = {}): Promise<DelegateRunResult> =>
		new Promise((resolve, reject) => {
			const child = spawn(node, [options.cliPath, ...args], {
				cwd: options.cwd,
				env: baseEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let settled = false;
			const capture = (current: string, chunk: Buffer): string => {
				if (current.length >= MAX_OUTPUT_BYTES) return current;
				return (current + chunk.toString()).slice(0, MAX_OUTPUT_BYTES);
			};
			const finish = (result: DelegateRunResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				runOptions.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				runOptions.signal?.removeEventListener("abort", onAbort);
				reject(error);
			};
			const onAbort = (): void => {
				child.kill("SIGTERM");
				fail(new Error("Delegate transport cancelled"));
			};
			const timer =
				runOptions.timeoutMs && runOptions.timeoutMs > 0
					? setTimeout(() => {
							child.kill("SIGTERM");
							fail(new Error(`Delegate command timed out after ${runOptions.timeoutMs}ms`));
						}, runOptions.timeoutMs)
					: (undefined as unknown as ReturnType<typeof setTimeout>);
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout = capture(stdout, chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = capture(stderr, chunk);
			});
			child.once("error", fail);
			child.once("close", (code) => finish({ stdout, stderr, exitCode: code ?? 1 }));
			if (runOptions.signal?.aborted) onAbort();
			else runOptions.signal?.addEventListener("abort", onAbort, { once: true });
		});

	const stateFromStdout = (stdout: string): DelegateState => parseJson<DelegateState>(stdout);

	return {
		run,
		async start(requests, runOptions) {
			const args =
				requests.length === 1
					? ["start", "--json", JSON.stringify(requests[0])]
					: ["start-many", "--json", JSON.stringify(requests)];
			const result = checked(await run(args, { timeoutMs: 30000, ...runOptions }), "start");
			const parsed = parseJson<DelegateState | DelegateState[]>(result.stdout);
			return Array.isArray(parsed) ? parsed : [parsed];
		},
		async status(taskId, runOptions) {
			assertTaskId(taskId);
			const result = checked(
				await run(["status", "--task-id", taskId], { timeoutMs: 30000, ...runOptions }),
				"status",
			);
			return stateFromStdout(result.stdout);
		},
		async poll(taskId) {
			assertTaskId(taskId);
			try {
				const text = await readFile(join(dataDir, "tasks", taskId, "state.json"), "utf8");
				return JSON.parse(text) as DelegateState;
			} catch {
				return undefined;
			}
		},
		async answer(taskId, requestId, value) {
			assertTaskId(taskId);
			if (typeof requestId !== "string" || requestId === "") throw new Error("Invalid request ID.");
			const result = checked(
				await run(["answer", "--json", JSON.stringify({ ...value, taskId, requestId })], { timeoutMs: 15000 }),
				"answer",
			);
			if (result.stdout.trim()) parseJson<unknown>(result.stdout);
		},
		async cancel(taskId, runOptions) {
			assertTaskId(taskId);
			const result = checked(
				await run(["cancel", "--task-id", taskId, "--json", "{}"], { timeoutMs: 30000, ...runOptions }),
				"cancel",
			);
			return stateFromStdout(result.stdout);
		},
		async diff(taskId, runOptions) {
			assertTaskId(taskId);
			const result = checked(await run(["diff", "--task-id", taskId], { timeoutMs: 60000, ...runOptions }), "diff");
			const parsed = parseJson<{ diff?: string }>(result.stdout);
			return parsed.diff ?? "";
		},
		async accept(taskId) {
			assertTaskId(taskId);
			const result = checked(await run(["accept", "--task-id", taskId], { timeoutMs: 60000 }), "accept");
			return stateFromStdout(result.stdout);
		},
		async undo(taskId, force) {
			assertTaskId(taskId);
			const args = ["undo", "--task-id", taskId];
			if (force) args.push("--force");
			const result = checked(await run(args, { timeoutMs: 60000 }), "undo");
			return stateFromStdout(result.stdout);
		},
		async prune(olderThan) {
			const result = checked(await run(["prune", "--older-than", olderThan], { timeoutMs: 60000 }), "prune");
			return parseJson<DelegatePruneResult>(result.stdout);
		},
		async agents(cwd) {
			const result = checked(await run(["agents", "--cwd", cwd], { timeoutMs: 15000 }), "agents");
			const parsed = parseJson<DelegateAgentInfo[]>(result.stdout);
			return Array.isArray(parsed) ? parsed : [];
		},
		async listModels(provider) {
			const args = ["models", ...(provider ? ["--provider", provider] : [])];
			const result = checked(await run(args, { timeoutMs: 120000 }), "models");
			const parsed = parseJson<DelegateModelList[]>(result.stdout);
			return Array.isArray(parsed) ? parsed : [];
		},
	};
}
