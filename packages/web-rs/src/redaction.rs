use std::cell::Cell;

use aho_corasick::{AhoCorasick, MatchKind};
use base64::{engine::general_purpose, Engine as _};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::protocol::ErrorCode;

pub(crate) const REDACTED: &str = "[REDACTED]";

const URL_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');
const FORM_COMPONENT: &AsciiSet = &URL_COMPONENT.add(b'~').remove(b'*');

const SENSITIVE_HEADERS: [&str; 12] = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "api-key",
    "apikey",
    "x-api-key",
    "x-api-token",
    "x-auth-token",
    "x-access-token",
    "x-goog-api-key",
    "x-amz-security-token",
];

pub(crate) struct Redactor {
    matcher: AhoCorasick,
    header_name_matcher: AhoCorasick,
}

impl Redactor {
    pub(crate) fn new(values: Vec<String>) -> Result<Self, ErrorCode> {
        let mut patterns = Vec::new();
        for value in values.into_iter().filter(|value| !value.is_empty()) {
            let encoded = serde_json::to_string(&value).map_err(|_| ErrorCode::Internal)?;
            patterns.push(encoded[1..encoded.len() - 1].to_string());
            let url = utf8_percent_encode(&value, URL_COMPONENT).to_string();
            if url != value {
                push_url_patterns(&mut patterns, url);
            }
            let form = utf8_percent_encode(&value, FORM_COMPONENT)
                .to_string()
                .replace("%20", "+");
            if form != value {
                push_url_patterns(&mut patterns, form);
            }
            for engine in [general_purpose::STANDARD, general_purpose::URL_SAFE] {
                let encoded = engine.encode(&value);
                patterns.push(encoded.trim_end_matches('=').to_owned());
                patterns.push(encoded);
            }
            patterns.push(value);
        }
        patterns.sort_unstable();
        patterns.dedup();
        let matcher = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(&patterns)
            .map_err(|_| ErrorCode::Internal)?;
        let header_name_matcher = AhoCorasick::builder()
            .ascii_case_insensitive(true)
            .build(&patterns)
            .map_err(|_| ErrorCode::Internal)?;
        Ok(Redactor {
            matcher,
            header_name_matcher,
        })
    }

    pub(crate) fn has_values(&self) -> bool {
        self.matcher.patterns_len() > 0
    }

    pub(crate) fn matches_header_name(&self, name: &str) -> bool {
        self.header_name_matcher.is_match(name)
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        self.redact_limited(text, usize::MAX).0
    }

    pub(crate) fn redact_limited(&self, text: &str, limit: usize) -> (String, bool) {
        self.replace_limited(text, limit, REDACTED)
    }

    pub(crate) fn strip_limited(&self, text: &str, limit: usize) -> (String, bool) {
        self.replace_limited(text, limit, "")
    }

    fn replace_limited(&self, text: &str, limit: usize, replacement: &str) -> (String, bool) {
        let mut output = String::with_capacity(text.len().min(limit));
        let mut end = 0;
        for found in self.matcher.find_iter(text) {
            if !append_prefix(&mut output, &text[end..found.start()], limit)
                || !append_prefix(&mut output, replacement, limit)
            {
                return (output, true);
            }
            end = found.end();
        }
        let complete = append_prefix(&mut output, &text[end..], limit);
        (output, !complete)
    }
}

fn push_url_patterns(patterns: &mut Vec<String>, encoded: String) {
    let mut lower = encoded.as_bytes().to_vec();
    let mut cursor = 0;
    while cursor < lower.len() {
        if lower[cursor] == b'%' {
            lower[cursor + 1..cursor + 3].make_ascii_lowercase();
            cursor += 3;
        } else {
            cursor += 1;
        }
    }
    patterns.push(encoded);
    patterns.push(String::from_utf8(lower).expect("URL encoding produces UTF-8"));
}

