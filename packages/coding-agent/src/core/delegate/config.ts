import { join } from "node:path";
import { getAgentDir, getPackageDir } from "../../config.ts";

export const DELEGATE_PROJECT_CONFIG_DIR = ".delegate-pi";
export const DELEGATE_PI_CONFIG_DIR = ".delegate-pi";

export function delegateCliPath(packageDir: string = getPackageDir()): string {
	return join(packageDir, "delegate", "core", "delegate.mjs");
}

export function delegateDataDir(): string {
	return join(getAgentDir(), "delegate");
}

export function delegateAgentsDir(): string {
	return join(getAgentDir(), "delegate", "agents");
}

export function delegateDefaultAgentsDir(packageDir: string = getPackageDir()): string {
	return join(packageDir, "delegate", "agents");
}

export function delegatePiEntry(packageDir: string = getPackageDir()): string {
	return join(packageDir, "dist", "bundle", "cli.js");
}

export function delegateEnv(packageDir: string = getPackageDir()): Record<string, string> {
	return {
		DELEGATE_DATA: delegateDataDir(),
		DELEGATE_AGENTS_DIR: delegateAgentsDir(),
		DELEGATE_DEFAULT_AGENTS_DIR: delegateDefaultAgentsDir(packageDir),
		DELEGATE_PROJECT_CONFIG_DIR,
		DELEGATE_PI_ENTRY: delegatePiEntry(packageDir),
		DELEGATE_PI_PACKAGE_DIR: packageDir,
		DELEGATE_PI_CONFIG_DIR,
	};
}
