#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(repoRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const marker = "# delegate-pi launcher (managed by scripts/delegate-pi-install.mjs)";

function usage(message) {
	if (message) {
		process.stderr.write(`delegate-pi-install: ${message}\n`);
	}
	process.stderr.write(
		"usage: node scripts/delegate-pi-install.mjs [install|uninstall|doctor] [--prefix <dir>] [--name <command>] [--force] [--purge]\n",
	);
	process.exit(1);
}

function parseArgs(argv) {
	const options = {
		command: null,
		force: false,
		purge: false,
		prefix: join(homedir(), ".local", "bin"),
		name: "delegate-pi",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--force") {
			options.force = true;
		} else if (arg === "--purge") {
			options.purge = true;
		} else if (arg === "--prefix") {
			const value = argv[++i];
			if (!value) {
				usage("missing value for --prefix");
			}
			options.prefix = value;
		} else if (arg.startsWith("--prefix=")) {
			options.prefix = arg.slice("--prefix=".length);
		} else if (arg === "--name") {
			options.name = argv[++i];
		} else if (arg.startsWith("--name=")) {
			options.name = arg.slice("--name=".length);
		} else if (arg.startsWith("--")) {
			usage(`unknown option: ${arg}`);
		} else if (options.command) {
			usage(`unexpected argument: ${arg}`);
		} else {
			options.command = arg;
		}
	}
	if (!options.name || !/^[A-Za-z0-9._-]+$/.test(options.name)) {
		usage(`invalid --name: ${options.name ?? ""}`);
	}
	return options;
}

function findExecutable(name) {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) {
			continue;
		}
		const candidate = join(dir, name);
		try {
			const stat = statSync(candidate);
			if (stat.isFile() && (stat.mode & 0o111) !== 0) {
				return candidate;
			}
		} catch {}
	}
	return null;
}

function isOurs(file) {
	try {
		return readFileSync(file, "utf8").includes(marker);
	} catch {
		return false;
	}
}

function binOnPath(prefix) {
	const dirs = (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((dir) => resolve(dir));
	return dirs.includes(resolve(prefix));
}

function requirePlatformAndSandbox() {
	if (process.platform !== "linux") {
		process.stderr.write(`delegate-pi install: Linux is required, current platform is ${process.platform}\n`);
		process.exit(1);
	}
	if (!findExecutable("bwrap")) {
		process.stderr.write("delegate-pi install: bwrap (bubblewrap) not found on PATH\n");
		process.exit(1);
	}
}

function requireBundle() {
	if (!existsSync(bundlePath)) {
		process.stderr.write(
			`delegate-pi install: no built bundle at ${bundlePath}\nrun npm run build first\n` +
				"This script never builds, downloads, or runs npm install.\n",
		);
		process.exit(1);
	}
}

function launcherScript() {
	return ["#!/bin/sh", marker, `exec node ${JSON.stringify(bundlePath)} "$@"`, ""].join("\n");
}

function install(options) {
	requirePlatformAndSandbox();
	requireBundle();
	mkdirSync(options.prefix, { recursive: true });
	const launcher = join(options.prefix, options.name);
	const backup = join(options.prefix, `${options.name}.bak`);
	if (existsSync(launcher) && !isOurs(launcher)) {
		if (!options.force) {
			process.stderr.write(
				`delegate-pi install: refusing to overwrite ${launcher}, it is not a delegate-pi launcher (use --force)\n`,
			);
			process.exit(1);
		}
		copyFileSync(launcher, backup);
		console.log(`backed up previous launcher to ${backup}`);
	}
	writeFileSync(launcher, launcherScript());
	chmodSync(launcher, 0o755);
	console.log(`installed ${launcher}`);
	console.log(`bundle: ${bundlePath}`);
	if (!binOnPath(options.prefix)) {
		console.log(`warning: ${options.prefix} is not on your PATH`);
	}
}

function uninstall(options) {
	const launcher = join(options.prefix, options.name);
	const backup = join(options.prefix, `${options.name}.bak`);
	let removed = false;
	if (existsSync(launcher)) {
		if (isOurs(launcher)) {
			rmSync(launcher);
			removed = true;
			console.log(`removed ${launcher}`);
		} else {
			process.stderr.write(
				`delegate-pi uninstall: ${launcher} is not a delegate-pi launcher, leaving it in place\n`,
			);
		}
	} else {
		console.log(`no launcher at ${launcher}`);
	}
	if (existsSync(backup) && (removed || !existsSync(launcher))) {
		renameSync(backup, launcher);
		console.log(`restored previous launcher from ${backup}`);
	}
	const stateDir = join(homedir(), ".delegate-pi");
	if (existsSync(stateDir)) {
		if (options.purge) {
			rmSync(stateDir, { recursive: true, force: true });
			console.log(`removed ${stateDir}`);
		} else {
			console.log(`kept ${stateDir} (use --purge to remove it)`);
		}
	} else if (options.purge) {
		console.log(`no state directory at ${stateDir}`);
	}
}

function doctor(options) {
	const launcher = join(options.prefix, options.name);
	const backup = join(options.prefix, `${options.name}.bak`);
	const bwrap = findExecutable("bwrap");
	console.log(`node: ${process.version} (${process.execPath})`);
	console.log(`bwrap: ${bwrap ?? "not found on PATH"}`);
	if (!bwrap) {
		console.log("warning: bwrap is required to run delegate children");
	}
	let bundleVersion = null;
	if (existsSync(bundlePath)) {
		const result = spawnSync(process.execPath, [bundlePath, "--version"], { encoding: "utf8" });
		bundleVersion =
			result.status === 0 ? (result.stdout ?? "").trim() : `--version exited with ${result.status ?? "signal"}`;
	}
	console.log(`bundle: ${bundlePath}`);
	console.log(`bundle version: ${bundleVersion ?? "missing, run npm run build first"}`);
	if (existsSync(launcher)) {
		console.log(`launcher: ${launcher} (${isOurs(launcher) ? "installed" : "present, not managed by this script"})`);
	} else {
		console.log(`launcher: not found at ${launcher}`);
	}
	if (existsSync(backup)) {
		console.log(`launcher backup: ${backup}`);
	}
	const stateDir = join(homedir(), ".delegate-pi");
	console.log(`state dir: ${stateDir} (${existsSync(stateDir) ? "present" : "absent"})`);
	if (!binOnPath(options.prefix)) {
		console.log(`warning: ${options.prefix} is not on your PATH`);
	}
}

const options = parseArgs(process.argv.slice(2));
switch (options.command ?? "install") {
	case "install":
		install(options);
		break;
	case "uninstall":
		uninstall(options);
		break;
	case "doctor":
		doctor(options);
		break;
	default:
		usage(`unknown command: ${options.command}`);
}
