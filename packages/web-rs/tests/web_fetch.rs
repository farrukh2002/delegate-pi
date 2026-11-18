mod support;

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

use flate2::{write::GzEncoder, Compression};
use pi_web::engine::{OperationHandler, OperationOutcome};
use pi_web::operations::WebHandler;
use pi_web::protocol::ErrorCode;
use serde_json::{json, Value};
use support::{TestResponse, TestServer};

fn html(body: &str) -> TestResponse {
    TestResponse::bytes(200, "text/html; charset=utf-8", body.as_bytes().to_vec())
}

async fn fetch(url: &str, extra: Value) -> Result<Value, ErrorCode> {
    let mut params = extra.as_object().unwrap().clone();
    params.insert("url".into(), Value::from(url));
    match WebHandler::new()
        .unwrap()
        .start("web_fetch", Some(Value::Object(params)))
        .await
    {
        OperationOutcome::Result(value) => Ok(value),
        OperationOutcome::Error(code) => Err(code),
    }
}

fn article(extra: &str) -> String {
    format!("<!doctype html><html><head><title>Native reader &amp; Rust</title><style>STYLE_NOISE</style></head><body><nav>NAV_NOISE</nav><article><h1>Native reader</h1><p>{}</p>{extra}</article><footer>FOOTER_NOISE</footer><script>SCRIPT_NOISE</script></body></html>", "Rust ownership keeps memory safe without a garbage collector. This readable article describes values, borrowing, and lifetimes. ".repeat(8))
}

#[tokio::test]
async fn extracts_article_markdown_without_subresource_requests() {
    let page = article("<h2>Example</h2><pre><code>fn main() {\n    println!(\"hello\");\n}</code></pre><ul><li>First item</li><li>Second item</li></ul><p><a href='/guide?q=a%20b&amp;x=1#part'>Read the guide</a></p><iframe src='/frame'></iframe><img src='/pixel'><div hidden>HIDDEN_NOISE</div><div aria-hidden='true'>ARIA_NOISE</div>");
    let len = page.len();
    let server = TestServer::start(move |_| html(&page));
    let result = fetch(server.url(), json!({})).await.unwrap();
    assert_eq!(result["status"], 200);
    assert_eq!(result["title"], "Native reader & Rust");
    assert_eq!(result["format"], "markdown");
    assert_eq!(result["access"], "ok");
    assert_eq!(result["extraction"], "readability");
    assert_eq!(result["contentType"], "text/html");
    assert_eq!(result["bytesReceived"], len);
    assert_eq!(result["truncated"], false);
    let content = result["content"].as_str().unwrap();
    for expected in [
        "ownership",
        "## Example",
        "```",
        "fn main()",
        "First item",
        "Second item",
        &format!("{}/guide?q=a%20b&amp;x=1#part", server.url()),
    ] {
        assert!(content.contains(expected), "missing {expected}: {content}");
    }
    for excluded in [
        "NAV_NOISE",
        "FOOTER_NOISE",
        "STYLE_NOISE",
        "SCRIPT_NOISE",
        "HIDDEN_NOISE",
        "ARIA_NOISE",
        "/frame",
        "/pixel",
    ] {
        assert!(
            !content.contains(excluded),
            "unexpected {excluded}: {content}"
        );
    }
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert!(requests[0].body.is_empty());
    assert!(requests[0].headers["user-agent"].contains("Mozilla/5.0"));
    assert!(requests[0].headers["accept"].contains("text/html"));
}

#[tokio::test]
async fn falls_back_for_short_pages_and_repairs_malformed_html() {
    for page in [
        "<title>Short page</title><main><p>Hello &amp; welcome.</p></main>",
        "<main><h1>Short page</h1><p>Hello &amp; welcome.",
    ] {
        let server = TestServer::start(move |_| html(page));
        let result = fetch(server.url(), json!({})).await.unwrap();
        assert_eq!(result["access"], "ok");
        assert_eq!(result["title"], "Short page");
        assert_eq!(result["extraction"], "fallback");
        assert!(result["content"]
            .as_str()
            .unwrap()
            .contains("Hello & welcome."));
    }
}

