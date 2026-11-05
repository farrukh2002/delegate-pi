import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTaskId, createCliTransport, type DelegateTransport } from "../src/core/delegate/transport.ts";

const FIXTURE = [
	"const args = process.argv.slice(2);",
	"const cmd = args[0];",
	"const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };",
	'const out = (v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); };',
	'if (cmd === "status") {',
	'  const id = flag("--task-id");',
	'  if (id === "missing") { out({ error: "no such task" }); process.exit(1); }',
	'  out({ taskId: id, status: "running", agent: "worker", provider: "pi" });',
	'} else if (cmd === "cancel") {',
	'  out({ taskId: flag("--task-id"), status: "cancelled" });',
	'} else if (cmd === "diff") {',
	'  out({ diff: "diff-body" });',
	'} else if (cmd === "accept") {',
	'  out({ taskId: flag("--task-id"), status: "completed" });',
	'} else if (cmd === "undo") {',
	'  out({ taskId: flag("--task-id"), status: "completed", restored: ["a.ts"] });',
	'} else if (cmd === "prune") {',
	'  out({ removed: ["x"], kept: [] });',
	'} else if (cmd === "agents") {',
	'  out([{ name: "worker", provider: "pi" }]);',
	'} else if (cmd === "models") {',
	'  const provider = flag("--provider");',
	'  if (provider === "codex") { out({ error: "discovery broke" }); process.exit(1); }',
	'  out([{ provider: provider ?? "pi", models: [{ id: "pi/glm", efforts: ["high"] }], fetchedAt: 1 }]);',
	'} else if (cmd === "answer") {',
	'  const j = JSON.parse(flag("--json"));',
	'  if (j.requestId === "err") { out({ error: "bad answer" }); process.exit(1); }',
	"  out({ ok: true });",
	'} else if (cmd === "start") {',
	'  out({ taskId: "11111111-1111-4111-8111-111111111111", status: "running", agent: "worker" });',
	'} else if (cmd === "start-many") {',
	'  const list = JSON.parse(flag("--json"));',
	'  out(list.map((r, i) => i === 1 ? { status: "failed", error: "no worker" } : { taskId: "22222222-2222-4222-8222-00000000000" + i, status: "running", agent: r.agent }));',
	'} else if (cmd === "big") {',
	'  out("x".repeat(2 * 1024 * 1024));',
	"} else {",
	'  process.stderr.write("unknown command");',
	"  process.exit(3);",
	"}",
].join("\n");

const TASK = "11111111-1111-4111-8111-111111111111";
let dir = "";
let dataDir = "";
let transport: DelegateTransport;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "delegate-transport-"));
	writeFileSync(join(dir, "fixture.mjs"), FIXTURE);
	dataDir = join(dir, "data");
	mkdirSync(join(dataDir, "tasks", TASK), { recursive: true });
	writeFileSync(join(dataDir, "tasks", TASK, "state.json"), JSON.stringify({ taskId: TASK, status: "completed" }));
	transport = createCliTransport({ cliPath: join(dir, "fixture.mjs"), env: {}, cwd: dir, dataDir });
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("delegate transport", () => {
	it("parses a status result", async () => {
		const state = await transport.status(TASK);
		expect(state.status).toBe("running");
		expect(state.agent).toBe("worker");
	});

	it("enforces the exit code and the parsed error", async () => {
		await expect(transport.status("missing")).rejects.toThrow(/status failed/);
		await expect(transport.answer(TASK, "err", { answer: "x" })).rejects.toThrow(/bad answer/);
	});

	it("rejects an invalid task ID before running", async () => {
		await expect(transport.status("bad id!")).rejects.toThrow(/Invalid task ID/);
		await expect(transport.diff("")).rejects.toThrow(/Invalid task ID/);
		expect(() => assertTaskId("ok-1")).not.toThrow();
	});

	it("caps captured output", async () => {
		const result = await transport.run(["big"], { timeoutMs: 15000 });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
	});

	it("polls the configured data directory", async () => {
		const state = await transport.poll(TASK);
		expect(state?.status).toBe("completed");
		expect(await transport.poll("00000000-0000-4000-8000-000000000000")).toBeUndefined();
	});

	it("preserves partial start-many failures", async () => {
		const states = await transport.start([{ agent: "a" }, { agent: "b" }]);
		expect(states).toHaveLength(2);
		expect(states[0]!.agent).toBe("a");
		expect(states[1]!.error).toBe("no worker");
	});

	it("parses answer, diff, accept and undo results", async () => {
		await expect(transport.answer(TASK, "q1", { answer: "x" })).resolves.toBeUndefined();
		expect(await transport.diff(TASK)).toBe("diff-body");
		expect((await transport.accept(TASK)).status).toBe("completed");
		expect((await transport.undo(TASK, true)).restored).toEqual(["a.ts"]);
		expect((await transport.prune("7d")).removed).toEqual(["x"]);
		expect(await transport.agents(dir)).toEqual([{ name: "worker", provider: "pi" }]);
	});

	it("lists models for all providers or one provider, and reports CLI failures", async () => {
		const all = await transport.listModels();
		expect(all).toEqual([{ provider: "pi", models: [{ id: "pi/glm", efforts: ["high"] }], fetchedAt: 1 }]);
		const one = await transport.listModels("pi");
		expect(one[0]!.provider).toBe("pi");
		await expect(transport.listModels("codex")).rejects.toThrow(/discovery broke/);
	});

	it("honors DELEGATE_DATA from options.env when dataDir is not given", async () => {
		const envTransport = createCliTransport({
			cliPath: join(dir, "fixture.mjs"),
			env: { DELEGATE_DATA: dataDir },
			cwd: dir,
		});
		const state = await envTransport.poll(TASK);
		expect(state?.status).toBe("completed");
	});

	it("rejects dot and dotdot task IDs", async () => {
		expect(() => assertTaskId(".")).toThrow(/Invalid task ID/);
		expect(() => assertTaskId("..")).toThrow(/Invalid task ID/);
		await expect(transport.poll("..")).rejects.toThrow(/Invalid task ID/);
	});
});
