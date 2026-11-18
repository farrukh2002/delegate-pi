use super::*;
use crate::engine::{Engine, ExitReason, OperationHandler};
use crate::frame_reader::{FrameReader, LineRead};
use serde_json::json;
use std::io::Write;
use tokio::io::{duplex, AsyncWriteExt};

#[path = "../../tests/support/mod.rs"]
mod support;
use support::{TestResponse, TestServer};

fn html(body: &str) -> TestResponse {
    TestResponse::bytes(200, "text/html; charset=utf-8", body.as_bytes().to_vec())
}

fn yahoo(url: &str, title: &str, snippet: &str) -> String {
    format!(
        r#"<div class="algo relsrch"><div class="compTitle"><a href="{url}"><h3>{title}</h3></a></div><div class="compText"><p>{snippet}</p></div></div>"#
    )
}

fn brave(url: &str, title: &str, snippet: &str) -> String {
    format!(
        r#"<div data-type="web"><a href="{url}"><div class="title">{title}</div></a><div class="snippet"><div class="content">{snippet}</div></div></div>"#
    )
}

fn handler(first: &TestServer, second: &TestServer) -> SearchHandler {
    SearchHandler {
        client: SearchHandler::new().unwrap().client,
        endpoints: [
            (Provider::Yahoo, Url::parse(first.url()).unwrap()),
            (Provider::Brave, Url::parse(second.url()).unwrap()),
        ],
    }
}

async fn result(handler: &SearchHandler, params: Value) -> Result<Value, ErrorCode> {
    match handler.start(Some(params)).await {
        OperationOutcome::Result(value) => Ok(value),
        OperationOutcome::Error(code) => Err(code),
    }
}

#[test]
fn validates_search_parameters_and_normalizes_sites() {
    let params =
        SearchParams::parse(Some(json!({"query":"  ownership  ", "site":"BÜCHER.de"}))).unwrap();
    assert_eq!(params.query, "ownership");
    assert_eq!(params.site.as_deref(), Some("xn--bcher-kva.de"));
    assert_eq!(params.max_results, 5);
    assert_eq!(params.max_output_bytes, 8192);
    assert_eq!(params.provider_query(), "ownership site:xn--bcher-kva.de");
    for value in [
        None,
        Some(Value::Null),
        Some(json!([])),
        Some(json!({})),
        Some(json!({"query":42})),
        Some(json!({"query":" \t"})),
        Some(json!({"query":"a\nb"})),
        Some(json!({"query":"a".repeat(513)})),
        Some(json!({"query":"é".repeat(257)})),
    ] {
        assert!(matches!(
            SearchParams::parse(value),
            Err(ErrorCode::InvalidParams)
        ));
    }
    for site in [
        "",
        "a b",
        "https://example.com",
        "example.com/path",
        "example.com:443",
        "*.example.com",
        "a@b.com",
        "127.0.0.1",
        "[::1]",
        "1",
        "-a.com",
        "a-.com",
        "a..com",
        "a.com?x",
        "example%2ecom",
    ] {
        assert!(normalize_site(&json!(site)).is_err(), "{site}");
    }
    for (field, values) in [
        (
            "maxResults",
            vec![json!(0), json!(11), json!(1.5), json!("5"), Value::Null],
        ),
        (
            "maxOutputBytes",
            vec![json!(1023), json!(49153), json!(-1), Value::Null],
        ),
    ] {
        for value in values {
            let mut input = json!({"query":"rust"});
            input[field] = value;
            assert!(SearchParams::parse(Some(input)).is_err());
        }
    }
}

