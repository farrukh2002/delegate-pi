use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, RequestBuilder, Url};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    collect, AttemptStatus, Candidate, Failure, Provider, Reason, SearchItem, SearchParams,
};

type Decoded = (AttemptStatus, Vec<SearchItem>, bool);

pub(super) fn request(
    client: &Client,
    provider: Provider,
    url: Url,
    params: &SearchParams,
) -> RequestBuilder {
    let query = params.provider_query();
    let count = params.max_results;
    match provider {
        Provider::Exa => tool_call(
            client,
            url,
            "web_search_exa",
            json!({"query": query, "numResults": count}),
        ),
        Provider::Parallel => tool_call(
            client,
            url,
            "web_search",
            json!({"objective": query, "search_queries": [query]}),
        ),
        Provider::Firecrawl => post(
            client,
            url,
            "application/json",
            &json!({"query": query, "limit": count}),
        ),
        Provider::Tavily => post(
            client,
            url,
            "application/json",
            &json!({
                "query": query,
                "search_depth": "basic",
                "chunks_per_source": 1,
                "max_results": count,
            }),
        )
        .header("X-Tavily-Access-Mode", "keyless")
        .header("X-Client-Name", "pi-web"),
    }
}

pub(super) fn decode(
    provider: Provider,
    body: &str,
    site: Option<&str>,
    max_results: usize,
) -> Result<Decoded, Failure> {
    let candidates = match provider {
        Provider::Exa => exa(body)?,
        Provider::Parallel => parallel(body)?,
        Provider::Firecrawl => firecrawl(body)?,
        Provider::Tavily => tavily(body)?,
    };
    Ok(collect(provider, candidates, site, max_results))
}

fn tool_call(client: &Client, url: Url, tool: &str, arguments: Value) -> RequestBuilder {
    post(
        client,
        url,
        "application/json, text/event-stream",
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }),
    )
}

fn post(client: &Client, url: Url, accept: &str, body: &Value) -> RequestBuilder {
    client
        .post(url)
        .header(ACCEPT, accept)
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
}

fn invalid() -> Failure {
    Failure::new(
        AttemptStatus::UnsupportedResponse,
        Some(200),
        Some(Reason::InvalidPayload),
    )
}

fn refused() -> Failure {
    Failure::new(
        AttemptStatus::Blocked,
        Some(200),
        Some(Reason::ProviderError),
    )
}

#[derive(Deserialize)]
struct Envelope {
    result: Option<ToolResult>,
    error: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolResult {
    #[serde(default)]
    content: Vec<Content>,
    #[serde(default)]
    is_error: bool,
    structured_content: Option<Value>,
}

#[derive(Deserialize)]
struct Content {
    text: Option<String>,
}

fn tool_result(body: &str) -> Result<ToolResult, Failure> {
    let body = body.trim();
    let payload = if body.starts_with('{') {
        body
    } else {
        body.lines()
            .find_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .ok_or_else(invalid)?
    };
    let envelope: Envelope = serde_json::from_str(payload).map_err(|_| invalid())?;
    if envelope.error.is_some() {
        return Err(refused());
    }
    let result = envelope.result.ok_or_else(invalid)?;
    if result.is_error {
        return Err(refused());
    }
    Ok(result)
}

fn exa(body: &str) -> Result<Vec<Candidate>, Failure> {
    let text = tool_result(body)?
        .content
        .into_iter()
        .find_map(|content| content.text)
        .ok_or_else(invalid)?;
    Ok(text
        .split("\n\n---\n\n")
        .filter(|block| block.starts_with("Title:"))
        .filter_map(|block| {
            let field = |name: &str| block.lines().find_map(|line| line.strip_prefix(name));
            let url = field("URL:")?.trim().to_string();
            let title = field("Title:")
                .map(str::trim)
                .filter(|title| *title != "N/A")
                .unwrap_or_default()
                .to_string();
            let snippet = block
                .split_once("\nHighlights:")
                .or_else(|| block.split_once("\nText:"))
                .map_or("", |(_, rest)| rest)
                .to_string();
            Some(Candidate {
                url,
                title,
                snippet,
            })
        })
        .collect())
}

#[derive(Deserialize)]
struct ParallelPayload {
    #[serde(default)]
    results: Vec<ParallelItem>,
}

#[derive(Deserialize)]
struct ParallelItem {
    url: Option<String>,
    title: Option<String>,
    #[serde(default)]
    excerpts: Vec<String>,
}

fn parallel(body: &str) -> Result<Vec<Candidate>, Failure> {
    let value = tool_result(body)?.structured_content.ok_or_else(invalid)?;
    let payload: ParallelPayload = serde_json::from_value(value).map_err(|_| invalid())?;
    Ok(payload
        .results
        .into_iter()
        .filter_map(|item| {
            Some(Candidate {
                url: item.url?,
                title: item.title.unwrap_or_default(),
                snippet: item.excerpts.join(" "),
            })
        })
        .collect())
}

#[derive(Deserialize)]
struct FirecrawlResponse {
    success: bool,
    data: Option<FirecrawlData>,
}

#[derive(Deserialize)]
struct FirecrawlData {
    #[serde(default)]
    web: Vec<FirecrawlItem>,
}

#[derive(Deserialize)]
struct FirecrawlItem {
    url: Option<String>,
    title: Option<String>,
    description: Option<String>,
}

fn firecrawl(body: &str) -> Result<Vec<Candidate>, Failure> {
    let response: FirecrawlResponse = serde_json::from_str(body).map_err(|_| invalid())?;
    if !response.success {
        return Err(refused());
    }
    let data = response.data.ok_or_else(invalid)?;
    Ok(data
        .web
        .into_iter()
        .filter_map(|item| {
            Some(Candidate {
                url: item.url?,
                title: item.title.unwrap_or_default(),
                snippet: item.description.unwrap_or_default(),
            })
        })
        .collect())
}

#[derive(Deserialize)]
struct TavilyResponse {
    results: Vec<TavilyItem>,
}

#[derive(Deserialize)]
struct TavilyItem {
    url: Option<String>,
    title: Option<String>,
    content: Option<String>,
}

fn tavily(body: &str) -> Result<Vec<Candidate>, Failure> {
    let response: TavilyResponse = serde_json::from_str(body).map_err(|_| invalid())?;
    Ok(response
        .results
        .into_iter()
        .filter_map(|item| {
            Some(Candidate {
                url: item.url?,
                title: item.title.unwrap_or_default(),
                snippet: item.content.unwrap_or_default(),
            })
        })
        .collect())
}
