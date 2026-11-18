use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, LOCATION};
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;

use crate::engine::{OperationFuture, OperationOutcome};
use crate::http_target::{raw_has_userinfo, same_origin};
use crate::protocol::ErrorCode;

mod providers;
#[cfg(test)]
mod tests;

use providers::parse;

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(8);
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Provider {
    Yahoo,
    Brave,
}

impl Provider {
    fn endpoint(self) -> &'static str {
        match self {
            Provider::Yahoo => "https://search.yahoo.com/search",
            Provider::Brave => "https://search.brave.com/search",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AttemptStatus {
    Ok,
    Empty,
    Blocked,
    HttpError,
    NetworkError,
    Timeout,
    UnsupportedResponse,
    ResponseLimit,
}

#[derive(Debug, Serialize)]
struct SearchItem {
    title: String,
    url: String,
    snippet: String,
    source: Provider,
}

#[derive(Debug, Serialize)]
struct Attempt {
    provider: Provider,
    status: AttemptStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    site: Option<String>,
    status: &'static str,
    results: Vec<SearchItem>,
    attempts: Vec<Attempt>,
    truncated: bool,
}

struct SearchParams {
    query: String,
    site: Option<String>,
    max_results: usize,
    max_output_bytes: usize,
}

impl SearchParams {
    fn parse(value: Option<Value>) -> Result<Self, ErrorCode> {
        let value = value.ok_or(ErrorCode::InvalidParams)?;
        let object = value.as_object().ok_or(ErrorCode::InvalidParams)?;
        let query = object
            .get("query")
            .and_then(Value::as_str)
            .ok_or(ErrorCode::InvalidParams)?;
        if query.len() > 512 || query.trim().is_empty() || query.chars().any(char::is_control) {
            return Err(ErrorCode::InvalidParams);
        }
        let site = object.get("site").map(normalize_site).transpose()?;
        let integer = |name: &str, default: usize, min: u64, max: u64| match object.get(name) {
            None => Ok(default),
            Some(value) => value
                .as_u64()
                .filter(|n| (min..=max).contains(n))
                .map(|n| n as usize)
                .ok_or(ErrorCode::InvalidParams),
        };
        Ok(SearchParams {
            query: query.trim().to_string(),
            site,
            max_results: integer("maxResults", 5, 1, 10)?,
            max_output_bytes: integer("maxOutputBytes", 8192, 1024, 49152)?,
        })
    }

    fn provider_query(&self) -> String {
        match &self.site {
            Some(site) => format!("{} site:{site}", self.query),
            None => self.query.clone(),
        }
    }
}

fn normalize_site(value: &Value) -> Result<String, ErrorCode> {
    let value = value.as_str().ok_or(ErrorCode::InvalidParams)?;
    if value.is_empty()
        || value.len() > 1024
        || value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/:@?#\\*%".contains(c))
    {
        return Err(ErrorCode::InvalidParams);
    }
    let url = Url::parse(&format!("https://{value}/")).map_err(|_| ErrorCode::InvalidParams)?;
    if url.domain().is_none() {
        return Err(ErrorCode::InvalidParams);
    }
    let host = url.host_str().ok_or(ErrorCode::InvalidParams)?;
    let host = host.strip_suffix('.').unwrap_or(host);
    if host.len() > 253
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || label.starts_with('-')
                || label.ends_with('-')
        })
    {
        return Err(ErrorCode::InvalidParams);
    }
    Ok(host.to_string())
}

pub struct SearchHandler {
    client: Client,
    endpoints: [(Provider, Url); 2],
}

impl SearchHandler {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(SearchHandler {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .user_agent(USER_AGENT)
                .build()?,
            endpoints: [Provider::Yahoo, Provider::Brave]
                .map(|provider| (provider, Url::parse(provider.endpoint()).unwrap())),
        })
    }

    pub(crate) fn start(&self, params: Option<Value>) -> OperationFuture {
        let client = self.client.clone();
        let endpoints = self.endpoints.clone();
        Box::pin(async move {
            match execute(&client, &endpoints, params).await {
                Ok(result) => OperationOutcome::Result(result),
                Err(error) => OperationOutcome::Error(error),
            }
        })
    }
}

async fn execute(
    client: &Client,
    endpoints: &[(Provider, Url); 2],
    params: Option<Value>,
) -> Result<Value, ErrorCode> {
    let params = SearchParams::parse(params)?;
    let mut result = SearchResult {
        query: params.query.clone(),
        site: params.site.clone(),
        status: "unavailable",
        results: Vec::new(),
        attempts: Vec::new(),
        truncated: false,
    };
    for (provider, endpoint) in endpoints {
        let attempt = tokio::time::timeout(
            PROVIDER_TIMEOUT,
            fetch(client, *provider, endpoint.clone(), &params),
        )
        .await;
        let (status, items, truncated) = match attempt {
            Ok(Ok(parsed)) => parsed,
            Ok(Err(status)) => (status, Vec::new(), false),
            Err(_) => (AttemptStatus::Timeout, Vec::new(), false),
        };
        result.attempts.push(Attempt {
            provider: *provider,
            status,
        });
        result.truncated |= truncated;
        if status == AttemptStatus::Empty {
            result.status = "empty";
        }
        if !items.is_empty() {
            result.status = "ok";
            result.results = items;
            break;
        }
    }
    if result.results.is_empty() && result.truncated {
        result.status = "unavailable";
    }
    loop {
        let encoded = serde_json::to_vec(&result).map_err(|_| ErrorCode::Internal)?;
        if encoded.len() <= params.max_output_bytes {
            return serde_json::to_value(result).map_err(|_| ErrorCode::Internal);
        }
        if result.results.len() <= 1 {
            return Err(ErrorCode::OutputLimit);
        }
        result.results.pop();
        result.truncated = true;
    }
}

