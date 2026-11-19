# Native web engine

## Current scope

`pi-web` is a Linux-only Rust helper. `WebEngineClient` starts it on demand and reuses the process until its owner closes it. It uses local pipes, not MCP or an HTTP server. Stage 1 provides the engine lifecycle and protocol. Stage 2 adds the [native HTTP/API operation](web-http.md) and the built-in `http_request` tool. Stage 3 adds [key-free web search](web-search.md) through `web_search`. Stage 4 adds [page retrieval and readable content extraction](web-fetch.md) through `web_fetch`. Stage 5 adds [repository indexing, search, and reads](web-git.md) through `git_index`, `git_search`, and `git_read`. The built-in `web` extension owns the client and closes it on session shutdown, replacement, or reload. No process starts until the tool is used.

By default, the model sees one tool, `web_tools`. It calls an existing operation with `operation` and `args`, for example `{"operation":"web_fetch","args":{"url":"https://example.com/","maxOutputBytes":1800}}`. Set `describe: true` to get the inputs and guidance for one operation without running it. Neither call changes the tool declarations or system prompt. This keeps the prompt prefix stable for cache reuse. The gateway uses the existing input validation, tool hooks, and HTTP approval rules.

To disable all web and Git operations, disable `web` under Built-in in `pi config` or set `"extensions": ["-builtin:web"]`. The gateway only calls enabled operations, so `--exclude-tools http_request` still blocks HTTP API requests through it. To declare an operation directly instead of using the gateway, select it without `web_tools`, for example `pi --tools read,web_fetch`.

The first release must support key-free broad search and mixed developer/general-web research. Hosted APIs remain optional. Browser execution is outside the first release.

## Protocol version 1

Each frame is one UTF-8 JSON object followed by a newline. Frames must not exceed 65,536 bytes before the newline. Diagnostic output must use stderr. stdout is reserved for protocol frames.

The engine emits one startup frame:

```json
{"type":"ready","protocolVersion":1,"engineVersion":"0.1.0"}
```

Pi must validate this frame before sending requests. An unsupported protocol version, malformed output, an oversized frame, or an unexpected process exit invalidates the connection and fails its pending requests. An invalid connection must not replay requests. A later call may start a new process.

Pi sends requests with a unique nonempty string ID of at most 128 ASCII alphanumeric, hyphen, or underscore characters. A timeout is required and must be between 1 and 120,000 milliseconds.

```json
{"type":"request","id":"1","operation":"status","timeoutMs":30000}
```

The client and engine each support up to 32 active requests and reject an additional request with `busy`. A duplicate active ID is a protocol error and must not replace the original request. Requests may complete out of order. Responses for an ID that the client never issued on that connection invalidate the connection.

Requests may include an optional `params` value. `status` ignores it. All other operations require a parameter object. See [HTTP requests](web-http.md), [web search](web-search.md), [page retrieval](web-fetch.md), and [Git indexing and search](web-git.md).

The `status` operation returns the engine version, protocol version, and supported operations:

```json
{"type":"result","id":"1","result":{"engineVersion":"0.1.0","protocolVersion":1,"operations":["status","http_request","web_search","web_fetch","git_index","git_search","git_read"]}}
```

An accepted request receives exactly one terminal `result` or `error` frame. Error messages must not include the raw input frame or environment values.

```json
{"type":"error","id":"1","code":"timeout","message":"Request timed out"}
```

Transport error codes are `invalid_request`, `unsupported_operation`, `busy`, `cancelled`, `timeout`, and `internal`. HTTP operation error codes are documented in [Native HTTP requests](web-http.md). Invalid frames that cannot safely be associated with a request use `id: null`. The engine reports malformed, unknown, duplicate-ID, and oversized input frames as `invalid_request` with `id: null`. Pi treats an error with a null ID as a connection failure. An oversized input frame must terminate the engine after the error frame, without reading an unbounded line. An otherwise valid request with an unknown operation receives `unsupported_operation` with its request ID.

Pi can cancel one request:

```json
{"type":"cancel","id":"1"}
```

The engine returns `cancelled` if the request is still running. Once a terminal response starts, cancellation must not interrupt its frame. The request retains its capacity slot until that response is written. Cancellation of an unknown or already completed request has no effect. A client that already settled an aborted or expired request ignores its later terminal response. Aborting one request must not terminate the shared process or its other requests.

Pi can close the connection:

```json
{"type":"shutdown"}
```

On shutdown or stdin EOF, the engine cancels its remaining work and exits. Pi bounds the shutdown wait and terminates a process that does not exit. Engine deadlines are enforced independently of the client's deadlines, including a check after synchronous processing. DOM parsing is bounded but not preempted inside a library call; cancellation can take effect after that call returns. The client has its own deadline in the host process.

## Packaging

Follow the existing Linux native-helper build pattern: `pi-web-x64` and `pi-web-arm64` in `packages/coding-agent/dist/bin`. Development can use the crate's local release binary. Asset resolution belongs in `src/config.ts`. `PI_WEB_BIN` can select an explicit executable.

## Build and smoke test

Build prerequisites are Rust with `rustup`, Zig, and `cargo-zigbuild` (verified with version 0.24.1). Install the Cargo helper with `cargo install cargo-zigbuild --version 0.24.1 --locked` and make Zig available to it. The build uses Zig for the TLS crypto dependency's C code and static musl linking on both architectures. These tools are build dependencies only; the packaged helper does not need Rust or Zig at runtime. HTTPS uses the host's trusted CA certificates.

From the repository root:

```sh
sh scripts/build-web.sh
node scripts/smoke-test-web-engine.mjs
```

The build produces both Linux architectures. The smoke test runs the current host's binary through the TypeScript client. Cross-compilation alone does not verify execution on the other architecture.

## Verification

Rust tests cover frame validation and bounds, status requests, deadlines, cancellation, concurrent request ownership, duplicate IDs, and shutdown. TypeScript tests use local process fixtures to cover startup validation, frame parsing, out-of-order replies, cancellation isolation, deadline cleanup, child exit, bounded output, and shutdown. A native smoke test checks the actual Rust binary, HTTP requests to a local server, and the model-facing tool. No public website, live provider, paid token, or API key is needed for these tests. Search tests use local HTML fixtures and servers for extraction, fallback, access failures, host filters, limits, and cancellation. The separate `node scripts/smoke-test-web-search.mjs` command makes live key-free searches and checks broad and site-specific results; it is a manual check, not a CI gate. Page tests cover readable extraction, short-page fallback, access failures, safe links, credential handling, malformed HTML, and structural/download/output bounds. `node scripts/smoke-test-web-fetch.mjs` runs the actual Pi tool against public pages; it is also manual and not a CI gate.
