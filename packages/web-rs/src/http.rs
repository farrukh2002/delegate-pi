use reqwest::header::{HeaderMap, LOCATION};
use reqwest::{Client, Response, StatusCode};
use serde_json::Value;

use crate::credentials;
use crate::engine::{OperationFuture, OperationOutcome};
use crate::http_params::{
    HttpMethod, RequestParams, MAX_REQUEST_HEADERS, MAX_REQUEST_HEADER_BYTES,
};
use crate::http_response::{read_result, ResponseOptions};
use crate::http_target::{raw_has_userinfo, same_origin, validate_redirect};
use crate::protocol::ErrorCode;
use crate::redaction::Redactor;

pub struct HttpHandler {
    client: Client,
}

impl HttpHandler {
    pub fn new() -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        Ok(HttpHandler { client })
    }

    pub(crate) fn start_fetch(&self, params: Option<Value>) -> OperationFuture {
        let client = self.client.clone();
        Box::pin(async move {
            match crate::fetch::execute(&client, params).await {
                Ok(value) => OperationOutcome::Result(value),
                Err(code) => OperationOutcome::Error(code),
            }
        })
    }

    pub(crate) fn start(&self, params: Option<Value>) -> OperationFuture {
        let client = self.client.clone();
        Box::pin(async move {
            match execute(&client, params).await {
                Ok(value) => OperationOutcome::Result(value),
                Err(code) => OperationOutcome::Error(code),
            }
        })
    }
}

async fn execute(client: &Client, params: Option<Value>) -> Result<Value, ErrorCode> {
    let params = RequestParams::parse(params)?;
    let (response, redactor) = request(client, &params, &HeaderMap::new()).await?;
    read_result(
        response,
        ResponseOptions {
            head: params.method == HttpMethod::Head,
            select: &params.select,
            max_response_bytes: params.max_response_bytes,
            max_output_bytes: params.max_output_bytes,
            redactor: &redactor,
        },
    )
    .await
}

pub(crate) async fn request(
    client: &Client,
    params: &RequestParams,
    defaults: &HeaderMap,
) -> Result<(Response, Redactor), ErrorCode> {
    let mut known_values = Vec::new();
    let mut headers = params.headers.clone();
    for value in headers.values() {
        known_values.push(String::from_utf8_lossy(value.as_bytes()).into_owned());
    }
    if let Some(name) = &params.credential {
        let name = name.clone();
        let url = params.url.clone();
        let credential = tokio::task::spawn_blocking(move || credentials::resolve(&name, &url))
            .await
            .map_err(|_| ErrorCode::CredentialError)??;
        known_values.extend(credential.secrets);
        for (name, value) in &credential.headers {
            headers.insert(name.clone(), value.clone());
        }
    }
    let mut effective_headers = defaults.clone();
    effective_headers.extend(headers.clone());
    let header_bytes: usize = effective_headers
        .iter()
        .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
        .sum();
    if effective_headers.len() > MAX_REQUEST_HEADERS || header_bytes > MAX_REQUEST_HEADER_BYTES {
        return Err(ErrorCode::InvalidParams);
    }
    let redactor = Redactor::new(known_values)?;
    let response = send(client, params, headers, defaults).await?;
    Ok((response, redactor))
}

async fn send(
    client: &Client,
    params: &RequestParams,
    mut headers: HeaderMap,
    defaults: &HeaderMap,
) -> Result<Response, ErrorCode> {
    let mut url = params.url.clone();
    let mut origin_changed = false;
    let mut redirects = 0usize;
    loop {
        let mut request = client
            .request(params.method.as_reqwest(), url.clone())
            .headers(defaults.clone());
        if !headers.is_empty() {
            request = request.headers(headers.clone());
        }
        if let Some(body) = &params.body {
            request = request.body(body.clone());
        }
        let response = request.send().await.map_err(|_| ErrorCode::NetworkError)?;
        if params.method.is_get_or_head() && is_redirect(response.status()) {
            if let Some(location) = response.headers().get(LOCATION) {
                if redirects >= params.max_redirects {
                    return Err(ErrorCode::RedirectLimit);
                }
                let location = location.to_str().map_err(|_| ErrorCode::NetworkError)?;
                if raw_has_userinfo(location) {
                    return Err(ErrorCode::NetworkError);
                }
                let next = url.join(location).map_err(|_| ErrorCode::NetworkError)?;
                validate_redirect(&url, &next)?;
                if !origin_changed && !same_origin(&url, &next) {
                    origin_changed = true;
                    headers.clear();
                }
                redirects += 1;
                url = next;
                continue;
            }
        }
        return Ok(response);
    }
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}
