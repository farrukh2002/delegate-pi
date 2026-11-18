use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::ErrorCode;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Scope {
    Worktree,
    Head,
    History,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    source: String,
    scope: Option<Scope>,
    revision: Option<String>,
    max_commits: Option<u64>,
    max_files: Option<u64>,
    max_file_bytes: Option<u64>,
    max_total_bytes: Option<u64>,
    max_download_bytes: Option<u64>,
    max_output_bytes: Option<u64>,
}

pub(super) const MAX_FILE_BYTES: u64 = 4_194_304;

pub(super) struct IndexParams {
    pub source: String,
    pub scope: Option<Scope>,
    pub revision: Option<String>,
    pub max_commits: u64,
    pub max_files: u64,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_download_bytes: u64,
    pub max_output_bytes: usize,
}

impl IndexParams {
    pub fn parse(value: Value) -> Result<Self, ErrorCode> {
        let input: Input = serde_json::from_value(value).map_err(|_| ErrorCode::InvalidParams)?;
        if !valid_text(&input.source, 4096)
            || input.revision.as_ref().is_some_and(|s| !valid_text(s, 256))
            || input.scope == Some(Scope::Worktree) && input.revision.is_some()
        {
            return Err(ErrorCode::InvalidParams);
        }
        Ok(Self {
            source: input.source,
            scope: input.scope,
            revision: input.revision,
            max_commits: limit(input.max_commits, 1000, 1, 10000)?,
            max_files: limit(input.max_files, 10000, 1, 20000)?,
            max_file_bytes: limit(input.max_file_bytes, 1_048_576, 1024, MAX_FILE_BYTES)?,
            max_total_bytes: limit(input.max_total_bytes, 33_554_432, 1_048_576, 134_217_728)?,
            max_download_bytes: limit(input.max_download_bytes, 67_108_864, 1_048_576, 268_435_456)?,
            max_output_bytes: limit(input.max_output_bytes, 8192, 1024, 49152)? as usize,
        })
    }
}

pub(super) fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

pub(super) fn valid_index_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(super) fn limit(value: Option<u64>, default: u64, min: u64, max: u64) -> Result<u64, ErrorCode> {
    let value = value.unwrap_or(default);
    if !(min..=max).contains(&value) {
        return Err(ErrorCode::InvalidParams);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_and_out_of_range_parameters() {
        for value in [
            json!({}),
            json!({"source":"." , "headers":{}}),
            json!({"source":".","maxFiles":0}),
            json!({"source":".","maxFileBytes":4_194_305}),
            json!({"source":".","maxTotalBytes":134_217_729}),
            json!({"source":".","maxDownloadBytes":268_435_457}),
            json!({"source":".","scope":"worktree","revision":"HEAD"}),
            json!({"source":"a\nb"}),
        ] {
            assert!(matches!(IndexParams::parse(value), Err(ErrorCode::InvalidParams)));
        }
        assert!(IndexParams::parse(json!({"source":"."})).is_ok());
    }

    #[test]
    fn accepts_only_opaque_index_ids() {
        assert!(valid_index_id(&"a0".repeat(32)));
        for value in ["../index", "", &"F".repeat(64), &"0".repeat(63)] {
            assert!(!valid_index_id(value));
        }
    }
}
