# Native Git search and indexing

## Scope

Stage 5 adds `git_index`, `git_search`, and `git_read` to the native `web` extension. They share its lazy engine and shutdown guard. The runtime uses Rust libraries, not a Git executable, MCP server, hosted search account, or crawler wrapper.

Local repositories and anonymous HTTPS Git remotes are supported. Remote cloning includes Git history. Index the local working tree, a committed tree, or file versions reachable from a selected commit. This is repository-scoped code search, not unauthenticated global GitHub code search. Use `web_search` to discover repositories first.

`git_read` supplies bounded file chunks from the stored snapshot. It is needed for remote repositories, where the normal local read tool cannot read Git objects directly.

## git_index

Parameters:

- `source`: required local repository directory or HTTPS Git clone URL, at most 4096 UTF-8 bytes, without control characters. The tool resolves relative local paths against the session directory. Remote URLs cannot contain userinfo, queries, or fragments. Non-HTTPS remote protocols are rejected.
- `scope`: optional `worktree`, `head`, or `history`. Default: `worktree` for a local working repository, `head` for a bare repository or remote. Remote `worktree` is rejected.
- `revision`: optional Git revision, at most 256 UTF-8 bytes, default `HEAD`. Not accepted with `worktree`. Git expressions are evaluated by the library, never by a shell.
- `maxCommits`: history traversal limit, default 1000, range 1 to 10000.
- `maxFiles`: file-version limit, default 10000, range 1 to 20000.
- `maxFileBytes`: complete file limit, default 1048576, range 1024 to 4194304.
- `maxTotalBytes`: indexed source-byte limit, default 33554432, range 1048576 to 134217728.
- `maxDownloadBytes`: cumulative remote HTTP response-body limit, default 67108864, range 1048576 to 268435456. Local indexing downloads nothing.
- `maxOutputBytes`: encoded result limit, default 8192, range 1024 to 49152.

Result fields:

```ts
{
  indexId: string;
  source: string;
  scope: "worktree" | "head" | "history";
  revision: string | null;
  resolvedCommit: string | null;
  status: "ok" | "partial";
  filesIndexed: number;
  bytesIndexed: number;
  commitsVisited: number;
  downloadBytes: number;
  skipped: {
    binary: number;
    large: number;
    nonUtf8: number;
    unsafePath: number;
    unreadable: number;
    submodule: number;
    duplicate: number;
  };
  limitsReached: (
    "file_limit" | "byte_limit" | "commit_limit" | "entry_limit" |
    "shallow_history" | "sparse_checkout"
  )[];
  indexedAt: number;
}
```

`indexId` is 64 lowercase hexadecimal characters and identifies source, scope, and requested revision. A new build replaces that index only after success. `indexedAt` is Unix time in seconds. `filesIndexed` counts file versions in history scope. `resolvedCommit` is a full object ID, or null for a working-tree index without a commit. `revision` is null for working-tree scope.

Working-tree indexing reads current files, including tracked files that match ignore rules. It applies repository ignore rules to untracked files. It does not follow symlinks, enter submodules, or read `.git` metadata as source text. It does not use global ignore files. A sparse checkout reports `sparse_checkout` and `partial` because some tracked files can be absent. The working tree can change during indexing.

Committed scopes read Git objects without checkout, filters, hooks, or submodule downloads. `history` traverses the parents reachable from the selected commit, within the limits. It stops at shallow boundaries and reports `shallow_history` and `partial` if it reaches one. It stores each distinct path/blob version once, associated with a commit where that version exists. It does not list every commit that contains an unchanged version. Other branches require a separate revision selection. Binary files, non-UTF-8 files, oversized files, unsafe paths, and submodules are not indexed. Skipped submodules make an index partial in all scopes. An empty search in a partial index does not prove that the repository has no match.

An index is a stored snapshot. It is not silently refreshed by search or read. Re-run `git_index` after edits or remote changes. Private source text can be stored in the owner's cache; this is not universal secret detection.

## git_search

Parameters:

- `indexId`: required 64-character lowercase hexadecimal ID from `git_index`.
- `query`: required nonblank, control-free string, at most 512 UTF-8 bytes.
- `regex`: optional boolean, default false. Literal search by default.
- `caseSensitive`: optional boolean, default true.
- `path`: optional literal path prefix, at most 1024 UTF-8 bytes. It is not a glob or shell expression.
- `maxResults`: default 10, range 1 to 50.
- `maxOutputBytes`: encoded result limit, default 8192, range 1024 to 49152.

