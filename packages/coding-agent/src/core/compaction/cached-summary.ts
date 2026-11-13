import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	contentText,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "../messages.ts";
import { getSummarizationFailure, SUMMARIZATION_PROMPT } from "./compaction.ts";

export interface SessionRequest {
	model: Model<any>;
	context: Context;
	options: ModelsSimpleStreamOptions;
	messages: AgentMessage[];
}

export type SummaryStream = (
	model: Model<any>,
	context: Context,
	options: ModelsSimpleStreamOptions,
) => { result(): Promise<AssistantMessage> };

export const CACHED_SUMMARY_PROMPT = `${SUMMARIZATION_PROMPT}

If the conversation starts with an earlier summary, keep all of its information that still applies. The newest messages can stay verbatim after your summary, so cover them briefly. Answer with the summary text only. Do not call tools.`;

export function requestTail(request: SessionRequest, current: AgentMessage[]): AgentMessage[] | undefined {
	if (current.length < request.messages.length) return undefined;
	for (let i = 0; i < request.messages.length; i++) {
		if (current[i] !== request.messages[i]) return undefined;
	}
	return current.slice(request.messages.length);
}

export async function summarizeFromRequest(
	request: SessionRequest,
	tail: AgentMessage[],
	stream: SummaryStream,
	signal?: AbortSignal,
	customInstructions?: string,
): Promise<{ text: string; usage: Usage }> {
	const prompt = customInstructions
		? `${CACHED_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`
		: CACHED_SUMMARY_PROMPT;
	const base = normalizeContext(request.context);
	const context: Context = {
		messages: [
			...base.messages,
			...convertToLlm(tail),
			{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
		],
	};
	const response = await stream(request.model, context, { ...request.options, signal }).result();
	const failure = getSummarizationFailure(response, "Cached summarization");
	if (failure) throw new Error(failure);
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Cached summarization attempted to call a tool");
	}
	const text = contentText(response.content).trim();
	if (!text) throw new Error("Cached summarization returned no text");
	return { text, usage: response.usage };
}
