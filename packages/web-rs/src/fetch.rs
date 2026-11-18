use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, USER_AGENT};
use reqwest::Client;
use serde_json::{Map, Value};

use crate::http;
use crate::http_params::RequestParams;
use crate::http_response::{enforce_output_limit, read_text};
use crate::protocol::ErrorCode;

mod page;

use page::Page;

const PAGE_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn parse_params(params: Option<Value>) -> Result<RequestParams, ErrorCode> {
    let params = params.ok_or(ErrorCode::InvalidParams)?;
    let object = params.as_object().ok_or(ErrorCode::InvalidParams)?;
    if ["method", "headers", "body", "select"]
        .iter()
        .any(|name| object.contains_key(*name))
    {
        return Err(ErrorCode::InvalidParams);
    }
    let mut request = Map::new();
    for field in [
        "url",
        "credential",
        "maxResponseBytes",
        "maxOutputBytes",
        "maxRedirects",
    ] {
        if let Some(value) = object.get(field) {
            request.insert(field.to_string(), value.clone());
        }
    }
    request
        .entry("maxResponseBytes")
        .or_insert(Value::from(2_097_152));
    RequestParams::parse(Some(Value::Object(request)))
}

pub(crate) async fn execute(client: &Client, params: Option<Value>) -> Result<Value, ErrorCode> {
    let params = parse_params(params)?;
    let defaults = HeaderMap::from_iter([
        (USER_AGENT, HeaderValue::from_static(PAGE_USER_AGENT)),
        (
            ACCEPT,
            HeaderValue::from_static(
                "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.8",
            ),
        ),
    ]);
    let (response, redactor) = http::request(client, &params, &defaults).await?;
    let url = response.url().clone();
    let status = response.status().as_u16();
    let access = match status {
        200..=299 => "ok",
        401 => "auth_required",
        403 | 429 => "blocked",
        _ => "http_error",
    };
    let mut content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if access == "ok"
        && !matches!(
            content_type.as_str(),
            "" | "text/html"
                | "application/xhtml+xml"
                | "text/plain"
                | "text/markdown"
                | "text/x-markdown"
        )
    {
        return Err(ErrorCode::UnsupportedResponse);
    }
    let downloaded = read_text(response, access != "ok", params.max_response_bytes).await?;
    if downloaded.download_truncated && redactor.has_values() {
        return Err(ErrorCode::ResponseLimit);
    }
    if content_type.is_empty() {
        let prefix: String = downloaded
            .text
            .chars()
            .take(512)
            .collect::<String>()
            .to_ascii_lowercase();
        content_type = if [
            "<!doctype html",
            "<html",
            "<head",
            "<body",
            "<article",
            "<main",
            "<p>",
            "<h1",
        ]
        .iter()
        .any(|tag| prefix.contains(tag))
        {
            "text/html"
        } else {
            "text/plain"
        }
        .to_string();
    }
    let format = if content_type == "text/plain" {
        "text"
    } else {
        "markdown"
    };
    let mut page = if access != "ok" {
        Page::empty(access, format)
    } else if matches!(content_type.as_str(), "text/html" | "application/xhtml+xml") {
        if downloaded.download_truncated {
            return Err(ErrorCode::ResponseLimit);
        }
        page::extract(&downloaded.text, &url, &redactor)?
    } else {
        let (content, cut) = redactor.redact_limited(&downloaded.text, params.max_output_bytes);
        if content.trim().is_empty() {
            Page::empty("empty", format)
        } else {
            Page {
                title: String::new(),
                content,
                format,
                access: "ok",
                extraction: "text",
                truncated: cut,
            }
        }
    };
    page.truncated |= downloaded.download_truncated;
    let (url, url_cut) = redactor.redact_limited(url.as_str(), params.max_output_bytes);
    let (content_type, type_cut) = redactor.redact_limited(&content_type, params.max_output_bytes);
    if url_cut || type_cut {
        return Err(ErrorCode::OutputLimit);
    }
    let mut result = Map::from_iter([
        ("url".to_string(), Value::String(url)),
        ("status".to_string(), Value::from(status)),
        ("contentType".to_string(), Value::String(content_type)),
        ("title".to_string(), Value::String(page.title)),
        ("content".to_string(), Value::String(page.content)),
        ("format".to_string(), Value::from(page.format)),
        ("access".to_string(), Value::from(page.access)),
        ("extraction".to_string(), Value::from(page.extraction)),
        ("truncated".to_string(), Value::Bool(page.truncated)),
        (
            "bytesReceived".to_string(),
            Value::from(downloaded.bytes_received),
        ),
    ]);
    enforce_output_limit(&mut result, "content", params.max_output_bytes)?;
    if result["access"] == "ok"
        && result["content"]
            .as_str()
            .is_none_or(|text| text.trim().is_empty())
    {
        return Err(ErrorCode::OutputLimit);
    }
    Ok(Value::Object(result))
}
