# pi bash-restrictions extension

A drop-in [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
extension that brings Open Cowork's bash **trust / denylist** restriction engine
to the standalone `pi` coding CLI.

It layers on top of `pi`'s own permission flow via the public `tool_call` event:
before the agent's `bash` tool runs, the command is evaluated against your
trusted-prefix and denylist patterns. Trusted commands run without a prompt;
anything else asks (interactively) or is blocked (headless).

- **Shared engine.** The decision logic and settings schema are the exact same
  modules the Electron app uses (`src/shared/bash-restrictions/`). Behaviour
  stays in lock-step across both hosts.
- **Agent bash only.** Only the LLM-invoked `bash` tool is gated. Your own
  `!` / `!!` (`user_bash`) commands are never intercepted.
- **Fail-closed.** No UI, a dialog error, a timeout, or any internal error all
  resolve to **block**, never to a silent allow.

For the full semantics of the engine (sub-command splitting, word-boundary
denylist matching, the shell-syntax guard, pipelines), see
[BASH_COMMAND_RESTRICTIONS.md](../../BASH_COMMAND_RESTRICTIONS.md) — this
extension reuses that engine unchanged.

---

## Install

The extension imports from `src/shared/`, so it must be bundled into a single
self-contained file before installation.

```sh
# From the repo root
npm run build:pi-extension
# → dist-pi-extensions/bash-restrictions.mjs

# Install globally for pi
cp dist-pi-extensions/bash-restrictions.mjs ~/.pi/agent/extensions/

# then, inside pi:
/reload          # or restart pi
```

`@earendil-works/*`, `typebox`, and Node built-ins are left external — `pi`
provides them at load time, so the bundle stays small and version-safe.

### Quick try without installing

```sh
pi -e ./pi-extensions/bash-restrictions/extension.ts
```

`pi` loads the TypeScript entry point directly via `jiti`, so no build step is
needed for a one-off trial.

---

## Configure

The extension reads up to two optional JSON files and **unions** them:

| Scope   | Path                                 |
| ------- | ------------------------------------ |
| Global  | `~/.pi/agent/bash-restrictions.json` |
| Project | `<cwd>/.pi/bash-restrictions.json`   |

```jsonc
// .pi/bash-restrictions.json
{
  // Prefix patterns, `*` = wildcard, case-insensitive. Matching commands run
  // without a prompt. NOTE: `ls *` compiles to `^ls .*`, so it matches
  // `ls -la` but NOT bare `ls` — include an argument or add `ls` separately.
  "trusted": ["ls *", "cat *", "npm run *", "git status*"],

  // Substring patterns, word-boundary, case-insensitive. Always prompt, even
  // if the command also matches a trusted pattern. Denylist beats trust.
  "denied": ["rm", "--force", "sudo", "git push"],

  // Permission-dialog timeout in seconds.
  //   0          → wait forever (no timeout)
  //   positive   → clamped to [10, 3600]; default 300 (5 min)
  // On timeout the dialog auto-denies (fail-closed).
  "permissionTimeoutSeconds": 300,
}
```

### Merge rules

- `trusted` and `denied` → **union** of global ∪ project, deduped
  (global entries first). Per-project tightening is done by _adding_ denials.
- `permissionTimeoutSeconds` → project value if the key is present, else global,
  else the shared default (`300`).

### Reload

Config is read **once** at extension load (startup). After editing a JSON file,
run `/reload` in `pi` (or restart) to pick up the change. There is no file
watcher — this matches the app's startup-hydration model.

### Opt-in

When **both** lists are empty (no config files, or only a timeout set), the gate
is **inactive** and every `bash` call defers to `pi`'s own approval flow. The
engine only takes over once you add at least one `trusted` or `denied` entry.

---

## Behaviour

| Situation                                   | Result                                        |
| ------------------------------------------- | --------------------------------------------- |
| All sub-commands trusted, no denylist hit   | **allow** — runs without a prompt             |
| Denylist hit / not trusted / unknown syntax | **ask** (interactive) or **block** (headless) |
| Lists empty (not opted in)                  | defer to `pi` (no opinion)                    |

Interactive `ask` shows a `select` dialog mirroring the app's permission dialog:

| Choice                         | Effect                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- |
| **Allow once**                 | Command runs (`undefined` returned to `pi`).                           |
| **Deny**                       | Blocked. Model sees `User denied permission for 'bash'.`               |
| **Deny & suggest alternative** | Prompts for free text; the suggestion is appended to the block reason. |
| Timed out / dismissed          | Blocked (auto-deny).                                                   |

Headless (`!ctx.hasUI`), a dialog error, or any internal error → **block**.

---

## Manual e2e checklist

With a project config such as:

```jsonc
// .pi/bash-restrictions.json
{ "trusted": ["ls *", "echo *"], "denied": ["rm"], "permissionTimeoutSeconds": 15 }
```

Run `pi -e ./pi-extensions/bash-restrictions/extension.ts` and have the agent
attempt each command:

| Command            | Expected                                                      |
| ------------------ | ------------------------------------------------------------- |
| `ls -la`           | **allow** — runs without a prompt                             |
| `rm -rf x`         | **ask** → Deny blocks it (denylist `rm`)                      |
| `echo $(rm -rf /)` | **ask/block** — command substitution trips the syntax guard\* |
| (no response 15s)  | **auto-deny** after the configured timeout                    |

\* `echo $(rm -rf /)` is **never executed** — the gate decides before `pi` runs
anything, and the syntax guard forces a prompt for any `$(...)`. It is only ever
inert text driving the decision.

---

## Tests

- `tests/pi-bash-extension-config.test.ts` — config loader (merge, malformed
  files, path resolution).
- `tests/pi-bash-extension-mapping.test.ts` — `resolveBashToolCall` decision →
  result + timeout plumbing (engine stubbed).
- `tests/pi-bash-extension.e2e.test.ts` — full chain config file → loader →
  engine → mapper with real temp files (no `pi` process).
- `tests/pi-bash-extension-build.test.ts` — the bundle builds and is importable.
