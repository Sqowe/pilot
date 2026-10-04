# File-Tool Path Permissions (Workspace Zone) — Implementation Plan

**Status:** Superseded in part by [trusted-directories.md](trusted-directories.md) (2026-10-03).
Not implemented.
**Date:** 2026-06-19
**Owner:** @obodnikov
**Related:** [pi-bash-restrictions-extension.md](archive/pi-bash-restrictions-extension.md), [path-containment.ts](../../src/main/tools/path-containment.ts), [permission-rules-store.ts](../../src/main/config/permission-rules-store.ts), [config-store.ts](../../src/main/config/config-store.ts), [agent-runner.ts](../../src/main/claude/agent-runner.ts), `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

---

> ## Superseded in part — 2026-10-03
>
> [trusted-directories.md](trusted-directories.md) is now the plan to implement. It keeps this
> document's shared path module, tool-agnostic dialog and project-trust rule, and changes three
> things: the settings model (one `trustedDirectories` list in the bash-restrictions settings
> instead of a separate `path-permissions.json`), the first-version scope (`write` and `edit`
> only; the read family is deferred), and bash writes (now in scope, no longer a non-goal).
> Its §12 maps every part of this document to what replaced it. Read this one for background,
> not as the specification.

---

## 1. Goal

Add a **two-zone permission policy for the built-in file tools**: auto-allow operations whose
target path is **inside the workspace** (or the OS temp dir), and **ask** for anything
**outside**. This applies to **both** hosts — the Electron app and the standalone `pi` CLI
extension — driven by one shared, pure decision engine, mirroring the
[bash-restrictions](archive/pi-bash-restrictions-extension.md) architecture.

Concretely: "give the agent free rein under the current workspace, but prompt before it
touches files elsewhere."

### Why both hosts, one engine

The app already gates tools through `decidePermission`; the `pi` extension gates through the
`tool_call` event. A single shared `decidePathPermission` keeps behavior identical across both
and makes future changes a one-place edit — the same single-source-of-truth principle proven
in the bash work (Phases 1–2 there).

### Non-goals

- Confining **bash**-tool reads/writes (`cat`, `cp`, `>` redirection). Those remain the
  [bash engine's](archive/pi-bash-restrictions-extension.md) job via its denylist. This feature governs
  the **dedicated file tools** only.
- A full sandbox / OS-level jail. `PathGuard` ([path-guard.ts](../../src/main/sandbox/path-guard.ts))
  already does hard sandbox containment; this is a softer, always-on **ask** boundary that works
  without sandbox mode (which is disabled by default).
- Per-file ACLs or glob-based allow/deny lists. The axis here is purely **inside vs outside**.

---

## 2. Locked decisions

| #   | Decision              | Resolution                                                                                                                                                                                                                                                                                            |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Gated tools           | **All path-bearing file tools.** Extension: `read, write, edit, grep, find, ls`. App: same **+ `glob`** (app-only tool — `pi` folds globbing into `find`).                                                                                                                                            |
| 2   | Zones                 | `inside` = workspace root **∪ OS temp dir** (both `realpath`-resolved) **∪** user `extraAllowedRoots`; `outside` = everything else.                                                                                                                                                                   |
| 3   | Outside action        | **Ask** — routed through the universal deny-and-suggest + timeout dialog (decision #4). `deny` is available per config but defaults to `ask`.                                                                                                                                                         |
| 4   | Dialog                | **Universal / tool-agnostic.** One `presentAsk(toolName, summary, ctx, settings)` shared by the bash engine _and_ this path engine. Matches the app's `PermissionDialog`, which is already tool-agnostic.                                                                                             |
| 5   | Trigger               | **Opt-in.** Disabled → today's behavior is untouched (read=allow, write/edit=ask, search family=allow).                                                                                                                                                                                               |
| 6   | Precedence            | When enabled, the path-zone decision is **authoritative for file tools** — consulted before session "allow always" memory and the generic `PermissionRule[]`, exactly like the bash engine.                                                                                                           |
| 7   | Module                | New sibling shared module **`src/shared/path-permissions/`** (engine + settings); `isPathWithinRoot` relocates here and is re-exported from its old home.                                                                                                                                             |
| 8   | Extension cwd + trust | Extension reads workspace root from **`ctx.cwd`** (on `session_start`), not `process.cwd()`. The project-local `path-permissions.json` is honored **only when `ctx.isProjectTrusted()`** (fail closed). Config-dir name comes from the SDK's **`CONFIG_DIR_NAME`** (fallback `.pi`), never hardcoded. |

---

## 3. Why this is tractable (existing infrastructure)

| Need                            | Already exists                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Path containment primitive      | `isPathWithinRoot(path, root, isWindows?)` — [path-containment.ts:13](../../src/main/tools/path-containment.ts) (pure; used by sandbox, path-guard, workspace prompt).                                                                           |
| Symlink-safe re-check pattern   | [workspace-system-prompt.ts:93-103](../../src/main/utils/workspace-system-prompt.ts) (`realpath` + re-test containment).                                                                                                                         |
| Workspace root at decision time | App: `sessionCwdMap` via `setSessionCwd` ([permission-rules-store.ts](../../src/main/config/permission-rules-store.ts)); the hook also carries a live `cwdRef`. Extension: `ctx.cwd` captured on `session_start` (NOT `process.cwd()` — see §8). |
| Path extraction                 | Uniform `input.path` across all pi file tools; app already has `extractReadFilePath`.                                                                                                                                                            |
| Tool input shapes (verified)    | `read.path`/`write.path`/`edit.path` required; `grep.path`/`find.path`/`ls.path` optional (default cwd); **both** `find` and `grep` expose `pattern` **and** `glob` filters under `path`.                                                        |

What's missing is only the **decision wiring** and the **settings**.

---

## 4. Target layout

```
open-cowork/
├── src/
│   ├── shared/
│   │   └── path-permissions/
│   │       ├── containment.ts     # isPathWithinRoot (relocated; pure)
│   │       ├── engine.ts          # pure classifier + fs-aware resolver + decidePathPermission
│   │       ├── settings.ts        # canonical PathPermissionsSettings + normalizers
│   │       └── index.ts           # public re-exports
│   ├── main/
│   │   ├── tools/path-containment.ts     # re-exports isPathWithinRoot from shared (import paths unchanged)
│   │   ├── config/
│   │   │   ├── permission-rules-store.ts # + file-tool branch in decidePermission; + path-settings cache
│   │   │   └── config-store.ts           # + path-permission fields, normalizers from shared
│   │   └── claude/agent-runner.ts        # (no change — decidePermission already consulted in the hook)
│   └── renderer/components/settings/
│       └── SettingsFilePermissions.tsx   # NEW settings panel (enable, outside action, extra roots)
├── pi-extensions/
│   └── bash-restrictions/                # SHARED extension package (see §8 — universal dialog)
│       ├── extension.ts          # resolveToolCall + presentAsk (tool-agnostic)
│       ├── path-config.ts        # loads .pi/path-permissions.json via shared sanitizer
│       └── …                     # (bash-config.ts etc. from the bash plan)
└── tests/
    ├── path-permissions-engine.test.ts     # phase 1 (pure classifier + resolver)
    ├── path-permissions-settings.test.ts   # phase 1 (normalizers)
    ├── path-permissions-decide.test.ts     # phase 2 (app decidePermission integration)
    ├── pi-path-extension-config.test.ts     # phase 4 (extension config loader)
    ├── pi-permission-dialog.test.ts         # phase 4 (universal presentAsk, tool-agnostic)
    └── path-permissions.e2e.test.ts         # phase 6 (integration/e2e)
