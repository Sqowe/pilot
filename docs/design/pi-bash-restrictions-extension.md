# Pi Bash Restrictions Extension — Implementation Plan

**Status:** ✅ Phases 1–5 complete (2026-06-20); Phase 6 integration test + docs complete
(2026-06-20) — only the manual `pi -e` smoke-test (README checklist) remains to be run by hand.
**Date:** 2026-06-19
**Owner:** @obodnikov
**Related:** [BASH_COMMAND_RESTRICTIONS.md](../../BASH_COMMAND_RESTRICTIONS.md), [permission-rules-store.ts](../../src/main/config/permission-rules-store.ts), [config-store.ts](../../src/main/config/config-store.ts), [SettingsBashCommands.tsx](../../src/renderer/components/settings/SettingsBashCommands.tsx), `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

---

## 1. Goal

Bring Open Cowork's bash trust/denylist restriction engine **and its bash/permission
settings** to the **standalone `pi` coding CLI** (`@earendil-works/pi-coding-agent`'s
`bin: pi`) as a **drop-in extension**, with:

- **no fork or modification of `pi`** — pure consumer, via the public extension API;
- **no upstream collaboration** required;
- **a single source of truth** for both the engine logic _and the settings schema_, shared
  with the Electron app, so the add-on stays in sync as the app's bash settings evolve.

### Settings parity requirement

Every bash/permission setting the app exposes must also exist in the extension, and adding a
**future** setting must be a one-place change. Current app settings (verified in
[config-store.ts](../../src/main/config/config-store.ts) + [SettingsBashCommands.tsx](../../src/renderer/components/settings/SettingsBashCommands.tsx)):

| App field                          | UI label                    | Semantics                                                                                     |
| ---------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `bashTrustedCommands: string[]`    | "Trusted commands"          | Prefix patterns, `*` wildcard, case-insensitive.                                              |
| `bashDenylist: string[]`           | "Denylist (force approval)" | Word-boundary substring; always wins over trust.                                              |
| `permissionTimeoutSeconds: number` | "Permission dialog timeout" | Default `300`; `0` = wait forever; otherwise clamped `10`–`3600`. **On timeout → auto-deny.** |
| _(future)_                         | …                           | Must be addable in one shared place (see §5, §7).                                             |

> `mcpToolTimeoutSeconds` is **out of scope** — it governs MCP tool execution, not bash
> permission. Noted only so it isn't mistaken for a missing bash setting.

### Non-goals

- Replacing `pi`'s own permission/approval flow (we layer on top).
- Porting MCP per-server policies, the generic `PermissionRule[]` engine, or session
  "always allow" memory. Only the **bash engine + bash settings** move.
- Publishing to the pi community (internal use only — future trigger in §10).

---

## 2. Why this is possible (one paragraph)

`pi` exposes a documented extension system. Extensions are TypeScript modules auto-discovered
from `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project), loaded via `jiti`.
They subscribe to the **`tool_call`** event and return `{ block: true, reason?: string }` to
deny a command — the same interception the app installs via `agent.beforeToolCall`. Dialogs
(`ctx.ui.confirm`/`ctx.ui.select`) accept a `{ timeout: ms }` option that auto-cancels and
returns `false`, mapping cleanly onto our "Permission dialog timeout → auto-deny" setting. The
shipped `examples/extensions/permission-gate.ts` is a simpler version of this exact pattern.

---

## 3. Decision summary

| Decision               | Choice                                                                            | Rationale                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repo topology          | **Same repo**                                                                     | One PR + one test suite cover both hosts; minimizes drift.                                                                                                         |
| Engine ownership       | **`src/shared/bash-restrictions/engine.ts`** — pure, stateless                    | Single source of truth; both hosts import it.                                                                                                                      |
| **Settings ownership** | **`src/shared/bash-restrictions/settings.ts`** — canonical schema + normalizers   | Parity + future-proofing: a new setting is added once; both hosts consume the same sanitizer/normalizer.                                                           |
| Extension location     | **`pi-extensions/bash-restrictions/`** (top-level, NOT under `src/main/`)         | Different runtime; must never enter the Electron main bundle.                                                                                                      |
| Distribution           | **esbuild → one self-contained directory** (`index.js` + `package.json` manifest) | The bundle runs where `src/shared/` does not exist; a directory+manifest is what pi auto-discovers (a loose `.mjs` is not — see §8).                               |
| Plan doc location      | **`docs/design/`**                                                                | Established convention (17 design docs incl. `skill-features-implementation-plan.md`). Only the _plan_ lives here; code lands in `src/shared/` + `pi-extensions/`. |
| Testing cadence        | **Unit tests in every phase; e2e + integration only in the final phase**          | Each phase ships verified; broad cross-process tests come once the parts exist.                                                                                    |

