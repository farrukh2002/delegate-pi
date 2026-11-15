use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LOG_CAP: usize = 2 * 1024 * 1024;
const HEARTBEAT_MS: i64 = 5000;
const ACTIVITY: usize = 5;
const LINE_CAP: usize = 4 * 1024 * 1024;
const OUTPUT_CAP: usize = 8000;
const TEXT_CAP: usize = 4000;

static SIGNALLED: AtomicBool = AtomicBool::new(false);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

extern "C" fn on_signal(_: libc::c_int) {
	SIGNALLED.store(true, Ordering::SeqCst);
}

fn now_ms() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|value| value.as_millis() as i64)
		.unwrap_or(0)
}

fn home_dir() -> PathBuf {
	PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/root".to_string()))
}

fn data_dir() -> PathBuf {
	if let Ok(value) = std::env::var("DELEGATE_DATA") {
		if !value.is_empty() {
			return PathBuf::from(value);
		}
	}
	let state = match std::env::var("XDG_STATE_HOME") {
		Ok(value) if value.starts_with('/') => value,
		_ => format!("{}/.local/state", home_dir().display()),
	};
	PathBuf::from(format!("{state}/delegate"))
}

fn valid_id(id: &str) -> bool {
	id.len() == 36 && id.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

fn read_json(file: &Path) -> Result<Value, String> {
	let text = fs::read_to_string(file).map_err(|error| format!("{}: {error}", file.display()))?;
	serde_json::from_str(&text).map_err(|error| format!("{}: {error}", file.display()))
}

fn write_private(file: &Path, data: &[u8], mode: u32) -> std::io::Result<()> {
	let mut options = OpenOptions::new();
	options.write(true).create_new(true).mode(mode);
	let mut handle = options.open(file)?;
	handle.write_all(data)?;
	Ok(())
}

fn write_atomic(file: &Path, text: &str) -> std::io::Result<()> {
	let temp = format!(
		"{}.{}.{}.tmp",
		file.display(),
		std::process::id(),
		TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
	);
	let temp = PathBuf::from(temp);
	write_private(&temp, text.as_bytes(), 0o600)?;
	fs::rename(&temp, file)
}

fn real_path(value: &Path) -> Option<PathBuf> {
	fs::canonicalize(value).ok()
}

fn under(child: &Path, parent: &Path) -> bool {
	child == parent || child.starts_with(parent)
}

fn tail(text: &str, cap: usize) -> String {
	let chars: Vec<char> = text.chars().collect();
	if chars.len() <= cap {
		return text.to_string();
	}
	chars[chars.len() - cap..].iter().collect()
}

fn compact_log_line(line: &str) -> Option<String> {
	if line.is_empty() {
		return None;
	}
	if line.contains("\"message_update\"") || line.contains("\"thinking_delta\"") {
		return None;
	}
	if line.len() <= 4096 {
		return Some(line.to_string());
	}
	Some(format!("{}...[{} bytes]...{}", &line[..2048], line.len(), &line[line.len() - 2048..]))
}

struct Inner {
	dir: PathBuf,
	state: Value,
	last: String,
	output: String,
	errors: String,
	activity: Vec<String>,
	seen: HashMap<String, Value>,
	stop: Option<String>,
	child: Option<u32>,
	log_partial: String,
	parse_buffer: String,
	log_bytes: usize,
	log_fd: Option<File>,
	active_ms: i64,
	last_output: i64,
	last_tick: i64,
	started_at: i64,
	stopped_at: Option<i64>,
	denied: bool,
	provider_error: bool,
	open_questions: HashSet<String>,
}

impl Inner {
	fn save(&mut self) {
		let text = self.state.to_string();
		if text == self.last {
			return;
		}
		self.last = text.clone();
		let _ = write_atomic(&self.dir.join("state.json"), &text);
	}

	fn beat(&mut self, now: i64) {
		let heartbeat = self.state["heartbeat"].as_i64().unwrap_or(0);
		if now - heartbeat >= HEARTBEAT_MS {
			self.state["heartbeat"] = json!(now);
		}
	}

	fn stop(&mut self, reason: &str) {
		if self.stop.is_some() {
			return;
		}
		self.stop = Some(reason.to_string());
		if let Some(pid) = self.child {
			unsafe {
				libc::kill(-(pid as i32), libc::SIGTERM);
			}
		}
	}

	fn log(&mut self, text: &str) {
		self.log_partial.push_str(text);
		if !self.log_partial.contains('\n') {
			return;
		}
		let mut lines: Vec<String> = self.log_partial.split('\n').map(|line| line.to_string()).collect();
		self.log_partial = lines.pop().unwrap_or_default();
		for line in lines {
			if let Some(line) = compact_log_line(&line) {
				if self.log_bytes + line.len() + 1 > LOG_CAP {
					self.rotate_log();
				}
				if let Some(handle) = self.log_fd.as_mut() {
					let _ = writeln!(handle, "{line}");
					self.log_bytes += line.len() + 1;
				}
			}
		}
	}

	fn rotate_log(&mut self) {
		self.log_fd = None;
		let file = self.dir.join("output.log");
		let _ = fs::remove_file(self.dir.join("output.log.1"));
		let _ = fs::rename(&file, self.dir.join("output.log.1"));
		self.log_bytes = 0;
		self.open_log();
		if let Some(handle) = self.log_fd.as_mut() {
			let _ = writeln!(handle, "[delegate] log rotated; the earlier part is in output.log.1");
		}
		let rotations = self.state["logRotated"].as_i64().unwrap_or(0);
		self.state["logRotated"] = json!(rotations + 1);
	}

	fn open_log(&mut self) {
		let file = self.dir.join("output.log");
		let opened = OpenOptions::new().create(true).append(true).mode(0o600).open(file);
		if let Ok(handle) = opened {
			let bytes = handle.metadata().map(|meta| meta.len() as usize).unwrap_or(0);
			self.log_bytes = bytes;
			self.log_fd = Some(handle);
		}
	}

	fn push_error(&mut self, text: &str) {
		let mut next = self.errors.clone();
		next.push_str(text);
		self.errors = tail(&next, TEXT_CAP);
	}

	fn push_activity(&mut self, line: String) {
		if self.activity.last() == Some(&line) {
			return;
		}
		self.activity.push(line);
		if self.activity.len() > ACTIVITY {
			let extra = self.activity.len() - ACTIVITY;
			self.activity.drain(0..extra);
		}
		self.state["activity"] = json!(self.activity);
	}

	fn usage(&mut self, key: &str) -> f64 {
		self.state["usage"][key].as_f64().unwrap_or(0.0)
	}

	fn set_usage(&mut self, key: &str, value: f64) {
		self.state["usage"][key] = json!(value);
	}
}

type Shared = Arc<Mutex<Inner>>;

enum Part {
	Text(String),
	Tool { name: String, arguments: Value },
}

struct Delta {
	input: f64,
	output: f64,
	cache_read: f64,
	cache_write: f64,
	cost: f64,
	context: f64,
}

enum Event {
	Message {
		id: Option<String>,
		assistant: bool,
		content: Vec<Part>,
		usage: Option<Delta>,
		stop_reason: Option<String>,
		error_message: Option<String>,
	},
	Cost(f64),
	Info(String),
}

fn activity_line(part: &Part) -> Option<String> {
	match part {
		Part::Tool { name, arguments } => {
			let keys = ["path", "file_path", "filePath", "command", "cmd", "pattern", "query", "url"];
			let mut target: Option<String> = None;
			for key in keys {
				if let Some(value) = arguments[key].as_str() {
					if !value.trim().is_empty() {
						target = Some(value.to_string());
						break;
					}
				}
			}
			if target.is_none() {
				if let Some(map) = arguments.as_object() {
					for value in map.values() {
						if let Some(text) = value.as_str() {
							if !text.trim().is_empty() {
								target = Some(text.to_string());
								break;
							}
						}
					}
				}
			}
			let label = match target {
				Some(value) => format!("{name} {}", value.split_whitespace().collect::<Vec<_>>().join(" ")),
				None => name.clone(),
			};
			Some(label.chars().take(120).collect())
		}
		Part::Text(text) => {
			let line = text.lines().map(|line| line.trim()).find(|line| !line.is_empty())?;
			Some(line.chars().take(120).collect())
		}
	}
}

fn num_of(value: &Value) -> f64 {
	value.as_f64().unwrap_or(0.0)
}

fn str_of(value: &Value) -> Option<String> {
	value.as_str().filter(|text| !text.is_empty()).map(|text| text.to_string())
}

fn text_of(value: &Value) -> String {
	match value {
		Value::String(text) => text.clone(),
		Value::Array(items) => items
			.iter()
			.filter_map(|item| {
				if let Some(text) = item["text"].as_str() {
					Some(text.to_string())
				} else if let Some(text) = item["content"].as_str() {
					Some(text.to_string())
				} else {
					None
				}
			})
			.collect::<Vec<_>>()
			.join("\n"),
		Value::Object(map) => map
			.get("text")
			.and_then(|item| item.as_str())
			.map(|text| text.to_string())
			.unwrap_or_else(|| value.to_string()),
		_ => String::new(),
	}
}

fn message(id: Option<String>, content: Vec<Part>) -> Event {
	Event::Message {
		id,
		assistant: true,
		content,
		usage: None,
		stop_reason: None,
		error_message: None,
	}
}

fn parse_pi(raw: &Value) -> Vec<Event> {
	if raw["type"].as_str() != Some("message_end") {
		return Vec::new();
	}
	let msg = &raw["message"];
	let assistant = msg["role"].as_str() != Some("user");
	let mut content: Vec<Part> = Vec::new();
	if let Some(parts) = msg["content"].as_array() {
		for part in parts {
			match part["type"].as_str() {
				Some("text") => {
					if let Some(text) = part["text"].as_str() {
						content.push(Part::Text(text.to_string()));
					}
				}
				Some("toolCall") => content.push(Part::Tool {
					name: part["name"].as_str().unwrap_or("unknown").to_string(),
					arguments: part["arguments"].clone(),
				}),
				_ => {}
			}
		}
	}
	let usage = if msg["usage"].is_null() || !assistant {
		None
	} else {
		let source = &msg["usage"];
		Some(Delta {
			input: num_of(&source["input"]),
			output: num_of(&source["output"]),
			cache_read: num_of(&source["cacheRead"]),
			cache_write: num_of(&source["cacheWrite"]),
			cost: num_of(&source["cost"]["total"]),
			context: num_of(&source["totalTokens"]),
		})
	};
	vec![Event::Message {
		id: str_of(&msg["id"]).or_else(|| str_of(&msg["responseId"])),
		assistant,
		content,
		usage,
		stop_reason: str_of(&msg["stopReason"]),
		error_message: str_of(&msg["errorMessage"]),
	}]
}

fn parse_claude(raw: &Value) -> Vec<Event> {
	match raw["type"].as_str() {
		Some("assistant") => {
			let msg = &raw["message"];
			let mut content: Vec<Part> = Vec::new();
			if let Some(parts) = msg["content"].as_array() {
				for part in parts {
					match part["type"].as_str() {
						Some("text") => {
							if let Some(text) = part["text"].as_str() {
								content.push(Part::Text(text.to_string()));
							}
						}
						Some("tool_use") => content.push(Part::Tool {
							name: part["name"].as_str().unwrap_or("unknown").to_string(),
							arguments: part["input"].clone(),
						}),
						_ => {}
					}
				}
			}
			let usage = &msg["usage"];
			let input = num_of(&usage["input_tokens"]);
			let cached = num_of(&usage["cache_read_input_tokens"]);
			let created = num_of(&usage["cache_creation_input_tokens"]);
			vec![Event::Message {
				id: str_of(&msg["id"]),
				assistant: true,
				content,
				usage: Some(Delta {
					input,
					output: num_of(&usage["output_tokens"]),
					cache_read: cached,
					cache_write: created,
					cost: 0.0,
					context: input + cached + created,
				}),
				stop_reason: str_of(&msg["stop_reason"]),
				error_message: None,
			}]
		}
		Some("result") => {
			let mut events: Vec<Event> = Vec::new();
			let cost = num_of(&raw["total_cost_usd"]);
			if cost > 0.0 {
				events.push(Event::Cost(cost));
			}
			let subtype = raw["subtype"].as_str();
			if raw["is_error"].as_bool() == Some(true) || subtype.map(|value| value != "success").unwrap_or(false) {
				let text = str_of(&raw["result"])
					.or_else(|| str_of(&raw["error"]["message"]))
					.unwrap_or_else(|| format!("stopped: {}", subtype.unwrap_or("")));
				events.push(Event::Info(text));
			}
			events
		}
		_ => Vec::new(),
	}
}

fn parse_codex(raw: &Value) -> Vec<Event> {
	match raw["type"].as_str() {
		Some("item.completed") | Some("item.started") => {
			let item = &raw["item"];
			let item_type = item["type"].as_str().unwrap_or("item");
			if item_type == "agent_message" {
				if raw["type"].as_str() != Some("item.completed") {
					return Vec::new();
				}
				let text = item["text"].as_str().unwrap_or("");
				if text.is_empty() {
					return Vec::new();
				}
				return vec![message(None, vec![Part::Text(text.to_string())])];
			}
			if item_type == "reasoning" {
				return Vec::new();
			}
			let name = if item_type == "command_execution" { "bash".to_string() } else { item_type.to_string() };
			let arguments = if item_type == "command_execution" {
				json!({ "command": item["command"].as_str().unwrap_or("") })
			} else {
				item.clone()
			};
			vec![message(None, vec![Part::Tool { name, arguments }])]
		}
		Some("turn.completed") => {
			let usage = &raw["usage"];
			let input = num_of(&usage["input_tokens"]);
			let cached = num_of(&usage["cached_input_tokens"]);
			vec![Event::Message {
				id: None,
				assistant: true,
				content: Vec::new(),
				usage: Some(Delta {
					input: (input - cached).max(0.0),
					output: num_of(&usage["output_tokens"]),
					cache_read: cached,
					cache_write: num_of(&usage["cache_write_input_tokens"]),
					cost: 0.0,
					context: input,
				}),
				stop_reason: None,
				error_message: None,
			}]
		}
		Some("turn.failed") | Some("error") => {
			let text = str_of(&raw["error"]["message"])
				.or_else(|| str_of(&raw["message"]))
				.unwrap_or_else(|| "codex turn failed".to_string());
			vec![Event::Message {
				id: None,
				assistant: true,
				content: Vec::new(),
				usage: None,
				stop_reason: Some("error".to_string()),
				error_message: Some(text),
			}]
		}
		_ => Vec::new(),
	}
}

fn parse_commandcode(raw: &Value) -> Vec<Event> {
	match raw["type"].as_str() {
		Some("result") => {
			let text = raw["finalText"].as_str().unwrap_or("").to_string();
			let mut events: Vec<Event> = Vec::new();
			if !text.is_empty() {
				events.push(message(None, vec![Part::Text(text.clone())]));
			}
			let failed = raw["subtype"].as_str() == Some("error");
			events.push(Event::Message {
				id: None,
				assistant: true,
				content: Vec::new(),
				usage: None,
				stop_reason: if failed { Some("error".to_string()) } else { None },
				error_message: if failed {
					Some(if text.is_empty() { "commandcode error".to_string() } else { text })
				} else {
					None
				},
			});
			events
		}
		Some("event") => {
			let inner = &raw["event"];
			match inner["type"].as_str() {
				Some("run_end") => Vec::new(),
				Some("model_request_end") => {
					let usage = &inner["usage"];
					let cached = num_of(&usage["cacheReadTokens"]);
					let total = num_of(&usage["inputTokens"]);
					vec![Event::Message {
						id: None,
						assistant: true,
						content: Vec::new(),
						usage: Some(Delta {
							input: (total - cached).max(0.0),
							output: num_of(&usage["outputTokens"]),
							cache_read: cached,
							cache_write: num_of(&usage["cacheWriteTokens"]),
							cost: 0.0,
							context: total,
						}),
						stop_reason: None,
						error_message: None,
					}]
				}
				Some("message_end") => {
					let Some(parts) = inner["content"].as_array() else { return Vec::new() };
					let mut content: Vec<Part> = Vec::new();
					for part in parts {
						match part["type"].as_str() {
							Some("tool_use") => content.push(Part::Tool {
								name: part["name"].as_str().unwrap_or("tool").to_string(),
								arguments: part["input"].clone(),
							}),
							Some("text") => {
								if let Some(text) = part["text"].as_str() {
									content.push(Part::Text(text.to_string()));
								}
							}
							_ => {}
						}
					}
					if content.is_empty() {
						Vec::new()
					} else {
						vec![message(None, content)]
					}
				}
				Some("run_error") | Some("error") => {
					let text = str_of(&inner["error"]["message"]).unwrap_or_else(|| "commandcode run error".to_string());
					vec![Event::Message {
						id: None,
						assistant: true,
						content: Vec::new(),
						usage: None,
						stop_reason: Some("error".to_string()),
						error_message: Some(text),
					}]
				}
				Some("agent_message") | Some("assistant_message") => {
					let text = str_of(&inner["text"]).unwrap_or_else(|| text_of(&inner["content"]));
					if text.is_empty() {
						Vec::new()
					} else {
						vec![message(None, vec![Part::Text(text)])]
					}
				}
				_ => Vec::new(),
			}
		}
		_ => Vec::new(),
	}
}

fn parse_events(provider: &str, raw: &Value) -> Vec<Event> {
	match provider {
		"claude" => parse_claude(raw),
		"codex" => parse_codex(raw),
		"commandcode" => parse_commandcode(raw),
		_ => parse_pi(raw),
	}
}

fn apply_event(inner: &mut Inner, event: Event, provider: &str) {
	match event {
		Event::Cost(cost) => {
			inner.state["costUsd"] = json!(cost);
			inner.set_usage("cost", cost);
		}
		Event::Info(text) => inner.push_error(&text),
		Event::Message { id, assistant, content, usage, stop_reason, error_message } => {
			if error_message.is_some() || matches!(stop_reason.as_deref(), Some("error") | Some("aborted")) {
				inner.provider_error = true;
				inner.errors = error_message.or(stop_reason).unwrap_or_default();
			}
			if !assistant {
				return;
			}
			for part in &content {
				if let Some(line) = activity_line(part) {
					inner.push_activity(line);
				}
			}
			let text: Vec<String> = content
				.iter()
				.filter_map(|part| if let Part::Text(text) = part { Some(text.clone()) } else { None })
				.collect();
			let joined = text.join("\n");
			if !joined.trim().is_empty() {
				inner.output = tail(&joined, OUTPUT_CAP);
			}
			let Some(delta) = usage else { return };
			let current = json!({
				"input": delta.input,
				"output": delta.output,
				"cacheRead": delta.cache_read,
				"cacheWrite": delta.cache_write,
				"cost": delta.cost,
			});
			let previous = id.as_ref().and_then(|key| inner.seen.get(key)).cloned();
			for key in ["input", "output", "cacheRead", "cacheWrite", "cost"] {
				let before = previous
					.as_ref()
					.map(|value| value[key].as_f64().unwrap_or(0.0))
					.unwrap_or(0.0);
				let value = inner.usage(key) + current[key].as_f64().unwrap_or(0.0) - before;
				inner.set_usage(key, value);
			}
			if previous.is_none() && provider != "commandcode" {
				let turns = inner.usage("turns") + 1.0;
				inner.set_usage("turns", turns);
			}
			if let Some(key) = id {
				inner.seen.insert(key, current.clone());
			}
			if provider == "pi" {
				let cost = inner.usage("cost");
				inner.state["costUsd"] = json!(cost);
			}
			if delta.context > 0.0 {
				let stored = inner.usage("contextTokens");
				if delta.context > stored {
					inner.set_usage("contextTokens", delta.context);
				}
			}
		}
	}
}

fn parse_line(inner: &mut Inner, line: &str, provider: &str) {
	let raw: Value = match serde_json::from_str(line) {
		Ok(value) => value,
		Err(_) => {
			inner.push_error(line);
			return;
		}
	};
	if raw["type"].as_str() == Some("result") {
		if raw["permission_denials"].as_array().map(|items| !items.is_empty()).unwrap_or(false) {
			inner.denied = true;
		}
		if raw["is_error"].as_bool() == Some(true) {
			inner.provider_error = true;
		}
	}
	if provider == "commandcode" && raw["type"].as_str() == Some("event") && raw["event"]["type"].as_str() == Some("turn_start") {
		let turns = inner.usage("turns") + 1.0;
		inner.set_usage("turns", turns);
	}
	for event in parse_events(provider, &raw) {
		apply_event(inner, event, provider);
	}
}

fn instruction(scope: &[String]) -> String {
	let access = if scope.is_empty() {
		"The project is read-only for this task. Do not try to write files in it.".to_string()
	} else if scope.iter().any(|item| item == ".") {
		"You may change files anywhere in /workspace except .git.".to_string()
	} else {
		format!(
			"You may change files only in these project paths: {}. All other project paths are read-only.",
			scope.join(", ")
		)
	};
	format!("You are a delegated child inside a fixed Linux filesystem sandbox. /workspace is the host project, and your changes land in it directly. {access} .git is read-only: do not commit, stage, stash or switch branches; the parent reviews and commits your changes. Other children can work in other paths of the project at the same time. If the task needs a change outside your writable paths, do not work around it: finish the other parts, then list each blocked file and the change it needs in your report. A write that is denied because another task changes the file must not be retried: finish the rest and list the file under BLOCKED FILES. Do not delegate again. For a user decision, use question (pi), delegate_question (Command Code), or AskUserQuestion (Claude). All providers can also ask with: node /delegate/ask.mjs '{{\"question\":\"Your question?\",\"options\":[{{\"label\":\"First\"}},{{\"label\":\"Second\"}}]}}'. This command waits for the real user in the parent CLI. Never invent the answer. A permission denial is not permission to try another tool. Stop and report BLOCKED if the sandbox or user blocks all required work. Do not alter permission hooks. Report changed files and test results.")
}

fn resolve_on_path(name: &str) -> Option<PathBuf> {
	let path = std::env::var("PATH").ok()?;
	for dir in path.split(':') {
		if dir.is_empty() {
			continue;
		}
		let candidate = Path::new(dir).join(name);
		if let Ok(real) = fs::canonicalize(&candidate) {
			if fs::metadata(&real).map(|meta| meta.is_file()).unwrap_or(false) {
				return Some(real);
			}
		}
	}
	None
}

fn pi_config_dir() -> String {
	std::env::var("DELEGATE_PI_CONFIG_DIR")
		.ok()
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| ".pi".to_string())
}