#[test]
fn extracts_entities_titles_and_snippets_for_both_providers() {
    for (provider, body) in [
        (
            Provider::Yahoo,
            yahoo(
                "https://example.com/a?utm_source=x&amp;k=1#part",
                "A &amp; <b>B</b>",
                " A\n <b>useful</b> &lt;snippet&gt; ",
            ),
        ),
        (
            Provider::Brave,
            brave(
                "https://example.com/a?utm_source=x&amp;k=1#part",
                "A &amp; <b>B</b>",
                " A\n <b>useful</b> &lt;snippet&gt; ",
            ),
        ),
    ] {
        let (status, items, truncated) = parse(provider, &body, None, 5);
        assert_eq!(status, AttemptStatus::Ok);
        assert_eq!(items[0].title, "A & B");
        assert_eq!(items[0].snippet, "A useful <snippet>");
        assert_eq!(items[0].url, "https://example.com/a?k=1");
        assert!(!truncated);
    }
}

#[test]
fn unwraps_yahoo_links_and_rejects_unsafe_or_provider_links() {
    let raw = "https://r.search.yahoo.com/_ylt=token/RU=https%3a%2f%2fexample.com%2fa%3fq%3da%252Bb/RK=2/RS=token";
    assert_eq!(
        result_url(Provider::Yahoo, raw).unwrap().as_str(),
        "https://example.com/a?q=a%2Bb"
    );
    for raw in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "/relative",
        "https://user:password@example.com",
        "https://@example.com/",
        "https://search.yahoo.com/search?p=x",
        "https://www.bing.com/aclick?x=y",
        "https://r.search.yahoo.com/broken",
        "https://r.search.yahoo.com/RU=https%3a%2f%2fuser%3apass%40example.com/RK=x",
        "https://r.search.yahoo.com/RU=%ff/RK=x",
    ] {
        assert!(result_url(Provider::Yahoo, raw).is_none(), "{raw}");
    }
    assert!(result_url(
        Provider::Brave,
        &format!("https://example.com/{}", "x".repeat(4096))
    )
    .is_none());
    let raw = "https://example.com/a?token=A%20B&empty&x=%2f";
    assert_eq!(result_url(Provider::Yahoo, raw).unwrap().as_str(), raw);
}

#[test]
fn deduplicates_and_preserves_order_with_bounded_text() {
    let body = [
        yahoo("https://example.com/a#one", "First", &"é".repeat(500)),
        yahoo(
            "https://example.com/a?utm_source=x#two",
            "Duplicate",
            "duplicate",
        ),
        yahoo("https://example.com/b", &"é".repeat(200), "second"),
        yahoo("https://example.com/c", "Third", "third"),
    ]
    .concat();
    let (status, items, truncated) = parse(Provider::Yahoo, &body, None, 2);
    assert_eq!(status, AttemptStatus::Ok);
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].title, "First");
    assert_eq!(items[0].snippet.len(), 512);
    assert_eq!(items[1].title.len(), 256);
    assert_eq!(items[1].url, "https://example.com/b");
    assert!(truncated);
}

#[test]
fn filters_site_by_hostname_boundary_not_substring() {
    let body = [
        yahoo("https://example.com/a", "Root", ""),
        yahoo("https://docs.example.com/b", "Subdomain", ""),
        yahoo("https://evil-example.com/c", "Wrong", ""),
        yahoo("https://example.com.evil.org/d", "Wrong", ""),
    ]
    .concat();
    let (_, items, _) = parse(Provider::Yahoo, &body, Some("example.com"), 10);
    assert_eq!(items.len(), 2);
    let (status, items, _) = parse(Provider::Yahoo, &body, Some("not.example.org"), 10);
    assert_eq!(status, AttemptStatus::Empty);
    assert!(items.is_empty());
}

#[tokio::test]
async fn does_not_claim_empty_when_the_candidate_limit_hides_a_match() {
    let wrong_site = yahoo("https://other.example/result", "Wrong site", "");
    let match_after_cap = yahoo("https://example.com/result", "Match", "");
    let first =
        TestServer::start(move |_| html(&format!("{}{}", wrong_site.repeat(100), match_after_cap)));
    let second = TestServer::start(|_| html("<body>No results found</body>"));
    let result = result(
        &handler(&first, &second),
        json!({"query": "docs", "site": "example.com"}),
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "unavailable");
    assert_eq!(result["attempts"][0]["status"], "response_limit");
    assert_eq!(result["truncated"], true);
    assert_eq!(result["results"], json!([]));
}

