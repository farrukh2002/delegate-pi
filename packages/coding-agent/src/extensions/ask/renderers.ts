import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { AskUserDetails } from "./index.ts";

export const askRenderers: Pick<ToolDefinition<any, AskUserDetails>, "renderResult"> = {
	renderResult(result, _options, theme) {
		const details = result.details;
		if (!details.asked) return new Text(theme.fg("warning", "No user available to answer"), 0, 0);
		if (details.dismissed) return new Text(theme.fg("warning", "Question dismissed"), 0, 0);
		return new Text(
			`${theme.fg("success", "Answered")}${theme.fg("muted", " · ")}${theme.fg("toolOutput", details.answer ?? "")}`,
			0,
			0,
		);
	},
};