#[tokio::test]
async fn resolves_links_from_the_final_http_url_and_ignores_alternate_urls() {
    let page = article("<base href='https://untrusted.invalid/'><link rel='canonical' href='https://untrusted.invalid/canonical'><meta http-equiv='refresh' content='0;url=https://untrusted.invalid/refresh'><p><a href='../guide'>Guide</a> <a href='javascript:alert(1)'>Script</a> <a href='data:text/plain,bad'>Data</a> <a href='file:///etc/passwd'>File</a> <a href='https://user:pass@example.com/'>Userinfo</a> <a href='https://@example.com/'>Empty userinfo</a></p>");
    let server = TestServer::start(move |request| {
        if request.path == "/start" {
            TestResponse::text(302, "redirect").header("Location", "/pages/article")
        } else {
            html(&page)
        }
    });
    let result = fetch(&format!("{}/start", server.url()), json!({}))
        .await
        .unwrap();
    assert_eq!(result["url"], format!("{}/pages/article", server.url()));
    let content = result["content"].as_str().unwrap();
    assert!(content.contains(&format!("{}/guide", server.url())));
    for excluded in [
        "untrusted.invalid",
        "javascript:",
        "data:",
        "file:",
        "user:pass",
        "@example.com",
    ] {
        assert!(!content.contains(excluded), "unexpected {excluded}");
    }
    assert_eq!(server.requests().len(), 2);
}

#[tokio::test]
async fn returns_plain_text_and_markdown_without_html_interpretation() {
    for (mime, format) in [
        ("text/plain", "text"),
        ("text/markdown", "markdown"),
        ("text/x-markdown", "markdown"),
    ] {
        let server = TestServer::start(move |_| {
            TestResponse::bytes(200, mime, b"# Source\n\n<literal> & text".to_vec())
        });
        let result = fetch(server.url(), json!({})).await.unwrap();
        assert_eq!(result["content"], "# Source\n\n<literal> & text");
        assert_eq!(result["format"], format);
        assert_eq!(result["extraction"], "text");
        assert_eq!(result["title"], "");
    }
}

#[tokio::test]
async fn handles_missing_content_types_and_xhtml() {
    for mime in ["", "application/xhtml+xml; charset=utf-8"] {
        let server = TestServer::start(move |_| {
            let mut response = TestResponse::bytes(
                200,
                mime,
                b"<!doctype html><title>Example</title><main><p>Readable content.</p></main>"
                    .to_vec(),
            );
            if mime.is_empty() {
                response.headers.clear();
            }
            response
        });
        let result = fetch(server.url(), json!({})).await.unwrap();
        assert_eq!(result["access"], "ok");
        assert!(result["content"]
            .as_str()
            .unwrap()
            .contains("Readable content."));
    }
    let server = TestServer::start(|_| {
        let mut response = TestResponse::text(200, "Plain content");
        response.headers.clear();
        response
    });
    let result = fetch(server.url(), json!({})).await.unwrap();
    assert_eq!(result["format"], "text");
    assert_eq!(result["contentType"], "text/plain");
}

#[tokio::test]
async fn reports_http_access_failures_without_reading_error_bodies() {
    for (status, access) in [
        (401, "auth_required"),
        (403, "blocked"),
        (429, "blocked"),
        (404, "http_error"),
        (503, "http_error"),
        (302, "http_error"),
    ] {
        let server = TestServer::start(move |_| {
            TestResponse::bytes(status, "application/octet-stream", vec![0xff; 32_000])
        });
        let result = fetch(server.url(), json!({"maxResponseBytes": 1}))
            .await
            .unwrap();
        assert_eq!(result["status"], status);
        assert_eq!(result["access"], access);
        assert_eq!(result["content"], "");
        assert_eq!(result["extraction"], "none");
        assert_eq!(result["bytesReceived"], 0);
    }
}

#[tokio::test]
async fn distinguishes_challenges_login_shells_and_empty_pages() {
    for (page, access) in [
        ("<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x'></script><p>Checking your browser</p>", "blocked"),
        ("<title>Verify you are human</title><form id='challenge-form'>Check</form>", "blocked"),
        ("<title>Sign in</title><h1>Sign in</h1><form><input type='password'></form>", "auth_required"),
        ("<div id='app'></div><noscript>Please enable JavaScript to continue.</noscript><script>app()</script>", "requires_javascript"),
        ("<main>JavaScript is required to use this app.</main>", "requires_javascript"),
        ("<html><body><script>app()</script></body></html>", "empty"),
        ("", "empty"),
    ] {
        let server = TestServer::start(move |_| html(page));
        let result = fetch(server.url(), json!({})).await.unwrap();
        assert_eq!(result["access"], access, "page {page}");
        assert_eq!(result["content"], "");
        assert_eq!(result["extraction"], "none");
    }
}

