use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PROTOCOL_VERSION: u32 = 1;
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_REQUEST_ID_BYTES: usize = 128;
pub const MAX_ACTIVE_REQUESTS: usize = 32;
pub const MIN_TIMEOUT_MS: u64 = 1;
pub const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    UnsupportedOperation,
    Busy,
    Cancelled,
    Timeout,
    Internal,
    InvalidParams,
    NetworkError,
    RedirectLimit,
    CredentialError,
    UnsupportedResponse,
    ResponseLimit,
    OutputLimit,
    InvalidJson,
    RepositoryError,
    RepositoryAuthRequired,
    IndexNotFound,
    IndexIncompatible,
    ResourceLimit,
}

impl ErrorCode {
    pub fn message(self) -> &'static str {
        match self {
            ErrorCode::InvalidRequest => "Invalid request frame",
            ErrorCode::UnsupportedOperation => "Unsupported operation",
            ErrorCode::Busy => "Too many active requests",
            ErrorCode::Cancelled => "Request cancelled",
            ErrorCode::Timeout => "Request timed out",
            ErrorCode::Internal => "Internal engine error",
            ErrorCode::InvalidParams => "Invalid operation parameters",
            ErrorCode::NetworkError => "Network request failed",
            ErrorCode::RedirectLimit => "Too many redirects",
            ErrorCode::CredentialError => "Credential could not be used",
            ErrorCode::UnsupportedResponse => "Unsupported response content",
            ErrorCode::ResponseLimit => "Response size limit exceeded",
            ErrorCode::OutputLimit => "Output size limit exceeded",
            ErrorCode::InvalidJson => "Response is not valid JSON",
            ErrorCode::RepositoryError => "Repository operation failed",
            ErrorCode::RepositoryAuthRequired => "Repository requires authentication; only anonymous Git remotes are supported",
            ErrorCode::IndexNotFound => "Repository index was not found",
            ErrorCode::IndexIncompatible => "Repository index is incompatible or damaged",
            ErrorCode::ResourceLimit => "Repository resource limit exceeded",
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type")]
pub enum Frame<'a> {
    #[serde(rename = "ready")]
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "engineVersion")]
        engine_version: &'a str,
    },
    #[serde(rename = "result")]
    Result { id: &'a str, result: &'a Value },
    #[serde(rename = "error")]
    Error {
        id: Option<&'a str>,
        code: ErrorCode,
        message: &'a str,
    },
}

