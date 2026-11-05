#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { start, runOne, runMany, runWorker, status, wait, answer, cancel, accept, undo, diff, prune, parseOlderThan, MAX_TASKS } from "./core.ts";
import { agentProblem, enabledProviders, loadAgents } from "./agents.ts";
import { listClaims } from "./workspace.ts";
import { PROVIDERS, PROVIDER_IDS, providerAvailable } from "./providers.ts";
import { listModels } from "./models.ts";

const args = process.argv.slice(2);
const command = args.shift();
const has = name => args.includes(name);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const json = () => JSON.parse(has("--b64") ? Buffer.from(flag("--b64"), "base64url").toString() : flag("--json") || flag("--tasks-json") || "{}");
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

function request() {
  if (has("--json") || has("--b64") || has("--tasks-json")) return json();
  return Object.fromEntries(Object.entries({
    agent: flag("--agent"), task: flag("--task"), provider: flag("--provider"), model: flag("--model"),
    runtimeMode: flag("--runtime-mode"), scope: flag("--scope"), cwd: flag("--cwd"), sandbox: flag("--sandbox"),
    scratch: flag("--scratch")?.split(",").map(item => item.trim()).filter(Boolean),
    tools: flag("--tools"),
    timeoutMs: has("--timeout") ? Number(flag("--timeout")) : undefined,
    noProgressMs: has("--no-progress-ms") ? Number(flag("--no-progress-ms")) : undefined,
    contextBudget: has("--context-budget") ? Number(flag("--context-budget")) : undefined,
  }).filter(([, value]) => value !== undefined));
}

function finish(results) {
  if (results.some(item => item?.status !== "completed")) process.exitCode = 2;
}

function print(value) {
  if (!has("--text") || !value || typeof value !== "object") { console.log(JSON.stringify(value, null, 2)); return; }
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (!item.taskId) { console.log(JSON.stringify(item)); continue; }
    console.log(`[${item.agent || "task"} / ${item.provider || ""}] ${item.status || "answer accepted"} | ${item.taskId}`);
    if (item.costUsd != null) console.log(`Reported cost: $${item.costUsd.toFixed(4)}`);
    if (item.summary) console.log(item.summary);
    if (item.scope?.length) console.log(`Scope: ${item.scope.join(", ")}`);
    for (const conflict of item.conflicts || []) console.log(`Conflict: ${conflict.path} (task ${conflict.taskId})`);
    if (item.diffstat) console.log(`Changes:\n${item.diffstat}`);
    if (item.accepted) console.log("Accepted. The scope is free.");
    if (item.undone) console.log(`Undone. Restored: ${(item.restored || []).join(", ") || "nothing"}`);
    for (const pending of item.pending || []) console.log(`PENDING ${pending.kind} ${pending.id}: ${JSON.stringify(pending)}`);
  }
}

try {
  if (command === "_worker") {
    await runWorker(args[0]);
  } else if (command === "run" || command === "start") {
    const parsed = request();
    if (Array.isArray(parsed) && parsed.length !== 1) throw new Error("Use run-many for more than one task");
    const input = Array.isArray(parsed) ? parsed[0] : parsed;
    const result = command === "start" ? start(input) : await runOne(input, 0, controller.signal);
    print(result);
    if (command === "run") finish([result]);
  } else if (command === "start-many") {
    const parsed = json();
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length < 1 || list.length > MAX_TASKS) throw new Error(`Use 1-${MAX_TASKS} tasks`);
    print(list.map((item) => {
      try { return start(item); }
      catch (error) { return { status: "failed", error: error.message || String(error) }; }
    }));
  } else if (command === "run-many") {
    const results = await runMany(json(), controller.signal);
    print(results);
    finish(results);
  } else if (["status", "wait", "cancel", "answer", "accept", "undo", "diff"].includes(command)) {
    const input = json();
    const id = flag("--task-id") || input.taskId;
    if (!id) throw new Error("A task ID is required");
    if (command === "status") print(status(id));
    if (command === "accept") print(accept(id));
    if (command === "undo") print(undo(id, has("--force") || input.force === true));
    if (command === "diff") { const result = diff(id); if (has("--text")) process.stdout.write(result.diff ? `${result.diff}\n` : ""); else print(result); }
    if (command === "wait") print(await wait(id, Number(flag("--wait-ms") || input.waitMs || 30000), controller.signal));
    if (command === "cancel") print(await cancel(id));
    if (command === "answer") {
      const value = { answer: flag("--answer") ?? input.answer, approved: has("--approve") ? true : has("--deny") ? false : input.approved };
      print(answer(id, flag("--request-id") || input.requestId, value));
    }
  } else if (command === "prune") {
    const result = prune(parseOlderThan(flag("--older-than")));
    if (has("--text")) {
      console.log(`Removed ${result.removed.length} task folders`);
      for (const item of result.kept) console.log(`Kept ${item.taskId}: ${item.reason}`);
    } else print(result);
  } else if (command === "agents") {
    const enabled = enabledProviders();
    print(loadAgents(flag("--cwd") || process.cwd()).map(({ name, provider, model, scope, source, description, filePath }) => {
      const problem = agentProblem({ provider }, enabled);
      return { name, provider, model, scope: scope ?? [], source, description, filePath, ready: !problem, ...(problem ? { problem } : {}) };
    }));
  } else if (command === "claims") {
    const claims = listClaims(realpathSync(flag("--cwd") || process.cwd()));
    if (has("--text")) for (const claim of claims) console.log(`${claim.path} | ${claim.taskId} | ${claim.agent}`);
    else print(claims);
  } else if (command === "providers") {
    print(PROVIDER_IDS.map(id => ({ id, ready: providerAvailable(id), description: PROVIDERS[id].describe })));
  } else if (command === "models") {
    const provider = flag("--provider");
    if (provider && !PROVIDER_IDS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
    const results = (provider ? [provider] : PROVIDER_IDS).map(id => listModels(id, { refresh: has("--refresh") }));
    if (has("--text")) {
      for (const result of results) {
        console.log(`${result.provider}${result.error ? ` (error: ${result.error})` : ""}`);
        if (!result.models.length) console.log("  No models available");
        for (const model of result.models) {
          const detail = [model.description, model.efforts?.length ? `efforts: ${model.efforts.join(", ")}` : undefined].filter(Boolean).join("; ");
          console.log(`  ${model.id}${detail ? ` — ${detail}` : ""}`);
        }
      }
    } else print(results);
  } else {
    throw new Error("Use run/start --agent NAME --task TEXT [--scope PATH,PATH] [--scratch PATH,PATH]; run-many --tasks-json JSON; status/wait/cancel/diff/accept --task-id ID; undo --task-id ID [--force]; answer --task-id ID --request-id ID --answer TEXT (or --approve/--deny); prune [--older-than 7d]; agents; models [--provider P] [--refresh] [--text]; providers; claims [--cwd DIR]. Sandbox is mandatory. No scope means read-only. Default permissions require parent approval. full-access means access inside the sandbox only.");
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.message || String(error) }));
  process.exitCode = 1;
}
