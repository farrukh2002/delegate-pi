import { request, claim, notify, deniedText, notesText } from "./client.mjs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const event = JSON.parse(raw);
const tool = event.tool_name;
let decision = "allow";
let reason = "Allowed inside the fixed filesystem sandbox.";
let context = "";
const target = event.tool_input?.file_path || event.tool_input?.notebook_path;
try {
  let denied = [];
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) && target) denied = (await claim([target])).denied || [];
  if (["Task", "Agent"].includes(tool)) {
    decision = "deny";
    reason = "Nested delegation is disabled.";
  } else if (denied.length > 0) {
    decision = "deny";
    reason = deniedText(denied);
  } else if (tool === "AskUserQuestion") {
    const answers = [];
    for (const item of event.tool_input.questions || []) {
      const response = await request({ kind: "question", question: item.question, options: item.options, multiSelect: item.multiSelect });
      answers.push({ question: item.question, answer: response.answer });
    }
    decision = "deny";
    reason = "The parent user answered these questions. Use these answers; do not ask them again: " + JSON.stringify(answers);
  } else if (process.env.DELEGATE_PERMISSION_MODE === "approval-required" && !["Read", "Glob", "Grep", "LS", "TodoWrite", "ToolSearch"].includes(tool)) {
    const response = await request({ kind: "permission", question: "Allow this child tool call once?", tool, input: event.tool_input });
    if (response.approved !== true) {
      decision = "deny";
      reason = "The user denied this operation. Do not work around the denial.";
    }
  }
  if (decision === "allow" && tool === "Read" && target) context = notesText((await notify([target])).notes || []);
} catch {
  decision = "deny";
  reason = "No parent answer is available. Stop and report blocked.";
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason, ...(context && { additionalContext: context }) } }));