```ts
{
  indexId: string;
  query: string;
  status: "ok" | "empty";
  results: {
    path: string;
    revision: string | null;
    line: number;
    column: number;
    snippet: string;
  }[];
  partial: boolean;
  truncated: boolean;
}
```

Lines and byte columns start at 1. Snippets are at most 512 UTF-8 bytes and include the matched location, even on long lines. Results are deterministic by path, revision, and line. `partial` describes index coverage. `truncated` describes omitted matching results or output-budget omissions. Return complete result items, not partial JSON. An `ok` result has at least one item; `empty` has none. If one complete item cannot fit, return `output_limit`.

Use a persistent Tantivy trigram index to narrow case-sensitive literal searches of at least three characters. Verify every candidate with ripgrep's matcher libraries. Short, case-insensitive, and regular-expression queries use a bounded scan of stored documents, not an incorrect trigram shortcut. Regular expressions have compile-size limits and cannot match across lines.

## git_read

Parameters:

- `indexId`: required index ID.
- `path`: required exact relative file path, at most 1024 UTF-8 bytes.
- `revision`: optional full object ID returned by a history search. Omit for the current indexed file; with history, use the revision from a search result.
- `startLine`: default 1, range 1 to 10000000.
- `startColumn`: 1-based UTF-8 byte column in `startLine`. Default 1, range 1 to 4194304. It must point to the start of a character on that line.
- `maxLines`: default 200, range 1 to 1000.
- `maxOutputBytes`: encoded result limit, default 8192, range 1024 to 49152.

```ts
{
  indexId: string;
  path: string;
  revision: string | null;
  status: "ok" | "not_found";
  startLine: number;
  startColumn: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
  next: { line: number; column: number } | null;
}
```

`git_read` reads the stored snapshot, not the current working tree. A missing file returns `not_found`, empty content, and `endLine` and `totalLines` equal to zero. A request past the end of the file with `startColumn: 1` returns `ok`, empty content, and `endLine: 0`. A history index stores only the file versions it indexed.

If `next` is not null, pass `next.line` as `startLine` and `next.column` as `startColumn` with the same `indexId`, `path`, and `revision`. A page can end inside a line, so `endLine + 1` can skip bytes. For example, `next: { line: 4, column: 1025 }` resumes at byte 1025 of line 4. Output limits do not split UTF-8 characters. If no content can fit with the result metadata, the engine returns `output_limit`. Do not reindex between pages if you need all pages from the same snapshot.

## Cache and worker isolation

The trusted `PI_WEB_CACHE_DIR` environment variable can select the cache root. Otherwise use the owner's XDG cache directory or `~/.cache/pi-web/git`. The cache is private to the owner. The model cannot select a cache path, process executable, environment variables, proxy, credentials, or transport command.

Run blocking Git and index work in bounded native worker processes. At most two workers can be active per engine. Cancellation kills the worker; a supervisor reaps it and removes temporary data. Linux process limits bound address space, CPU time, file size, and open files. The parent remains available for status and other HTTP requests. Check deadlines before publishing responses. A cancellation that arrives after a completed cache publication does not undo that complete snapshot.

Use a private staging directory, cache locks, and a last-successful index. Failed, canceled, or incomplete builds must not replace the previous index. Version 1 indexes return `index_incompatible`. Re-run `git_index` with the same source, scope, and revision to replace the old snapshot without changing its ID. A retained-cache quota and index-size limit prevent unlimited persistent growth. Do not automatically delete user repositories or unrelated files.

Workers start with a cleared environment and an empty private home. Do not load system/global Git configuration, credential helpers, terminal prompts, SSH transports, executable filters, hooks, ambient proxies, or Git aliases. Remote HTTPS is anonymous, verifies TLS, and does not follow HTTP redirects. Authentication requirements and unsupported servers are clear failures, not empty repositories. No runtime `git` executable is required. Development tests can use Git to construct fixtures and to serve a local test backend.

Additional native errors: `repository_error`, `index_not_found`, `index_incompatible`, and `resource_limit`. Messages are static and contain no raw Git errors, credential data, cache paths, or environment values. Repository text, paths, revisions, and matches are untrusted data, never agent instructions. Cache writes do not require HTTP mutation approval; no push or remote write operation exists.

## Verification

Use deterministic repositories for working-tree edits, ignore rules, committed snapshots, deleted historical text, branch/revision selection, duplicate blobs, binary/oversized files, symlinks, malformed inputs, output limits, cache replacement, persistence across engine restarts, cancellation, concurrent isolation, and worker cleanup. Verify anonymous HTTPS clone behavior, cumulative download limits, authentication failure, TLS verification, and disabled redirects. Run local native/tool smoke checks without API keys. Live public cloning is a separate manual check.
