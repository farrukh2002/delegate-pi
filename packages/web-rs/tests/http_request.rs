mod support;

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use support::{body_json, run_http, TestResponse, TestServer};

fn params(url: &str, extra: Value) -> Value {
    let mut params = json!({"url": url});
    if let Value::Object(extra) = extra {
        for (key, value) in extra {
            params[key] = value;
        }
    }
    params
}

fn text_server() -> TestServer {
    TestServer::start(|request| match request.path.as_str() {
        "/missing" => TestResponse::text(404, "not found"),
        _ => TestResponse::text(200, "ok"),
    })
}

#[tokio::test]
async fn gets_url_query_and_headers() {
    let server = TestServer::start(|request| {
        let seen = format!(
            "{} {} {}",
            request.method,
            request.path,
            request.headers.get("x-test").cloned().unwrap_or_default()
        );
        TestResponse::text(200, seen)
    });
    let url = format!("{}/items?q=hello%20world", server.url());
    let result = run_http(params(
        &url,
        json!({"headers": {"X-Test": "yes", "Accept": "text/plain"}}),
    ))
    .await
    .unwrap();
    assert_eq!(result["status"], json!(200));
    assert_eq!(
        result["body"],
        json!("GET /items?q=hello%20world [REDACTED]")
    );
    assert_eq!(result["truncated"], json!(false));
    assert_eq!(result["bytesReceived"], json!(30));
    assert_eq!(result["missingPointers"], json!([]));
    assert_eq!(
        result["headers"]["content-type"],
        json!("[REDACTED]; charset=utf-8")
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/items?q=hello%20world");
    assert_eq!(requests[0].headers["x-test"], "yes");
    assert_eq!(requests[0].headers["accept"], "text/plain");
}

#[tokio::test]
async fn returns_http_error_statuses_as_results() {
    let server = text_server();
    let result = run_http(params(&format!("{}/missing", server.url()), json!({})))
        .await
        .unwrap();
    assert_eq!(result["status"], json!(404));
    assert_eq!(result["body"], json!("not found"));
}

#[tokio::test]
async fn sends_allowed_methods_with_bodies() {
    let server = TestServer::start(|request| {
        TestResponse::json(
            200,
            &json!({
                "method": request.method,
                "body": String::from_utf8_lossy(&request.body),
                "contentType": request.headers.get("content-type")
            }),
        )
    });
    for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
        let result = run_http(params(
            server.url(),
            json!({"method": method, "body": "payload", "headers": {"Content-Type": "text/plain"}}),
        ))
        .await
        .unwrap();
        let echo = body_json(&result);
        assert_eq!(echo["method"], json!(method));
        assert_eq!(echo["body"], json!("payload"));
        assert_eq!(echo["contentType"], json!("[REDACTED]"));
    }
    assert_eq!(server.requests().len(), 5);
    assert!(server
        .requests()
        .iter()
        .all(|request| request.headers["content-type"] == "text/plain"));
}

#[tokio::test]
async fn head_returns_no_body() {
    let server = TestServer::start(|_| TestResponse::text(200, "hidden"));
    let result = run_http(params(server.url(), json!({"method": "HEAD"})))
        .await
        .unwrap();
    assert_eq!(result["status"], json!(200));
    assert_eq!(result["body"], json!(""));
    assert_eq!(result["bytesReceived"], json!(0));
    assert_eq!(result["truncated"], json!(false));
}

#[tokio::test]
async fn selects_json_pointers_and_lists_missing_values() {
    let document = json!({
        "items": [{"name": "first"}, {"name": "second"}],
        "a/b": 7,
        "": 9
    });
    let expected_document = document.clone();
    let server = TestServer::start(move |_| TestResponse::json(200, &document));
    let result = run_http(params(
        server.url(),
        json!({"select": ["/items/0/name", "/items/1", "/a~1b", "/", "/missing", ""]}),
    ))
    .await
    .unwrap();
    assert_eq!(
        body_json(&result),
        json!({
            "/items/0/name": "first",
            "/items/1": {"name": "second"},
            "/a~1b": 7,
            "/": 9,
            "": expected_document
        })
    );
    assert_eq!(
        result["missingPointers"],
        json!(["/missing"]),
        "missing pointers are listed separately"
    );
}

