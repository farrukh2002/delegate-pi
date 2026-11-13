import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { type BashOperations, createLocalBashOperations } from "../../core/tools/bash.ts";

export const JOB_TOOL_NAME = "job";
export const JOB_REPORT_TAG = "job-report";
export const DEFAULT_JOB_WAIT_MS = 600_000;
export const MIN_JOB_WAIT_MS = 10_000;
export const MAX_JOB_WAIT_MS = 1_200_000;
const TAIL_LINES = 30;
const TAIL_CHARS = 4000;
const BUFFER_CHARS = 64 * 1024;

const JOB_DESCRIPTION =
	"Run a long shell command in the background, such as a build, test run, training, upload or server, and get its result when it stops. start returns a job id at once. Do not start background work with & or nohup in bash. When a job stops, a <job-report> with its exit code and last output lines comes with your next tool result. If your turn has ended, the report starts a new turn. Do not poll with sleep, tail, ps or status: each call sends the full context again. When you have no other work, call wait: it blocks until a job stops or waitMs passes. status lists the jobs, cancel stops one. The full output is in the log file. Jobs stop when the session ends. Use bash for short commands.";

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface Job {
	id: string;
	command: string;
	cwd: string;
	log: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	state: JobState;
	tail: string;
	reported: boolean;
	controller: AbortController;
}

type Exec = BashOperations["exec"];

export class JobManager {
	readonly jobs = new Map<string, Job>();
	private readonly waiters = new Set<() => void>();
	private count = 0;
	private readonly dir: string;
	private readonly onFinish: (job: Job) => void;
	private readonly exec: Exec;
	private readonly now: () => number;

	constructor(
		dir: string,
		onFinish: (job: Job) => void = () => {},
		exec: Exec = createLocalBashOperations().exec,
		now: () => number = Date.now,
	) {
		this.dir = dir;
		this.onFinish = onFinish;
		this.exec = exec;
		this.now = now;
	}

	start(command: string, cwd: string): Job {
		mkdirSync(this.dir, { recursive: true });
		const id = `j${++this.count}`;
		const job: Job = {
			id,
			command,
			cwd,
			log: join(this.dir, `${id}.log`),
			startedAt: this.now(),
			state: "running",
			tail: "",
			reported: false,
			controller: new AbortController(),
		};
		this.jobs.set(id, job);
		const stream: WriteStream = createWriteStream(job.log);
		const write = (text: string) => {
			stream.write(text);
			job.tail = (job.tail + text).slice(-BUFFER_CHARS);
		};
		const stop = (state: JobState, exitCode?: number) => {
			job.endedAt = this.now();
			stream.end(() => {
				job.exitCode = exitCode;
				job.state = state;
				for (const waiter of [...this.waiters]) waiter();
				if (!job.reported) this.onFinish(job);
			});
		};
		this.exec(command, cwd, { onData: (data: Buffer) => write(data.toString()), signal: job.controller.signal }).then(
			({ exitCode }) => stop(exitCode === 0 ? "done" : "failed", exitCode ?? 1),
			(error: unknown) => {
				if (job.controller.signal.aborted) return stop("cancelled");
				write(`\n${error instanceof Error ? error.message : String(error)}\n`);
				stop("failed");
			},
		);
		return job;
	}

	takeUnreported(ids?: string[]): Job[] {
		const jobs = [...this.jobs.values()].filter(
			(job) => job.state !== "running" && !job.reported && (!ids || ids.includes(job.id)),
		);
		for (const job of jobs) job.reported = true;
		return jobs;
	}

	running(): Job[] {
		return [...this.jobs.values()].filter((job) => job.state === "running");
	}

	async wait(ids: string[] | undefined, ms: number, signal?: AbortSignal): Promise<Job[]> {
		const ready = this.takeUnreported(ids);
		if (ready.length > 0 || !this.running().some((job) => !ids || ids.includes(job.id))) return ready;
		return new Promise<Job[]>((resolve) => {
			const finish = (jobs: Job[]) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.waiters.delete(check);
				resolve(jobs);
			};
			const check = () => {
				const jobs = this.takeUnreported(ids);
				if (jobs.length > 0) finish(jobs);
			};
			const abort = () => finish([]);
			const timer = setTimeout(abort, ms);
			signal?.addEventListener("abort", abort, { once: true });
			this.waiters.add(check);
		});
	}

	cancel(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job || job.state !== "running") return false;
		job.controller.abort();
		return true;
	}

	cancelAll(): void {
		for (const job of this.running()) job.controller.abort();
	}
}