```

> The extension lives **alongside the bash extension** (same package), because the universal
> dialog (§8) is shared. They bundle into one extension file.

---

## 5. Shared module surface (`src/shared/path-permissions/`)

Split into a **pure** classifier (trivially unit-testable) and an **fs-aware** resolver.

### `containment.ts` (relocated, pure)

```ts
export function isPathWithinRoot(path: string, root: string, isWindows?: boolean): boolean;
```

Moved verbatim from [path-containment.ts](../../src/main/tools/path-containment.ts). The old
file becomes `export { isPathWithinRoot } from '../../shared/path-permissions/containment'` so
every existing importer (sandbox-tool-executor, tool-executor, path-guard, workspace-system-prompt,
sandbox-sync) is unchanged. (The lima-agent's own copy under `src/main/sandbox/lima-agent/` is a
separate bundled build — left alone.)

### `engine.ts`

```ts
export type PathZone = 'inside' | 'outside';
export type PathDecision = 'allow' | 'ask' | 'deny' | null;

export interface PathPolicy {
  outsideAction: 'ask' | 'deny'; // inside is always 'allow'
}
export interface ResolveContext {
  cwd: string | undefined; // workspace root
  allowedRoots: string[]; // already includes temp dir when enabled
  isWindows: boolean;
}

