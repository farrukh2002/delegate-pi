#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendored = join(root, "packages", "coding-agent", "delegate");
const delegateRepo = process.env.DELEGATE_REPO || join(root, "..");
const baselineFile = join(root, "scripts", "delegate-sync-baseline.json");
const accept = process.argv.includes("--accept");

const failures = [];
const notes = [];

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listFiles(base, prefix = "") {
	const entries = [];
	if (!existsSync(base)) return entries;
	for (const name of readdirSync(base, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${name.name}` : name.name;
		if (rel === "core/models" || rel === "core/projects" || rel === "core/tasks") continue;
		if (name.isDirectory()) entries.push(...listFiles(join(base, name.name), rel));
		else entries.push(rel);
	}
	return entries.sort();
}

function fail(message) {
	failures.push(message);
}

if (!existsSync(join(delegateRepo, "core", "core.ts"))) {
	console.error(`delegate repository not found at ${delegateRepo}`);
	console.error("set DELEGATE_REPO to the delegate checkout and retry");
	process.exit(2);
}

const delegateAgents = listFiles(join(delegateRepo, "agents"), "agents");
const vendoredAgents = listFiles(join(vendored, "agents"), "agents");
for (const rel of delegateAgents) {
	const b = join(vendored, rel);
	if (!existsSync(b)) fail(`${rel}: bundled agent missing in the vendored runtime`);
	else if (sha256(join(delegateRepo, rel)) !== sha256(b)) fail(`${rel}: bundled agent must be byte-identical but differs`);
}
for (const rel of vendoredAgents) {
	if (!existsSync(join(delegateRepo, rel))) fail(`${rel}: vendored-only bundled agent`);
}

const delegateShared = [...listFiles(join(delegateRepo, "core"), "core"), ...listFiles(join(delegateRepo, "tests"), "tests")];
const vendoredShared = [...listFiles(join(vendored, "core"), "core"), ...listFiles(join(vendored, "tests"), "tests")];

for (const rel of delegateShared) {
	const b = join(vendored, rel);
	if (!existsSync(b)) fail(`${rel}: missing in the vendored runtime`);
	else if (sha256(join(delegateRepo, rel)) !== sha256(b)) fail(`${rel}: must be byte-identical but differs`);
}
for (const rel of vendoredShared) {
	if (!existsSync(join(delegateRepo, rel))) fail(`${rel}: exists only in the vendored runtime`);
}

const sharedSources = [["core/view.ts", join(root, "packages", "coding-agent", "src", "core", "delegate", "view.ts")]];
for (const [rel, copy] of sharedSources) {
	if (!existsSync(copy)) fail(`${relative(root, copy)}: missing copy of ${rel}`);
	else if (sha256(join(delegateRepo, rel)) !== sha256(copy)) fail(`${relative(root, copy)}: must be byte-identical to ${rel}`);
}

let head;
try {
	head = execFileSync("git", ["-C", delegateRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
	fail("could not read the delegate repository git HEAD");
}

let baseline = {};
try {
	baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
} catch {}

if (head && !accept && baseline.delegateHead && baseline.delegateHead !== head) {
	fail(`delegate repository moved: baseline ${baseline.delegateHead.slice(0, 12)}, HEAD ${head.slice(0, 12)}`);
	notes.push("port the new delegate changes, then run: npm run check:delegate-sync -- --accept");
}

if (failures.length === 0 && accept && head) {
	writeFileSync(baselineFile, `${JSON.stringify({ delegateHead: head, syncedAt: new Date().toISOString() }, null, 2)}\n`);
	notes.push(`baseline updated to ${head.slice(0, 12)}`);
}

for (const note of notes) console.log(`note: ${note}`);
if (failures.length > 0) {
	for (const failure of failures) console.error(`DRIFT ${failure}`);
	console.error(`\n${failures.length} drift problem(s). Sync the delegate changes into packages/coding-agent/delegate/ and retry.`);
	process.exit(1);
}
console.log(`delegate runtime in sync with ${relative(root, delegateRepo)} (baseline ${head.slice(0, 12)})`);
