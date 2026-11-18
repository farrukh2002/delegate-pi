use std::collections::BTreeMap;

use serde_json::Value;

use crate::http_params::MAX_SELECT_POINTER_BYTES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pointer {
    raw: String,
    tokens: Vec<String>,
}

impl Pointer {
    pub(crate) fn parse(raw: &str) -> Option<Self> {
        if raw.len() > MAX_SELECT_POINTER_BYTES {
            return None;
        }
        if raw.is_empty() {
            return Some(Pointer {
                raw: String::new(),
                tokens: Vec::new(),
            });
        }
        let rest = raw.strip_prefix('/')?;
        let mut tokens = Vec::new();
        for token in rest.split('/') {
            tokens.push(decode_token(token)?);
        }
        Some(Pointer {
            raw: raw.to_string(),
            tokens,
        })
    }
}

pub(crate) fn select<'a>(
    document: &'a Value,
    pointers: &[Pointer],
) -> (BTreeMap<String, &'a Value>, Vec<String>) {
    let mut found = BTreeMap::new();
    let mut missing = Vec::new();
    for pointer in pointers {
        match resolve(document, &pointer.tokens) {
            Some(value) => {
                found.insert(pointer.raw.clone(), value);
            }
            None => missing.push(pointer.raw.clone()),
        }
    }
    (found, missing)
}

fn decode_token(token: &str) -> Option<String> {
    let mut decoded = String::with_capacity(token.len());
    let mut chars = token.chars();
    while let Some(character) = chars.next() {
        if character != '~' {
            decoded.push(character);
            continue;
        }
        match chars.next()? {
            '0' => decoded.push('~'),
            '1' => decoded.push('/'),
            _ => return None,
        }
    }
    Some(decoded)
}

fn resolve<'a>(document: &'a Value, tokens: &[String]) -> Option<&'a Value> {
    let mut current = document;
    for token in tokens {
        current = match current {
            Value::Object(object) => object.get(token)?,
            Value::Array(array) => array.get(array_index(token)?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn array_index(token: &str) -> Option<usize> {
    if token == "0" {
        return Some(0);
    }
    if token.starts_with('0') || token.is_empty() {
        return None;
    }
    if !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    token.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(raw: &str) -> Pointer {
        Pointer::parse(raw).unwrap()
    }

    #[test]
    fn parses_root_and_tokens() {
        assert_eq!(parse("").tokens, Vec::<String>::new());
        assert_eq!(parse("/").tokens, vec![String::new()]);
        assert_eq!(parse("/a/b").tokens, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn decodes_escapes() {
        assert_eq!(parse("/a~1b").tokens, vec!["a/b".to_string()]);
        assert_eq!(parse("/a~0b").tokens, vec!["a~b".to_string()]);
        assert_eq!(
            parse("/~0~1").tokens,
            vec!["~/".to_string()],
            "escapes decode left to right"
        );
    }

    #[test]
    fn rejects_invalid_pointers() {
        for raw in ["a", "/a~", "/a~2", "/a~x"] {
            assert_eq!(Pointer::parse(raw), None, "pointer {raw}");
        }
        assert_eq!(
            Pointer::parse(&"a".repeat(MAX_SELECT_POINTER_BYTES + 1)),
            None
        );
    }

    #[test]
    fn selects_found_and_missing_pointers() {
        let document = json!({
            "items": [{"name": "first"}, {"name": "second"}],
            "a/b": 1,
            "": 2
        });
        let pointers = vec![
            parse("/items/0/name"),
            parse("/items/1"),
            parse("/a~1b"),
            parse("/"),
            parse(""),
            parse("/missing"),
            parse("/items/01"),
        ];
        let (found, missing) = select(&document, &pointers);
        assert_eq!(found.get("/items/0/name").copied(), Some(&json!("first")));
        assert_eq!(
            found.get("/items/1").copied(),
            Some(&json!({"name": "second"}))
        );
        assert_eq!(found.get("/a~1b").copied(), Some(&json!(1)));
        assert_eq!(found.get("/").copied(), Some(&json!(2)));
        assert_eq!(found.get("").copied(), Some(&document));
        assert_eq!(
            missing,
            vec!["/missing".to_string(), "/items/01".to_string()],
            "missing pointers are listed, not returned as null"
        );
    }
}