/** PURE: classify an already-resolved absolute realpath against resolved roots. */
export function classifyZone(
  resolvedPath: string,
  resolvedRoots: string[],
  isWindows: boolean
): PathZone;

/** PURE: map a zone to a decision. inside → allow; outside → policy.outsideAction. */
export function decideForZone(zone: PathZone, policy: PathPolicy): PathDecision;

/** Extract the path(s) to classify for a given tool + input (see §6). */
export function extractToolPaths(toolName: string, input: Record<string, unknown>): string[];

/** fs-AWARE orchestrator: resolve relative→abs against cwd, realpath the existing portion,
 *  realpath roots, classify, decide. Returns null when the feature can't/shouldn't decide
 *  (no cwd, degenerate root, tool not gated). */
export function decidePathPermission(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ResolveContext,
  policy: PathPolicy
): PathDecision;

export const FILE_TOOLS_EXTENSION: ReadonlySet<string>; // read, write, edit, grep, find, ls
export const FILE_TOOLS_APP: ReadonlySet<string>; // + glob
```

### `settings.ts` (canonical — parity mechanism)

```ts
export interface PathPermissionsSettings {
  enabled: boolean; // default false (opt-in)
  outsideAction: 'ask' | 'deny'; // default 'ask'
  includeTempDir: boolean; // default true
  extraAllowedRoots: string[]; // default []  (absolute paths)
}
export const DEFAULT_PATH_PERMISSIONS_SETTINGS: Readonly<PathPermissionsSettings>;

export function sanitizeExtraRoots(input: unknown): string[]; // abs paths only, trimmed, deduped
export function sanitizePathPermissionsSettings(raw: unknown): PathPermissionsSettings;
```

---

## 6. Path extraction & resolution (the careful part)

### Per-tool extraction (`extractToolPaths`)

| Tool                    | Path(s) classified                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`, `write`, `edit` | `input.path` (required)                                                                                                                                                                                                       |
| `ls`                    | `input.path ?? cwd` (omitted → cwd → inside → allow)                                                                                                                                                                          |
| `grep`, `find`          | `input.path ?? cwd`, **plus** the static root of any absolute pattern. Verified: **both** `find` and `grep` expose **both** `pattern` and `glob` fields, so check both on both tools (not just `find.pattern` / `grep.glob`). |
| `glob` (app)            | the static root of `input.pattern` (and `input.path`/`input.cwd` if present) — **verify exact field names in [tool-executor.ts:703](../../src/main/tools/tool-executor.ts) during Phase 2**                                   |

**Absolute-pattern hardening:** a search rooted at cwd can still escape via an absolute glob
(`find pattern="/etc/**"`). `extractToolPaths` therefore also yields the literal prefix of any
**absolute** `pattern` **or** `glob` value (the dirname up to the first wildcard), for both
`find` and `grep`. If _any_ extracted path is `outside`, the whole call is `outside`.

### Resolution order (in `decidePathPermission`)

1. **Gate:** tool not in the gated set, or `cwd` undefined → return `null` (defer).
2. **Degenerate-root guard:** if `realpath(cwd)` is the filesystem root or the user's home dir →
   the workspace is too broad to be meaningful → return the **outside** decision for any path
   (i.e., everything asks) rather than auto-allowing the world. (Configurable: could instead
   disable; default is fail-safe = ask.)
3. **Build allowed roots:** `[realpath(cwd)]` + (`includeTempDir` ? `[realpath(os.tmpdir())]` : `[]`)
   - `extraAllowedRoots.map(realpath)`. **macOS note:** `os.tmpdir()` is `/var/folders/…` which
     symlinks to `/private/var/…`; resolving both sides is mandatory or temp writes read as outside.
4. **For each extracted raw path:**
   - `abs = path.resolve(cwd, raw)` (handles relative + `..`).
   - `real = realpathExistingPortion(abs)` — resolve symlinks on the longest existing ancestor
     (the file itself may not exist yet for `write`); rejects symlink-escape.
   - `classifyZone(real, roots, isWindows)`.
