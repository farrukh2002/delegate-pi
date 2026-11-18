#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use pi_web::engine::{OperationHandler, OperationOutcome};
use pi_web::operations::WebHandler;
use pi_web::protocol::ErrorCode;
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct TestRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

pub struct TestResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub delay: Duration,
    pub chunks: Option<Vec<(Duration, Vec<u8>)>>,
}

impl TestResponse {
    pub fn text(status: u16, body: impl Into<String>) -> Self {
        TestResponse::bytes(
            status,
            "text/plain; charset=utf-8",
            body.into().into_bytes(),
        )
    }

    pub fn json(status: u16, body: &Value) -> Self {
        TestResponse::bytes(
            status,
            "application/json",
            serde_json::to_vec(body).unwrap(),
        )
    }

    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        TestResponse {
            status,
            headers: vec![("Content-Type".to_string(), content_type.to_string())],
            body,
            delay: Duration::ZERO,
            chunks: None,
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    pub fn chunked(mut self, chunks: Vec<(Duration, Vec<u8>)>) -> Self {
        self.chunks = Some(chunks);
        self
    }
}

pub struct TestServer {
    url: String,
    address: SocketAddr,
    requests: Arc<Mutex<Vec<TestRequest>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl TestServer {
    pub fn start<F>(handler: F) -> Self
    where
        F: Fn(&TestRequest) -> TestResponse + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let url = format!("http://{address}");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handler = Arc::new(handler);
        let thread_requests = Arc::clone(&requests);
        let thread_stop = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let handler = Arc::clone(&handler);
                        let requests = Arc::clone(&thread_requests);
                        thread::spawn(move || {
                            handle_connection(stream, handler.as_ref(), &requests);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        TestServer {
            url,
            address,
            requests,
            stop,
            handle: Some(handle),
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn requests(&self) -> Vec<TestRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub async fn run_http(params: Value) -> Result<Value, ErrorCode> {
    let handler = WebHandler::new().unwrap();
    run_with(&handler, params).await
}

pub async fn run_with(handler: &WebHandler, params: Value) -> Result<Value, ErrorCode> {
    match handler.start("http_request", Some(params)).await {
        OperationOutcome::Result(result) => Ok(result),
        OperationOutcome::Error(code) => Err(code),
    }
}

pub fn body_json(result: &Value) -> Value {
    serde_json::from_str(result["body"].as_str().unwrap()).unwrap()
}

fn handle_connection<F>(mut stream: TcpStream, handler: &F, requests: &Mutex<Vec<TestRequest>>)
where
    F: Fn(&TestRequest) -> TestResponse,
{
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    requests.lock().unwrap().push(request.clone());
    let response = handler(&request);
    write_response(&mut stream, &request, response);
}

fn read_request(stream: &mut TcpStream) -> Option<TestRequest> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).ok()? == 0 {
        return None;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(TestRequest {
        method,
        path,
        headers,
        body,
    })
}

fn write_response(stream: &mut TcpStream, request: &TestRequest, response: TestResponse) {
    if !response.delay.is_zero() {
        thread::sleep(response.delay);
    }
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        response.status,
        reason_phrase(response.status)
    );
    if response.chunks.is_some() {
        head.push_str("Transfer-Encoding: chunked\r\n");
    } else {
        head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    }
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    if request.method == "HEAD" {
        let _ = stream.flush();
        return;
    }
    if let Some(chunks) = response.chunks {
        for (delay, chunk) in chunks {
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            if stream
                .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                .is_err()
                || stream.write_all(&chunk).is_err()
                || stream.write_all(b"\r\n").is_err()
            {
                return;
            }
            let _ = stream.flush();
        }
        let _ = stream.write_all(b"0\r\n\r\n");
    } else {
        let _ = stream.write_all(&response.body);
    }
    let _ = stream.flush();
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        404 => "Not Found",
        418 => "I'm a teapot",
        500 => "Internal Server Error",
        _ => "Status",
    }
}
