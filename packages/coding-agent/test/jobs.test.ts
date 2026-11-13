import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReport, type Job, JobManager } from "../src/extensions/jobs/index.ts";

type Run = { onData: (data: Buffer) => void; resolve: (code: number) => void; reject: (error: Error) => void };

function fakeExec() {
	const runs: Run[] = [];
	const exec = (_command: string, _cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal }) =>
		new Promise<{ exitCode: number | null }>((resolve, reject) => {
			options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			runs.push({ onData: options.onData, resolve: (code) => resolve({ exitCode: code }), reject });
		});
	return { runs, exec: exec as never };
}

const dir = () => mkdtempSync(join(tmpdir(), "pi-jobs-test-"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("JobManager", () => {
	it("hands a finished job to a waiting call and not to onFinish", async () => {
		const { runs, exec } = fakeExec();
		const finished: Job[] = [];
		const manager = new JobManager(dir(), (job) => finished.push(job), exec);
		const job = manager.start("make", "/");
		const waiting = manager.wait(undefined, 60_000);
		runs[0].onData(Buffer.from("building\nok\n"));
		runs[0].resolve(0);
		const jobs = await waiting;
		expect(jobs.map((j) => j.id)).toEqual([job.id]);
		expect(job.state).toBe("done");
		expect(finished).toEqual([]);
		expect(readFileSync(job.log, "utf8")).toBe("building\nok\n");
	});

	it("calls onFinish once when nothing waits, and reports a job only once", async () => {
		const { runs, exec } = fakeExec();
		const finished: Job[] = [];
		const manager = new JobManager(dir(), (job) => finished.push(job), exec);
		manager.start("test", "/");
		runs[0].resolve(2);
		await tick();
		expect(finished.map((j) => j.state)).toEqual(["failed"]);
		expect(manager.takeUnreported().map((j) => j.exitCode)).toEqual([2]);
		expect(manager.takeUnreported()).toEqual([]);
	});

	it("returns from wait after the time limit while the job still runs", async () => {
		const { exec } = fakeExec();
		const manager = new JobManager(dir(), () => {}, exec);
		manager.start("server", "/");
		expect(await manager.wait(undefined, 10)).toEqual([]);
		expect(manager.running()).toHaveLength(1);
	});

	it("waits only for the named job", async () => {
		const { runs, exec } = fakeExec();
		const manager = new JobManager(dir(), () => {}, exec);
		manager.start("a", "/");
		const b = manager.start("b", "/");
		const waiting = manager.wait([b.id], 60_000);
		runs[0].resolve(0);
		await tick();
		runs[1].resolve(0);
		expect((await waiting).map((j) => j.id)).toEqual([b.id]);
		expect(manager.takeUnreported().map((j) => j.id)).toEqual(["j1"]);
	});

	it("marks a cancelled job", async () => {
		const { exec } = fakeExec();
		const finished: Job[] = [];
		const manager = new JobManager(dir(), (job) => finished.push(job), exec);
		const job = manager.start("sleep", "/");
		expect(manager.cancel(job.id)).toBe(true);
		await tick();
		expect(job.state).toBe("cancelled");
		expect(manager.cancel(job.id)).toBe(false);
		expect(finished).toHaveLength(1);
	});

	it("runs a real shell command", async () => {
		const manager = new JobManager(dir());
		const job = manager.start("echo hello; exit 3", process.cwd());
		const [done] = await manager.wait([job.id], 10_000);
		expect(done.exitCode).toBe(3);
		expect(done.tail).toContain("hello");
	});
});

describe("formatReport", () => {
	it("shows the exit code, duration, log and the last 30 lines", () => {
		const job = {
			id: "j1",
			command: "npm   test",
			cwd: "/",
			log: "/tmp/j1.log",
			startedAt: 0,
			endedAt: 125_000,
			exitCode: 1,
			state: "failed",
			tail: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
			reported: false,
			controller: new AbortController(),
		} as Job;
		const report = formatReport([job], 200_000);
		expect(report).toContain("j1 failed, exit 1, 2m 5s: npm test\nlog: /tmp/j1.log");
		expect(report).toContain("line 20\n");
		expect(report).not.toContain("line 19\n");
		expect(report.startsWith("<job-report>")).toBe(true);
	});
});
