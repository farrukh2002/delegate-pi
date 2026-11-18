use serde_json::{json, Value};

use crate::engine::{OperationFuture, OperationHandler, OperationOutcome};
use crate::git::GitHandler;
use crate::http::HttpHandler;
use crate::protocol::{ErrorCode, ENGINE_VERSION, PROTOCOL_VERSION};
use crate::search::SearchHandler;

const OPERATIONS: [&str; 7] = ["status", "http_request", "web_search", "web_fetch", "git_index", "git_search", "git_read"];

pub struct WebHandler {
    http: HttpHandler,
    search: SearchHandler,
    git: GitHandler,
}

impl WebHandler {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(WebHandler {
            http: HttpHandler::new()?,
            search: SearchHandler::new()?,
            git: GitHandler::default(),
        })
    }
}

impl OperationHandler for WebHandler {
    fn operations(&self) -> &'static [&'static str] {
        &OPERATIONS
    }

    fn start(&self, operation: &str, params: Option<Value>) -> OperationFuture {
        match operation {
            "status" => Box::pin(async { OperationOutcome::Result(status_result()) }),
            "http_request" => self.http.start(params),
            "web_search" => self.search.start(params),
            "web_fetch" => self.http.start_fetch(params),
            "git_index" | "git_search" | "git_read" => self.git.start(operation, params),
            _ => Box::pin(async { OperationOutcome::Error(ErrorCode::UnsupportedOperation) }),
        }
    }
}

fn status_result() -> Value {
    json!({
        "engineVersion": ENGINE_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "operations": OPERATIONS,
    })
}