5. **Combine:** any `outside` → `outside`; else `inside`. Then `decideForZone`.

### Case sensitivity / Windows

`isPathWithinRoot` already takes `isWindows`. On macOS (case-insensitive default) compare
case-folded, consistent with `sandbox-tool-executor`'s existing approach. The resolver passes
`process.platform === 'win32'`.

---

## 7. App integration

### `decidePermission` (permission-rules-store.ts)

Add a file-tool branch after the bash branch (~line 520), before MCP / session-memory / generic
rules:

```ts
if (FILE_TOOLS_APP.has(lowered) && pathPermissionsSettings.enabled) {
  const cwd = sessionCwdMap.get(sessionId);
  const decision = decidePathPermission(
    lowered,
    input,
    {
      cwd,
      allowedRoots: buildAllowedRoots(cwd, pathPermissionsSettings),
      isWindows: process.platform === 'win32',
    },
    { outsideAction: pathPermissionsSettings.outsideAction }
  );
  if (decision) return decision; // allow/ask/deny authoritative; null falls through
}
```

### Settings cache + hydration (mirror the bash lists)

- `setPathPermissionSettings(raw)` / `getPathPermissionSettings()` in the store, sanitized via
  the shared `sanitizePathPermissionsSettings`.
- Hydrate from `configStore` on startup and on `settings.update` IPC — copy the exact pattern the
  bash trust/deny lists use ([config-store.ts](../../src/main/config/config-store.ts) +
  `main/index.ts` IPC handler).

### config-store fields

Add `pathPermissions: PathPermissionsSettings` (or flat fields) to the persisted config, with the
shared normalizer applied at load and update — same shape as the bash settings.

---

## 8. Extension integration — universal dialog (remark #1)

This **generalizes** the bash extension's `resolveBashToolCall`
([bash plan §6](archive/pi-bash-restrictions-extension.md)) into a tool-agnostic resolver + a shared
presentation function. **The bash plan's §6 should be updated to consume `presentAsk`.**

```ts
// pi-extensions/bash-restrictions/extension.ts
import { decideBashPermission } from '../../src/shared/bash-restrictions';
import { decidePathPermission, FILE_TOOLS_EXTENSION } from '../../src/shared/path-permissions';

export async function resolveToolCall(event, ctx, settings) {
  const tool = event.toolName;
  let decision = null;

  if (tool === 'bash') {
    decision = decideBashPermission(event.input.command ?? '', settings.bash);
  } else if (FILE_TOOLS_EXTENSION.has(tool)) {
    const cwd = ctx.cwd ?? process.cwd(); // session cwd, NOT raw process.cwd()
    decision = decidePathPermission(
      tool,
      event.input,
      {
        cwd,
        allowedRoots: buildAllowedRoots(cwd, settings.path),
        isWindows: process.platform === 'win32',
      },
      { outsideAction: settings.path.outsideAction }
    );
  }

  if (decision === 'allow' || decision === null) return undefined;
  if (decision === 'deny') return { block: true, reason: denyReason(tool, '') };
  return presentAsk(tool, summarize(tool, event.input), ctx, settings); // 'ask'
}

// Tool-agnostic dialog: Allow once / Deny / Deny & suggest + timeout (same as app's PermissionDialog)
export async function presentAsk(toolName, summary, ctx, settings) {
  if (!ctx.hasUI) return { block: true, reason: `Blocked by permissions (no UI): ${toolName}` };
  const opts =
    settings.permissionTimeoutSeconds > 0
      ? { timeout: settings.permissionTimeoutSeconds * 1000 }
      : {};
  const [ALLOW, DENY, SUGGEST] = ['Allow once', 'Deny', 'Deny & suggest alternative'];
  const choice = await ctx.ui.select(
    `Permission: ${toolName}\n\n  ${summary}`,
    [ALLOW, DENY, SUGGEST],
    opts
  );
  if (choice === ALLOW) return undefined;
  if (choice === SUGGEST) {
    const s = ((await ctx.ui.input('Suggest an alternative approach')) ?? '').trim();
    return { block: true, reason: denyReason(toolName, s) };
  }
  if (choice === DENY) return { block: true, reason: `User denied permission for '${toolName}'.` };
  return { block: true, reason: 'Blocked (timed out)' };
}
```

