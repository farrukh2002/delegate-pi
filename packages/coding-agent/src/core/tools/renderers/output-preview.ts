import { type Component, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../../modes/interactive/components/visual-truncate.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";

const PREVIEW_LINES = 10;

export function renderOutputPreview(output: string, expanded: boolean, theme: Theme): Component {
	const text = output
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	if (expanded) {
		return new Text(text, 0, 0);
	}
	return new VisualLinePreview({
		text,
		maxVisualLines: PREVIEW_LINES,
		keep: "start",
		formatHint: (hidden) =>
			`${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
	});
}
