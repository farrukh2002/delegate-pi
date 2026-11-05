import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findAgent, toToolList } from "./agents.ts";
import { PROVIDERS, insertInvocationFlags, isProviderId, piEntryProblem, providerAvailable } from "./providers.ts";
import { checkModel } from "./models.ts";
export { listModels } from "./models.ts";
export { findAgent } from "./agents.ts";
import { closeHome, prepareHome, sandboxInvocation, executable } from "./sandbox.ts";
import { emptyUsage } from "./types.ts";
import { DATA, HEARTBEAT_STALE_MS, TASKS, acquireScope, acquireSlot, checkScopeTracked, claimMessage, claimPaths, releaseClaims, releaseScope, releaseSlot, diff as diffScope, diffstat, dropRefs, gitMounts, ignoredPaths, listParents, normalizeScope, prepareScope, requireRepository, scopeLayout, scratchPaths, sleep, snapshot, strayFiles, undo as undoScope, markWorkerGone, pidAlive, workerGone } from "./workspace.ts";

import { MAX_TASKS, STOPPED } from "./view.ts";

export { HEARTBEAT_STALE_MS, MAX_TASKS };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TERMINAL = new Set(STOPPED);

function instruction(scope: string[]): string {
	const access = !scope.length
		? "The project is read-only for this task. Do not try to write files in it."
		: scope.includes(".")
			? "You may change files anywhere in /workspace except .git."
			: `You may change files only in these project paths: ${scope.join(", ")}. All other project paths are read-only.`;
	return `You are a delegated child inside a fixed Linux filesystem sandbox. /workspace is the host project, and your changes land in it directly. ${access} .git is read-only: do not commit, stage, stash or switch branches; the parent reviews and commits your changes. Other children can work in other paths of the project at the same time. If the task needs a change outside your writable paths, do not work around it: finish the other parts, then list each blocked file and the change it needs in your report. A write that is denied because another task changes the file must not be retried: finish the rest and list the file under BLOCKED FILES. Do not delegate again. For a user decision, use question (pi), delegate_question (Command Code), or AskUserQuestion (Claude). All providers can also ask with: node /delegate/ask.mjs '{"question":"Your question?","options":[{"label":"First"},{"label":"Second"}]}'. This command waits for the real user in the parent CLI. Never invent the answer. A permission denial is not permission to try another tool. Stop and report BLOCKED if the sandbox or user blocks all required work. Do not alter permission hooks. Report changed files and test results.`;
}

export const LOG_CAP = 2 * 1024 * 1024;
export const MAX_PARALLEL = 4;
export const HEARTBEAT_MS = 5000;

export function compactLogLine(line: string): string | null {
	if (!line) return null;
	if (line.includes('"message_update"')) return null;
	if (line.includes('"thinking_delta"')) return null;
	const limit = 4096;
	if (line.length <= limit) return line;
	return `${line.slice(0, 2048)}...[${line.length} bytes]...${line.slice(-2048)}`;
}

export interface DelegateRequest {
	agent?: string;
	task: string;
	provider?: string;
	model?: string;
	runtimeMode?: string;
	scope?: string[] | string;
	scratch?: string[];
	tools?: string[] | string;
	timeoutMs?: number;
	noProgressMs?: number;
	contextBudget?: number;
	cwd?: string;
	sandbox?: string;
	trustProjectAgents?: boolean;
	isolation?: string;
}

function taskDir(id: string): string {
	if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid task ID");
	return path.join(TASKS, id);
}

