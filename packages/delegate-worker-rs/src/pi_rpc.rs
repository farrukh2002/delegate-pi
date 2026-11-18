use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::ChildStdin;
use std::sync::mpsc::{self, Sender};
use std::thread;

pub(crate) struct PiRpc {
    input: Option<Sender<Value>>,
    prompt_accepted: bool,
    pending_steer: Option<(String, String)>,
    guard_steers: HashMap<String, String>,
    sequence: u64,
}

impl PiRpc {
    pub(crate) fn start(mut stdin: ChildStdin, prompt: String) -> Self {
        let (input, frames) = mpsc::channel::<Value>();
        let _ = input.send(json!({"id": "start", "type": "prompt", "message": prompt}));
        thread::spawn(move || {
            for frame in frames {
                if writeln!(stdin, "{frame}").is_err() {
                    break;
                }
            }
        });
        Self {
            input: Some(input),
            prompt_accepted: false,
            pending_steer: None,
            guard_steers: HashMap::new(),
            sequence: 0,
        }
    }

    pub(crate) fn send_pending(&mut self, dir: &Path, state: &mut Value) {
        if self.input.is_none() || !self.prompt_accepted || self.pending_steer.is_some() {
            return;
        }
        let file = dir.join("steer.json");
        let text = match fs::read_to_string(&file) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => {
                state["steerError"] = json!("Could not read the steering request.");
                return;
            }
        };
        let request = serde_json::from_str::<Value>(&text).ok();
        let Some(message) = request
            .as_ref()
            .and_then(|value| value["message"].as_str())
            .map(str::trim)
            .filter(|message| !message.is_empty() && message.encode_utf16().count() <= 8000)
        else {
            let _ = fs::remove_file(file);
            state["steerError"] = json!("Invalid steering request.");
            return;
        };
        if let Some(id) = self.send_steer(message) {
            self.pending_steer = Some((id, message.chars().take(180).collect()));
        } else {
            self.close(dir, state);
        }
    }

    pub(crate) fn send_guard(&mut self, message: &str) {
        if let Some(id) = self.send_steer(message) {
            self.guard_steers
                .insert(id, message.chars().take(180).collect());
        }
    }

    fn send_steer(&mut self, message: &str) -> Option<String> {
        let input = self.input.as_ref()?;
        if !self.prompt_accepted {
            return None;
        }
        self.sequence += 1;
        let id = format!("steer-{}", self.sequence);
        input
            .send(json!({"id": id, "type": "steer", "message": message}))
            .ok()?;
        Some(id)
    }

    pub(crate) fn receive(
        &mut self,
        frame: &Value,
        dir: &Path,
        state: &mut Value,
    ) -> Option<Result<String, String>> {
        self.input.as_ref()?;
        match frame["type"].as_str() {
            Some("response") => match frame["command"].as_str() {
                Some("prompt") if !self.prompt_accepted && frame["id"] == "start" => {
                    if frame["success"] == true {
                        self.prompt_accepted = true;
                    } else {
                        self.close(dir, state);
                        return Some(Err(frame["error"]
                            .as_str()
                            .unwrap_or("Pi rejected the prompt.")
                            .to_string()));
                    }
                }
                Some("steer") => {
                    let id = frame["id"].as_str()?;
                    let succeeded = frame["success"] == true;
                    let preview = if self
                        .pending_steer
                        .as_ref()
                        .is_some_and(|(pending, _)| pending == id)
                    {
                        let (_, preview) = self.pending_steer.take().unwrap();
                        state["steerError"] = if succeeded {
                            Value::Null
                        } else {
                            json!("Pi rejected the steering request.")
                        };
                        let _ = fs::remove_file(dir.join("steer.json"));
                        preview
                    } else {
                        self.guard_steers.remove(id)?
                    };
                    if succeeded {
                        state["steers"] = json!(state["steers"].as_u64().unwrap_or(0) + 1);
                        return Some(Ok(format!("steer: {preview}")));
                    }
                }
                _ => {}
            },
            Some("agent_settled") if self.prompt_accepted => self.close(dir, state),
            _ => {}
        }
        None
    }

    pub(crate) fn close(&mut self, dir: &Path, state: &mut Value) {
        self.input.take();
        self.guard_steers.clear();
        if self.pending_steer.take().is_some() || dir.join("steer.json").exists() {
            let _ = fs::remove_file(dir.join("steer.json"));
            state["steerError"] = json!("Pi stopped before acknowledging the steering request.");
        }
    }
}
