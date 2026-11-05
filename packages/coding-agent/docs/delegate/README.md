# Delegate Pi fork

This directory documents the fork of Pi into the **Delegate Pi** distribution. The Delegate
feature is implemented: the `delegate` and `delegate_tasks` tools, a session-scoped task
manager with dialog and report delivery, a CLI transport to the bundled child runtime, the
live task band above the editor, tool and message renderers, the `delegate-tasks` screen,
and the child runtime itself under `delegate/` (sandboxed providers, scope locks, task
persistence, heartbeat and pruning).

Where the code lives:

- `src/extensions/delegate/` — extension wiring (`index.ts`), tools (`tools.ts`), renderers
  (`renderers.ts`), tasks screen (`screen.ts`).
- `src/core/delegate/` — `manager.ts` (state, dialogs, report delivery), `transport.ts`
  (`delegate.mjs` CLI client), `view.ts` (shared types, status marks, report, notice and answer
  text), `config.ts`. `view.ts` is a byte copy of `core/view.ts` in the delegate repository; the
  Claude Code, pi and Command Code hosts use the same file, and `check:delegate-sync` checks the copy.
- `src/modes/interactive/components/delegate-band.ts` and `delegate-style.ts` — live band.
- `src/core/keybindings.ts` — `app.delegate.*` keybindings.
- `delegate/core/` — child runtime (`delegate.mjs` CLI, providers, sandbox, workspace and
  scope locks, agents, model discovery in `models.ts`); `delegate/agents/` — bundled agents;
  `delegate/tests/` — runtime tests (node:test).
- `test/delegate-*.test.ts` — fork tests (vitest).

## Provenance

- Upstream project: `earendil-works/pi`, release `v1.4.0`.
- Upstream commit: `4a080252f06caf63a525d7873c5d94d3c23887e0` (`Release v1.4.0`).
- Delegate baseline commit: `3b8846d`, plus the core parts of `0008605` (scopes for new
  files, failed-start errors) and the model-discovery feature from the delegate repository
  working tree (synced 2026-11-02). Run `npm run check:delegate-sync` to detect drift.
- The native UI is a port of the Claude Code plugin in the delegate repository:
  `hosts/claude/hooks/mod.tsx`, `hosts/claude/hooks/live.tsx` and `hosts/claude/types/`
  at delegate commit `3b8846d`. Read them there with `git show 3b8846d:<path>`.
- `reference/colors.json` records the Claude Code palette that the fork themes follow.

## Fork identity

The distribution identity is set in `packages/coding-agent/package.json`:

- `piConfig.name` = `delegate-pi`
- `piConfig.configDir` = `.delegate-pi`
- `bin` = `{ "delegate-pi": "dist/bundle/cli.js" }`
- Internal package names are preserved: the package `name` stays
  `@earendil-works/pi-coding-agent`, and all workspace dependency names are unchanged.

Values derived at runtime in `src/config.ts`:

- `APP_NAME` = `delegate-pi`
- `APP_TITLE` = `delegate-pi`
- `CONFIG_DIR_NAME` = `.delegate-pi`
- `ENV_AGENT_DIR` = `DELEGATE_PI_CODING_AGENT_DIR`
- `ENV_SESSION_DIR` = `DELEGATE_PI_CODING_AGENT_SESSION_DIR`
- `PACKAGE_NAME` = `@earendil-works/pi-coding-agent`
- agent config directory = `~/.delegate-pi/agent` (unless an env override is set)

The environment prefixes are uppercased and any non-alphanumeric character becomes an
underscore, so `delegate-pi` yields the shell-safe prefixes `DELEGATE_PI_CODING_AGENT_DIR`
and `DELEGATE_PI_CODING_AGENT_SESSION_DIR`. The fork keeps its state under `~/.delegate-pi`
instead of `~/.pi`.

## Claude plugin API to Pi equivalents

The reference plugin targets the Claude Code plugin API. The fork maps its surfaces to Pi
extension APIs as follows:

