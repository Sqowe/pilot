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

## Build

The extension imports from `src/shared/`, so it is bundled into a self-contained
directory before installation.

**Prerequisites:** Node ≥ 22 with dependencies installed (`npm install` from the
repo root).

```sh
# From the repo root
npm run build:pi-extension
```

Defined in `package.json`; runs [`scripts/build-pi-extension.mjs`](../../scripts/build-pi-extension.mjs),
which uses esbuild to bundle the extension — inlining `src/shared/bash-restrictions/`
— into:

```
dist-pi-extensions/bash-restrictions/
├── index.js      (bundled ESM)
└── package.json  ({ "type": "module", "pi": { "extensions": ["./index.js"] } })
```

`@earendil-works/*`, `typebox`, and Node built-ins are left external — `pi`
provides them at load time, so the bundle stays small and version-safe. The
output directory is gitignored.

---

## Install

Build first (above), then copy the whole directory into pi's extensions folder:

```sh
cp -r dist-pi-extensions/bash-restrictions ~/.pi/agent/extensions/

# then, inside pi:
/reload          # or restart pi
```

> **Why a directory, not a loose file?** pi only auto-discovers `*.ts` / `*.js`
> files, a subdirectory with `index.ts`/`index.js`, or a directory whose
> `package.json` declares a `pi.extensions` manifest. A loose `.mjs` file is
> **not** discovered. Shipping a directory with a manifest also lets the local
> `"type": "module"` mark `index.js` as ESM.

### Quick try without installing (no build needed)

```sh
pi -e ./pi-extensions/bash-restrictions/extension.ts
```

`pi` loads the TypeScript entry point directly via `jiti`, so no build step is
needed for a one-off trial.

---

## Configure

The extension reads up to two optional config files and **unions** them:

| Scope   | Path                                 |
| ------- | ------------------------------------ |
| Global  | `~/.pi/agent/bash-restrictions.json` |
| Project | `<cwd>/.pi/bash-restrictions.json`   |

> The `.pi` directory name follows pi's configured config dir (`CONFIG_DIR_NAME`),
> so rebranded pi distributions use their own name automatically; it falls back
> to `.pi`.

> **JSONC is supported.** Like pi's own configs, these files may contain `//` and
> `/* */` comments and trailing commas — so the commented example below can be
> copied verbatim. Files that fail to parse are silently ignored (treated as
> absent), so a stray syntax error leaves the gate inactive rather than erroring.

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

### Paths, quotes & backslashes (Windows)

Pattern entries are ordinary JSON strings, so characters that are special in
JSON must be escaped. This matters most for Windows-style paths:

| Character          | Write in JSON as | Example                           |
| ------------------ | ---------------- | --------------------------------- |
| `"` (double quote) | `\"`             | a quoted path argument            |
| `\` (backslash)    | `\\`             | Windows paths like `C:\Users\...` |
| `:` and `/`        | as-is            | no escaping needed                |

So `cd "C:/Users/you/projects/app"` is written as:

```jsonc
{ "trusted": ["cd \"C:/Users/you/projects/app\""] }
```

and the backslash form `cd "C:\Users\you\projects\app"` as:

```jsonc
{ "trusted": ["cd \"C:\\Users\\you\\projects\\app\""] }
```

**Matching is literal — including quotes.** A `trusted` prefix is matched
against the raw command text (only `*` is a wildcard), so the entries above
match **only** when the agent quotes the path exactly the same way. If it runs
the command unquoted, they won't match. Wrap the variable part in `*` to accept
either form:

```jsonc
{ "trusted": ["cd *C:/Users/you/projects/app*"] } // matches quoted or unquoted
```

### Merge rules

- `trusted` and `denied` → **union** of global ∪ project, deduped
  (global entries first). Per-project tightening is done by _adding_ denials.
- `permissionTimeoutSeconds` → project value if the key is present, else global,
  else the shared default (`300`).

For example, a global file plus a trusted project file:

```jsonc
// ~/.pi/agent/bash-restrictions.json   (global)
{ "trusted": ["ls *", "git status*"], "denied": ["rm"] }

// <cwd>/.pi/bash-restrictions.json     (project)
{ "trusted": ["npm run *"], "denied": ["git push"] }
```

are evaluated against the merged result:

```jsonc
{ "trusted": ["ls *", "git status*", "npm run *"], "denied": ["rm", "git push"] }
```

A project can only **add** entries — it can't drop the global `rm` denial or
otherwise loosen a global rule. (If the project isn't trusted, its file is
skipped entirely and only the global lists apply.)

### Project trust

The **project** file (`<cwd>/.pi/bash-restrictions.json`) is honored only when
pi reports the project as trusted (`ctx.isProjectTrusted()`). An untrusted
project's file is ignored, so it cannot widen `trusted` to auto-allow dangerous
commands or otherwise loosen the gate — only the **global** file applies there.
If trust state is unavailable, the extension fails closed (treats the project as
untrusted).

### Wildcards & blanket trust

`*` is the only wildcard in a `trusted` pattern, and a bare `"*"` compiles to
`^.*` — it matches **every** command. So `"trusted": ["*"]` opts the gate in and
**auto-allows all bash** without a prompt. Two things still force a prompt even
then:

- **Denylist hits.** The `denied` list (global ∪ project) is checked first, so a
  denied pattern still sends the command to **ask** — `"*"` cannot override it.
- **Unsupported shell syntax.** Command substitution `$(...)`, backticks,
  newlines, a background `&`, subshells `(...)`, and process substitution `<(...)`
  fail closed to **ask**.

In a **project** file, `["*"]` obeys the **Project trust** rule above: an
untrusted project's `["*"]` is ignored (only the global config applies), so a
project cannot self-authorize blanket trust. Prefer specific prefixes
(`"npm run *"`, `"git status*"`) over `"*"`; if you do use `"*"`, pair it with a
strong **global** `denied` list — the one layer a project's `"*"` can't loosen.

### Reload

Config is read on `session_start` (using the session's `cwd`), which also fires
on `/reload`, `/new`, `/resume`, and `/fork`. After editing a JSON file, run
`/reload` in `pi` (or restart) to pick up the change. There is no file watcher.

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
