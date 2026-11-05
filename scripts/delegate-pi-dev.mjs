#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(repoRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");

if (!existsSync(bundle)) {
	process.stderr.write(
		`delegate-pi dev launcher: no built bundle at ${bundle}. Build it first:\n` +
			"  npm install --ignore-scripts\n" +
			"  npm run build\n" +
			"This launcher never builds, downloads, or installs anything for you.\n",
	);
	process.exit(1);
}

const child = spawn(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });

child.on("error", (error) => {
	process.stderr.write(`delegate-pi dev launcher: could not start the bundle: ${error.message}\n`);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
