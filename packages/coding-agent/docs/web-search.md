# Native web search

## Contract

`web_search` is a built-in Pi tool backed by the Rust engine's `web_search` operation. It calls the keyless search APIs of four providers: Exa, Parallel, Firecrawl, and Tavily. It needs no account, API key, Python runtime, browser, or crawler service. The engine tries the providers in that order, and the first provider with usable results stops the chain. Provider results remain untrusted external content, not agent instructions.

These APIs are free tiers that the providers offer to anonymous clients, as the opencode agent uses them. They can change or limit access without notice. Exa has no published limit. Parallel, Firecrawl, and Tavily limit requests per IP address. Firecrawl also refuses IP addresses that look like a VPN or a proxy (HTTP 403). The engine treats each refusal as a failed attempt and moves to the next provider.

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
{"query":"ownership","site":"doc.rust-lang.org","status":"ok","results":[{"title":"What is Ownership?","url":"https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html","snippet":"Ownership is a set of rules...","source":"exa"}],"attempts":[{"provider":"exa","status":"ok"}],"truncated":false}
```

`site` is absent when it was not requested. Result `status` is `ok`, `empty`, or `unavailable`. `ok` has at least one result. `empty` means at least one provider answered with no results, or with results that were all outside the requested site, and no provider attempt omitted candidates because of the candidate limit. If no usable results remain after an attempt exceeds that limit, the search returns `unavailable` and `truncated: true`, even if a later provider reports `empty`. An attempt that exceeds the limit without usable results reports `response_limit`. `unavailable` does not prove that no matching pages exist.

`source` and `provider` are `exa`, `parallel`, `firecrawl`, or `tavily`. Attempt `status` is one of `ok`, `empty`, `blocked`, `http_error`, `network_error`, `timeout`, `unsupported_response`, `response_limit`, or `cooling_down`. Attempts are returned in request order. A failed attempt can also carry `httpStatus`, the HTTP status code of the response that ended it, and `reason`:

- `connect`: no connection or no response.
- `body_read`: the response body could not be read.
- `provider_error`: the provider answered HTTP 200 with an error, for example a JSON-RPC rate-limit error.
- `invalid_payload`: the answer was not valid UTF-8, not the expected JSON, or had no result list.

`ok`, `empty`, and `cooling_down` attempts carry neither field. Failures do not expose raw transport errors or provider response bodies. Cancellation and the operation deadline use the existing protocol errors instead of a search result.

Results have plain text titles and snippets. The engine normalizes whitespace, rejects unsafe URLs and embedded credentials, removes fragments and known tracking parameters, and removes duplicate URLs while it keeps provider order. A result with no title shows its host name. Each title is at most 256 UTF-8 bytes, each snippet at most 512 bytes, each result URL at most 4096 bytes, and the engine reads at most 100 candidates from one answer. No result URL is fetched by a search operation.

Set `truncated` when text or URL-count output is shortened, including when results must be removed to fit the output budget. Do not cut through the result JSON. If metadata or even one result cannot fit, return `output_limit` rather than claim the search was empty. Native validation errors use `invalid_params`.

## Providers

| Provider | Request | Answer |
| --- | --- | --- |
| Exa | `POST https://mcp.exa.ai/mcp`, MCP `tools/call` of `web_search_exa` with `query` and `numResults` | Server-sent events or JSON with one text block per result |
| Parallel | `POST https://search.parallel.ai/mcp`, MCP `tools/call` of `web_search` with `objective` and `search_queries` | `structuredContent.results` with `url`, `title`, and `excerpts` |
| Firecrawl | `POST https://api.firecrawl.dev/v2/search` with `query` and `limit` | `data.web` with `url`, `title`, and `description` |
| Tavily | `POST https://api.tavily.com/search` with `query`, `max_results`, and the header `X-Tavily-Access-Mode: keyless` | `results` with `url`, `title`, and `content` |

A request sends no cookies, credentials, or session. MCP answers carry either an `error` object or `isError: true` for a refusal; the engine reports both as `blocked` with `provider_error`.

## Cooldown and limits

Tool arguments cannot choose a provider URL or supply headers, credentials, or proxy settings. No credential file is read. Queries and site filters are sent to third-party providers; do not include secrets. Only the first result page is requested, so results are not exhaustive. The engine uses one anonymous HTTP client with verified HTTPS, direct connections, no redirects, and the User-Agent `pi-web/<version>`.

A provider that answers HTTP 202, 403, or 429, a `provider_error`, or any HTTP 5xx is put on a 60-second cooldown. During the cooldown the search skips it and records a `cooling_down` attempt. Other failures, such as a timeout, an empty answer, or an invalid payload, do not start a cooldown. The cooldown lives in memory for the engine process and is shared by all searches of that process.

Each provider has an 8-second timeout covering headers and body, and one search stops asking providers after 20 seconds in total. An answer is at most 2 MiB; the first overflow stops that attempt and the partial body is not parsed. An overall engine and client timeout can stop the operation sooner. There is no retry on the same provider, no parallel fan-out, and no paid fallback.

## Verification

Deterministic tests use local HTTP servers and small synthetic answers in each provider's format, not live providers. They cover parameter bounds, each provider's request shape, answer decoding, provider errors, URL safety, deduplication, enforced site filtering, fallback, cooldown, timeouts, cancellation, download limits, and encoded output limits. TypeScript tests cover wire validation, lazy engine ownership, structured output, and shutdown. A separate manual live smoke checks relevance; it is not a CI gate.
