import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getForkedSelfUpdateInstruction } from "../src/config.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const launcher = join(repoRoot, "scripts", "delegate-pi-dev.mjs");
const bundle = join(packageDir, "dist", "bundle", "cli.js");

describe("fork self-update guard", () => {
	it("returns the local rebuild instruction for a renamed distribution", () => {
		const instruction = getForkedSelfUpdateInstruction("delegate-pi");
		expect(instruction).toBeDefined();
		expect(instruction).toContain("delegate-pi");
		expect(instruction).toContain("npm run build");
		expect(instruction).toContain("node scripts/delegate-pi-dev.mjs");
	});

	it("preserves official Pi self-update behavior", () => {
		expect(getForkedSelfUpdateInstruction("pi")).toBeUndefined();
	});

	describe("package command", () => {
		let tempDir: string;
		let agentDir: string;
		let projectDir: string;
		let npmRecordPath: string;
		let originalCwd: string;
		let originalAgentDir: string | undefined;
		let originalExitCode: typeof process.exitCode;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "delegate-fork-distribution-"));
			agentDir = join(tempDir, "agent");
			projectDir = join(tempDir, "project");
			npmRecordPath = join(tempDir, "npm-record.json");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });

			const fakeNpmPath = join(tempDir, "fake-npm.cjs");
			writeFileSync(
				fakeNpmPath,
				`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(npmRecordPath)},JSON.stringify(process.argv.slice(2)));`,
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ npmCommand: [process.execPath, fakeNpmPath] }, null, 2),
			);

			originalCwd = process.cwd();
			originalAgentDir = process.env[ENV_AGENT_DIR];
			originalExitCode = process.exitCode;
			process.exitCode = undefined;
			process.env[ENV_AGENT_DIR] = agentDir;
			process.chdir(projectDir);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
			process.chdir(originalCwd);
			process.exitCode = originalExitCode;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(tempDir, { force: true, recursive: true });
		});

		it("blocks self-update before any registry or install call", async () => {
			const fetchMock = vi.fn(() => {
				throw new Error("the registry must not be queried for a fork self-update");
			});
			vi.stubGlobal("fetch", fetchMock);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(fetchMock).not.toHaveBeenCalled();
			expect(existsSync(npmRecordPath)).toBe(false);
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("does not self-update");
			expect(stderr).toContain("npm run build");
			expect(stderr).toContain("node scripts/delegate-pi-dev.mjs");
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain("Updated");
			expect(process.exitCode).toBe(1);
		});

		it("does not block an extensions-only update", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "log").mockImplementation(() => {});

			await expect(handlePackageCommand(["update", "--extensions"])).resolves.toBe(true);

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).not.toContain("does not self-update");
		});
	});
});

describe("delegate-pi dev launcher", () => {
	it("runs the existing bundle from another cwd", () => {
		if (!existsSync(bundle)) {
			return;
		}
		const output = execFileSync(process.execPath, [launcher, "--help"], {
			cwd: tmpdir(),
			encoding: "utf8",
			timeout: 60000,
		});
		expect(output).toContain("delegate-pi");
		expect(output).toContain("Usage:");
	});

	it("only executes the built bundle and never installs or builds", () => {
		const script = readFileSync(launcher, "utf8");
		expect(script).toContain("spawn(process.execPath, [bundle");
		expect(script).not.toContain("execSync");
		expect(script).not.toContain("writeFileSync");
		expect(script).not.toContain("mkdirSync");
	});
});
