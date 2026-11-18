use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Worker {
    root: PathBuf,
    project: PathBuf,
    task: PathBuf,
    child: Child,
}

impl Worker {
    fn start(pi: &str) -> Self {
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let root = std::env::temp_dir().join(format!("pi-worker-rpc-{pid}-{sequence}"));
        let id = format!("00000000-0000-4000-8000-{pid:08x}{sequence:04x}");
        let project = root.join("project");
        let data = root.join("data");
        let task = data.join("tasks").join(&id);
        let bin = root.join("bin");
        for dir in [&project, &task, &bin, &root.join("home")] {
            fs::create_dir_all(dir).unwrap();
        }
        executable(&bin.join("pi"), pi);
        executable(
            &bin.join("bwrap"),
            "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift || exit 90; done\nshift\nexec \"$@\"\n",
        );
        fs::write(
            task.join("request.json"),
            json!({"provider": "pi", "cwd": project, "task": "initial task", "scope": [], "noProgressMs": 6000}).to_string(),
        )
        .unwrap();
        fs::write(
            task.join("state.json"),
            r#"{"status":"queued","pending":[]}"#,
        )
        .unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_delegate-worker"))
            .arg(id)
            .env_clear()
            .env("HOME", root.join("home"))
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("TMPDIR", &root)
            .env("DELEGATE_CORE_DIR", root.join("core"))
            .env("DELEGATE_DATA", data)
            .spawn()
            .unwrap();
        Self {
            root,
            project,
            task,
            child,
        }
    }

    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.task.join("state.json")).unwrap()).unwrap()
    }

    fn wait_for<T>(&mut self, label: &str, mut get: impl FnMut(&Self) -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            if let Some(value) = get(self) {
                return value;
            }
            if self.child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                return get(self)
                    .unwrap_or_else(|| panic!("did not observe {label}: {}", self.state()));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn command(&mut self, name: &str) -> Value {
        self.wait_for(name, |worker| {
            serde_json::from_slice(&fs::read(worker.project.join(name)).ok()?).ok()
        })
    }

    fn queue_steer(&self, message: &str) {
        let temp = self.task.join("steer.tmp");
        fs::write(&temp, json!({"message": message, "at": 1}).to_string()).unwrap();
        fs::rename(temp, self.task.join("steer.json")).unwrap();
    }

    fn finish(&mut self) -> Value {
        self.wait_for("finished task", |worker| {
            let state = worker.state();
            state["finishedAt"].is_number().then_some(state)
        })
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let state = self.state();
        if state["finishedAt"].is_null() {
            if let Some(pid) = state["childPid"].as_i64() {
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
            }
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn delivers_steering_and_counts_only_the_matching_acknowledgement() {
    let mut worker = Worker::start(
        r#"#!/bin/sh
[ "$1" = --mode ] && [ "$2" = rpc ] || exit 11
IFS= read -r prompt || exit 12
printf '%s\n' "$prompt" > prompt.json
printf '%s\n' '{"type":"response","id":"start","command":"prompt","success":true}'
IFS= read -r steer || exit 13
printf '%s\n' "$steer" > steer-command.json
contents=${steer#*\"message\":}
contents=${contents%,\"type\":\"steer\"\}}
printf '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":%s}]}}\n' "$contents"
id=${steer#*\"id\":\"}
id=${id%%\"*}
printf '%s\n' '{"type":"response","id":"unrelated","command":"steer","success":true}'
while [ ! -f allow-ack ]; do sleep 0.02; done
printf '{"type":"response","id":"%s","command":"steer","success":true}\n' "$id"
IFS= read -r steer || exit 13
id=${steer#*\"id\":\"}
id=${id%%\"*}
printf '{"type":"response","id":"%s","command":"steer","success":false}\n' "$id"
while [ ! -f allow-settle ]; do sleep 0.02; done
printf '%s\n' '{"type":"agent_settled"}'
if IFS= read -r extra; then exit 14; fi
"#,
    );
    let prompt = worker.command("prompt.json");
    assert_eq!(prompt["type"], "prompt");
    assert!(prompt["message"]
        .as_str()
        .unwrap()
        .ends_with("Task: initial task"));
    let message = format!("take the other path\n{}", "日本語".repeat(1300));
    worker.queue_steer(&message);
    let steer = worker.command("steer-command.json");
    assert_eq!(steer["type"], "steer");
    assert_eq!(steer["message"], message);
    assert_eq!(worker.state()["steers"].as_u64().unwrap_or(0), 0);
    fs::write(worker.project.join("allow-ack"), "").unwrap();
    worker.wait_for("steering acknowledgement", |worker| {
        (worker.state()["steers"] == 1).then_some(())
    });
    assert!(!worker.task.join("steer.json").exists());
    worker.queue_steer("This instruction is rejected");
    worker.wait_for("steering rejection", |worker| {
        (worker.state()["steerError"] == "Pi rejected the steering request.").then_some(())
    });
    assert!(!worker.task.join("steer.json").exists());
    fs::write(worker.project.join("allow-settle"), "").unwrap();
    let state = worker.finish();
    assert_eq!(state["status"], "completed");
    assert_eq!(state["steers"], 1);
}

#[test]
fn a_rejected_prompt_closes_stdin_without_waiting_for_a_timeout() {
    let mut worker = Worker::start(
        r#"#!/bin/sh
[ "$1" = --mode ] && [ "$2" = rpc ] || exit 11
IFS= read -r prompt || exit 12
printf '%s\n' '{"type":"response","id":"start","command":"prompt","success":false,"error":"Fixture rejected prompt"}'
if IFS= read -r extra; then exit 14; fi
"#,
    );
    let state = worker.finish();
    assert_eq!(state["status"], "failed");
    assert_eq!(state["exitCode"], 0);
    assert_eq!(state["summary"], "Fixture rejected prompt");
}
