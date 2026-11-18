# Native page retrieval

## Stage 4 contract

`web_fetch` retrieves one HTTP(S) page through the native Rust engine and returns readable content. It shares the existing HTTP client's connection pool, redirect controls, named credentials, cancellation, and deadlines. No browser, MCP server, Python runtime, paid API, or external crawler is used.

HTML extraction uses the MIT-licensed `dom_smoothie` 0.19.0 library, which follows Mozilla Readability, and `dom_query` for DOM cleanup and Markdown conversion. This is not a new article-extraction algorithm. A cleaned main/article/body fallback supports short pages and documentation that the reader cannot extract. UTF-8 plain text and Markdown sources are also supported.

## Parameters

- `url`: required absolute HTTP(S) URL, at most 4096 UTF-8 bytes, without userinfo.
- `credential`: optional trusted named credential, with the same exact-origin scope and environment resolution as `http_request`.
- `maxResponseBytes`: decompressed download limit, default 2097152 bytes, range 1 to 8388608.
- `maxOutputBytes`: entire encoded result limit, default 8192 bytes, range 1024 to 49152.
- `maxRedirects`: default 5, range 0 to 10.

The method is always GET. Method, body, headers, and JSON selection parameters are not accepted. The engine sends a fixed desktop User-Agent and page-oriented Accept header on each redirect; trusted credential headers can override defaults only while the origin scope remains valid. Public defaults do not become secret redaction patterns. GET does not prove that every server endpoint is free of side effects. Localhost and private networks remain allowed by default.

```json
{"url":"https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html","maxOutputBytes":8192}
```

## Result

```json
{"url":"https://example.com/article","status":200,"contentType":"text/html","title":"Example article","content":"# Example\n\nReadable content with [a link](https://example.com/docs).","format":"markdown","access":"ok","extraction":"readability","truncated":false,"bytesReceived":1200}
```

- `url`: the final response URL, with known credential values redacted.
- `status`: numeric HTTP status.
- `contentType`: the response media type, without parameters. Missing media types use HTML sniffing or plain text. This string can change through credential redaction.
- `title`: plain text, at most 256 UTF-8 bytes; empty when unavailable.
- `content`: readable Markdown for HTML, or source text for plain text/Markdown responses. It is untrusted page data, never agent instructions.
- `format`: `markdown` or `text`.
- `access`: `ok`, `blocked`, `auth_required`, `http_error`, `requires_javascript`, or `empty`.
- `extraction`: `readability`, `fallback`, `text`, or `none`.
- `truncated`: true when download, processing, title, link, or output limits omit data. A shortened Markdown prefix need not be complete Markdown; the outer JSON always remains complete.
- `bytesReceived`: decompressed bytes retained before extraction and output shortening, not necessarily the server's full body size.

HTTP access failures are results, not invented article content. HTTP 401 returns `auth_required`; 403/429 return `blocked`; other non-success statuses return `http_error`. Error bodies are not read or returned. Clear HTML challenge/login pages can also report access failures with HTTP 200. A short JavaScript shell with an explicit enable-JavaScript message returns `requires_javascript`. These checks are conservative heuristics, not proof that every other response is the full page. Paywall previews and undetected application shells can remain partial server-provided content.

An empty or inaccessible result has empty `content` and `extraction: "none"`. `ok` means nonblank extracted content, not verified truth or complete access to the website. No login, CAPTCHA solving, cookie persistence, JavaScript execution, link crawling, or automatic retry occurs.

## Safety and limits

Reuse HTTP URL validation and manual GET redirects. Reject HTTPS downgrade. Supplied credential headers are removed permanently after an origin change, even if a later redirect returns. TLS verification stays enabled; proxy environment variables are not used. No subresources, images, extracted links, canonical URLs, meta refreshes, or alternate-page endpoints are fetched.

