import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	getAgentDir,
	getAuthPath,
	getSessionsDir,
	getSettingsPath,
	PACKAGE_NAME,
} from "../src/config.ts";

const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const OFFICIAL_ENV_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";

interface PackageManifest {
	name: string;
	piConfig: { name?: string; configDir?: string };
	bin: Record<string, string>;
}

function readManifest(): PackageManifest {
	return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
}

const MANAGED_ENV_KEYS = [ENV_AGENT_DIR, ENV_SESSION_DIR, OFFICIAL_ENV_AGENT_DIR, OFFICIAL_ENV_SESSION_DIR];

describe("delegate fork config isolation", () => {
	let savedEnv: Array<[string, string | undefined]>;
	let tempDirs: string[];

	beforeEach(() => {
		savedEnv = MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]);
		tempDirs = [];
	});

	afterEach(() => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "delegate-fork-config-"));
		tempDirs.push(dir);
		return dir;
	}

	it("rebrands the command and config directory without renaming the package", () => {
		const manifest = readManifest();
		expect(manifest.name).toBe(OFFICIAL_PACKAGE_NAME);
		expect(manifest.piConfig).toEqual({ name: "delegate-pi", configDir: ".delegate-pi" });
		expect(manifest.bin).toEqual({ "delegate-pi": "dist/bundle/cli.js" });
		expect(manifest.bin.pi).toBeUndefined();
	});

	it("derives the fork app identity and shell-safe env names from piConfig", () => {
		expect(PACKAGE_NAME).toBe(OFFICIAL_PACKAGE_NAME);
		expect(APP_NAME).toBe("delegate-pi");
		expect(APP_TITLE).toBe("delegate-pi");
		expect(CONFIG_DIR_NAME).toBe(".delegate-pi");
		expect(ENV_AGENT_DIR).toBe("DELEGATE_PI_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("DELEGATE_PI_CODING_AGENT_SESSION_DIR");
		expect(ENV_AGENT_DIR).not.toContain("-");
		expect(ENV_SESSION_DIR).not.toContain("-");
	});

	it("resolves every fork config path under .delegate-pi, never .pi", () => {
		delete process.env[ENV_AGENT_DIR];
		const agentDir = join(homedir(), ".delegate-pi", "agent");
		expect(getAgentDir()).toBe(agentDir);
		expect(getSessionsDir()).toBe(join(agentDir, "sessions"));
		expect(getSettingsPath()).toBe(join(agentDir, "settings.json"));
		expect(getAuthPath()).toBe(join(agentDir, "auth.json"));
		expect(getAgentDir()).not.toBe(join(homedir(), ".pi", "agent"));
	});

	it("honors the fork env override for every config path", () => {
		const override = makeTempDir();
		process.env[ENV_AGENT_DIR] = override;
		expect(getAgentDir()).toBe(override);
		expect(getSessionsDir()).toBe(join(override, "sessions"));
		expect(getSettingsPath()).toBe(join(override, "settings.json"));
		expect(getAuthPath()).toBe(join(override, "auth.json"));
	});

	it("expands a tilde in the fork env override", () => {
		process.env[ENV_AGENT_DIR] = "~/delegate-fork-agent";
		expect(getAgentDir()).toBe(join(homedir(), "delegate-fork-agent"));
	});

	it("ignores the official PI_CODING_AGENT_DIR for the fork", () => {
		const officialDir = makeTempDir();
		delete process.env[ENV_AGENT_DIR];
		process.env[OFFICIAL_ENV_AGENT_DIR] = officialDir;
		const agentDir = join(homedir(), ".delegate-pi", "agent");
		expect(getAgentDir()).toBe(agentDir);
		expect(getSessionsDir()).toBe(join(agentDir, "sessions"));
		expect(getSettingsPath()).toBe(join(agentDir, "settings.json"));
		expect(getAgentDir()).not.toBe(officialDir);
	});
});