#[test]
fn distinguishes_empty_challenge_and_changed_markup() {
    for (provider, body, expected) in [
        (
            Provider::Yahoo,
            "<body>We did not find results for that query</body>",
            AttemptStatus::Empty,
        ),
        (
            Provider::Brave,
            "<body>No results found</body>",
            AttemptStatus::Empty,
        ),
        (
            Provider::Yahoo,
            "<title>Captcha</title><form action='/captcha'></form>",
            AttemptStatus::Blocked,
        ),
        (
            Provider::Brave,
            "<form id='challenge-form'></form>",
            AttemptStatus::Blocked,
        ),
        (
            Provider::Yahoo,
            "<body>Different markup</body>",
            AttemptStatus::UnsupportedResponse,
        ),
    ] {
        assert_eq!(parse(provider, body, None, 5).0, expected);
    }
    let organic = yahoo(
        "https://example.com",
        "CAPTCHA documentation",
        "CAPTCHA support",
    );
    assert_eq!(
        parse(Provider::Yahoo, &organic, None, 5).0,
        AttemptStatus::Ok
    );
}

#[test]
fn excludes_ads_scripts_and_invalid_results() {
    let body = format!(
        "{}{}{}{}",
        yahoo("https://ads.example.com", "Ad", "ad")
            .replace("algo relsrch", "algo relsrch sponsored"),
        yahoo("javascript:alert(1)", "Bad", "bad"),
        yahoo(
            "https://example.com",
            "<script>secret</script>Good",
            "<style>noise</style>Text"
        ),
        "<a href='https://navigation.example.com'>Navigation</a>"
    );
    let (_, items, _) = parse(Provider::Yahoo, &body, None, 5);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "Good");
    assert_eq!(items[0].snippet, "Text");
}

#[tokio::test]
async fn encodes_queries_and_stops_after_first_success() {
    let first = TestServer::start(|_| html(&yahoo("https://example.com/rust", "Rust", "text")));
    let second = TestServer::start(|_| html("unused"));
    let value = result(
        &handler(&first, &second),
        json!({"query":"a & b", "site":"EXAMPLE.COM"}),
    )
    .await
    .unwrap();
    assert_eq!(value["status"], "ok");
    assert_eq!(value["site"], "example.com");
    assert_eq!(
        value["attempts"],
        json!([{"provider":"yahoo","status":"ok"}])
    );
    let requests = first.requests();
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/?p=a+%26+b+site%3Aexample.com");
    assert_eq!(requests[0].headers["user-agent"], USER_AGENT);
    assert!(!requests[0].headers.contains_key("authorization"));
    assert!(!requests[0].headers.contains_key("cookie"));
    assert!(second.requests().is_empty());
}

#[tokio::test]
async fn invalid_params_never_reach_a_provider() {
    let first = TestServer::start(|_| html("unused"));
    let second = TestServer::start(|_| html("unused"));
    assert_eq!(
        result(&handler(&first, &second), json!({"query":""})).await,
        Err(ErrorCode::InvalidParams)
    );
    assert!(first.requests().is_empty() && second.requests().is_empty());
}

#[tokio::test]
async fn falls_back_on_blocking_errors_and_empty_responses() {
    for (status, body, expected) in [
        (429, "blocked", "blocked"),
        (202, "challenge", "blocked"),
        (403, "denied", "blocked"),
        (503, "unavailable", "http_error"),
        (200, "<title>Captcha</title>", "blocked"),
        (200, "<body>We did not find results for x</body>", "empty"),
        (200, "<body>changed markup</body>", "unsupported_response"),
    ] {
        let first = TestServer::start(move |_| {
            TestResponse::bytes(status, "text/html", body.as_bytes().to_vec())
        });
        let second = TestServer::start(|_| html(&brave("https://example.com", "Found", "text")));
        let value = result(&handler(&first, &second), json!({"query":"rust"}))
            .await
            .unwrap();
        assert_eq!(value["status"], "ok");
        assert_eq!(
            value["attempts"],
            json!([{"provider":"yahoo","status":expected},{"provider":"brave","status":"ok"}])
        );
        assert_eq!(second.requests()[0].path, "/?q=rust&source=web");
    }
}