| Reference (Claude Code) | Delegate Pi |
| --- | --- |
| `ui.render` `ToolUse` / `ToolResult` | `pi.registerTool` with `renderCall` / `renderResult` (`src/extensions/delegate/tools.ts`, `renderers.ts`) |
| `ui.render` `AbovePrompt` live band | `ctx.ui.setWidget("delegate-band", ..., { placement: "aboveEditor" })` (`src/extensions/delegate/index.ts`) |
| `ui.render` `UserMessage` report notice | `pi.registerMessageRenderer("delegate-report", ...)` (`renderers.ts`) |
| `ui.render` `Pane` task list | `ctx.ui.custom` full screen opened by the `delegate-tasks` command (`src/extensions/delegate/screen.ts`) |
| `tool.check` auto-allow | No Pi equivalent. Pi has no plugin tool-approval hook; tools registered with `registerTool` run like built-in tools, so there is nothing to auto-allow. |
| Plugin state atoms (`tasks-1`, `calls-1`) | Session custom entries `delegate.tasks`, `delegate.calls`, `delegate.reports` (`src/core/delegate/manager.ts`) |
| `turn.start` / `turn.complete` / `prompt.submit` | `tool_result` and `before_agent_start` extension events (`src/extensions/delegate/index.ts`) |

## Decisions

- Band input model: in regular (inline) mode the band is keyboard-only — `alt+d` focuses
  the band (`app.delegate.focus`), `j`/`k` move, `enter`/`space` toggle, `escape` returns
  focus to the editor (`app.delegate.*` in `src/core/keybindings.ts`). Mouse interaction is
  fullscreen-only; the band component implements `handleMouse` and that handler is
  unit-tested, but regular mode is not wired for mouse.
- Linux-only first release: the child sandbox requires bubblewrap (`bwrap`). Runtime tests
  that need the sandbox skip when `bwrap` is missing, and some also require the built
  bundle.

## Feature and acceptance checklist

Legend: `[x]` code exists and a test covers it (test file named), `[~]` code exists but no
test covers it, `[ ]` not implemented. Two `[ ]` items are not applicable in this fork
rather than pending; see their notes. Marks record code and test coverage only; they are
not visual parity evidence (see "Parity verification status").

### A. Fork identity and config isolation

- [x] `piConfig.name` set to `delegate-pi` (test/delegate-fork-config-isolation.test.ts).
- [x] `piConfig.configDir` set to `.delegate-pi` (test/delegate-fork-config-isolation.test.ts).
- [x] `bin` exposes the `delegate-pi` command (test/delegate-fork-distribution.test.ts).
- [x] Package `name` and dependency names preserved (test/delegate-fork-config-isolation.test.ts).
- [x] Runtime `APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME`, `ENV_AGENT_DIR` derived from `piConfig` (test/delegate-fork-config-isolation.test.ts).
- [x] Config paths (`getAgentDir`, `getSessionsDir`, `getSettingsPath`, `getAuthPath`) resolve under `~/.delegate-pi/agent` (test/delegate-fork-config-isolation.test.ts).
- [~] Root `package-lock.json` and `packages/coding-agent/install-lock/` updated to the renamed bin — both carry the `delegate-pi` bin, but no test asserts the lockfiles.

### B. Delegate tool (`src/extensions/delegate/tools.ts`)

The fork adds a third mode (`chain`, steps run in order with a `{previous}` placeholder)
and an extra schema field (`noProgressMs`) beyond the reference. The model cannot trust
project agents: the manager asks the user once for each project agent in a session.

