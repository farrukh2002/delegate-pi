use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;
use tokio::time::Instant;

use crate::engine::{OperationFuture, OperationOutcome};
use crate::http_target::raw_has_userinfo;
use crate::protocol::ErrorCode;

mod api;
#[cfg(test)]
mod tests;

const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_CANDIDATES: usize = 100;
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(8);
const SEARCH_BUDGET: Duration = Duration::from_secs(20);
const COOLDOWN: Duration = Duration::from_secs(60);
const USER_AGENT: &str = concat!("pi-web/", env!("CARGO_PKG_VERSION"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
enum Provider {
    Exa,
    Parallel,
    Firecrawl,
    Tavily,
}

impl Provider {
    const ALL: [Provider; 4] = [
        Provider::Exa,
        Provider::Parallel,
        Provider::Firecrawl,
        Provider::Tavily,
    ];

    fn endpoint(self) -> &'static str {
        match self {
            Provider::Exa => "https://mcp.exa.ai/mcp",
            Provider::Parallel => "https://search.parallel.ai/mcp",
            Provider::Firecrawl => "https://api.firecrawl.dev/v2/search",
            Provider::Tavily => "https://api.tavily.com/search",
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
    CoolingDown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Reason {
    Connect,
    BodyRead,
    ProviderError,
    InvalidPayload,
}

#[derive(Clone, Copy, Debug)]
struct Failure {
    status: AttemptStatus,
    http_status: Option<u16>,
    reason: Option<Reason>,
}

impl Failure {
    fn new(status: AttemptStatus, http_status: Option<u16>, reason: Option<Reason>) -> Self {
        Failure {
            status,
            http_status,
            reason,
        }
    }

    fn needs_cooldown(&self) -> bool {
        self.status == AttemptStatus::Blocked
            || self.http_status.is_some_and(|status| status >= 500)
    }
}

#[derive(Debug, Serialize)]
struct SearchItem {
    title: String,
    url: String,
    snippet: String,
    source: Provider,
}

struct Candidate {
    url: String,
    title: String,
    snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Attempt {
    provider: Provider,
    status: AttemptStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Reason>,
}

impl Attempt {
    fn new(provider: Provider, status: AttemptStatus) -> Self {
        Attempt {
            provider,
            status,
            http_status: (status == AttemptStatus::ResponseLimit).then_some(200),
            reason: None,
        }
    }

    fn failed(provider: Provider, failure: Failure) -> Self {
        Attempt {
            provider,
            status: failure.status,
            http_status: failure.http_status,
            reason: failure.reason,
        }
    }
}

#[derive(Default)]
struct Cooldowns(Mutex<HashMap<Provider, Instant>>);

impl Cooldowns {
    fn active(&self, provider: Provider) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(&provider)
            .is_some_and(|until| *until > Instant::now())
    }

    fn start(&self, provider: Provider) {
        self.0
            .lock()
            .unwrap()
            .insert(provider, Instant::now() + COOLDOWN);
    }
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
    endpoints: Vec<(Provider, Url)>,
    cooldowns: Arc<Cooldowns>,
}

impl SearchHandler {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(SearchHandler {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .user_agent(USER_AGENT)
                .build()?,
            endpoints: Provider::ALL
                .map(|provider| (provider, Url::parse(provider.endpoint()).unwrap()))
                .to_vec(),
            cooldowns: Arc::default(),
        })
    }

    pub(crate) fn start(&self, params: Option<Value>) -> OperationFuture {
        let client = self.client.clone();
        let endpoints = self.endpoints.clone();
        let cooldowns = Arc::clone(&self.cooldowns);
        Box::pin(async move {
            match execute(&client, &endpoints, &cooldowns, params).await {
                Ok(result) => OperationOutcome::Result(result),
                Err(error) => OperationOutcome::Error(error),
            }
        })
    }
}

async fn execute(
    client: &Client,
    endpoints: &[(Provider, Url)],
    cooldowns: &Cooldowns,
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
    let started = Instant::now();
    for (provider, endpoint) in endpoints {
        if cooldowns.active(*provider) {
            result
                .attempts
                .push(Attempt::new(*provider, AttemptStatus::CoolingDown));
            continue;
        }
        let Some(remaining) = SEARCH_BUDGET
            .checked_sub(started.elapsed())
            .filter(|remaining| !remaining.is_zero())
        else {
            break;
        };
        let attempt = tokio::time::timeout(
            remaining.min(PROVIDER_TIMEOUT),
            fetch(client, *provider, endpoint, &params),
        )
        .await;
        let (attempt, items, truncated) = match attempt {
            Ok(Ok((status, items, truncated))) => {
                (Attempt::new(*provider, status), items, truncated)
            }
            Ok(Err(failure)) => {
                if failure.needs_cooldown() {
                    cooldowns.start(*provider);
                }
                (Attempt::failed(*provider, failure), Vec::new(), false)
            }
            Err(_) => (
                Attempt::failed(*provider, Failure::new(AttemptStatus::Timeout, None, None)),
                Vec::new(),
                false,
            ),
        };
        let status = attempt.status;
        result.attempts.push(attempt);
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
    url: &Url,
    params: &SearchParams,
) -> Result<(AttemptStatus, Vec<SearchItem>, bool), Failure> {
    let mut response = api::request(client, provider, url.clone(), params)
        .send()
        .await
        .map_err(|_| Failure::new(AttemptStatus::NetworkError, None, Some(Reason::Connect)))?;
    let status = response.status().as_u16();
    if matches!(status, 202 | 403 | 429) {
        return Err(Failure::new(AttemptStatus::Blocked, Some(status), None));
    }
    if status != 200 {
        return Err(Failure::new(AttemptStatus::HttpError, Some(status), None));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        Failure::new(
            AttemptStatus::NetworkError,
            Some(status),
            Some(Reason::BodyRead),
        )
    })? {
        if chunk.len() > MAX_BODY_BYTES - bytes.len() {
            return Err(Failure::new(
                AttemptStatus::ResponseLimit,
                Some(status),
                None,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = std::str::from_utf8(&bytes).map_err(|_| {
        Failure::new(
            AttemptStatus::UnsupportedResponse,
            Some(status),
            Some(Reason::InvalidPayload),
        )
    })?;
    api::decode(provider, body, params.site.as_deref(), params.max_results)
}

fn collect(
    provider: Provider,
    candidates: Vec<Candidate>,
    site: Option<&str>,
    max_results: usize,
) -> (AttemptStatus, Vec<SearchItem>, bool) {
    let candidate_limit_reached = candidates.len() > MAX_CANDIDATES;
    let mut truncated = candidate_limit_reached;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for candidate in candidates.into_iter().take(MAX_CANDIDATES) {
        let Some(url) = result_url(&candidate.url) else {
            continue;
        };
        if site.is_some_and(|site| {
            !url.host_str()
                .is_some_and(|host| host == site || host.ends_with(&format!(".{site}")))
        }) {
            continue;
        }
        if !seen.insert(url.as_str().to_string()) {
            continue;
        }
        if items.len() == max_results {
            truncated = true;
            break;
        }
        let (title, title_cut) = plain_text(&candidate.title, 256);
        let title = if title.is_empty() {
            url.host_str().unwrap_or_default().to_string()
        } else {
            title
        };
        let (snippet, _) = plain_text(&candidate.snippet, 512);
        truncated |= title_cut;
        items.push(SearchItem {
            title,
            url: url.into(),
            snippet,
            source: provider,
        });
    }
    let status = if !items.is_empty() {
        AttemptStatus::Ok
    } else if candidate_limit_reached {
        AttemptStatus::ResponseLimit
    } else {
        AttemptStatus::Empty
    };
    (status, items, truncated)
}

fn result_url(raw: &str) -> Option<Url> {
    if raw.len() > 16384 || raw_has_userinfo(raw) {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
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
