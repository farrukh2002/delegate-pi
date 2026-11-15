use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

const QUESTION_TIMEOUT: Duration = Duration::from_secs(86_400);
const SMALL_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE: usize = 65_536;
const ALLOWED_REASON: &str = "Allowed inside the fixed filesystem sandbox.";
const READ_ONLY_TOOLS: [&str; 6] = ["Read", "Glob", "Grep", "LS", "TodoWrite", "ToolSearch"];

#[derive(Deserialize)]
struct Event {
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    tool_input: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionOutput {
    hook_event_name: String,
    permission_decision: String,
    permission_decision_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    additional_context: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookOutput {
    hook_specific_output: PermissionOutput,
}

#[derive(Serialize)]
struct Answer {
    question: Value,
    answer: Value,
}

struct Decision {
    decision: &'static str,
    reason: String,
    context: Option<String>,
}

impl Decision {
    fn allow() -> Decision {
        Decision {
            decision: "allow",
            reason: ALLOWED_REASON.to_string(),
            context: None,
        }
    }

    fn deny(reason: impl Into<String>) -> Decision {
        Decision {
            decision: "deny",
            reason: reason.into(),
            context: None,
        }
    }
}

fn socket_path() -> String {
    std::env::var("DELEGATE_SOCKET").unwrap_or_else(|_| "/delegate-ipc/control.sock".to_string())
}

fn request(input: &Value, timeout: Duration) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket_path()).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let mut payload = serde_json::to_vec(input).map_err(|error| error.to_string())?;
    payload.push(b'\n');
    stream.write_all(&payload).map_err(|error| error.to_string())?;

    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                if buffer.len() > MAX_RESPONSE {
                    return Err("Response is too large".to_string());
                }
                if let Some(position) = buffer.iter().position(|&byte| byte == b'\n') {
                    let line = &buffer[..position];
                    return serde_json::from_slice(line).map_err(|error| error.to_string());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Parent channel closed without an answer".to_string())
}

fn claim(paths: &[Value]) -> Value {
    match request(&json!({ "kind": "claim", "paths": paths }), SMALL_TIMEOUT) {
        Ok(value) => value,
        Err(_) => json!({ "denied": [] }),
    }
}

fn notify(paths: &[Value]) -> Value {
    match request(&json!({ "kind": "notify", "paths": paths }), SMALL_TIMEOUT) {
        Ok(value) => value,
        Err(_) => json!({ "notes": [] }),
    }
}

fn denied_items(value: &Value) -> Vec<Value> {
    value
        .get("denied")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn note_items(value: &Value) -> Vec<Value> {
    value
        .get("notes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn text_field(item: &Value, key: &str) -> String {
    item.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn denied_text(denied: &[Value]) -> String {
    let first = &denied[0];
    format!(
        "File {} is being changed by task {} ({}). Do not change it and do not retry. Finish the other parts and list it under BLOCKED FILES in your final report.",
        text_field(first, "path"),
        text_field(first, "taskId"),
        text_field(first, "agent")
    )
}

fn notes_text(notes: &[Value]) -> String {
    notes
        .iter()
        .map(|item| {
            format!(
                "Note: task {} ({}) is changing {}. Its content can change.",
                text_field(item, "taskId"),
                text_field(item, "agent"),
                text_field(item, "path")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn evaluate(event: &Event, approval_required: bool) -> Decision {
    let tool = event.tool_name.as_str();
    let target = event
        .tool_input
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| event.tool_input.get("notebook_path").and_then(Value::as_str));
    let target_value = target.map(|value| Value::String(value.to_string()));
    let mut decision = Decision::allow();

    let mut denied: Vec<Value> = Vec::new();
    if matches!(tool, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
        if let Some(target) = &target_value {
            denied = denied_items(&claim(std::slice::from_ref(target)));
        }
    }

    if matches!(tool, "Task" | "Agent") {
        decision = Decision::deny("Nested delegation is disabled.");
    } else if !denied.is_empty() {
        decision = Decision::deny(denied_text(&denied));
    } else if tool == "AskUserQuestion" {
        let questions = event
            .tool_input
            .get("questions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut answers = Vec::new();
        for item in questions {
            let mut payload = json!({
                "kind": "question",
                "question": item.get("question").cloned().unwrap_or(Value::Null),
            });
            if let Some(options) = item.get("options") {
                payload["options"] = options.clone();
            }
            if let Some(multi) = item.get("multiSelect") {
                payload["multiSelect"] = multi.clone();
            }
            match request(&payload, QUESTION_TIMEOUT) {
                Ok(response) => answers.push(Answer {
                    question: item.get("question").cloned().unwrap_or(Value::Null),
                    answer: response.get("answer").cloned().unwrap_or(Value::Null),
                }),
                Err(error) => return Decision::deny(error),
            }
        }
        let answers = serde_json::to_string(&answers).unwrap_or_else(|_| "[]".to_string());
        decision = Decision::deny(format!(
            "The parent user answered these questions. Use these answers; do not ask them again: {answers}"
        ));
    } else if approval_required && !READ_ONLY_TOOLS.contains(&tool) {
        let payload = json!({
            "kind": "permission",
            "question": "Allow this child tool call once?",
            "tool": tool,
            "input": event.tool_input,
        });
        match request(&payload, QUESTION_TIMEOUT) {
            Ok(response) => {
                if response.get("approved").and_then(Value::as_bool) != Some(true) {
                    decision = Decision::deny("The user denied this operation. Do not work around the denial.");
                }
            }
            Err(_) => {
                decision = Decision::deny("No parent approval is available.");
            }
        }
    }

    if decision.decision == "allow" && tool == "Read" {
        if let Some(target) = &target_value {
            let notes = note_items(&notify(std::slice::from_ref(target)));
            if !notes.is_empty() {
                decision.context = Some(notes_text(&notes));
            }
        }
    }
    decision
}

fn emit(decision: Decision) {
    let output = HookOutput {
        hook_specific_output: PermissionOutput {
            hook_event_name: "PreToolUse".to_string(),
            permission_decision: decision.decision.to_string(),
            permission_decision_reason: decision.reason,
            additional_context: decision.context,
        },
    };
    let mut stdout = std::io::stdout();
    if let Ok(text) = serde_json::to_vec(&output) {
        let _ = stdout.write_all(&text);
    }
}

fn main() {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        emit(Decision::deny(
            "No parent answer is available. Stop and report blocked.",
        ));
        return;
    }
    let event: Event = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            emit(Decision::deny(format!(
                "The delegate hook could not read the tool event: {error}"
            )));
            return;
        }
    };
    let approval_required = std::env::var("DELEGATE_PERMISSION_MODE").as_deref() == Ok("approval-required");
    let decision = std::panic::catch_unwind(|| evaluate(&event, approval_required)).unwrap_or_else(|_| {
        Decision::deny("No parent answer is available. Stop and report blocked.")
    });
    emit(decision);
}
