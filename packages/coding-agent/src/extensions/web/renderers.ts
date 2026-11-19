import { STATUS_CODES } from "node:http";
import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput } from "../../core/tools/render-utils.ts";
import { renderOutputPreview } from "../../core/tools/renderers/output-preview.ts";
import type { WebEngineFetchAccess } from "../../core/web/client.ts";
import type { WebToolSummary } from "./summary.ts";

type Tone = "success" | "warning" | "error";

interface Label {
	text: string;
	tone: Tone;
}

const FETCH_LABELS = {
	ok: "Page fetched",
	blocked: "Page blocked",
	auth_required: "Login required",
	http_error: "Page not available",
	requires_javascript: "Needs JavaScript",
	empty: "Page is empty",
} satisfies Record<WebEngineFetchAccess, string>;

function statusText(status: number): string {
	const reason = STATUS_CODES[status];
	return reason ? `${status} ${reason}` : `${status}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function summaryLabel(summary: WebToolSummary): Label {
	switch (summary.kind) {
		case "fetch": {
			const text = `${FETCH_LABELS[summary.access]} · ${statusText(summary.status)}`;
			return {
				text: summary.truncated ? `${text} · truncated` : text,
				tone: summary.access === "ok" ? "success" : "warning",
			};
		}
		case "http": {
			const failed = summary.status >= 400;
			const text = `${failed ? "Request failed" : "Request sent"} · ${statusText(summary.status)}`;
			return { text: summary.truncated ? `${text} · truncated` : text, tone: failed ? "error" : "success" };
		}
		case "search": {
			const tones = { ok: "success", empty: "warning", unavailable: "error" } as const;
			const texts = {
				ok: `Found ${plural(summary.count, "result")}`,
				empty: "No results",
				unavailable: "Search unavailable",
			};
			return {
				text: summary.truncated ? `${texts[summary.status]} · truncated` : texts[summary.status],
				tone: tones[summary.status],
			};
		}
		case "git_index":
			return summary.status === "ok"
				? { text: `Repository indexed · ${plural(summary.filesIndexed, "file")}`, tone: "success" }
				: { text: `Repository partly indexed · ${plural(summary.filesIndexed, "file")}`, tone: "warning" };
		case "git_search": {
			const base = summary.status === "ok" ? `Found ${plural(summary.count, "match", "matches")}` : "No matches";
			const notes = [summary.partial ? "partial index" : "", summary.truncated ? "truncated" : ""].filter(Boolean);
			return {
				text: [base, ...notes].join(" · "),
				tone: summary.status === "ok" ? "success" : "warning",
			};
		}
		case "git_read": {
			if (summary.status === "not_found") return { text: "File not found", tone: "warning" };
			const text = `File read · lines ${summary.startLine}-${summary.endLine} of ${summary.totalLines}`;
			return { text: summary.truncated ? `${text} · truncated` : text, tone: "success" };
		}
	}
}

export const webRenderers: Pick<ToolDefinition<any, WebToolSummary | undefined>, "renderResult"> = {
	renderResult(result, options, theme, context) {
		const output = getTextOutput(result, context.showImages);
		const summary = result.details;
		if (!summary || context.isError) return renderOutputPreview(output, options.expanded, theme);

		const label = summaryLabel(summary);
		const hint = options.expanded
			? ""
			: `${theme.fg("muted", " (")}${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		const head = new Text(theme.fg(label.tone, label.text) + hint, 0, 0);
		if (!options.expanded) return head;

		const container = new Container();
		container.addChild(head);
		container.addChild(renderOutputPreview(output, true, theme));
		return container;
	},
};
