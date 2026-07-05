# Rebrand: Open Cowork → Sqowe Pilot — Implementation Plan

**Status:** Complete (as of 2026-07-04) — all batches landed. Remaining items are the
deferred future-work topics in [§8](#8-open-questions--future-work) (auto-update channel,
GitLab CI). The GitHub `issue-auto-response` workflow was kept by decision (see [§5.3](#53-batch-3--remove-dead-files--repoint-urls-task-1--low-risk)).
**Date:** 2026-06-19 (plan) · 2026-07-04 (completed)
**Author:** Mike Obodnikov + AI-assisted design session
**Scope:** Whole-product rebrand of the fork from "Open Cowork" to "Sqowe Pilot",
including packaging identity, on-disk data migration, documentation, removal of dead
upstream plumbing, and a feature-differentiation document.

> This is a fork of [Open Cowork](https://github.com/OpenCoworkAI/open-cowork) (MIT).
> The fork has diverged substantially and is now developed as a standalone product,
> **Sqowe Pilot**, hosted privately on GitLab
> (`ssh://git@gitlab.obodnikov.com:2222/mike/sqowe-pilot.git`).

---

## 1. Overview & Context

The rebrand is now **complete** (2026-07-04). A prior session (see
`docs/chats/rebranding-application-name-from-open-cowork-to-sqowe-pilot-2026-05-19.md`)
produced a full rename map but only executed its **🔴 Critical (user-facing UI)** group.
This plan finished the rest: packaging identity, on-disk data paths + first-launch
migration, runtime cosmetics (incl. internal `OPEN_COWORK_*` → `SQOWE_PILOT_*` env vars),
documentation, and removal of dead upstream GitHub plumbing. Encryption seeds and the four
`projectName` store values are intentionally left as `open-cowork` for data-decryption
compatibility.

This document was the authoritative plan to finish the rebrand cleanly, **without breaking
existing users' data**, and to record why Sqowe Pilot is a distinct product. The batch
sections below are retained as the as-built record.

### 1.1 Already done ✅

- Renderer UI strings → "Sqowe Pilot" (`Sidebar`, `WelcomeView`, `ChatView`,
  `SettingsPanel`, `SettingsGeneral`, `index.html`)
- i18n locales (`en`, `zh`, plus fork-added `ru`, `hu`) carry Sqowe strings
- Default system prompts → Sqowe Pilot identity (`src/main/prompts/prompt-loader.ts`)
- Purple brand palette (`src/renderer/styles/globals.css`) + brandbook
  (`docs/AI_WEB_DESIGN_SQOWE.md`)
- Application icons & logos replaced with Sqowe branding (`resources/icon.*`,
  `resources/logo.png`, `resources/tray-icon*.png`, `public/*`) — filenames are generic,
  so **no file renames are required**
- Version already carries the fork marker: `3.3.0-sqowe.8`

### 1.2 Still "Open Cowork" / "open-cowork" ❌

113 files across packaging, data paths, runtime cosmetics, docs, GitHub plumbing, and
tests. Full inventory in [§9 Appendix](#9-appendix--file-inventory).

---

## 2. Goals & Non-Goals

### Goals

1. Complete the brand change across packaging, OS identity, runtime, and docs.
2. **Migrate existing user data** from the legacy data directory to the new one on first
   launch — losslessly, including the encrypted config.
3. Remove upstream plumbing that cannot run on the new (GitLab) home; repoint URLs.
4. Preserve required attribution to the upstream MIT project.
5. Produce a comprehensive feature-differentiation document.

### Non-Goals

- Re-theming / visual redesign (already done in a prior session).
- Re-creating GitHub Actions automation as GitLab CI (deferred; see [§8](#8-open-questions--future-work)).
- Changing the encryption scheme or rotating keys (explicitly avoided — see [§5.2](#52-encryption-seeds--do-not-rename)).

---

## 3. Key Decisions

| #   | Decision                                | Choice                                                                            | Rationale                                                                                                                                 |
| --- | --------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | On-disk data directory                  | **Rename `open-cowork` → `sqowe-pilot` + migrate**                                | Clean brand on disk; matches product split. Requires first-launch migration.                                                              |
| 2   | Bundle identifier (`appId`)             | **`com.opencowork.app` → `com.sqowe.pilot`**                                      | Correct for a distinct product. New code-signing identity; auto-update treats it as a new app (acceptable — private GitLab distribution). |
| 3   | Upstream GitHub plumbing                | **Remove dead CI + repoint URLs to GitLab; keep one attribution link**            | GitHub-only workflows can't run on GitLab; repo URLs must point home.                                                                     |
| 4   | First Sqowe Pilot version               | **`1.0.0`**                                                                       | Fresh product identity; clean break from the `3.3.0-sqowe.N` fork-marker series.                                                          |
| 5   | Encryption seed strings                 | **Leave unchanged** (`open-cowork-*-stable-v1`, salts, legacy keys)               | Opaque salts; the brand word is cosmetic. Renaming makes migrated `config.json` undecryptable.                                            |
| 6   | `projectName: 'open-cowork'` (4 stores) | **Leave unchanged**                                                               | Inert inside Electron (electron-store uses `app.getPath('userData')`); only a fallback for non-Electron test contexts.                    |
| 7   | Migration "is this my fork?" gate       | **Fork fingerprint** (legacy `prompts/` Sqowe identity) + forward `.brand` marker | Old `sqowe.N` builds never persisted their version, so the version string can't be read retroactively; fingerprint is the reliable proxy. |

---

## 4. Current-State Mechanics (verified)

### 4.1 How the data directory name is derived

- `package.json` has **`name: "open-cowork"`**, **no `productName`** field, and the main
  process makes **no `app.setName()` call**.
- Therefore at runtime `app.getName()` → `"open-cowork"` and
  `app.getPath('userData')` → `<appData>/open-cowork`:
  - macOS: `~/Library/Application Support/open-cowork`
  - Windows: `%APPDATA%/open-cowork`
  - Linux: `~/.config/open-cowork`
- This is corroborated by MCP child processes (no Electron `app`) that **hardcode** the
  same path (`src/main/mcp/mcp-logger.ts`, `src/main/mcp/gui-operate-server.ts`). They
  must match the Electron userData dir, so the real dir is `open-cowork`.
- `electron-builder.yml`'s `productName: Open Cowork` only affects the packaged bundle name
  (`Open Cowork.app`, `CFBundleName`), **not** `app.getName()`.

**Consequence:** changing `package.json` `name` to `sqowe-pilot` (and/or calling
`app.setName('sqowe-pilot')`) changes `app.getPath('userData')` to `<appData>/sqowe-pilot`,
**orphaning all existing user data** — hence the migration in [§6](#6-batch-5--data-migration-the-careful-one).

### 4.2 What lives in the data directory

| Path (under `<appData>/open-cowork/`) | Owner                                      | Sensitive?                                                                            |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `config.json`                         | `ConfigStore` (electron-store)             | **Encrypted** (API keys)                                                              |
| `mcp-config.json` (and related)       | `mcp-config-store.ts`                      | Possibly secrets                                                                      |
| `remote-config.json`                  | `remote-config-store.ts`                   | **Encrypted**                                                                         |
| `cowork.db`                           | `src/main/db/database.ts` (better-sqlite3) | Chat history, sessions                                                                |
| `prompts/`                            | `prompt-loader.ts`                         | System prompt sections (**fork fingerprint lives here**)                              |
| `memory/`                             | `memory-service.ts`                        | `core_memory.json`, `experience_memory.json`, `session_state.json`, `eval-artifacts/` |
| `plugin registry`                     | `plugin-registry-store.ts`                 | Installed plugin metadata                                                             |
| `claude/skills/`                      | runtime skills dir                         | Built-in + synced skills                                                              |
| `default_working_dir/`                | `initializeDefaultWorkingDir()`            | Default workspace                                                                     |
| `logs/`                               | `mcp-logger.ts`, `logger.ts`               | Logs (safe to skip on copy)                                                           |

### 4.3 Encryption

`createEncryptedStoreWithKeyRotation` derives keys from seed strings containing
`open-cowork` (e.g. `open-cowork-config-stable-v1`, salt `open-cowork-config-salt`), with a
`legacyKeys` rotation path already wired. **Because the migration copies `config.json`
byte-for-byte and the seeds are unchanged, the migrated config decrypts transparently.**

### 4.4 Auto-update

`electron-builder.yml` ends with `publish: { provider: github }` pointing implicitly at the
upstream repo. For a private GitLab fork this is **broken/irrelevant**; see
[§8](#8-open-questions--future-work).

---

## 5. Batches 1–4 — Rebrand the surface

Each batch is independently committable. Order is low-risk → high-risk.

### 5.1 Batch 1 — Feature differentiation doc (task #4) · zero risk

Create `docs/SQOWE_PILOT_VS_OPEN_COWORK.md` — "Why Sqowe Pilot is not Open Cowork".
Draw from `docs/chats/` and `docs/design/`. Cover at minimum:

- **Memory subsystem** — cross-session, workspace-aware core memory; injection filtering;
  health dashboard; embedding-based retrieval; fact-staleness handling; unified memory MCP
  server for Claude tools.
- **Skills** — conflict resolution; workspace profiles; plugin archive install (`.plugin`)
  - plugin-level pinning; orchestrator skill auto-detection; version-stamped auto-update.
- **MCP** — server enable/disable toggles; "Save to Workspace" connector profiles; default
  tool permissions; LLM-generated server descriptions; orphan detection + cleanup.
- **Scheduler v2** — anacron-style fuzzy-window in-app scheduling.
- **i18n** — Russian + Hungarian added (beyond en/zh).
- **Custom MCP servers** — EU law, Hungarian law (`tools/eu-law-mcp`, `tools/hungarian-law-mcp`).
- **Bash command restrictions** — trusted/denylist, complex pipes (`BASH_COMMAND_RESTRICTIONS.md`).
- **Sandbox** — WSL/Lima isolation.
- **Corporate-CLI providers** — local model providers via corporate CLIs (kiro gateway).
- **Chat export** — markdown export.
- **Brand identity** — purple palette, new icons, Sqowe Pilot default system prompts.
- **SDK** — `@earendil-works/pi-*` 0.78.x (post scope migration).

### 5.2 Batch 2 — Documentation + attribution (task #2) · zero risk

Rebrand prose in: `README.md`, `README_zh.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`,
`ROADMAP.md`, `CHANGELOG.md`, `llms.txt`, `website/` (config, index, robots.txt, custom.css).

Add an **Attribution / NOTICE** section to `README.md` (and keep `LICENSE`):

```markdown
## Attribution

Sqowe Pilot is a fork of [Open Cowork](https://github.com/OpenCoworkAI/open-cowork),
originally released under the MIT License. The original copyright and license are retained
in [LICENSE](./LICENSE). Sqowe Pilot has since diverged substantially — see
[docs/SQOWE_PILOT_VS_OPEN_COWORK.md](./docs/SQOWE_PILOT_VS_OPEN_COWORK.md).
```

> **Encryption seeds:** do **not** rename `open-cowork-*` seed strings (see [§4.3](#43-encryption)).

### 5.3 Batch 3 — Remove dead files + repoint URLs (task #1) · low risk

**Remove:**

- `.github/workflows/codex-pr-review.yml` + `.github/prompts/codex-pr-review.md`
- ~~`.github/workflows/issue-auto-response.yml` + `.github/prompts/issue-auto-response.md`~~
  — **Kept by decision (2026-07-04):** GitHub remains the public distribution home, so
  issues live there and the issue auto-responder stays active. Not removed.
- `.github/workflows/update-homebrew.yml`
- `resources/WeChat.jpg` (upstream community asset)
- Review/trim `.github/ISSUE_TEMPLATE/*` and `CODEOWNERS` (GitHub-specific)

**Repoint:** `package.json` `homepage` / `repository.url` / `bugs.url` →
`https://gitlab.obodnikov.com/mike/sqowe-pilot`.

**Keep:** `resources/windows/Open-Cowork-Legacy-Cleanup.{ps1,cmd}` — they intentionally
target the **old** app's broken Windows installs. (Optional: rename to
`Sqowe-Pilot-Cleanup.*` while retaining detection of "Open Cowork" entries; see
[§6.5](#65-windows-legacy-handling).)

**Keep (historical record):** `docs/chats/*` — conversation exports that mention the old
name are an accurate history and should not be rewritten.

### 5.4 Batch 4 — Identity, packaging & runtime cosmetics · medium-high risk

| File                                                          | Change                                                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                | `name` → `sqowe-pilot`; `description` rebrand; **`version` → `1.0.0`**                                                                                                                               |
| `package.json`                                                | Add **`"productName": "Sqowe Pilot"`** (makes the name deterministic in dev + packaged)                                                                                                              |
| `electron-builder.yml`                                        | `productName: Sqowe Pilot`; `appId: com.sqowe.pilot`; `copyright`; macOS DMG `name: Sqowe Pilot.app`; `NSScreenCaptureUsageDescription` / `NSAccessibilityUsageDescription`; review `publish:` block |
| `scripts/notarize.js`                                         | `appId: 'com.sqowe.pilot'`                                                                                                                                                                           |
| `scripts/deploy-local.sh`                                     | `APP_NAME="Sqowe Pilot"`                                                                                                                                                                             |
| `src/main/index.ts`                                           | tray tooltip, startup log, error dialog; **data-dir string literals** → `sqowe-pilot`                                                                                                                |
| `src/main/utils/logger.ts`                                    | log file header                                                                                                                                                                                      |
| `src/main/mcp/mcp-logger.ts`                                  | hardcoded data-dir path → `sqowe-pilot`                                                                                                                                                              |
| `src/main/mcp/gui-operate-server.ts`                          | hardcoded data-dir path + permission hint strings + OpenRouter referrer/title                                                                                                                        |
| `src/main/mcp/mcp-manager.ts`                                 | MCP client name `'open-cowork'` → `'sqowe-pilot'`                                                                                                                                                    |
| `src/main/mcp/software-dev-server-example.ts`                 | OpenRouter referrer/title headers                                                                                                                                                                    |
| `src/main/tools/tool-executor.ts`, `sandbox-tool-executor.ts` | User-Agent strings                                                                                                                                                                                   |
| `src/main/skills/plugin-catalog-service.ts`                   | User-Agent string                                                                                                                                                                                    |
| `src/renderer/components/remote/PairingGuideCard.tsx`         | localStorage key — rename **with backward-compatible read**                                                                                                                                          |

> **Leave unchanged:** the four `projectName: 'open-cowork'` values and all encryption seed
> strings ([§4.3](#43-encryption), Decisions 5–6).

**Backward-compatible localStorage** pattern (avoid losing existing pairing state):

```ts
const NEW_KEY = 'sqowe-pilot.pairing';
const OLD_KEY = 'open-cowork.pairing';
function readPairing(): string | null {
  return localStorage.getItem(NEW_KEY) ?? localStorage.getItem(OLD_KEY);
}
```

---

## 6. Batch 5 — Data migration (the careful one) · task #3

### 6.1 Where it runs

New module `src/main/migration/migrate-legacy-data.ts`, invoked **once** in
`src/main/index.ts` during `app.whenReady()`, **after** `app.setName('sqowe-pilot')` (or the
`productName` resolution) and **before** any store/database/memory initialization.

```
app.whenReady()
  └─ app.setName('sqowe-pilot')          // deterministic userData dir
  └─ migrateLegacyDataIfNeeded()         // ← NEW, blocking, synchronous
  └─ initialize ConfigStore, DB, memory, MCP, …
```

### 6.2 Algorithm

```
newDir    = app.getPath('userData')                    // .../sqowe-pilot
legacyDir = path.join(app.getPath('appData'), 'open-cowork')

1. If exists(newDir/.brand) → return (already migrated/native sqowe install).
2. If exists(newDir/config.json) → write .brand, return (fresh sqowe install; nothing to migrate).
3. If !exists(legacyDir) → write .brand, return (clean machine).
4. If !isForkInstall(legacyDir) → return WITHOUT writing .brand
        (pristine upstream open-cowork — leave it untouched, do not adopt its data).
5. Copy legacyDir → newDir:
        - include: config.json, mcp-config*.json, remote-config.json, cowork.db,
          prompts/, memory/, plugin registry, claude/skills/, default_working_dir/
        - skip:    logs/ and any *cache* (regenerated)
        - never overwrite files already present in newDir
6. Write newDir/.brand = { product: 'sqowe-pilot', version: app.getVersion(),
                           migratedFrom: 'open-cowork', migratedAt: ISO }
7. Log a summary; surface a one-time toast in the renderer (optional).
```

> **Copy, not move.** The legacy dir is left intact so a rollback to an old build still
> works and the user is never at risk of data loss. A later "clean up old data" action can
> remove it.

### 6.3 The fork gate — `isForkInstall(legacyDir)`

The user's intent: _only migrate data that belongs to this fork_ ("if the old version had
`sqowe` in it"). Old `3.3.0-sqowe.N` builds did not persist their version on disk, so the
version string cannot be read retroactively. Use a **fingerprint** instead:

```
isForkInstall(legacyDir):
  return fileContains(legacyDir/prompts/identity.md, 'Sqowe Pilot')
      || exists(legacyDir/.brand)            // future-proof
      || /* optional secondary fingerprints: ru/hu prompt sections, sqowe config keys */
```

Rationale: the fork shipped a Sqowe Pilot identity prompt to the runtime `prompts/` dir
(confirmed in `docs/chats/update-default-system-prompts-to-sqowe-pilot-identity-2026-06-05.md`).
A pristine upstream install will not have it → it is correctly skipped.

**Forward-compatibility:** once any sqowe-pilot build writes `.brand`, all subsequent
migrations are exact (no fingerprinting needed). The `.brand` marker is the durable
version/identity record the old builds lacked.

### 6.4 Cross-platform paths

`app.getPath('appData')` already resolves correctly per-OS, so both `newDir` and `legacyDir`
derive from it. No platform branching needed beyond what `appData` provides.

### 6.5 Windows legacy handling

Keep `resources/windows/Open-Cowork-Legacy-Cleanup.{ps1,cmd}` as a **separate** concern — it
removes broken _installs_ (Programs dir, uninstall registry entries), which is unrelated to
the per-user data migration above. After rebrand, the NSIS installer + uninstaller IDs
change (new `appId`), so old and new can coexist; the migration adopts the old **data**,
and the cleanup script (run manually) can remove the old **install** if desired.

### 6.6 Tests

`tests/migrate-legacy-data.test.ts` with a temp-dir harness:

| Case                           | Setup                                                           | Expected                        |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------- |
| Fork legacy present, new empty | `open-cowork/` with Sqowe `prompts/identity.md` + `config.json` | Copies data, writes `.brand`    |
| Pristine upstream legacy       | `open-cowork/` **without** Sqowe fingerprint                    | **Skips**, no copy, no `.brand` |
| Already migrated               | `sqowe-pilot/.brand` exists                                     | No-op                           |
| Fresh sqowe install            | `sqowe-pilot/config.json`, no legacy                            | Writes `.brand`, no copy        |
| No legacy at all               | empty appData                                                   | No-op, writes `.brand`          |
| Never overwrites               | both dirs have `config.json`                                    | New file preserved              |

---

## 7. Test, version & rollout

### 7.1 Update existing tests asserting the old name

- `tests/chat-view-claude-layout.test.ts`
- `tests/welcome-view-claude-layout.test.ts`
- `tests/windows-legacy-uninstall-remediation.test.ts`
- `tests/store-encryption.test.ts` (verify it asserts on **derived keys**, not the brand
  word; should remain green since seeds are unchanged)
- `tests/prompt-loader.test.ts` (already references Sqowe — verify still green)

### 7.2 Version

`package.json` `version` → **`1.0.0`**. Add a `CHANGELOG.md` entry: "1.0.0 — Rebrand to
Sqowe Pilot; first-launch data migration from legacy `open-cowork` directory."

### 7.3 Suggested commit sequence (Conventional Commits)

1. `docs: add Sqowe Pilot vs Open Cowork feature differentiation` (Batch 1)
2. `docs: rebrand documentation to Sqowe Pilot and add upstream attribution` (Batch 2)
3. `chore: remove dead GitHub CI and repoint repo URLs to GitLab` (Batch 3)
4. `feat: rebrand packaging identity and runtime to Sqowe Pilot` (Batch 4)
5. `feat(migration): migrate legacy open-cowork user data on first launch` (Batch 5)
6. `chore: release 1.0.0` (version bump + CHANGELOG)

### 7.4 Verification checklist (before release)

- [ ] `npm run typecheck` and `npm run lint` clean
- [ ] `npm test` green (incl. new migration tests)
- [ ] Dev run: confirm data dir is now `<appData>/sqowe-pilot` and prior data appears
- [ ] Confirm encrypted API keys still load (migrated `config.json` decrypts)
- [ ] `grep -rI "Open Cowork\|open-cowork\|opencowork"` — only intentional residue remains
      (encryption seeds, `projectName`, attribution links, `docs/chats/` history, legacy
      cleanup script)
- [ ] macOS packaged build launches as `Sqowe Pilot.app` with `com.sqowe.pilot`
- [ ] Windows packaged build installs/uninstalls cleanly under the new `appId`

---

## 8. Open Questions & Future Work

1. **Auto-update channel.** `publish: github` points at the upstream repo. Decide: drop
   auto-update for now, or wire a GitLab/generic release feed. (Out of scope for this plan.)
2. **GitLab CI.** GitHub Actions are removed in Batch 3; recreating equivalent CI on GitLab
   (`.gitlab-ci.yml`) is deferred.
3. **Legacy-data cleanup UX.** A future "Remove old Open Cowork data" settings action could
   delete `<appData>/open-cowork` after a successful, confirmed migration.
4. **Notarization / signing identity.** New `appId` may require updated Apple Developer ID
   / certificate configuration in `scripts/notarize.js` and CI secrets.

---

## 9. Appendix — File Inventory

> Generated from `grep -rIl` over the working tree (excluding `node_modules`, `.git`,
> `.index`, build output). Counts are approximate and will shrink as batches land.

### 9.1 `electron-builder.yml` (current branding)

```
appId: com.opencowork.app          → com.sqowe.pilot
productName: Open Cowork           → Sqowe Pilot
copyright: Copyright © 2026 Open Cowork Team → Sqowe Pilot
mac.dmg name: 'Open Cowork.app'    → 'Sqowe Pilot.app'
publish: { provider: github }      → review (§8)
```

### 9.2 Source files referencing data-dir / identity (Batch 4)

```
src/main/index.ts
src/main/utils/logger.ts
src/main/mcp/mcp-logger.ts
src/main/mcp/gui-operate-server.ts
src/main/mcp/mcp-manager.ts
src/main/mcp/software-dev-server-example.ts
src/main/tools/tool-executor.ts
src/main/tools/sandbox-tool-executor.ts
src/main/skills/plugin-catalog-service.ts
src/renderer/components/remote/PairingGuideCard.tsx
```

### 9.3 Leave-unchanged (data-safety)

```
src/main/config/config-store.ts          # projectName + encryption seeds
src/main/mcp/mcp-config-store.ts          # projectName
src/main/remote/remote-config-store.ts    # projectName + encryption seeds
src/main/skills/plugin-registry-store.ts  # projectName + tmpdir fallback
src/main/utils/store-encryption.ts        # key derivation
```

### 9.4 Docs to rebrand (Batch 2)

```
README.md, README_zh.md, ARCHITECTURE.md, CONTRIBUTING.md, ROADMAP.md,
CHANGELOG.md, llms.txt, BASH_COMMAND_RESTRICTIONS.md,
website/.vitepress/config.ts, website/.vitepress/theme/custom.css,
website/index.md, website/zh/index.md, website/public/robots.txt
```

### 9.5 Remove (Batch 3)

```
.github/workflows/codex-pr-review.yml + .github/prompts/codex-pr-review.md
.github/workflows/issue-auto-response.yml + .github/prompts/issue-auto-response.md
.github/workflows/update-homebrew.yml
resources/WeChat.jpg
(review) .github/ISSUE_TEMPLATE/*, CODEOWNERS
```

### 9.6 New files

```
docs/SQOWE_PILOT_VS_OPEN_COWORK.md         # Batch 1
src/main/migration/migrate-legacy-data.ts  # Batch 5
tests/migrate-legacy-data.test.ts          # Batch 5
```