#[tokio::test]
async fn rejects_invalid_json_for_selection() {
    let server = TestServer::start(|_| TestResponse::text(200, "{\"a\":1"));
    assert_eq!(
        run_http(params(server.url(), json!({"select": ["/a"]}))).await,
        Err(pi_web::protocol::ErrorCode::InvalidJson)
    );
}

#[tokio::test]
async fn selection_cannot_read_a_truncated_document() {
    let server = TestServer::start(|_| TestResponse::json(200, &json!({"a": "abcdef"})));
    assert_eq!(
        run_http(params(
            server.url(),
            json!({"select": ["/a"], "maxResponseBytes": 8})
        ))
        .await,
        Err(pi_web::protocol::ErrorCode::ResponseLimit)
    );
}

#[tokio::test]
async fn truncates_plain_text_at_the_decompressed_download_limit() {
    let server = TestServer::start(|_| TestResponse::text(200, "abcdefghij"));
    let result = run_http(params(server.url(), json!({"maxResponseBytes": 4})))
        .await
        .unwrap();
    assert_eq!(result["body"], json!("abcd"));
    assert_eq!(result["truncated"], json!(true));
    assert_eq!(result["bytesReceived"], json!(4));
}

#[tokio::test]
async fn reads_chunked_responses_incrementally() {
    let server = TestServer::start(|_| {
        TestResponse::text(200, "").chunked(vec![
            (Duration::ZERO, b"ab".to_vec()),
            (Duration::ZERO, b"cd".to_vec()),
            (Duration::ZERO, b"ef".to_vec()),
        ])
    });
    let result = run_http(params(server.url(), json!({"maxResponseBytes": 5})))
        .await
        .unwrap();
    assert_eq!(result["body"], json!("abcde"));
    assert_eq!(result["truncated"], json!(true));
}