---

## 4. Target layout

```
open-cowork/
├── src/
│   ├── shared/
│   │   └── bash-restrictions/
│   │       ├── engine.ts          # decision logic (pure, lists injected)
│   │       ├── settings.ts        # canonical BashRestrictionsSettings + normalizers
│   │       └── index.ts           # public re-exports
│   └── main/config/
│       ├── permission-rules-store.ts   # keeps state + IPC; delegates bash logic to shared
│       └── config-store.ts             # imports normalizers from shared (drops local copies)
├── pi-extensions/
│   └── bash-restrictions/
│       ├── extension.ts           # pi.on("tool_call") adapter → engine; timeout-aware
│       ├── config.ts              # loads + merges .pi/bash-restrictions.json via shared sanitizer
│       └── README.md              # install + config-file documentation
├── scripts/
│   └── build-pi-extension.mjs     # esbuild → dist-pi-extensions/bash-restrictions/{index.js,package.json}
├── dist-pi-extensions/            # build output dir (gitignored)
└── tests/
    ├── bash-command-control.test.ts        # unchanged (store re-export keeps 1-arg API)
    ├── denylist-word-boundary.test.ts      # unchanged
    ├── bash-command-control-main-hydration.test.ts  # unchanged
    ├── bash-restrictions-engine.test.ts    # NEW (phase 1) pure engine
    ├── bash-restrictions-settings.test.ts  # NEW (phase 1) normalizers
    ├── pi-bash-extension-config.test.ts    # NEW (phase 3) config loader
    ├── pi-bash-extension-mapping.test.ts   # NEW (phase 4) decision→result + timeout
    ├── pi-bash-extension-build.test.ts     # NEW (phase 5) bundle is importable
    └── pi-bash-extension.e2e.test.ts       # NEW (phase 6) integration/e2e
```

---

## 5. Shared module surface

### `engine.ts` (decision logic — pure)

Moved from [permission-rules-store.ts](../../src/main/config/permission-rules-store.ts), with the
module-level lists replaced by an explicit parameter:

```ts
export type BashDecision = 'allow' | 'ask' | null;
export interface BashCommandLists {
  trusted: string[];
  denied: string[];
}

export function splitBashSubCommands(command: string): string[];
export function containsUnsupportedShellSyntax(command: string): boolean;
export function matchesTrustedPrefix(pattern: string, command: string): boolean; // was private
export function matchesDenylistPattern(pattern: string, command: string): boolean; // was private
export function decideBashPermission(command: string, lists: BashCommandLists): BashDecision;
```

### `settings.ts` (canonical settings — the parity mechanism)

```ts
export interface BashRestrictionsSettings {
  trusted: string[]; // ↔ app bashTrustedCommands
  denied: string[]; // ↔ app bashDenylist
  permissionTimeoutSeconds: number; // ↔ app permissionTimeoutSeconds (0 = infinite; else 10..3600)
  // FUTURE settings are added HERE once; both hosts then consume them.
}
export const DEFAULT_BASH_RESTRICTIONS_SETTINGS: BashRestrictionsSettings;

export function sanitizeBashCommandList(input: unknown): string[]; // moved from store
export function normalizePermissionTimeout(value: unknown): number; // moved from config-store
export function sanitizeBashRestrictionsSettings(raw: unknown): BashRestrictionsSettings;
```

`normalizePermissionTimeout` keeps the app's exact rules: `0` → `0` (infinite); positive →
clamp to `[10, 3600]`; invalid/missing → `300`.

### App adapter (kept API-compatible to avoid ripple)

- `permission-rules-store.ts`: keeps `bashTrustedCommands`/`bashDenylist` state +
  `setBashCommandLists`/`getBashCommandLists`; **keeps the existing 1-arg
  `decideBashPermission(command)`** as a thin wrapper that injects current lists; **re-exports**
  `sanitizeBashCommandList` from shared (so `config-store.ts` and IPC import paths are unchanged).
