import { Type } from "typebox";
import { request, claim, notify, deniedText, notesText } from "./client.mjs";

export default function (pi: any) {
  pi.registerTool({
    name: "question",
    label: "Ask parent user",
    description: "Ask the user through the parent CLI and wait for the real answer. Never guess.",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }))),
    }),
    async execute(_id: string, input: any) {
      const result = await request({ ...input, kind: "question" });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
  pi.on("tool_call", async (event: any) => {
    if (event.toolName === "question") return;
    if (["edit", "write"].includes(event.toolName) && event.input?.path) {
      const result = await claim([event.input.path]);
      if (result.denied?.length > 0) return { block: true, reason: deniedText(result.denied) };
    }
    if (process.env.DELEGATE_PERMISSION_MODE !== "approval-required") return;
    if (!["bash", "edit", "write"].includes(event.toolName)) return;
    try {
      const result: any = await request({ kind: "permission", question: "Allow this child tool call once?", tool: event.toolName, input: event.input });
      if (result.approved !== true) return { block: true, reason: "The user denied this operation. Do not work around the denial." };
    } catch { return { block: true, reason: "No parent approval is available." }; }
  });
  pi.on("tool_result", async (event: any) => {
    if (event.toolName !== "read" || !event.input?.path) return;
    const notes = (await notify([event.input.path])).notes || [];
    if (notes.length === 0) return;
    return { content: [...(event.content ?? []), { type: "text", text: notesText(notes) }] };
  });
}
