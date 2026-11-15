#!/usr/bin/env node
// Copy the built PreToolUse hook from the delegate checkout into the vendored
// runtime. The binaries are build artifacts and are not committed.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidates = [process.env.DELEGATE_REPO, join(root, "..", "delegate"), join(root, "..")].filter(Boolean);
const delegateRepo = candidates.map((path) => resolve(path)).find((path) => existsSync(join(path, "core", "core.ts")));
if (!delegateRepo) {
	console.error("sync-delegate-native: delegate checkout not found. Set DELEGATE_REPO.");
	process.exit(1);
}
const source = join(delegateRepo, "bin");
const target = join(root, "packages", "coding-agent", "delegate", "bin");

const names = ["child-claude-x64", "child-claude-arm64"];
const missing = names.filter((name) => !existsSync(join(source, name)));
if (missing.length > 0) {
	console.error(`sync-delegate-native: ${missing.join(", ")} not found in ${source}`);
	console.error("Run scripts/build-native.sh in the delegate checkout first.");
	process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const name of names) {
	copyFileSync(join(source, name), join(target, name));
	console.log(`copied ${name} from ${delegateRepo}`);
}