fn append_prefix(output: &mut String, text: &str, limit: usize) -> bool {
    let mut end = text.len().min(limit - output.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    output.push_str(&text[..end]);
    end == text.len()
}

pub(crate) struct RedactedValue<'a> {
    pub(crate) value: &'a Value,
    pub(crate) redactor: &'a Redactor,
    pub(crate) limit: usize,
    pub(crate) truncated: &'a Cell<bool>,
}

impl Serialize for RedactedValue<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let redact = |text: &str| {
            let (text, truncated) = self.redactor.redact_limited(text, self.limit);
            if truncated {
                self.truncated.set(true);
            }
            text
        };
        let wrap = |value| RedactedValue { value, ..*self };
        match self.value {
            Value::String(text) => serializer.serialize_str(&redact(text)),
            Value::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(&wrap(value))?;
                }
                sequence.end()
            }
            Value::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    map.serialize_entry(&redact(key), &wrap(value))?;
                }
                map.end()
            }
            value => {
                let text = value.to_string();
                let redacted = redact(&text);
                if redacted == text {
                    value.serialize(serializer)
                } else {
                    serializer.serialize_str(&redacted)
                }
            }
        }
    }
}

pub(crate) fn sensitive_header(name: &str) -> bool {
    SENSITIVE_HEADERS
        .iter()
        .any(|sensitive| name.eq_ignore_ascii_case(sensitive))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_longest_values_first() {
        let redactor =
            Redactor::new(vec!["secret".to_string(), "Bearer secret".to_string()]).unwrap();
        assert_eq!(redactor.redact("Bearer secret"), REDACTED);
        assert_eq!(redactor.redact("secret"), REDACTED);
        assert_eq!(
            redactor.redact("before Bearer secret after"),
            format!("before {REDACTED} after")
        );
    }

    #[test]
    fn does_not_redact_its_replacement_marker() {
        let redactor = Redactor::new(vec!["a".to_string(), "R".to_string()]).unwrap();
        assert_eq!(redactor.redact("a R"), "[REDACTED] [REDACTED]");
    }

    #[test]
    fn bounds_expanding_redactions_and_preserves_utf8() {
        let redactor = Redactor::new(vec!["a".to_string()]).unwrap();
        let (value, truncated) = redactor.redact_limited(&"a".repeat(1_000), 17);
        assert_eq!(value.len(), 17);
        assert!(truncated);
        let (value, truncated) = redactor.redact_limited("ééé", 3);
        assert_eq!(value, "é");
        assert!(truncated);
    }

    #[test]
    fn ignores_empty_values() {
        let redactor = Redactor::new(vec![String::new(), "secret".to_string()]).unwrap();
        assert_eq!(redactor.redact("plain text"), "plain text");
        assert_eq!(Redactor::new(Vec::new()).unwrap().redact("plain"), "plain");
    }

    #[test]
    fn redacts_json_scalar_secrets_without_changing_other_scalar_types() {
        let redactor = Redactor::new(vec!["123456".into(), "true".into(), "null".into()]).unwrap();
        for (value, expected) in [
            (serde_json::json!(123456), serde_json::json!(REDACTED)),
            (serde_json::json!(true), serde_json::json!(REDACTED)),
            (Value::Null, serde_json::json!(REDACTED)),
            (serde_json::json!(42), serde_json::json!(42)),
            (serde_json::json!(false), serde_json::json!(false)),
        ] {
            let truncated = Cell::new(false);
            let wrapped = RedactedValue {
                value: &value,
                redactor: &redactor,
                limit: 1024,
                truncated: &truncated,
            };
            assert_eq!(serde_json::to_value(wrapped).unwrap(), expected);
            assert!(!truncated.get());
        }
    }

    #[test]
    fn recognizes_sensitive_headers_case_insensitively() {
        for name in ["Authorization", "SET-COOKIE", "X-Api-Key", "x-goog-api-key"] {
            assert!(sensitive_header(name), "header {name}");
        }
        assert!(!sensitive_header("content-type"));
    }
}