- `summarize(tool, input)` → command for bash, resolved path for file tools, compact JSON otherwise.
- `denyReason(tool, suggestion)` → the app's verbatim "denied THIS SPECIFIC invocation of
  '<tool>' … User's suggestion: <s>" wording, generalized from `'bash'` to `tool`.
- **Extension config:** `<CONFIG_DIR>/agent/path-permissions.json` +
  `<cwd>/<CONFIG_DIR>/path-permissions.json` where `CONFIG_DIR` comes from the SDK's
  `CONFIG_DIR_NAME` (fallback `.pi`), **not** a hardcoded `.pi`. Project overrides
  (`extraAllowedRoots` union) normalized via the shared sanitizer. Kept separate from
  `bash-restrictions.json` for modularity (option to unify later).
- **Project trust (security):** the project-local `path-permissions.json` is honored **only
  when `ctx.isProjectTrusted()`** (fail closed). This matters more here than for bash: an
  untrusted project could otherwise ship `{"enabled": false}` to **disable the gate** or
  `extraAllowedRoots: ["/"]` to mark the whole filesystem "inside". pi trust-gates _extensions_,
  not the JSON files we read ourselves, so the extension must check trust before reading it.
- **Load timing:** settings load on `session_start` using `ctx.cwd` (also fires on `/reload`,
  `/new`, `/resume`, `/fork`); the factory does no I/O. Refresh via `/reload` (same as bash).

---

## 9. App settings UI (Phase 3)

`SettingsFilePermissions.tsx` (sibling of `SettingsBashCommands.tsx`):

- Toggle **Enable workspace file permissions**.
- **Outside-workspace action:** Ask / Deny (default Ask).
- **Include OS temp directory** (default on).
- **Extra allowed roots:** textarea, one absolute path per line.
- A short explainer: "Inside the workspace runs freely; outside prompts (or is denied)."
- Persist via `settings.update` IPC; i18n keys for en/zh/ru/hu.

---

## 10. Implementation phases — unit tests in every phase; integration + e2e last only

### Phase 1 — Shared `path-permissions` module

- **Code:** `containment.ts` (relocate `isPathWithinRoot` + re-export from old home), `engine.ts`
  (pure classifier, resolver, `extractToolPaths`), `settings.ts`, `index.ts`.
- **Unit tests:**
  - `path-permissions-engine.test.ts` — pure `classifyZone`/`decideForZone` (inside/outside,
    boundary, `..`, case-insensitive macOS, multiple roots); `extractToolPaths` per tool incl.
    absolute-pattern hardening; resolver with **temp dirs** (symlink escape → outside; nonexistent
    write target → parent realpath; temp-dir realpath; degenerate root → all-outside).
  - `path-permissions-settings.test.ts` — `sanitizeExtraRoots` (drops relative/non-string,
    dedupe), `sanitizePathPermissionsSettings` (defaults, partial/garbage).
  - **Regression:** existing `isPathWithinRoot` importers still pass (re-export preserves them).
- **Gate:** `npm test` green; `npm run typecheck`.

### Phase 2 — App: store + `decidePermission`

- **Code:** path-settings cache + hydration in the store; file-tool branch in `decidePermission`;
  config-store fields + shared normalizers; IPC wiring; **verify app `glob` input shape**.