#[tokio::test]
async fn distinguishes_total_unavailability_from_valid_empty_results() {
    let first = TestServer::start(|_| html("<body>We did not find results for x</body>"));
    let second = TestServer::start(|_| TestResponse::text(429, "blocked"));
    let value = result(&handler(&first, &second), json!({"query":"rust"}))
        .await
        .unwrap();
    assert_eq!(value["status"], "empty");
    assert_eq!(value["results"], json!([]));
    let first = TestServer::start(|_| TestResponse::text(429, "blocked"));
    let value = result(&handler(&first, &second), json!({"query":"rust"}))
        .await
        .unwrap();
    assert_eq!(value["status"], "unavailable");
}

#[tokio::test]
async fn rejects_non_html_charsets_and_invalid_utf8() {
    for (content_type, body) in [
        ("application/json", b"{}".to_vec()),
        ("text/html; charset=latin-1", b"text".to_vec()),
        ("text/html; charset=utf-8-invalid", b"text".to_vec()),
        ("text/html", vec![0xff]),
    ] {
        let first =
            TestServer::start(move |_| TestResponse::bytes(200, content_type, body.clone()));
        let second = TestServer::start(|_| html(&brave("https://example.com", "Found", "")));
        let value = result(&handler(&first, &second), json!({"query":"rust"}))
            .await
            .unwrap();
        assert_eq!(value["attempts"][0]["status"], "unsupported_response");
        assert_eq!(value["status"], "ok");
    }
}

#[tokio::test]
async fn bounds_decompressed_html_and_does_not_parse_partial_pages() {
    let body = format!(
        "{}{}",
        yahoo("https://example.com", "Prefix", ""),
        "x".repeat(MAX_HTML_BYTES)
    );
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(body.as_bytes()).unwrap();
    let gzip = encoder.finish().unwrap();
    let first = TestServer::start(move |_| {
        TestResponse::bytes(200, "text/html", gzip.clone()).header("Content-Encoding", "gzip")
    });
    let second = TestServer::start(|_| html(&brave("https://example.org", "Fallback", "")));
    let value = result(&handler(&first, &second), json!({"query":"rust"}))
        .await
        .unwrap();
    assert_eq!(value["attempts"][0]["status"], "response_limit");
    assert_eq!(value["results"][0]["title"], "Fallback");
}

#[tokio::test]
async fn bounds_encoded_output_without_claiming_empty() {
    let body = (0..10)
        .map(|i| {
            yahoo(
                &format!("https://example.com/{i}"),
                &"é".repeat(128),
                &"\\\"".repeat(400),
            )
        })
        .collect::<String>();
    let first = TestServer::start(move |_| html(&body));
    let second = TestServer::start(|_| html("unused"));
    let value = result(
        &handler(&first, &second),
        json!({"query":"rust","maxResults":10,"maxOutputBytes":2048}),
    )
    .await
    .unwrap();
    assert_eq!(value["status"], "ok");
    assert_eq!(value["truncated"], true);
    assert!(serde_json::to_vec(&value).unwrap().len() <= 2048);
    let first = TestServer::start(|_| {
        html(&yahoo(
            &format!("https://example.com/{}", "x".repeat(2000)),
            "Long",
            "",
        ))
    });
    assert_eq!(
        result(
            &handler(&first, &second),
            json!({"query":"rust","maxOutputBytes":1024})
        )
        .await,
        Err(ErrorCode::OutputLimit)
    );
}

