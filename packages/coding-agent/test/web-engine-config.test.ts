import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getWebEngineBinaryPath } from "../src/config.ts";

const descriptors = new Map(
	["platform", "arch", "execPath"].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]),
);
let root: string;
let packageDir: string;

function createBinary(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "", { mode: 0o755 });
	return path;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-web-config-"));
	packageDir = join(root, "coding-agent");
	mkdirSync(packageDir);
	vi.stubEnv("PI_PACKAGE_DIR", packageDir);
	vi.stubEnv("PI_WEB_BIN", "");
	Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
	Object.defineProperty(process, "arch", { configurable: true, value: "x64" });
	Object.defineProperty(process, "execPath", { configurable: true, value: join(root, "runtime", "node") });
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const [key, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(process, key, descriptor);
	}
	rmSync(root, { recursive: true, force: true });
});

describe("web engine binary resolution", () => {
	test("returns no binary when no helper is installed", () => {
		expect(getWebEngineBinaryPath()).toBeUndefined();
	});

	test("honors an explicit executable without silently falling back", () => {
		createBinary(join(packageDir, "dist", "bin", "pi-web-x64"));
		vi.stubEnv("PI_WEB_BIN", " ./missing-web-engine ");
		expect(getWebEngineBinaryPath()).toBe(resolve("./missing-web-engine"));
	});

	test("prefers an architecture-specific packaged binary", () => {
		createBinary(join(packageDir, "dist", "bin", "pi-web"));
		const binary = createBinary(join(packageDir, "dist", "bin", "pi-web-x64"));
		expect(getWebEngineBinaryPath()).toBe(binary);
	});

	test("resolves ARM64 packages", () => {
		Object.defineProperty(process, "arch", { configurable: true, value: "arm64" });
		const binary = createBinary(join(packageDir, "dist", "bin", "pi-web-arm64"));
		expect(getWebEngineBinaryPath()).toBe(binary);
	});

	test("resolves an unqualified binary beside a compiled Pi executable", () => {
		const binary = createBinary(join(packageDir, "pi-web"));
		expect(getWebEngineBinaryPath()).toBe(binary);
	});

	test("resolves a helper beside the runtime executable", () => {
		const binary = createBinary(join(root, "runtime", "pi-web-x64"));
		expect(getWebEngineBinaryPath()).toBe(binary);
	});

	test("resolves a local release build in a source checkout", () => {
		const binary = createBinary(join(root, "web-rs", "target", "release", "pi-web"));
		expect(getWebEngineBinaryPath()).toBe(binary);
	});

	test("rejects non-Linux platforms even with an override", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		vi.stubEnv("PI_WEB_BIN", "/custom/pi-web");
		expect(getWebEngineBinaryPath()).toBeUndefined();
	});

	test("does not guess a packaged binary for an unsupported architecture", () => {
		Object.defineProperty(process, "arch", { configurable: true, value: "riscv64" });
		createBinary(join(packageDir, "dist", "bin", "pi-web"));
		expect(getWebEngineBinaryPath()).toBeUndefined();
	});
});
