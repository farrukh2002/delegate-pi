use pi_web::protocol::MAX_FRAME_BYTES;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_secs(30);

struct Engine {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Option<String>>,
}

impl Engine {
    fn start() -> Engine {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-web"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn pi-web");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(Some(line)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = sender.send(None);
        });
        Engine {
            child,
            stdin: Some(stdin),
            lines,
        }
    }

    fn send(&mut self, frame: Value) {
        self.write(&format!("{frame}\n"));
    }

    fn write(&mut self, text: &str) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        stdin.write_all(text.as_bytes()).expect("write frame");
        stdin.flush().expect("flush");
    }

    fn send_detached(&mut self, bytes: Vec<u8>) {
        let mut stdin = self.stdin.take().expect("stdin open");
        thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
            let _ = stdin.flush();
        });
    }

    fn line(&self) -> Value {
        match self.lines.recv_timeout(READ_TIMEOUT) {
            Ok(Some(line)) => serde_json::from_str(&line).expect("frame is json"),
            Ok(None) => panic!("engine closed stdout"),
            Err(error) => panic!("no frame within timeout: {error}"),
        }
    }

    fn finish(mut self) -> (i32, Receiver<Option<String>>) {
        drop(self.stdin.take());
        let code = self
            .child
            .wait()
            .expect("wait for engine")
            .code()
            .expect("exit code");
        (code, self.lines)
    }
}

fn expect_closed(lines: &Receiver<Option<String>>) {
    match lines.recv_timeout(READ_TIMEOUT) {
        Ok(None) => {}
        Ok(Some(line)) => panic!("unexpected frame after exit: {line}"),
        Err(error) => panic!("engine did not close stdout: {error}"),
    }
}

#[test]
fn ready_status_and_shutdown() {
    let mut engine = Engine::start();
    let ready = engine.line();
    assert_eq!(ready["type"], json!("ready"));
    assert_eq!(ready["protocolVersion"], json!(1));
    assert_eq!(ready["engineVersion"], json!("0.1.0"));

    engine.send(json!({"type": "request", "id": "1", "operation": "status", "timeoutMs": 30000}));
    let result = engine.line();
    assert_eq!(result["type"], json!("result"));
    assert_eq!(result["id"], json!("1"));
    assert_eq!(result["result"]["engineVersion"], json!("0.1.0"));
    assert_eq!(result["result"]["protocolVersion"], json!(1));
    assert_eq!(
        result["result"]["operations"],
        json!([
            "status",
            "http_request",
            "web_search",
            "web_fetch",
            "git_index",
            "git_search",
            "git_read"
        ])
    );

    engine.send(json!({"type": "shutdown"}));
    let (code, lines) = engine.finish();
    assert_eq!(code, 0);
    expect_closed(&lines);
}

#[test]
fn invalid_frame_keeps_connection_open() {
    let mut engine = Engine::start();
    engine.line();
    engine.write("not json\n");
    let error = engine.line();
    assert_eq!(error["type"], json!("error"));
    assert_eq!(error["id"], json!(null));
    assert_eq!(error["code"], json!("invalid_request"));

    engine
        .send(json!({"type": "request", "id": "after", "operation": "status", "timeoutMs": 1000}));
    let result = engine.line();
    assert_eq!(result["type"], json!("result"));
    assert_eq!(result["id"], json!("after"));

    let (code, lines) = engine.finish();
    assert_eq!(code, 0);
    expect_closed(&lines);
}

#[test]
fn oversized_frame_terminates_engine() {
    let mut engine = Engine::start();
    engine.line();
    let mut payload = vec![b' '; MAX_FRAME_BYTES + 1];
    payload.push(b'\n');
    engine.send_detached(payload);
    let error = engine.line();
    assert_eq!(error["type"], json!("error"));
    assert_eq!(error["id"], json!(null));
    assert_eq!(error["code"], json!("invalid_request"));

    let (code, lines) = engine.finish();
    assert_eq!(code, 1);
    expect_closed(&lines);
}