HTML must be complete within the download limit. Return `response_limit` for a truncated HTML document instead of extracting a misleading partial tree. Plain text and Markdown can return a truncated UTF-8 prefix only when no credential was used. For an incomplete credentialed download, return `response_limit` because the last bytes could be an incomplete secret. Reject declared binary/JSON/XML formats, unsupported declared charsets, and invalid UTF-8. Only HTML, XHTML, plain text, and Markdown media types are supported.

Remove scripts, styles, forms, navigation, hidden nodes, frames, images, and metadata that can supply alternate URLs. Use the final HTTP URL to resolve HTML links. Keep only HTTP(S) links without embedded credentials; do not trust an HTML base URL. Known secrets are removed from DOM text before Markdown escaping, so entity decoding and Markdown punctuation do not expose a value that was recognized in a text node. Redact remaining raw known values after Markdown conversion, including values joined when comments or wrappers are removed. Drop HTML links that contain a known secret before or after URL resolution. Redact result metadata independently. A generated replacement marker is never passed through redaction again. Arbitrary alternate encodings, cross-node fragments changed by Markdown formatting, and newly issued tokens remain outside known-value redaction guarantees. Hidden-node cleanup covers explicit attributes and inline display/visibility rules, not external CSS or browser layout.

Bound processing to 50000 DOM elements and depth 64. Before extraction, retain at most 131072 bytes of redacted DOM text and at most 100 normalized links with 32768 destination bytes total. Limit an individual destination to 4096 bytes. Mark processing omissions as truncated. Convert tables to preformatted text blocks before Markdown conversion to prevent padding amplification; drop nonessential output attributes. Use one strict readability attempt, not repeated full-tree retries. Use the cleaned-page fallback if the extracted article has fewer than 100 characters. Return `response_limit` when structural bounds are exceeded. Parsing is bounded but synchronous: cancellation waits for a current library call to return. Check the native deadline after processing, and keep the separate host-client deadline.

Enforce the output limit on the complete JSON result after escaping. Shorten only `content`, preserve UTF-8 boundaries, and mark truncation. Return `output_limit` if metadata cannot fit. Native validation and transport errors use existing protocol error codes; messages do not contain raw URLs, headers, bodies, or credential data.

## Verification

Deterministic tests use local servers and synthetic pages: articles, short pages, code, lists, links, tables, entities, missing metadata, plaintext, access failures, JavaScript shells, malformed HTML, URL safety, credentials and redirects, processing limits, decompression, output limits, cancellation, concurrency, and shutdown. Client and tool tests cover typed wire validation, structured output, lazy shared ownership, read-only execution without UI, and cleanup. Manual public-page checks remain separate from CI and require no paid provider or API key:

```sh
sh scripts/build-web.sh all
node scripts/smoke-test-web-engine.mjs
node scripts/smoke-test-web-fetch.mjs
```

The live fetch check uses the actual Pi tool. It requires readable results from Example Domain, the Rust ownership chapter, and MDN's Fetch API page, then probes GitHub, Wikipedia, Stack Overflow, and Reuters without requiring those access-controlled sites to succeed. All returned JSON must fit 8192 bytes. A successful probe is evidence of readable server content, not proof of full access to every page on that site. Five of these seven sites returned readable content during development. Stack Overflow returned HTTP 403 and Reuters returned HTTP 401; these were reported as access failures, without reading their error bodies. No fingerprint-emulation transport was added. TLS emulation alone would not provide login, JavaScript rendering, or CAPTCHA solving.

The dependency notices and MPL-2.0 source-availability links in [Native web search](web-search.md) also apply to the shared HTML/CSS libraries. `dom_smoothie` is MIT-licensed: <https://github.com/niklak/dom_smoothie>. Retain upstream notices with distribution.

### dom_smoothie and dom_query MIT notices

```text
MIT License

Copyright (c) 2024 Mykola Humanov
Copyright (c) 2023 Mykola Humanov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The `dom_query` license also includes this upstream notice:

> This project contains portions of code and architectural concepts originally derived from the "nipper" project (https://github.com/importcjj/nipper), developed by Chen Jiaju, licensed under the MIT License and the Apache License 2.0 (dual licensed).