#[tokio::test]
async fn does_not_confuse_real_articles_with_javascript_shells_or_login_widgets() {
    let page = article("<noscript>Please enable JavaScript.</noscript><form><input type='password'></form><iframe src='/captcha'></iframe><h2>How to enable JavaScript</h2><p>A useful explanation of browser settings.</p>");
    let server = TestServer::start(move |_| html(&page));
    let result = fetch(server.url(), json!({})).await.unwrap();
    assert_eq!(result["access"], "ok");
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("browser settings"));
}

#[tokio::test]
async fn bounds_tables_links_text_and_encoded_output() {
    let links = (0..150)
        .map(|index| format!("<a href='/item/{index}'>Item {index}</a> "))
        .collect::<String>();
    let page = article(&format!("<p>{links}</p><table><tr><th>Name</th><th>Value</th></tr><tr><td>Rust</td><td>Safe</td></tr></table><p>{}</p>", "é\\\"\n".repeat(40_000)));
    let server = TestServer::start(move |_| html(&page));
    for limit in [1_024, 8_192, 49_152] {
        let result = fetch(server.url(), json!({"maxOutputBytes": limit}))
            .await
            .unwrap();
        assert_eq!(result["access"], "ok");
        assert_eq!(result["truncated"], true);
        assert!(serde_json::to_vec(&result).unwrap().len() <= limit);
        let content = result["content"].as_str().unwrap();
        assert!(content.matches("](").count() <= 100);
        assert!(content.is_char_boundary(content.len()));
    }
}

#[tokio::test]
async fn converts_tables_to_bounded_preformatted_text() {
    let page = article("<table><tr><th>Language</th><th>Type</th></tr><tr><td>Rust</td><td>Native</td></tr></table>");
    let server = TestServer::start(move |_| html(&page));
    let result = fetch(server.url(), json!({})).await.unwrap();
    let content = result["content"].as_str().unwrap();
    for text in ["```", "Language", "Type", "Rust", "Native"] {
        assert!(content.contains(text), "missing {text}: {content}");
    }
}

#[tokio::test]
async fn enforces_html_structure_bounds_before_readability() {
    for page in [
        format!(
            "<html><body>{}</body></html>",
            "<span></span>".repeat(50_001)
        ),
        format!("{}text{}", "<div>".repeat(100), "</div>".repeat(100)),
    ] {
        let server = TestServer::start(move |_| html(&page));
        assert_eq!(
            fetch(server.url(), json!({})).await,
            Err(ErrorCode::ResponseLimit)
        );
    }
}

#[tokio::test]
async fn refuses_partial_html_but_can_return_a_utf8_plaintext_prefix() {
    let server =
        TestServer::start(|_| html("<main><p>Readable content that must be complete.</p></main>"));
    assert_eq!(
        fetch(server.url(), json!({"maxResponseBytes": 10})).await,
        Err(ErrorCode::ResponseLimit)
    );
    let server = TestServer::start(|_| TestResponse::text(200, "héllo"));
    let result = fetch(server.url(), json!({"maxResponseBytes": 2}))
        .await
        .unwrap();
    assert_eq!(result["content"], "h");
    assert_eq!(result["bytesReceived"], 2);
    assert_eq!(result["truncated"], true);
}

#[tokio::test]
async fn decompresses_html_before_applying_the_download_limit() {
    let page = article("<h2>Compressed content</h2>");
    let len = page.len();
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(page.as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();
    let server = TestServer::start(move |_| {
        TestResponse::bytes(200, "text/html", compressed.clone()).header("Content-Encoding", "gzip")
    });
    let result = fetch(server.url(), json!({})).await.unwrap();
    assert_eq!(result["bytesReceived"], len);
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("Compressed content"));
    assert_eq!(
        fetch(server.url(), json!({"maxResponseBytes": 100})).await,
        Err(ErrorCode::ResponseLimit)
    );
}

