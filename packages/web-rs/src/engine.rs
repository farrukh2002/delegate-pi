use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

use crate::frame_reader::{FrameReader, LineRead};
use crate::frame_writer::FrameWriter;
use crate::protocol::{
    parse_frame, ErrorCode, Frame, Inbound, ENGINE_VERSION, MAX_ACTIVE_REQUESTS, PROTOCOL_VERSION,
};

pub type OperationFuture = Pin<Box<dyn Future<Output = OperationOutcome> + Send>>;

pub enum OperationOutcome {
    Result(Value),
    Error(ErrorCode),
}

pub trait OperationHandler: Send + Sync + 'static {
    fn operations(&self) -> &'static [&'static str];
    fn start(&self, operation: &str, params: Option<Value>) -> OperationFuture;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExitReason {
    Eof,
    Shutdown,
    OversizedFrame,
    WriteFailed,
}

impl ExitReason {
    pub fn exit_code(self) -> i32 {
        match self {
            ExitReason::Eof | ExitReason::Shutdown => 0,
            ExitReason::OversizedFrame | ExitReason::WriteFailed => 1,
        }
    }
}

enum RequestState {
    Running,
    Responding,
}

struct ActiveRequest {
    handle: JoinHandle<()>,
    state: RequestState,
}

pub struct Engine<H: OperationHandler> {
    handler: Arc<H>,
    active: Mutex<HashMap<String, ActiveRequest>>,
    write_failed: Notify,
}

impl<H: OperationHandler> Engine<H> {
    pub fn new(handler: H) -> Self {
        Engine {
            handler: Arc::new(handler),
            active: Mutex::new(HashMap::new()),
            write_failed: Notify::new(),
        }
    }

