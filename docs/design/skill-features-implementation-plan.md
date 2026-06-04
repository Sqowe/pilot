# Skill Features Implementation Plan

**Created:** 2026-06-04
**Status:** In Progress
**Covers:** Skill Conflict Resolution + Skill Workspace Profiles
**Design docs:** [skill-conflict-resolution.md](./skill-conflict-resolution.md), [skill-workspace-profiles.md](./skill-workspace-profiles.md)

---

## Overview

Two orthogonal skill features to implement:

- **Conflict Resolution** — determines which _version_ of a skill is used when the same
  name exists in multiple sources (built-in vs custom)
- **Workspace Profiles** — determines _whether_ a skill is loaded at all for a given
  session/workspace (available → pinned → removed)

These features share infrastructure (types, config store, preload bridge) but solve
different problems. This plan interleaves them to minimize rework and ship incremental value.

---

## Dependency Graph

```
Phase 0 (shared types/config)  ✅ DONE
   ├──► Phase 1 (conflict engine) ✅ DONE ──► Phase 3 (conflict UI)──┐
   │                                                                   │
   └──► Phase 2 (session disable + workspace profile) ✅ DONE        ├──► Phase 6 (polish)
              │                                                        │
              ├──► Phase 4 (Context Panel UI) ─────────────────────────┘
              │
              └──► Phase 5 (Welcome page)
```

Phases 1 and 2 can run **in parallel** after Phase 0.
Phases 3, 4, and 5 can also run in parallel once their respective backends are complete.

---

## Phase 0: Shared Foundation ✅ DONE

**Completed:** 2026-06-04
**Estimate:** 1–2 days
**Depends on:** Nothing
**Unlocks:** Phase 1, Phase 2

### Tasks

- [x] 0.1 — Extend `Skill` interface in `src/renderer/types/index.ts` with new fields:
  - `source?: SkillSource` (imported from shared types)
  - `sourcePath?: string`
  - `hasConflict?: boolean`
  - `conflictSources?: SkillSource[]`
  - `isActive?: boolean`
- [x] 0.2 — Add shared type definitions in `src/shared/skill-conflict-types.ts`:
  - `SkillConflictConfig` interface
  - `SkillsWorkspaceProfile` interface
  - `SkillSource` type union
  - `ConflictPolicy` type union
  - `DEFAULT_SKILL_CONFLICT_CONFIG` frozen constant
  - `createDefaultSkillConflictConfig()` factory (mutation-safe)
  - `normalizeSkillConflictConfig()` with `isValidSkillId` validation, dedup, caps
  - `isValidConflictPolicy()` / `isValidSkillSource()` validators
- [x] 0.3 — Add `skillConflictConfig` key to config store (electron-store) with defaults
  - Normalization via `normalizeSkillConflictConfig` in `getAll()`
- [x] 0.4 — Add preload bridge + IPC handlers for all new endpoints:
  - Conflict: `getConflictConfig`, `setConflictPolicy`, `setSourceOverride`,
    `toggleDisabled`, `acknowledgeConflict`, `getConflicts`, `resetToBuiltin`
  - Profiles: `toggleSessionDisabled`, `getSessionDisabledSkills`,
    `getWorkspaceProfile`, `saveWorkspaceProfile`
  - All handlers include: `isValidSkillId` validation, size caps (200 entries),
    runtime type checks, workspace CWD authorization, symlink rejection,
    atomic file writes (`O_CREAT|O_EXCL` + `renameSync`)
- [x] 0.5 — Add i18n keys to `en.json` and `zh.json` for both features
- [x] 0.6 — Add server event types to `ServerEvent` union:
  - `skills.conflict-detected`
  - `skills.conflict-resolved`
  - `skills.session-disabled-changed`

### Key Files

- `src/shared/skill-conflict-types.ts` (new)
- `src/renderer/types/index.ts` (extended Skill + ServerEvent)
- `src/main/config/config-store.ts` (AppConfig + defaults + normalization)
- `src/preload/index.ts` (IPC bridge)
- `src/main/index.ts` (IPC handlers with security validation)
- `src/renderer/i18n/locales/en.json`, `zh.json` (i18n keys)
- `tests/skill-conflict-types.test.ts` (24 tests)

### Notes from Code Review