function atomic(file: string, value: unknown): void {
	const temp = `${file}.${randomUUID()}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	fs.renameSync(temp, file);
}

export function makeSave(file: string, state: any): () => void {
	let last = "";
	return () => {
		const text = JSON.stringify(state);
		if (text === last) return;
		last = text;
		atomic(file, state);
	};
}

const ACTIVITY = 5;

export function activityLine(part: any): string | undefined {
	if (part?.type === "toolCall") {
		const args = part.arguments ?? {};
		const target = ["path", "file_path", "filePath", "command", "cmd", "pattern", "query", "url"].map(key => args[key]).find(value => typeof value === "string" && value.trim());
		const first = target ?? Object.values(args).find(value => typeof value === "string" && value.trim());
		return `${part.name}${first ? ` ${String(first).replace(/\s+/g, " ").trim()}` : ""}`.slice(0, 120);
	}
	if (part?.type === "text") {
		const line = String(part.text ?? "").split("\n").map(text => text.trim()).find(Boolean);
		return line ? line.slice(0, 120) : undefined;
	}
	return undefined;
}

function readJson(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parentOnly(): void {
	if (Number(process.env.DELEGATE_DEPTH || 0) >= 1) throw new Error("Nested delegation is disabled");
}

function safeWorkspace(cwd: string): string {
	const workspace = fs.realpathSync(cwd);
	if (!fs.statSync(workspace).isDirectory()) throw new Error("Workspace must be a directory");
	const home = os.homedir();
	const neverWorkspace = [home, "/etc", "/usr", "/run", "/proc", path.join(home, ".claude"), path.join(home, ".pi"), path.join(home, ".codex"), path.join(home, ".commandcode")];
	for (const protectedPath of [...neverWorkspace, ROOT, DATA]) {
		if (workspace === protectedPath) throw new Error("Use a project directory, not a home, system, credential, or delegate directory");
		if (protectedPath !== home && workspace.startsWith(protectedPath + "/")) throw new Error("Use a project directory, not a home, system, credential, or delegate directory");
	}
	for (const protectedPath of neverWorkspace) {
		if (protectedPath.startsWith(workspace + "/")) throw new Error("Use a project directory, not a home, system, credential, or delegate directory");
	}
	if (workspace === "/") throw new Error("The filesystem root cannot be a workspace");
	return workspace;
}

export function start(request: DelegateRequest): any {
	parentOnly();
	if (!request || typeof request.task !== "string" || !request.task.trim() || request.task.length > 12000) throw new Error("Task must contain 1–12000 characters");
	if (request.sandbox && request.sandbox !== "fs") throw new Error("Sandbox bypass is not supported");
	if (request.isolation !== undefined) throw new Error("isolation was removed. Give scope: the paths the child may change, or no scope for a read-only task.");
	executable("bwrap");
	const cwd = safeWorkspace(request.cwd || process.cwd());
	const agent = request.agent ? findAgent(request.agent, cwd) : undefined;
	if (request.agent && !agent) throw new Error(`Unknown agent: ${request.agent}`);
	if (agent?.source === "project" && request.trustProjectAgents !== true) throw new Error(`The project agent ${agent.name} (${agent.filePath}) needs approval from the user, and the user did not approve it. Use a bundled or user agent instead.`);
	const provider = request.provider || agent?.provider || "pi";
	if (!isProviderId(provider)) throw new Error(`Provider unavailable: ${provider}`);
	if (!providerAvailable(provider)) {
		const problem = provider === "pi" ? piEntryProblem() : undefined;
		throw new Error(problem ? `Provider unavailable: pi (${problem})` : `Provider unavailable: ${provider}`);
	}
	checkModel(provider, request.model || agent?.model);
	const requestedMode = request.runtimeMode || agent?.runtimeMode;
	const runtimeMode = requestedMode === "full-access" ? "full-access" : "approval-required";
	if (request.runtimeMode && !["inherit", "full-access", "approval-required"].includes(request.runtimeMode)) throw new Error("Invalid runtime mode");
	if (provider === "codex" && runtimeMode === "approval-required") throw new Error("Codex exec cannot relay native approvals. Use another provider for approval-required, or explicitly choose full-access inside the mandatory sandbox.");
	const scope = normalizeScope(cwd, request.scope !== undefined ? request.scope : agent?.scope);
	if (scope.length) {
		requireRepository(cwd);
		checkScopeTracked(cwd, scope);
		prepareScope(cwd, scope);
	}
	const scratch = scratchPaths(cwd, scope, request.scratch);
	const timeoutMs = request.timeoutMs ?? 900000;
	const noProgressMs = Number(request.noProgressMs ?? process.env.DELEGATE_NO_PROGRESS_MS ?? 600000);
	const contextBudget = Number(request.contextBudget ?? 0);
	if (contextBudget && (!Number.isInteger(contextBudget) || contextBudget < 10000)) throw new Error("contextBudget must be 0 (off) or an integer of at least 10000");
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000) throw new Error("timeoutMs must be an integer from 1000 to 86400000");
	fs.mkdirSync(TASKS, { recursive: true, mode: 0o700 });
	reapHomes();
	const id = randomUUID();
	const dir = taskDir(id);
	fs.mkdirSync(dir, { mode: 0o700 });
	const resolved = { ...request, cwd, provider, runtimeMode, scope, scratch, tools: toToolList(request.tools ?? agent?.tools), timeoutMs, noProgressMs, contextBudget, model: request.model || agent?.model, systemPrompt: agent?.systemPrompt || "", maxTurns: agent?.maxTurns };
	atomic(path.join(dir, "request.json"), resolved);
	atomic(path.join(dir, "state.json"), { taskId: id, agent: request.agent || "direct", provider, status: "starting", sandbox: "fs", runtimeMode, cwd, scope, createdAt: Date.now(), summary: "Starting sandboxed child", usage: emptyUsage(), costUsd: null, pending: [] });
	const log = fs.openSync(path.join(dir, "worker.log"), "a", 0o600);
	try {
		const worker = spawn(process.execPath, [path.join(ROOT, "delegate.mjs"), "_worker", id], { detached: true, stdio: ["ignore", log, log], env: process.env });
		worker.unref();
	} finally { fs.closeSync(log); }
	return status(id);
}

export function status(id: string): any {
	parentOnly();
	const dir = taskDir(id);
	const state = readJson(path.join(dir, "state.json"));
	if (workerGone(state)) {
		markWorkerGone(path.join(dir, "state.json"), state);
		closeHome(dir);
	}
	return state;
}

function reapHomes(): void {
	let names: string[] = [];
	try { names = fs.readdirSync(TASKS); } catch { return; }
	for (const name of names) {
		const dir = path.join(TASKS, name);
		if (!fs.existsSync(path.join(dir, "home"))) continue;
		try {
			const file = path.join(dir, "state.json");
			const state = readJson(file);
			if (workerGone(state)) markWorkerGone(file, state);
			else if (!TERMINAL.has(state.status) || (typeof state.workerPid === "number" && pidAlive(state.workerPid))) continue;
			closeHome(dir);
		} catch {}
	}
}

export async function wait(id: string, waitMs = 30000, signal?: AbortSignal): Promise<any> {
	const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 86400000);
	for (;;) {
		if (signal?.aborted) { await cancel(id); throw new Error("Delegate wait cancelled"); }
		const state = status(id);
		if (TERMINAL.has(state.status) || state.pending?.length || Date.now() >= deadline) return state;
		await sleep(100);
	}
}

export function answer(id: string, requestId: string, value: { answer?: string; approved?: boolean }): any {
	parentOnly();
	const state = status(id);
	const pending = state.pending.find((item: any) => item.id === requestId);
	if (!pending || TERMINAL.has(state.status)) throw new Error("Question is stale or is not pending on this task");
	if (pending.kind === "permission" && typeof value.approved !== "boolean") throw new Error("Permission answer requires approved: true or false");
	if (pending.kind === "question" && (typeof value.answer !== "string" || !value.answer.trim() || value.answer.length > 16000)) throw new Error("Question requires a nonempty answer of at most 16000 characters");
	fs.writeFileSync(path.join(taskDir(id), `answer-${requestId}.json`), JSON.stringify(pending.kind === "permission" ? { approved: value.approved } : { answer: value.answer }), { mode: 0o600, flag: "wx" });
	return { taskId: id, requestId, accepted: true };
}

export async function cancel(id: string): Promise<any> {
	parentOnly();
	const state = status(id);
	if (TERMINAL.has(state.status)) return state;
	atomic(path.join(taskDir(id), "cancel.json"), { cancelled: true });
	for (let i = 0; i < 80; i++) {
		const current = status(id);
		if (TERMINAL.has(current.status)) return current;
		await sleep(100);
	}
	throw new Error("Cancellation is pending; check task status");
}

function settled(id: string): { state: any; input: any } {
	parentOnly();
	const state = status(id);
	if (!TERMINAL.has(state.status)) throw new Error("The task is still active. Wait for it or cancel it first.");
	if (state.accepted || state.undone) throw new Error(`The task was already ${state.accepted ? "accepted" : "undone"}`);
	return { state, input: readJson(path.join(taskDir(id), "request.json")) };
}

export function accept(id: string): any {
	const { state, input } = settled(id);
	if (input.scope?.length) {
		dropRefs(input.cwd, id);
		releaseScope(input.cwd, id);
	}
	releaseClaims(input.cwd, id);
	Object.assign(state, { scopeHeld: false, accepted: true, acceptedAt: Date.now() });
	atomic(path.join(taskDir(id), "state.json"), state);
	fs.rmSync(taskDir(id), { recursive: true, force: true });
	return state;
}

export function undo(id: string, force = false): any {
	const { state, input } = settled(id);
	if (!input.scope?.length) throw new Error("A read-only task has no changes to undo");
	const restored = undoScope(input.cwd, id, input.scope, taskDir(id), force);
	releaseScope(input.cwd, id);
	releaseClaims(input.cwd, id);
	Object.assign(state, { scopeHeld: false, undone: true, undoneAt: Date.now(), restored });
	atomic(path.join(taskDir(id), "state.json"), state);
	fs.rmSync(taskDir(id), { recursive: true, force: true });
	return state;
}

export function parseOlderThan(value?: string): number {
	if (value === undefined || !value.trim()) return 7 * 86400000;
	const match = /^(\d+)([mhd])$/.exec(value.trim());
	if (!match) throw new Error("olderThan takes a number with m, h or d, for example 7d");
	const units: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
	return Number(match[1]) * units[match[2]];
}

export function prune(olderThanMs: number): { removed: string[]; kept: { taskId: string; reason: string }[] } {
	parentOnly();
	const removed: string[] = [];
	const kept: { taskId: string; reason: string }[] = [];
	const cutoff = Date.now() - olderThanMs;
	let names: string[] = [];
	try { names = fs.readdirSync(TASKS); } catch { return { removed, kept }; }
	for (const name of names) {
		const dir = path.join(TASKS, name);
		let stat: fs.Stats;
		try { stat = fs.statSync(dir); } catch { continue; }
		if (!stat.isDirectory()) continue;
		let state: any;
		try { state = readJson(path.join(dir, "state.json")); } catch { state = undefined; }
		const taskId = typeof state?.taskId === "string" ? state.taskId : name;
		if (!state) {
			if (stat.mtimeMs < cutoff) { removeTask(name, dir); removed.push(taskId); }
			else kept.push({ taskId, reason: "starting" });
			continue;
		}
		if (!TERMINAL.has(state.status)) { kept.push({ taskId, reason: "active" }); continue; }
		if (state.scopeHeld === true) { kept.push({ taskId, reason: "holds scope; accept or undo it" }); continue; }
		const finished = typeof state.finishedAt === "number" ? state.finishedAt : stat.mtimeMs;
		if (finished < cutoff) { removeTask(name, dir); removed.push(taskId); }
	}
	return { removed, kept };
}

function removeTask(id: string, dir: string): void {
	try {
		const input = readJson(path.join(dir, "request.json"));
		if (typeof input.cwd === "string" && input.scope?.length && fs.existsSync(input.cwd)) dropRefs(input.cwd, id);
	} catch {}
	fs.rmSync(dir, { recursive: true, force: true });
}

export function diff(id: string): any {
	parentOnly();
	const input = readJson(path.join(taskDir(id), "request.json"));
	if (!input.scope?.length) return { taskId: id, diff: "" };
	return { taskId: id, diff: diffScope(input.cwd, id, input.scope) };
}

export async function runOne(request: DelegateRequest, _index = 0, signal?: AbortSignal): Promise<any> {
	const state = start(request);
	return wait(state.taskId, request.timeoutMs ?? 900000, signal);
}

export async function runMany(requests: DelegateRequest[], signal?: AbortSignal): Promise<any[]> {
	if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_TASKS) throw new Error(`Use 1–${MAX_TASKS} tasks`);
	let next = 0;
	const results: any[] = new Array(requests.length);
	await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, requests.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= requests.length) return;
			try { results[i] = await runOne(requests[i], i, signal); }
			catch (error: any) { results[i] = { status: "failed", error: error.message, summary: error.message }; }
		}
	}));
	return results;
}

export async function runWorker(id: string): Promise<void> {
	const dir = taskDir(id);
	const input = readJson(path.join(dir, "request.json"));
	const state = readJson(path.join(dir, "state.json"));
	const scope: string[] = input.scope ?? [];
	state.workerPid = process.pid;
	state.heartbeat = Date.now();
	const save = makeSave(path.join(dir, "state.json"), state);
	const beat = () => { const now = Date.now(); if (now - (state.heartbeat ?? 0) >= HEARTBEAT_MS) state.heartbeat = now; };
	save();
	let slotHeld = false;
	let child: ReturnType<typeof spawn> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let escalation: ReturnType<typeof setTimeout> | undefined;
	let stopped: string | undefined;
	let closed = false;
	let denied = false;
	let errorText = "";
	let lastOutputAt = Date.now();
	let lastTick = lastOutputAt;
	let activeMs = 0;
	let logPartial = "";
	let logFd: number | undefined;
	const closeLog = () => { if (logFd !== undefined) { try { fs.closeSync(logFd); } catch {} logFd = undefined; } };
	let parentListing: Record<string, string[]> = {};
	let ignoredBefore = new Set<string>();
	const watchers: fs.FSWatcher[] = [];
	const sockets = new Map<string, net.Socket>();
	const connections = new Set<net.Socket>();
	const stop = (reason: string) => {
		if (closed || stopped) return;
		stopped = reason;
		if (child?.pid) {
			try { process.kill(-child.pid, "SIGTERM"); } catch {}
			escalation = setTimeout(() => { if (!closed && child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 2000);
		}
	};
	const onSignal = () => stop("cancelled");
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);
	const server = net.createServer(socket => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
		socket.on("error", () => {});
		let buffer = "";
		let received = false;
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			if (received) return;
			buffer += chunk.toString();
			if (buffer.length > 32768) { socket.destroy(); return; }
			if (!buffer.includes("\n")) return;
			received = true;
			try {
				const value = JSON.parse(buffer.split("\n")[0]);
				if (["claim", "release", "notify"].includes(value.kind)) {
					socket.end(JSON.stringify(claimMessage(input.cwd, id, state.agent, value)) + "\n");
					return;
				}
				if (!["question", "permission"].includes(value.kind) || typeof value.question !== "string" || !value.question.trim() || value.question.length > 8000 || sockets.size >= 16) throw new Error("Invalid question");
				const requestId = randomUUID();
				const pending = { id: requestId, kind: value.kind, question: value.question, options: Array.isArray(value.options) ? value.options.slice(0, 20) : [], multiSelect: value.multiSelect === true, tool: value.tool, input: value.input };
				sockets.set(requestId, socket);
				state.pending.push(pending);
				state.status = "waiting";
				state.summary = "Child is waiting for the parent user. Do not invent an answer.";
				save();
			} catch { socket.end(JSON.stringify({ error: "Invalid question request" }) + "\n"); }
		});
	});
	try {
		const queuedAt = Date.now();
		for (;;) {
			beat();
			if (scope.length && !state.scopeHeld) {
				const blocking = await acquireScope(input.cwd, id, scope, dir);
				if (blocking.length) {
					state.status = "queued";
					state.queuedBehind = blocking;
					state.summary = `Queued: the scope overlaps task ${blocking.join(", ")}. It starts when that task completes, or when the parent accepts or undoes it.`;
					save();
					if (fs.existsSync(path.join(dir, "cancel.json"))) stop("cancelled");
					if (Date.now() - queuedAt > input.timeoutMs) { errorText = `Queued for more than ${Math.round(input.timeoutMs / 1000)}s behind task ${blocking.join(", ")}`; stop("timed_out"); }
					if (stopped) break;
					await sleep(500);
					continue;
				}
				state.scopeHeld = true;
			}
			if (!slotHeld) {
				const blocking = await acquireSlot(input.cwd, id, dir, MAX_PARALLEL);
				if (blocking.length) {
					state.status = "queued";
					state.queuedBehind = blocking;
					state.summary = `Queued: this workspace already runs ${blocking.length} children, the maximum of ${MAX_PARALLEL}. It starts when a running child stops, or when the parent cancels it.`;
					save();
					if (fs.existsSync(path.join(dir, "cancel.json"))) stop("cancelled");
					if (Date.now() - queuedAt > input.timeoutMs) { errorText = `Queued for more than ${Math.round(input.timeoutMs / 1000)}s waiting for a free child slot`; stop("timed_out"); }
					if (stopped) break;
					await sleep(500);
					continue;
				}
				slotHeld = true;
			}
			break;
		}
		if (!stopped && scope.length && !state.snapshot) {
			delete state.queuedBehind;
			snapshot(input.cwd, scope, id, "before", dir);
			ignoredBefore = new Set(ignoredPaths(input.cwd, scope).skipped);
			state.snapshot = true;
			save();
		}
		if (!stopped) {
			fs.mkdirSync(path.join(dir, "ipc"), { mode: 0o700 });
			await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path.join(dir, "ipc/control.sock"), resolve); });
			fs.chmodSync(path.join(dir, "ipc/control.sock"), 0o600);
			prepareHome(path.join(dir, "home"), input.provider);
			const provider = PROVIDERS[input.provider as keyof typeof PROVIDERS];
			let invocation = provider.build({ prompt: `${input.systemPrompt}\n\n${instruction(scope)}\n\nTask: ${input.task}`, model: input.model, maxTurns: input.maxTurns, tools: input.tools });
			if (input.provider === "pi") invocation = insertInvocationFlags(invocation, ["--extension", "/delegate/child-pi.ts"]);
			if (input.provider === "claude") invocation.args.unshift("--setting-sources", "user");
			const layout = scopeLayout(input.cwd, scope);
			parentListing = listParents(input.cwd, layout);
			const wrapped = sandboxInvocation(invocation, { project: input.cwd, layout, scratch: input.scratch ?? [], git: gitMounts(input.cwd) }, dir, input.provider, input.runtimeMode);
			state.status = "running";
			state.startedAt = Date.now();
			state.summary = "Running inside the filesystem sandbox";
			state.logPath = path.join(dir, "output.log");
			save();
			let logBytes = 0;
			const openLog = () => { logFd = fs.openSync(state.logPath, "a", 0o600); };
			openLog();
			const rotateLog = () => {
				closeLog();
				try {
					if (fs.existsSync(`${state.logPath}.1`)) fs.unlinkSync(`${state.logPath}.1`);
					fs.renameSync(state.logPath, `${state.logPath}.1`);
				} catch {}
				logBytes = 0;
				openLog();
				fs.writeSync(logFd!, "[delegate] log rotated; the earlier part is in output.log.1\n");
				state.logRotated = (state.logRotated ?? 0) + 1;
			};
			const log = (text: string) => {
				logPartial += text;
				if (!text.includes("\n")) return;
				const lines = logPartial.split("\n");
				logPartial = lines.pop() ?? "";
				for (const raw of lines) {
					const line = compactLogLine(raw);
					if (!line) continue;
					if (logBytes + line.length + 1 > LOG_CAP) rotateLog();
					fs.writeSync(logFd!, `${line}\n`);
					logBytes += line.length + 1;
				}
			};
			let output = "";
			let providerError = false;
			let buffer = "";
			const seen = new Map<string, any>();
			const parse = (line: string) => {
				try {
					const raw = JSON.parse(line);
					if (raw.type === "result" && Array.isArray(raw.permission_denials) && raw.permission_denials.length) denied = true;
					if (raw.type === "result" && raw.is_error) providerError = true;
					if (input.provider === "commandcode" && raw?.type === "event" && raw?.event?.type === "turn_start") {
						state.usage.turns += 1;
					}
					for (const event of provider.parse(raw)) {
						if (event.kind === "cost") { state.costUsd = event.costUsd; state.usage.cost = event.costUsd; continue; }
						if (event.kind === "info") { errorText = (errorText + event.text).slice(-4000); continue; }
						if (event.errorMessage || ["error", "aborted"].includes(event.stopReason || "")) { providerError = true; errorText = event.errorMessage || event.stopReason!; }
						if (event.role !== "assistant") continue;
						for (const part of event.content) {
							const line = activityLine(part);
							if (line && line !== state.activity?.at(-1)) state.activity = [...(state.activity ?? []), line].slice(-ACTIVITY);
						}
						const text = event.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
						if (text.trim()) output = text.slice(-8000);
						if (event.usage) {
							const previous = event.id ? seen.get(event.id) : undefined;
							for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) state.usage[key] += (event.usage[key] || 0) - (previous?.[key] || 0);
							if (!previous && input.provider !== "commandcode") state.usage.turns++;
							if (event.id) seen.set(event.id, event.usage);
							if (input.provider === "pi" && event.usage.cost !== undefined) state.costUsd = state.usage.cost;
							if (event.usage.contextTokens) {
								state.usage.contextTokens = Math.max(state.usage.contextTokens, event.usage.contextTokens);
							}
						}
					}
				} catch { errorText = (errorText + line).slice(-4000); }
			};
			const watchRoots = scope.includes(".") ? ["."] : [...new Set(scope.map(rel => { try { return fs.statSync(path.join(input.cwd, rel)).isDirectory() ? rel : path.dirname(rel); } catch { return path.dirname(rel); } }))];
			const conflicted = new Set<string>();
			const onChange = (root: string, name: string | null) => {
				if (!name) return;
				const rel = path.join(root, name);
				if (rel.split("/").some(part => part === ".git" || part === "node_modules")) return;
				if (!scope.some(s => s === "." || rel === s || rel.startsWith(s + "/"))) return;
				try {
					if (fs.statSync(path.join(input.cwd, rel)).isDirectory()) return;
				} catch {}
				const [other] = claimPaths(input.cwd, id, state.agent, [rel]);
				if (!other || conflicted.has(rel)) return;
				conflicted.add(rel);
				state.conflicts = [...(state.conflicts ?? []), { path: rel, taskId: other.taskId }];
				state.summary = `${state.summary}\n[delegate] Conflict: ${rel} is also claimed by task ${other.taskId}`.slice(-4000);
			};
			for (const root of watchRoots) {
				try {
					const watcher = fs.watch(path.join(input.cwd, root), { recursive: true }, (_event, name) => { try { onChange(root, name); } catch {} });
					watcher.on("error", () => {});
					watchers.push(watcher);
				} catch (error: any) {
					state.summary = `${state.summary}\n[delegate] The file watcher for ${root} did not start: ${error.message}`.slice(-4000);
				}
			}
			child = spawn(wrapped.command, wrapped.args, { cwd: input.cwd, env: wrapped.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
			child.stdin?.on("error", () => {});
			child.stdin?.end();
			lastOutputAt = Date.now();
			lastTick = lastOutputAt;
			state.childPid = child.pid;
			save();
			child.stdout!.setEncoding("utf8");
			child.stderr!.setEncoding("utf8");
			child.stdout!.on("data", chunk => {
				lastOutputAt = Date.now();
				state.lastOutputAt = Math.floor(lastOutputAt / 1000) * 1000;
				const text = chunk.toString();
				log(text);
				buffer += text;
				if (buffer.length > 4 * 1024 * 1024) { providerError = true; errorText = "Child output line exceeded 4 MiB"; stop("failed"); buffer = ""; return; }
				if (!text.includes("\n")) return;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) parse(line);
			});
			child.stderr!.on("data", chunk => { const text = chunk.toString(); log(text); errorText = (errorText + text).slice(-4000); });
			interval = setInterval(() => {
				try {
					if (fs.existsSync(path.join(dir, "cancel.json"))) stop("cancelled");
					for (const pending of [...state.pending]) {
						const file = path.join(dir, `answer-${pending.id}.json`);
						const socket = sockets.get(pending.id);
						if (socket?.destroyed) {
							state.pending = state.pending.filter((p: any) => p.id !== pending.id);
							sockets.delete(pending.id);
							continue;
						}
						if (!fs.existsSync(file)) continue;
						const response = readJson(file);
						if (pending.kind === "permission" && response.approved !== true) denied = true;
						socket?.end(JSON.stringify(response) + "\n");
						sockets.delete(pending.id);
						state.pending = state.pending.filter((p: any) => p.id !== pending.id);
						fs.renameSync(file, path.join(dir, `answered-${pending.id}.json`));
					}
					if (!stopped && Number(input.contextBudget ?? 0) > 0 && state.usage.contextTokens > Number(input.contextBudget)) {
						errorText = `Context budget reached: the child carried ${state.usage.contextTokens} tokens in one request, above the budget of ${input.contextBudget}. Its changes stay in the project. Continue with a new child on the same scope after accept.`;
						stop("blocked");
					}
					const now = Date.now();
					if (state.pending.length) lastOutputAt = now;
					else activeMs += now - lastTick;
					lastTick = now;
					if (!stopped && activeMs > input.timeoutMs) stop("timed_out");
					if (!stopped && now - lastOutputAt > Number(input.noProgressMs ?? 600000)) {
						errorText = `No child output for ${Math.round(Number(input.noProgressMs ?? 600000) / 1000)}s. Last output: ${(errorText || "(none)").slice(-500)}`;
						stop("failed");
					}
					if (!state.pending.length && state.status === "waiting") { state.status = "running"; state.summary = "Child continued after user input"; }
					beat();
					save();
				} catch (error: any) { errorText = error.message; stop("failed"); }
			}, 100);
			const code = await new Promise<number>((resolve, reject) => { child!.once("error", reject); child!.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1))); });
			closed = true;
			if (buffer.trim()) parse(buffer);
			state.exitCode = code;
			state.status = stopped || (code !== 0 || providerError ? "failed" : denied || /^BLOCKED\b/i.test(output.trim()) ? "blocked" : "completed");
			state.summary = (state.status === "failed" || state.status === "blocked" ? errorText || output : output || errorText || state.status).slice(-4000);
		} else {
			state.status = stopped;
			state.summary = (errorText || `Stopped while queued: ${stopped}`).slice(-4000);
		}
		state.pending = [];
	} catch (error: any) {
		stop("failed");
		state.status = "failed";
		state.summary = String(error.message || error).slice(0, 4000);
		state.pending = [];
	} finally {
		if (logPartial.trim()) {
			try {
				const tail = compactLogLine(logPartial);
				if (tail) {
					if (logFd !== undefined) fs.writeSync(logFd, `${tail}\n`);
					else fs.appendFileSync(state.logPath, `${tail}\n`, { mode: 0o600 });
				}
			} catch {}
		}
		closeLog();
		if (interval) clearInterval(interval);
		for (const watcher of watchers) watcher.close();
		if (closed && escalation) clearTimeout(escalation);
		for (const socket of connections) socket.destroy();
		server.close();
		if (slotHeld) { try { releaseSlot(input.cwd, id); slotHeld = false; } catch {} }
		if (state.snapshot) {
			try {
				snapshot(input.cwd, scope, id, "after", dir);
				state.diffstat = diffstat(input.cwd, id, scope);
				const stray = strayFiles(input.cwd, scope, parentListing, id);
				if (stray.length) {
					state.strayFiles = stray;
					state.summary = `${state.summary}\n[delegate] New paths next to the file scope, outside the scope, not in the snapshot and not removed by undo: ${stray.slice(0, 20).join(", ")}`.slice(-4000);
				}
				const ignored = ignoredPaths(input.cwd, scope).skipped.filter(rel => !ignoredBefore.has(rel));
				if (ignored.length) {
					state.ignoredPaths = ignored;
					state.summary = `${state.summary}\n[delegate] New git-ignored paths in the scope, too large for the snapshot and not removed by undo: ${ignored.slice(0, 20).join(", ")}`.slice(-4000);
				}
			} catch (error: any) {
				state.summary = `${state.summary}\n[delegate] The after snapshot failed: ${error.message}`.slice(-4000);
			}
		}
		if (state.scopeHeld && (state.status === "completed" || !state.snapshot)) {
			try { releaseScope(input.cwd, id); state.scopeHeld = false; } catch {}
		}
		if (state.status === "completed") {
			try { releaseClaims(input.cwd, id); } catch {}
		}
		state.durationMs = Date.now() - (state.startedAt || state.createdAt);
		state.finishedAt = Date.now();
		save();
		closeHome(dir);
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
	}
}