    pub async fn run<R, W>(self, input: R, output: W) -> ExitReason
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let engine = Arc::new(self);
        let writer = Arc::new(FrameWriter::new(output));
        let ready = Frame::Ready {
            protocol_version: PROTOCOL_VERSION,
            engine_version: ENGINE_VERSION,
        };
        if writer.send(&ready).await.is_err() {
            return ExitReason::WriteFailed;
        }
        let mut reader = FrameReader::new(input);
        loop {
            let frame = tokio::select! {
                biased;
                _ = engine.write_failed.notified() => {
                    engine.cancel_all().await;
                    return ExitReason::WriteFailed;
                }
                frame = reader.next_frame() => frame,
            };
            match frame {
                LineRead::Frame(bytes) => match parse_frame(&bytes) {
                    Inbound::Request {
                        id,
                        operation,
                        timeout_ms,
                        params,
                    } => {
                        engine
                            .accept(&writer, id, operation, timeout_ms, params)
                            .await
                    }
                    Inbound::Cancel { id } => engine.cancel(&writer, &id).await,
                    Inbound::Shutdown => {
                        engine.cancel_all().await;
                        return ExitReason::Shutdown;
                    }
                    Inbound::Invalid { id } => {
                        let frame = Frame::error(id.as_deref(), ErrorCode::InvalidRequest);
                        if writer.send(&frame).await.is_err() {
                            engine.cancel_all().await;
                            return ExitReason::WriteFailed;
                        }
                    }
                },
                LineRead::Oversized => {
                    let frame = Frame::error(None, ErrorCode::InvalidRequest);
                    let _ = writer.send(&frame).await;
                    engine.cancel_all().await;
                    return ExitReason::OversizedFrame;
                }
                LineRead::Eof => {
                    engine.cancel_all().await;
                    return ExitReason::Eof;
                }
            }
        }
    }

    async fn accept<W>(
        self: &Arc<Self>,
        writer: &Arc<FrameWriter<W>>,
        id: String,
        operation: String,
        timeout_ms: u64,
        params: Option<Value>,
    ) where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let mut active = self.active.lock().await;
        if active.contains_key(&id) {
            drop(active);
            self.respond(writer, &Frame::error(None, ErrorCode::InvalidRequest))
                .await;
            return;
        }
        if !self.handler.operations().contains(&operation.as_str()) {
            drop(active);
            self.respond(
                writer,
                &Frame::error(Some(&id), ErrorCode::UnsupportedOperation),
            )
            .await;
            return;
        }
        if active.len() >= MAX_ACTIVE_REQUESTS {
            drop(active);
            self.respond(writer, &Frame::error(Some(&id), ErrorCode::Busy))
                .await;
            return;
        }
        let engine = Arc::clone(self);
        let writer = Arc::clone(writer);
        let request_id = id.clone();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        let handle = tokio::spawn(async move {
            let outcome =
                tokio::time::timeout_at(deadline, engine.handler.start(&operation, params)).await;
            if tokio::time::Instant::now() >= deadline {
                engine
                    .settle(
                        &writer,
                        &request_id,
                        Frame::error(Some(&request_id), ErrorCode::Timeout),
                    )
                    .await;
                return;
            }
            match outcome {
                Ok(OperationOutcome::Result(value)) => {
                    let frame = Frame::Result {
                        id: &request_id,
                        result: &value,
                    };
                    engine.settle(&writer, &request_id, frame).await;
                }
                Ok(OperationOutcome::Error(code)) => {
                    let frame = Frame::error(Some(&request_id), code);
                    engine.settle(&writer, &request_id, frame).await;
                }
                Err(_) => {
                    let frame = Frame::error(Some(&request_id), ErrorCode::Timeout);
                    engine.settle(&writer, &request_id, frame).await;
                }
            }
        });
        active.insert(
            id,
            ActiveRequest {
                handle,
                state: RequestState::Running,
            },
        );
    }

    async fn settle<W>(self: &Arc<Self>, writer: &Arc<FrameWriter<W>>, id: &str, frame: Frame<'_>)
    where
        W: AsyncWrite + Unpin,
    {
        let mut active = self.active.lock().await;
        if let Some(request) = active.get_mut(id) {
            request.state = RequestState::Responding;
            drop(active);
            self.respond(writer, &frame).await;
            self.active.lock().await.remove(id);
        }
    }

    async fn cancel<W>(self: &Arc<Self>, writer: &Arc<FrameWriter<W>>, id: &str)
    where
        W: AsyncWrite + Unpin,
    {
        let handle = {
            let mut active = self.active.lock().await;
            if active
                .get(id)
                .is_some_and(|request| matches!(request.state, RequestState::Running))
            {
                active.remove(id).map(|request| request.handle)
            } else {
                None
            }
        };
        if let Some(handle) = handle {
            handle.abort();
            let _ = handle.await;
            self.respond(writer, &Frame::error(Some(id), ErrorCode::Cancelled))
                .await;
        }
    }

    async fn respond<W>(&self, writer: &FrameWriter<W>, frame: &Frame<'_>)
    where
        W: AsyncWrite + Unpin,
    {
        if writer.send(frame).await.is_err() {
            self.write_failed.notify_one();
        }
    }

    async fn cancel_all(&self) {
        let handles: Vec<JoinHandle<()>> = self
            .active
            .lock()
            .await
            .drain()
            .map(|(_, request)| request.handle)
            .collect();
        for handle in handles {
            handle.abort();
            let _ = handle.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::MAX_FRAME_BYTES;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{duplex, AsyncWriteExt, DuplexStream};

    struct DropCounter(Arc<AtomicUsize>);

    impl Drop for DropCounter {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct TestHandler {
        started: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
    }

    impl OperationHandler for TestHandler {
        fn operations(&self) -> &'static [&'static str] {
            &["status", "hold", "fail", "large", "cpu"]
        }

        fn start(&self, operation: &str, _params: Option<Value>) -> OperationFuture {
            match operation {
                "hold" => {
                    let started = Arc::clone(&self.started);
                    let dropped = Arc::clone(&self.dropped);
                    Box::pin(async move {
                        started.fetch_add(1, Ordering::SeqCst);
                        let _guard = DropCounter(dropped);
                        std::future::pending::<OperationOutcome>().await
                    })
                }
                "cpu" => Box::pin(async {
                    std::thread::sleep(Duration::from_millis(30));
                    OperationOutcome::Result(Value::Null)
                }),
                "fail" => Box::pin(async { OperationOutcome::Error(ErrorCode::Internal) }),
                "large" => {
                    let started = Arc::clone(&self.started);
                    Box::pin(async move {
                        started.fetch_add(1, Ordering::SeqCst);
                        OperationOutcome::Result(json!({"body": "x".repeat(4096)}))
                    })
                }
                _ => Box::pin(async {
                    OperationOutcome::Result(json!({"engineVersion": ENGINE_VERSION}))
                }),
            }
        }
    }

    struct Harness {
        engine: JoinHandle<ExitReason>,
        input: DuplexStream,
        output: FrameReader<DuplexStream>,
        started: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
    }

    impl Harness {
        fn start() -> Harness {
            let (engine_input, input) = duplex(1 << 20);
            let (output, engine_output) = duplex(1 << 20);
            let started = Arc::new(AtomicUsize::new(0));
            let dropped = Arc::new(AtomicUsize::new(0));
            let handler = TestHandler {
                started: Arc::clone(&started),
                dropped: Arc::clone(&dropped),
            };
            let engine = tokio::spawn(Engine::new(handler).run(engine_input, engine_output));
            Harness {
                engine,
                input,
                output: FrameReader::new(output),
                started,
                dropped,
            }
        }

        async fn send(&mut self, frame: Value) {
            let mut line = frame.to_string().into_bytes();
            line.push(b'\n');
            self.input.write_all(&line).await.unwrap();
        }

        async fn send_raw(&mut self, bytes: &[u8]) {
            self.input.write_all(bytes).await.unwrap();
        }

        async fn receive(&mut self) -> Value {
            match self.output.next_frame().await {
                LineRead::Frame(bytes) => serde_json::from_slice(&bytes).unwrap(),
                other => panic!("unexpected read result: {other:?}"),
            }
        }

        fn started(&self) -> usize {
            self.started.load(Ordering::SeqCst)
        }

        async fn wait_for_started(&self, target: usize) {
            for _ in 0..100_000 {
                if self.started() >= target {
                    return;
                }
                tokio::task::yield_now().await;
            }
            panic!("handlers started: {}", self.started());
        }

        async fn shutdown(mut self) -> ExitReason {
            self.send(json!({"type": "shutdown"})).await;
            let engine = self.engine;
            engine.await.unwrap()
        }
    }

    fn request(id: &str, operation: &str, timeout_ms: u64) -> Value {
        json!({"type": "request", "id": id, "operation": operation, "timeoutMs": timeout_ms})
    }

    fn error(id: Option<&str>, code: &str, message: &str) -> Value {
        json!({"type": "error", "id": id, "code": code, "message": message})
    }

    #[tokio::test]
    async fn emits_ready_then_answers_status() {
        let mut harness = Harness::start();
        assert_eq!(
            harness.receive().await,
            json!({"type": "ready", "protocolVersion": PROTOCOL_VERSION, "engineVersion": ENGINE_VERSION})
        );
        harness.send(request("1", "status", 30_000)).await;
        assert_eq!(
            harness.receive().await,
            json!({"type": "result", "id": "1", "result": {"engineVersion": ENGINE_VERSION}})
        );
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn rejects_unknown_operation_with_request_id() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("1", "search", 1_000)).await;
        assert_eq!(
            harness.receive().await,
            error(Some("1"), "unsupported_operation", "Unsupported operation")
        );
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn reports_duplicate_id_without_replacing_request() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("dup", "hold", 120_000)).await;
        harness.wait_for_started(1).await;
        harness.send(request("dup", "status", 120_000)).await;
        assert_eq!(
            harness.receive().await,
            error(None, "invalid_request", "Invalid request frame")
        );
        harness.send(json!({"type": "cancel", "id": "dup"})).await;
        assert_eq!(
            harness.receive().await,
            error(Some("dup"), "cancelled", "Request cancelled")
        );
        let dropped = Arc::clone(&harness.dropped);
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn malformed_duplicate_does_not_settle_the_active_request() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("dup", "hold", 120_000)).await;
        harness.wait_for_started(1).await;
        harness
            .send(json!({"type": "request", "id": "dup", "operation": "status"}))
            .await;
        assert_eq!(
            harness.receive().await,
            error(None, "invalid_request", "Invalid request frame")
        );
        harness.send(json!({"type": "cancel", "id": "dup"})).await;
        assert_eq!(
            harness.receive().await,
            error(Some("dup"), "cancelled", "Request cancelled")
        );
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn response_write_failure_stops_the_engine_and_other_work() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("hold", "hold", 120_000)).await;
        harness.wait_for_started(1).await;
        let Harness {
            engine,
            mut input,
            output,
            dropped,
            ..
        } = harness;
        drop(output);
        let mut frame = request("reply", "status", 30_000).to_string();
        frame.push('\n');
        input.write_all(frame.as_bytes()).await.unwrap();
        let reason = tokio::time::timeout(Duration::from_secs(1), engine)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reason, ExitReason::WriteFailed);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn blocked_responses_keep_their_request_slots() {
        let started = Arc::new(AtomicUsize::new(0));
        let engine = Arc::new(Engine::new(TestHandler {
            started: Arc::clone(&started),
            dropped: Arc::new(AtomicUsize::new(0)),
        }));
        let (_output, engine_output) = duplex(1024);
        let writer = Arc::new(FrameWriter::new(engine_output));
        for index in 0..MAX_ACTIVE_REQUESTS {
            engine
                .accept(
                    &writer,
                    format!("r{index}"),
                    "large".to_string(),
                    30_000,
                    None,
                )
                .await;
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while started.load(Ordering::SeqCst) < MAX_ACTIVE_REQUESTS {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        engine.cancel(&writer, "r0").await;
        let active = engine.active.lock().await.len();
        engine.cancel_all().await;
        assert_eq!(active, MAX_ACTIVE_REQUESTS);
    }

    #[tokio::test]
    async fn caps_active_requests_at_32() {
        let mut harness = Harness::start();
        harness.receive().await;
        for index in 0..MAX_ACTIVE_REQUESTS {
            harness
                .send(request(&format!("r{index}"), "hold", 120_000))
                .await;
        }
        harness.wait_for_started(MAX_ACTIVE_REQUESTS).await;
        harness.send(request("overflow", "status", 1_000)).await;
        assert_eq!(
            harness.receive().await,
            error(Some("overflow"), "busy", "Too many active requests")
        );
        let dropped = Arc::clone(&harness.dropped);
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
        assert_eq!(dropped.load(Ordering::SeqCst), MAX_ACTIVE_REQUESTS);
    }

    #[tokio::test]
    async fn answers_concurrent_requests_independently() {
        let mut harness = Harness::start();
        harness.receive().await;
        for index in 0..3 {
            harness
                .send(request(&format!("c{index}"), "status", 30_000))
                .await;
        }
        harness
            .send(json!({"type": "cancel", "id": "missing"}))
            .await;
        let mut ids: Vec<String> = Vec::new();
        for _ in 0..3 {
            let frame = harness.receive().await;
            assert_eq!(frame["type"], json!("result"));
            ids.push(frame["id"].as_str().unwrap().to_string());
        }
        ids.sort();
        assert_eq!(ids, ["c0", "c1", "c2"]);
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn cancels_active_request_and_drops_its_work() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("job", "hold", 120_000)).await;
        harness.wait_for_started(1).await;
        harness.send(json!({"type": "cancel", "id": "job"})).await;
        assert_eq!(
            harness.receive().await,
            error(Some("job"), "cancelled", "Request cancelled")
        );
        assert_eq!(harness.dropped.load(Ordering::SeqCst), 1);
        harness.send(request("job", "status", 30_000)).await;
        let frame = harness.receive().await;
        assert_eq!(frame["type"], json!("result"));
        assert_eq!(frame["id"], json!("job"));
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn times_out_synchronous_processing_that_crosses_the_deadline() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("cpu", "cpu", 1)).await;
        assert_eq!(
            harness.receive().await,
            error(Some("cpu"), "timeout", "Request timed out")
        );
        harness.send(request("next", "status", 30_000)).await;
        assert_eq!(harness.receive().await["id"], "next");
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test(start_paused = true)]
    async fn times_out_pending_operation() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("slow", "hold", 250)).await;
        assert_eq!(
            harness.receive().await,
            error(Some("slow"), "timeout", "Request timed out")
        );
        assert_eq!(harness.dropped.load(Ordering::SeqCst), 1);
        harness.send(json!({"type": "cancel", "id": "slow"})).await;
        harness.send(request("next", "status", 30_000)).await;
        let frame = harness.receive().await;
        assert_eq!(frame["id"], json!("next"));
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn surfaces_handler_error_with_request_id() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("1", "fail", 1_000)).await;
        assert_eq!(
            harness.receive().await,
            error(Some("1"), "internal", "Internal engine error")
        );
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn exits_on_eof_and_cancels_work() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send(request("job", "hold", 120_000)).await;
        harness.wait_for_started(1).await;
        let dropped = Arc::clone(&harness.dropped);
        drop(harness.input);
        let engine = harness.engine;
        assert_eq!(engine.await.unwrap(), ExitReason::Eof);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn survives_malformed_frame() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send_raw(b"not json\n").await;
        assert_eq!(
            harness.receive().await,
            error(None, "invalid_request", "Invalid request frame")
        );
        harness.send(request("ok", "status", 30_000)).await;
        assert_eq!(harness.receive().await["id"], json!("ok"));
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn accepts_frame_at_size_limit() {
        let mut harness = Harness::start();
        harness.receive().await;
        let mut line = request("bounded", "status", 30_000)
            .to_string()
            .into_bytes();
        while line.len() < MAX_FRAME_BYTES {
            line.push(b' ');
        }
        line.push(b'\n');
        harness.send_raw(&line).await;
        assert_eq!(harness.receive().await["id"], json!("bounded"));
        assert_eq!(harness.shutdown().await, ExitReason::Shutdown);
    }

    #[tokio::test]
    async fn terminates_after_frame_one_byte_over_limit() {
        let mut harness = Harness::start();
        harness.receive().await;
        let mut line = request("bounded", "status", 30_000)
            .to_string()
            .into_bytes();
        while line.len() < MAX_FRAME_BYTES + 1 {
            line.push(b' ');
        }
        line.push(b'\n');
        harness.send_raw(&line).await;
        assert_eq!(
            harness.receive().await,
            error(None, "invalid_request", "Invalid request frame")
        );
        let engine = harness.engine;
        assert_eq!(engine.await.unwrap(), ExitReason::OversizedFrame);
    }

    #[tokio::test]
    async fn terminates_after_unterminated_frame_over_limit() {
        let mut harness = Harness::start();
        harness.receive().await;
        harness.send_raw(&vec![b'x'; MAX_FRAME_BYTES + 1]).await;
        assert_eq!(
            harness.receive().await,
            error(None, "invalid_request", "Invalid request frame")
        );
        let engine = harness.engine;
        assert_eq!(engine.await.unwrap(), ExitReason::OversizedFrame);
    }
}
