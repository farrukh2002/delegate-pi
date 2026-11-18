use std::cell::Cell;
use std::collections::BTreeMap;
use std::io::{self, Write};

use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use reqwest::Response;
use serde_json::{Map, Value};

use crate::json_pointer::{select, Pointer};
use crate::protocol::ErrorCode;
use crate::redaction::{sensitive_header, RedactedValue, Redactor, REDACTED};

const MAX_RESPONSE_HEADER_BYTES: usize = 4_096;

pub(crate) struct ResponseOptions<'a> {
    pub(crate) head: bool,
    pub(crate) select: &'a [Pointer],
    pub(crate) max_response_bytes: usize,
    pub(crate) max_output_bytes: usize,
    pub(crate) redactor: &'a Redactor,
}

pub(crate) struct Downloaded {
    pub(crate) url: String,
    pub(crate) status: u16,
    pub(crate) headers: HeaderMap,
    pub(crate) text: String,
    pub(crate) bytes_received: u64,
    pub(crate) download_truncated: bool,
}

pub(crate) async fn read_text(
    mut response: Response,
    head: bool,
    max_response_bytes: usize,
) -> Result<Downloaded, ErrorCode> {
    let url = response.url().as_str().to_string();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let no_body = head || matches!(status, 100..=199 | 204 | 304);
    let mut body_bytes = Vec::new();
    let mut bytes_received = 0u64;
    let mut download_truncated = false;
    if !no_body {
        if declared_binary(&headers)? {
            return Err(ErrorCode::UnsupportedResponse);
        }
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ErrorCode::NetworkError)?
        {
            let total = body_bytes.len();
            if total < max_response_bytes {
                let take = chunk.len().min(max_response_bytes - total);
                body_bytes.extend_from_slice(&chunk[..take]);
                bytes_received = body_bytes.len() as u64;
                if take < chunk.len() {
                    download_truncated = true;
                    break;
                }
            } else if !chunk.is_empty() {
                download_truncated = true;
                break;
            }
        }
    }
    let text = decode_text(body_bytes, download_truncated)?;
    Ok(Downloaded {
        url,
        status,
        headers,
        text,
        bytes_received,
        download_truncated,
    })
}

pub(crate) async fn read_result(
    response: Response,
    options: ResponseOptions<'_>,
) -> Result<Value, ErrorCode> {
    let Downloaded {
        url,
        status,
        headers,
        text,
        bytes_received,
        download_truncated,
    } = read_text(response, options.head, options.max_response_bytes).await?;
    let (body, missing_pointers, body_truncated) =
        response_body(&text, download_truncated, &options)?;
    let (headers, headers_truncated) = encode_headers(&headers, options.redactor);
    let mut result = Map::new();
    result.insert(
        "url".to_string(),
        Value::String(options.redactor.redact(&url)),
    );
    result.insert("status".to_string(), Value::from(status));
    result.insert("headers".to_string(), Value::Object(headers));
    result.insert("body".to_string(), Value::String(body));
    result.insert(
        "truncated".to_string(),
        Value::Bool(download_truncated || headers_truncated || body_truncated),
    );
    result.insert("bytesReceived".to_string(), Value::from(bytes_received));
    result.insert(
        "missingPointers".to_string(),
        Value::Array(missing_pointers),
    );
    enforce_output_limit(&mut result, "body", options.max_output_bytes)?;
    Ok(Value::Object(result))
}

fn response_body(
    text: &str,
    download_truncated: bool,
    options: &ResponseOptions<'_>,
) -> Result<(String, Vec<Value>, bool), ErrorCode> {
    if download_truncated && (!options.select.is_empty() || options.redactor.has_values()) {
        return Err(ErrorCode::ResponseLimit);
    }
    let document = if !options.select.is_empty() {
        Some(serde_json::from_str::<Value>(text).map_err(|_| ErrorCode::InvalidJson)?)
    } else if options.redactor.has_values() {
        serde_json::from_str::<Value>(text).ok()
    } else {
        None
    };
    let Some(document) = document else {
        let (body, truncated) = options
            .redactor
            .redact_limited(text, options.max_output_bytes);
        return Ok((body, Vec::new(), truncated));
    };
    let truncated = Cell::new(false);
    let wrap = |value| RedactedValue {
        value,
        redactor: options.redactor,
        limit: options.max_output_bytes,
        truncated: &truncated,
    };
    if options.select.is_empty() {
        let (body, limited) = encode_json_prefix(&wrap(&document), options.max_output_bytes)?;
        return Ok((body, Vec::new(), limited || truncated.get()));
    }
    let (found, missing) = select(&document, options.select);
    let found: BTreeMap<_, _> = found
        .into_iter()
        .map(|(key, value)| (options.redactor.redact(&key), wrap(value)))
        .collect();
    let (body, limited) = encode_json_prefix(&found, options.max_output_bytes)?;
    let missing = missing
        .into_iter()
        .map(|pointer| Value::String(options.redactor.redact(&pointer)))
        .collect();
    Ok((body, missing, limited || truncated.get()))
}