function duration(job: Job, now: number): string {
	const seconds = Math.round(((job.endedAt ?? now) - job.startedAt) / 1000);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function short(command: string): string {
	const line = command.replace(/\s+/g, " ").trim();
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

export function formatJob(job: Job, now: number): string {
	const exit = job.exitCode !== undefined ? `, exit ${job.exitCode}` : "";
	return `${job.id} ${job.state}${exit}, ${duration(job, now)}: ${short(job.command)}\nlog: ${job.log}`;
}

export function formatReport(jobs: Job[], now: number): string {
	const blocks = jobs.map((job) => {
		const tail = job.tail.trimEnd().split("\n").slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
		return `${formatJob(job, now)}${tail ? `\nlast lines:\n${tail}` : ""}`;
	});
	return `<${JOB_REPORT_TAG}>\n${blocks.join("\n\n")}\n</${JOB_REPORT_TAG}>`;
}

const jobSchema = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("wait"), Type.Literal("status"), Type.Literal("cancel")]),
	command: Type.Optional(Type.String({ description: "For start: the bash command." })),
	cwd: Type.Optional(
		Type.String({ description: "For start: the working directory. Default: the session directory." }),
	),
	id: Type.Optional(Type.String({ description: "The job id. For wait: leave empty to wait for any job." })),
	waitMs: Type.Optional(
		Type.Number({
			description: `For wait: return after this long when the jobs still run. Default ${DEFAULT_JOB_WAIT_MS}, min ${MIN_JOB_WAIT_MS}, max ${MAX_JOB_WAIT_MS}.`,
		}),
	),
});

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export function createJobsExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let ctx: ExtensionContext | undefined;
		const wake = () => {
			const jobs = manager.takeUnreported();
			if (jobs.length === 0) return;
			pi.sendMessage(
				{ customType: JOB_REPORT_TAG, content: formatReport(jobs, Date.now()), display: true },
				{ triggerTurn: true },
			);
		};
		const manager = new JobManager(join(tmpdir(), "pi-jobs", String(process.pid)), () => {
			if (ctx?.isIdle()) wake();
		});

		pi.on("session_start", (_event, context) => {
			ctx = context;
		});
		pi.on("session_shutdown", () => {
			manager.cancelAll();
			ctx = undefined;
		});
		pi.on("tool_result", (event) => {
			if (event.parentToolCallId) return;
			const jobs = manager.takeUnreported();
			if (jobs.length === 0) return;
			return {
				content: [...event.content, { type: "text" as const, text: formatReport(jobs, Date.now()) }],
				details: event.details,
				structuredContent: event.structuredContent,
			};
		});
		pi.on("agent_settled", (event) => {
			if (!event.aborted) wake();
		});
		pi.on("before_agent_start", () => {
			const jobs = manager.takeUnreported();
			if (jobs.length === 0) return;
			return { message: { customType: JOB_REPORT_TAG, content: formatReport(jobs, Date.now()), display: true } };
		});

		pi.registerTool({
			name: JOB_TOOL_NAME,
			label: JOB_TOOL_NAME,
			description: JOB_DESCRIPTION,
			parameters: jobSchema,
			async execute(_toolCallId, input, signal, _onUpdate, context) {
				ctx = context;
				const now = Date.now();
				if (input.action === "start") {
					if (!input.command) return text("start needs a command.");
					const job = manager.start(input.command, input.cwd ?? context.cwd);
					return text(`Started ${job.id}. log: ${job.log}\nA <${JOB_REPORT_TAG}> comes when it stops.`);
				}
				if (input.action === "wait") {
					if (input.id && !manager.jobs.has(input.id)) return text(`No job has the id ${input.id}.`);
					const ms = Math.min(Math.max(input.waitMs ?? DEFAULT_JOB_WAIT_MS, MIN_JOB_WAIT_MS), MAX_JOB_WAIT_MS);
					const jobs = await manager.wait(input.id ? [input.id] : undefined, ms, signal);
					const running = manager.running().map((job) => job.id);
					const still = running.length ? `\nStill running: ${running.join(", ")}.` : "";
					if (jobs.length > 0) return text(`${formatReport(jobs, Date.now())}${still}`);
					return text(
						running.length
							? `No job stopped yet.${still} Call wait again, or do other work.`
							: "No job is running.",
					);
				}
				if (input.action === "cancel") {
					if (!input.id) return text("cancel needs an id.");
					return text(manager.cancel(input.id) ? `Cancel sent to ${input.id}.` : `${input.id} is not running.`);
				}
				const jobs = input.id
					? [manager.jobs.get(input.id)].filter((job) => job !== undefined)
					: [...manager.jobs.values()];
				if (jobs.length === 0)
					return text(input.id ? `No job has the id ${input.id}.` : "No jobs in this session.");
				const lines = jobs.map((job) => formatJob(job, now)).join("\n");
				return text(
					manager.running().length ? `${lines}\nTo wait for a running job, use action wait, not status.` : lines,
				);
			},
		});
	};
}

export default createJobsExtension();