- `config-store.ts`: replaces its local `normalizePermissionTimeout` (line ~471) with the
  shared one. Persisted field names stay (`bashTrustedCommands`, `bashDenylist`,
  `permissionTimeoutSeconds`) — only the normalization logic is now shared.

> **Why API-compatible:** the 3 existing test files import `decideBashPermission(cmd)` (1-arg)
> and `sanitizeBashCommandList` from the store and drive module state via `setBashCommandLists`.
> Keeping those signatures means they pass **unedited** — the regression proof for Phase 2.

---

## 6. Extension adapter — `tool_call` mapping (timeout + deny-and-suggest)

`pi`'s `tool_call` return value only controls blocking, and its `reason` string is fed to the
model as the tool result — the channel the app uses for **deny-and-suggest**. Our engine is
3-state; the interactive path offers the app's multi-choice outcomes. Mapping:

| Engine result         | Interactive (`ctx.hasUI`)                         | Headless (`!ctx.hasUI`)         |
| --------------------- | ------------------------------------------------- | ------------------------------- |
| `'allow'`             | `return undefined` (let pi run it)                | `return undefined`              |
| `'ask'`               | `ctx.ui.select(…)` → outcome below (with timeout) | `{ block: true }` — fail-closed |
| `null` (not opted in) | `return undefined` (defer to pi's own approval)   | `return undefined`              |

Interactive `'ask'` outcomes (mirror the app's `PermissionDialog`):

| User choice                                        | Returns                                         | Model sees (`reason`)                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Allow once**                                     | `undefined`                                     | — (command runs)                                                                                                           |
| **Deny**                                           | `{ block: true, reason }`                       | `User denied permission for 'bash'.`                                                                                       |
| **Deny & suggest alternative**                     | `ctx.ui.input(...)` → `{ block: true, reason }` | `User denied THIS SPECIFIC invocation of 'bash'. … You may still use 'bash' for other purposes. User's suggestion: <text>` |
| **Timed out / dismissed** (`select` → `undefined`) | `{ block: true, reason }`                       | `Blocked (timed out)` — auto-deny                                                                                          |

The `select`/`input` dialogs take `{ timeout: permissionTimeoutSeconds * 1000 }` when
`permissionTimeoutSeconds > 0`, otherwise **no timeout** (waits forever). `select` returns
`undefined` on timeout/cancel → treated as **deny** (auto-deny, matching the app). The
deny-and-suggest `reason` wording is copied verbatim from
[agent-runner.ts:1806](../../src/main/claude/agent-runner.ts) for behavioral parity.

Skeleton (decision→result extracted as a pure, testable function):

```ts
// pi-extensions/bash-restrictions/extension.ts
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import {
  decideBashPermission,
  DEFAULT_BASH_RESTRICTIONS_SETTINGS,
  type BashRestrictionsSettings,
} from '../../src/shared/bash-restrictions';
import { loadBashRestrictionsSettings } from './config';

export async function resolveBashToolCall(
  command: string,
  ctx: ExtensionContext,
  settings: BashRestrictionsSettings
): Promise<{ block: true; reason: string } | undefined> {
  const decision = decideBashPermission(command, {
    trusted: settings.trusted,
    denied: settings.denied,
  });
  if (decision === 'allow' || decision === null) return undefined;
  if (!ctx.hasUI) return { block: true, reason: 'Blocked by bash restrictions (no UI to confirm)' };
  const opts =
    settings.permissionTimeoutSeconds > 0
      ? { timeout: settings.permissionTimeoutSeconds * 1000 }
      : {};
  const [ALLOW, DENY, SUGGEST] = ['Allow once', 'Deny', 'Deny & suggest alternative'];
  const choice = await ctx.ui.select(
    `Bash restriction\n\n  ${command}`,
    [ALLOW, DENY, SUGGEST],
    opts
  );

  if (choice === ALLOW) return undefined;
  if (choice === SUGGEST) {
    const s = (
      (await ctx.ui.input('Suggest an alternative approach', 'e.g. "read the file instead"')) ?? ''
    ).trim();
    return {
      block: true,
      reason:
        `User denied THIS SPECIFIC invocation of 'bash'. The tool 'bash' is NOT globally ` +
        `blocked — only this particular call was rejected. You may still use 'bash' for ` +
        `other purposes.` +
        (s ? ` User's suggestion: ${s}` : ''),
    };
  }
  if (choice === DENY) return { block: true, reason: "User denied permission for 'bash'." };
  return { block: true, reason: 'Blocked (timed out)' }; // select returned undefined
}