impl<'a> Frame<'a> {
    pub fn error(id: Option<&'a str>, code: ErrorCode) -> Frame<'a> {
        Frame::Error {
            id,
            code,
            message: code.message(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    Request {
        id: String,
        operation: String,
        timeout_ms: u64,
        params: Option<Value>,
    },
    Cancel {
        id: String,
    },
    Shutdown,
    Invalid {
        id: Option<String>,
    },
}

pub fn parse_frame(bytes: &[u8]) -> Inbound {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => return invalid(None),
    };
    let object = match value.as_object() {
        Some(object) => object,
        None => return invalid(None),
    };
    match object.get("type").and_then(Value::as_str) {
        Some("request") => parse_request(object),
        Some("cancel") => match request_id(object.get("id")) {
            Some(id) => Inbound::Cancel { id },
            None => invalid(None),
        },
        Some("shutdown") => Inbound::Shutdown,
        _ => invalid(None),
    }
}

fn parse_request(object: &Map<String, Value>) -> Inbound {
    let id = match request_id(object.get("id")) {
        Some(id) => id,
        None => return invalid(None),
    };
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .filter(|operation| !operation.is_empty());
    let timeout_ms = object.get("timeoutMs").and_then(timeout_ms);
    match (operation, timeout_ms) {
        (Some(operation), Some(timeout_ms)) => Inbound::Request {
            id,
            operation: operation.to_string(),
            timeout_ms,
            params: object.get("params").cloned(),
        },
        _ => invalid(None),
    }
}

fn invalid(id: Option<String>) -> Inbound {
    Inbound::Invalid { id }
}

fn request_id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|id| valid_request_id(id))
        .map(str::to_string)
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_REQUEST_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn timeout_ms(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|ms| (MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> Inbound {
        parse_frame(value.to_string().as_bytes())
    }

    fn request(id: &str, timeout_ms: Value) -> Value {
        json!({"type": "request", "id": id, "operation": "status", "timeoutMs": timeout_ms})
    }

    fn accepted(id: &str, timeout_ms: u64) -> Inbound {
        Inbound::Request {
            id: id.to_string(),
            operation: "status".to_string(),
            timeout_ms,
            params: None,
        }
    }

    #[test]
    fn accepts_a_valid_request() {
        assert_eq!(parse(request("1", json!(30_000))), accepted("1", 30_000));
    }

    #[test]
    fn accepts_id_at_length_limit() {
        let id = "a".repeat(MAX_REQUEST_ID_BYTES);
        assert_eq!(parse(request(&id, json!(1))), accepted(&id, 1));
    }

    #[test]
    fn rejects_id_over_length_limit() {
        let id = "a".repeat(MAX_REQUEST_ID_BYTES + 1);
        assert_eq!(parse(request(&id, json!(1))), Inbound::Invalid { id: None });
    }

    #[test]
    fn rejects_malformed_ids() {
        for id in ["", "a b", "a/1", "a.b", "request-id!", "\u{e9}"] {
            assert_eq!(
                parse(request(id, json!(1))),
                Inbound::Invalid { id: None },
                "id {id}"
            );
        }
        assert_eq!(
            parse(request("A-z_0", json!(1))),
            Inbound::Request {
                id: "A-z_0".to_string(),
                operation: "status".to_string(),
                timeout_ms: 1,
                params: None,
            }
        );
    }

    #[test]
    fn rejects_timeouts_outside_the_allowed_range() {
        for timeout in [
            json!(0),
            json!(MAX_TIMEOUT_MS + 1),
            json!(-5),
            json!(1.5),
            json!("1000"),
            json!(null),
        ] {
            assert_eq!(
                parse(request("1", timeout.clone())),
                Inbound::Invalid { id: None },
                "timeout {timeout}"
            );
        }
        for timeout in [json!(MIN_TIMEOUT_MS), json!(MAX_TIMEOUT_MS)] {
            assert!(matches!(
                parse(request("1", timeout)),
                Inbound::Request { .. }
            ));
        }
    }

    #[test]
    fn malformed_requests_cannot_claim_an_active_request_id() {
        for frame in [
            json!({"type": "request", "id": "1", "operation": "", "timeoutMs": 10}),
            json!({"type": "request", "id": "1", "operation": "status"}),
            json!({"type": "request", "id": "1", "timeoutMs": 10}),
            json!({"type": "request", "id": "1", "operation": 7, "timeoutMs": 10}),
        ] {
            assert_eq!(
                parse(frame.clone()),
                Inbound::Invalid { id: None },
                "frame {frame}"
            );
        }
    }

    #[test]
    fn rejects_frames_without_request_association() {
        for raw in [
            "",
            "{",
            "[]",
            "null",
            "42",
            "{}",
            "{\"type\":7}",
            "{\"type\":\"unknown\"}",
            "{\"id\":\"1\"}",
            "{\"type\":\"request\",\"id\":7,\"operation\":\"status\",\"timeoutMs\":10}",
        ] {
            assert_eq!(
                parse_frame(raw.as_bytes()),
                Inbound::Invalid { id: None },
                "frame {raw}"
            );
        }
    }

    #[test]
    fn parses_cancel_and_shutdown() {
        assert_eq!(
            parse(json!({"type": "cancel", "id": "1"})),
            Inbound::Cancel {
                id: "1".to_string()
            }
        );
        assert_eq!(
            parse(json!({"type": "cancel", "id": "1 2"})),
            Inbound::Invalid { id: None }
        );
        assert_eq!(parse(json!({"type": "shutdown"})), Inbound::Shutdown);
        assert_eq!(
            parse(json!({"type": "shutdown", "id": "x"})),
            Inbound::Shutdown
        );
    }

    #[test]
    fn ignores_unknown_fields() {
        let frame = json!({"type": "request", "id": "1", "operation": "status", "timeoutMs": 1, "extra": true});
        assert_eq!(parse(frame), accepted("1", 1));
    }

    #[test]
    fn carries_optional_params() {
        for params in [json!(null), json!({"url": "http://localhost/"}), json!([])] {
            let frame = json!({"type": "request", "id": "1", "operation": "http_request", "timeoutMs": 1, "params": params.clone()});
            assert_eq!(
                parse(frame),
                Inbound::Request {
                    id: "1".to_string(),
                    operation: "http_request".to_string(),
                    timeout_ms: 1,
                    params: Some(params),
                }
            );
        }
    }

    #[test]
    fn serializes_protocol_frames() {
        let ready = Frame::Ready {
            protocol_version: PROTOCOL_VERSION,
            engine_version: ENGINE_VERSION,
        };
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            json!({"type": "ready", "protocolVersion": 1, "engineVersion": "0.1.0"})
        );
        let value = json!({"engineVersion": "0.1.0"});
        let result = Frame::Result {
            id: "1",
            result: &value,
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"type": "result", "id": "1", "result": {"engineVersion": "0.1.0"}})
        );
        assert_eq!(
            serde_json::to_value(Frame::error(None, ErrorCode::InvalidRequest)).unwrap(),
            json!({"type": "error", "id": null, "code": "invalid_request", "message": "Invalid request frame"})
        );
        assert_eq!(
            serde_json::to_value(Frame::error(Some("1"), ErrorCode::Timeout)).unwrap(),
            json!({"type": "error", "id": "1", "code": "timeout", "message": "Request timed out"})
        );
        for (code, name, message) in [
            (
                ErrorCode::InvalidParams,
                "invalid_params",
                "Invalid operation parameters",
            ),
            (
                ErrorCode::NetworkError,
                "network_error",
                "Network request failed",
            ),
            (
                ErrorCode::RedirectLimit,
                "redirect_limit",
                "Too many redirects",
            ),
            (
                ErrorCode::CredentialError,
                "credential_error",
                "Credential could not be used",
            ),
            (
                ErrorCode::UnsupportedResponse,
                "unsupported_response",
                "Unsupported response content",
            ),
            (
                ErrorCode::ResponseLimit,
                "response_limit",
                "Response size limit exceeded",
            ),
            (
                ErrorCode::OutputLimit,
                "output_limit",
                "Output size limit exceeded",
            ),
            (
                ErrorCode::InvalidJson,
                "invalid_json",
                "Response is not valid JSON",
            ),
        ] {
            assert_eq!(
                serde_json::to_value(Frame::error(Some("1"), code)).unwrap(),
                json!({"type": "error", "id": "1", "code": name, "message": message})
            );
        }
    }

    #[test]
    fn pins_protocol_limits() {
        assert_eq!(PROTOCOL_VERSION, 1);
        assert_eq!(ENGINE_VERSION, "0.1.0");
        assert_eq!(MAX_FRAME_BYTES, 65_536);
        assert_eq!(MAX_ACTIVE_REQUESTS, 32);
        assert_eq!(MIN_TIMEOUT_MS, 1);
        assert_eq!(MAX_TIMEOUT_MS, 120_000);
    }
}
