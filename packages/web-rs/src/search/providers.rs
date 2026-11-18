use std::collections::HashSet;

use dom_query::Document;

use super::{plain_text, result_url, AttemptStatus, Provider, SearchItem};

pub(super) fn parse(
    provider: Provider,
    html: &str,
    site: Option<&str>,
    max_results: usize,
) -> (AttemptStatus, Vec<SearchItem>, bool) {
    let document = Document::from(html);
    document.select("script,style,noscript,template").remove();
    let (container, anchor, title, snippet) = match provider {
        Provider::Yahoo => ("div.algo.relsrch", ".compTitle a", "h3", ".compText"),
        Provider::Brave => (
            "div[data-type='web']",
            "a:has(.title)",
            ".title",
            ".snippet .content",
        ),
    };
    let candidates = document.select(container);
    let candidate_limit_reached = candidates.length() > 100;
    let mut truncated = candidate_limit_reached;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let mut filtered = false;
    for candidate in candidates.iter().take(100) {
        if candidate.is(".ad, .sponsored, [data-ad]") {
            continue;
        }
        let link = candidate.select_single(anchor);
        let Some(raw) = link.attr("href") else {
            continue;
        };
        let Some(url) = result_url(provider, &raw) else {
            continue;
        };
        let (title, title_cut) = plain_text(&link.select_single(title).text(), 256);
        if title.is_empty() {
            continue;
        }
        if site.is_some_and(|site| {
            !url.host_str()
                .is_some_and(|host| host == site || host.ends_with(&format!(".{site}")))
        }) {
            filtered = true;
            continue;
        }
        if !seen.insert(url.as_str().to_string()) {
            continue;
        }
        if items.len() == max_results {
            truncated = true;
            break;
        }
        let (snippet, snippet_cut) = plain_text(&candidate.select_single(snippet).text(), 512);
        truncated |= title_cut || snippet_cut;
        items.push(SearchItem {
            title,
            url: url.into(),
            snippet,
            source: provider,
        });
    }
    if !items.is_empty() {
        return (AttemptStatus::Ok, items, truncated);
    }
    let title = document.select_single("title").text().to_ascii_lowercase();
    if document.select("form[action*='captcha'], #captcha, .g-recaptcha, #challenge-form, input[name='captcha']").exists() || title.contains("captcha") || title.contains("verify you are human") || title.contains("access denied") {
        return (AttemptStatus::Blocked, items, truncated);
    }
    if candidate_limit_reached {
        return (AttemptStatus::ResponseLimit, items, true);
    }
    let page = document.select("body").text().to_ascii_lowercase();
    let empty = match provider {
        Provider::Yahoo => {
            page.contains("we did not find results for") || page.contains("no results found for")
        }
        Provider::Brave => {
            page.contains("no results found") || page.contains("no results for your query")
        }
    };
    (
        if empty || filtered {
            AttemptStatus::Empty
        } else {
            AttemptStatus::UnsupportedResponse
        },
        items,
        truncated,
    )
}