#[tokio::test]
async fn rejects_unsupported_media_charsets_and_invalid_utf8() {
    for (mime, body) in [
        ("application/pdf", b"%PDF".to_vec()),
        ("application/json", b"{}".to_vec()),
        ("application/xml", b"<doc/>".to_vec()),
        ("image/png", vec![1, 2]),
        ("text/html; charset=iso-8859-1", b"text".to_vec()),
        ("text/html", vec![0xff]),
    ] {
        let server = TestServer::start(move |_| TestResponse::bytes(200, mime, body.clone()));
        assert_eq!(
            fetch(server.url(), json!({})).await,
            Err(ErrorCode::UnsupportedResponse),
            "{mime}"
        );
    }
}

#[tokio::test]
async fn enforces_redirect_limits_and_url_safety() {
    let server =
        TestServer::start(|_| TestResponse::text(302, "redirect").header("Location", "/again"));
    assert_eq!(
        fetch(server.url(), json!({"maxRedirects": 1})).await,
        Err(ErrorCode::RedirectLimit)
    );
    let server = TestServer::start(|_| {
        TestResponse::text(302, "redirect").header("Location", "file:///etc/passwd")
    });
    assert_eq!(
        fetch(server.url(), json!({})).await,
        Err(ErrorCode::NetworkError)
    );
    for url in [
        "file:///etc/passwd",
        "https://user:pass@example.com/",
        "https://@example.com/",
        "not-a-url",
    ] {
        assert_eq!(fetch(url, json!({})).await, Err(ErrorCode::InvalidParams));
    }
}

