# Workspace Instructions — Priority-Based Auto-Discovery — Implementation Plan

**Status:** In Progress (Phase 1 ✓, Phase 2 ✓, Phase 4/7 ✓)
**Date:** 2026-07-01
**Owner:** @obodnikov
**Related:** [workspace-system-prompt.ts](../../src/main/utils/workspace-system-prompt.ts), [system-prompt-file-choices.ts](../../src/shared/system-prompt-file-choices.ts), [agent-runner.ts](../../src/main/claude/agent-runner.ts), [config-store.ts](../../src/main/config/config-store.ts), [SettingsPrompt.tsx](../../src/renderer/components/settings/SettingsPrompt.tsx), [WorkspaceInstructionsBadge.tsx](../../src/renderer/components/WorkspaceInstructionsBadge.tsx), `node_modules/@earendil-works/pi-coding-agent/docs/usage.md`
**Prior art:** [pi-code-agent-default-rules-and-instruction-files-2026-06-21.md](../chats/pi-code-agent-default-rules-and-instruction-files-2026-06-21.md), [opencowork-configuration-files-and-system-prompt-selection-2026-04-27.md](../chats/opencowork-configuration-files-and-system-prompt-selection-2026-04-27.md), [workspace-instructions-visibility-badge-implementation-2026-06-03.md](../chats/workspace-instructions-visibility-badge-implementation-2026-06-03.md)

---

## 1. Goal