- **Unit tests:** `path-permissions-decide.test.ts` — for each gated tool: inside→allow,
  outside→ask (or deny), disabled→null (today's behavior); relative paths; degenerate root;
  temp dir allowed; precedence vs a generic `{tool:'write',action:'allow'}` rule (zone wins).
  Existing `bash-command-control*` / `mcp-tool-permissions` suites pass unedited.
- **Gate:** full `npm test` + typecheck + lint.

### Phase 3 — App settings UI

- **Code:** `SettingsFilePermissions.tsx` + store/IPC wiring + i18n.
- **Tests:** renderer store/component tests for load/save + dirty-state; sanitization of extra
  roots on commit.
- **Gate:** typecheck + lint + tests.

### Phase 4 — Extension: universal dialog + path engine

- **Code:** generalize to `resolveToolCall` + tool-agnostic `presentAsk` (also rewires the bash
  path to use `presentAsk`); `path-config.ts` loader; wire `tool_call` for the file tools.
  **Update [bash plan §6](archive/pi-bash-restrictions-extension.md) to reference `presentAsk`.**
- **Unit tests:**
  - `pi-permission-dialog.test.ts` — `presentAsk` tool-agnostic: allow/deny/ask, deny-and-suggest
    (suggestion in reason + generalized wording), `hasUI:false`→block, timeout→block, `{timeout}`
    passed iff seconds>0. Parameterized over a few tool names.
  - `pi-path-extension-config.test.ts` — config loader (absent/malformed files, project override,
    `extraAllowedRoots` union, normalization).
  - `resolveToolCall` routing: bash→bash engine, file tools→path engine, others→undefined.
- **Gate:** tests + typecheck.

### Phase 5 — Build / bundle

- **Code:** ensure the esbuild bundle (`scripts/build-pi-extension.mjs` from the bash plan) pulls
  in `src/shared/path-permissions/`; externals unchanged. The bundle emits a **directory**
  (`dist-pi-extensions/bash-restrictions/{index.js,package.json}`), not a loose `.mjs` — pi only
  discovers `.ts`/`.js`/index/manifest dirs (see bash plan §8).
- **Tests:** build-verification — `index.js` builds + manifest present; default export is a
  function; `resolveToolCall` + `presentAsk` exported.
- **Gate:** `npm run build:pi-extension` succeeds; test green.

### Phase 6 (LAST) — Integration + e2e + docs

- **Integration:** `path-permissions.e2e.test.ts` — full chain (config → engine → presentAsk) and
  app `decidePermission` against a **real temp workspace + temp dir + a symlink escaping it**, per
  gated tool: inside allow, outside ask, temp allow, symlink-escape ask, absolute-pattern ask.
- **e2e:** `pi -e` run with a real `.pi/path-permissions.json`: read/write/edit/grep/find/ls inside
  (allow) vs outside (ask), temp (allow), timeout (auto-deny), deny-and-suggest round-trip.
- **Docs:** extension README section; app `SettingsFilePermissions` help; a short
  `FILE_TOOL_PERMISSIONS.md` (or section in `BASH_COMMAND_RESTRICTIONS.md`'s neighborhood); update
  [ARCHITECTURE.md](../../ARCHITECTURE.md) §4.4 security layers.

---

## 11. Risks & coordination

- **`isPathWithinRoot` relocation** must preserve every importer — use the re-export shim
  (Phase 1 regression test guards this). High blast radius (sandbox, path-guard) if done wrong.
- **realpath cost per tool call** — `realpathSync` on the file + roots for every read/write. Cache
  resolved roots per `(cwd, settings)`; acceptable. Handle `ENOENT` (resolve nearest existing
  ancestor) without throwing into the hook.
- **Cross-plan coupling (universal dialog):** §8 changes the bash extension's §6. Land them
  together or land Phase 4 here after the bash extension's Phase 4, and edit the bash plan's §6.
- **Degenerate / symlinked workspace root** — realpath the root; a project legitimately under the
  home dir would be treated as all-outside by the guard (documented trade-off; `extraAllowedRoots`
  is the escape hatch).
- **SDK coupling** — file-tool input field names (`path`, `pattern`, `glob`) and the
  `isToolCallEventType` names are pre-1.0; re-verify on `pi` bumps. The app's `glob` input shape
  must be confirmed in Phase 2. `CONFIG_DIR_NAME` is read defensively (namespace import +
  `.pi` fallback) because it only exists in pi SDK ≥ 0.79.
- **Project trust is load-bearing for security** — because the zone model and `extraAllowedRoots`
  live in config, the project file MUST be read behind `ctx.isProjectTrusted()` (decision #8).
  Skipping the check lets an untrusted repo disable or widen the gate.
- **Bash-tool reads remain out of scope** — `bash: cat /etc/shadow` is governed only by the bash
  denylist, not this engine. Documented in §1.

---

## 12. Open items

None blocking. Two confirmations deferred to implementation:

1. App `glob` tool input field names (Phase 2 — read [tool-executor.ts:703](../../src/main/tools/tool-executor.ts)).
2. Whether to keep `path-permissions.json` separate from `bash-restrictions.json` or unify into a
   single `pi` permissions config (default: separate; trivially unifiable later).
