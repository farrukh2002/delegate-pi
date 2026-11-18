use dom_query::Document;
use dom_smoothie::{Config, ParsePolicy, Readability, TextMode};
use reqwest::Url;

use crate::http_target::{parse_request_url, raw_has_userinfo};
use crate::protocol::ErrorCode;
use crate::redaction::Redactor;

const MAX_ELEMENTS: usize = 50_000;
const MAX_DEPTH: usize = 64;
const MAX_TEXT_BYTES: usize = 131_072;
const MAX_LINKS: usize = 100;
const MAX_LINK_BYTES: usize = 32_768;

pub(super) struct Page {
    pub(super) title: String,
    pub(super) content: String,
    pub(super) format: &'static str,
    pub(super) access: &'static str,
    pub(super) extraction: &'static str,
    pub(super) truncated: bool,
}

impl Page {
    pub(super) fn empty(access: &'static str, format: &'static str) -> Self {
        Self {
            title: String::new(),
            content: String::new(),
            format,
            access,
            extraction: "none",
            truncated: false,
        }
    }
}

pub(super) fn extract(html: &str, url: &Url, redactor: &Redactor) -> Result<Page, ErrorCode> {
    if html.trim().is_empty() {
        return Ok(Page::empty("empty", "markdown"));
    }
    let document = Document::from(html);
    let mut elements = 0;
    for node in document.root().descendants_it() {
        if node.is_element() {
            elements += 1;
            if elements > MAX_ELEMENTS || node.ancestors_it(Some(MAX_DEPTH + 1)).count() > MAX_DEPTH
            {
                return Err(ErrorCode::ResponseLimit);
            }
        }
    }
    let raw_title = ["head > title", "h1"]
        .iter()
        .find_map(|selector| {
            let text = document.select_single(selector).text();
            (!text.trim().is_empty()).then_some(text)
        })
        .unwrap_or_default();
    let (title, title_cut) = redactor.redact_limited(&raw_title, 256);
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower_title = raw_title.trim().to_ascii_lowercase();
    let challenge = document.select_single("#challenge-form, #cf-challenge-running, script[src*='challenge-platform'], iframe[src*='captcha']").exists();
    let password = document
        .select_single("form input[type='password']")
        .exists();
    let noscript = document.select("noscript").text().to_ascii_lowercase();
    document.select("script, style, noscript, template, svg, canvas, iframe, frame, object, embed, img, video, audio, form, nav, header, footer, aside, base, meta, link, [hidden]").remove();
    for node in document.select("[style], [aria-hidden]").nodes() {
        let style: String = node
            .attr_or("style", "")
            .chars()
            .filter(|ch| !ch.is_ascii_whitespace())
            .collect::<String>()
            .to_ascii_lowercase();
        if node.attr_or("aria-hidden", "").eq_ignore_ascii_case("true")
            || style.contains("display:none")
            || style.contains("visibility:hidden")
        {
            node.remove_from_parent();
        }
    }
    let visible = document.select_single("body").formatted_text();
    let visible_lower = visible.to_ascii_lowercase();
    let access = if visible.len() < 1_000
        && (challenge
            || matches!(
                lower_title.as_str(),
                "just a moment..." | "just a moment…" | "verify you are human" | "captcha"
            )) {
        "blocked"
    } else if password
        && visible.len() < 1_000
        && ["log in", "login", "sign in", "signin"]
            .iter()
            .any(|hint| lower_title.contains(hint))
    {
        "auth_required"
    } else if visible.trim().len() < 200
        && ((visible.trim().len() < 40 && noscript.contains("enable javascript"))
            || [
                "javascript is required",
                "javascript must be enabled",
                "please enable javascript",
                "need to enable javascript",
            ]
            .iter()
            .any(|hint| visible_lower.contains(hint)))
    {
        "requires_javascript"
    } else {
        "ok"
    };
    if access != "ok" {
        return Ok(Page {
            title,
            truncated: title_cut,
            ..Page::empty(access, "markdown")
        });
    }
    let mut truncated = title_cut;
    let mut remaining_text = MAX_TEXT_BYTES;
    let text_nodes: Vec<_> = document
        .root()
        .descendants_it()
        .filter(|node| node.is_text())
        .collect();
    for node in text_nodes {
        let text = node.text();
        let (text, cut) = redactor.strip_limited(&text, remaining_text);
        remaining_text -= text.len();
        truncated |= cut;
        node.set_text(text);
    }
    let mut links = 0;
    let mut link_bytes = 0;
    for node in document.select("a[href]").nodes() {
        let raw = node.attr_or("href", "");
        node.remove_attr("href");
        if raw.len() > 4_096 || links >= MAX_LINKS || link_bytes >= MAX_LINK_BYTES {
            truncated = true;
            continue;
        }
        let (checked, cut) = redactor.redact_limited(&raw, 4_096);
        if cut || checked != raw.as_ref() || raw_has_userinfo(&raw) {
            continue;
        }
        let Ok(target) = url.join(&raw) else {
            continue;
        };
        if target.as_str().len() > 4_096 {
            truncated = true;
            continue;
        }
        if parse_request_url(target.as_str()).is_none() {
            continue;
        }
        let (checked, cut) = redactor.redact_limited(target.as_str(), 4_096);
        if cut || checked != target.as_str() {
            continue;
        }
        if links >= MAX_LINKS || link_bytes + checked.len() > MAX_LINK_BYTES {
            truncated = true;
            continue;
        }
        links += 1;
        link_bytes += checked.len();
        node.set_attr("href", &checked);
    }
    let fallback = ["main", "article", "[role='main']", "body"]
        .iter()
        .find_map(|selector| {
            let selection = document.select_single(selector);
            (!selection.text().trim().is_empty()).then(|| selection.html())
        })
        .unwrap_or_default();
    let config = Config {
        max_elements_to_parse: MAX_ELEMENTS,
        char_threshold: 100,
        disable_json_ld: true,
        text_mode: TextMode::Raw,
        ..Config::default()
    };
    let mut reader = Readability::with_document(document, None, Some(config))
        .map_err(|_| ErrorCode::Internal)?;
    let (content, extraction) = match reader.parse_with_policy(ParsePolicy::Strict) {
        Ok(article) if article.text_content.trim().chars().take(100).count() == 100 => {
            (article.content, "readability")
        }
        _ => (fallback, "fallback"),
    };
    let content = Document::fragment(content.as_ref());
    let nodes: Vec<_> = content
        .root()
        .descendants_it()
        .filter(|node| node.is_element())
        .collect();
    for node in nodes {
        if node.has_name("a") {
            node.retain_attrs(&["href"]);
        } else {
            node.remove_all_attrs();
        }
    }
    for table in content.select("table").nodes() {
        let text = table.formatted_text();
        table.rename("pre");
        table.set_text(text);
    }
    let content = content.md(None);
    let (content, cut) = redactor.redact_limited(content.trim(), MAX_TEXT_BYTES);
    truncated |= cut;
    if content.trim().is_empty() {
        return Ok(Page {
            title,
            truncated,
            ..Page::empty("empty", "markdown")
        });
    }
    Ok(Page {
        title,
        content,
        format: "markdown",
        access: "ok",
        extraction,
        truncated,
    })
}
