use crate::{Event, Part};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const MAX_RESULT_BYTES: usize = 200_000;

#[derive(Eq, Hash, PartialEq)]
enum ResultKey {
    Id(String),
    Content([u8; 32]),
}

pub(crate) struct TraceWriter {
    file: Option<File>,
    next_id: usize,
    tools: HashSet<String>,
    results: HashSet<ResultKey>,
}

impl TraceWriter {
    pub(crate) fn open(path: &Path, task: &str) -> Option<Self> {
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let mut trace = Self {
            file: Some(file),
            next_id: 0,
            tools: HashSet::new(),
            results: HashSet::new(),
        };
        if !task.trim().is_empty() {
            trace.write(json!({"type": "user", "message": {"role": "user", "content": task}}));
        }
        trace.file.is_some().then_some(trace)
    }

    pub(crate) fn event(&mut self, event: &Event, fallback_model: Option<&str>) {
        if self.file.is_none() {
            return;
        }
        match event {
            Event::Message {
                id,
                assistant: true,
                content,
                usage,
                model,
                ..
            } => {
                let mut parts = Vec::new();
                for part in content {
                    match part {
                        Part::Text(text) if !text.trim().is_empty() => {
                            parts.push(json!({"type": "text", "text": text}));
                        }
                        Part::Tool {
                            id,
                            name,
                            arguments,
                        } => {
                            if id.as_ref().is_some_and(|id| !self.tools.insert(id.clone())) {
                                continue;
                            }
                            let label = id.clone().unwrap_or_else(|| self.id("toolu_"));
                            parts.push(json!({"type": "tool_use", "id": label, "name": name, "input": arguments}));
                        }
                        _ => {}
                    }
                }
                if parts.is_empty() && usage.is_none() {
                    return;
                }
                let id = id.clone().unwrap_or_else(|| self.id("assistant-"));
                let mut message = json!({"role": "assistant", "id": id, "content": parts});
                if let Some(model) = model.as_deref().or(fallback_model) {
                    message["model"] = json!(model);
                }
                if let Some(usage) = usage {
                    message["usage"] = json!({
                        "input_tokens": usage.input,
                        "output_tokens": usage.output,
                        "cache_read_input_tokens": usage.cache_read,
                        "cache_creation_input_tokens": usage.cache_write,
                    });
                }
                self.write(json!({"type": "assistant", "message": message}));
            }
            Event::Message {
                assistant: false,
                content,
                ..
            } => {
                let text = content
                    .iter()
                    .filter_map(|part| match part {
                        Part::Text(text) => Some(text.as_str()),
                        Part::Tool { .. } => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    self.write(
                        json!({"type": "user", "message": {"role": "user", "content": text}}),
                    );
                }
            }
            Event::ToolResult {
                id,
                name,
                content,
                is_error,
                ..
            } => {
                let key = if let Some(id) = id {
                    ResultKey::Id(id.clone())
                } else {
                    let mut hash = Sha256::new();
                    hash.update(name.as_bytes());
                    hash.update([0]);
                    hash.update(content.as_bytes());
                    ResultKey::Content(hash.finalize().into())
                };
                if !self.results.insert(key) {
                    return;
                }
                let start =
                    content.ceil_char_boundary(content.len().saturating_sub(MAX_RESULT_BYTES));
                let mut result = json!({
                    "type": "tool_result", "tool_use_id": id.as_deref().unwrap_or(""), "content": &content[start..],
                });
                if *is_error {
                    result["is_error"] = json!(true);
                }
                self.write(
                    json!({"type": "user", "message": {"role": "user", "content": [result]}}),
                );
            }
            Event::Cost(_) | Event::Info(_) => {}
        }
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{}", self.next_id)
    }

    fn write(&mut self, value: Value) {
        if let Some(file) = self.file.as_mut() {
            let mut line = value.to_string();
            line.push('\n');
            if file.write_all(line.as_bytes()).is_err() {
                self.file = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn bounds_utf8_results_and_deduplicates_results_without_ids() {
        let path = std::env::temp_dir().join(format!("delegate-trace-{}", crate::uuid_v4()));
        let mut trace = TraceWriter::open(&path, "").unwrap();
        let event = Event::ToolResult {
            id: None,
            name: "fixture".to_string(),
            content: format!("{}end", "日".repeat(MAX_RESULT_BYTES)),
            is_error: false,
            activity: None,
        };
        trace.event(&event, None);
        trace.event(&event, None);
        drop(trace);
        let raw = fs::read_to_string(&path).unwrap();
        fs::remove_file(path).unwrap();
        let mut lines = raw.lines();
        let line: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert!(lines.next().is_none());
        let result = line["message"]["content"][0]["content"].as_str().unwrap();
        assert!(result.len() <= MAX_RESULT_BYTES);
        assert!(result.starts_with('日') && result.ends_with("end"));
    }

    #[test]
    fn does_not_open_nonregular_trace_files() {
        assert!(TraceWriter::open(Path::new("/dev/full"), "task").is_none());
    }
}
