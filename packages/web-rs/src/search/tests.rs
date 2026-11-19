use super::*;
use crate::engine::{Engine, ExitReason, OperationHandler};
use crate::frame_reader::{FrameReader, LineRead};
use serde_json::json;
use tokio::io::{duplex, AsyncWriteExt};

#[path = "../../tests/support/mod.rs"]
mod support;
use support::{TestResponse, TestServer};

type Entry<'a> = (&'a str, &'a str, &'a str);

fn exa_body(entries: &[Entry]) -> String {
    let text = entries
        .iter()
        .map(|(url, title, snippet)| {
            format!(
                "Title: {title}\nURL: {url}\nPublished: N/A\nAuthor: N/A\nHighlights:\n{snippet}"
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let envelope =
        json!({"result":{"content":[{"type":"text","text":text}]},"jsonrpc":"2.0","id":1});
    format!("event: message\ndata: {envelope}\n\n")
}

fn parallel_body(entries: &[Entry]) -> String {
    let results = entries
        .iter()
        .map(|(url, title, snippet)| {
            json!({"url":url,"title":title,"publish_date":null,"excerpts":[snippet, "more"]})
        })
        .collect::<Vec<_>>();
    json!({
        "jsonrpc":"2.0","id":1,
        "result":{"content":[{"text":"{}","type":"text"}],"structuredContent":{"results":results}}
    })
    .to_string()
}

fn firecrawl_body(entries: &[Entry]) -> String {
    let web = entries
        .iter()
        .map(|(url, title, snippet)| json!({"url":url,"title":title,"description":snippet}))
        .collect::<Vec<_>>();
    json!({"success":true,"data":{"web":web}}).to_string()
}

fn tavily_body(entries: &[Entry]) -> String {
    let results = entries
        .iter()
        .map(|(url, title, snippet)| json!({"url":url,"title":title,"content":snippet}))
        .collect::<Vec<_>>();
    json!({"query":"q","results":results}).to_string()
}

fn body(provider: Provider, entries: &[Entry]) -> String {
    match provider {
        Provider::Exa => exa_body(entries),
        Provider::Parallel => parallel_body(entries),
        Provider::Firecrawl => firecrawl_body(entries),
        Provider::Tavily => tavily_body(entries),
    }
}

fn ok(provider: Provider, entries: &[Entry]) -> TestResponse {
    let content_type = match provider {
        Provider::Exa => "text/event-stream",
        _ => "application/json",
    };
    TestResponse::bytes(200, content_type, body(provider, entries).into_bytes())
}

fn handler(servers: &[(Provider, &TestServer)]) -> SearchHandler {
    SearchHandler {
        client: SearchHandler::new().unwrap().client,
        endpoints: servers
            .iter()
            .map(|(provider, server)| (*provider, Url::parse(server.url()).unwrap()))
            .collect(),
        cooldowns: Arc::default(),
    }
}

async fn result(handler: &SearchHandler, params: Value) -> Result<Value, ErrorCode> {
    match handler.start(Some(params)).await {
        OperationOutcome::Result(value) => Ok(value),
        OperationOutcome::Error(code) => Err(code),
    }
}

fn decode(provider: Provider, entries: &[Entry], site: Option<&str>, max: usize) -> Decoded {
    api::decode(provider, &body(provider, entries), site, max).unwrap()
}

type Decoded = (AttemptStatus, Vec<SearchItem>, bool);

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
fn decodes_each_provider_into_the_same_item_shape() {
    for provider in Provider::ALL {
        let (status, items, truncated) = decode(
            provider,
            &[(
                "https://example.com/a?utm_source=x&k=1#part",
                " A   B ",
                "useful text",
            )],
            None,
            5,
        );
        assert_eq!(status, AttemptStatus::Ok);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "A B");
        assert_eq!(items[0].url, "https://example.com/a?k=1");
        assert!(items[0].snippet.starts_with("useful text"));
        assert_eq!(items[0].source, provider);
        assert!(!truncated);
    }
}

#[test]
fn decodes_exa_answers_sent_as_plain_json_and_missing_titles() {
    let text = "Title: N/A\nURL: https://example.com/x\nHighlights:\ntext";
    let plain = json!({"result":{"content":[{"type":"text","text":text}]}}).to_string();
    let (status, items, _) = api::decode(Provider::Exa, &plain, None, 5).unwrap();
    assert_eq!(status, AttemptStatus::Ok);
    assert_eq!(items[0].title, "example.com");
    assert_eq!(items[0].snippet, "text");
}

#[test]
fn rejects_unsafe_result_urls_and_strips_tracking() {
    for raw in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "/relative",
        "https://user:password@example.com",
        "https://@example.com/",
        &format!("https://example.com/{}", "x".repeat(4096)),
    ] {
        assert!(result_url(raw).is_none(), "{raw}");
    }
    let raw = "https://example.com/a?token=A%20B&empty&x=%2f";
    assert_eq!(result_url(raw).unwrap().as_str(), raw);
    assert_eq!(
        result_url("https://example.com/a?gclid=1&utm_medium=x&k=v#f")
            .unwrap()
            .as_str(),
        "https://example.com/a?k=v"
    );
}

#[test]
fn deduplicates_and_preserves_order_with_bounded_text() {
    let long = "é".repeat(500);
    let title = "é".repeat(200);
    let entries = [
        ("https://example.com/a#one", "First", long.as_str()),
        (
            "https://example.com/a?utm_source=x#two",
            "Duplicate",
            "duplicate",
        ),
        ("https://example.com/b", title.as_str(), "second"),
        ("https://example.com/c", "Third", "third"),
    ];
    let (status, items, truncated) = decode(Provider::Tavily, &entries, None, 2);
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
    let entries = [
        ("https://example.com/a", "Root", ""),
        ("https://docs.example.com/b", "Subdomain", ""),
        ("https://evil-example.com/c", "Wrong", ""),
        ("https://example.com.evil.org/d", "Wrong", ""),
    ];
    let (_, items, _) = decode(Provider::Firecrawl, &entries, Some("example.com"), 10);
    assert_eq!(items.len(), 2);
    let (status, items, _) = decode(Provider::Firecrawl, &entries, Some("not.example.org"), 10);
    assert_eq!(status, AttemptStatus::Empty);
    assert!(items.is_empty());
}

#[test]
fn does_not_claim_empty_when_the_candidate_limit_hides_a_match() {
    let wrong = ("https://other.example/result", "Wrong site", "");
    let mut entries = vec![wrong; 100];
    entries.push(("https://example.com/result", "Match", ""));
    let (status, items, truncated) = decode(Provider::Tavily, &entries, Some("example.com"), 5);
    assert_eq!(status, AttemptStatus::ResponseLimit);
    assert!(items.is_empty());
    assert!(truncated);
}

#[test]
fn reports_provider_errors_and_malformed_payloads() {
    let rpc_error = json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"rate limit"}});
    let tool_error = json!({"result":{"content":[{"type":"text","text":"no"}],"isError":true}});
    let failure = |provider, body: &str| api::decode(provider, body, None, 5).unwrap_err();
    for provider in [Provider::Exa, Provider::Parallel] {
        for body in [rpc_error.to_string(), tool_error.to_string()] {
            let failure = failure(provider, &body);
            assert_eq!(failure.status, AttemptStatus::Blocked);
            assert_eq!(failure.http_status, Some(200));
            assert_eq!(failure.reason, Some(Reason::ProviderError));
        }
    }
    let refused = failure(Provider::Firecrawl, r#"{"success":false,"error":"x"}"#);
    assert_eq!(refused.status, AttemptStatus::Blocked);
    assert_eq!(refused.reason, Some(Reason::ProviderError));
    for (provider, body) in [
        (Provider::Exa, "not json"),
        (Provider::Exa, "event: message\n\n"),
        (Provider::Parallel, r#"{"result":{"content":[]}}"#),
        (Provider::Firecrawl, "<html></html>"),
        (Provider::Firecrawl, r#"{"success":true}"#),
        (Provider::Tavily, r#"{"detail":{"error":"x"}}"#),
    ] {
        let failure = failure(provider, body);
        assert_eq!(failure.status, AttemptStatus::UnsupportedResponse, "{body}");
        assert_eq!(failure.reason, Some(Reason::InvalidPayload));
    }
}

#[tokio::test]
async fn sends_the_documented_request_to_each_provider() {
    for provider in Provider::ALL {
        let server = TestServer::start(move |_| ok(provider, &[("https://example.com", "T", "s")]));
        let value = result(
            &handler(&[(provider, &server)]),
            json!({"query":"a & b","site":"EXAMPLE.COM","maxResults":3}),
        )
        .await
        .unwrap();
        assert_eq!(value["status"], "ok");
        assert_eq!(value["site"], "example.com");
        assert_eq!(value["results"][0]["source"], json!(provider));
        let request = &server.requests()[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.headers["user-agent"], USER_AGENT);
        assert_eq!(request.headers["content-type"], "application/json");
        assert!(!request.headers.contains_key("authorization"));
        assert!(!request.headers.contains_key("cookie"));
        let sent: Value = serde_json::from_slice(&request.body).unwrap();
        let text = sent.to_string();
        assert!(text.contains("a & b site:example.com"), "{text}");
        match provider {
            Provider::Exa => {
                assert_eq!(sent["method"], "tools/call");
                assert_eq!(sent["params"]["name"], "web_search_exa");
                assert_eq!(sent["params"]["arguments"]["numResults"], 3);
                assert_eq!(
                    request.headers["accept"],
                    "application/json, text/event-stream"
                );
            }
            Provider::Parallel => {
                assert_eq!(sent["params"]["name"], "web_search");
                assert_eq!(
                    sent["params"]["arguments"]["search_queries"],
                    json!(["a & b site:example.com"])
                );
            }
            Provider::Firecrawl => assert_eq!(sent["limit"], 3),
            Provider::Tavily => {
                assert_eq!(sent["max_results"], 3);
                assert_eq!(request.headers["x-tavily-access-mode"], "keyless");
            }
        }
    }
}

#[tokio::test]
async fn stops_after_the_first_provider_with_results() {
    let first = TestServer::start(|_| ok(Provider::Exa, &[("https://example.com", "T", "s")]));
    let second = TestServer::start(|_| TestResponse::text(500, "unused"));
    let value = result(
        &handler(&[(Provider::Exa, &first), (Provider::Parallel, &second)]),
        json!({"query":"rust"}),
    )
    .await
    .unwrap();
    assert_eq!(value["attempts"], json!([{"provider":"exa","status":"ok"}]));
    assert!(second.requests().is_empty());
}

#[tokio::test]
async fn invalid_params_never_reach_a_provider() {
    let server = TestServer::start(|_| TestResponse::text(500, "unused"));
    assert_eq!(
        result(&handler(&[(Provider::Exa, &server)]), json!({"query":""})).await,
        Err(ErrorCode::InvalidParams)
    );
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn falls_back_on_failures_and_reports_each_attempt() {
    let rpc_error = json!({"jsonrpc":"2.0","id":1,"error":{"message":"limit"}}).to_string();
    let empty = parallel_body(&[]);
    for (status, content_type, payload, expected) in [
        (
            429,
            "text/plain",
            "x".to_string(),
            json!({"status":"blocked","httpStatus":429}),
        ),
        (
            202,
            "text/plain",
            "x".to_string(),
            json!({"status":"blocked","httpStatus":202}),
        ),
        (
            403,
            "text/plain",
            "x".to_string(),
            json!({"status":"blocked","httpStatus":403}),
        ),
        (
            503,
            "text/plain",
            "x".to_string(),
            json!({"status":"http_error","httpStatus":503}),
        ),
        (
            302,
            "text/plain",
            "x".to_string(),
            json!({"status":"http_error","httpStatus":302}),
        ),
        (
            200,
            "application/json",
            rpc_error,
            json!({"status":"blocked","httpStatus":200,"reason":"provider_error"}),
        ),
        (
            200,
            "application/json",
            "<html>".to_string(),
            json!({"status":"unsupported_response","httpStatus":200,"reason":"invalid_payload"}),
        ),
        (
            200,
            "application/json",
            empty.clone(),
            json!({"status":"empty"}),
        ),
    ] {
        let first = TestServer::start(move |_| {
            TestResponse::bytes(status, content_type, payload.clone().into_bytes())
        });
        let second =
            TestServer::start(|_| ok(Provider::Tavily, &[("https://example.com", "Found", "s")]));
        let search = handler(&[(Provider::Parallel, &first), (Provider::Tavily, &second)]);
        let value = result(&search, json!({"query":"rust"})).await.unwrap();
        assert_eq!(value["status"], "ok");
        let mut first_attempt = json!({"provider":"parallel"});
        first_attempt
            .as_object_mut()
            .unwrap()
            .extend(expected.as_object().unwrap().clone());
        assert_eq!(
            value["attempts"],
            json!([first_attempt, {"provider":"tavily","status":"ok"}])
        );
    }
}

#[tokio::test]
async fn skips_a_blocked_provider_while_it_cools_down() {
    let first = TestServer::start(|_| TestResponse::text(429, "slow down"));
    let second =
        TestServer::start(|_| ok(Provider::Tavily, &[("https://example.com", "Found", "s")]));
    let search = handler(&[(Provider::Firecrawl, &first), (Provider::Tavily, &second)]);
    let value = result(&search, json!({"query":"rust"})).await.unwrap();
    assert_eq!(value["attempts"][0]["status"], "blocked");
    let value = result(&search, json!({"query":"rust again"}))
        .await
        .unwrap();
    assert_eq!(
        value["attempts"],
        json!([
            {"provider":"firecrawl","status":"cooling_down"},
            {"provider":"tavily","status":"ok"}
        ])
    );
    assert_eq!(first.requests().len(), 1);
    assert_eq!(second.requests().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn asks_a_provider_again_after_its_cooldown() {
    let cooldowns = Cooldowns::default();
    assert!(!cooldowns.active(Provider::Exa));
    cooldowns.start(Provider::Exa);
    assert!(cooldowns.active(Provider::Exa));
    assert!(!cooldowns.active(Provider::Tavily));
    tokio::time::advance(COOLDOWN + Duration::from_secs(1)).await;
    assert!(!cooldowns.active(Provider::Exa));
}

#[tokio::test]
async fn does_not_cool_down_providers_that_only_found_nothing() {
    let first = TestServer::start(|_| ok(Provider::Tavily, &[]));
    let search = handler(&[(Provider::Tavily, &first)]);
    for _ in 0..2 {
        let value = result(&search, json!({"query":"rust"})).await.unwrap();
        assert_eq!(value["status"], "empty");
    }
    assert_eq!(first.requests().len(), 2);
}

#[tokio::test]
async fn distinguishes_total_unavailability_from_valid_empty_results() {
    let first = TestServer::start(|_| ok(Provider::Tavily, &[]));
    let second = TestServer::start(|_| TestResponse::text(429, "blocked"));
    let value = result(
        &handler(&[(Provider::Tavily, &first), (Provider::Firecrawl, &second)]),
        json!({"query":"rust"}),
    )
    .await
    .unwrap();
    assert_eq!(value["status"], "empty");
    assert_eq!(value["results"], json!([]));
    let first = TestServer::start(|_| TestResponse::text(429, "blocked"));
    let value = result(
        &handler(&[(Provider::Tavily, &first), (Provider::Firecrawl, &second)]),
        json!({"query":"rust"}),
    )
    .await
    .unwrap();
    assert_eq!(value["status"], "unavailable");
}

#[tokio::test]
async fn rejects_invalid_utf8() {
    let first = TestServer::start(|_| TestResponse::bytes(200, "application/json", vec![0xff]));
    let second =
        TestServer::start(|_| ok(Provider::Tavily, &[("https://example.com", "Found", "s")]));
    let value = result(
        &handler(&[(Provider::Firecrawl, &first), (Provider::Tavily, &second)]),
        json!({"query":"rust"}),
    )
    .await
    .unwrap();
    assert_eq!(
        value["attempts"][0],
        json!({"provider":"firecrawl","status":"unsupported_response","httpStatus":200,"reason":"invalid_payload"})
    );
    assert_eq!(value["status"], "ok");
}

#[tokio::test]
async fn bounds_the_response_body() {
    let big = vec![b' '; MAX_BODY_BYTES + 1];
    let first =
        TestServer::start(move |_| TestResponse::bytes(200, "application/json", big.clone()));
    let second = TestServer::start(|_| {
        ok(
            Provider::Tavily,
            &[("https://example.org", "Fallback", "s")],
        )
    });
    let value = result(
        &handler(&[(Provider::Firecrawl, &first), (Provider::Tavily, &second)]),
        json!({"query":"rust"}),
    )
    .await
    .unwrap();
    assert_eq!(value["attempts"][0]["status"], "response_limit");
    assert_eq!(value["results"][0]["title"], "Fallback");
}

#[tokio::test]
async fn bounds_encoded_output_without_claiming_empty() {
    let title = "é".repeat(128);
    let snippet = "\\\"".repeat(400);
    let urls = (0..10)
        .map(|i| format!("https://example.com/{i}"))
        .collect::<Vec<_>>();
    let entries = urls
        .iter()
        .map(|url| (url.as_str(), title.as_str(), snippet.as_str()))
        .collect::<Vec<_>>();
    let payload = tavily_body(&entries);
    let first = TestServer::start(move |_| {
        TestResponse::bytes(200, "application/json", payload.clone().into_bytes())
    });
    let value = result(
        &handler(&[(Provider::Tavily, &first)]),
        json!({"query":"rust","maxResults":10,"maxOutputBytes":2048}),
    )
    .await
    .unwrap();
    assert_eq!(value["status"], "ok");
    assert_eq!(value["truncated"], true);
    assert!(serde_json::to_vec(&value).unwrap().len() <= 2048);
    let long = format!("https://example.com/{}", "x".repeat(2000));
    let first = TestServer::start(move |_| ok(Provider::Tavily, &[(long.as_str(), "Long", "")]));
    assert_eq!(
        result(
            &handler(&[(Provider::Tavily, &first)]),
            json!({"query":"rust","maxOutputBytes":1024})
        )
        .await,
        Err(ErrorCode::OutputLimit)
    );
}

#[tokio::test]
async fn reports_a_connection_failure_with_its_reason() {
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", closed.local_addr().unwrap());
    drop(closed);
    let second =
        TestServer::start(|_| ok(Provider::Tavily, &[("https://example.com", "Found", "s")]));
    let search = SearchHandler {
        client: SearchHandler::new().unwrap().client,
        endpoints: vec![
            (Provider::Exa, Url::parse(&url).unwrap()),
            (Provider::Tavily, Url::parse(second.url()).unwrap()),
        ],
        cooldowns: Arc::default(),
    };
    let value = result(&search, json!({"query":"rust"})).await.unwrap();
    assert_eq!(
        value["attempts"][0],
        json!({"provider":"exa","status":"network_error","reason":"connect"})
    );
    assert_eq!(value["status"], "ok");
}

#[tokio::test]
async fn provider_timeout_leaves_time_for_fallback() {
    let first = TestServer::start(|_| ok(Provider::Exa, &[]).delay(Duration::from_secs(9)));
    let second = TestServer::start(|_| {
        ok(
            Provider::Tavily,
            &[("https://example.com", "Fallback", "s")],
        )
    });
    let value = result(
        &handler(&[(Provider::Exa, &first), (Provider::Tavily, &second)]),
        json!({"query":"rust"}),
    )
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
        let query = String::from_utf8_lossy(&request.body);
        if query.contains("slow") {
            ok(Provider::Tavily, &[]).delay(Duration::from_secs(5))
        } else {
            ok(Provider::Tavily, &[("https://example.com", "Fast", "s")])
        }
    });
    let second = TestServer::start(|_| TestResponse::text(500, "must not fetch"));
    let (engine_input, mut input) = duplex(1 << 20);
    let (output, engine_output) = duplex(1 << 20);
    let engine = tokio::spawn(
        Engine::new(handler(&[
            (Provider::Tavily, &first),
            (Provider::Firecrawl, &second),
        ]))
        .run(engine_input, engine_output),
    );
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
        if first
            .requests()
            .iter()
            .any(|r| String::from_utf8_lossy(&r.body).contains("slow"))
        {
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
