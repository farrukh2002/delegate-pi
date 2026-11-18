use reqwest::header::{HeaderName, HeaderValue, CONTENT_LENGTH, HOST};
use reqwest::{Method, Url};
use serde_json::{Map, Value};

use crate::http_target;
use crate::json_pointer::Pointer;
use crate::protocol::ErrorCode;

pub(crate) const MAX_URL_BYTES: usize = 4_096;
pub(crate) const MAX_REQUEST_HEADERS: usize = 32;
pub(crate) const MAX_REQUEST_HEADER_BYTES: usize = 8_192;
pub(crate) const MAX_BODY_BYTES: usize = 32_768;
pub(crate) const MAX_SELECT_POINTERS: usize = 32;
pub(crate) const MAX_SELECT_POINTER_BYTES: usize = 256;
pub(crate) const MAX_CREDENTIAL_NAME_BYTES: usize = 256;
pub(crate) const DEFAULT_MAX_RESPONSE_BYTES: usize = 1_048_576;
pub(crate) const MAX_RESPONSE_BYTES: usize = 8_388_608;
pub(crate) const DEFAULT_MAX_OUTPUT_BYTES: usize = 8_192;
pub(crate) const MIN_OUTPUT_BYTES: usize = 1_024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 49_152;
pub(crate) const DEFAULT_MAX_REDIRECTS: usize = 5;
pub(crate) const MAX_REDIRECTS: usize = 10;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum HttpMethod {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
}

impl HttpMethod {
    fn from_value(value: Option<&Value>) -> Result<Self, ErrorCode> {
        let method = match value {
            None => return Ok(HttpMethod::Get),
            Some(value) => value.as_str().ok_or(ErrorCode::InvalidParams)?,
        };
        match method {
            "GET" => Ok(HttpMethod::Get),
            "HEAD" => Ok(HttpMethod::Head),
            "POST" => Ok(HttpMethod::Post),
            "PUT" => Ok(HttpMethod::Put),
            "PATCH" => Ok(HttpMethod::Patch),
            "DELETE" => Ok(HttpMethod::Delete),
            "OPTIONS" => Ok(HttpMethod::Options),
            _ => Err(ErrorCode::InvalidParams),
        }
    }

    pub(crate) fn as_reqwest(self) -> Method {
        match self {
            HttpMethod::Get => Method::GET,
            HttpMethod::Head => Method::HEAD,
            HttpMethod::Post => Method::POST,
            HttpMethod::Put => Method::PUT,
            HttpMethod::Patch => Method::PATCH,
            HttpMethod::Delete => Method::DELETE,
            HttpMethod::Options => Method::OPTIONS,
        }
    }

    pub(crate) fn is_get_or_head(self) -> bool {
        matches!(self, HttpMethod::Get | HttpMethod::Head)
    }

    pub(crate) fn allows_body(self) -> bool {
        !self.is_get_or_head()
    }
}

pub(crate) struct RequestParams {
    pub(crate) url: Url,
    pub(crate) method: HttpMethod,
    pub(crate) headers: reqwest::header::HeaderMap,
    pub(crate) body: Option<String>,
    pub(crate) credential: Option<String>,
    pub(crate) select: Vec<Pointer>,
    pub(crate) max_response_bytes: usize,
    pub(crate) max_output_bytes: usize,
    pub(crate) max_redirects: usize,
}

impl RequestParams {
    pub(crate) fn parse(params: Option<Value>) -> Result<Self, ErrorCode> {
        let params = params.ok_or(ErrorCode::InvalidParams)?;
        let object = params.as_object().ok_or(ErrorCode::InvalidParams)?;
        let url = object
            .get("url")
            .and_then(Value::as_str)
            .and_then(http_target::parse_request_url)
            .ok_or(ErrorCode::InvalidParams)?;
        let method = HttpMethod::from_value(object.get("method"))?;
        let headers = parse_headers(object)?;
        let body = parse_body(object, method)?;
        let credential = parse_credential(object)?;
        let select = parse_select(object)?;
        let max_response_bytes = integer_param(
            object,
            "maxResponseBytes",
            DEFAULT_MAX_RESPONSE_BYTES,
            MAX_RESPONSE_BYTES,
        )?;
        let max_output_bytes = range_param(
            object,
            "maxOutputBytes",
            DEFAULT_MAX_OUTPUT_BYTES,
            MIN_OUTPUT_BYTES,
            MAX_OUTPUT_BYTES,
        )?;
        let max_redirects = range_param(
            object,
            "maxRedirects",
            DEFAULT_MAX_REDIRECTS,
            0,
            MAX_REDIRECTS,
        )?;
        Ok(RequestParams {
            url,
            method,
            headers,
            body,
            credential,
            select,
            max_response_bytes,
            max_output_bytes,
            max_redirects,
        })
    }
}

