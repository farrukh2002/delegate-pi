mod support;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use support::{body_json, run_http, TestResponse, TestServer};

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);
const TOKEN: &str = "s3cr3t-token";
const ECHO: &str = "echo-secret";

async fn lock_env() -> tokio::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().await
}

struct EnvGuard {
    path: PathBuf,
    keys: Vec<&'static str>,
}

impl EnvGuard {
    fn new(contents: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pi-web-credentials-{}-{}.json",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::write(&path, contents).unwrap();
        std::env::set_var("PI_WEB_CREDENTIALS_FILE", &path);
        EnvGuard {
            path,
            keys: Vec::new(),
        }
    }

    fn set(mut self, key: &'static str, value: &str) -> Self {
        std::env::set_var(key, value);
        self.keys.push(key);
        self
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for key in &self.keys {
            std::env::remove_var(key);
        }
        std::env::remove_var("PI_WEB_CREDENTIALS_FILE");
        let _ = fs::remove_file(&self.path);
    }
}

fn credential_file(origin: &str, headers: Value) -> String {
    json!({"test": {"origin": origin, "headers": headers}}).to_string()
}

#[tokio::test]
async fn credential_headers_override_ordinary_headers_and_redact_reflections() {
    let _lock = lock_env().await;
    let server = TestServer::start(|request| {
        let authorization = request
            .headers
            .get("authorization")
            .cloned()
            .unwrap_or_default();
        let echo = request.headers.get("x-echo").cloned().unwrap_or_default();
        let ordinary = request
            .headers
            .get("x-ordinary")
            .cloned()
            .unwrap_or_default();
        TestResponse::text(
            200,
            format!(
                "auth={authorization};echo={echo};ordinary={ordinary};raw={TOKEN};rawEcho={ECHO}"
            ),
        )
        .header("Set-Cookie", &format!("session={TOKEN}"))
        .header("Authorization", &format!("Bearer {TOKEN}"))
        .header("X-Api-Key", TOKEN)
        .header("X-Echo", ECHO)
    });
    let file = credential_file(
        server.url(),
        json!({
            "Authorization": {"env": "PI_TEST_TOKEN", "prefix": "Bearer "},
            "X-Echo": {"env": "PI_TEST_ECHO"}
        }),
    );
    let _guard = EnvGuard::new(&file)
        .set("PI_TEST_TOKEN", TOKEN)
        .set("PI_TEST_ECHO", ECHO);
    let result = run_http(json!({
        "url": server.url(),
        "credential": "test",
        "headers": {
            "Authorization": "Bearer ordinary",
            "X-Echo": "ordinary",
            "X-Ordinary": "keep"
        }
    }))
    .await
    .unwrap();
    let requests = server.requests();
    assert_eq!(
        requests[0].headers["authorization"],
        format!("Bearer {TOKEN}")
    );
    assert_eq!(requests[0].headers["x-echo"], ECHO);
    assert_eq!(requests[0].headers["x-ordinary"], "keep");
    let body = result["body"].as_str().unwrap();
    assert!(!body.contains(TOKEN));
    assert!(!body.contains(ECHO));
    assert!(body.contains("[REDACTED]"));
    assert_eq!(result["headers"]["set-cookie"], json!("[REDACTED]"));
    assert_eq!(result["headers"]["authorization"], json!("[REDACTED]"));
    assert_eq!(result["headers"]["x-api-key"], json!("[REDACTED]"));
    assert_eq!(result["headers"]["x-echo"], json!("[REDACTED]"));
    assert_eq!(
        result["headers"]["content-type"],
        json!("text/plain; charset=utf-8")
    );
}

#[tokio::test]
async fn omits_reflected_credential_header_names_and_redacts_encoded_values() {
    let _lock = lock_env().await;
    let server = TestServer::start(|_| {
        TestResponse::text(200, "url=private%2Ftoken%2B7; base64=cHJpdmF0ZS90b2tlbis3")
            .header("X-Reflected-S3CR3T-Token", "not secret by itself")
            .header("X-Encoded", "private%2ftoken%2b7")
    });
    let file = credential_file(
        server.url(),
        json!({"Authorization": {"env": "PI_TEST_TOKEN"}, "X-Second": {"env": "PI_TEST_SECOND"}}),
    );
    let _guard = EnvGuard::new(&file)
        .set("PI_TEST_TOKEN", "S3CR3T-TOKEN")
        .set("PI_TEST_SECOND", "private/token+7");
    let result = run_http(json!({"url": server.url(), "credential": "test"}))
        .await
        .unwrap();
    assert!(result["headers"].get("x-reflected-s3cr3t-token").is_none());
    assert_eq!(result["headers"]["x-encoded"], "[REDACTED]");
    assert_eq!(result["body"], "url=[REDACTED]; base64=[REDACTED]");
    assert_eq!(result["truncated"], true);
}