struct PrefixWriter {
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl Write for PrefixWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let count = bytes.len().min(self.limit - self.bytes.len());
        if count == 0 {
            self.truncated = true;
            return Err(io::Error::other("Output limit reached"));
        }
        self.bytes.extend_from_slice(&bytes[..count]);
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encode_json_prefix(
    value: &impl serde::Serialize,
    limit: usize,
) -> Result<(String, bool), ErrorCode> {
    let mut writer = PrefixWriter {
        bytes: Vec::new(),
        limit,
        truncated: false,
    };
    if serde_json::to_writer(&mut writer, value).is_err() && !writer.truncated {
        return Err(ErrorCode::Internal);
    }
    let body = decode_text(writer.bytes, writer.truncated)?;
    Ok((body, writer.truncated))
}

fn declared_binary(headers: &HeaderMap) -> Result<bool, ErrorCode> {
    let Some(value) = headers.get(CONTENT_TYPE) else {
        return Ok(false);
    };
    let value = value.to_str().map_err(|_| ErrorCode::UnsupportedResponse)?;
    Ok(!is_text_content_type(value))
}

fn is_text_content_type(value: &str) -> bool {
    let mut parts = value.split(';');
    let essence = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    let text_type = essence.starts_with("text/")
        || essence == "application/json"
        || essence.ends_with("+json")
        || essence == "application/xml"
        || essence.ends_with("+xml");
    text_type
        && parts.all(|part| {
            let Some((name, charset)) = part.split_once('=') else {
                return true;
            };
            if !name.trim().eq_ignore_ascii_case("charset") {
                return true;
            }
            matches!(
                charset
                    .trim()
                    .trim_matches('"')
                    .to_ascii_lowercase()
                    .as_str(),
                "utf-8" | "utf8" | "us-ascii"
            )
        })
}

fn decode_text(bytes: Vec<u8>, truncated: bool) -> Result<String, ErrorCode> {
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(error) => {
            let valid_up_to = error.utf8_error().valid_up_to();
            let bytes = error.into_bytes();
            let suffix = &bytes[valid_up_to..];
            if truncated && suffix.len() <= 3 && incomplete_utf8_prefix(suffix) {
                String::from_utf8(bytes[..valid_up_to].to_vec())
                    .map_err(|_| ErrorCode::UnsupportedResponse)
            } else {
                Err(ErrorCode::UnsupportedResponse)
            }
        }
    }
}

fn incomplete_utf8_prefix(bytes: &[u8]) -> bool {
    let Some((&first, rest)) = bytes.split_first() else {
        return false;
    };
    let (needed, second_min, second_max) = match first {
        0xc2..=0xdf => (2, 0x80, 0xbf),
        0xe0 => (3, 0xa0, 0xbf),
        0xe1..=0xec => (3, 0x80, 0xbf),
        0xed => (3, 0x80, 0x9f),
        0xee..=0xef => (3, 0x80, 0xbf),
        0xf0 => (4, 0x90, 0xbf),
        0xf1..=0xf3 => (4, 0x80, 0xbf),
        0xf4 => (4, 0x80, 0x8f),
        _ => return false,
    };
    if bytes.len() >= needed {
        return false;
    }
    if let Some(&second) = rest.first() {
        if !(second_min..=second_max).contains(&second) {
            return false;
        }
    }
    rest.iter().skip(1).all(|byte| (0x80..=0xbf).contains(byte))
}

fn encode_headers(source: &HeaderMap, redactor: &Redactor) -> (Map<String, Value>, bool) {
    let mut names: Vec<&str> = source.keys().map(|name| name.as_str()).collect();
    names.sort_unstable();
    let mut headers = Map::new();
    let mut omitted = false;
    for name in names {
        if redactor.matches_header_name(name) {
            omitted = true;
            continue;
        }
        let values: Vec<String> = source.get_all(name).iter().map(header_value_text).collect();
        let joined = values.join(", ");
        let value = if sensitive_header(name) {
            REDACTED.to_string()
        } else {
            redactor.redact(&joined)
        };
        headers.insert(name.to_string(), Value::String(value));
        if encoded_len(&headers) > MAX_RESPONSE_HEADER_BYTES {
            headers.remove(name);
            omitted = true;
        }
    }
    (headers, omitted)
}

fn header_value_text(value: &HeaderValue) -> String {
    match value.to_str() {
        Ok(value) => value.to_string(),
        Err(_) => String::from_utf8_lossy(value.as_bytes()).into_owned(),
    }
}

