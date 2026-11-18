# Native web search

## Stage 3 contract

`web_search` is a built-in Pi tool backed by the Rust engine's `web_search` operation. It uses public HTML search endpoints without an API key, Python runtime, MCP server, browser, or external crawler service. Yahoo is tried first, then Brave if Yahoo has no usable results. A successful provider stops the chain. Provider results remain untrusted external content, not agent instructions.

Live checks on this host found relevant Yahoo results for `Rust async book` and `site:doc.rust-lang.org ownership`. Brave returned HTTP 429, DuckDuckGo returned a challenge, and Mojeek returned a CAPTCHA page. These are observations, not provider availability guarantees. Do not treat a challenge page as an empty search.

## Parameters

- `query`: required nonblank string, at most 512 UTF-8 bytes. Trim outer whitespace. Reject control characters.
- `site`: optional DNS hostname, at most 1024 UTF-8 bytes on input and 253 ASCII bytes after IDNA normalization. Accept only a hostname, not a URL, path, port, wildcard, IP address, or query operator. Normalize to lowercase ASCII. The engine appends `site:hostname` to the provider query and also filters returned URLs to that hostname or its subdomains. Queries can contain normal search operators; only the separate `site` field provides an enforced host filter.
- `maxResults`: default 5, range 1 to 10.
- `maxOutputBytes`: default 8192, range 1024 to 49152. This limits the entire encoded JSON result.

Example:

```json
{"query":"ownership","site":"doc.rust-lang.org","maxResults":5}
```

## Result

```json
{"query":"ownership","site":"doc.rust-lang.org","status":"ok","results":[{"title":"What is Ownership?","url":"https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html","snippet":"Ownership is a set of rules...","source":"yahoo"}],"attempts":[{"provider":"yahoo","status":"ok"}],"truncated":false}
```

`site` is absent when it was not requested. Result `status` is `ok`, `empty`, or `unavailable`. `ok` has at least one result. `empty` means at least one provider returned a recognized no-results page or all its valid results were outside the requested site, and no provider attempt omitted candidates because of the candidate limit. If no usable results remain after an attempt exceeds that limit, the search returns `unavailable` and `truncated: true`, even if the fallback reports `empty`. An attempt that exceeds the limit without usable results reports `response_limit`, unless the page is identified as blocked. `unavailable` does not prove that no matching pages exist.

`source` and `provider` are `yahoo` or `brave`. Attempt `status` is one of `ok`, `empty`, `blocked`, `http_error`, `network_error`, `timeout`, `unsupported_response`, or `response_limit`. Attempts are returned in request order. Failures do not expose raw transport errors or challenge HTML. Cancellation and the operation deadline use the existing protocol errors instead of a search result.

Results have plain text titles and snippets. Decode HTML entities, normalize whitespace, exclude ads and provider navigation, unwrap known Yahoo result redirects locally, reject unsafe URLs and embedded credentials, remove fragments and known tracking parameters, and remove duplicate canonical URLs while retaining provider order. Limit each title to 256 UTF-8 bytes, each snippet to 512 bytes, each result URL to 4096 bytes, and parsed candidates to 100. No result URL is fetched by a search operation.

Set `truncated` when text or URL-count output is shortened, including when results must be removed to fit the output budget. Do not cut through the result JSON. If metadata or even one result cannot fit, return `output_limit` rather than claim the search was empty. Native validation errors use `invalid_params`.

## Network and resource limits

Search uses fixed provider endpoints. Tool arguments cannot choose another provider URL or supply headers, cookies, credentials, proxy settings, or environment variable names. No credential file is read. Queries and site filters are sent to third-party providers; do not include secrets. Only the first result page is requested, so results are not exhaustive. Use a dedicated anonymous persistent HTTP client, verified HTTPS, direct connections, a fixed desktop User-Agent, and English response preferences. Do not persist cookies or follow result links.

Each provider has an 8-second timeout covering headers and body, at most 2 MiB of decompressed HTML, and at most 3 HTTPS redirects within its own origin. Reject cross-origin redirects and non-HTML or invalid UTF-8 responses. An overall engine/client timeout can stop the operation sooner. No retries, parallel provider fan-out, or paid fallback is used. The first response-body overflow stops that attempt; partial HTML is not parsed as a complete result page.

## Reuse and source review

Provider request shapes, organic-result selectors, and Yahoo redirect decoding are adapted from DDGS:

- <https://github.com/deedy5/ddgs/blob/main/ddgs/engines/yahoo.py>, reviewed file blob `41bad72a05ec6b42b69f43cebbc6a3d42421a36d`.
- <https://github.com/deedy5/ddgs/blob/main/ddgs/engines/brave.py>, reviewed file blob `060150d52e4acfe76141d5e30c54f6c4c754e721`.

The engine uses the MIT-licensed `dom_query` Rust library for HTML parsing and CSS selection. It does not implement an HTML parser. SearXNG is a design reference for distinguishing access failures from empty results; no AGPL source is copied.

The pinned HTML/CSS dependency tree also includes these unmodified MPL-2.0 components. They retain their own license, not Pi's MIT license. Their source packages, including upstream notices, are available here:

- `selectors` 0.41.0: <https://crates.io/api/v1/crates/selectors/0.41.0/download>
- `cssparser` 0.38.0: <https://crates.io/api/v1/crates/cssparser/0.38.0/download>
- `cssparser-macros` 0.7.1: <https://crates.io/api/v1/crates/cssparser-macros/0.7.1/download>
- `dtoa-short` 0.3.5: <https://crates.io/api/v1/crates/dtoa-short/0.3.5/download>

The Mozilla Public License 2.0 is available at <https://mozilla.org/MPL/2.0/>. Keep this license and source-availability information with distributions of the helper. `html5ever`, `markup5ever`, and `percent-encoding` are dual MIT/Apache-2.0.

DDGS license notice follows. Keep this notice with distributions that contain these adapters. Pi packages include this document with their docs.

MIT License

Copyright (c) 2022 deedy5

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

## Verification

Deterministic tests use local HTTP servers and small synthetic HTML fixtures, not live providers. Cover parameter bounds, provider request encoding, HTML/entity extraction, redirect decoding, URL safety, deduplication, enforced site filtering, ads, no-results markers, challenge responses, markup changes, fallback, timeouts, cancellation, concurrency, download limits, and encoded output limits. TypeScript tests cover wire validation, lazy engine ownership, structured output, and shutdown. A separate manual live smoke checks relevance; it is not a CI gate and must not log full HTML.