#[tokio::test]
async fn rejects_a_partial_credentialed_response_before_it_can_return_a_token_prefix() {
    let _lock = lock_env().await;
    let server = TestServer::start(|_| TestResponse::text(200, TOKEN));
    let file = credential_file(
        server.url(),
        json!({"Authorization": {"env": "PI_TEST_TOKEN"}}),
    );
    let _guard = EnvGuard::new(&file).set("PI_TEST_TOKEN", TOKEN);
    let error = run_http(json!({"url": server.url(), "credential": "test", "maxResponseBytes": 5}))
        .await
        .unwrap_err();
    assert_eq!(error, pi_web::protocol::ErrorCode::ResponseLimit);
}

#[tokio::test]
async fn redacts_custom_request_header_values() {
    let server = TestServer::start(|request| {
        TestResponse::text(200, request.headers["x-custom-secret"].clone())
    });
    for secret in ["custom-header-secret", "é-private"] {
        let result = run_http(json!({
            "url": server.url(),
            "headers": {"X-Custom-Secret": secret}
        }))
        .await
        .unwrap();
        assert_eq!(result["body"], "[REDACTED]");
    }
}

#[tokio::test]
async fn redacts_json_values_keys_and_missing_pointers_before_serialization() {
    let _lock = lock_env().await;
    const SECRET: &str = "quoted\"secret\\value";
    let server = TestServer::start(|_| {
        let mut value = serde_json::Map::new();
        value.insert("value".to_string(), json!(SECRET));
        value.insert(SECRET.to_string(), json!("key"));
        TestResponse::json(200, &Value::Object(value))
    });
    let file = credential_file(
        server.url(),
        json!({"Authorization": {"env": "PI_TEST_QUOTED"}}),
    );
    let _guard = EnvGuard::new(&file).set("PI_TEST_QUOTED", SECRET);
    let result = run_http(json!({
        "url": server.url(), "credential": "test", "select": ["", format!("/{SECRET}/missing")]
    }))
    .await
    .unwrap();
    let selected = body_json(&result);
    assert_eq!(selected[""]["value"], "[REDACTED]");
    assert_eq!(selected[""]["[REDACTED]"], "key");
    assert_eq!(result["missingPointers"], json!(["/[REDACTED]/missing"]));
    let result = run_http(json!({"url": server.url(), "credential": "test"}))
        .await
        .unwrap();
    let body = body_json(&result);
    assert_eq!(body["value"], "[REDACTED]");
    assert_eq!(body["[REDACTED]"], "key");
}

