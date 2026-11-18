mod support;

use std::time::Duration;

use pi_web::engine::{Engine, ExitReason};
use pi_web::frame_reader::{FrameReader, LineRead};
use pi_web::operations::WebHandler;
use serde_json::{json, Value};
use support::{TestResponse, TestServer};
use tokio::io::{duplex, AsyncWriteExt, DuplexStream};

struct EngineClient {
    engine: tokio::task::JoinHandle<ExitReason>,
    input: DuplexStream,
    output: FrameReader<DuplexStream>,
}

impl EngineClient {
    async fn start() -> Self {
        let (engine_input, input) = duplex(1 << 20);
        let (output, engine_output) = duplex(1 << 20);
        let handler = WebHandler::new().unwrap();
        let engine = tokio::spawn(Engine::new(handler).run(engine_input, engine_output));
        let mut client = EngineClient {
            engine,
            input,
            output: FrameReader::new(output),
        };
        assert_eq!(client.receive().await["type"], json!("ready"));
        client
    }

    async fn send(&mut self, frame: Value) {
        let mut line = frame.to_string().into_bytes();
        line.push(b'\n');
        self.input.write_all(&line).await.unwrap();
    }

    async fn receive(&mut self) -> Value {
        match self.output.next_frame().await {
            LineRead::Frame(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("unexpected read result: {other:?}"),
        }
    }

    async fn shutdown(mut self) -> ExitReason {
        self.send(json!({"type": "shutdown"})).await;
        self.engine.await.unwrap()
    }
}

fn request(id: &str, operation: &str, timeout_ms: u64, params: Option<Value>) -> Value {
    let mut frame = json!({
        "type": "request",
        "id": id,
        "operation": operation,
        "timeoutMs": timeout_ms
    });
    if let Some(params) = params {
        frame["params"] = params;
    }
    frame
}

async fn wait_for_path(server: &TestServer, path: &str) {
    for _ in 0..1_000 {
        if server.requests().iter().any(|request| request.path == path) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("server did not receive {path}");
}

#[tokio::test]
async fn status_lists_supported_operations() {
    let mut client = EngineClient::start().await;
    client.send(request("1", "status", 30_000, None)).await;
    let result = client.receive().await;
    assert_eq!(result["type"], json!("result"));
    assert_eq!(result["id"], json!("1"));
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
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}

#[tokio::test]
async fn performs_a_native_http_request_through_the_protocol() {
    let server = TestServer::start(|request| {
        TestResponse::json(
            200,
            &json!({"method": request.method, "path": request.path}),
        )
    });
    let mut client = EngineClient::start().await;
    client
        .send(request(
            "1",
            "http_request",
            30_000,
            Some(json!({"url": format!("{}/native", server.url())})),
        ))
        .await;
    let result = client.receive().await;
    assert_eq!(result["type"], json!("result"));
    assert_eq!(result["id"], json!("1"));
    assert_eq!(result["result"]["status"], json!(200));
    let body: Value = serde_json::from_str(result["result"]["body"].as_str().unwrap()).unwrap();
    assert_eq!(body, json!({"method": "GET", "path": "/native"}));
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}

#[tokio::test]
async fn cancels_a_slow_http_request() {
    let server =
        TestServer::start(|_| TestResponse::text(200, "late").delay(Duration::from_secs(5)));
    let mut client = EngineClient::start().await;
    client
        .send(request(
            "slow",
            "http_request",
            120_000,
            Some(json!({"url": format!("{}/slow", server.url())})),
        ))
        .await;
    wait_for_path(&server, "/slow").await;
    client.send(json!({"type": "cancel", "id": "slow"})).await;
    let frame = client.receive().await;
    assert_eq!(frame["type"], json!("error"));
    assert_eq!(frame["id"], json!("slow"));
    assert_eq!(frame["code"], json!("cancelled"));
    client.send(request("next", "status", 30_000, None)).await;
    assert_eq!(client.receive().await["id"], json!("next"));
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}

#[tokio::test]
async fn times_out_a_slow_http_request() {
    let server =
        TestServer::start(|_| TestResponse::text(200, "late").delay(Duration::from_secs(5)));
    let mut client = EngineClient::start().await;
    client
        .send(request(
            "slow",
            "http_request",
            100,
            Some(json!({"url": format!("{}/slow", server.url())})),
        ))
        .await;
    let frame = client.receive().await;
    assert_eq!(frame["type"], json!("error"));
    assert_eq!(frame["id"], json!("slow"));
    assert_eq!(frame["code"], json!("timeout"));
    client.send(request("next", "status", 30_000, None)).await;
    assert_eq!(client.receive().await["id"], json!("next"));
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}

#[tokio::test]
async fn keeps_concurrent_http_requests_isolated_when_one_is_cancelled() {
    let server = TestServer::start(|request| {
        if request.path == "/slow" {
            TestResponse::text(200, "late").delay(Duration::from_secs(5))
        } else {
            TestResponse::text(200, "fast")
        }
    });
    let mut client = EngineClient::start().await;
    client
        .send(request(
            "slow",
            "http_request",
            120_000,
            Some(json!({"url": format!("{}/slow", server.url())})),
        ))
        .await;
    client
        .send(request(
            "fast",
            "http_request",
            30_000,
            Some(json!({"url": format!("{}/fast", server.url())})),
        ))
        .await;
    wait_for_path(&server, "/slow").await;
    client.send(json!({"type": "cancel", "id": "slow"})).await;
    let mut slow_cancelled = false;
    let mut fast_done = false;
    for _ in 0..2 {
        let frame = client.receive().await;
        match frame["id"].as_str().unwrap() {
            "slow" => {
                assert_eq!(frame["code"], json!("cancelled"));
                slow_cancelled = true;
            }
            "fast" => {
                assert_eq!(frame["type"], json!("result"));
                assert_eq!(frame["result"]["body"], json!("fast"));
                fast_done = true;
            }
            other => panic!("unexpected frame for {other}"),
        }
    }
    assert!(slow_cancelled && fast_done);
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}

#[tokio::test]
async fn shutdown_cancels_a_slow_http_request() {
    let server =
        TestServer::start(|_| TestResponse::text(200, "late").delay(Duration::from_secs(5)));
    let mut client = EngineClient::start().await;
    client
        .send(request(
            "slow",
            "http_request",
            120_000,
            Some(json!({"url": format!("{}/slow", server.url())})),
        ))
        .await;
    wait_for_path(&server, "/slow").await;
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}

#[tokio::test]
async fn fetch_extracts_a_page_through_the_native_protocol() {
    let server = TestServer::start(|_| {
        TestResponse::bytes(
            200,
            "text/html",
            b"<title>Native page</title><main><p>Readable native content.</p></main>".to_vec(),
        )
    });
    let mut client = EngineClient::start().await;
    client
        .send(request(
            "fetch",
            "web_fetch",
            30_000,
            Some(json!({"url":server.url()})),
        ))
        .await;
    let frame = client.receive().await;
    assert_eq!(frame["type"], "result");
    assert_eq!(frame["id"], "fetch");
    assert_eq!(frame["result"]["access"], "ok");
    assert!(frame["result"]["content"]
        .as_str()
        .unwrap()
        .contains("Readable native content."));
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}

#[tokio::test]
async fn cancels_fetch_without_disturbing_a_concurrent_read_or_shutdown() {
    let server = TestServer::start(|request| {
        if request.path == "/slow" {
            TestResponse::text(200, "late").delay(Duration::from_secs(5))
        } else {
            TestResponse::text(200, "fast native content")
        }
    });
    let mut client = EngineClient::start().await;
    for (id, path) in [("slow", "/slow"), ("fast", "/fast")] {
        client
            .send(request(
                id,
                "web_fetch",
                30_000,
                Some(json!({"url":format!("{}{path}",server.url())})),
            ))
            .await;
    }
    wait_for_path(&server, "/slow").await;
    client.send(json!({"type":"cancel","id":"slow"})).await;
    let mut ids = Vec::new();
    for _ in 0..2 {
        let frame = client.receive().await;
        if frame["id"] == "slow" {
            assert_eq!(frame["code"], "cancelled");
        } else {
            assert_eq!(frame["result"]["content"], "fast native content");
        }
        ids.push(frame["id"].as_str().unwrap().to_string());
    }
    ids.sort();
    assert_eq!(ids, ["fast", "slow"]);
    client
        .send(request(
            "shutdown-fetch",
            "web_fetch",
            30_000,
            Some(json!({"url":format!("{}/slow",server.url())})),
        ))
        .await;
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}

#[tokio::test]
async fn fetch_honors_the_protocol_deadline() {
    let server =
        TestServer::start(|_| TestResponse::text(200, "late").delay(Duration::from_secs(5)));
    let mut client = EngineClient::start().await;
    client
        .send(request(
            "fetch",
            "web_fetch",
            100,
            Some(json!({"url":server.url()})),
        ))
        .await;
    let frame = client.receive().await;
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["id"], "fetch");
    assert_eq!(frame["code"], "timeout");
    client.send(request("next", "status", 30_000, None)).await;
    assert_eq!(client.receive().await["id"], "next");
    assert_eq!(client.shutdown().await, ExitReason::Shutdown);
}
