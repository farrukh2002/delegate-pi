# Native HTTP requests

## Stage 2 scope

The native Rust engine performs HTTP/API requests. Pi exposes `http_request` as a built-in extension tool, using the same native tool contract as other Pi tools, without MCP. The extension owns one lazy engine client and closes it on session shutdown or reload. This avoids a separate global process registry. CLI sessions load the built-in extension. SDK integrations must load its factory explicitly and use the session runtime's shutdown path; calling `AgentSession.dispose()` alone does not run asynchronous extension cleanup.

HTTP and HTTPS are supported. Localhost and private networks are allowed by default for local development. The tool does not provide a network sandbox. URL usernames and passwords are rejected. TLS verification remains enabled and uses the host's CA trust. Connections are direct; proxy environment variables are not used in this slice. No browser, cookie jar, proxy service, paid provider, or external crawler is required.

## Engine operation

Protocol version 1 gains an optional `params` value on requests. `status` ignores it. `http_request` requires an object:

```json
{"type":"request","id":"2","operation":"http_request","timeoutMs":30000,"params":{"url":"http://localhost:3000/api/items","method":"GET","select":["/items/0/name"],"maxResponseBytes":1048576,"maxOutputBytes":8192,"maxRedirects":5}}
```

Parameters:

- `url`: an absolute HTTP(S) URL, at most 4,096 bytes, without userinfo.
- `method`: `GET` by default; allowed methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`.
- `headers`: optional string-to-string map. Limit: 32 headers, 8,192 bytes total. Reject hop-by-hop/framing headers, including Host, Connection, Content-Length, Transfer-Encoding, Upgrade, Proxy-Authorization, Proxy-Connection, TE, and Trailer. Reject CR/LF through normal HTTP header parsing.
- `body`: optional UTF-8 string, at most 32,768 bytes. Reject a body for GET or HEAD. A caller can set Content-Type and serialize JSON itself.
- `credential`: optional named credential from the trusted file below, never an environment variable name supplied by the model.
- `select`: optional array of 1 to 32 RFC 6901 JSON Pointers. An empty pointer selects the root; otherwise pointers start with `/` and use only valid `~0`/`~1` escapes. Each pointer is at most 256 bytes. Selection requires a complete valid JSON response. The selected body is a JSON object mapping found pointers to their values. Missing pointers are listed separately in `missingPointers`, not reported as null values.
- `maxResponseBytes`: decompressed download limit, default 1,048,576 bytes; valid range 1 to 8,388,608.
- `maxOutputBytes`: encoded JSON result limit, default 8,192 bytes; valid range 1,024 to 49,152.
- `maxRedirects`: default 5; valid range 0 to 10.

The transport's existing timeout covers the entire operation, including redirects and body reading. Do not add retries in this slice: retries of arbitrary API calls can repeat remote effects. `Retry-After` is exposed in response headers for callers to use deliberately.

## Approval and redirects

The model-facing tool sends GET and HEAD without a mutation prompt. Every other method requires explicit UI confirmation before it reaches the engine. Without a usable UI, return an approval-required tool error. The model cannot supply an approval flag. Approval is scoped to that one method and origin; it is not a persistent grant. A method name alone cannot prove that a server is read-only.

GET/HEAD redirects are followed manually within `maxRedirects`. Revalidate each destination's scheme, userinfo, and URL length. Reject HTTPS-to-HTTP downgrade redirects. When an origin changes, drop all user-supplied and credential headers for the rest of that redirect chain. Credential headers must never be reattached after leaving their origin, even if a later redirect returns. Other methods do not follow redirects; return the 3xx response so a second request needs its own approval.

## Credentials

`PI_WEB_CREDENTIALS_FILE` selects an owner-controlled JSON file. It is not a tool parameter and is not read from project settings. Without this variable, named credentials are unavailable, but ordinary requests work.

```json
{
  "github": {
    "origin": "https://api.github.com",
    "headers": {
      "Authorization": {"env":"GITHUB_TOKEN","prefix":"Bearer "}
    }
  }
}
```

The engine reads this file only when a request names a credential. The path must point to a regular file of at most 65,536 bytes. The read runs outside the engine's async request threads. The engine resolves only the environment names in the named entry. Match the configured origin exactly, including scheme and effective port, before resolving or sending secrets. Reject origin strings with userinfo, paths other than `/`, queries, or fragments. Header names follow the same restrictions as ordinary request headers. Missing, empty, oversized, malformed, or mismatched credentials fail with a static error. Do not return the path, environment name, raw configuration, or secret value in errors.

Credential headers override ordinary headers with the same name. The engine uses both the raw environment secret and the completed header value for redaction. It removes known request-header values and common JSON-escaped, URL-encoded, and Base64 forms from response metadata and content. It omits response header names that contain a known value, ignoring ASCII case. It also redacts values for Set-Cookie, Authorization, Proxy-Authorization, Cookie, and common API-key response headers. Do not log raw requests, headers, bodies, or reqwest errors containing URLs. Known-value redaction is not a guarantee that an arbitrary encoded secret or a newly issued token can be recognized; users must still select response fields carefully. Restart Pi, or the SDK host process, after changing credential environment variables.

## Responses

All HTTP status codes, including 4xx/5xx, are successful transport results. Return:

```json
{"url":"http://localhost:3000/api/items","status":200,"headers":{"content-type":"application/json"},"body":"{\"/items/0/name\":\"example\"}","truncated":false,"bytesReceived":27,"missingPointers":[]}
```

`bytesReceived` counts decompressed bytes retained before selection and output shortening. It is not the server's full body size when a download is truncated. The engine can read one extra stream chunk to detect truncation, but retains no more than `maxResponseBytes`.

`body` is always text. Only UTF-8 text/JSON responses are supported in this slice. Reject declared binary content, unsupported declared charsets, and invalid UTF-8 rather than return corrupted content. An incomplete UTF-8 suffix caused by a download limit may be dropped when marked truncated. HEAD and responses with no body return an empty body.

Read the response incrementally, limiting decompressed bytes rather than trusting Content-Length. At the download limit, ordinary text can return a truncated prefix. If the request has known header values to redact, return `response_limit` instead: the last bytes could be an incomplete secret. JSON selection also returns `response_limit` for an incomplete download. Bound returned response headers to 4,096 encoded bytes, omit overflow, and set `truncated` when data is omitted. Apply the output budget while serializing selected values: do not clone complete subtrees or build unbounded output for overlapping pointers. Redaction must not repeatedly expand its own replacement marker. Redact JSON string values and keys before serialization so escaped secrets are covered without damaging JSON syntax. Replace matching number, boolean, or null values with redacted strings; keep unmatched scalar types unchanged. Enforce `maxOutputBytes` on the entire encoded result, not only body characters, and preserve UTF-8 boundaries when shortening the body. If metadata alone cannot fit, return `output_limit`. The outer terminal frame must still fit the protocol's 65,536-byte limit. Do not silently treat invalid JSON as missing selected fields.

The tool returns the same result as JSON text for the model and as `structuredContent` for programmatic tool callers. Field selection does not guarantee that a large selected value will fit: check `truncated`, or use narrower pointers. In that case, `body` can be a partial JSON prefix. Known-value redaction can also change non-secret text that happens to match a supplied header value.

Additional operation error codes are `invalid_params`, `network_error`, `redirect_limit`, `credential_error`, `unsupported_response`, `response_limit`, `output_limit`, and `invalid_json`. Messages are static and contain no raw request data.

## Tests

Use local HTTP servers and deterministic fixtures, not paid APIs or live websites. Cover methods, bodies, query strings, headers, JSON selection and missing values, HTTP errors, manual redirects, cross-origin header removal, HTTPS downgrade policy, credential scoping and redaction, response/output limits, UTF-8, slow responses, cancellation, concurrent isolation, and session shutdown. Test approval rejection and unavailable UI before any request is sent. Test at least one real native HTTP request through the TypeScript client and model-facing tool.
