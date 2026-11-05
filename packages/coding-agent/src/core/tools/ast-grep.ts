import { stat as fsStat, readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { astGrepRenderers } from "./renderers/ast-grep.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead, truncateLine } from "./truncate.ts";

const astGrepSchema = Type.Object({
	symbol: Type.Optional(
		Type.String({
			description:
				"Name of a function, class, method, type or constant. Returns its full definition with line numbers. Use Class.method for one member",
		}),
	),
	callers: Type.Optional(
		Type.String({
			description:
				"Name of a function or method. Returns each call site with the function that contains it, e.g. 'src/a.ts 12 in Foo.run: add(1)'",
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description:
				"ast-grep code pattern. Write code with $NAME for one node and $$$ for many, e.g. 'useState($A)' or 'function $F($$$) { $$$ }'",
		}),
	),
	kind: Type.Optional(
		Type.String({ description: "tree-sitter node kind to match instead of a pattern, e.g. 'function_declaration'" }),
	),
	body: Type.Optional(
		Type.Boolean({
			description:
				"With pattern or kind: show each whole match with line numbers (up to 40 lines each), not only its first line",
		}),
	),
	outline: Type.Optional(
		Type.Boolean({
			description: "List the symbols of the files in path with their line numbers. Ignores the other queries",
		}),
	),
	lang: Type.Optional(
		Type.String({
			description: "Language, e.g. ts, tsx, js, py, rust, go. Required with kind. Default: from file extension",
		}),
	),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 100)" })),
});

export const astGrepToolSystemPromptContribution = {
	snippet:
		"Find definitions, call sites and code by syntax structure, and outline files (ast-grep, respects .gitignore)",
	guidelines: [
		"Use ast_grep symbol to read a definition and ast_grep callers to find who calls it, before you read whole files or grep",
		"Use ast_grep outline to see the structure of a file, and ast_grep pattern or kind to find code; add body: true to see the whole matches",
		"After ast_grep, read only the line ranges you still need with read offset and limit, not whole files",
		"Use text search through bash only for logs, prose, or text that ast_grep cannot express",
	],
} as const;

export type AstGrepToolInput = Static<typeof astGrepSchema>;
const DEFAULT_LIMIT = 100;
const BODY_MAX_LINES = 40;
const SYMBOL_MAX_LINES = 150;
const SYMBOL_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/;

export interface AstGrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
}

export interface AstGrepToolOptions {
	/** Path to the ast-grep binary. Default: system ast-grep, or a downloaded copy */
	binaryPath?: string;
}

interface LineRange {
	start: { line: number };
	end: { line: number };
}

interface AstGrepMatch {
	file: string;
	lines: string;
	range: LineRange;
}

interface OutlineSymbol {
	name: string;
	range: LineRange;
	isImport?: boolean;
	members?: OutlineSymbol[];
}

interface OutlineFile {
	path: string;
	items: OutlineSymbol[];
}

interface Block {
	file: string;
	line: number;
	text: string;
	truncated: boolean;
}

type Run = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

function runner(binary: string, cwd: string, signal: AbortSignal | undefined): Run {
	return (args) =>
		new Promise((resolve, reject) => {
			const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			const onAbort = () => child.kill();
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => {
				signal?.removeEventListener("abort", onAbort);
				reject(new Error(`Failed to run ast-grep: ${error.message}`));
			});
			child.on("close", (code) => {
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) reject(new Error("Operation aborted"));
				else if (code !== 0 && code !== 1) reject(new Error(stderr.trim() || `ast-grep exited with code ${code}`));
				else resolve({ stdout, stderr });
			});
		});
}

function parseStream<T>(stdout: string): T[] {
	const rows: T[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as T);
		} catch {}
	}
	return rows;
}

function numbered(lines: string[], first: number, max: number): { text: string; truncated: boolean } {
	let truncated = false;
	const shown = lines.slice(0, max).map((line, index) => {
		const cut = truncateLine(line.replace(/\r/g, ""));
		if (cut.wasTruncated) truncated = true;
		return `${first + index}: ${cut.text}`;
	});
	if (lines.length > max) {
		shown.push(`... ${lines.length - max} more lines, read with offset=${first + max} limit=${lines.length - max}`);
	}
	return { text: shown.join("\n"), truncated };
}

