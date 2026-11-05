import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA } from "./workspace.ts";
import type { ProviderId } from "./types.ts";

export interface ModelInfo {
	id: string;
	description?: string;
	efforts?: string[];
}

export interface ModelList {
	provider: ProviderId;
	models: ModelInfo[];
	fetchedAt: number;
	error?: string;
}

export type ModelRunner = (command: string, args: string[], timeoutMs: number) => string;

const CACHE_TTL = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 30000;
const PI_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const CLAUDE_MODELS: ModelInfo[] = [
	{ id: "opus", description: "Claude Opus" },
	{ id: "sonnet", description: "Claude Sonnet" },
	{ id: "haiku", description: "Claude Haiku" },
	{ id: "fable", description: "Claude Fable" },
];

export function parsePiModels(text: string): ModelInfo[] {
	const models: ModelInfo[] = [];
	for (const line of text.split(/\r?\n/)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length < 6 || columns[0].toLowerCase() === "provider") continue;
		if (columns.some(column => /^[-=]+$/.test(column))) continue;
		const [provider, model, , , thinking] = columns;
		if (!provider || !model) continue;
		models.push({
			id: `${provider}/${model}`,
			...(thinking?.toLowerCase() === "yes" ? { efforts: [...PI_EFFORTS] } : {}),
		});
	}
	return models;
}

export function parseCodexModels(json: string): ModelInfo[] {
	const value = JSON.parse(json);
	if (!Array.isArray(value?.models)) return [];
	return value.models.flatMap((item: any): ModelInfo[] => {
		if (!item || typeof item.slug !== "string" || item.visibility === "hide") return [];
		const efforts: string[] = Array.isArray(item.supported_reasoning_levels)
			? [...new Set<string>(item.supported_reasoning_levels.map((level: any) => level?.effort).filter((effort: unknown): effort is string => typeof effort === "string"))]
			: [];
		return [{
			id: item.slug,
			...(typeof item.description === "string" ? { description: item.description } : {}),
			...(efforts.length ? { efforts } : {}),
		}];
	});
}

export function parseCommandcodeModels(text: string): ModelInfo[] {
	const models: ModelInfo[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || /^Available models\b/i.test(trimmed) || /^(Open Source|Anthropic)$/i.test(trimmed)) continue;
		const match = /^(\S+)\s{2,}(.+)$/.exec(trimmed);
		if (!match) continue;
		models.push({ id: match[1], description: match[2].trim() });
	}
	return models;
}

function runCli(command: string, args: string[], timeoutMs: number): string {
	try {
		return execFileSync(command, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
	} catch (error: any) {
		const detail = [error?.stderr, error?.stdout, error?.message].map(value => Buffer.isBuffer(value) ? value.toString("utf8").trim() : typeof value === "string" ? value.trim() : "").find(Boolean);
		throw new Error(detail || `${command} failed`);
	}
}

function commandFor(provider: ProviderId): { command: string; args: string[]; parse: (text: string) => ModelInfo[] } | undefined {
	if (provider === "pi") return { command: "pi", args: ["--list-models"], parse: parsePiModels };
	if (provider === "codex") return { command: "codex", args: ["debug", "models"], parse: parseCodexModels };
	if (provider === "commandcode") return { command: "commandcode", args: ["--list-models"], parse: parseCommandcodeModels };
	return undefined;
}

function cachePath(provider: ProviderId): string {
	return path.join(DATA, "models", `${provider}.json`);
}

function readCache(provider: ProviderId): ModelList | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(cachePath(provider), "utf8"));
		if (value?.provider !== provider || !Array.isArray(value.models) || typeof value.fetchedAt !== "number") return undefined;
		if (Date.now() - value.fetchedAt < 0 || Date.now() - value.fetchedAt >= CACHE_TTL) return undefined;
		return value as ModelList;
	} catch {
		return undefined;
	}
}

function writeCache(result: ModelList): void {
	try {
		const file = cachePath(result.provider);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(result), { mode: 0o600 });
		fs.renameSync(temp, file);
	} catch {}
}

export function listModels(provider: ProviderId, options: { refresh?: boolean; run?: ModelRunner } = {}): ModelList {
	if (!options.refresh) {
		const cached = readCache(provider);
		if (cached) return cached;
	}
	const fetchedAt = Date.now();
	let result: ModelList;
	if (provider === "claude") {
		result = { provider, models: CLAUDE_MODELS.map(model => ({ ...model })), fetchedAt };
	} else {
		const spec = commandFor(provider);
		try {
			if (!spec) throw new Error(`Unsupported provider: ${provider}`);
			const output = (options.run ?? runCli)(spec.command, spec.args, TIMEOUT_MS);
			result = { provider, models: spec.parse(output), fetchedAt };
		} catch (error: any) {
			result = { provider, models: [], fetchedAt, error: error instanceof Error ? error.message : String(error) };
		}
	}
	if (!result.error) writeCache(result);
	return result;
}

function piModelMatches(candidate: ModelInfo, model: string): boolean {
	const aliases = [candidate.id, candidate.id.includes("/") ? candidate.id.slice(candidate.id.indexOf("/") + 1) : candidate.id];
	if (aliases.includes(model)) return true;
	const colon = model.lastIndexOf(":");
	if (colon < 0) return false;
	const base = model.slice(0, colon);
	const effort = model.slice(colon + 1);
	return (candidate.efforts ?? []).includes(effort) && aliases.includes(base);
}

export function checkModel(provider: ProviderId, model: string | undefined, options: { run?: ModelRunner } = {}): void {
	if (!model?.trim()) return;
	const list = listModels(provider, { run: options.run });
	if (list.error || list.models.length === 0) return;
	let valid = false;
	if (provider === "pi") {
		const matches = list.models.filter(candidate => piModelMatches(candidate, model));
		valid = matches.length === 1;
	} else if (provider === "claude") {
		valid = list.models.some(candidate => candidate.id === model) || model.startsWith("claude-");
	} else {
		valid = list.models.some(candidate => candidate.id === model);
	}
	if (valid) return;
	const needle = (provider === "pi" ? model.replace(/:[^/:]*$/, "") : model).toLowerCase();
	const close = list.models.filter(candidate => candidate.id.toLowerCase().includes(needle) || needle.includes(candidate.id.toLowerCase())).slice(0, 8).map(candidate => candidate.id);
	throw new Error(`Unknown model ${model} for provider ${provider}. Close matches: ${close.length ? close.join(", ") : "none"}. Run delegate models --provider ${provider} for the list.`);
}