- All IPC handlers implement workspace CWD authorization (same pattern as MCP profiles)
- `saveWorkspaceProfile` uses atomic writes with crypto-random temp files and `O_CREAT|O_EXCL`
- `getWorkspaceProfile` uses `lstatSync` + `realpathSync` to reject symlinks
- `resetToBuiltin` sets `sourceOverrides[name] = 'builtin'` (works under `custom-wins` policy)
- `getConflicts` returns `{ conflicts: [], notImplemented: true }` until Phase 1
- `toggleSessionDisabled` returns not-implemented error until Phase 2
- Remaining tech debt: concurrent config mutations could use a serialize helper (low risk in Electron)

---

## Phase 1: Conflict Detection & Policy Engine ✅ DONE

**Completed:** 2026-06-04
**Estimate:** 2–3 days
**Depends on:** Phase 0 ✅
**Unlocks:** Phase 3

### Tasks

- [x] 1.1 — Create `src/main/skills/skill-conflict-detector.ts`:
  - `discoverAllSkillSources(builtinDir, userDir, configuredDir, projectDir?)` → map of
    skill name → array of `{ source, path }`
  - `detectConflicts(sources, config)` → array of `SkillConflict` objects (filters disabled, non-builtin under ask)
  - `resolveConflict(skillName, sources, config)` → winning source with priority resolution
  - `computeSyncActions(sourceMap, config, runtimeDir)` → planned sync actions
  - `getNewConflicts(sourceMap, config)` → only unacknowledged conflicts
- [x] 1.2 — Modify `syncUserSkillsToAppDir()` in `agent-runner.ts` to:
  - Read `skillConflictConfig` from config store via `resolveSkillSyncDecision()`
  - Check `disabledSkills` list (returns 'disabled' → removes runtime entry without restoring)
  - Check `sourceOverrides` per skill (use explicit choice)
  - Apply `conflictPolicy` for unresolved conflicts
  - Validate SKILL.md + isValidSkillId before processing (matches detector rules)
  - Replace built-in with user's symlink when custom-wins (only for known builtin copies)
  - Handle user-vs-configured conflicts (configured > user priority)
- [x] 1.3 — Add `emitSkillConflict(skillName, customPath, builtinPath)` method to agent runner
  - Sends `skills.conflict-detected` event to renderer via IPC
  - Guards `getBuiltinSkillsPath()` for null safety
- [x] 1.4 — Wire `skills.getConflicts` IPC handler to real detection:
  - Scans builtin, user, and configured directories
  - Returns `{ conflicts, notImplemented: false }`
  - Project-level excluded until project sync is implemented
- [x] 1.5 — Migration logic:
  - Config normalization via `normalizeSkillConflictConfig` handles missing config
  - `.user-modified` markers continue to work via existing hash-based sync loop
  - Full migration to `sourceOverrides` deferred to Phase 6 (Settings UI)
- [x] 1.6 — Unit tests (`tests/skill-conflict-detector.test.ts`):
  - 26 tests covering discovery, detection, all 3 policies, overrides, disabled skills,
    user-vs-configured conflicts, sync actions, new-conflict filtering
- [x] 1.7 — Security hardening (from code review):
  - `removeDisabledSkillsFromRuntime`: validates skill IDs + path containment
  - `removeRuntimeSkillEntry`: only removes known managed builtin copies (not user data)
  - Link paths: guards `source !== target`, only `rmSync` for `_builtinSkillNames` entries
  - `syncConfiguredSkillsToRuntimeDir`: same policy-aware behavior as user sync
  - `populateBuiltinSkillNames`: validates with `SAFE_SKILL_ID_REGEX` + SKILL.md
  - `hasUserConfiguredConflict`: requires SKILL.md + valid directory
  - `removeStaleSymlink`: uses `lstatSync` for broken symlink detection
  - `restoreBuiltinSkill`: handles broken symlinks at target path

### Key Files

- `src/main/skills/skill-conflict-detector.ts` (new — 300 lines)
- `src/main/claude/agent-runner.ts` (modified sync methods + 7 new private helpers)
- `src/main/index.ts` (`skills.getConflicts` wired to real detection)
- `tests/skill-conflict-detector.test.ts` (new — 26 tests)

### Notes from Code Review

- Sync decisions are source-based (via `_builtinSkillNames` + `hasUserConfiguredConflict`),
  not runtime-state-based, ensuring policy changes take effect regardless of stale symlinks