async fn fetch(
    client: &Client,
    provider: Provider,
    mut url: Url,
    params: &SearchParams,
) -> Result<(AttemptStatus, Vec<SearchItem>, bool), AttemptStatus> {
    match provider {
        Provider::Yahoo => {
            url.query_pairs_mut()
                .append_pair("p", &params.provider_query());
        }
        Provider::Brave => {
            url.query_pairs_mut()
                .append_pair("q", &params.provider_query())
                .append_pair("source", "web");
        }
    }
    for redirects in 0..=3 {
        let mut response = client
            .get(url.clone())
            .header("Accept", "text/html")
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .await
            .map_err(|_| AttemptStatus::NetworkError)?;
        let status = response.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(AttemptStatus::UnsupportedResponse)?;
            if redirects == 3 || raw_has_userinfo(location) {
                return Err(AttemptStatus::UnsupportedResponse);
            }
            let next = url
                .join(location)
                .map_err(|_| AttemptStatus::UnsupportedResponse)?;
            if !same_origin(&url, &next)
                || next.as_str().len() > 4096
                || !next.username().is_empty()
                || next.password().is_some()
            {
                return Err(AttemptStatus::UnsupportedResponse);
            }
            url = next;
            continue;
        }
        if matches!(status, 202 | 403 | 429) {
            return Err(AttemptStatus::Blocked);
        }
        if status != 200 {
            return Err(AttemptStatus::HttpError);
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(
            content_type.split(';').next().unwrap_or("").trim(),
            "text/html" | "application/xhtml+xml"
        ) || content_type
            .split(';')
            .skip(1)
            .filter_map(|part| part.split_once('='))
            .any(|(name, value)| {
                name.trim() == "charset"
                    && !matches!(
                        value.trim().trim_matches('"'),
                        "utf-8" | "utf8" | "us-ascii"
                    )
            })
        {
            return Err(AttemptStatus::UnsupportedResponse);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AttemptStatus::NetworkError)?
        {
            if chunk.len() > MAX_HTML_BYTES - bytes.len() {
                return Err(AttemptStatus::ResponseLimit);
            }
            bytes.extend_from_slice(&chunk);
        }
        let html = std::str::from_utf8(&bytes).map_err(|_| AttemptStatus::UnsupportedResponse)?;
        return Ok(parse(
            provider,
            html,
            params.site.as_deref(),
            params.max_results,
        ));
    }
    Err(AttemptStatus::UnsupportedResponse)
}

fn result_url(provider: Provider, raw: &str) -> Option<Url> {
    if raw.len() > 16384 || raw_has_userinfo(raw) {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    if provider == Provider::Yahoo && url.host_str() == Some("r.search.yahoo.com") {
        let encoded = url
            .path()
            .split_once("/RU=")?
            .1
            .split("/RK=")
            .next()?
            .split("/RS=")
            .next()?;
        let encoded = encoded.replace('+', " ");
        let decoded = percent_encoding::percent_decode_str(&encoded)
            .decode_utf8()
            .ok()?;
        if raw_has_userinfo(&decoded) {
            return None;
        }
        url = Url::parse(&decoded).ok()?;
    }
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || matches!(
            url.host_str(),
            Some("search.yahoo.com" | "r.search.yahoo.com" | "search.brave.com")
        )
        || url.host_str() == Some("www.bing.com") && matches!(url.path(), "/aclick" | "/ck/a")
    {
        return None;
    }
    url.set_fragment(None);
    if let Some(query) = url.query() {
        let clean = query
            .split('&')
            .filter(|pair| {
                let name = pair.split('=').next().unwrap_or("");
                let name = percent_encoding::percent_decode_str(name)
                    .decode_utf8_lossy()
                    .to_ascii_lowercase();
                !name.starts_with("utm_")
                    && !matches!(name.as_str(), "gclid" | "fbclid" | "msclkid")
            })
            .collect::<Vec<_>>()
            .join("&");
        if clean != query {
            url.set_query(if clean.is_empty() { None } else { Some(&clean) });
        }
    }
    (url.as_str().len() <= 4096).then_some(url)
}

fn plain_text(text: &str, limit: usize) -> (String, bool) {
    let mut output = String::new();
    let mut space = false;
    for character in text.chars() {
        if character.is_whitespace() {
            space = !output.is_empty();
            continue;
        }
        if character.is_control() {
            continue;
        }
        if output.len() + usize::from(space) + character.len_utf8() > limit {
            return (output, true);
        }
        if space {
            output.push(' ');
            space = false;
        }
        output.push(character);
    }
    (output, false)
}
