import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, piEntryProblem, providerAvailable } from "./providers.ts";
import type { ProviderId, RuntimeMode } from "./types.ts";

export interface AgentFile {
	name: string;
	description: string;
	provider: ProviderId;
	model?: string;
	runtimeMode: RuntimeMode;
	scope?: string[];
	tools?: string[];
	maxTurns?: number;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_IDS: ProviderId[] = ["pi", "claude", "codex", "commandcode"];

export function defaultAgentsDir(): string {
	return process.env.DELEGATE_DEFAULT_AGENTS_DIR || path.resolve(ROOT, "..", "agents");
}

export function userAgentsDir(): string {
	return process.env.DELEGATE_AGENTS_DIR || path.join(os.homedir(), ".pi", "agent", "agents");
}

export function projectConfigDir(): string {
	return process.env.DELEGATE_PROJECT_CONFIG_DIR || ".pi";
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return { data: {}, body: content };

	const data: Record<string, string> = {};
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "---") {
			end = i;
			break;
		}
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (value.length > 0) data[key] = value;
	}
	if (end < 0) return { data: {}, body: content };
	return { data, body: lines.slice(end + 1).join("\n").trim() };
}

function toProviderId(value: string | undefined): ProviderId {
	return value && (PROVIDER_IDS as string[]).includes(value) ? (value as ProviderId) : "pi";
}

function toRuntimeMode(value: string | undefined): RuntimeMode {
	if (value === "full-access" || value === "approval-required") return value;
	return "inherit";
}

export function toToolList(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const raw = typeof value === "string" ? (value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value) : value.join(",");
	const tools = raw
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function loadAgentFile(filePath: string, source: AgentFile["source"]): AgentFile | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const { data, body } = parseFrontmatter(content);
	if (!data.name || !data.description) return null;
	return {
		name: data.name,
		description: data.description,
		provider: toProviderId(data.provider),
		model: data.model,
		runtimeMode: toRuntimeMode(data.runtimeMode),
		scope: toToolList(data.scope),
		tools: toToolList(data.tools),
		maxTurns: data.maxTurns && Number(data.maxTurns) > 0 ? Math.floor(Number(data.maxTurns)) : undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

function projectRoot(cwd: string): string {
	for (let current = cwd; ; current = path.dirname(current)) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		if (path.dirname(current) === current) return cwd;
	}
}

export function loadAgents(cwd: string): AgentFile[] {
	const found = new Map<string, AgentFile>();
	const dirs: Array<{ dir: string; source: AgentFile["source"] }> = [
		{ dir: defaultAgentsDir(), source: "bundled" },
		{ dir: userAgentsDir(), source: "user" },
	];

	const top = projectRoot(cwd);
	for (let current = cwd; ; current = path.dirname(current)) {
		const candidate = path.join(current, projectConfigDir(), "agents");
		if (fs.existsSync(candidate)) {
			dirs.push({ dir: candidate, source: "project" });
			break;
		}
		if (current === top || path.dirname(current) === current) break;
	}

	for (const { dir, source } of dirs) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
			const agent = loadAgentFile(path.join(dir, entry.name), source);
			if (agent) found.set(agent.name, agent);
		}
	}

	return Array.from(found.values());
}

export function enabledProviders(file = process.env.DELEGATE_PROVIDERS_FILE || path.join(ROOT, "providers.json")): ProviderId[] {
	try {
		const listed = JSON.parse(fs.readFileSync(file, "utf-8")).providers;
		const ids = Array.isArray(listed) ? PROVIDER_IDS.filter((id) => listed.includes(id)) : [];
		if (ids.length > 0) return ids;
	} catch {}
	return PROVIDER_IDS;
}

export function agentProblem(agent: Pick<AgentFile, "provider">, enabled: ProviderId[] = enabledProviders()): string | undefined {
	if (!enabled.includes(agent.provider)) return `${agent.provider} was not chosen at install (providers.json)`;
	if (providerAvailable(agent.provider)) return undefined;
	return (agent.provider === "pi" ? piEntryProblem() : undefined) ?? `the ${PROVIDERS[agent.provider].binary} CLI is not installed`;
}

export function findAgent(name: string, cwd: string): AgentFile | undefined {
	return loadAgents(cwd).find((agent) => agent.name === name);
}