- [x] Tool registered as `delegate` (test/delegate-ui.test.ts, test/delegate-delivery.test.ts).
- [x] Modes: single (`agent` + `task`) or parallel (`tasks` array, max 8); exactly one mode enforced — plus `chain` (test/delegate-tools.test.ts; the max-8 cap itself is not asserted).
- [x] Rejects calls that supply both or neither mode (test/delegate-tools.test.ts).
- [~] Rejects requests with an empty `agent` or empty `task` — enforced in `resolveMode`, no test asserts it.
- [ ] Rejects Claude (`claude` provider / host agents) children from a Claude Code host — not applicable: the host is `delegate-pi`, not Claude Code, and `claude` is a supported child provider. The equivalent protection, blocking nested delegation via `DELEGATE_DEPTH`, exists and is tested (delegate/tests/nested.test.ts).
- [x] Providers enumerated — the fork supports `pi`, `claude`, `codex`, `commandcode` (`delegate/core/providers.ts`; delegate/tests/tools.test.ts).
- [~] Child agents discovered from `delegate agents` and used as the schema enum — the `agents` CLI command and transport are tested (test/delegate-transport.test.ts, delegate/tests/config.test.ts), but the discovered names never reach the registered tool: `registerTools` runs once at extension load with the static default list and the `session_start` re-registration is a no-op. The schema uses a plain string with the agent list in the description, not an enum.
- [x] Input schema: `agent`, `task`, `tasks[]` (`agent`, `task`, `provider`, `model`, `scope`, ...), `provider`, `model`, `runtimeMode`, `scope`, `cwd`, `timeoutMs`, `background`, `waitMs`, `contextBudget` (test/delegate-tools.test.ts, exercised through `execute`).
- [~] `runtimeMode`: `full-access` or `approval-required` — a free-form string in the tool schema, defaulted to `approval-required` and validated in `delegate/core/core.ts` (codex cannot relay approvals); no test asserts the values.
- [x] `scope`: project paths the child may change; `["."]` = whole project, `[]` = read-only; overlapping scopes serialized via scope locks (delegate/tests/workspace.test.ts, delegate/tests/runtime.test.ts).
- [x] Default `timeoutMs` 15 minutes; `background` default true; `waitMs` default 300000 (test/delegate-tools.test.ts — default background and foreground wait are exercised; the 900000/300000 numbers are not asserted).
- [x] Single start via `start`, parallel start via `start-many` (test/delegate-transport.test.ts, delegate/tests/start-many.test.ts).
- [x] Returns the started task ids and a background `delegate-report` notice with the next tool result (test/delegate-tools.test.ts, test/delegate-delivery.test.ts).
- [x] Cancels children on abort when running in the foreground (test/delegate-manager.test.ts, "cancels known children when the signal aborts during start"; the foreground abort listener in `startForeground` is not separately tested).
- [~] Per-request `scope`/`provider`/`model` fall back to the call-level values — implemented by `overrides()` in `tools.ts`, no test asserts the fallback.

### C. `delegate_tasks` tool (`src/extensions/delegate/tools.ts`)

- [x] Registered as `delegate_tasks` (test/delegate-tools.test.ts, test/delegate-delivery.test.ts).
- [x] Actions: `wait`, `status`, `cancel`, `diff`, `accept`, `undo`, `prune` (default `status`), plus the fork-added `answer` and `models` (test/delegate-tools.test.ts).
- [x] `wait` blocks until children stop or `waitMs` elapses (default 120000, max 300000) (test/delegate-tools.test.ts, test/delegate-manager.test.ts; the still-running-after-timeout branch has no direct test).
- [x] `prune` removes old stopped task folders (`olderThan`, default `7d`) (test/delegate-tools.test.ts, delegate/tests/prune.test.ts).
- [x] `models` lists the models of all providers or one provider through the CLI `models` command (test/delegate-tools.test.ts, test/delegate-transport.test.ts, delegate/tests/models.test.ts).
- [x] `accept` keeps changes and frees the scope; `undo` restores the scope (`force` overwrites later edits) (delegate/tests/prune.test.ts, delegate/tests/workspace.test.ts).
- [x] `diff` returns the task diff (test/delegate-tools.test.ts, test/delegate-transport.test.ts).
- [~] `status` returns task detail and open questions — `detailText` returns the detail (test/delegate-tools.test.ts) but does not include the pending question text; pending questions surface only as the `asking` status.
- [~] Unknown actions fall back to `status` — replaced by a schema union of literals (unknown actions are rejected at validation) with a fall-through to refresh in `execute`; no test covers the fallback path.

### D. State, persistence, and session integration (`src/core/delegate/manager.ts`)