- `removeDisabledSkillsFromRuntime` runs as a final pass after all sync operations,
  ensuring built-in-only disabled skills are properly removed
- Non-builtin real directories are never recursively deleted — only symlinks (safe) and
  verified managed builtin copies (checked via `_builtinSkillNames` + path containment)
- Remaining tech debt: centralize path discovery between IPC and runner, deduplicate
  conflict emissions, integration tests for agent-runner sync methods

---

## Phase 2: Session-Level Skill Disable & Workspace Profile ✅ DONE

**Completed:** 2026-06-04
**Estimate:** 2–3 days
**Depends on:** Phase 0 ✅
**Unlocks:** Phase 4, Phase 5

### Tasks

- [x] 2.1 — Add `sessionDisabledSkills: Map<string, Set<string>>` to `SessionManager`
  - `toggleSessionDisabledSkill(sessionId, skillId, disabled)` method with cap (200)
  - `getSessionDisabledSkills(sessionId)` method
  - Cleanup on session delete (like `sessionPinnedSkills`)
  - Cross-format ID reconciliation via `SessionManager.stripKnownPrefix()`
- [x] 2.2 — Modify agent-runner `resolveSkillPaths` to filter disabled skills:
  - Detects individual skill dirs (has SKILL.md) vs parent dirs
  - Expands parent dirs into children, filtering disabled by bare name
  - Strips known prefixes (`builtin-`, `global-`, `configured-`, `project-`) for matching
- [x] 2.3 — Create `src/main/skills/skills-workspace-profile.ts`:
  - `loadSkillsWorkspaceProfile(cwd)` — mtime cached, deduped, capped at 200
  - `invalidateSkillsWorkspaceProfileCache()` — for testing
  - Security: `lstatSync` (rejects symlinks), 64KB size limit, `realpathSync` boundary check
  - Caches parse failures to avoid repeated re-reads