function firstLine(match: AstGrepMatch, prefix: string): Block {
	const cut = truncateLine((match.lines.split("\n")[0] ?? "").replace(/\r/g, "").trim());
	return {
		file: match.file,
		line: match.range.start.line,
		text: `${prefix}: ${cut.text}`,
		truncated: cut.wasTruncated,
	};
}

function wordPattern(name: string): RegExp {
	return new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
}

function location(range: LineRange): string {
	const start = range.start.line + 1;
	const end = range.end.line + 1;
	return end > start ? `${start}-${end}` : `${start}`;
}

function grouped(blocks: Block[], spaced: boolean): string {
	const files = new Map<string, string[]>();
	for (const block of blocks) files.set(block.file, [...(files.get(block.file) ?? []), block.text]);
	const gap = spaced ? "\n\n" : "\n";
	return [...files]
		.map(
			([file, texts]) =>
				`${file}\n${texts
					.join(gap)
					.split("\n")
					.map((line) => (line ? `  ${line}` : line))
					.join("\n")}`,
		)
		.join(gap);
}

async function searchBlocks(run: Run, args: string[], body: boolean): Promise<{ blocks: Block[]; stderr: string }> {
	const { stdout, stderr } = await run(["run", "--json=stream", "--color=never", ...args]);
	const seen = new Set<string>();
	const blocks: Block[] = [];
	for (const match of parseStream<AstGrepMatch>(stdout)) {
		const key = `${match.file}:${match.range.start.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (!body) {
			blocks.push(firstLine(match, location(match.range)));
			continue;
		}
		const shown = numbered(match.lines.split("\n"), match.range.start.line + 1, BODY_MAX_LINES);
		blocks.push({ file: match.file, line: match.range.start.line, text: shown.text, truncated: shown.truncated });
	}
	return { blocks, stderr };
}

async function symbolBlocks(
	run: Run,
	name: string,
	langArgs: string[],
	target: string,
	baseDir: string,
): Promise<Block[]> {
	const [owner, member] = name.includes(".") ? name.split(".", 2) : [undefined, name];
	const outline = (paths: string[]) =>
		run(["outline", "--json=stream", "--color=never", ...langArgs, "--", ...paths]).then(({ stdout }) =>
			parseStream<OutlineFile>(stdout),
		);
	const word = wordPattern(member);
	const contents = new Map<string, string>();
	for (const file of await outline([target])) {
		const relative = file.path.replace(/^\.\//, "");
		const content = await readFile(resolveToCwd(relative, baseDir), "utf8").catch(() => "");
		if (word.test(content)) contents.set(relative, content);
	}
	if (contents.size === 0) return [];
	const blocks: Block[] = [];
	for (const file of await outline([...contents.keys()])) {
		const hits = file.items.flatMap((item) =>
			owner !== undefined
				? item.name === owner
					? (item.members ?? []).filter((m) => m.name === member)
					: []
				: [item, ...(item.members ?? [])].filter((s) => s.name === member && !s.isImport),
		);
		if (hits.length === 0) continue;
		const lines = (contents.get(file.path) ?? "").split("\n");
		for (const hit of hits) {
			const start = hit.range.start.line;
			const shown = numbered(lines.slice(start, hit.range.end.line + 1), start + 1, SYMBOL_MAX_LINES);
			blocks.push({ file: file.path, line: start, text: shown.text, truncated: shown.truncated });
		}
	}
	return blocks;
}

async function callerBlocks(run: Run, name: string, langArgs: string[], target: string): Promise<Block[]> {
	const patterns = [`${name}($$$)`, `$OBJ.${name}($$$)`, `new ${name}($$$)`];
	const results = await Promise.all(
		patterns.map((pattern) =>
			run(["run", "--json=stream", "--color=never", "-p", pattern, ...langArgs, "--", target]),
		),
	);
	const word = wordPattern(name);
	const seen = new Set<string>();
	const matches: AstGrepMatch[] = [];
	for (const match of results.flatMap(({ stdout }) => parseStream<AstGrepMatch>(stdout))) {
		const key = `${match.file}:${match.range.start.line}`;
		if (seen.has(key) || !word.test(match.lines)) continue;
		seen.add(key);
		matches.push(match);
	}
	if (matches.length === 0) return [];
	matches.sort((a, b) => a.file.localeCompare(b.file) || a.range.start.line - b.range.start.line);

	const files = [...new Set(matches.map((m) => m.file))];
	const { stdout } = await run(["outline", "--json=stream", "--color=never", ...langArgs, "--", ...files]);
	const scopes = new Map(
		parseStream<OutlineFile>(stdout).map((file) => [
			file.path,
			file.items.flatMap((item) => [
				{ name: item.name, range: item.range },
				...(item.members ?? []).map((m) => ({ name: `${item.name}.${m.name}`, range: m.range })),
			]),
		]),
	);
	return matches.map((match) => {
		const line = match.range.start.line;
		const scope = (scopes.get(match.file) ?? [])
			.filter((s) => s.range.start.line <= line && s.range.end.line >= line)
			.sort((a, b) => a.range.end.line - a.range.start.line - (b.range.end.line - b.range.start.line))[0];
		return firstLine(match, scope ? `${line + 1} in ${scope.name}` : `${line + 1}`);
	});
}

export function createAstGrepToolDefinition(
	cwd: string,
	options?: AstGrepToolOptions,
): ToolDefinition<typeof astGrepSchema, AstGrepToolDetails | undefined> {
	return {
		name: "ast_grep",
		label: "ast_grep",
		description: `Find code by syntax structure with ast-grep. Give one of: symbol (a definition's full source), callers (call sites with the containing function), pattern (code with $META variables) or kind (tree-sitter node kind), or set outline. Results are grouped by file, with line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: astGrepToolSystemPromptContribution.snippet,
		promptGuidelines: [...astGrepToolSystemPromptContribution.guidelines],
		parameters: astGrepSchema,
		async execute(
			_toolCallId,
			{ symbol, callers, pattern, kind, body, outline, lang, path: searchDir, limit }: AstGrepToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!outline && !symbol && !callers && !pattern && !kind) {
				throw new Error("Give symbol, callers, pattern, kind, or outline: true");
			}
			if (!outline && !symbol && !callers && kind && !lang) throw new Error("kind needs lang");
			const name = outline ? undefined : (symbol ?? callers);
			if (name !== undefined && !SYMBOL_NAME.test(name)) {
				throw new Error(`Not a valid name: ${name}`);
			}

			const binary = options?.binaryPath ?? (await ensureTool("ast-grep"));
			if (!binary) throw new Error("ast-grep is not available and could not be downloaded");

			const baseDir = ctx?.cwd || cwd;
			const target = searchDir || ".";
			try {
				await fsStat(resolveToCwd(target, baseDir));
			} catch {
				throw new Error(`Path not found: ${target}`);
			}

			const run = runner(binary, baseDir, signal);
			const langArgs = lang ? ["--lang", lang] : [];
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			const details: AstGrepToolDetails = {};
			const notices: string[] = [];
			let raw: string;
			let stderr = "";
			if (outline) {
				raw = (await run(["outline", "--color=never", ...langArgs, "--", target])).stdout.trimEnd();
			} else {
				let blocks: Block[];
				let spaced = false;
				if (symbol) {
					blocks = await symbolBlocks(run, symbol, langArgs, target, baseDir);
					spaced = true;
				} else if (callers) {
					blocks = await callerBlocks(run, callers.split(".").pop() ?? callers, langArgs, target);
				} else {
					const query = pattern ? ["--pattern", pattern] : ["--kind", kind ?? ""];
					const result = await searchBlocks(run, [...query, ...langArgs, "--", target], body === true);
					blocks = result.blocks;
					stderr = result.stderr;
					spaced = body === true;
				}
				if (blocks.length > effectiveLimit) {
					blocks = blocks.slice(0, effectiveLimit);
					details.matchLimitReached = effectiveLimit;
					notices.push(
						`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine the query`,
					);
				}
				if (blocks.some((block) => block.truncated))
					notices.push("Some lines truncated. Use read tool to see full lines");
				raw = grouped(blocks, spaced);
			}
			if (!raw) {
				const hint = stderr.includes("ERROR node") ? " (the pattern did not parse as valid code)" : "";
				return { content: [{ type: "text", text: `No matches found${hint}` }], details: undefined };
			}

			const truncation = truncateHead(raw);
			let output = truncation.content;
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
		...astGrepRenderers,
	};
}

export function createAstGrepTool(cwd: string, options?: AstGrepToolOptions): AgentTool<typeof astGrepSchema> {
	return wrapToolDefinition(createAstGrepToolDefinition(cwd, options));
}