#[tokio::test]
async fn decompresses_gzip_before_applying_the_limit() {
    let payload = "hello ".repeat(1_000);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(payload.as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();
    let server = TestServer::start(move |_| {
        TestResponse::bytes(200, "text/plain", compressed.clone())
            .header("Content-Encoding", "gzip")
    });
    let result = run_http(params(server.url(), json!({}))).await.unwrap();
    assert_eq!(result["body"], json!(payload));
    assert_eq!(result["truncated"], json!(false));

    let result = run_http(params(server.url(), json!({"maxResponseBytes": 11})))
        .await
        .unwrap();
    assert_eq!(result["body"], json!("hello hello"));
    assert_eq!(result["truncated"], json!(true));
}

#[tokio::test]
async fn drops_an_incomplete_utf8_suffix_at_the_limit() {
    let server = TestServer::start(|_| TestResponse::text(200, "abcé"));
    let result = run_http(params(server.url(), json!({"maxResponseBytes": 4})))
        .await
        .unwrap();
    assert_eq!(result["body"], json!("abc"));
    assert_eq!(result["truncated"], json!(true));

    let result = run_http(params(server.url(), json!({"maxResponseBytes": 5})))
        .await
        .unwrap();
    assert_eq!(result["body"], json!("abcé"));
    assert_eq!(result["truncated"], json!(false));
}

#[tokio::test]
async fn rejects_invalid_utf8_and_declared_binary_content() {
    let invalid = TestServer::start(|_| TestResponse::bytes(200, "text/plain", vec![0xff]));
    assert_eq!(
        run_http(params(invalid.url(), json!({}))).await,
        Err(pi_web::protocol::ErrorCode::UnsupportedResponse)
    );

    let binary =
        TestServer::start(|_| TestResponse::bytes(200, "application/octet-stream", vec![0, 1, 2]));
    assert_eq!(
        run_http(params(binary.url(), json!({}))).await,
        Err(pi_web::protocol::ErrorCode::UnsupportedResponse)
    );

    let undeclared = TestServer::start(|_| TestResponse {
        status: 200,
        headers: Vec::new(),
        body: vec![0xff],
        delay: Duration::ZERO,
        chunks: None,
    });
    assert_eq!(
        run_http(params(undeclared.url(), json!({}))).await,
        Err(pi_web::protocol::ErrorCode::UnsupportedResponse)
    );
}

#[tokio::test]
async fn bounds_response_headers_and_marks_them_truncated() {
    let server = TestServer::start(|_| {
        let mut response = TestResponse::text(200, "ok");
        for index in 0..40 {
            response = response.header(&format!("X-Test-{index}"), &"v".repeat(200));
        }
        response
    });
    let result = run_http(params(server.url(), json!({}))).await.unwrap();
    let encoded_headers = serde_json::to_vec(&result["headers"]).unwrap();
    assert!(encoded_headers.len() <= 4_096);
    assert_eq!(result["truncated"], json!(true));
    assert!(result["headers"].as_object().unwrap().len() < 40);
}

#[tokio::test]
async fn shortens_the_body_to_the_encoded_output_limit() {
    let payload = "é".repeat(2_000);
    let server = TestServer::start(move |_| TestResponse::text(200, payload.clone()));
    let result = run_http(params(server.url(), json!({"maxOutputBytes": 1_024})))
        .await
        .unwrap();
    let encoded = serde_json::to_vec(&result).unwrap();
    assert!(encoded.len() <= 1_024);
    assert_eq!(result["truncated"], json!(true));
    let body = result["body"].as_str().unwrap();
    assert!("é".repeat(2_000).starts_with(body));
}

#[tokio::test]
async fn returns_output_limit_when_metadata_alone_cannot_fit() {
    let server = TestServer::start(|_| TestResponse::text(200, "ok"));
    let url = format!("{}/{}", server.url(), "a".repeat(2_000));
    assert_eq!(
        run_http(params(&url, json!({"maxOutputBytes": 1_024}))).await,
        Err(pi_web::protocol::ErrorCode::OutputLimit)
    );
}

#[tokio::test]
async fn follows_get_redirects_and_returns_the_final_url() {
    let server = TestServer::start(|request| match request.path.as_str() {
        "/start" => TestResponse::text(302, "").header("Location", "/middle"),
        "/middle" => TestResponse::text(301, "").header("Location", "/final?q=1"),
        "/final?q=1" => TestResponse::text(200, "done"),
        _ => TestResponse::text(404, "unexpected"),
    });
    let result = run_http(params(
        &format!("{}/start", server.url()),
        json!({"maxRedirects": 5}),
    ))
    .await
    .unwrap();
    assert_eq!(result["body"], json!("done"));
    assert_eq!(result["url"], json!(format!("{}/final?q=1", server.url())));
    let paths: Vec<String> = server
        .requests()
        .into_iter()
        .map(|request| request.path)
        .collect();
    assert_eq!(paths, ["/start", "/middle", "/final?q=1"]);
}

#[tokio::test]
async fn enforces_the_redirect_limit() {
    let server = TestServer::start(|_| TestResponse::text(302, "").header("Location", "/again"));
    assert_eq!(
        run_http(params(
            &format!("{}/start", server.url()),
            json!({"maxRedirects": 2})
        ))
        .await,
        Err(pi_web::protocol::ErrorCode::RedirectLimit)
    );
    assert_eq!(server.requests().len(), 3);

    assert_eq!(
        run_http(params(
            &format!("{}/start", server.url()),
            json!({"maxRedirects": 0})
        ))
        .await,
        Err(pi_web::protocol::ErrorCode::RedirectLimit)
    );
}

#[tokio::test]
async fn returns_redirects_without_a_location_or_for_other_methods() {
    let server = TestServer::start(|request| {
        if request.method == "POST" {
            TestResponse::text(302, "approved elsewhere").header("Location", "/elsewhere")
        } else {
            TestResponse::text(302, "no location")
        }
    });
    let result = run_http(params(server.url(), json!({}))).await.unwrap();
    assert_eq!(result["status"], json!(302));
    assert_eq!(result["body"], json!("no location"));

    let result = run_http(params(
        server.url(),
        json!({"method": "POST", "body": "data"}),
    ))
    .await
    .unwrap();
    assert_eq!(result["status"], json!(302));
    assert_eq!(result["body"], json!("approved elsewhere"));
    assert_eq!(server.requests().len(), 2);
    assert_eq!(server.requests()[1].method, "POST");
}

#[tokio::test]
async fn drops_headers_after_a_cross_origin_redirect_and_never_reattaches() {
    let destination_url = Arc::new(Mutex::new(String::new()));
    let slot = Arc::clone(&destination_url);
    let server = TestServer::start(move |request| match request.path.as_str() {
        "/start" => TestResponse::text(302, "")
            .header("Location", &format!("{}/back", slot.lock().unwrap())),
        "/final" => {
            let sent = json!({
                "authorization": request.headers.get("authorization"),
                "secret": request.headers.get("x-secret")
            });
            TestResponse::json(200, &sent)
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
    let result = run_http(params(
        &format!("{}/start", server.url()),
        json!({"headers": {"Authorization": "Bearer abc", "X-Secret": "value"}}),
    ))
    .await
    .unwrap();
    assert_eq!(
        body_json(&result),
        json!({"authorization": null, "secret": null})
    );
    let final_request = server
        .requests()
        .into_iter()
        .find(|request| request.path == "/final")
        .unwrap();
    assert!(!final_request.headers.contains_key("authorization"));
    assert!(!final_request.headers.contains_key("x-secret"));
}

#[tokio::test]
async fn rejects_unsafe_redirect_targets() {
    for location in ["file:///tmp/x", "http://user@127.0.0.1/"] {
        let server =
            TestServer::start(move |_| TestResponse::text(302, "").header("Location", location));
        assert_eq!(
            run_http(params(&format!("{}/start", server.url()), json!({}))).await,
            Err(pi_web::protocol::ErrorCode::NetworkError),
            "location {location}"
        );
    }
}

#[tokio::test]
async fn rejects_invalid_params_before_sending() {
    let server = TestServer::start(|_| TestResponse::text(200, "unexpected"));
    let url = server.url();
    let mut too_many_headers = serde_json::Map::new();
    for index in 0..33 {
        too_many_headers.insert(format!("X-{index}"), json!("v"));
    }
    let cases = vec![
        Value::Null,
        json!({}),
        json!({"url": "ftp://example.com/"}),
        json!({"url": "http://user@127.0.0.1/"}),
        json!({"url": format!("http://example.com/{}", "a".repeat(5_000))}),
        json!({"url": url, "method": "get"}),
        json!({"url": url, "method": "TRACE"}),
        json!({"url": url, "headers": []}),
        json!({"url": url, "headers": {"Host": "example.com"}}),
        json!({"url": url, "headers": {"Connection": "keep-alive"}}),
        json!({"url": url, "headers": {"Content-Length": "1"}}),
        json!({"url": url, "headers": {"X-Test": "a\r\nInjected: 1"}}),
        json!({"url": url, "headers": too_many_headers}),
        json!({"url": url, "headers": {"X-Test": "v".repeat(9_000)}}),
        json!({"url": url, "body": 7}),
        json!({"url": url, "body": "x".repeat(32_769)}),
        json!({"url": url, "body": "get body"}),
        json!({"url": url, "method": "HEAD", "body": "head body"}),
        json!({"url": url, "credential": 7}),
        json!({"url": url, "select": []}),
        json!({"url": url, "select": [7]}),
        json!({"url": url, "select": ["not-a-pointer"]}),
        json!({"url": url, "maxResponseBytes": 0}),
        json!({"url": url, "maxResponseBytes": 8_388_609}),
        json!({"url": url, "maxResponseBytes": 1.5}),
        json!({"url": url, "maxOutputBytes": 1_023}),
        json!({"url": url, "maxOutputBytes": 49_153}),
        json!({"url": url, "maxRedirects": 11}),
        json!({"url": url, "maxRedirects": -1}),
    ];
    for case in cases {
        assert_eq!(
            run_http(case.clone()).await,
            Err(pi_web::protocol::ErrorCode::InvalidParams),
            "params {case}"
        );
    }
    assert!(server.requests().is_empty());
    assert_eq!(
        run_http(json!({"url": server.url(), "credential": ""})).await,
        Err(pi_web::protocol::ErrorCode::CredentialError)
    );
}

#[tokio::test]
async fn ignores_unknown_params() {
    let server = text_server();
    let result = run_http(params(
        server.url(),
        json!({"unknown": true, "maxRedirects": 3}),
    ))
    .await
    .unwrap();
    assert_eq!(result["status"], json!(200));
}
