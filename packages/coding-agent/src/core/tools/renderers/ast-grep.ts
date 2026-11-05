import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { AstGrepToolDetails } from "../ast-grep.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

interface AstGrepCallArgs {
	symbol?: string;
	callers?: string;
	body?: boolean;
	pattern?: string;
	kind?: string;
	outline?: boolean;
	lang?: string;
	path?: string;
	limit?: number;
}

function formatAstGrepCall(args: AstGrepCallArgs | undefined, theme: Theme): string {
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const invalidArg = invalidArgText(theme);
	const pattern = str(args?.pattern);
	const kind = str(args?.kind);
	const symbol = str(args?.symbol);
	const callers = str(args?.callers);
	const query = args?.outline
		? "outline"
		: symbol
			? `symbol ${symbol}`
			: callers
				? `callers ${callers}`
				: pattern
					? pattern
					: kind
						? `kind ${kind}`
						: null;
	let text =
		theme.fg("toolTitle", theme.bold("ast_grep")) +
		" " +
		(query === null ? invalidArg : theme.fg("accent", query)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (args?.lang) text += theme.fg("toolOutput", ` (${args.lang})`);
	if (args?.body && (pattern || kind)) text += theme.fg("toolOutput", " body");
	if (args?.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
	return text;
}

function formatAstGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: AstGrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const remaining = lines.length - maxLines;
		text += `\n${lines
			.slice(0, maxLines)
			.map((line) => theme.fg("toolOutput", line))
			.join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}
	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	if (matchLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const astGrepRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatAstGrepCall(args as AstGrepCallArgs, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatAstGrepResult(result as any, options, theme, context.showImages));
		return text;
	},
};
