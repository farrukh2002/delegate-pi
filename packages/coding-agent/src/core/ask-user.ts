import type { ExtensionUIContext, ExtensionUIDialogOptions } from "./extensions/types.ts";

export async function askUserQuestion(
	ui: Pick<ExtensionUIContext, "select" | "input">,
	question: string,
	options?: string[],
	placeholder?: string,
	dialogOptions: ExtensionUIDialogOptions = {},
): Promise<string | undefined> {
	if (dialogOptions.signal?.aborted) return undefined;
	if (!options?.length) return ui.input(question, placeholder, dialogOptions);

	const timeout = dialogOptions.timeout;
	const deadline = timeout && timeout > 0 ? Date.now() + timeout : undefined;
	let customOption = "Other — type your answer";
	while (options.includes(customOption)) customOption += " (custom)";
	const answer = await ui.select(question, [...options, customOption], dialogOptions);
	if (dialogOptions.signal?.aborted) return undefined;
	if (answer !== customOption) return answer;

	const remaining = deadline === undefined ? undefined : deadline - Date.now();
	if (remaining !== undefined && remaining <= 0) return undefined;
	return ui.input(question, placeholder ?? "Your answer", { ...dialogOptions, timeout: remaining });
}