#[tokio::test]
async fn follows_only_same_origin_bounded_redirects_without_cookies() {
    let first = TestServer::start(|request| {
        if request.path.starts_with("/landing") {
            assert!(!request.headers.contains_key("cookie"));
            html(&yahoo("https://example.com", "Found", ""))
        } else {
            let mut response = html("")
                .header("Location", "/landing")
                .header("Set-Cookie", "secret=never-send");
            response.status = 302;
            response
        }
    });
    let second = TestServer::start(|_| html("unused"));
    assert_eq!(
        result(&handler(&first, &second), json!({"query":"rust"}))
            .await
            .unwrap()["status"],
        "ok"
    );
    let target = TestServer::start(|_| html("must not fetch"));
    let location = target.url().to_string();
    let first =
        TestServer::start(move |_| TestResponse::text(302, "").header("Location", &location));
    let value = result(&handler(&first, &second), json!({"query":"rust"}))
        .await
        .unwrap();
    assert_eq!(value["attempts"][0]["status"], "unsupported_response");
    assert!(target.requests().is_empty());
    let first = TestServer::start(|_| TestResponse::text(302, "").header("Location", "/loop"));
    let value = result(&handler(&first, &second), json!({"query":"rust"}))
        .await
        .unwrap();
    assert_eq!(value["attempts"][0]["status"], "unsupported_response");
    assert_eq!(first.requests().len(), 4);
}

#[tokio::test]
async fn provider_timeout_leaves_time_for_fallback() {
    let first = TestServer::start(|_| html("late").delay(Duration::from_secs(9)));
    let second = TestServer::start(|_| html(&brave("https://example.com", "Fallback", "")));
    let value = result(&handler(&first, &second), json!({"query":"rust"}))
        .await
        .unwrap();
    assert_eq!(value["attempts"][0]["status"], "timeout");
    assert_eq!(value["status"], "ok");
}

impl OperationHandler for SearchHandler {
    fn operations(&self) -> &'static [&'static str] {
        &["web_search"]
    }
    fn start(&self, _operation: &str, params: Option<Value>) -> OperationFuture {
        SearchHandler::start(self, params)
    }
}

#[tokio::test]
async fn protocol_cancellation_keeps_other_searches_alive_and_stops_fallback() {
    let first = TestServer::start(|request| {
        if request.path.contains("slow") {
            html("late").delay(Duration::from_secs(5))
        } else {
            html(&yahoo("https://example.com", "Fast", ""))
        }
    });
    let second = TestServer::start(|_| html("must not fetch"));
    let (engine_input, mut input) = duplex(1 << 20);
    let (output, engine_output) = duplex(1 << 20);
    let engine =
        tokio::spawn(Engine::new(handler(&first, &second)).run(engine_input, engine_output));
    let mut output = FrameReader::new(output);
    async fn receive(output: &mut FrameReader<tokio::io::DuplexStream>) -> Value {
        match output.next_frame().await {
            LineRead::Frame(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(receive(&mut output).await["type"], "ready");
    for id in ["slow", "fast"] {
        let request = json!({"type":"request","id":id,"operation":"web_search","timeoutMs":30000,"params":{"query":id}});
        input
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
    }
    for _ in 0..1000 {
        if first.requests().iter().any(|r| r.path.contains("slow")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    input
        .write_all(b"{\"type\":\"cancel\",\"id\":\"slow\"}\n")
        .await
        .unwrap();
    for _ in 0..2 {
        let value = receive(&mut output).await;
        if value["id"] == "slow" {
            assert_eq!(value["code"], "cancelled");
        } else {
            assert_eq!(value["id"], "fast");
            assert_eq!(value["result"]["results"][0]["title"], "Fast");
        }
    }
    input.write_all(b"{\"type\":\"shutdown\"}\n").await.unwrap();
    assert_eq!(engine.await.unwrap(), ExitReason::Shutdown);
    assert!(second.requests().is_empty());
}
