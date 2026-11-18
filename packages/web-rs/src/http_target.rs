use reqwest::Url;

use crate::http_params::MAX_URL_BYTES;
use crate::protocol::ErrorCode;

pub(crate) fn parse_request_url(raw: &str) -> Option<Url> {
    if raw.len() > MAX_URL_BYTES || raw_has_userinfo(raw) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !valid_absolute_url(&url) {
        return None;
    }
    Some(url)
}

pub(crate) fn validate_redirect(current: &Url, next: &Url) -> Result<(), ErrorCode> {
    if next.as_str().len() > MAX_URL_BYTES || !valid_absolute_url(next) {
        return Err(ErrorCode::NetworkError);
    }
    if current.scheme() == "https" && next.scheme() == "http" {
        return Err(ErrorCode::NetworkError);
    }
    Ok(())
}

pub(crate) fn raw_has_userinfo(raw: &str) -> bool {
    let authority = raw
        .split_once("://")
        .map(|(_, rest)| rest)
        .or_else(|| raw.strip_prefix("//"))
        .unwrap_or("");
    authority
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .contains('@')
}

pub(crate) fn same_origin(left: &Url, right: &Url) -> bool {
    left.origin() == right.origin()
}

pub(crate) fn parse_credential_origin(raw: &str) -> Option<Url> {
    let url = parse_request_url(raw)?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    Some(url)
}

fn valid_absolute_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty())
        && !url_has_userinfo(url)
}

fn url_has_userinfo(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn accepts_absolute_http_urls() {
        for raw in [
            "http://localhost:3000/path?q=1",
            "https://example.com/",
            "http://127.0.0.1",
        ] {
            assert!(parse_request_url(raw).is_some(), "url {raw}");
        }
    }

    #[test]
    fn rejects_unsafe_request_urls() {
        for raw in [
            "",
            "example.com",
            "file:///tmp/x",
            "ftp://example.com/",
            "http://user:pass@example.com/",
            "http://user@example.com/",
            "http://@example.com/",
            "http://",
            "http://example.com:99999/",
        ] {
            assert_eq!(parse_request_url(raw), None, "url {raw}");
        }
        assert_eq!(
            parse_request_url(&format!("http://example.com/{}", "a".repeat(MAX_URL_BYTES))),
            None
        );
    }

    #[test]
    fn rejects_https_to_http_downgrade() {
        let https = url("https://example.com/a");
        let http = url("http://example.com/b");
        assert_eq!(
            validate_redirect(&https, &http),
            Err(ErrorCode::NetworkError)
        );
        assert_eq!(
            validate_redirect(&http, &url("https://example.com/b")),
            Ok(())
        );
        assert_eq!(
            validate_redirect(&http, &url("http://example.com:80/b")),
            Ok(())
        );
    }

    #[test]
    fn rejects_unsafe_redirect_targets() {
        let current = url("https://example.com/");
        for raw in [
            "ftp://example.com/",
            "https://user@example.com/",
            "file:///x",
        ] {
            assert_eq!(
                validate_redirect(&current, &url(raw)),
                Err(ErrorCode::NetworkError),
                "url {raw}"
            );
        }
    }

    #[test]
    fn compares_effective_origins() {
        assert!(same_origin(
            &url("http://localhost:80/a"),
            &url("http://localhost/b")
        ));
        assert!(same_origin(
            &url("https://example.com:443/a"),
            &url("https://example.com/b")
        ));
        assert!(!same_origin(
            &url("http://localhost:3000/a"),
            &url("http://localhost:3001/a")
        ));
        assert!(!same_origin(
            &url("http://localhost/a"),
            &url("https://localhost/a")
        ));
    }

    #[test]
    fn accepts_only_origin_credential_configuration() {
        assert_eq!(
            parse_credential_origin("https://api.github.com").map(|url| url.to_string()),
            Some("https://api.github.com/".to_string())
        );
        assert!(parse_credential_origin("https://api.github.com/").is_some());
        for raw in [
            "https://api.github.com/path",
            "https://api.github.com/?q=1",
            "https://api.github.com/#fragment",
            "https://user@api.github.com/",
            "ftp://api.github.com/",
        ] {
            assert_eq!(parse_credential_origin(raw), None, "origin {raw}");
        }
    }
}