export default function (pi: ExtensionAPI) {
  let settings = { ...DEFAULT_BASH_RESTRICTIONS_SETTINGS };
  // Load on session_start (NOT in the factory): per pi extensions.md, the factory
  // may run without a session, so resource work is deferred; the session cwd comes
  // from ctx.cwd (not process.cwd()); and the project-local config is honored only
  // when ctx.isProjectTrusted() is true (fail closed otherwise). session_start also
  // fires on /reload, /new, /resume, /fork — so it doubles as the reload hook.
  pi.on('session_start', async (_event, ctx) => {
    const projectTrusted =
      typeof ctx.isProjectTrusted === 'function' ? ctx.isProjectTrusted() : false;
    settings = loadBashRestrictionsSettings(ctx.cwd ?? process.cwd(), { projectTrusted });
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('bash', event)) return undefined;
    return resolveBashToolCall(event.input.command ?? '', ctx, settings);
  });
  // user_bash (the human's ! / !! commands) is intentionally NOT gated — agent bash tool only.
}
```

`@earendil-works/pi-coding-agent` is **external** (provided by pi at load), never bundled.

---

## 7. Extension config source (full parity + forward-compatible)

The extension reads its own JSON (the app reads encrypted electron-store). It carries the
**full** settings set and is normalized through the **shared** `sanitizeBashRestrictionsSettings`,
so a future field added to the schema is honored automatically once both hosts read it.

```jsonc
// <CONFIG_DIR>/agent/bash-restrictions.json (global)  and/or  <cwd>/<CONFIG_DIR>/bash-restrictions.json (project)
// CONFIG_DIR defaults to ".pi" but follows pi's CONFIG_DIR_NAME (rebranded distros differ).
{
  "trusted": ["ls *", "cat *", "npm run *", "git status*"],
  "denied": ["rm", "--force", "sudo", "git push"],
  "permissionTimeoutSeconds": 300,
}
```

`config.ts` responsibilities:

1. Resolve the config dir from the SDK's `CONFIG_DIR_NAME` (default `.pi`), **not** a
   hardcoded `.pi`. Read it off a namespace import with a `.pi` fallback so older SDKs
   that don't export it (< 0.79) still work. Global lives under `<CONFIG_DIR>/agent/`.
2. Read global + project files; tolerate missing/malformed (fall back to defaults).
   **The project file is read only when the caller reports the project as trusted**
   (`projectTrusted`, wired to `ctx.isProjectTrusted()`); an untrusted project must not
   be able to widen `trusted` (or otherwise loosen the gate). Global config always applies.
3. Merge: **`trusted` and `denied` = union** (`global ∪ project`, deduped);
   `permissionTimeoutSeconds` = project value if present, else global, else default.
4. Pass the merged raw object through `sanitizeBashRestrictionsSettings` → canonical shape.

> **Future setting parity (the mechanism):** add the field + its normalizer to
> `src/shared/bash-restrictions/settings.ts` once. The app wires UI + store; the extension reads
> it from this JSON. The normalization is written a single time and shared.

---

## 8. Build / bundling

> **pi only auto-discovers `*.ts` / `*.js`, a subdir with `index.ts`/`index.js`, or a
> directory whose `package.json` declares a `pi.extensions` manifest** — a loose `.mjs`
> is NOT discovered (`dist/core/extensions/loader.js`: `name.endsWith(".ts")||".js"`).
> So we emit a **directory with `index.js` + a manifest**, not a single `.mjs`.

```js
// scripts/build-pi-extension.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
const OUT_DIR = 'dist-pi-extensions/bash-restrictions';
await build({
  entryPoints: ['pi-extensions/bash-restrictions/extension.ts'],
  outfile: `${OUT_DIR}/index.js`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@earendil-works/*', 'typebox', 'node:*'],
});
// Manifest so pi discovers the directory AND Node loads index.js as ESM:
writeFileSync(
  `${OUT_DIR}/package.json`,
  JSON.stringify(
    {
      name: 'bash-restrictions',
      private: true,
      type: 'module',
      pi: { extensions: ['./index.js'] },
    },
    null,
    2
  )
);
```

- `"build:pi-extension": "node scripts/build-pi-extension.mjs"` in `package.json`; `esbuild`
  is a direct devDependency.
- `dist-pi-extensions/` → `.gitignore`.
- **Install (documented in extension README):** `cp -r dist-pi-extensions/bash-restrictions ~/.pi/agent/extensions/`
  then `/reload` (or restart). Quick test: `pi -e ./pi-extensions/bash-restrictions/extension.ts`.

---

## 9. Implementation phases — each phase ships its own unit tests

> Rule: **unit tests are written and green within the same phase as the code.** Only
> integration + e2e are deferred to the final phase (they need all parts to exist).

### Phase 1 — Shared engine + settings (pure) — ✅ DONE (2026-06-19)

> Implemented: `src/shared/bash-restrictions/{engine.ts,settings.ts,index.ts}` with the §5 API
> surface, plus `tests/bash-restrictions-engine.test.ts` and
> `tests/bash-restrictions-settings.test.ts`. **Gate met: 171 unit tests passing.**

- **Code:** `engine.ts`, `settings.ts`, `index.ts`.
- **Unit tests (this phase):**
  - `bash-restrictions-engine.test.ts` — decision logic against `decideBashPermission(cmd, lists)`
    directly: trust/deny, pipeline split, denylist-beats-trust, unsupported-syntax fail-closed,
    FD-redirection allowances, regex-safe escaping. (Port the cases from the existing suites to
    the pure 2-arg form.)
  - `bash-restrictions-settings.test.ts` — `sanitizeBashCommandList` edge cases;
    `normalizePermissionTimeout` (`0`→`0`, `5`→`10`, `300`→`300`, `9999`→`3600`, garbage→`300`);
    `sanitizeBashRestrictionsSettings` produces a complete canonical object from partial/garbage.
- **Gate:** `npm test` green; `npm run typecheck`.

### Phase 2 — Rewire app to shared (behavior-preserving)

- **Code:** store delegates via 1-arg wrapper + re-export; `config-store.ts` imports
  `normalizePermissionTimeout` from shared; delete local duplicates.
- **Tests (this phase):** the **existing** suites (`bash-command-control*`,
  `denylist-word-boundary`, plus any config-store timeout-normalization tests) must pass
  **unedited** — this is the regression proof. Add a focused test only if a gap appears.
- **Gate:** full `npm test` + `npm run typecheck` + `npm run lint`.

### Phase 3 — Extension config loader

- **Code:** `pi-extensions/bash-restrictions/config.ts` (read global+project, env fallback,
  merge per §7, normalize via shared).
- **Unit tests (this phase):** `pi-bash-extension-config.test.ts` with temp dirs / mock fs —
  absent files → defaults; malformed JSON tolerated; `trusted` + `denied` union (deduped);
  timeout normalized; full canonical shape returned.
- **Gate:** tests green.

### Phase 4 — Extension handler + decision/timeout mapping

- **Code:** `extension.ts` with the pure `resolveBashToolCall(command, ctx, settings)` (§6) and
  the `pi.on("tool_call")` wiring.
- **Unit tests (this phase):** `pi-bash-extension-mapping.test.ts` with a fake `ctx` —
  `allow`/`null` → `undefined`; `ask` + `hasUI:false` → block (fail-closed); `ask` + `hasUI:true`
  select **"Allow once"** → `undefined`; **"Deny"** → block with the plain-deny reason;
  **"Deny & suggest alternative"** → `ctx.ui.input` captured → block whose `reason` contains the
  suggestion **and** the "NOT globally blocked" wording; `select` → `undefined` (timeout/cancel)
  → block (auto-deny). Assert `{ timeout: ms }` is passed to `select`/`input` when
  `permissionTimeoutSeconds>0` and **omitted** when `0`.
- **Gate:** tests green + typecheck.

### Phase 5 — Build / bundle

- **Code:** `scripts/build-pi-extension.mjs`, `package.json` script, `.gitignore` entry.
- **Tests (this phase):** `pi-bash-extension-build.test.ts` — run the bundler, assert the output
  file exists and is importable with `@earendil-works/*` stubbed, and that its default export is
  a function (and `resolveBashToolCall` is exported). Lightweight build-verification.
- **Gate:** `npm run build:pi-extension` succeeds; test green.

### Phase 6 (LAST) — Integration + e2e + docs

- **Integration:** `pi-bash-extension.e2e.test.ts` exercises the full chain **config file →
  loader → engine → mapper** with real temp files and real modules (no pi process): trusted
  command → allow, denylisted → block, unsupported syntax → block, headless ask → block,
  timeout → block.
- **e2e (manual + scripted where feasible):** `pi -e ./pi-extensions/bash-restrictions/extension.ts`
  with a real `.pi/bash-restrictions.json`; verify `ls -la` (allow), `rm -rf x` (ask/block),
  `echo $(rm -rf /)` (block via syntax guard), and a no-response timeout (auto-deny).
- **Docs:** extension `README.md` (install + config format incl. timeout) and a pointer from
  [BASH_COMMAND_RESTRICTIONS.md](../../BASH_COMMAND_RESTRICTIONS.md).

---

## 10. Risks & future triggers

- **SDK version coupling.** `pi-coding-agent` is pre-1.0 and breaks often (see
  [ARCHITECTURE.md](../../ARCHITECTURE.md) §7). Re-verify the extension API (`tool_call`,
  `ToolCallEventResult`, `isToolCallEventType`, `ExtensionUIDialogOptions.timeout`) on each `pi`
  bump — same discipline as `before-tool-call-hook.ts`.
- **Headless fail-closed** changes UX vs the GUI (block instead of prompt). Intentional;
  consistent with timeout auto-deny.
- **Trust boundary.** Extensions run with full user permissions; install only from this repo's
  build output.
- **Graduate to a published package / separate repo** only when sharing with the pi community
  (cf. `pi-permission-system`), diverging release cadence, or a third consumer. Because the
  engine + settings are isolated in `src/shared/bash-restrictions/`, that promotion is a
  lift-and-shift, not a rewrite.

---

## 11. Resolved decisions (locked — no open questions)

| #   | Decision                           | Resolution                                   | Implication                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Headless `'ask'` policy            | **Block (fail-closed)**                      | When `!ctx.hasUI`, an `'ask'` decision returns `{ block: true }`. No allow-on-no-UI path.                                                                                                                                                                                               |
| 2   | Global + project list merge        | **Union both** (`global ∪ project`, deduped) | `trusted` and `denied` are each concatenated + deduped. Per-project tightening is done by adding denials; denylist beats trust.                                                                                                                                                         |
| 3   | Gate `user_bash`?                  | **No — agent bash tool only**                | Only the LLM's `bash` tool is gated via `tool_call`. The human's `!`/`!!` commands are not intercepted.                                                                                                                                                                                 |
| 4   | Config reload                      | **On `session_start`**                       | `loadBashRestrictionsSettings` runs in the `session_start` handler (using `ctx.cwd`), which also fires on `/reload`, `/new`, `/resume`, `/fork`. Edit the JSON + `/reload` to refresh. No file watcher.                                                                                 |
| 7   | Project config trust               | **Gated on `ctx.isProjectTrusted()`**        | The project-local file is honored only for trusted projects (fail closed otherwise); an untrusted project cannot widen `trusted`/loosen the gate. Global config always applies. pi only trust-gates _extensions_, not JSON we read ourselves, so the extension must check trust itself. |
| 5   | Permission outcomes (interactive)  | **Allow once / Deny / Deny & suggest**       | `'ask'` uses `ctx.ui.select` + `ctx.ui.input`; the free-text suggestion is appended to the block `reason` fed to the model, wording verbatim from the app.                                                                                                                              |
| 6   | `allow_always` (app's 4th outcome) | **Skipped (intentional)**                    | Inert for bash in authoritative mode in the app too — the list engine runs before session "always allow" memory. Permanent trust = add the command to the trusted list + `/reload`.                                                                                                     |

> Mandated (not a decision): timeout-on-no-response = **deny** — fixed by parity with the app's
> "auto-deny" semantics and the fail-closed posture.

```

```