#[tokio::test]
async fn rejects_non_page_request_fields_and_bad_limits_before_network_access() {
    let server = TestServer::start(|_| panic!("invalid request reached the server"));
    for extra in [
        json!({"method":"POST"}),
        json!({"method":"GET"}),
        json!({"headers":{}}),
        json!({"body":""}),
        json!({"select":[""]}),
        json!({"maxResponseBytes":0}),
        json!({"maxResponseBytes":8_388_609}),
        json!({"maxOutputBytes":1023}),
        json!({"maxOutputBytes":49153}),
        json!({"maxRedirects":11}),
    ] {
        assert_eq!(
            fetch(server.url(), extra).await,
            Err(ErrorCode::InvalidParams)
        );
    }
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn returns_output_limit_when_metadata_cannot_fit() {
    let server = TestServer::start(|_| html("<title>Example</title><p>Content.</p>"));
    assert_eq!(
        fetch(
            &format!("{}/{}", server.url(), "a".repeat(1_100)),
            json!({"maxOutputBytes":1_024})
        )
        .await,
        Err(ErrorCode::OutputLimit)
    );
}

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

struct CredentialEnv {
    path: std::path::PathBuf,
    old_file: Option<std::ffi::OsString>,
    old_token: Option<std::ffi::OsString>,
}

impl CredentialEnv {
    fn new(origin: &str, token: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pi-fetch-credentials-{}-{}.json",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, json!({"page":{"origin":origin,"headers":{"Authorization":{"env":"PI_FETCH_TEST_TOKEN","prefix":"Bearer "}}}}).to_string()).unwrap();
        let guard = Self {
            path,
            old_file: std::env::var_os("PI_WEB_CREDENTIALS_FILE"),
            old_token: std::env::var_os("PI_FETCH_TEST_TOKEN"),
        };
        std::env::set_var("PI_WEB_CREDENTIALS_FILE", &guard.path);
        std::env::set_var("PI_FETCH_TEST_TOKEN", token);
        guard
    }
}

impl Drop for CredentialEnv {
    fn drop(&mut self) {
        for (key, value) in [
            ("PI_WEB_CREDENTIALS_FILE", &self.old_file),
            ("PI_FETCH_TEST_TOKEN", &self.old_token),
        ] {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

#[tokio::test]
async fn refuses_partial_plaintext_when_a_credential_is_used() {
    let _lock = ENV_LOCK.lock().await;
    let server = TestServer::start(|request| {
        assert_eq!(request.headers["authorization"], "Bearer page-private-key");
        TestResponse::text(200, "page-private-key")
    });
    let _env = CredentialEnv::new(server.url(), "page-private-key");
    assert_eq!(
        fetch(
            server.url(),
            json!({"credential": "page", "maxResponseBytes": 6})
        )
        .await,
        Err(ErrorCode::ResponseLimit)
    );
}

#[tokio::test]
async fn redacts_entities_markdown_punctuation_metadata_and_cross_node_values() {
    let _lock = ENV_LOCK.lock().await;
    let token = "abc_def<&token>";
    let page = article("<p>Bearer abc_def&lt;&amp;token&gt; is private. <a href='/abc_def%3C%26token%3E'>Encoded link</a> <a href='/abc_def&lt;&amp;token&gt;'>Secret link</a></p><p>abc_def&lt;&amp;<!--join-->token&gt;</p><pre><code>abc_def&lt;&amp;token&gt;</code></pre>").replace("Native reader &amp; Rust", "abc_def&lt;&amp;token&gt;");
    let server = TestServer::start(move |request| {
        assert_eq!(request.headers["authorization"], "Bearer abc_def<&token>");
        html(&page)
    });
    let _env = CredentialEnv::new(server.url(), token);
    let result = fetch(server.url(), json!({"credential":"page"}))
        .await
        .unwrap();
    let encoded = result.to_string();
    assert_eq!(result["title"], "[REDACTED]");
    assert!(!encoded.contains(token));
    assert!(!encoded.contains("abc_def&lt;"));
    assert!(!encoded.contains("abc\\_def"));
}

#[tokio::test]
async fn does_not_expand_its_own_markers_for_single_character_credentials() {
    let _lock = ENV_LOCK.lock().await;
    let server = TestServer::start(|_| {
        html("<title>R R</title><main><h1>Readable</h1><p>R is private.</p><ol><li>Example</li></ol></main>")
    });
    let _env = CredentialEnv::new(server.url(), "R");
    let result = fetch(server.url(), json!({"credential":"page"}))
        .await
        .unwrap();
    assert_eq!(result["title"], "[REDACTED] [REDACTED]");
    assert!(!result.to_string().contains("[[REDACTED]EDACTED]"));
}

#[tokio::test]
async fn credentials_stay_origin_scoped_and_are_not_reattached_after_redirects() {
    let _lock = ENV_LOCK.lock().await;
    let token = "page-private-key";
    let destination = TestServer::start(|request| {
        assert!(!request.headers.contains_key("authorization"));
        html("<main><p>A public destination.</p></main>")
    });
    let url = destination.url().to_string();
    let source = TestServer::start(move |request| {
        assert_eq!(request.headers["authorization"], "Bearer page-private-key");
        TestResponse::text(302, "redirect").header("Location", &url)
    });
    let _env = CredentialEnv::new(source.url(), token);
    let result = fetch(source.url(), json!({"credential":"page"}))
        .await
        .unwrap();
    assert_eq!(result["access"], "ok");
    assert!(!result.to_string().contains(token));
    assert_eq!(
        fetch(destination.url(), json!({"credential":"page"})).await,
        Err(ErrorCode::CredentialError)
    );
    assert_eq!(destination.requests().len(), 1);
    assert!(destination.requests()[0].headers["user-agent"].contains("Mozilla/5.0"));
}

#[tokio::test]
async fn keeps_public_defaults_out_of_redaction_and_allows_trusted_overrides() {
    let _lock = ENV_LOCK.lock().await;
    let server = TestServer::start(|request| {
        assert_eq!(request.headers["user-agent"], "private-user-agent");
        html("<main><p>Public Accept: text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.8</p><p>private-user-agent</p></main>")
    });
    let env = CredentialEnv::new(server.url(), "private-user-agent");
    let mut config: Value =
        serde_json::from_str(&std::fs::read_to_string(&env.path).unwrap()).unwrap();
    config["page"]["headers"]["User-Agent"] = json!({"env":"PI_FETCH_TEST_TOKEN"});
    std::fs::write(&env.path, config.to_string()).unwrap();
    let result = fetch(server.url(), json!({"credential":"page"}))
        .await
        .unwrap();
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("text/html,application/xhtml+xml"));
    assert!(!result.to_string().contains("private-user-agent"));
}

#[tokio::test]
async fn removes_inline_hidden_content_without_rejecting_short_javascript_guides() {
    let page = "<title>Browser settings</title><main><p>Enable JavaScript from the browser settings menu.</p><p style='DISPLAY : NONE !important'>STYLE_NOISE</p><p style='visibility: HIDDEN'>VISIBILITY_NOISE</p><p aria-hidden='TRUE'>ARIA_NOISE</p></main><noscript>Please enable JavaScript.</noscript>";
    let server = TestServer::start(move |_| html(page));
    let result = fetch(server.url(), json!({})).await.unwrap();
    assert_eq!(result["access"], "ok");
    let content = result["content"].as_str().unwrap();
    assert!(content.contains("browser settings menu"));
    assert!(!content.contains("NOISE"));
}
