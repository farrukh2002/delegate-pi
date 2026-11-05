import { request, claim, notify, deniedText, notesText } from "/delegate/client.mjs";

export default function (cmd: any) {
  cmd.addTool({
    schema: {
      name: "delegate_question",
      description: "Ask the user in the parent CLI and wait for their answer. Use this instead of local question dialogs.",
      input_schema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } } }, required: ["question"] },
    },
    readOnly: true,
    run: async ({ input }: any) => {
      const result = await request({ ...input, kind: "question" });
      return { ok: true, content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  cmd.hooks({
    beforeToolCall: async ({ toolName, input }: any) => {
      if (["agent", "agent_output", "task", "delegate"].includes(toolName)) return { block: true, additionalContext: "Nested delegation is disabled." };
      if (toolName === "delegate_question") return;
      if (/^(ask_user|ask_user_question|question)$/.test(toolName)) {
        const items = Array.isArray(input.questions) && input.questions.length > 0
          ? input.questions
          : [{ question: input.question, options: input.options, multiSelect: input.multiSelect }];
        const answers = [];
        for (const item of items) {
          const text = typeof item.question === "string" && item.question.trim() ? item.question : JSON.stringify(item);
          const result = await request({ kind: "question", question: text, options: item.options, multiSelect: item.multiSelect === true });
          answers.push(`Q: ${text}\nA: ${result.answer}`);
        }
        return { result: { ok: true, content: [{ type: "text", text: answers.join("\n\n") }] } };
      }
      const info = cmd.getToolInfo().find((t: any) => t.name === toolName);
      const readOnly = info?.readOnly === true;
      const target = input?.path || input?.file_path || input?.filePath;
      if (typeof target === "string" && target) {
        if (readOnly) {
          const notes = (await notify([target])).notes || [];
          if (notes.length > 0) return { additionalContext: notesText(notes) };
        } else {
          const denied = (await claim([target])).denied || [];
          if (denied.length > 0) return { block: true, additionalContext: deniedText(denied) };
        }
      }
      if (process.env.DELEGATE_PERMISSION_MODE !== "approval-required") return;
      if (readOnly) return;
      try {
        const result: any = await request({ kind: "permission", question: "Allow this child tool call once?", tool: toolName, input });
        if (result.approved !== true) return { block: true, additionalContext: "The user denied this operation. Do not work around the denial." };
      } catch { return { block: true, additionalContext: "No parent approval is available." }; }
    },
    appendSystemPrompt: () => "Use delegate_question for user decisions. It waits for the parent user. Never guess an answer.",
  });
}
