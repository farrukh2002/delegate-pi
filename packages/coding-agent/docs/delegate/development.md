# Delegate Pi fork: local development and distribution

How to build, run, update-safely, and roll back the **Delegate Pi** fork. See
[README.md](./README.md) for provenance and the feature/parity checklist.

## Sync with the delegate repository

The child runtime under `packages/coding-agent/delegate/` is a copy of the
[delegate tool](../../../..). Every file in `core/`, `tests/` and `agents/` is byte-identical
to the delegate repository. Fork behavior (bundled agents, the pi entry mount, the
`.delegate-pi` config dir) comes from `DELEGATE_*` environment variables that
`src/core/delegate/config.ts` sets, not from changed files. Make a runtime change in the
delegate repository first, then copy it here. Check for drift after delegate-repository work:

```sh
npm run check:delegate-sync              # compare against the delegate checkout
DELEGATE_REPO=/path/to/delegate npm run check:delegate-sync
npm run check:delegate-sync -- --accept  # record a new baseline after a real sync
```

The check fails when a file differs, when a file exists on one side only, or when
the delegate repository has commits newer than the recorded baseline (then port the changes
and run with `--accept`).

## Upstream revision

- Upstream project: `earendil-works/pi`, release `v1.4.0`.
- Upstream commit: `4a080252f06caf63a525d7873c5d94d3c23887e0` (`Release v1.4.0`).
- The fork keeps the upstream package name `@earendil-works/pi-coding-agent` and every
  workspace dependency name. Only the distribution identity changes.

`packages/coding-agent/package.json` sets the fork identity:

- `piConfig.name` = `delegate-pi`
- `piConfig.configDir` = `.delegate-pi`
- `bin` = `{ "delegate-pi": "dist/bundle/cli.js" }`

`src/config.ts` derives `APP_NAME` = `delegate-pi`, `CONFIG_DIR_NAME` = `.delegate-pi`, and the
shell-safe env prefixes `DELEGATE_PI_CODING_AGENT_DIR` / `DELEGATE_PI_CODING_AGENT_SESSION_DIR`.
User state lives under `~/.delegate-pi/agent`, not `~/.pi`.

## Build and platform requirements

- **Linux with `bwrap` (bubblewrap).** Delegate children always run inside the mandatory
  filesystem sandbox; `core.start` calls `executable("bwrap")` and fails without it. There is no
  sandbox bypass.
- **Offline model data must be hydrated.** `packages/ai/src/providers/data/` is gitignored, so a
  clean checkout has no model catalog. Before an offline build or run, hydrate it:

  ```sh
  npm install --ignore-scripts
  npm run hydrate:model-data   # or: npm run build:offline
  ```

  `npm run build` regenerates model data from the network; use it only when network access is
  available.

## Local dev command

`scripts/delegate-pi-dev.mjs` runs the **already built** bundle. It works from any working
directory, forwards your arguments, and runs `delegate-pi` against the current project:

```sh
node scripts/delegate-pi-dev.mjs --version
node scripts/delegate-pi-dev.mjs --help
```

The launcher only spawns `packages/coding-agent/dist/bundle/cli.js` with `process.execPath`. It
never builds, downloads, or installs anything, and it exits with a rebuild instruction if the
bundle is missing. Build it yourself first with `npm run build`.

## Questions and typed answers

The built-in `ask_user` tool waits for a user answer. Its prompt rules tell the model to use
it instead of a normal chat question when an answer is needed to proceed. These rules guide
the model; they do not force it to call the tool.