- [x] Plugin state: the reference's `tasks`/`calls` atoms map to session custom entries `delegate.tasks` and `delegate.calls`, plus a fork-added `delegate.reports` receipt entry (test/delegate-manager.test.ts, test/delegate-ui.test.ts).
- [x] `TaskView` and `CallView` shapes match `hosts/claude/types/` of the delegate repository at `3b8846d` — the fork is a superset: it adds `fullSummary`, `logPath`, `error`, `restored`; `CallView` is identical (envelopes round-trip in test/delegate-manager.test.ts, test/delegate-delivery.test.ts).
- [x] Task state persisted and merged incrementally; an entry is appended only when the state changed (test/delegate-manager.test.ts, "does not append a task entry when its state did not change").
- [x] Child processes read/written through the `delegate.mjs` CLI — resolved from the package dir (`delegate/core/delegate.mjs`) with `DELEGATE_DATA`/`DELEGATE_*` env, not the reference's `HOME`/`DELEGATE_PREFIX` lookup (test/delegate-transport.test.ts; real runtime in delegate/tests/runtime.test.ts and delegate/tests/bundled-sandbox.test.ts, gated on `bwrap`/bundle; packaging in test/delegate-fork-distribution.test.ts).
- [x] Follower polls `tasks/<id>/state.json`, refreshing via `status` every 20 ticks (`STATUS_EVERY = 20`) (test/delegate-transport.test.ts "polls the configured data directory"; tick loops in test/delegate-manager.test.ts and test/delegate-delivery.test.ts exercise the cadence indirectly).
- [x] Pending child questions surfaced to the user and answers routed back (permission + free-text) (test/delegate-manager.test.ts, test/delegate-delivery.test.ts, test/delegate-ui.test.ts).
- [x] Background completion produces a `delegate-report` notice delivered with the next tool result (test/delegate-delivery.test.ts). The "or prompt" channel (`before_agent_start`) has code but no test.
- [~] Open tasks resumed on `session.start` — `restore()` re-watches non-terminal tasks, but the reload tests cover only terminal tasks ("does not start a finished or stopped task again after a reload", test/delegate-delivery.test.ts); no test resumes a still-running task.

### E. Live activity UI (`delegate-band.ts`, `delegate-style.ts`)

Rendered as a Pi widget above the editor (`setWidget` placement `aboveEditor`), not a
Claude `Live` client module; row cap and preview room are computed from the widget width
and terminal height instead of `rows`/`room` props.

- [x] Band rendered for the TUI surface while tasks run, with row cap and preview room (test/delegate-ui.test.ts, test/delegate-band.test.ts).
- [x] 90 ms frame timer drives animation state (test/delegate-band.test.ts, `FRAME_INTERVAL_MS`).
- [x] Shimmer highlight over the agent name (test/delegate-band.test.ts, `shimmerCells`).
- [x] Comet track animation (`COMET_TRACK` = 14) (test/delegate-band.test.ts).
- [x] Glyph spinner and `queued` placeholder (`◌` / dotted track) (test/delegate-band.test.ts).
- [x] `asking` state renders `needs you` with a blinking `?` (test/delegate-band.test.ts).
- [x] Elapsed clock format (`Ns`, `NmSSs`) (test/delegate-band.test.ts).
- [x] Keyboard navigation (`down`/`j`, `up`/`k`, `enter`/`space` toggle) and pointer toggling (test/delegate-band.test.ts; Alt+D focus and escape wiring in test/delegate-ui.test.ts). Per the decision above, regular mode is keyboard-only; mouse is fullscreen-only.
- [x] Expanded rows show recent activity lines with the `⎿` prefix, or `no activity yet` (test/delegate-band.test.ts).
- [x] Width-aware truncation with `…` (test/delegate-band.test.ts).

### F. Renderers, commands, and events (`src/extensions/delegate/`)

