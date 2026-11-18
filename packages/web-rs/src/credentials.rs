use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;

use reqwest::header::HeaderMap;
use reqwest::Url;
use serde_json::Value;

use crate::http_params::{
    restricted_header, valid_header_name, valid_header_value, MAX_REQUEST_HEADERS,
    MAX_REQUEST_HEADER_BYTES,
};
use crate::http_target::{parse_credential_origin, same_origin};
use crate::protocol::ErrorCode;

const MAX_CREDENTIALS_FILE_BYTES: u64 = 65_536;

pub(crate) struct ResolvedCredential {
    pub(crate) headers: HeaderMap,
    pub(crate) secrets: Vec<String>,
}

pub(crate) fn resolve(name: &str, request_url: &Url) -> Result<ResolvedCredential, ErrorCode> {
    let path = std::env::var_os("PI_WEB_CREDENTIALS_FILE")
        .filter(|path| !path.is_empty())
        .ok_or(ErrorCode::CredentialError)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| ErrorCode::CredentialError)?;
    let metadata = file.metadata().map_err(|_| ErrorCode::CredentialError)?;
    if !metadata.is_file() || metadata.len() > MAX_CREDENTIALS_FILE_BYTES {
        return Err(ErrorCode::CredentialError);
    }
    let mut bytes = Vec::new();
    file.take(MAX_CREDENTIALS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ErrorCode::CredentialError)?;
    if bytes.len() as u64 > MAX_CREDENTIALS_FILE_BYTES {
        return Err(ErrorCode::CredentialError);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| ErrorCode::CredentialError)?;
    let document: Value = serde_json::from_str(text).map_err(|_| ErrorCode::CredentialError)?;
    let entries = document.as_object().ok_or(ErrorCode::CredentialError)?;
    let entry = entries
        .get(name)
        .and_then(Value::as_object)
        .ok_or(ErrorCode::CredentialError)?;
    let origin = entry
        .get("origin")
        .and_then(Value::as_str)
        .and_then(parse_credential_origin)
        .ok_or(ErrorCode::CredentialError)?;
    if !same_origin(&origin, request_url) {
        return Err(ErrorCode::CredentialError);
    }
    let configured = entry
        .get("headers")
        .and_then(Value::as_object)
        .ok_or(ErrorCode::CredentialError)?;
    if configured.is_empty() || configured.len() > MAX_REQUEST_HEADERS {
        return Err(ErrorCode::CredentialError);
    }
    let mut headers = HeaderMap::new();
    let mut secrets = Vec::new();
    let mut total_bytes = 0usize;
    for (name, value) in configured {
        if restricted_header(name) {
            return Err(ErrorCode::CredentialError);
        }
        let name = valid_header_name(name).ok_or(ErrorCode::CredentialError)?;
        let config = value.as_object().ok_or(ErrorCode::CredentialError)?;
        let env_name = config
            .get("env")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or(ErrorCode::CredentialError)?;
        let prefix = match config.get("prefix") {
            None => "",
            Some(Value::String(prefix)) => prefix,
            Some(_) => return Err(ErrorCode::CredentialError),
        };
        let secret = std::env::var(env_name).map_err(|_| ErrorCode::CredentialError)?;
        if secret.is_empty() {
            return Err(ErrorCode::CredentialError);
        }
        let completed = format!("{prefix}{secret}");
        let value = valid_header_value(&completed).ok_or(ErrorCode::CredentialError)?;
        total_bytes = total_bytes
            .checked_add(name.as_str().len() + completed.len())
            .ok_or(ErrorCode::CredentialError)?;
        if total_bytes > MAX_REQUEST_HEADER_BYTES {
            return Err(ErrorCode::CredentialError);
        }
        secrets.push(secret);
        secrets.push(completed);
        headers.insert(name, value);
    }
    Ok(ResolvedCredential { headers, secrets })
}