fn parse_headers(object: &Map<String, Value>) -> Result<reqwest::header::HeaderMap, ErrorCode> {
    let mut headers = reqwest::header::HeaderMap::new();
    let values = match object.get("headers") {
        None => return Ok(headers),
        Some(Value::Object(values)) => values,
        Some(_) => return Err(ErrorCode::InvalidParams),
    };
    if values.len() > MAX_REQUEST_HEADERS {
        return Err(ErrorCode::InvalidParams);
    }
    let mut total_bytes = 0usize;
    for (name, value) in values {
        let value = value.as_str().ok_or(ErrorCode::InvalidParams)?;
        if restricted_header(name) {
            return Err(ErrorCode::InvalidParams);
        }
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            return Err(ErrorCode::InvalidParams);
        }
        total_bytes = total_bytes
            .checked_add(name.len() + value.len())
            .ok_or(ErrorCode::InvalidParams)?;
        if total_bytes > MAX_REQUEST_HEADER_BYTES {
            return Err(ErrorCode::InvalidParams);
        }
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| ErrorCode::InvalidParams)?;
        let value = HeaderValue::from_str(value).map_err(|_| ErrorCode::InvalidParams)?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn parse_body(
    object: &Map<String, Value>,
    method: HttpMethod,
) -> Result<Option<String>, ErrorCode> {
    let body = match object.get("body") {
        None => return Ok(None),
        Some(Value::String(body)) => body,
        Some(_) => return Err(ErrorCode::InvalidParams),
    };
    if !method.allows_body() || body.len() > MAX_BODY_BYTES {
        return Err(ErrorCode::InvalidParams);
    }
    Ok(Some(body.clone()))
}

fn parse_credential(object: &Map<String, Value>) -> Result<Option<String>, ErrorCode> {
    let credential = match object.get("credential") {
        None => return Ok(None),
        Some(Value::String(credential)) => credential,
        Some(_) => return Err(ErrorCode::InvalidParams),
    };
    if credential.is_empty() || credential.len() > MAX_CREDENTIAL_NAME_BYTES {
        return Err(ErrorCode::CredentialError);
    }
    Ok(Some(credential.clone()))
}

fn parse_select(object: &Map<String, Value>) -> Result<Vec<Pointer>, ErrorCode> {
    let values = match object.get("select") {
        None => return Ok(Vec::new()),
        Some(Value::Array(values)) => values,
        Some(_) => return Err(ErrorCode::InvalidParams),
    };
    if values.is_empty() || values.len() > MAX_SELECT_POINTERS {
        return Err(ErrorCode::InvalidParams);
    }
    let mut pointers = Vec::with_capacity(values.len());
    for value in values {
        let raw = value.as_str().ok_or(ErrorCode::InvalidParams)?;
        pointers.push(Pointer::parse(raw).ok_or(ErrorCode::InvalidParams)?);
    }
    Ok(pointers)
}

fn integer_param(
    object: &Map<String, Value>,
    name: &str,
    default: usize,
    max: usize,
) -> Result<usize, ErrorCode> {
    range_param(object, name, default, 1, max)
}

fn range_param(
    object: &Map<String, Value>,
    name: &str,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize, ErrorCode> {
    match object.get(name) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| (min..=max).contains(value))
            .ok_or(ErrorCode::InvalidParams),
    }
}

pub(crate) fn restricted_header(name: &str) -> bool {
    name.eq_ignore_ascii_case(HOST.as_str())
        || name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
        || [
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "proxy-connection",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "http2-settings",
        ]
        .iter()
        .any(|restricted| name.eq_ignore_ascii_case(restricted))
}

pub(crate) fn valid_header_name(name: &str) -> Option<HeaderName> {
    if name.contains(['\r', '\n']) {
        return None;
    }
    HeaderName::from_bytes(name.as_bytes()).ok()
}

pub(crate) fn valid_header_value(value: &str) -> Option<HeaderValue> {
    if value.contains(['\r', '\n']) {
        return None;
    }
    HeaderValue::from_str(value).ok()
}