- [~] Command `delegate-tasks` opens the tasks screen — `pi.registerCommand` wiring exists; the screen itself is tested directly but the command handler is not (test/delegate-ui.test.ts).
- [x] Tool call/result rendering for `delegate` and `delegate_tasks`, collapsed and expanded — the reference's `ui.render` `ToolUse`/`ToolResult` map to `registerTool` `renderCall`/`renderResult` (test/delegate-ui.test.ts).
- [x] Tool results collapse to one row (test/delegate-ui.test.ts, "keeps one collapsed row for a delegate call before and after completion").
- [x] Band above the editor renders live rows with a `+N more · /delegate-tasks` overflow line — the reference's `AbovePrompt` maps to `setWidget` above the editor (test/delegate-band.test.ts, test/delegate-ui.test.ts).
- [x] The `delegate-report` notice renders as a message with status marks — the reference's `UserMessage` renderer maps to `registerMessageRenderer` (test/delegate-ui.test.ts).
- [x] Full task list screen — the reference's `Pane` maps to a `ctx.ui.custom` screen listing all child tasks (test/delegate-ui.test.ts).
- [ ] `tool.check` auto-allows `delegate` and `delegate_tasks` — not applicable: Pi has no `tool.check`; the tools are registered via `registerTool` and run without a plugin approval gate, so no auto-allow code exists or is needed.
- [x] Status marks/labels per status (`MARKS` covers `starting`, `queued`, `running`, `waiting`, `completed`, `accepted`, `undone`, `blocked`, `failed`, `timed_out`, `cancelled`, `stopped`) (test/delegate-ui.test.ts, test/delegate-band.test.ts).
- [~] Terminal status set and `GOOD`/`STOPPED` groupings — `TERMINAL` and `STOPPED` are honored and tested (test/delegate-manager.test.ts, test/delegate-delivery.test.ts); `GOOD` is exported from `view.ts` and used by the renderers and the Claude Code band.
- [~] Turn tracking for notice delivery — the reference's `turn.start`/`turn.complete` map to the `tool_result` event (tested, test/delegate-delivery.test.ts) and `before_agent_start` (code, no test).
- [~] Pending reports injected as context before the next turn — the reference's `prompt.submit` maps to `before_agent_start` (`src/extensions/delegate/index.ts`); no delegate test covers it.
- [x] `session_start` restores state and resumes; tools and the command are registered once at extension load, not per session (test/delegate-ui.test.ts "recreates a usable manager after session shutdown and restart", test/delegate-delivery.test.ts reload tests).

### G. Providers, agents, and sandbox assumptions (`delegate/core/`)

- [x] Child providers `pi`, `claude`, `codex`, `commandcode` run in a fixed Linux filesystem sandbox (delegate/tests/tools.test.ts; sandbox mounting in delegate/tests/workspace.test.ts and delegate/tests/bundled-sandbox.test.ts, gated on `bwrap`). Linux-only first release per the decision above.
- [x] `.git` is read-only for children; scope governs write access (delegate/tests/workspace.test.ts, "sandbox mounts: scope writable, rest and .git read-only, scratch discarded", gated on `bwrap`).
- [x] Read-only tasks run when no scope is given (delegate/tests/bundled-sandbox.test.ts runs children with an empty-scope layout; gated on `bwrap` and the built bundle).
- [x] The tool text names no preferred agent; the model picks from the ready agents. `delegate-ui.test.ts` asserts it.
- [x] Model discovery: `delegate models [--provider P] [--refresh] [--text]` discovers pi, Codex and
  Command Code models from their CLIs, keeps fixed Claude aliases, caches results in
  `models/<provider>.json` under the data dir for 24 hours, and `checkModel` rejects an unknown
  model at task start when discovery succeeds (delegate/tests/models.test.ts).
- [x] Scopes may name files or folders that do not exist yet; `prepareScope` creates their parent
  folders and the sandbox mounts make them writable (delegate/tests/workspace.test.ts).
- [x] Bundled agents: `pi-scout`, `pi-worker` (pi), `cc-scout`, `cc-worker`
  (Claude), `cx-worker` (Codex), `cmd-worker` (Command Code).

## Parity verification status

A manual tmux check ran on 2026-10-30 (110x40 terminal, source build through `pi-test.sh`,
parent model `zai/glm-5.3`, two parallel `scout` children on `zai/glm-5.3-flash`). The rows
were compared as text with the reference sources, not with side-by-side Claude captures.

Matched the reference:

- Band: one row per child with spinner glyph, comet track, clock and latest activity; the
  `?` mark and `needs you` while a child waits for permission.
- `alt+d` focuses the band, `down` moves, `enter` expands a row to its recent `⎿` actions; the
  selected name is underlined.
- Permission dialog names the tool and its arguments; the answer reaches the child.
- Collapsed call row: `◌ started scout in the background` while open, then
  `✓ delegated ✓ scout ✓ scout 1m15s`.
- `delegate_tasks` row: `· wait all tasks`; its collapsed result is empty.

Fixed during the check:

- Session state entries rendered as `· delegate N active / N tasks` rows in the transcript.
- The call row showed `✗ running` when one child failed and another still ran.
- The collapsed `delegate_tasks` result printed the raw `<delegate-report>` text.

Still open:

- No pixel or colour comparison against Claude captures in the same terminal and font.
- Resize, narrow widths, and session reload were checked only by unit tests.
- Mouse is fullscreen-only by decision.