- [x] 2.4 — Seed session state from workspace profile on `session.start`:
  - Load profile from validated cwd (uses `getWorkspacePathUnsupportedReason` + loader's own checks)
  - Seed `sessionDisabledSkills` from `profile.disabled`
  - Seed `sessionPinnedSkills` from `profile.pinned` (validated against installed skills)
  - Handle `initialDisabledSkills` from session.start payload
  - Pinned-wins-over-disabled enforced with cross-format comparison
- [x] 2.5 — Wire IPC handlers to real implementations:
  - `skills.toggleSessionDisabled` → calls SessionManager, emits event with pinnedSkills
  - `skills.getSessionDisabledSkills` → returns current set
  - `skills.getWorkspaceProfile` → delegates to `loadSkillsWorkspaceProfile` (with cwd auth)
  - `skills.saveWorkspaceProfile` → unchanged (Phase 0 implementation)
- [x] 2.6 — Add `initialDisabledSkills` to ClientEvent session.start payload type
  - Runtime validation: `Array.isArray` check, `isValidSkillId` filter, 200 cap
- [x] 2.7 — Unit tests (`tests/skills-workspace-profile.test.ts`):
  - 11 tests covering: load valid/missing/invalid, pinned-only/disabled-only,
    invalid ID filtering, mtime caching, cache invalidation, empty object

### Key Files

- `src/main/session/session-manager.ts` (extended: disabled skills + cross-format reconciliation)
- `src/main/skills/skills-workspace-profile.ts` (new — secure loader with cache)
- `src/main/claude/agent-runner.ts` (resolveSkillPaths filtering + getSessionDisabledSkills)
- `src/main/index.ts` (IPC handlers wired + session.start seeding + stripKnownPrefix helper)
- `src/renderer/types/index.ts` (ClientEvent + ServerEvent payload updates)
- `tests/skills-workspace-profile.test.ts` (new — 11 tests)

### Notes from Code Review

- `SessionManager.stripKnownPrefix()` centralizes prefix stripping for cross-format comparison
- Pinned-wins invariant enforced in three places: `toggleSessionPinnedSkill`, `toggleSessionDisabledSkill`, and `startSession` initial disabled filtering
- Workspace profile loading uses loader's built-in security (lstat + realpath boundary + size limit), not redundant IPC-level checks
- `skills.session-disabled-changed` event includes `pinnedSkills` for renderer reconciliation
- Remaining tech debt: integration tests for session lifecycle + agent filtering, SKILL.md validation when expanding parent dirs

---

## Phase 3: Conflict Resolution UI

**Estimate:** 2–3 days
**Depends on:** Phase 1 ✅
**Unlocks:** Phase 6

### Tasks

- [ ] 3.1 — Add "Conflict Resolution" section to Settings → Skills page:
  - Radio buttons: Custom wins / Built-in wins / Ask me each time
  - Calls `skills.setConflictPolicy` on change
  - Shows only when conflicts exist or user has custom skills
- [ ] 3.2 — Enhance skill list cards in Settings:
  - Source indicator badge (Built-in / User / Project / Configured)
  - Conflict warning icon when `hasConflict === true`
  - Per-skill source dropdown (only visible for conflicted skills)
  - Calls `skills.setSourceOverride` on dropdown change
- [ ] 3.3 — Add disable/enable toggle per skill card:
  - Calls `skills.toggleDisabled`
  - Muted styling when disabled
- [ ] 3.4 — Add "Reset to built-in" action button on conflicted skill cards
- [ ] 3.5 — Implement conflict toast notification component:
  - Shown once on new conflict detection (listen to `skills.conflict-detected` event)
  - Informational toast when policy is `custom-wins` or `builtin-wins`
  - Decision dialog when policy is `ask`
  - Buttons: Use Custom / Use Built-in / Open Settings
- [ ] 3.6 — Track acknowledged conflicts:
  - Toast dismissed → add to `acknowledgedConflicts` via `skills.acknowledgeConflict`
  - Don't re-show for same conflict

### Key Files

- `src/renderer/components/SettingsSkills.tsx` (extend or create)
- `src/renderer/components/SkillConflictToast.tsx` (new)
- `src/renderer/hooks/useSkillConflicts.ts` (new)

### Acceptance Criteria

- Settings page shows policy selector and skill list with conflict indicators
- Changing policy triggers re-resolution (skill list updates)
- Toast appears once per new conflict, respects acknowledgment
- "Ask me" dialog correctly captures user decision

---

## Phase 4: Workspace Profiles UI — Context Panel

**Estimate:** 2–3 days
**Depends on:** Phase 2 ✅
**Unlocks:** Phase 6

### Tasks

- [ ] 4.1 — Add [✕] remove button to each skill chip in Context Panel sidebar
  - Calls `skills.toggleSessionDisabled(sessionId, skillId, true)`
  - Skill moves to "Removed" section
- [ ] 4.2 — Add "Removed" collapsible section at bottom:
  - Muted/strikethrough styling (mirror MCP disabled servers pattern)
  - [+] restore button per skill → calls `toggleSessionDisabled(…, false)`
- [ ] 4.3 — Update section header with counter: `PINNED SKILLS (3/14 active · 6 removed)`
  - `pinned` = skills with filled star
  - `active` = total loaded (pinned + available, not removed)
  - `removed` = disabled count
- [ ] 4.4 — Add 💾 save button to section header:
  - Visible when session state differs from workspace profile
  - Compare current pinned + disabled sets vs loaded workspace profile
  - On click: calls `skills.saveWorkspaceProfile(cwd, { pinned, disabled })`
  - Hides after successful save
  - Success/error notice (mirrors MCP save pattern)
- [ ] 4.5 — Load workspace profile on panel mount:
  - Derive initial disabled set from workspace profile
  - Show correct state when switching sessions/workspaces
- [ ] 4.6 — Handle removing a pinned skill:
  - Removing unpins automatically (Pin + Remove = invalid)
  - Star disappears, skill moves to Removed section

### Key Files

- `src/renderer/components/ContextPanel.tsx` (extend skills section)
- `src/renderer/utils/skills-profile-derive.ts` (new, mirror `mcp-profile-derive.ts`)

### Acceptance Criteria

- Users can remove skills mid-conversation via [✕] button
- Removed skills are visually distinct and restorable via [+]
- 💾 button correctly reflects dirty state vs workspace profile
- Saving writes correct `.cowork/skills-profile.json`
- State resets correctly on session/workspace switch

---

## Phase 5: Welcome Page Integration

**Estimate:** 1–2 days
**Depends on:** Phase 2 ✅
**Unlocks:** Phase 6

### Tasks

- [ ] 5.1 — Load workspace profile when workspace is selected on Welcome page:
  - Call `skills.getWorkspaceProfile(workingDir)` on mount / workspace change
  - Pre-set removed skills from `profile.disabled`
  - Pre-set pinned skills from `profile.pinned`
- [ ] 5.2 — Show three visual states for skill cards:
  - ★ Pinned (filled star, accent color)
  - ☆ Available (empty star, normal)
  - ✕ Removed (muted, strikethrough or dimmed)
- [ ] 5.3 — Interactions:
  - Click star on available → pin
  - Click star on pinned → unpin (back to available)
  - Click card on removed skill → restore to available
  - Right-click / long-press on available → remove
  - Or: add small ✕ icon to card corner for removal
- [ ] 5.4 — Pass both sets to session creation:
  - `initialPinnedSkills` (existing)
  - `initialDisabledSkills` (new)
- [ ] 5.5 — Footer text: `14 active · 6 removed from workspace profile`

### Key Files

- `src/renderer/components/WelcomeView.tsx` (extend skills section)
- Types for `session.start` payload (already extended in Phase 2)

### Acceptance Criteria

- Welcome page reflects workspace profile on load
- All three states render correctly and are interactive
- Starting a chat passes both pinned and disabled to session
- New session immediately respects the workspace skill profile

---

## Phase 6: Polish & Global Defaults

**Estimate:** 1–2 days
**Depends on:** Phase 3, Phase 4, Phase 5

### Tasks

- [ ] 6.1 — Add global disabled skills to config store:
  - `globalDisabledSkills: string[]` in settings
  - Settings → Skills page toggle to globally disable skills
  - Resolution: session > workspace > global > all available
- [ ] 6.2 — Skill detail view (expandable card in Settings):
  - Full description from SKILL.md
  - File paths for all sources
  - Last modified date
  - Content hash comparison for conflicts ("Files differ" / "Identical content")
  - "Open in editor" button
- [ ] 6.3 — Conflict count badge in Settings sidebar navigation
- [ ] 6.4 — Integration tests:
  - Install custom skill → app update adds built-in with same name → policy applied
  - Change policy → skill version switches → UI reflects
  - Workspace profile flow: remove in session → save → new session picks up profile
- [ ] 6.5 — Update ARCHITECTURE.md:
  - Add stability zone entries for new components
  - Update key files lists
  - Document new `.cowork/skills-profile.json` pattern
- [ ] 6.6 — Update ROADMAP.md with completed features

### Key Files

- `src/renderer/components/SettingsSkills.tsx`
- `ARCHITECTURE.md`
- `ROADMAP.md`
- `tests/skill-features-integration.test.ts` (new)

### Acceptance Criteria

- Global disable works across all workspaces
- Detail view shows meaningful conflict comparison
- Integration tests cover end-to-end flows
- Architecture docs are current

---

## Risk Assessment

| Risk                                                                        | Mitigation                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Multi-source scanner has edge cases (symlinks, dangling paths, permissions) | Test with mock filesystem; handle gracefully with fallback to built-in   |
| Pi SDK skill loading internals change                                       | Agent-runner filtering happens _before_ SDK sees paths — decoupled       |
| Workspace profile file conflicts (git merge)                                | JSON format is simple; profile is additive (just lists of IDs)           |
| Context Panel complexity grows                                              | Extract skills section into its own component (`ContextPanelSkills.tsx`) |
| Performance with 50+ skills on scan                                         | Mtime caching (proven pattern from MCP profiles), only rescan on change  |

---

## References

- Design: [skill-conflict-resolution.md](./skill-conflict-resolution.md)
- Design: [skill-workspace-profiles.md](./skill-workspace-profiles.md)
- Prior art: [skill-pinning-ux.md](./skill-pinning-ux.md) (implemented)
- Pattern: `src/main/mcp/mcp-workspace-profile.ts` (load/save/cache)
- Pattern: `src/renderer/components/ContextPanel.tsx` (MCP toggle + save)
- Constants: `src/shared/skill-pinning-constants.ts`
- Agent engine: `src/main/claude/agent-runner.ts` (`syncUserSkillsToAppDir`)
- Skills manager: `src/main/skills/skills-manager.ts` (`loadGlobalSkills`, `loadBuiltinSkills`)
