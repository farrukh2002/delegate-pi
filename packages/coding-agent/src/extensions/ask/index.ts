import { type Static, Type } from "typebox";
import { askUserQuestion } from "../../core/ask-user.ts";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../core/extensions/types.ts";

export const ASK_USER_TOOL_NAME = "ask_user";

const NO_USER_TEXT =
	"No interactive user is attached to this session. Do not call ask_user again. For safe choices, choose the best option and state the assumption. If approval is required, stop and report that approval is unavailable.";
const DISMISSED_TEXT =
	"The user dismissed the question. For safe choices, use your best judgment and state the assumption. This is not approval; do not perform an action that requires the user's confirmation.";

const askUserSchema = Type.Object({
	question: Type.String({ description: "The question to show the user. One clear sentence." }),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "Suggested choices. The UI adds an Other option for a typed answer. Omit for a free-text answer.",
		}),
	),
	placeholder: Type.Optional(Type.String({ description: "Hint shown in the empty input field." })),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Dismiss the question after this many milliseconds. Default: wait." }),
	),
});

export type AskUserInput = Static<typeof askUserSchema>;

export interface AskUserDetails {
	asked: boolean;
	answer?: string;
	dismissed?: boolean;
}

const ASK_USER_DESCRIPTION = `Ask the user a question and wait for the answer. Use ask_user instead of asking in a normal chat reply when you need the user's answer to proceed.

Use this tool when:
- The requirement is unclear and the answer changes what you build.
- Two valid approaches exist and the user's preference matters.
- An action is destructive or hard to undo and you need confirmation.
- A credential, name, or value only the user knows is required.

Do not use this tool for things you can learn from the codebase, the docs, or a test run.
Ask one question per call and ask the most important question first.
With options given, the user can pick one or select Other to type an answer. Do not add an Other option yourself; the UI adds it. Without options, the user types an answer.
Do not treat a dismissed question as permission for a destructive action.`;

export function createAskUserToolDefinition(): ToolDefinition<typeof askUserSchema, AskUserDetails> {
	return {
		name: ASK_USER_TOOL_NAME,
		label: ASK_USER_TOOL_NAME,
		description: ASK_USER_DESCRIPTION,
		promptSnippet: "Ask the user a question and wait for the answer",
		promptGuidelines: [
			"When you need the user's answer to proceed, use ask_user instead of asking in a normal chat reply. Wait for the tool result before continuing.",
			"When a decision materially changes the result and you cannot infer the user's intent, ask with ask_user instead of guessing. Do not ask for information you can obtain from the codebase, docs, or tests.",
			"Use ask_user for confirmation before destructive or hard-to-undo actions. A dismissed question is not approval.",
		],
		parameters: askUserSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx?.hasUI) {
				return { content: [{ type: "text", text: NO_USER_TEXT }], details: { asked: false } };
			}
			const dialogOptions = {
				signal,
				timeout: params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : undefined,
			};
			const answer = await askUserQuestion(
				ctx.ui,
				params.question,
				params.options,
				params.placeholder,
				dialogOptions,
			);
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled." }], details: { asked: true, dismissed: true } };
			}
			const text = answer?.trim() ?? "";
			if (text === "") {
				return { content: [{ type: "text", text: DISMISSED_TEXT }], details: { asked: true, dismissed: true } };
			}
			return {
				content: [{ type: "text", text: `The user answered: ${text}` }],
				details: { asked: true, answer: text },
			};
		},
	};
}

export function createAskExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		if (process.env.DELEGATE_DATA || process.env.DELEGATE_PI_ENTRY) return;
		pi.registerTool(createAskUserToolDefinition());
	};
}

export default createAskExtension();