#[tokio::test]
async fn enforces_combined_credential_and_request_header_limits() {
    let _lock = lock_env().await;
    let server = TestServer::start(|_| TestResponse::text(200, "unexpected"));
    let file = credential_file(
        server.url(),
        json!({"Authorization": {"env": "PI_TEST_TOKEN"}}),
    );
    let _guard = EnvGuard::new(&file).set("PI_TEST_TOKEN", TOKEN);
    let headers: serde_json::Map<String, Value> = (0..32)
        .map(|index| (format!("X-{index}"), json!("v")))
        .collect();
    for headers in [
        Value::Object(headers),
        json!({"X-Large": "v".repeat(8_170)}),
    ] {
        assert_eq!(
            run_http(json!({"url": server.url(), "credential": "test", "headers": headers})).await,
            Err(pi_web::protocol::ErrorCode::InvalidParams)
        );
    }
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn credential_origin_mismatch_fails_before_sending() {
    let _lock = lock_env().await;
    let server = TestServer::start(|_| TestResponse::text(200, "unexpected"));
    let file = credential_file(
        "http://127.0.0.1:1",
        json!({"Authorization": {"env": "PI_TEST_TOKEN"}}),
    );
    let _guard = EnvGuard::new(&file).set("PI_TEST_TOKEN", TOKEN);
    assert_eq!(
        run_http(json!({"url": server.url(), "credential": "test"})).await,
        Err(pi_web::protocol::ErrorCode::CredentialError)
    );
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn missing_environment_and_missing_file_fail_without_sending() {
    let _lock = lock_env().await;
    let server = TestServer::start(|_| TestResponse::text(200, "unexpected"));
    std::env::remove_var("PI_TEST_MISSING");
    let file = credential_file(
        server.url(),
        json!({"Authorization": {"env": "PI_TEST_MISSING"}}),
    );
    let _guard = EnvGuard::new(&file);
    assert_eq!(
        run_http(json!({"url": server.url(), "credential": "test"})).await,
        Err(pi_web::protocol::ErrorCode::CredentialError)
    );
    assert!(server.requests().is_empty());

    std::env::remove_var("PI_WEB_CREDENTIALS_FILE");
    assert_eq!(
        run_http(json!({"url": server.url(), "credential": "test"})).await,
        Err(pi_web::protocol::ErrorCode::CredentialError)
    );
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn ordinary_requests_work_without_a_credentials_file() {
    let _lock = lock_env().await;
    std::env::remove_var("PI_WEB_CREDENTIALS_FILE");
    let server = TestServer::start(|_| TestResponse::text(200, "ok"));
    let result = run_http(json!({"url": server.url()})).await.unwrap();
    assert_eq!(result["body"], json!("ok"));
}

#[tokio::test]
async fn credentials_are_dropped_on_cross_origin_redirects_and_not_reattached() {
    let _lock = lock_env().await;
    let destination_url = Arc::new(Mutex::new(String::new()));
    let slot = Arc::clone(&destination_url);
    let server = TestServer::start(move |request| match request.path.as_str() {
        "/start" => TestResponse::text(302, "")
            .header("Location", &format!("{}/back", slot.lock().unwrap())),
        "/final" => {
            let seen = json!({
                "authorization": request.headers.get("authorization"),
                "ordinary": request.headers.get("x-ordinary")
            });
            TestResponse::json(200, &seen)
        }
        _ => TestResponse::text(404, "unexpected"),
    });
    let origin = server.url().to_string();
    let destination = TestServer::start(move |request| {
        if request.path == "/back" {
            TestResponse::text(302, "").header("Location", &format!("{origin}/final"))
        } else {
            TestResponse::text(200, "destination")
        }
    });
    *destination_url.lock().unwrap() = destination.url().to_string();
    let file = credential_file(
        server.url(),
        json!({"Authorization": {"env": "PI_TEST_TOKEN", "prefix": "Bearer "}}),
    );
    let _guard = EnvGuard::new(&file).set("PI_TEST_TOKEN", TOKEN);
    let params = json!({
        "url": format!("{}/start", server.url()),
        "credential": "test",
        "headers": {"X-Ordinary": "keep"}
    });
    let result = run_http(params).await.unwrap();
    let destination_requests = destination.requests();
    let destination_back = destination_requests
        .iter()
        .find(|request| request.path == "/back")
        .unwrap();
    assert!(!destination_back.headers.contains_key("authorization"));
    assert!(!destination_back.headers.contains_key("x-ordinary"));
    let requests = server.requests();
    assert_eq!(requests[0].path, "/start");
    assert_eq!(
        requests[0].headers["authorization"],
        format!("Bearer {TOKEN}")
    );
    let final_request = requests
        .iter()
        .find(|request| request.path == "/final")
        .unwrap();
    assert!(!final_request.headers.contains_key("authorization"));
    assert!(!final_request.headers.contains_key("x-ordinary"));
    assert_eq!(
        body_json(&result),
        json!({"authorization": null, "ordinary": null})
    );
}

#[tokio::test]
async fn redacts_known_secrets_from_response_urls() {
    let _lock = lock_env().await;
    let server = TestServer::start(|request| {
        if request.path == "/redirect" {
            TestResponse::text(302, "").header("Location", &format!("/final?token={TOKEN}"))
        } else {
            TestResponse::text(200, "ok")
        }
    });
    let file = credential_file(
        server.url(),
        json!({"Authorization": {"env": "PI_TEST_TOKEN"}}),
    );
    let _guard = EnvGuard::new(&file).set("PI_TEST_TOKEN", TOKEN);
    let result = run_http(json!({
        "url": format!("{}/redirect", server.url()),
        "credential": "test"
    }))
    .await
    .unwrap();
    let url = result["url"].as_str().unwrap();
    assert!(!url.contains(TOKEN));
    assert!(url.contains("[REDACTED]"));
}

#[tokio::test]
async fn rejects_malformed_credentials_without_sending_or_leaking_configuration() {
    let _lock = lock_env().await;
    let server = TestServer::start(|_| TestResponse::text(200, "unexpected"));
    let origin = server.url();
    let cases = [
        "not json".to_string(),
        json!([]).to_string(),
        json!({}).to_string(),
        json!({"test": {"headers": {}}}).to_string(),
        json!({"test": {"origin": "https://example.com/path", "headers": {}}}).to_string(),
        json!({"test": {"origin": origin, "headers": {"Host": {"env": "PI_TEST_TOKEN"}}}})
            .to_string(),
        json!({"test": {"origin": origin, "headers": {"Authorization": {"env": ""}}}}).to_string(),
        json!({"test": {"origin": origin, "headers": {"Authorization": {"env": 7}}}}).to_string(),
        json!({"test": {"origin": origin, "headers": {"Authorization": {"env": "PI_TEST_TOKEN", "prefix": 7}}}})
            .to_string(),
        "x".repeat(65_537),
    ];
    for contents in cases {
        let _guard = EnvGuard::new(&contents).set("PI_TEST_TOKEN", TOKEN);
        assert_eq!(
            run_http(json!({"url": server.url(), "credential": "test"})).await,
            Err(pi_web::protocol::ErrorCode::CredentialError),
            "configuration {contents}"
        );
        assert!(server.requests().is_empty());
    }

    let empty_secret = credential_file(
        server.url(),
        json!({"Authorization": {"env": "PI_TEST_EMPTY"}}),
    );
    let _guard = EnvGuard::new(&empty_secret).set("PI_TEST_EMPTY", "");
    assert_eq!(
        run_http(json!({"url": server.url(), "credential": "test"})).await,
        Err(pi_web::protocol::ErrorCode::CredentialError)
    );
    assert!(server.requests().is_empty());
}