fn git_config(key: &str) -> Option<String> {
	let output = Command::new("git")
		.args(["config", "--global", "--get", key])
		.env("PATH", std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()))
		.env("HOME", home_dir())
		.output()
		.ok()?;
	if !output.status.success() {
		return None;
	}
	let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
	if value.is_empty() || value.contains('\n') || value.contains('\r') || value.contains('\0') {
		return None;
	}
	Some(value)
}

fn git_value(value: &str) -> String {
	format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn sha256_hex(data: &[u8]) -> String {
	use sha2::{Digest, Sha256};
	let mut hasher = Sha256::new();
	hasher.update(data);
	hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn copy_private(home: &Path, rel: &Path, from: &Path) -> Option<String> {
	let data = fs::read(from).ok()?;
	let to = home.join(rel);
	if let Some(parent) = to.parent() {
		let _ = fs::create_dir_all(parent);
		let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
	}
	let _ = fs::remove_file(&to);
	write_private(&to, &data, 0o600).ok()?;
	let _ = fs::set_permissions(&to, fs::Permissions::from_mode(0o600));
	Some(sha256_hex(&data))
}

const IDENTITY_KEYS: [&str; 7] = ["account_id", "accountId", "accountUuid", "organizationUuid", "email", "user_id", "userId"];

fn collect_identities(value: &Value, depth: usize, found: &mut std::collections::BTreeMap<String, Value>, prefix: &str) {
	if depth > 3 || !value.is_object() {
		return;
	}
	let Value::Object(map) = value else { return };
	for (key, item) in map {
		if IDENTITY_KEYS.contains(&key.as_str()) && (item.is_string() || item.is_number()) {
			found.insert(format!("{prefix}{key}"), item.clone());
		} else {
			collect_identities(item, depth + 1, found, &format!("{prefix}{key}."));
		}
	}
}

fn same_account(host: &[u8], child: &[u8]) -> bool {
	let Ok(Value::Object(before)) = serde_json::from_slice::<Value>(host) else { return false };
	let Ok(Value::Object(after)) = serde_json::from_slice::<Value>(child) else { return false };
	let mut left: Vec<&String> = before.keys().collect();
	let mut right: Vec<&String> = after.keys().collect();
	left.sort();
	right.sort();
	if left != right {
		return false;
	}
	let mut expected = std::collections::BTreeMap::new();
	let mut actual = std::collections::BTreeMap::new();
	collect_identities(&Value::Object(before), 0, &mut expected, "");
	collect_identities(&Value::Object(after), 0, &mut actual, "");
	expected.iter().all(|(key, value)| actual.get(key) == Some(value))
}

fn read_child_file(home: &Path, rel: &str) -> Option<Vec<u8>> {
	let file = home.join(rel);
	let root = fs::canonicalize(home).ok()?;
	let parent = fs::canonicalize(file.parent()?).ok()?;
	if parent != root && !parent.starts_with(&root) {
		return None;
	}
	let meta = fs::symlink_metadata(&file).ok()?;
	if !meta.file_type().is_file() || meta.len() > 1024 * 1024 {
		return None;
	}
	fs::read(&file).ok()
}

fn return_credentials(task_dir: &Path) {
	let Ok(Value::Array(copies)) = read_json(&task_dir.join("credentials.json")) else { return };
	let home = task_dir.join("home");
	for copy in copies {
		let (Some(rel), Some(from), Some(hash)) = (copy["rel"].as_str(), copy["from"].as_str(), copy["hash"].as_str()) else { continue };
		let Some(child) = read_child_file(&home, rel) else { continue };
		if sha256_hex(&child) == hash {
			continue;
		}
		let Ok(host) = fs::read(from) else { continue };
		if sha256_hex(&host) != hash || !same_account(&host, &child) {
			continue;
		}
		let temp = format!("{from}.delegate-{}-{}.tmp", std::process::id(), now_ms());
		let temp = PathBuf::from(temp);
		if write_private(&temp, &child, 0o600).is_ok() {
			let _ = fs::rename(&temp, from);
		}
	}
}

fn close_home(task_dir: &Path) {
	return_credentials(task_dir);
	let _ = fs::remove_dir_all(task_dir.join("home"));
	let _ = fs::remove_file(task_dir.join("credentials.json"));
}

fn prepare_home(home: &Path, provider: &str) -> Result<(), String> {
	fs::create_dir_all(home).map_err(|error| error.to_string())?;
	let _ = fs::set_permissions(home, fs::Permissions::from_mode(0o700));
	let mut credentials: Vec<Value> = Vec::new();
	let name = git_config("user.name").unwrap_or_else(|| "delegate child".to_string());
	let email = git_config("user.email").unwrap_or_else(|| "delegate@localhost".to_string());
	let config = format!(
		"[user]\n\tname = {}\n\temail = {}\n[init]\n\tdefaultBranch = main\n",
		git_value(&name),
		git_value(&email)
	);
	let file = home.join(".gitconfig");
	let _ = fs::remove_file(&file);
	write_private(&file, config.as_bytes(), 0o600).map_err(|error| error.to_string())?;
	if provider == "pi" {
		let source = match std::env::var("DELEGATE_PI_CODING_AGENT_DIR") {
			Ok(value) if !value.trim().is_empty() => {
				let value = value.trim().to_string();
				if let Some(rest) = value.strip_prefix("~/") {
					home_dir().join(rest)
				} else {
					PathBuf::from(value)
				}
			}
			_ => home_dir().join(pi_config_dir()).join("agent"),
		};
		let dir = home.join(pi_config_dir()).join("agent");
		fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
		let auth_rel = Path::new(&pi_config_dir()).join("agent").join("auth.json");
		if let Some(hash) = copy_private(home, &auth_rel, &source.join("auth.json")) {
			credentials.push(json!({
				"rel": auth_rel.display().to_string(),
				"from": source.join("auth.json").display().to_string(),
				"hash": hash,
			}));
		}
		copy_private(
			home,
			&Path::new(&pi_config_dir()).join("agent").join("models.json"),
			&source.join("models.json"),
		);
		let mut settings = serde_json::Map::new();
		if let Ok(text) = fs::read_to_string(source.join("settings.json")) {
			if let Ok(value) = serde_json::from_str::<Value>(&text) {
				for key in ["defaultProvider", "defaultModel"] {
					if !value[key].is_null() {
						settings.insert(key.to_string(), value[key].clone());
					}
				}
			}
		}
		let target = dir.join("settings.json");
		let _ = fs::remove_file(&target);
		write_private(&target, Value::Object(settings).to_string().as_bytes(), 0o600)
			.map_err(|error| error.to_string())?;
	}
	if provider == "claude" {
		let onboarding = home.join(".claude.json");
		let _ = fs::remove_file(&onboarding);
		write_private(&onboarding, json!({ "hasCompletedOnboarding": true }).to_string().as_bytes(), 0o600)
			.map_err(|error| error.to_string())?;
		let dir = home.join(".claude");
		fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
		let hook = if claude_hook_binary().is_some() {
			"/child-claude".to_string()
		} else {
			"node /delegate/child-claude.mjs".to_string()
		};
		let settings = json!({
			"hooks": {
				"PreToolUse": [{
					"matcher": ".*",
					"hooks": [{ "type": "command", "command": hook, "timeout": 86400 }]
				}]
			}
		});
		let file = dir.join("settings.json");
		let _ = fs::remove_file(&file);
		write_private(&file, settings.to_string().as_bytes(), 0o600).map_err(|error| error.to_string())?;
	}
	if provider == "commandcode" {
		let mods = home.join(".commandcode").join("mods");
		fs::create_dir_all(&mods).map_err(|error| error.to_string())?;
		let source = core_dir()?.join("bridge").join("child-commandcode.ts");
		if source.is_file() {
			let _ = fs::copy(&source, mods.join("delegate-child.ts"));
		}
	}
	let credential_files: &[&str] = match provider {
		"claude" => &[".claude/.credentials.json"],
		"codex" => &[".codex/auth.json"],
		"commandcode" => &[".commandcode/auth.json", ".commandcode/providers.json"],
		_ => &[],
	};
	for rel in credential_files {
		let from = home_dir().join(rel);
		let hash = copy_private(home, Path::new(rel), &from);
		if rel.ends_with("providers.json") {
			continue;
		}
		if let Some(hash) = hash {
			credentials.push(json!({
				"rel": rel,
				"from": from.display().to_string(),
				"hash": hash,
			}));
		}
	}
	let credentials_file = home.parent().map(|parent| parent.join("credentials.json"));
	if let Some(file) = credentials_file {
		let _ = fs::remove_file(&file);
		let _ = write_private(&file, json!(credentials).to_string().as_bytes(), 0o600);
	}
	Ok(())
}

fn secret_folders() -> Vec<PathBuf> {
	let home = home_dir();
	[".ssh", ".gnupg", ".claude", ".codex", ".commandcode", ".pi", ".aws", ".docker", ".kube"]
		.iter()
		.map(|rel| home.join(rel))
		.chain(std::iter::once(home.join(pi_config_dir())))
		.collect()
}

fn too_broad(dir: &Path) -> bool {
	let home = home_dir();
	let mut broad = vec![
		home.clone(),
		home.parent().map(|path| path.to_path_buf()).unwrap_or_default(),
		PathBuf::from("/"),
		PathBuf::from("/home"),
		PathBuf::from("/opt"),
		PathBuf::from("/srv"),
		PathBuf::from("/var"),
		PathBuf::from("/tmp"),
	];
	for rel in [".local", ".config", ".cache", ".local/share", ".local/state", ".local/lib"] {
		broad.push(home.join(rel));
	}
	if broad.iter().any(|item| item == dir) {
		return true;
	}
	let data = data_dir();
	let secrets: Vec<PathBuf> = secret_folders()
		.into_iter()
		.chain([
			home.join(".netrc"),
			home.join(".git-credentials"),
			data.clone(),
			data.join("tasks"),
			data.join("projects"),
		])
		.collect();
	secrets.iter().any(|secret| under(secret, dir))
}

fn tool_mount(file: &Path) -> Option<PathBuf> {
	if !file.is_absolute() {
		return None;
	}
	let system = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
	if system.iter().any(|dir| under(file, Path::new(dir))) {
		return None;
	}
	let data = data_dir();
	let mut guarded = secret_folders();
	guarded.push(data);
	if guarded.iter().any(|secret| under(file, secret)) {
		return None;
	}
	let dir = file.parent()?;
	let prefix = if dir.file_name().map(|name| name == "bin").unwrap_or(false) {
		dir.parent().unwrap_or(dir)
	} else {
		dir
	};
	for candidate in [prefix, dir] {
		if !too_broad(candidate) {
			return Some(candidate.to_path_buf());
		}
	}
	Some(file.to_path_buf())
}

struct Invocation {
	command: PathBuf,
	args: Vec<String>,
}

fn pi_entry() -> Option<String> {
	std::env::var("DELEGATE_PI_ENTRY")
		.ok()
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
}

fn build_invocation(request: &Value, scope: &[String]) -> Result<Invocation, String> {
	let provider = request["provider"].as_str().unwrap_or("pi");
	let system_prompt = request["systemPrompt"].as_str().unwrap_or("");
	let task = request["task"].as_str().unwrap_or("");
	let prompt = format!("{system_prompt}\n\n{}\n\nTask: {task}", instruction(scope));
	let model = request["model"].as_str().map(|value| value.to_string());
	if provider == "pi" {
		let mut args: Vec<String> = Vec::new();
		if let Some(entry) = pi_entry() {
			let node = resolve_on_path("node").ok_or_else(|| "node is missing from PATH".to_string())?;
			args.push(entry);
			args.push("--extension".to_string());
			args.push("/delegate/child-pi.ts".to_string());
			let mut tail_args = vec!["--mode".to_string(), "json".to_string(), "-p".to_string()];
			tail_args.extend(["--no-mcp", "--no-extensions", "--no-session"].iter().map(|item| item.to_string()));
			if let Some(model) = model.as_ref() {
				tail_args.push("--model".to_string());
				tail_args.push(model.clone());
			}
			if let Some(tools) = request["tools"].as_array() {
				let list: Vec<String> = tools.iter().filter_map(|item| item.as_str().map(|value| value.to_string())).collect();
				if !list.is_empty() {
					tail_args.push("--tools".to_string());
					tail_args.push(list.join(","));
				}
			}
			tail_args.push(prompt);
			args.extend(tail_args);
			return Ok(Invocation { command: node, args });
		}
		let node = resolve_on_path("pi").ok_or_else(|| "Required executable is missing: pi".to_string())?;
		args.extend(
			["--mode", "json", "-p", "--no-mcp", "--no-extensions", "--no-session"]
				.iter()
				.map(|item| item.to_string()),
		);
		if let Some(model) = model {
			args.push("--model".to_string());
			args.push(model);
		}
		args.push(prompt);
		return Ok(Invocation { command: node, args });
	}
	let binary = if provider == "claude" {
		"claude"
	} else if provider == "codex" {
		"codex"
	} else if provider == "commandcode" {
		"commandcode"
	} else {
		return Err(format!("Provider unavailable: {provider}"));
	};
	let command = resolve_on_path(binary).ok_or_else(|| format!("Required executable is missing: {binary}"))?;
	let mut args: Vec<String> = Vec::new();
	if provider == "claude" {
		args.extend(["--setting-sources", "user"].iter().map(|item| item.to_string()));
		args.extend(
			[
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--strict-mcp-config",
				"--disallowedTools",
				"Task",
				"--no-session-persistence",
				"--dangerously-skip-permissions",
			]
			.iter()
			.map(|item| item.to_string()),
		);
		if let Some(model) = model.as_ref() {
			args.push("--model".to_string());
			args.push(model.clone());
		}
		if let Some(tools) = request["tools"].as_array() {
			let list: Vec<String> = tools.iter().filter_map(|item| item.as_str().map(|value| value.to_string())).collect();
			if !list.is_empty() {
				args.push("--allowedTools".to_string());
				args.push(list.join(","));
			}
		}
		if let Some(max_turns) = request["maxTurns"].as_i64() {
			args.push("--max-turns".to_string());
			args.push(max_turns.to_string());
		}
	} else if provider == "codex" {
		args.extend(
			[
				"exec",
				"--json",
				"--skip-git-repo-check",
				"--ephemeral",
				"--dangerously-bypass-approvals-and-sandbox",
			]
			.iter()
			.map(|item| item.to_string()),
		);
		if let Some(model) = model.as_ref() {
			args.push("--model".to_string());
			args.push(model.clone());
		}
	} else {
		args.extend(
			[
				"-p",
				"--output-format",
				"json",
				"--trust",
				"--skip-onboarding",
				"--no-auto-update",
				"--no-session",
				"--yolo",
				"--tools-all",
			]
			.iter()
			.map(|item| item.to_string()),
		);
		if let Some(max_turns) = request["maxTurns"].as_i64() {
			args.push("--max-turns".to_string());
			args.push(max_turns.to_string());
		}
		if let Some(model) = model.as_ref() {
			args.push("--model".to_string());
			args.push(model.clone());
		}
	}
	args.push(prompt);
	Ok(Invocation { command, args })
}

fn provider_keys(provider: &str) -> Vec<String> {
	let list: &[&str] = match provider {
		"claude" => &["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
		"codex" => &["OPENAI_API_KEY"],
		"commandcode" => &["COMMANDCODE_API_KEY"],
		_ => &[
			"ZAI_API_KEY",
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"OPENROUTER_API_KEY",
			"GEMINI_API_KEY",
			"GOOGLE_API_KEY",
			"DEEPSEEK_API_KEY",
			"GROQ_API_KEY",
			"MISTRAL_API_KEY",
			"XAI_API_KEY",
			"CEREBRAS_API_KEY",
		],
	};
	let mut keys: Vec<String> = list.iter().map(|item| item.to_string()).collect();
	if let Ok(extra) = std::env::var("DELEGATE_PASS_ENV") {
		for name in extra.split([' ', ',', '\t']).filter(|item| !item.is_empty()) {
			let valid = name
				.chars()
				.next()
				.map(|ch| ch.is_ascii_alphabetic() || ch == '_')
				.unwrap_or(false)
				&& name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
			if valid && !name.starts_with("DELEGATE_") && !keys.iter().any(|key| key == name) {
				keys.push(name.to_string());
			}
		}
	}
	keys
}

struct Layout {
	parents: Vec<String>,
	siblings: Vec<String>,
	folders: Vec<String>,
}

struct GitMounts {
	inside: Vec<String>,
	outside: Vec<PathBuf>,
}

struct Ignored {
	files: Vec<String>,
	skipped: Vec<String>,
}

fn core_dir() -> Result<PathBuf, String> {
	if let Ok(value) = std::env::var("DELEGATE_CORE_DIR") {
		if !value.is_empty() {
			return Ok(PathBuf::from(value));
		}
	}
	let exe = std::env::current_exe().map_err(|error| error.to_string())?;
	let bin = exe
		.parent()
		.ok_or_else(|| "the delegate core directory is unknown".to_string())?;
	bin.parent()
		.ok_or_else(|| "the delegate core directory is unknown".to_string())
		.map(|root| root.join("core"))
}

fn claude_hook_binary() -> Option<PathBuf> {
	let name = if cfg!(target_arch = "aarch64") {
		"child-claude-arm64"
	} else {
		"child-claude-x64"
	};
	let file = core_dir().ok()?.parent()?.join("bin").join(name);
	if file.is_file() {
		Some(file)
	} else {
		None
	}
}

fn sha16(value: &str) -> String {
	use sha2::{Digest, Sha256};
	let mut hasher = Sha256::new();
	hasher.update(value.as_bytes());
	let digest = hasher.finalize();
	let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
	hex[..16].to_string()
}

fn git_run(cwd: &Path, args: &[String], extra: &[(&str, String)], input: Option<&str>) -> Result<String, String> {
	let mut command = Command::new("git");
	command.arg("-C").arg(cwd).args(args);
	command
		.env("GIT_LITERAL_PATHSPECS", "1")
		.env("GIT_AUTHOR_NAME", "delegate")
		.env("GIT_AUTHOR_EMAIL", "delegate@localhost")
		.env("GIT_COMMITTER_NAME", "delegate")
		.env("GIT_COMMITTER_EMAIL", "delegate@localhost");
	for (key, value) in extra {
		command.env(key, value);
	}
	command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
	command.stdout(Stdio::piped()).stderr(Stdio::piped());
	let mut child = command.spawn().map_err(|error| error.to_string())?;
	if let Some(text) = input {
		if let Some(mut handle) = child.stdin.take() {
			let _ = handle.write_all(text.as_bytes());
		}
	}
	let output = child.wait_with_output().map_err(|error| error.to_string())?;
	if !output.status.success() {
		return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
	}
	Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn try_git(cwd: &Path, args: &[String]) -> Option<String> {
	git_run(cwd, args, &[], None).ok()
}

fn args_of(items: &[&str]) -> Vec<String> {
	items.iter().map(|item| item.to_string()).collect()
}

fn dir_of(rel: &str) -> String {
	match Path::new(rel).parent() {
		Some(parent) if !parent.as_os_str().is_empty() => parent.display().to_string(),
		_ => ".".to_string(),
	}
}

fn depth_of(rel: &str) -> usize {
	if rel == "." {
		0
	} else {
		rel.split('/').count()
	}
}

fn scope_layout(cwd: &Path, scope: &[String]) -> Layout {
	if scope.iter().any(|item| item == ".") {
		return Layout { parents: Vec::new(), siblings: Vec::new(), folders: vec![".".to_string()] };
	}
	let folders: Vec<String> = scope
		.iter()
		.filter(|rel| cwd.join(rel.as_str()).is_dir())
		.cloned()
		.collect();
	let files: Vec<String> = scope.iter().filter(|rel| !folders.contains(rel)).cloned().collect();
	let mut parents: Vec<String> = Vec::new();
	for rel in &files {
		let parent = dir_of(rel);
		if !parents.contains(&parent) {
			parents.push(parent);
		}
	}
	parents.sort_by_key(|rel| depth_of(rel));
	let mut siblings: Vec<String> = Vec::new();
	for parent in &parents {
		let Ok(entries) = fs::read_dir(cwd.join(parent)) else { continue };
		let mut names: Vec<String> = entries.flatten().filter_map(|entry| entry.file_name().into_string().ok()).collect();
		names.sort();
		for name in names {
			let rel = if parent == "." { name } else { format!("{parent}/{name}") };
			if !files.contains(&rel) && !folders.contains(&rel) && !parents.contains(&rel) {
				siblings.push(rel);
			}
		}
	}
	Layout { parents, siblings, folders }
}

fn git_mounts(cwd: &Path) -> GitMounts {
	let mut mounts = GitMounts { inside: Vec::new(), outside: Vec::new() };
	let Some(git_dir) = try_git(cwd, &args_of(&["rev-parse", "--absolute-git-dir"])) else { return mounts };
	let common = try_git(cwd, &args_of(&["rev-parse", "--git-common-dir"]))
		.map(|value| {
			let path = Path::new(&value);
			if path.is_absolute() {
				path.to_path_buf()
			} else {
				cwd.join(path)
			}
		})
		.unwrap_or_else(|| PathBuf::from(&git_dir));
	let mut dirs: Vec<PathBuf> = Vec::new();
	for dir in [PathBuf::from(&git_dir), common] {
		if let Some(real) = real_path(&dir) {
			if !dirs.contains(&real) {
				dirs.push(real);
			}
		}
	}
	for dir in dirs {
		if under(&dir, cwd) {
			if let Ok(rel) = dir.strip_prefix(cwd) {
				mounts.inside.push(rel.display().to_string());
			}
		} else {
			mounts.outside.push(dir);
		}
	}
	let dot_git = cwd.join(".git");
	if dot_git.exists() && !mounts.inside.iter().any(|rel| rel == ".git") {
		mounts.inside.push(".git".to_string());
	}
	mounts
}

fn workspace_args(cwd: &Path, layout: &Layout, git: &GitMounts, scratch: &[String]) -> Vec<String> {
	let mut binds: Vec<(String, bool)> = Vec::new();
	for rel in &layout.parents {
		binds.push((rel.clone(), true));
	}
	for rel in &layout.siblings {
		binds.push((rel.clone(), false));
	}
	for rel in &layout.folders {
		binds.push((rel.clone(), true));
	}
	binds.sort_by_key(|(rel, _)| depth_of(rel));
	let mut args = vec![
		"--ro-bind".to_string(),
		cwd.display().to_string(),
		"/workspace".to_string(),
	];
	for (rel, writable) in binds {
		args.push(if writable { "--bind".to_string() } else { "--ro-bind".to_string() });
		args.push(cwd.join(&rel).display().to_string());
		args.push(format!("/workspace/{rel}"));
	}
	for rel in &git.inside {
		args.push("--ro-bind".to_string());
		args.push(cwd.join(rel).display().to_string());
		args.push(format!("/workspace/{rel}"));
	}
	for dir in &git.outside {
		args.push("--ro-bind".to_string());
		args.push(dir.display().to_string());
		args.push(dir.display().to_string());
	}
	for rel in scratch {
		args.push("--tmpfs".to_string());
		args.push(format!("/workspace/{rel}"));
	}
	args.push("--chdir".to_string());
	args.push("/workspace".to_string());
	args
}

fn ref_name(id: &str, name: &str) -> String {
	format!("refs/delegate/{id}/{name}")
}

fn has_ref(cwd: &Path, id: &str, name: &str) -> bool {
	try_git(cwd, &["rev-parse".to_string(), "--verify".to_string(), "-q".to_string(), ref_name(id, name)]).is_some()
}

fn ignored_paths(cwd: &Path, scope: &[String]) -> Result<Ignored, String> {
	let present: Vec<String> = scope.iter().filter(|rel| cwd.join(rel.as_str()).exists()).cloned().collect();
	if present.is_empty() {
		return Ok(Ignored { files: Vec::new(), skipped: Vec::new() });
	}
	let mut args = args_of(&["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory", "--"]);
	args.extend(present.iter().cloned());
	let listing = git_run(cwd, &args, &[], None)?;
	let entries: Vec<String> = listing.split('\0').filter(|item| !item.is_empty()).map(|item| item.to_string()).collect();
	let dirs: Vec<String> = entries.iter().filter(|rel| rel.ends_with('/')).cloned().collect();
	let mut ignored_dirs: Vec<String> = Vec::new();
	if !dirs.is_empty() {
		let plain = vec![("GIT_LITERAL_PATHSPECS", "0".to_string())];
		let stdin = dirs.join("\0");
		if let Ok(output) = git_run(cwd, &args_of(&["check-ignore", "-z", "--stdin"]), &plain, Some(&stdin)) {
			ignored_dirs = output.split('\0').filter(|item| !item.is_empty()).map(|item| item.to_string()).collect();
		}
	}
	let mut skipped = ignored_dirs.clone();
	let mut files: Vec<String> = Vec::new();
	for rel in &entries {
		if rel.ends_with('/') || ignored_dirs.iter().any(|dir| rel.starts_with(dir.as_str())) {
			continue;
		}
		let Ok(meta) = fs::symlink_metadata(cwd.join(rel)) else { continue };
		if meta.is_file() && meta.len() > 1024 * 1024 {
			skipped.push(rel.clone());
		} else {
			files.push(rel.clone());
		}
	}
	if files.len() > 1000 {
		skipped.extend(files);
		skipped.sort();
		return Ok(Ignored { files: Vec::new(), skipped });
	}
	skipped.sort();
	Ok(Ignored { files, skipped })
}

fn snapshot(cwd: &Path, scope: &[String], id: &str, name: &str, temp_dir: &Path) -> Result<String, String> {
	let index = temp_dir.join(format!("index-{name}-{}", std::process::id()));
	let result = (|| -> Result<String, String> {
		let git_path = git_run(cwd, &args_of(&["rev-parse", "--git-path", "index"]), &[], None)?;
		let real_index = cwd.join(git_path);
		let head = try_git(cwd, &args_of(&["rev-parse", "--verify", "-q", "HEAD"]));
		let env = vec![("GIT_INDEX_FILE", index.display().to_string())];
		if real_index.exists() {
			fs::copy(&real_index, &index).map_err(|error| error.to_string())?;
		} else if let Some(head) = head.as_ref() {
			git_run(cwd, &["read-tree".to_string(), head.clone()], &env, None)?;
		}
		let present: Vec<String> = scope.iter().filter(|rel| cwd.join(rel.as_str()).exists()).cloned().collect();
		if !present.is_empty() {
			let mut args = args_of(&["add", "-A", "--"]);
			args.extend(present.iter().cloned());
			git_run(cwd, &args, &env, None)?;
			let ignored = ignored_paths(cwd, &present)?;
			if !ignored.files.is_empty() {
				let stdin = ignored.files.join("\0");
				git_run(
					cwd,
					&args_of(&["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"]),
					&env,
					Some(&stdin),
				)?;
			}
		}
		let tree = git_run(cwd, &args_of(&["write-tree"]), &env, None)?;
		let mut commit_args = vec!["commit-tree".to_string(), tree.clone()];
		if let Some(head) = head.as_ref() {
			commit_args.push("-p".to_string());
			commit_args.push(head.clone());
		}
		commit_args.push("-m".to_string());
		commit_args.push(format!("delegate {id} {name}"));
		let commit = git_run(cwd, &commit_args, &[], None)?;
		git_run(
			cwd,
			&["update-ref".to_string(), ref_name(id, name), commit.clone()],
			&[],
			None,
		)?;
		Ok(commit)
	})();
	let _ = fs::remove_file(&index);
	result
}

fn diffstat(cwd: &Path, id: &str, scope: &[String]) -> String {
	if !has_ref(cwd, id, "before") || !has_ref(cwd, id, "after") {
		return String::new();
	}
	let mut args = args_of(&["diff", "--stat", "--relative", &ref_name(id, "before"), &ref_name(id, "after"), "--"]);
	args.extend(scope.iter().cloned());
	match git_run(cwd, &args, &[], None) {
		Ok(text) => text.chars().take(4000).collect(),
		Err(_) => String::new(),
	}
}

fn project_dir(cwd: &Path) -> Result<PathBuf, String> {
	let dir = data_dir().join("projects").join(sha16(&cwd.display().to_string()));
	fs::create_dir_all(dir.join("scopes")).map_err(|error| error.to_string())?;
	let _ = fs::set_permissions(dir.join("scopes"), fs::Permissions::from_mode(0o700));
	let meta = dir.join("project.json");
	if !meta.exists() {
		let _ = write_private(&meta, json!({ "cwd": cwd.display().to_string() }).to_string().as_bytes(), 0o600);
	}
	Ok(dir)
}

fn with_mutex<T>(dir: &Path, work: impl FnOnce() -> T) -> Result<T, String> {
	let mutex = dir.join(".mutex");
	for attempt in 0..=500 {
		match fs::create_dir(&mutex) {
			Ok(()) => {
				let value = work();
				let _ = fs::remove_dir(&mutex);
				return Ok(value);
			}
			Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
				if let Ok(meta) = fs::metadata(&mutex) {
					if let Ok(modified) = meta.modified() {
						let age = SystemTime::now().duration_since(modified).map(|value| value.as_millis() as i64).unwrap_or(0);
						if age > 10_000 {
							let _ = fs::remove_dir(&mutex);
						}
					}
				}
				if attempt > 500 {
					return Err("Scope registry is busy".to_string());
				}
				thread::sleep(Duration::from_millis(20));
			}
			Err(error) => return Err(error.to_string()),
		}
	}
	Err("Scope registry is busy".to_string())
}

fn pid_alive(pid: i32) -> bool {
	unsafe { libc::kill(pid, 0) == 0 }
}

fn worker_gone(state: &Value) -> bool {
	let status = state["status"].as_str().unwrap_or("");
	if matches!(status, "completed" | "failed" | "blocked" | "cancelled" | "timed_out") {
		return false;
	}
	if let Some(heartbeat) = state["heartbeat"].as_i64() {
		if now_ms() - heartbeat < 15_000 {
			return false;
		}
	}
	if let Some(pid) = state["workerPid"].as_i64() {
		return !pid_alive(pid as i32);
	}
	if let Some(created) = state["createdAt"].as_i64() {
		return now_ms() - created >= 15_000;
	}
	false
}

fn mark_worker_gone(file: &Path, state: &Value) {
	let mut next = state.clone();
	next["status"] = json!("failed");
	next["summary"] = json!("Task supervisor stopped. The changes stay in the project. Use diff, then accept or undo.");
	next["pending"] = json!([]);
	let _ = write_atomic(file, &next.to_string());
}

fn overlaps(a: &str, b: &str) -> bool {
	a == "." || b == "." || a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

fn acquire_scope(cwd: &Path, id: &str, scope: &[String], task_dir: &Path) -> Result<Vec<String>, String> {
	let dir = project_dir(cwd)?;
	with_mutex(&dir, || -> Result<Vec<String>, String> {
		let mut blocking: Vec<String> = Vec::new();
		let scopes = dir.join("scopes");
		let entries = fs::read_dir(&scopes).map_err(|error| error.to_string())?;
		for entry in entries.flatten() {
			let file = entry.path();
			let Ok(held) = read_json(&file) else { continue };
			let held_id = held["taskId"].as_str().unwrap_or("").to_string();
			if held_id == id {
				return Ok(Vec::new());
			}
			let held_dir = PathBuf::from(held["taskDir"].as_str().unwrap_or(""));
			let state_file = held_dir.join("state.json");
			if !state_file.exists() {
				let _ = fs::remove_file(&file);
				continue;
			}
			if let Ok(state) = read_json(&state_file) {
				if worker_gone(&state) {
					if state["snapshot"].as_bool() != Some(true) {
						let _ = fs::remove_file(&file);
						continue;
					}
					mark_worker_gone(&state_file, &state);
				}
			}
			let held_scope: Vec<String> = held["scope"]
				.as_array()
				.map(|items| items.iter().filter_map(|item| item.as_str().map(|value| value.to_string())).collect())
				.unwrap_or_default();
			if held_scope.iter().any(|a| scope.iter().any(|b| overlaps(a, b))) {
				blocking.push(held_id);
			}
		}
		if blocking.is_empty() {
			let file = scopes.join(format!("{id}.json"));
			let entry = json!({
				"taskId": id,
				"scope": scope,
				"taskDir": task_dir.display().to_string(),
				"since": now_ms(),
			});
			write_private(&file, entry.to_string().as_bytes(), 0o600).map_err(|error| error.to_string())?;
		}
		Ok(blocking)
	})?
}

fn release_scope(cwd: &Path, id: &str) -> Result<(), String> {
	let dir = project_dir(cwd)?;
	let _ = fs::remove_file(dir.join("scopes").join(format!("{id}.json")));
	Ok(())
}

fn release_claims(cwd: &Path, id: &str) -> Result<(), String> {
	let dir = project_dir(cwd)?.join("claims");
	let entries = match fs::read_dir(&dir) {
		Ok(entries) => entries,
		Err(_) => return Ok(()),
	};
	for entry in entries.flatten() {
		let file = entry.path();
		if let Ok(held) = read_json(&file) {
			if held["taskId"].as_str() == Some(id) {
				let _ = fs::remove_file(&file);
			}
		}
	}
	Ok(())
}

fn list_parents(cwd: &Path, layout: &Layout) -> Vec<(String, Vec<String>)> {
	let mut listing: Vec<(String, Vec<String>)> = Vec::new();
	for parent in &layout.parents {
		let mut names: Vec<String> = fs::read_dir(cwd.join(parent))
			.map(|entries| entries.flatten().filter_map(|entry| entry.file_name().into_string().ok()).collect())
			.unwrap_or_default();
		names.sort();
		listing.push((parent.clone(), names));
	}
	listing
}

fn stray_files(cwd: &Path, scope: &[String], before: &[(String, Vec<String>)], task_id: &str) -> Vec<String> {
	let mut claims: Vec<Value> = Vec::new();
	if let Ok(dir) = project_dir(cwd) {
		if let Ok(entries) = fs::read_dir(dir.join("claims")) {
			for entry in entries.flatten() {
				if let Ok(held) = read_json(&entry.path()) {
					claims.push(held);
				}
			}
		}
	}
	let mut held: Vec<Vec<String>> = Vec::new();
	if let Ok(dir) = project_dir(cwd) {
		if let Ok(entries) = fs::read_dir(dir.join("scopes")) {
			for entry in entries.flatten() {
				let Ok(value) = read_json(&entry.path()) else { continue };
				if value["taskId"].as_str().unwrap_or("") == task_id {
					continue;
				}
				if let Some(items) = value["scope"].as_array() {
					held.push(items.iter().filter_map(|item| item.as_str().map(|value| value.to_string())).collect());
				}
			}
		}
	}
	let mut stray: Vec<String> = Vec::new();
	for (parent, names) in before {
		let Ok(entries) = fs::read_dir(cwd.join(parent)) else { continue };
		for entry in entries.flatten() {
			let Ok(name) = entry.file_name().into_string() else { continue };
			let rel = if parent == "." { name.clone() } else { format!("{parent}/{name}") };
			if names.contains(&name) {
				continue;
			}
			if scope.iter().any(|item| item == &rel || rel.starts_with(&format!("{item}/"))) {
				continue;
			}
			if claims.iter().any(|claim| claim["path"].as_str() == Some(rel.as_str()) && claim["taskId"].as_str() != Some(task_id)) {
				continue;
			}
			if held.iter().any(|items| items.iter().any(|item| item == &rel || rel.starts_with(&format!("{item}/")))) {
				continue;
			}
			stray.push(rel);
		}
	}
	stray.sort();
	stray
}

fn holder_stale(held: &Value) -> bool {
	let Some(dir) = held["taskDir"].as_str() else { return true };
	let file = Path::new(dir).join("state.json");
	if !file.exists() {
		return true;
	}
	let Ok(state) = read_json(&file) else { return true };
	let status = state["status"].as_str().unwrap_or("");
	if matches!(status, "completed" | "failed" | "blocked" | "cancelled" | "timed_out") {
		return true;
	}
	worker_gone(&state)
}

fn acquire_slot(cwd: &Path, id: &str, task_dir: &Path, max: usize) -> Result<Vec<String>, String> {
	let dir = project_dir(cwd)?;
	with_mutex(&dir, || -> Result<Vec<String>, String> {
		let slots = dir.join("slots");
		fs::create_dir_all(&slots).map_err(|error| error.to_string())?;
		let _ = fs::set_permissions(&slots, fs::Permissions::from_mode(0o700));
		let mut holders: Vec<String> = Vec::new();
		let entries = fs::read_dir(&slots).map_err(|error| error.to_string())?;
		for entry in entries.flatten() {
			let file = entry.path();
			let Ok(held) = read_json(&file) else {
				let _ = fs::remove_file(&file);
				continue;
			};
			let held_id = held["taskId"].as_str().unwrap_or("").to_string();
			if held_id == id {
				return Ok(Vec::new());
			}
			if holder_stale(&held) {
				let _ = fs::remove_file(&file);
				continue;
			}
			holders.push(held_id);
		}
		if holders.len() >= max {
			return Ok(holders);
		}
		let entry = json!({
			"taskId": id,
			"taskDir": task_dir.display().to_string(),
			"since": now_ms(),
		});
		let file = slots.join(format!("{id}.json"));
		write_private(&file, entry.to_string().as_bytes(), 0o600).map_err(|error| error.to_string())?;
		Ok(Vec::new())
	})?
}

fn release_slot(cwd: &Path, id: &str) {
	if let Ok(dir) = project_dir(cwd) {
		let _ = fs::remove_file(dir.join("slots").join(format!("{id}.json")));
	}
}

fn uuid_v4() -> String {
	let mut bytes = [0u8; 16];
	if let Ok(mut file) = File::open("/dev/urandom") {
		let _ = file.read_exact(&mut bytes);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let hex: Vec<String> = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
	format!(
		"{}{}{}{}-{}{}-{}{}-{}{}-{}{}{}{}{}{}",
		hex[0], hex[1], hex[2], hex[3], hex[4], hex[5], hex[6], hex[7], hex[8], hex[9], hex[10], hex[11], hex[12], hex[13], hex[14], hex[15]
	)
}

fn project_rel(text: &str) -> Option<String> {
	let mut stack: Vec<String> = Vec::new();
	let parts: Vec<&str> = text.split('/').filter(|part| !part.is_empty()).collect();
	if text.starts_with('/') {
		if parts.first() != Some(&"workspace") {
			return None;
		}
		for part in &parts[1..] {
			match *part {
				"." => {}
				".." => {
					stack.pop()?;
				}
				other => stack.push(other.to_string()),
			}
		}
	} else {
		for part in parts {
			match part {
				"." => {}
				".." => {
					stack.pop()?;
				}
				other => stack.push(other.to_string()),
			}
		}
	}
	let rel = stack.join("/");
	if rel.is_empty() || rel == ".git" || rel.starts_with(".git/") {
		return None;
	}
	Some(rel)
}

fn project_paths(raw: &Value) -> Vec<String> {
	let mut result: Vec<String> = Vec::new();
	let Some(items) = raw.as_array() else { return result };
	for item in items.iter().take(64) {
		let Some(text) = item.as_str() else { continue };
		if text.is_empty() || text.len() > 1024 || text.contains('\0') {
			continue;
		}
		if let Some(rel) = project_rel(text) {
			if !result.contains(&rel) {
				result.push(rel);
			}
		}
	}
	result
}

fn claim_file(cwd: &Path, rel: &str) -> Result<PathBuf, String> {
	let dir = project_dir(cwd)?.join("claims");
	fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
	let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
	Ok(dir.join(format!("{}.json", sha16(rel))))
}

fn base_hash(cwd: &Path, rel: &str) -> Option<String> {
	if !cwd.join(rel).exists() {
		return None;
	}
	try_git(cwd, &["hash-object".to_string(), "--".to_string(), rel.to_string()])
}

fn read_claim(file: &Path) -> Option<Value> {
	let claim = read_json(file).ok()?;
	let task_id = claim["taskId"].as_str().unwrap_or("");
	if !data_dir().join("tasks").join(task_id).join("state.json").exists() {
		let _ = fs::remove_file(file);
		return None;
	}
	Some(claim)
}

fn claim_paths(cwd: &Path, task_id: &str, agent: &str, paths: &[String]) -> Vec<Value> {
	let mut denied: Vec<Value> = Vec::new();
	for rel in paths {
		let Ok(file) = claim_file(cwd, rel) else { continue };
		for _ in 0..3 {
			let entry = json!({
				"path": rel,
				"taskId": task_id,
				"agent": agent,
				"since": now_ms(),
				"baseHash": base_hash(cwd, rel),
			});
			match write_private(&file, entry.to_string().as_bytes(), 0o600) {
				Ok(()) => break,
				Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
				Err(_) => break,
			}
			let Some(held) = read_claim(&file) else { continue };
			if held["taskId"].as_str() != Some(task_id) {
				denied.push(json!({
					"path": rel,
					"taskId": held["taskId"],
					"agent": held["agent"],
				}));
			}
			break;
		}
	}
	denied
}

fn release_claim_paths(cwd: &Path, task_id: &str, paths: &[String]) -> Vec<String> {
	let mut released: Vec<String> = Vec::new();
	for rel in paths {
		let Ok(file) = claim_file(cwd, rel) else { continue };
		let Some(held) = read_json(&file).ok() else { continue };
		if held["taskId"].as_str() != Some(task_id) {
			continue;
		}
		let _ = fs::remove_file(&file);
		released.push(rel.clone());
	}
	released
}

fn claim_notes(cwd: &Path, task_id: &str, paths: &[String]) -> Vec<Value> {
	let mut notes: Vec<Value> = Vec::new();
	for rel in paths {
		let Ok(file) = claim_file(cwd, rel) else { continue };
		let Some(held) = read_claim(&file) else { continue };
		if held["taskId"].as_str() != Some(task_id) {
			notes.push(json!({
				"path": rel,
				"taskId": held["taskId"],
				"agent": held["agent"],
			}));
		}
	}
	notes
}

fn claim_message(cwd: &Path, task_id: &str, agent: &str, message: &Value) -> Result<Value, String> {
	let paths = project_paths(&message["paths"]);
	match message["kind"].as_str() {
		Some("claim") => Ok(json!({ "denied": claim_paths(cwd, task_id, agent, &paths) })),
		Some("release") => Ok(json!({ "released": release_claim_paths(cwd, task_id, &paths) })),
		Some("notify") => Ok(json!({ "notes": claim_notes(cwd, task_id, &paths) })),
		_ => Err("Invalid claim message".to_string()),
	}
}

struct Ipc {
	alias: PathBuf,
	stop: Arc<AtomicBool>,
}

fn read_request(stream: &mut UnixStream) -> Result<String, String> {
	let _ = stream.set_read_timeout(Some(Duration::from_millis(5000)));
	let mut buffer: Vec<u8> = Vec::new();
	let mut chunk = [0u8; 4096];
	loop {
		match stream.read(&mut chunk) {
			Ok(0) => break,
			Ok(size) => {
				buffer.extend_from_slice(&chunk[..size]);
				if buffer.len() > 32768 {
					return Err("Invalid question".to_string());
				}
				if buffer.contains(&b'\n') {
					break;
				}
			}
			Err(_) => break,
		}
	}
	let text = String::from_utf8_lossy(&buffer).to_string();
	let line = text.split('\n').next().unwrap_or("").to_string();
	if line.trim().is_empty() {
		return Err("Invalid question".to_string());
	}
	Ok(line)
}

fn socket_closed(stream: &UnixStream) -> bool {
	if stream.set_nonblocking(true).is_err() {
		return true;
	}
	let mut handle: &UnixStream = stream;
	let mut probe = [0u8; 1];
	let closed = match handle.read(&mut probe) {
		Ok(0) => true,
		Ok(_) => false,
		Err(error) => error.kind() != std::io::ErrorKind::WouldBlock,
	};
	let _ = stream.set_nonblocking(false);
	closed
}

fn handle_connection(shared: Shared, cwd: PathBuf, task_id: String, stop: Arc<AtomicBool>, mut stream: UnixStream) {
	let line = match read_request(&mut stream) {
		Ok(line) => line,
		Err(_) => {
			let _ = stream.write_all(b"{\"error\":\"Invalid question request\"}\n");
			return;
		}
	};
	let value: Value = match serde_json::from_str(&line) {
		Ok(value) => value,
		Err(_) => {
			let _ = stream.write_all(b"{\"error\":\"Invalid question request\"}\n");
			return;
		}
	};
	let kind = value["kind"].as_str().unwrap_or("");
	if matches!(kind, "claim" | "release" | "notify") {
		let agent = shared.lock().map(|inner| inner.state["agent"].as_str().unwrap_or("direct").to_string()).unwrap_or_else(|_| "direct".to_string());
		let response = match claim_message(&cwd, &task_id, &agent, &value) {
			Ok(value) => value,
			Err(error) => json!({ "error": error }),
		};
		let _ = stream.write_all(format!("{response}\n").as_bytes());
		return;
	}
	if !matches!(kind, "question" | "permission") {
		let _ = stream.write_all(b"{\"error\":\"Invalid question request\"}\n");
		return;
	}
	let question = value["question"].as_str().unwrap_or("").to_string();
	if question.trim().is_empty() || question.len() > 8000 {
		let _ = stream.write_all(b"{\"error\":\"Invalid question request\"}\n");
		return;
	}
	let request_id = uuid_v4();
	{
		let Ok(mut inner) = shared.lock() else { return };
		if inner.open_questions.len() >= 16 {
			drop(inner);
			let _ = stream.write_all(b"{\"error\":\"Invalid question request\"}\n");
			return;
		}
		inner.open_questions.insert(request_id.clone());
		let options = value["options"].as_array().map(|items| items.iter().take(20).cloned().collect::<Vec<_>>()).unwrap_or_default();
		let pending = json!({
			"id": request_id,
			"kind": kind,
			"question": question,
			"options": options,
			"multiSelect": value["multiSelect"].as_bool() == Some(true),
			"tool": value["tool"],
			"input": value["input"],
		});
		let mut list = inner.state["pending"].as_array().cloned().unwrap_or_default();
		list.push(pending);
		inner.state["pending"] = json!(list);
		inner.state["status"] = json!("waiting");
		inner.state["summary"] = json!("Child is waiting for the parent user. Do not invent an answer.");
		inner.save();
	}
	let task_dir = inner_dir(&shared);
	let answer_file = task_dir.join(format!("answer-{request_id}.json"));
	let answered_file = task_dir.join(format!("answered-{request_id}.json"));
	loop {
		if stop.load(Ordering::SeqCst) {
			finish_question(&shared, &request_id);
			return;
		}
		if socket_closed(&stream) {
			finish_question(&shared, &request_id);
			return;
		}
		if answer_file.exists() {
			if let Ok(response) = read_json(&answer_file) {
				if kind == "permission" && response["approved"].as_bool() != Some(true) {
					if let Ok(mut inner) = shared.lock() {
						inner.denied = true;
					}
				}
				let _ = stream.write_all(format!("{response}\n").as_bytes());
			}
			let _ = fs::rename(&answer_file, &answered_file);
			finish_question(&shared, &request_id);
			return;
		}
		thread::sleep(Duration::from_millis(100));
	}
}

fn inner_dir(shared: &Shared) -> PathBuf {
	shared.lock().map(|inner| inner.dir.clone()).unwrap_or_else(|_| PathBuf::from("/"))
}

fn finish_question(shared: &Shared, request_id: &str) {
	if let Ok(mut inner) = shared.lock() {
		inner.open_questions.remove(request_id);
		let list: Vec<Value> = inner.state["pending"]
			.as_array()
			.map(|items| items.iter().filter(|item| item["id"].as_str() != Some(request_id)).cloned().collect())
			.unwrap_or_default();
		let empty = list.is_empty();
		inner.state["pending"] = json!(list);
		if empty && inner.state["status"].as_str() == Some("waiting") {
			inner.state["status"] = json!("running");
			inner.state["summary"] = json!("Child continued after user input");
		}
		inner.save();
	}
}

fn start_ipc(shared: &Shared, task_dir: &Path, cwd: &Path, task_id: &str) -> Result<Ipc, String> {
	let ipc_dir = task_dir.join("ipc");
	fs::create_dir_all(&ipc_dir).map_err(|error| error.to_string())?;
	let _ = fs::set_permissions(&ipc_dir, fs::Permissions::from_mode(0o700));
	let name = format!("delegate-ipc-{task_id}");
	let temp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
	let base = if format!("{temp}/{name}/control.sock").len() < 108 { temp } else { "/tmp".to_string() };
	let alias = PathBuf::from(format!("{base}/{name}"));
	let _ = fs::remove_file(&alias);
	std::os::unix::fs::symlink(&ipc_dir, &alias).map_err(|error| error.to_string())?;
	let socket_path = alias.join("control.sock");
	let listener = UnixListener::bind(&socket_path).map_err(|error| error.to_string())?;
	let _ = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600));
	listener.set_nonblocking(true).map_err(|error| error.to_string())?;
	let stop = Arc::new(AtomicBool::new(false));
	let stop_thread = stop.clone();
	let shared_thread = shared.clone();
	let cwd_thread = cwd.to_path_buf();
	let id_thread = task_id.to_string();
	thread::spawn(move || loop {
		if stop_thread.load(Ordering::SeqCst) {
			break;
		}
		match listener.accept() {
			Ok((stream, _)) => {
				let shared = shared_thread.clone();
				let cwd = cwd_thread.clone();
				let id = id_thread.clone();
				let stop = stop_thread.clone();
				thread::spawn(move || handle_connection(shared, cwd, id, stop, stream));
			}
			Err(_) => thread::sleep(Duration::from_millis(100)),
		}
	});
	Ok(Ipc { alias, stop })
}

struct Watch {
	stop: Arc<AtomicBool>,
}

fn join_rel(base: &str, name: &str) -> String {
	if base == "." || base.is_empty() {
		name.to_string()
	} else if name.is_empty() {
		base.to_string()
	} else {
		format!("{base}/{name}")
	}
}

fn scope_roots(cwd: &Path, scope: &[String]) -> Vec<String> {
	if scope.iter().any(|item| item == ".") {
		return vec![".".to_string()];
	}
	let mut roots: Vec<String> = Vec::new();
	for rel in scope {
		let dir = if cwd.join(rel).is_dir() { rel.clone() } else { dir_of(rel) };
		if !roots.contains(&dir) {
			roots.push(dir);
		}
	}
	roots
}

fn add_tree(fd: i32, dir: &Path, root: &str, rel_dir: &str, watches: &mut HashMap<i32, (String, String)>) {
	let mask = libc::IN_CREATE
		| libc::IN_MODIFY
		| libc::IN_CLOSE_WRITE
		| libc::IN_MOVED_TO
		| libc::IN_MOVED_FROM
		| libc::IN_DELETE
		| libc::IN_ATTRIB;
	use std::os::unix::ffi::OsStrExt;
	if let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) {
		let wd = unsafe { libc::inotify_add_watch(fd, path.as_ptr(), mask) };
		if wd >= 0 {
			watches.insert(wd, (root.to_string(), rel_dir.to_string()));
		}
	}
	let Ok(entries) = fs::read_dir(dir) else { return };
	for entry in entries.flatten() {
		let name = entry.file_name().to_string_lossy().to_string();
		if name == ".git" || name == "node_modules" {
			continue;
		}
		let path = entry.path();
		if !path.is_dir() {
			continue;
		}
		let child = join_rel(rel_dir, &name);
		add_tree(fd, &path, root, &child, watches);
	}
}

fn watch_change(shared: &Shared, cwd: &Path, scope: &[String], task_id: &str, rel: &str, conflicted: &mut HashSet<String>) {
	if rel.split('/').any(|part| part == ".git" || part == "node_modules") {
		return;
	}
	if !scope
		.iter()
		.any(|item| item == "." || item == rel || rel.starts_with(&format!("{item}/")))
	{
		return;
	}
	if cwd.join(rel).is_dir() {
		return;
	}
	let agent = shared
		.lock()
		.map(|inner| inner.state["agent"].as_str().unwrap_or("direct").to_string())
		.unwrap_or_else(|_| "direct".to_string());
	let denied = claim_paths(cwd, task_id, &agent, &[rel.to_string()]);
	let Some(first) = denied.first() else { return };
	if conflicted.contains(rel) {
		return;
	}
	conflicted.insert(rel.to_string());
	if let Ok(mut inner) = shared.lock() {
		let mut list = inner.state["conflicts"].as_array().cloned().unwrap_or_default();
		list.push(json!({ "path": rel, "taskId": first["taskId"] }));
		inner.state["conflicts"] = json!(list);
		let note = format!(
			"[delegate] Conflict: {rel} is also claimed by task {}",
			first["taskId"].as_str().unwrap_or("")
		);
		let summary = format!("{}\n{note}", inner.state["summary"].as_str().unwrap_or(""));
		inner.state["summary"] = json!(tail(&summary, TEXT_CAP));
		inner.save();
	}
}

fn watch_loop(shared: Shared, cwd: PathBuf, scope: Vec<String>, task_id: String, stop: Arc<AtomicBool>) {
	let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
	if fd < 0 {
		return;
	}
	let mut watches: HashMap<i32, (String, String)> = HashMap::new();
	for root in scope_roots(&cwd, &scope) {
		add_tree(fd, &cwd.join(&root), &root, "", &mut watches);
	}
	let event_size = std::mem::size_of::<libc::inotify_event>();
	let mut buffer = vec![0u8; 64 * 1024];
	let mut conflicted: HashSet<String> = HashSet::new();
	while !stop.load(Ordering::SeqCst) {
		let read = unsafe { libc::read(fd, buffer.as_mut_ptr() as *mut libc::c_void, buffer.len()) };
		if read <= 0 {
			thread::sleep(Duration::from_millis(50));
			continue;
		}
		let mut offset = 0usize;
		while offset + event_size <= read as usize {
			let event = unsafe { &*(buffer.as_ptr().add(offset) as *const libc::inotify_event) };
			let size = event_size + event.len as usize;
			let name = if event.len > 0 {
				let bytes = &buffer[offset + event_size..offset + size];
				let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
				String::from_utf8_lossy(&bytes[..end]).to_string()
			} else {
				String::new()
			};
			if let Some((root, rel_dir)) = watches.get(&event.wd).cloned() {
				if !name.is_empty() {
					if (event.mask & libc::IN_ISDIR) != 0 && (event.mask & (libc::IN_CREATE | libc::IN_MOVED_TO)) != 0 {
						let child = join_rel(&rel_dir, &name);
						add_tree(fd, &cwd.join(&root).join(&child), &root, &child, &mut watches);
					} else {
						let rel = join_rel(&join_rel(&root, &rel_dir), &name);
						watch_change(&shared, &cwd, &scope, &task_id, &rel, &mut conflicted);
					}
				}
			}
			offset += size;
		}
	}
	unsafe {
		libc::close(fd);
	}
}

fn start_watcher(shared: &Shared, cwd: &Path, scope: &[String], task_id: &str) -> Watch {
	let stop = Arc::new(AtomicBool::new(false));
	let stop_thread = stop.clone();
	let shared_thread = shared.clone();
	let cwd_thread = cwd.to_path_buf();
	let scope_thread = scope.to_vec();
	let id_thread = task_id.to_string();
	thread::spawn(move || watch_loop(shared_thread, cwd_thread, scope_thread, id_thread, stop_thread));
	Watch { stop }
}

struct Sandbox {
	command: PathBuf,
	args: Vec<String>,
	env: Vec<(String, String)>,
}

fn sandbox_invocation(invocation: Invocation, request: &Value, task_dir: &Path, layout: &Layout, git: &GitMounts, scratch: &[String]) -> Result<Sandbox, String> {
	let bwrap = resolve_on_path("bwrap").ok_or_else(|| "Required executable is missing: bwrap".to_string())?;
	let provider = request["provider"].as_str().unwrap_or("pi");
	let project = PathBuf::from(request["cwd"].as_str().unwrap_or(""));
	let home = home_dir();
	let config = pi_config_dir();
	let mut args: Vec<String> = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--cap-drop", "ALL"]
		.iter()
		.map(|item| item.to_string())
		.collect();
	for dir in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"] {
		if Path::new(dir).exists() {
			args.extend(["--ro-bind".to_string(), dir.to_string(), dir.to_string()]);
		}
	}
	args.extend(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run"].iter().map(|item| item.to_string()));
	for dir in ["/run/systemd/resolve"] {
		if Path::new(dir).exists() {
			args.extend(["--ro-bind".to_string(), dir.to_string(), dir.to_string()]);
		}
	}
	args.extend(["--bind".to_string(), task_dir.join("home").display().to_string(), home.display().to_string()]);
	for rel in [format!("{config}/agent/install"), format!("{config}/agent/bin")] {
		let target = home.join(&rel);
		if let Some(real) = real_path(&target) {
			args.extend(["--ro-bind".to_string(), real.display().to_string(), target.display().to_string()]);
		}
	}
	let mut bin_dirs: Vec<String> = vec![invocation.command.display().to_string()];
	if let Some(parent) = invocation.command.parent() {
		bin_dirs[0] = parent.display().to_string();
	}
	let exe = std::env::current_exe().map_err(|error| error.to_string())?;
	if let Some(parent) = exe.parent() {
		bin_dirs.push(parent.display().to_string());
	}
	let mut mounted: Vec<PathBuf> = Vec::new();
	let mut targets: Vec<PathBuf> = vec![invocation.command.clone(), exe.clone()];
	if let Some(real) = real_path(&invocation.command) {
		targets.push(real);
	}
	if let Some(real) = real_path(&exe) {
		targets.push(real);
	}
	for target in targets {
		let Some(mount) = tool_mount(&target) else { continue };
		if mounted.contains(&mount) || under(&mount, &project) || under(&project, &mount) {
			continue;
		}
		mounted.push(mount.clone());
		args.extend(["--ro-bind".to_string(), mount.display().to_string(), mount.display().to_string()]);
	}
	let core = core_dir()?;
	args.extend([
		"--ro-bind".to_string(),
		core.join("bridge").display().to_string(),
		"/delegate".to_string(),
	]);
	if provider == "claude" {
		if let Some(hook) = claude_hook_binary() {
			args.extend(["--ro-bind".to_string(), hook.display().to_string(), "/child-claude".to_string()]);
		}
	}
	args.extend([
		"--ro-bind".to_string(),
		task_dir.join("ipc").display().to_string(),
		"/delegate-ipc".to_string(),
	]);
	args.extend(workspace_args(&project, layout, git, scratch));
	let mut seen: Vec<String> = Vec::new();
	let bind = |args: &mut Vec<String>, seen: &mut Vec<String>, source: &Path, target: String| {
		let key = format!("{}\0{target}", source.display());
		if seen.contains(&key) {
			return;
		}
		seen.push(key);
		args.extend(["--ro-bind".to_string(), source.display().to_string(), target]);
	};
	let pkg = std::env::var("DELEGATE_PI_PACKAGE_DIR").ok().and_then(|value| real_path(Path::new(&value)));
	let entry = pi_entry().and_then(|value| real_path(Path::new(&value)));
	if let Some(pkg) = pkg.as_ref() {
		bind(&mut args, &mut seen, pkg, "/delegate-pi-package".to_string());
	}
	if let Some(entry) = entry.as_ref() {
		let inside = pkg.as_ref().map(|value| under(entry, value)).unwrap_or(false);
		if !inside {
			bind(&mut args, &mut seen, entry, "/delegate-pi-entry.mjs".to_string());
		}
	}
	let tasks = real_path(&data_dir().join("tasks"));
	let projects = real_path(&data_dir().join("projects"));
	for asset in [Some(core.clone()), entry.clone(), tasks, projects].into_iter().flatten() {
		if asset == project {
			continue;
		}
		if under(&asset, &project) {
			let rel = asset.strip_prefix(&project).unwrap_or(&asset);
			bind(&mut args, &mut seen, &asset, format!("/workspace/{}", rel.display()));
		}
	}
	let mut child_args = invocation.args.clone();
	if let Some(entry_env) = pi_entry() {
		let entry_real = real_path(Path::new(&entry_env));
		if provider == "pi" && !child_args.is_empty() && child_args[0] == entry_env {
			if let (Some(pkg), Some(entry_real)) = (pkg.as_ref(), entry_real.as_ref()) {
				if under(entry_real, pkg) {
					let rel = entry_real.strip_prefix(pkg).unwrap_or(entry_real);
					child_args[0] = format!("/delegate-pi-package/{}", rel.display());
				}
			}
		}
	}
	let mut path_parts: Vec<String> = bin_dirs
		.into_iter()
		.chain([
			format!("{}/{config}/agent/bin", home.display()),
			format!("{}/.local/bin", home.display()),
			format!("{}/.npm-global/bin", home.display()),
			"/usr/local/bin".to_string(),
			"/usr/bin".to_string(),
			"/bin".to_string(),
		])
		.collect();
	path_parts.dedup();
	let mut env: Vec<(String, String)> = vec![
		("HOME".to_string(), home.display().to_string()),
		(
			"USER".to_string(),
			std::env::var("USER").unwrap_or_else(|_| "root".to_string()),
		),
		("PATH".to_string(), path_parts.join(":")),
		("LANG".to_string(), "C.UTF-8".to_string()),
		("TERM".to_string(), "dumb".to_string()),
		("TMPDIR".to_string(), "/tmp".to_string()),
		("DELEGATE_DEPTH".to_string(), "1".to_string()),
		(
			"DELEGATE_PERMISSION_MODE".to_string(),
			request["runtimeMode"].as_str().unwrap_or("approval-required").to_string(),
		),
		("DELEGATE_SOCKET".to_string(), "/delegate-ipc/control.sock".to_string()),
		("DISABLE_AUTOUPDATER".to_string(), "1".to_string()),
		("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(), "1".to_string()),
		("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
	];
	if provider == "pi" {
		env.push((
			"DELEGATE_PI_CODING_AGENT_DIR".to_string(),
			home.join(&config).join("agent").display().to_string(),
		));
	}
	for key in provider_keys(provider) {
		if let Ok(value) = std::env::var(&key) {
			env.push((key, value));
		}
	}
	let mut final_args = args;
	final_args.push("--".to_string());
	final_args.push(invocation.command.display().to_string());
	final_args.extend(child_args);
	Ok(Sandbox { command: bwrap, args: final_args, env })
}

fn spawn_child(sandbox: &Sandbox, project: &Path) -> std::io::Result<Child> {
	let mut command = Command::new(&sandbox.command);
	command.args(&sandbox.args);
	command.current_dir(project);
	command.env_clear();
	for (key, value) in &sandbox.env {
		command.env(key, value);
	}
	command.stdin(Stdio::null());
	command.stdout(Stdio::piped());
	command.stderr(Stdio::piped());
	unsafe {
		command.pre_exec(|| {
			libc::setsid();
			Ok(())
		});
	}
	command.spawn()
}

fn tick(shared: &Shared, timeout_ms: i64, no_progress_ms: i64, budget: f64) {
	let mut inner = match shared.lock() {
		Ok(guard) => guard,
		Err(_) => return,
	};
	if SIGNALLED.load(Ordering::SeqCst) {
		inner.stop("cancelled");
	}
	if inner.dir.join("cancel.json").exists() {
		inner.stop("cancelled");
	}
	if inner.stop.is_none() && budget > 0.0 && inner.usage("contextTokens") > budget {
		let tokens = inner.usage("contextTokens");
		inner.errors = format!("Context budget reached: the child carried {tokens} tokens in one request, above the budget of {budget}. Its changes stay in the project. Continue with a new child on the same scope after accept.");
		inner.stop("blocked");
	}
	let now = now_ms();
	let waiting = inner.state["pending"].as_array().map(|items| !items.is_empty()).unwrap_or(false);
	if waiting {
		inner.last_output = now;
	} else {
		inner.active_ms += now - inner.last_tick;
	}
	inner.last_tick = now;
	if inner.stop.is_none() && inner.active_ms > timeout_ms {
		inner.stop("timed_out");
	}
	if inner.stop.is_none() && now - inner.last_output > no_progress_ms {
		let seconds = ((no_progress_ms as f64) / 1000.0).round() as i64;
		let last = if inner.errors.is_empty() {
			"(none)".to_string()
		} else {
			tail(&inner.errors, 500)
		};
		inner.errors = format!("No child output for {seconds}s. Last output: {last}");
		inner.stop("failed");
	}
	if inner.stop.is_some() && inner.stopped_at.is_none() {
		inner.stopped_at = Some(now);
		if let Some(pid) = inner.child {
			unsafe {
				libc::kill(-(pid as i32), libc::SIGTERM);
			}
		}
	}
	if let Some(at) = inner.stopped_at {
		if now - at > 2000 {
			if let Some(pid) = inner.child {
				unsafe {
					libc::kill(-(pid as i32), libc::SIGKILL);
				}
			}
		}
	}
	inner.beat(now);
	inner.save();
}

fn finalize_queued(
	shared: &Shared,
	project: &Path,
	id: &str,
	scope_held: bool,
	slot_held: bool,
	status: &str,
	summary: &str,
) {
	if slot_held {
		release_slot(project, id);
	}
	if scope_held {
		let _ = release_scope(project, id);
	}
	let Ok(mut inner) = shared.lock() else { return };
	inner.state["status"] = json!(status);
	inner.state["summary"] = json!(tail(summary, TEXT_CAP));
	inner.state["pending"] = json!([]);
	if scope_held {
		inner.state["scopeHeld"] = json!(false);
	}
	let finished = now_ms();
	let started = inner.state["startedAt"]
		.as_i64()
		.or_else(|| inner.state["createdAt"].as_i64())
		.unwrap_or(finished);
	inner.state["durationMs"] = json!(finished - started);
	inner.state["finishedAt"] = json!(finished);
	inner.save();
}

fn run(id: &str) -> Result<(), String> {
	let dir = data_dir().join("tasks").join(id);
	let request = read_json(&dir.join("request.json"))?;
	let state = read_json(&dir.join("state.json"))?;
	let shared: Shared = Arc::new(Mutex::new(Inner {
		dir: dir.clone(),
		state,
		last: String::new(),
		output: String::new(),
		errors: String::new(),
		activity: Vec::new(),
		seen: HashMap::new(),
		stop: None,
		child: None,
		log_partial: String::new(),
		parse_buffer: String::new(),
		log_bytes: 0,
		log_fd: None,
		active_ms: 0,
		last_output: now_ms(),
		last_tick: now_ms(),
		started_at: 0,
		stopped_at: None,
		denied: false,
		provider_error: false,
		open_questions: HashSet::new(),
	}));
	{
		let mut inner = shared.lock().unwrap();
		inner.state["workerPid"] = json!(std::process::id());
		inner.state["heartbeat"] = json!(now_ms());
		inner.save();
	}
	unsafe {
		libc::signal(libc::SIGTERM, on_signal as *const () as usize as libc::sighandler_t);
		libc::signal(libc::SIGINT, on_signal as *const () as usize as libc::sighandler_t);
	}
	let done = Arc::new(AtomicBool::new(false));
	let scope: Vec<String> = request["scope"]
		.as_array()
		.map(|items| items.iter().filter_map(|item| item.as_str().map(|value| value.to_string())).collect())
		.unwrap_or_default();
	let provider = request["provider"].as_str().unwrap_or("pi").to_string();
	let timeout_ms = request["timeoutMs"].as_i64().unwrap_or(900_000);
	let no_progress_ms = request["noProgressMs"]
		.as_i64()
		.or_else(|| std::env::var("DELEGATE_NO_PROGRESS_MS").ok().and_then(|value| value.parse().ok()))
		.unwrap_or(600_000);
	let budget = request["contextBudget"].as_f64().unwrap_or(0.0);
	let project = PathBuf::from(request["cwd"].as_str().unwrap_or(""));
	let layout = scope_layout(&project, &scope);
	let git = git_mounts(&project);
	let scratch: Vec<String> = request["scratch"]
		.as_array()
		.map(|items| items.iter().filter_map(|item| item.as_str().map(|value| value.to_string())).collect())
		.unwrap_or_default();
	let mut scope_held = false;
	let mut slot_held = false;
	let mut snapshot_taken = false;
	let mut ignored_before: Vec<String> = Vec::new();
	let mut ipc: Option<Ipc> = None;
	let parent_listing = list_parents(&project, &layout);
	let result = (|| -> Result<(), String> {
		if !scope.is_empty() {
			let queued_at = now_ms();
			loop {
				let blocking = acquire_scope(&project, id, &scope, &dir)?;
				if blocking.is_empty() {
					break;
				}
				{
					let mut inner = shared.lock().unwrap();
					inner.state["status"] = json!("queued");
					inner.state["queuedBehind"] = json!(blocking);
					inner.state["summary"] = json!(format!(
						"Queued: the scope overlaps task {}. It starts when that task completes, or when the parent accepts or undoes it.",
						blocking.join(", ")
					));
					inner.save();
				}
				if dir.join("cancel.json").exists() {
					finalize_queued(
						&shared,
						&project,
						id,
						scope_held,
						slot_held,
						"cancelled",
						"Stopped while queued: cancelled",
					);
					return Ok(());
				}
				if now_ms() - queued_at > timeout_ms {
					let summary = format!("Queued for more than {}s behind the scope of another task", timeout_ms / 1000);
					finalize_queued(&shared, &project, id, scope_held, slot_held, "timed_out", &summary);
					return Ok(());
				}
				thread::sleep(Duration::from_millis(500));
			}
			scope_held = true;
			{
				let mut inner = shared.lock().unwrap();
				inner.state["scopeHeld"] = json!(true);
				if let Some(map) = inner.state.as_object_mut() {
					map.remove("queuedBehind");
				}
				inner.save();
			}
		}
		let queued_slot_at = now_ms();
		loop {
			let blocking = acquire_slot(&project, id, &dir, 4)?;
			if blocking.is_empty() {
				break;
			}
			{
				let mut inner = shared.lock().unwrap();
				inner.state["status"] = json!("queued");
				inner.state["queuedBehind"] = json!(blocking);
				inner.state["summary"] = json!(format!(
					"Queued: this workspace already runs {} children, the maximum of 4. It starts when a running child stops, or when the parent cancels it.",
					blocking.len()
				));
				inner.save();
			}
			if dir.join("cancel.json").exists() {
				finalize_queued(
					&shared,
					&project,
					id,
					scope_held,
					slot_held,
					"cancelled",
					"Stopped while queued: cancelled",
				);
				return Ok(());
			}
			if now_ms() - queued_slot_at > timeout_ms {
				let summary = format!("Queued for more than {}s waiting for a free child slot", timeout_ms / 1000);
				finalize_queued(&shared, &project, id, scope_held, slot_held, "timed_out", &summary);
				return Ok(());
			}
			thread::sleep(Duration::from_millis(500));
		}
		slot_held = true;
		if !scope.is_empty() {
			snapshot(&project, &scope, id, "before", &dir)?;
			ignored_before = ignored_paths(&project, &scope)?.skipped;
			let mut inner = shared.lock().unwrap();
			inner.state["snapshot"] = json!(true);
			inner.save();
			snapshot_taken = true;
		}
		ipc = Some(start_ipc(&shared, &dir, &project, id)?);
		prepare_home(&dir.join("home"), &provider)?;
		let invocation = build_invocation(&request, &scope)?;
		let sandbox = sandbox_invocation(invocation, &request, &dir, &layout, &git, &scratch)?;
		{
			let mut inner = shared.lock().unwrap();
			inner.started_at = now_ms();
			inner.state["status"] = json!("running");
			inner.state["startedAt"] = json!(inner.started_at);
			inner.state["summary"] = json!("Running inside the filesystem sandbox");
			inner.state["logPath"] = json!(dir.join("output.log").display().to_string());
			inner.open_log();
			inner.save();
		}
		let project = PathBuf::from(request["cwd"].as_str().unwrap_or(""));
		let watcher = if snapshot_taken { Some(start_watcher(&shared, &project, &scope, id)) } else { None };
		let mut child = spawn_child(&sandbox, &project).map_err(|error| format!("spawn: {error}"))?;
		let pid = child.id();
		{
			let mut inner = shared.lock().unwrap();
			inner.child = Some(pid);
			inner.state["childPid"] = json!(pid);
			inner.last_output = now_ms();
			inner.last_tick = now_ms();
			inner.save();
		}
		if let Some(stderr) = child.stderr.take() {
			let shared = shared.clone();
			thread::spawn(move || {
				let reader = BufReader::new(stderr);
				for line in reader.lines() {
					let Ok(line) = line else { break };
					let text = format!("{line}\n");
					if let Ok(mut inner) = shared.lock() {
						inner.log(&text);
						inner.push_error(&text);
					}
				}
			});
		}
		{
			let shared = shared.clone();
			let done = done.clone();
			thread::spawn(move || loop {
				thread::sleep(Duration::from_millis(100));
				if done.load(Ordering::SeqCst) {
					break;
				}
				tick(&shared, timeout_ms, no_progress_ms, budget);
			});
		}
		let stdout = child.stdout.take().ok_or_else(|| "no child stdout".to_string())?;
		let mut reader = BufReader::new(stdout);
		let mut buffer: Vec<u8> = Vec::new();
		loop {
			buffer.clear();
			let read = reader.read_until(b'\n', &mut buffer).map_err(|error| error.to_string())?;
			if read == 0 {
				break;
			}
			let text = String::from_utf8_lossy(&buffer).to_string();
			let mut inner = shared.lock().unwrap();
			inner.last_output = now_ms();
			inner.state["lastOutputAt"] = json!(now_ms() / 1000 * 1000);
			inner.log(&text);
			inner.parse_buffer.push_str(&text);
			if inner.parse_buffer.len() > LINE_CAP {
				inner.push_error("Child output line exceeded 4 MiB");
				inner.stop("failed");
				inner.parse_buffer.clear();
				continue;
			}
			let mut lines: Vec<String> = Vec::new();
			while let Some(index) = inner.parse_buffer.find('\n') {
				lines.push(inner.parse_buffer[..index].to_string());
				inner.parse_buffer.drain(..=index);
			}
			for line in lines {
				parse_line(&mut inner, &line, &provider);
			}
		}
		let status = child.wait().map_err(|error| error.to_string())?;
		let code = match status.code() {
			Some(code) => code,
			None => 128,
		};
		let mut inner = shared.lock().unwrap();
		let pending = std::mem::take(&mut inner.parse_buffer);
		if !pending.trim().is_empty() {
			parse_line(&mut inner, &pending, &provider);
		}
		inner.state["exitCode"] = json!(code);
		let blocked = inner.denied || inner.output.trim_start().to_lowercase().starts_with("blocked");
		let reason = inner.stop.clone();
		let final_status = match reason.as_deref() {
			Some(value) => value.to_string(),
			None if code != 0 || inner.provider_error => "failed".to_string(),
			None if blocked => "blocked".to_string(),
			None => "completed".to_string(),
		};
		let summary = if final_status == "failed" || final_status == "blocked" {
			if !inner.errors.is_empty() {
				inner.errors.clone()
			} else {
				inner.output.clone()
			}
		} else if !inner.output.is_empty() {
			inner.output.clone()
		} else if !inner.errors.is_empty() {
			inner.errors.clone()
		} else {
			final_status.clone()
		};
		inner.state["status"] = json!(final_status);
		inner.state["summary"] = json!(tail(&summary, TEXT_CAP));
		inner.state["pending"] = json!([]);
		if snapshot_taken {
			match snapshot(&project, &scope, id, "after", &dir) {
				Ok(_) => {
					inner.state["diffstat"] = json!(diffstat(&project, id, &scope));
					let stray = stray_files(&project, &scope, &parent_listing, id);
					if !stray.is_empty() {
						inner.state["strayFiles"] = json!(stray);
						let note = format!(
							"[delegate] New paths next to the file scope, outside the scope, not in the snapshot and not removed by undo: {}",
							stray.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
						);
						let summary = format!("{}\n{note}", inner.state["summary"].as_str().unwrap_or(""));
						inner.state["summary"] = json!(tail(&summary, TEXT_CAP));
					}
					let ignored = ignored_paths(&project, &scope).map(|value| value.skipped).unwrap_or_default();
					let fresh: Vec<String> = ignored.into_iter().filter(|rel| !ignored_before.contains(rel)).collect();
					if !fresh.is_empty() {
						inner.state["ignoredPaths"] = json!(fresh);
						let note = format!(
							"[delegate] New git-ignored paths in the scope, too large for the snapshot and not removed by undo: {}",
							fresh.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
						);
						let summary = format!("{}\n{note}", inner.state["summary"].as_str().unwrap_or(""));
						inner.state["summary"] = json!(tail(&summary, TEXT_CAP));
					}
				}
				Err(error) => {
					let summary = format!("{}\n[delegate] The after snapshot failed: {error}", inner.state["summary"].as_str().unwrap_or(""));
					inner.state["summary"] = json!(tail(&summary, TEXT_CAP));
				}
			}
		}
		let settled = inner.state["status"].as_str().unwrap_or("").to_string();
		if slot_held {
			release_slot(&project, id);
		}
		if scope_held && (settled == "completed" || !snapshot_taken) {
			let _ = release_scope(&project, id);
			inner.state["scopeHeld"] = json!(false);
		}
		if settled == "completed" {
			let _ = release_claims(&project, id);
		}
		let finished = now_ms();
		let started = inner.state["startedAt"].as_i64().unwrap_or(inner.state["createdAt"].as_i64().unwrap_or(finished));
		inner.state["durationMs"] = json!(finished - started);
		inner.state["finishedAt"] = json!(finished);
		if let Some(watcher) = watcher.as_ref() {
			watcher.stop.store(true, Ordering::SeqCst);
		}
		inner.save();
		Ok(())
	})();
	if let Some(ipc) = ipc.take() {
		ipc.stop.store(true, Ordering::SeqCst);
		let _ = fs::remove_file(&ipc.alias);
	}
	let mut inner = shared.lock().unwrap();
	if let Some(tail_text) = compact_log_line(&inner.log_partial) {
		if let Some(handle) = inner.log_fd.as_mut() {
			let _ = writeln!(handle, "{tail_text}");
		}
	}
	inner.log_fd = None;
	done.store(true, Ordering::SeqCst);
	match result {
		Ok(()) => {}
		Err(error) => {
			inner.stop = Some("failed".to_string());
			inner.state["status"] = json!("failed");
			inner.state["summary"] = json!(tail(&error, TEXT_CAP));
			inner.state["pending"] = json!([]);
			inner.save();
		}
	}
	let _ = close_home(&inner.dir);
	Ok(())
}

fn main() {
	let args: Vec<String> = std::env::args().collect();
	if args.len() < 2 {
		eprintln!("usage: delegate-worker TASK_ID");
		std::process::exit(2);
	}
	if !valid_id(&args[1]) {
		eprintln!("Invalid task ID");
		std::process::exit(2);
	}
	if let Err(error) = run(&args[1]) {
		eprintln!("delegate-worker: {error}");
		std::process::exit(1);
	}
}