Replace the single-file **dropdown** in Settings → System Prompt ("Workspace instructions
file") with **automatic discovery driven by a user-ordered priority list**. Instead of the
user picking one exact filename, the app scans the session working directory for a fixed set
of candidate files and injects the **first one that exists**, in a priority order the user can
**reorder** (drag labels between positions). If only one candidate exists it is used; if
several exist, the highest-priority one wins.

Concretely: "I have `CLAUDE.md` and `AGENTS.md` in the folder — the app should pick one based
on my priority list, automatically, without me re-selecting it per project."

### Non-goals

- **Adding or removing** candidate filenames from the whitelist. The set stays fixed
  (`CLAUDE.md`, `AGENTS.md`, `.cowork/instructions.md`, `memory.md`, `instructions.md`); only
  the **order** is user-editable. (Decision locked — see §2.)
- **Merging** multiple existing files. First-match-by-priority wins; we do not concatenate.
  (Decision locked — see §2.)
- Walking parent directories or a global instructions dir. Discovery stays **cwd-root-only**,
  matching the existing hardened loader. (pi's native discovery walks parents; we intentionally
  do not — see §4.)
- Changing the placement/wrapping of the injected text. It stays an **append** wrapped in
  `<workspace_instructions>`, recency-weighted as last-word guidance.

---

## 2. Locked decisions

Confirmed with the user before writing this plan:

| #   | Decision               | Choice                                                                                                                                                                           |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Direction              | **App-owned discovery.** Disable pi's native context-file loading (`noContextFiles: true`); the app resolves the winning file itself from the priority list and injects it once. |
| D2  | Candidate set          | **Fixed set, reorderable.** Keep the existing whitelist; add drag/up-down reordering. No add/remove of custom filenames.                                                         |
| D3  | Multiple files present | **First by priority wins.** Use only the single highest-priority existing file. No merge.                                                                                        |
| D4  | Fresh-install default  | **Enabled** with the default priority order (matches what pi was already auto-loading). Existing users' intent is preserved via migration (§7).                                  |

---

## 3. The key finding — pi already does this (and we double-inject today)

pi's `DefaultResourceLoader` — which the app already uses — natively discovers context files.
From `node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:29`:

```js
function loadContextFileFromDir(dir) {
  const candidates = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
  // ...first existing wins, per directory
}
```

pi walks **global (`agentDir`) → ancestor dirs → cwd**, injecting each as
`<project_instructions path="...">`. So pi already performs priority-ordered auto-discovery —
with a **hard-coded** order (`AGENTS.md` beats `CLAUDE.md`) that is not user-configurable.

**The app never passes `noContextFiles`**, which defaults to `false`
([agent-runner.ts:3257](../../src/main/claude/agent-runner.ts#L3257) constructs the loader with
only `cwd`, `agentDir`, `additionalSkillPaths`, `appendSystemPrompt`). Therefore **two parallel
mechanisms are live today**:

1. **pi** prepends discovered `AGENTS.md`/`CLAUDE.md` as `<project_instructions>`.
2. **The app** independently appends the user-selected file as `<workspace_instructions>`
   ([agent-runner.ts:3248](../../src/main/claude/agent-runner.ts#L3248)).

**Consequence — double injection:** if the workspace root has `CLAUDE.md` (or `AGENTS.md`)
**and** the user selected that same file, its bytes land in the prompt **twice** (prepended by
pi, appended by the app), the appended copy getting recency emphasis. Redundant tokens, not a
correctness bug. This design **fixes it** by taking ownership: `noContextFiles: true` turns off
pi's discovery, and the app becomes the single source of truth. (This confirms the open
question raised in
[pi-code-agent-default-rules-and-instruction-files-2026-06-21.md](../chats/pi-code-agent-default-rules-and-instruction-files-2026-06-21.md#L204-L217).)

---

## 4. Current architecture (as-is)

| Layer                | File                                                                                                                                                      | Behavior                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whitelist            | [system-prompt-file-choices.ts](../../src/shared/system-prompt-file-choices.ts)                                                                           | `SYSTEM_PROMPT_FILE_CHOICES` incl. `''`; `isValidSystemPromptFileChoice`.                                                                          |
| Loader               | [workspace-system-prompt.ts](../../src/main/utils/workspace-system-prompt.ts)                                                                             | `loadWorkspaceSystemPrompt(cwd, rawChoice)` — single choice; path-containment + symlink-escape rejection + 64 KB truncation + content fingerprint. |
| Config               | [config-store.ts](../../src/main/config/config-store.ts)                                                                                                  | `systemPromptFile?: SystemPromptFileChoice` (field ~L133, default `''` ~L322, normalizer ~L1200, update-merge ~L1630).                             |
| Session              | [agent-runner.ts](../../src/main/claude/agent-runner.ts)                                                                                                  | Loads file (~L2789), fingerprint feeds `buildPiSessionRuntimeSignature` (~L2802), appends as `<workspace_instructions>` (~L3248).                  |
| IPC                  | [index.ts](../../src/main/index.ts)                                                                                                                       | `workspace-instructions.getStatus` (~L2022); `settings.update` validates `systemPromptFile` (~L4819).                                              |
| Status type          | [workspace-instructions-status.ts](../../src/shared/workspace-instructions-status.ts)                                                                     | `WorkspaceInstructionsStatus`.                                                                                                                     |
| UI (settings)        | [SettingsPrompt.tsx](../../src/renderer/components/settings/SettingsPrompt.tsx)                                                                           | `<select>` bound to `systemPromptFile` (~L404).                                                                                                    |
| UI (badge)           | [WorkspaceInstructionsBadge.tsx](../../src/renderer/components/WorkspaceInstructionsBadge.tsx)                                                            | Shows configured file + loaded/active state.                                                                                                       |
| Renderer types/store | [types/index.ts](../../src/renderer/types/index.ts), [store/index.ts](../../src/renderer/store/index.ts), [useIPC.ts](../../src/renderer/hooks/useIPC.ts) | `systemPromptFile` field mirrored.                                                                                                                 |
| i18n                 | `en/zh/hu/ru.json`                                                                                                                                        | `prompt.systemPromptFile*` strings.                                                                                                                |

---

## 5. Target design

- The user configures an **ordered priority list** of the fixed candidates plus a master
  **on/off** toggle (replacing the old `''` = None sentinel).
- At session start the app resolves the **first existing + readable** candidate at the cwd
  root, honoring the user's order, and appends its contents (unchanged wrapping/hardening).
- pi's native discovery is **disabled** (`noContextFiles: true`) so nothing is injected twice.
- The badge reports **which** candidate won (`resolvedFile`), giving visible proof.

### Data model

Replace the single `systemPromptFile: string` with two fields:

```ts
systemPromptFileEnabled: boolean;   // master on/off (replaces '' = None)
systemPromptFilePriority: string[]; // permutation/subset of the whitelist, priority order
```

`systemPromptFile` is **removed** from the live schema but still **read once** by the
normalizer for migration (§7).

---

## 6. Implementation phases

### Phase 1 — Shared model ([system-prompt-file-choices.ts](../../src/shared/system-prompt-file-choices.ts))

Keep the whitelist as the safety allow-list, but factor out the non-empty candidates and add a
priority validator. Keeping this in `shared/` preserves the invariant that the UI can't offer,
and the backend can't accept, anything off-list.

```ts
// Non-empty candidates, in default priority order (D4).
export const DEFAULT_SYSTEM_PROMPT_PRIORITY = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cowork/instructions.md',
  'memory.md',
  'instructions.md',
] as const;

export type SystemPromptFileName = (typeof DEFAULT_SYSTEM_PROMPT_PRIORITY)[number];

const ALLOWED = new Set<string>(DEFAULT_SYSTEM_PROMPT_PRIORITY);

/** A valid priority list: array of unique, whitelisted filenames (subset OK). */
export function isValidSystemPromptPriority(v: unknown): v is SystemPromptFileName[] {
  if (!Array.isArray(v)) return false;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string' || !ALLOWED.has(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

/**
 * Normalize any stored/incoming list: drop invalid/dup entries, then append any
 * whitelist members the user hasn't ordered yet so newly-added candidates surface
 * at the bottom rather than silently vanishing. Result is always a full permutation.
 */
export function normalizeSystemPromptPriority(v: unknown): SystemPromptFileName[] {
  const seen = new Set<string>();
  const out: SystemPromptFileName[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string' && ALLOWED.has(item) && !seen.has(item)) {
        seen.add(item);
        out.push(item as SystemPromptFileName);
      }
    }
  }
  for (const c of DEFAULT_SYSTEM_PROMPT_PRIORITY) {
    if (!seen.has(c)) out.push(c);
  }
  return out;
}
```

`SYSTEM_PROMPT_FILE_CHOICES` / `isValidSystemPromptFileChoice` stay exported (still used by the
migration path and any external callers) until the migration window closes.

### Phase 2 — Loader ([workspace-system-prompt.ts](../../src/main/utils/workspace-system-prompt.ts))

Generalize the resolver to iterate the ordered list and return the first winner. **All existing
hardening is preserved per-candidate**: `isPathWithinRoot` on the raw resolved path, `realpath`

- re-check for symlink escape, `isFile()`, 64 KB read cap + truncation marker, content-based
  sha256 fingerprint. Add `resolvedFile` to the return so callers/badge know which won.

```ts
export interface WorkspaceInstructions {
  text: string;
  fingerprint: string;
  resolvedFile: string; // NEW — which candidate won (relative name)
}

/**
 * Resolve workspace instructions from an ordered priority list.
 * Returns the first existing + readable candidate, or null when disabled,
 * no cwd, or none of the candidates resolve safely.
 */
export async function loadWorkspaceSystemPrompt(
  cwd: string | undefined,
  priority: readonly string[],
  enabled: boolean
): Promise<WorkspaceInstructions | null> {
  if (!enabled || !cwd || typeof cwd !== 'string') return null;
  for (const choice of priority) {
    const result = await tryLoadOne(cwd, choice); // extracted from today's body
    if (result) return { ...result, resolvedFile: choice };
  }
  return null;
}
```

`tryLoadOne` is the current single-file body (lines ~72–149), minus the `resolvedFile` field
which the caller attaches. Signature-invalid entries are skipped, not fatal, so one bad entry
never blocks a lower-priority valid file.

### Phase 3 — Agent runner ([agent-runner.ts](../../src/main/claude/agent-runner.ts))

1. **Disable pi's native discovery** on the loader (~L3257) to end double-injection:

   ```ts
   const resourceLoader = new DefaultResourceLoader({
     cwd: effectiveCwd,
     agentDir: userClaudeDir,
     additionalSkillPaths: skillPaths,
     appendSystemPrompt: appendSystemPrompt ? [appendSystemPrompt] : undefined,
     noContextFiles: true, // NEW — app owns instruction-file discovery (D1)
   });
   ```

2. **Feed the new fields** into the loader call (~L2789):

   ```ts
   const workspaceInstructions = await loadWorkspaceSystemPrompt(
     effectiveCwd,
     configStore.get('systemPromptFilePriority'),
     configStore.get('systemPromptFileEnabled')
   );
   ```

   The fingerprint→`buildPiSessionRuntimeSignature` wiring (~L2802) is unchanged, so editing the
   winning file or reordering the list still invalidates the cached pi session correctly. The
   append block (~L3248) is unchanged except the log line uses `workspaceInstructions.resolvedFile`.

### Phase 4 — Config store ([config-store.ts](../../src/main/config/config-store.ts))

- **Field** (~L130): remove `systemPromptFile`; add:

  ```ts
  systemPromptFileEnabled: boolean;
  systemPromptFilePriority: string[];
  ```

- **Defaults** (~L322): `systemPromptFileEnabled: true`, `systemPromptFilePriority:
[...DEFAULT_SYSTEM_PROMPT_PRIORITY]` (D4).
- **Persisted-keys list** (~L241): replace `'systemPromptFile'` with the two new keys.
- **Normalizer** (~L1200): see §7 (migration-aware).
- **update()-merge** (~L1630): merge both new fields with the same
  `updates.x !== undefined ? updates.x : current.x` pattern.

### Phase 5 — IPC + status ([index.ts](../../src/main/index.ts), [workspace-instructions-status.ts](../../src/shared/workspace-instructions-status.ts))

- **Status type**: add `resolvedFile?: string` (which candidate won). `configuredFile` is
  reinterpreted as "the resolved file" for badge display; when nothing resolves it is `''`.
- **`workspace-instructions.getStatus`** (~L2022): call the new resolver with
  `systemPromptFilePriority` + `systemPromptFileEnabled`; when a result comes back set
  `configuredFile = result.resolvedFile`, `resolvedFile = result.resolvedFile`. When disabled →
  `{ configuredFile: '', loaded: false }`. When enabled but nothing found → `loaded: false` with
  an error naming the searched candidates.
- **`settings.update`** (~L4819): replace the `systemPromptFile` branch with validation of the
  two new fields via `isValidSystemPromptPriority` / boolean coercion; ignore invalid payloads
  with a warn, as today.

### Phase 6 — Renderer

- **Types** ([types/index.ts](../../src/renderer/types/index.ts)): drop `systemPromptFile`; add
  `systemPromptFileEnabled: boolean` and `systemPromptFilePriority: string[]` to both the
  `Settings` type (~L784) and the partial-update type (~L913).
- **Store** ([store/index.ts](../../src/renderer/store/index.ts) ~L248) + **hydration**
  ([useIPC.ts](../../src/renderer/hooks/useIPC.ts) ~L131): default/hydrate the two fields.
- **Settings UI** ([SettingsPrompt.tsx](../../src/renderer/components/settings/SettingsPrompt.tsx)
  ~L393–416): replace the `<select>` with:
  - a **master toggle** ("Auto-load workspace instructions") bound to `systemPromptFileEnabled`;
  - a **reorderable list** of the candidate labels bound to `systemPromptFilePriority`, each row
    with up/down buttons (no new dependency — the project has no dnd library). Reordering calls
    `updateSettings({ systemPromptFilePriority: next })`. Disabled/greyed when the toggle is off.
  - Copy: explain that the **first file that exists** in the working directory is used.
- **Badge** ([WorkspaceInstructionsBadge.tsx](../../src/renderer/components/WorkspaceInstructionsBadge.tsx)):
  already renders `status.configuredFile`; with `resolvedFile` populated it now shows the file
  that actually won. Optionally add a sub-line "matched from priority list".

### Phase 7 — i18n (`en`, `zh`, `hu`, `ru`)

Add: `prompt.workspaceInstructionsEnabled`, `...PriorityTitle`, `...PriorityDesc`,
`...moveUp`, `...moveDown`, plus badge `workspaceInstructions.matchedFrom`. Remove the now-unused
`...None` string once nothing references it. English first; keep the other three locales in sync
(the repo already maintains zh/hu/ru — see [en.json:95](../../src/renderer/i18n/locales/en.json#L95)).

---

## 7. Migration (backward compatibility)

Existing users have `systemPromptFile: SystemPromptFileChoice` persisted. The normalizer
(~L1200) reads the **legacy** key once and maps intent forward, preserving each user's current
behavior:

```ts
// Migration: derive new fields from legacy `systemPromptFile` when the new
// keys are absent (first launch after upgrade).
const legacy = raw.systemPromptFile;
const hasNew =
  typeof raw.systemPromptFileEnabled === 'boolean' || Array.isArray(raw.systemPromptFilePriority);

let enabled: boolean;
let priority: SystemPromptFileName[];

if (hasNew) {
  enabled = toBoolean(raw.systemPromptFileEnabled, defaultConfig.systemPromptFileEnabled);
  priority = normalizeSystemPromptPriority(raw.systemPromptFilePriority);
} else if (typeof legacy === 'string' && legacy !== '' && isValidSystemPromptFileChoice(legacy)) {
  // User had picked a specific file → enable and hoist it to the top.
  enabled = true;
  priority = normalizeSystemPromptPriority([legacy]);
} else if (legacy === '') {
  // User had explicitly selected "None" → stay off, but seed a sane order.
  enabled = false;
  priority = [...DEFAULT_SYSTEM_PROMPT_PRIORITY];
} else {
  // Truly fresh install (no legacy key at all) → D4 default: enabled.
  enabled = defaultConfig.systemPromptFileEnabled;
  priority = [...DEFAULT_SYSTEM_PROMPT_PRIORITY];
}
```

**Behavioral notes:**

- A user who had `''` (None) keeps auto-loading **off** — but note that pi _was_ silently
  discovering `AGENTS.md`/`CLAUDE.md` for them regardless (§3). After this change, with
  `noContextFiles: true` and the toggle off, **nothing** is injected. This is the intended,
  now-honest behavior; worth a one-line release note.
- A user who had a specific file keeps that file winning (it's hoisted to position 0), and other
  candidates fall in behind it as fallbacks — a strict superset of prior behavior.

The legacy `systemPromptFile` key can be dropped from the persisted config after the normalizer
runs (or left inert and ignored). Recommend leaving it untouched for one release, then removing.

---

## 8. Edge cases & safety

- **Per-candidate hardening preserved.** Path-containment, symlink-escape rejection, `isFile()`,
  64 KB truncation, content fingerprint — all run per candidate. A candidate that fails any check
  is skipped, and the loop continues to the next priority entry.
- **Empty file.** A candidate that exists but is whitespace-only returns null (as today) and the
  loop falls through to the next candidate — so an empty `CLAUDE.md` won't shadow a real
  `AGENTS.md`.
- **`.cowork/instructions.md`.** Contains a path separator; already handled by the existing
  `path.resolve` + containment logic and unaffected by ordering.
- **Reordering invalidates cache correctly.** Because a _different_ winning file yields a
  _different_ fingerprint, `buildPiSessionRuntimeSignature` changes and the cached pi session is
  recreated — no stale prompt. Reordering that doesn't change the winner is a no-op for the
  session (correct — same bytes).
- **Duplicate/garbage in stored priority.** `normalizeSystemPromptPriority` dedups and backfills,
  so a corrupted config can never drop a candidate or crash resolution.

---

## 9. Testing

- **Unit — priority validator** (new): `isValidSystemPromptPriority` accepts subsets/permutations,
  rejects dups/unknowns/non-arrays; `normalizeSystemPromptPriority` dedups + backfills to a full
  permutation.
- **Unit — loader**: given a temp cwd with multiple candidates, first-by-priority wins; empty
  higher-priority file falls through; symlink-escape candidate is skipped; `enabled: false` → null;
  `resolvedFile` matches the winner.
- **Unit — config migration**: legacy `''` → `{enabled:false, default order}`; legacy `CLAUDE.md`
  → `{enabled:true, CLAUDE.md first}`; new keys present → passthrough; no legacy → D4 default.
  (Mirror the existing `tests/config-store-*.test.ts` style.)
- **Manual**: put `CLAUDE.md` + `AGENTS.md` in a workspace, reorder in Settings, confirm the badge
  flips which file is "active"; confirm no double-injection by inspecting the assembled prompt
  (single `<workspace_instructions>`, no `<project_instructions>`).
- `npm run typecheck` + `npm run lint` clean.

---

## 10. Rollout / risks

- **Risk:** `noContextFiles: true` also disables pi discovery in **parent** directories, which
  the app's cwd-root-only loader does _not_ replicate. Users who relied on a `CLAUDE.md` in a
  _parent_ repo dir (found by pi, ignored by the app) will lose it. **Mitigation:** call this out
  in release notes; a future enhancement could add opt-in parent-walk to the app loader. Given the
  desktop app's per-session cwd model, root-only is the expected scope.
- **Risk:** users who deliberately set "None" now get truly-empty instructions (previously pi
  still injected). **Mitigation:** release note; the toggle default is _on_ for everyone else.
- **No new dependencies.** Reordering uses up/down buttons.

---

## 11. File-change checklist

- [x] `src/shared/system-prompt-file-choices.ts` — priority constants + validators (Phase 1)
- [x] `src/main/utils/workspace-system-prompt.ts` — list resolver + `resolvedFile` (Phase 2)
- [ ] `src/main/claude/agent-runner.ts` — `noContextFiles: true`, new loader args (Phase 3)
- [x] `src/main/config/config-store.ts` — fields, defaults, keys, normalizer+migration, update (Phase 4, 7)
- [ ] `src/main/index.ts` — `getStatus` + `settings.update` handlers (Phase 5)
- [ ] `src/shared/workspace-instructions-status.ts` — `resolvedFile` (Phase 5)
- [ ] `src/renderer/types/index.ts`, `store/index.ts`, `hooks/useIPC.ts` — fields (Phase 6)
- [ ] `src/renderer/components/settings/SettingsPrompt.tsx` — toggle + reorder list (Phase 6)
- [ ] `src/renderer/components/WorkspaceInstructionsBadge.tsx` — show resolved file (Phase 6)
- [ ] `src/renderer/i18n/locales/{en,zh,hu,ru}.json` — strings (Phase 7)
- [ ] Tests: validator, loader, migration (Phase 9)