pub(crate) fn enforce_output_limit(
    result: &mut Map<String, Value>,
    field: &str,
    max_output_bytes: usize,
) -> Result<(), ErrorCode> {
    if encoded_len(result) <= max_output_bytes {
        return Ok(());
    }
    result.insert("truncated".to_string(), Value::Bool(true));
    let body = result
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    result.insert(field.to_string(), Value::String(String::new()));
    if encoded_len(result) > max_output_bytes {
        return Err(ErrorCode::OutputLimit);
    }
    let mut low = 0usize;
    let mut high = body.len();
    let mut best = 0usize;
    while low <= high {
        let mid = low + (high - low) / 2;
        let end = floor_char_boundary(&body, mid);
        result.insert(field.to_string(), Value::String(body[..end].to_string()));
        if encoded_len(result) <= max_output_bytes {
            best = best.max(end);
            low = mid.saturating_add(1);
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }
    loop {
        let next = next_char_boundary(&body, best);
        if next == best {
            break;
        }
        result.insert(field.to_string(), Value::String(body[..next].to_string()));
        if encoded_len(result) <= max_output_bytes {
            best = next;
        } else {
            break;
        }
    }
    result.insert(field.to_string(), Value::String(body[..best].to_string()));
    if encoded_len(result) > max_output_bytes {
        return Err(ErrorCode::OutputLimit);
    }
    Ok(())
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn next_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut next = index + 1;
    while next < text.len() && !text.is_char_boundary(next) {
        next += 1;
    }
    next
}

fn encoded_len<T: serde::Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_text_content_types() {
        for value in [
            "text/plain",
            "text/html; charset=utf-8",
            "application/json",
            "application/json; charset=utf-8",
            "application/vnd.github+json",
            "application/xml",
        ] {
            assert!(is_text_content_type(value), "content type {value}");
        }
        for value in [
            "application/octet-stream",
            "image/png",
            "application/pdf",
            "application/zip",
            "text/plain; charset=utf-16",
            "application/json; charset=iso-8859-1",
        ] {
            assert!(!is_text_content_type(value), "content type {value}");
        }
    }

    #[test]
    fn bounds_serialization_of_overlapping_selected_subtrees() {
        let document = serde_json::json!({"nested": {"data": "x".repeat(1_000_000)}});
        let redactor = Redactor::new(Vec::new()).unwrap();
        let pointers = vec![
            Pointer::parse("").unwrap(),
            Pointer::parse("/nested").unwrap(),
        ];
        let options = ResponseOptions {
            head: false,
            select: &pointers,
            max_response_bytes: 2_000_000,
            max_output_bytes: 1_024,
            redactor: &redactor,
        };
        let (body, missing, truncated) =
            response_body(&document.to_string(), false, &options).unwrap();
        assert!(body.len() <= 1_024);
        assert!(missing.is_empty());
        assert!(truncated);
    }

    #[test]
    fn decodes_complete_utf8() {
        assert_eq!(
            decode_text("hello".as_bytes().to_vec(), false).unwrap(),
            "hello"
        );
        assert_eq!(
            decode_text("héllo".as_bytes().to_vec(), false).unwrap(),
            "héllo"
        );
    }

    #[test]
    fn drops_only_an_incomplete_utf8_suffix_at_the_download_limit() {
        let bytes = "aé".as_bytes().to_vec();
        let truncated = bytes[..bytes.len() - 1].to_vec();
        assert_eq!(decode_text(truncated, true).unwrap(), "a");
        let complete_truncated = "aé".as_bytes().to_vec();
        assert_eq!(decode_text(complete_truncated.clone(), true).unwrap(), "aé");
        assert_eq!(decode_text(complete_truncated, false).unwrap(), "aé");
        assert_eq!(
            decode_text(vec![0xff], true),
            Err(ErrorCode::UnsupportedResponse)
        );
        assert_eq!(
            decode_text(vec![0xff], false),
            Err(ErrorCode::UnsupportedResponse)
        );
    }

    #[test]
    fn keeps_output_within_the_byte_limit_on_character_boundaries() {
        let mut result = Map::new();
        result.insert("body".to_string(), Value::String("é".repeat(10)));
        result.insert("truncated".to_string(), Value::Bool(false));
        enforce_output_limit(&mut result, "body", 40).unwrap();
        let body = result["body"].as_str().unwrap();
        assert!(encoded_len(&result) <= 40);
        assert!(body.is_char_boundary(body.len()));
        assert_eq!(result["truncated"], Value::Bool(true));
    }

    #[test]
    fn fails_when_metadata_alone_exceeds_the_output_limit() {
        let mut result = Map::new();
        result.insert("url".to_string(), Value::String("x".repeat(100)));
        result.insert("body".to_string(), Value::String(String::new()));
        assert_eq!(
            enforce_output_limit(&mut result, "body", 10),
            Err(ErrorCode::OutputLimit)
        );
    }
}