A question without choices opens a text field. A question with choices includes
**Other — type your answer**. Press `1` through `9` to select the matching choice immediately,
or use arrow keys and Enter. The shortcut for **Other** opens a text field, where number keys
enter text normally. The [dialog shortcuts](../keybindings.md#dialog-choices) are configurable.
The original timeout covers both steps; switching to text input does not restart it. Cancel either step to dismiss
the question. A dismissed question is not approval for an action that needs confirmation.

Delegate child questions use the same controls. Permission requests keep their separate
confirmation dialog. The controls work in terminal and RPC modes.

The fork loads user extensions from `~/.delegate-pi/agent/extensions`, not
`~/.pi/agent/extensions`. An older `question` extension in the upstream Pi directory does not
load in the fork unless explicitly configured. If both tools are configured, disable the
older extension in the fork's `settings.json` with an exact exclusion:

```json
{
  "extensions": ["-/absolute/path/to/question.ts"]
}
```

## Install and uninstall

`scripts/delegate-pi-install.mjs` installs a user-level launcher without npm. It writes a small
`sh` script to `~/.local/bin/delegate-pi` that `exec`s `node` on the absolute bundle path, so the
launcher works from any directory but breaks if the checkout or the built bundle moves:

```sh
node scripts/delegate-pi-install.mjs            # install (the default command)
node scripts/delegate-pi-install.mjs doctor
node scripts/delegate-pi-install.mjs uninstall
```

`install` requires Linux with `bwrap` on PATH and an already built
`packages/coding-agent/dist/bundle/cli.js`. Like the dev launcher it never builds, downloads, or
runs npm install; with no bundle it exits with `run npm run build first`. It refuses to overwrite
an existing `~/.local/bin/delegate-pi` that is not ours (detected by a marker line in the
launcher) unless `--force` is given. Any previous launcher is backed up to
`~/.local/bin/delegate-pi.bak` before it is overwritten.

`uninstall` removes only a launcher that carries the marker, then restores the `.bak` rollback
copy if one is present. User state in `~/.delegate-pi` is always kept unless `--purge` is passed.

`doctor` prints the node version, the `bwrap` path, the bundle path and version (by running the
bundle with `--version`), launcher and backup status, and whether `~/.delegate-pi` exists, and it
warns when the bin directory is not on PATH. `--prefix <dir>` overrides the bin directory, which
lets tests install into a temporary directory instead of `~/.local/bin`. `--name <command>` sets
the launcher name (default `delegate-pi`), for example `--name pi2` to keep an upstream `pi` beside
the fork; pass the same `--name` to `doctor` and `uninstall`.

## Update and self-update guard

`delegate-pi update` and `delegate-pi update --self` must never fetch or install the published
package over this fork. `getForkedSelfUpdateInstruction` in `src/config.ts` blocks the self-update
branch in `src/package-manager-cli.ts` before any registry request or package-manager install, and
prints an actionable local rebuild instruction instead. Official Pi (`APP_NAME` = `pi`) is
unchanged, and plugin/extension paths (`update --extensions`, `update <source>`, `update --models`)
still run.

The npm package names are deliberately unchanged, so this fork **must not be published** to the
public registry.

## Command Code child auth

The `commandcode` child provider is pre-authenticated from the host by copying
`~/.commandcode/auth.json` and `~/.commandcode/providers.json` into the sandbox home. Run
`commandcode` login once on the host before delegating to a `commandcode` agent such as
`cmd-worker`. Other providers read `~/.claude/.credentials.json`,
`~/.codex/auth.json`, and `~/.delegate-pi/agent/auth.json` + `models.json` respectively.

## Rollback

Nothing is removed automatically. To return to upstream Pi, revert only the fork identity and
safeguard changes you no longer want:

- Restore `piConfig`, `bin`, `ENV_PREFIX`, the self-update guard, and the `files` whitelist in
  `packages/coding-agent/package.json` and `src/config.ts` / `src/package-manager-cli.ts`.
- Delete `scripts/delegate-pi-dev.mjs` and this `docs/delegate/` directory if the fork docs are not
  wanted.

## Remaining visual parity gate

All UI and runtime parity items in [README.md](./README.md) sections B through G are still
**pending**. There are no rendered captures, screenshots, or terminal transcripts for the Delegate
Pi UI, so nothing may be cited as visual evidence. The remaining gate is to run a built fork and
re-verify each pending item before any of them is marked complete.
