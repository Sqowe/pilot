# Stale Workspace Config Cleanup — Design Document

**Created:** 2026-06-15  
**Status:** In Progress (Phase 1–4 complete)  
**Phase 1 Implemented:** 2026-06-15  
**Phase 3–4 Implemented:** 2026-06-15  
**Author:** AI-assisted design session

---

## 1. Problem Statement

When a user removes a skill (uninstalls, disables globally) or deletes an MCP server
from the application via Settings UI, references to those entities may still persist in
the workspace `.cowork/*.json` configuration files:

- `.cowork/skills-profile.json` — `pinned` and `disabled` arrays may reference skill IDs
  that no longer exist
- `.cowork/mcp-servers.json` — `disabled` and `enabled` arrays may reference server names
  that are no longer configured

These become **orphaned entries** — configuration references pointing to nothing. They
cause no runtime errors (the app silently ignores unknown IDs), but they:

- **Confuse users** — "Why is `xlsx` still in my disabled list if I uninstalled it?"
- **Accumulate cruft** — workspace configs grow stale over time without cleanup signals
- **Break team expectations** — a teammate pulls the repo and sees references to
  skills/servers they've never installed, with no indication these are stale
- **Waste cognitive load** — users must remember to manually edit JSON files after
  uninstalling/removing things from the app

### Real-World Scenario

```
1. User installs skills: semantic-index, firecrawl, xlsx, pptx, docx
2. User configures workspace profile: disabled: ["xlsx", "pptx", "docx"]
3. User later uninstalls xlsx and pptx from the app entirely
4. .cowork/skills-profile.json still contains: disabled: ["xlsx", "pptx", "docx"]
5. User (or teammate) sees stale entries with no explanation or cleanup path
```

### Precedent in Other Tools

| Tool           | Pattern                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| Docker Compose | `WARN Found orphan containers for this project. Remove them with --remove-orphans` |
| VS Code        | Workspace trust banner — persistent info bar with action button, dismissible       |
| IntelliJ IDEA  | "Project configuration required" notification bar with "Fix" action                |
| npm            | `npm audit` warns about vulnerabilities on install, suggests `npm audit fix`       |
| Git            | `git status` shows untracked files; `git clean` requires explicit `-f` flag        |

The common pattern: **detect → inform → offer one-click fix → allow dismiss**.

---

## 2. Goals

- Detect orphaned entries in workspace config files on session/workspace activation
- Surface a non-blocking notification with clear explanation and actionable cleanup
- Provide one-click cleanup (auto-remove orphans) and optional review flow
- Allow dismissal without nagging (per-workspace "don't remind" or per-session suppress)
- Handle both skills and MCP servers in a unified flow
- Keep the detection fast (no disk I/O beyond what already happens on session start)

### Non-Goals

- Real-time file watching of `.cowork/*.json` (overkill — check on session start only)
- Preventing users from having unknown IDs in config (graceful ignore is fine at runtime)
- Migrating old config formats (separate concern)
- Cleaning up `.cowork/prompts/` or `.cowork/mcp-permissions.json` (future extension)

---

## 3. Detection Logic

### 3.1 When to Run

Detection runs **once per workspace activation**, triggered by either:

1. **App startup** with a remembered workspace CWD
2. **Working directory change** (user picks a new project folder)
3. **Session start** with a CWD that has `.cowork/` config files

Detection does NOT run:

- On every message/query
- When the user is in Settings (they might be in the middle of changes)
- If no `.cowork/` directory exists (nothing to check)

### 3.2 What to Check

```typescript
interface OrphanDetectionResult {
  /** Orphaned skill IDs found in skills-profile.json */
  orphanedSkills: {
    inPinned: string[]; // skill IDs in "pinned" that don't exist
    inDisabled: string[]; // skill IDs in "disabled" that don't exist
  };
  /** Orphaned server names found in mcp-servers.json */
  orphanedMcpServers: {
    inDisabled: string[]; // server names in "disabled" that don't exist
    inEnabled: string[]; // server names in "enabled" that don't exist
  };
  /** Total count of orphaned entries */
  totalOrphans: number;
  /** Whether a previous detection was dismissed for this workspace */
  wasDismissed: boolean;
}
```

### 3.3 Resolution Against Installed State

**Skills:** Compare profile entries against `skillsManager.getAllSkills()` which returns
all loaded skills (builtin + custom + plugin-provided). A skill ID is orphaned if:

- It's not in the `getAllSkills()` result, AND
- It's not a globally disabled skill (disabled skills are still "known")

**MCP Servers:** Compare profile entries against `mcpConfigStore.getServers()` which
returns all configured servers. A server name is orphaned if:

- No server in the config store has a matching `name` field

### 3.4 Performance

Detection piggybacks on data already loaded during session start:

- `skillsManager.getAllSkills()` is called during session creation anyway
- `mcpConfigStore.getServers()` is already in memory
- Workspace profiles are already read (mtime-cached) during session seeding

The only new work is the set-difference comparison — O(n) with n = profile entries.
No additional disk I/O required.

---

## 4. Notification UX

### 4.1 Primary: GlobalNoticeToast (Info Bar)

Uses the existing `GlobalNoticeToast` component with a new action type.

**Appearance (warning type):**

```
┌─────────────────────────────────────────────────────────────────────┐
│ ⚠️  Workspace profile references 3 skills and 1 MCP server that    │
│     are no longer installed.                                    [✕] │
│                                                                     │
│  ┌─────────────────────────────────────────┐                        │
│  │       Review & Clean Up                 │                        │
│  └─────────────────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

**Message variants:**

| Scenario    | Message                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| Skills only | "Workspace profile references {n} skill(s) that are no longer installed" |
| MCP only    | "Workspace profile references {n} MCP server(s) no longer configured"    |
| Both        | "Workspace profile has {n} stale references (skills + MCP servers)"      |
| Single item | "Workspace profile references '{name}' which is no longer installed"     |

**Behavior:**

- Appears ~2 seconds after workspace loads (avoid competing with other startup UI)
- Auto-dismiss after 10 seconds (longer than default 6s — this is actionable)
- Click [✕] → dismiss for this session
- Click "Review & Clean Up" → opens cleanup modal

### 4.2 Alternative: Context Panel Indicator (Persistent, Non-Blocking)

For users who dismiss the toast, show a subtle indicator in the Context Panel's
skills/MCP section header:

```
PINNED SKILLS (3/14 active · 6 removed · ⚠️ 2 stale)     💾   ∧
```

Clicking the "⚠️ 2 stale" badge opens the same cleanup flow.

### 4.3 Cleanup Modal

A small modal listing orphaned entries with checkboxes:

```
┌─────────────────────────────────────────────────────────────┐
│  Clean Up Workspace Profile                            [✕]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  The following entries in your workspace config reference   │
│  skills or MCP servers that are no longer installed.        │
│                                                             │
│  SKILLS (.cowork/skills-profile.json)                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ ☑ xlsx (was in "disabled")                          │    │
│  │ ☑ pptx (was in "disabled")                         │    │
│  │ ☑ my-old-skill (was in "pinned")                   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  MCP SERVERS (.cowork/mcp-servers.json)                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ ☑ old-server (was in "disabled")                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────┐    │
│  │  Remove All  │  │ Remove Selected  │  │  Dismiss   │    │
│  └──────────────┘  └──────────────────┘  └────────────┘    │
│                                                             │
│  ☐ Don't remind me for this workspace                       │
└─────────────────────────────────────────────────────────────┘
```

**Actions:**

| Button          | Behavior                                                           |
| --------------- | ------------------------------------------------------------------ |
| Remove All      | Removes all orphaned entries from both config files                |
| Remove Selected | Removes only checked entries                                       |
| Dismiss         | Closes modal, suppresses for this session                          |
| Don't remind    | Stores a "dismissed at" timestamp in config, suppresses until next |
|                 | change to the workspace profile file (mtime-based re-trigger)      |

---

## 5. Data Model

### 5.1 Dismiss State (per-workspace)

Stored in `electron-store` (not in the workspace file itself — avoids modifying the
file just to record dismissal):

```typescript
interface WorkspaceOrphanDismissal {
  /** Workspace CWD path */
  cwd: string;
  /** Timestamp when user dismissed */
  dismissedAt: number;
  /** Profile file mtimes at dismissal time (re-trigger if file changes) */
  skillsProfileMtime: number | null;
  mcpProfileMtime: number | null;
}

// In config store
interface AppConfig {
  // ... existing fields
  orphanDismissals: WorkspaceOrphanDismissal[];
}
```

**Re-trigger logic:** If the user dismisses, we record the file mtimes. If either
`.cowork/skills-profile.json` or `.cowork/mcp-servers.json` is modified after the
dismissal timestamp (by a git pull, manual edit, or save-from-UI), we show the
notification again. This prevents permanent suppression when the situation changes.

### 5.2 IPC Endpoints

| Handler                         | Payload                               | Returns                 | Purpose                      |
| ------------------------------- | ------------------------------------- | ----------------------- | ---------------------------- |
| `workspace.detectOrphans`       | `{ cwd }`                             | `OrphanDetectionResult` | Run orphan detection         |
| `workspace.cleanupOrphans`      | `{ cwd, skillIds?, mcpServerNames? }` | `{ success, removed }`  | Remove specified orphans     |
| `workspace.dismissOrphanNotice` | `{ cwd }`                             | `{ success }`           | Record dismissal with mtimes |

### 5.3 New GlobalNoticeAction

```typescript
export type GlobalNoticeAction =
  | 'open_api_settings'
  | 'navigate_settings_skills'
  | 'open_orphan_cleanup'; // NEW
```

---

## 6. Implementation Flow

### 6.1 Detection Trigger (Main Process)

```typescript
// In session start handler or workspace change handler (src/main/index.ts)
async function checkWorkspaceOrphans(cwd: string): Promise<void> {
  // 1. Check if detection was already dismissed for this workspace
  const dismissal = getDismissalForWorkspace(cwd);
  if (dismissal && !hasProfileChangedSince(cwd, dismissal)) {
    return; // User dismissed and nothing changed
  }

  // 2. Load workspace profiles (already cached from session seeding)
  const skillsProfile = loadSkillsWorkspaceProfile(cwd);
  const mcpProfile = loadWorkspaceMcpProfile(cwd);

  if (!skillsProfile && !mcpProfile) return; // No workspace configs

  // 3. Get current installed state
  const installedSkillIds = new Set(skillsManager.getAllSkills().map((s) => s.id));
  const configuredServerNames = new Set(mcpConfigStore.getServers().map((s) => s.name));

  // 4. Compute orphans
  const orphanedSkills = {
    inPinned: (skillsProfile?.pinned || []).filter((id) => !installedSkillIds.has(id)),
    inDisabled: (skillsProfile?.disabled || []).filter((id) => !installedSkillIds.has(id)),
  };
  const orphanedMcp = {
    inDisabled: (mcpProfile?.disabled || []).filter((name) => !configuredServerNames.has(name)),
    inEnabled: (mcpProfile?.enabled || []).filter((name) => !configuredServerNames.has(name)),
  };

  const total =
    orphanedSkills.inPinned.length +
    orphanedSkills.inDisabled.length +
    orphanedMcp.inDisabled.length +
    orphanedMcp.inEnabled.length;

  if (total === 0) return;

  // 5. Emit event to renderer
  mainWindow.webContents.send('server-event', {
    type: 'workspace_orphans_detected',
    payload: { orphanedSkills, orphanedMcp, total, cwd },
  });
}
```

### 6.2 Renderer Handling (useIPC.ts)

```typescript
case 'workspace_orphans_detected': {
  const { total, orphanedSkills, orphanedMcp } = event.payload;

  // Build message
  const skillCount = orphanedSkills.inPinned.length + orphanedSkills.inDisabled.length;
  const mcpCount = orphanedMcp.inDisabled.length + orphanedMcp.inEnabled.length;

  let messageKey = 'workspace.orphansDetected';
  let messageValues = { skillCount, mcpCount, total };

  store.setGlobalNotice({
    id: `workspace-orphans-${Date.now()}`,
    type: 'warning',
    messageKey,
    messageValues,
    action: 'open_orphan_cleanup',
    actionLabel: t('workspace.reviewCleanup'),
  });

  // Store orphan data for the cleanup modal
  store.setWorkspaceOrphans(event.payload);
  break;
}
```

### 6.3 Cleanup Execution (Main Process)

```typescript
ipcMain.handle('workspace.cleanupOrphans', async (_event, payload) => {
  const { cwd, skillIds, mcpServerNames } = payload;

  // Validate CWD
  const validation = validateWorkspaceCwd(cwd);
  if (!validation.valid) return { success: false, error: 'Invalid workspace' };

  let skillsRemoved = 0;
  let mcpRemoved = 0;

  // Clean skills profile
  if (skillIds?.length) {
    const profile = loadSkillsWorkspaceProfile(cwd);
    if (profile) {
      const removeSet = new Set(skillIds);
      const updated = {
        pinned: profile.pinned?.filter((id) => !removeSet.has(id)),
        disabled: profile.disabled?.filter((id) => !removeSet.has(id)),
      };
      await saveSkillsWorkspaceProfile(cwd, updated);
      skillsRemoved = skillIds.length;
    }
  }

  // Clean MCP profile
  if (mcpServerNames?.length) {
    const profile = loadWorkspaceMcpProfile(cwd);
    if (profile) {
      const removeSet = new Set(mcpServerNames);
      const updated = {
        disabled: profile.disabled?.filter((name) => !removeSet.has(name)),
        enabled: profile.enabled?.filter((name) => !removeSet.has(name)),
      };
      await saveWorkspaceMcpProfile(cwd, updated);
      mcpRemoved = mcpServerNames.length;
    }
  }

  return { success: true, removed: { skills: skillsRemoved, mcp: mcpRemoved } };
});
```

---

## 7. Timing & Debounce

| Event                   | Action                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| App startup + CWD known | Delay 3s → run detection (let skills/MCP fully initialize first)   |
| Working dir changed     | Delay 2s → run detection                                           |
| Session start           | Don't run separately (CWD change already triggered it)             |
| Skill uninstalled       | Don't run immediately (user is in Settings, not workspace context) |
| MCP server deleted      | Don't run immediately (same reason)                                |
| Profile file saved (💾) | Don't run (user just saved — they know what's in there)            |

The delay ensures `skillsManager` and `mcpConfigStore` are fully populated before
comparison. If detection is already pending for a CWD, debounce (cancel previous timer).

---

## 8. Edge Cases

| Scenario                                              | Behavior                                                |
| ----------------------------------------------------- | ------------------------------------------------------- |
| User installs a skill AFTER seeing the notification   | Next workspace activation re-checks; orphan may resolve |
| Profile has 50+ orphans (unlikely but possible)       | Modal shows scrollable list, "Remove All" is prominent  |
| `.cowork/` dir is git-tracked, teammate pushes orphan | Detection fires on next session start after git pull    |
| User has read-only filesystem                         | Cleanup fails gracefully, show error toast              |
| Both skills AND MCP orphans found                     | Single notification, combined modal                     |
| Empty profile after cleanup                           | Delete the file (existing pattern)                      |
| Detection runs but skillsManager isn't ready          | Skip silently, rely on next trigger                     |
| User re-installs the "orphaned" skill                 | It's no longer orphaned — notification won't fire       |

---

## 9. i18n Keys

```json
{
  "workspace.orphansDetected": "Workspace profile has {{total}} stale reference(s) to removed skills/servers",
  "workspace.orphansSkillsOnly": "Workspace profile references {{count}} skill(s) no longer installed",
  "workspace.orphansMcpOnly": "Workspace profile references {{count}} MCP server(s) no longer configured",
  "workspace.orphansSingle": "Workspace profile references '{{name}}' which is no longer installed",
  "workspace.reviewCleanup": "Review & Clean Up",
  "workspace.cleanupTitle": "Clean Up Workspace Profile",
  "workspace.cleanupDescription": "The following entries reference skills or MCP servers that are no longer installed.",
  "workspace.cleanupRemoveAll": "Remove All",
  "workspace.cleanupRemoveSelected": "Remove Selected",
  "workspace.cleanupDismiss": "Dismiss",
  "workspace.cleanupDontRemind": "Don't remind me for this workspace",
  "workspace.cleanupSuccess": "Removed {{count}} stale entries from workspace profile",
  "workspace.cleanupFailed": "Failed to update workspace profile",
  "workspace.sectionStale": "{{count}} stale"
}
```

---

## 10. Visual Design

### Toast Notification

- **Type:** `warning` (amber border, amber text)
- **Duration:** 10 seconds (extended from default 6s for actionable notices)
- **Position:** Top-right (existing `GlobalNoticeToast` position)
- **Action button:** "Review & Clean Up" — accent color, full-width in toast

### Context Panel Badge (Secondary Indicator)

```
PINNED SKILLS (3/14 active · 6 removed · ⚠️ 2 stale)
```

- `⚠️ N stale` shown in warning color (`text-warning`)
- Clickable → opens cleanup modal
- Disappears after cleanup or dismiss

### Cleanup Modal

- **Size:** sm (max-w-md), centered
- **Style:** Matches existing modal patterns (rounded-2xl, bg-surface, shadow-elevated)
- **Checkboxes:** All checked by default (user unchecks to keep specific entries)
- **Entry format:** `{skillId} (was in "{section}")` — e.g., `xlsx (was in "disabled")`
- **Sections:** Skills and MCP servers shown in separate groups with subheadings
- **"Don't remind" checkbox:** Bottom of modal, muted text, unchecked by default

---

## 11. Implementation Plan

### Phase 1: Detection Engine (Main Process) ✅

1. ~~Create `src/main/workspace/workspace-orphan-detector.ts`~~
   - ~~`detectWorkspaceOrphans(cwd, skillsManager, mcpConfigStore)` → `OrphanDetectionResult`~~
   - ~~`getDismissalForWorkspace(cwd)` / `saveDismissal(cwd)` helpers~~
   - ~~`hasProfileChangedSince(cwd, dismissal)` — mtime comparison~~
2. ~~Wire into session-start / workspace-change flow in `src/main/index.ts`~~
3. ~~Add `workspace.detectOrphans` and `workspace.dismissOrphanNotice` IPC handlers~~
4. ~~Tests: detection logic, dismissal persistence, re-trigger on mtime change~~

**Implementation notes (Phase 1):**

- Created `src/shared/workspace-orphan-types.ts` (shared types)
- Created `src/main/workspace/workspace-orphan-detector.ts` (detection + cleanup + dismissal)
- Added IPC handlers: `workspace.detectOrphans`, `workspace.cleanupOrphans`, `workspace.dismissOrphanNotice`
- Added preload bridge in `src/preload/index.ts`
- Added `workspace.orphans_detected` to `ServerEvent` union in renderer types
- Added `orphanDismissals` to `AppConfig` with full normalization
- Debounced detection trigger in `setWorkingDir` (3s delay)
- Security: CWD authorization on all handlers, symlink rejection, path boundary checks,
  array size caps, orphan verification (refuses to remove non-orphaned entries),
  unknown field preservation in skills-profile.json
- 33 unit tests covering detection, dismissal, cleanup, safety, and symlink cases

### Phase 2: Cleanup Logic (Main Process) ✅

_Implemented as part of Phase 1 — cleanup IPC handler, preload bridge, and tests
were built together with the detection engine._

1. ~~Add `workspace.cleanupOrphans` IPC handler~~
2. ~~Reuse existing `saveSkillsWorkspaceProfile` and `saveWorkspaceMcpProfile` functions~~
3. ~~Handle empty-profile deletion (existing pattern)~~
4. ~~Add preload bridge for new IPC endpoints~~
5. ~~Tests: cleanup execution, partial removal, empty-profile deletion~~

### Phase 3: Notification (Renderer) ✅

1. ~~Add `'open_orphan_cleanup'` to `GlobalNoticeAction` type~~
2. ~~Handle `workspace.orphans_detected` server event in `useIPC.ts`~~
3. ~~Add `workspaceOrphans` state to Zustand store~~
4. ~~Show `GlobalNoticeToast` with correct message variant~~
5. ~~Add i18n keys (en.json + zh.json)~~
6. Tests: toast rendering, action dispatch — _deferred_

**Implementation notes (Phase 3):**

- Added `open_orphan_cleanup` to `GlobalNoticeAction` type
- IPC handler normalizes nested payload arrays, validates shape, rejects stale CWDs
- Added `workspaceOrphans`, `showOrphanCleanup` state + actions + selectors to Zustand
- Workspace change clears orphan state, modal visibility, and related global notices
- Added 12 i18n keys to en.json and zh.json

### Phase 4: Cleanup Modal (Renderer) ✅

1. ~~Create `src/renderer/components/WorkspaceOrphanCleanupModal.tsx`~~
2. ~~List orphaned entries with checkboxes (grouped by type, deduplicated by ID)~~
3. ~~"Remove All" / "Remove Selected" / "Dismiss" buttons~~
4. ~~"Don't remind" checkbox → calls `workspace.dismissOrphanNotice`~~
5. ~~Success toast after cleanup~~
6. Tests: modal interactions, IPC calls — _deferred_

**Implementation notes (Phase 4):**

- Modal keyed on `orphans.cwd + totalOrphans` to remount on payload changes
- Entries deduplicated by `type:id` — same skill in pinned+disabled shows once
- Async cleanup guarded with `mountedRef` and workspace-change check
- Dismiss clears state before async IPC call to prevent stale mutations
- X button behaves like Dismiss (consistent close semantics)
- Accessible: `role="dialog"`, `aria-modal`, `aria-labelledby`
- Auto-close on success after 1.2s (timer cleaned up on unmount)

### Phase 5: Context Panel Badge (Optional Enhancement)

1. Add stale count to skills section header in `ContextPanel.tsx`
2. Make badge clickable → opens cleanup modal
3. Badge disappears when orphans are resolved

---

## 12. Relationship to Existing Features

| Feature                   | Relationship                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| Skill Workspace Profiles  | Detection reads from `.cowork/skills-profile.json` (same file)            |
| MCP Workspace Profiles    | Detection reads from `.cowork/mcp-servers.json` (same file)               |
| Skill Conflict Resolution | Orthogonal — conflicts are about _which version_, orphans about _exists?_ |
| Skill Disable (session)   | Session state is ephemeral; workspace profile is persistent (our target)  |
| MCP Session Toggle        | Same relationship — session vs. persistent workspace config               |
| GlobalNoticeToast         | Reuses existing notification component with a new action type             |
| Save to Workspace (💾)    | Cleanup is the inverse operation — remove entries instead of add them     |

---

## 13. UX Principles

1. **Non-blocking** — The notification is a toast, not a modal. The user can ignore it
   and continue working. The app functions correctly with orphaned entries.

2. **Informative first** — Explain what was found before offering to fix it. The user
   should understand why they're seeing this notification.

3. **One-click resolution** — "Remove All" is the primary action. Most users don't need
   to cherry-pick which orphans to keep.

4. **Respectful of dismissal** — Once dismissed, don't nag until something changes
   (file modification, new orphans detected).

5. **No data loss** — Removing orphaned entries from a config file cannot break anything
   (the entries already reference non-existent things).

6. **Team-friendly** — Works well with git-tracked `.cowork/` directories where
   teammates may push profiles with skills they have but you don't.

---

## 14. Future Extensions

- **Auto-cleanup option** — Settings toggle: "Automatically remove stale workspace profile
  entries" (no notification, just clean silently)
- **Audit log** — Record what was cleaned and when (in case user wants to restore)
- **Prompt section cleanup** — Extend to `.cowork/prompts/` files that reference
  non-existent template variables
- **MCP permissions cleanup** — Extend to `.cowork/mcp-permissions.json` referencing
  deleted servers
- **"Install missing" action** — Instead of removing references, offer to install the
  missing skill/server (useful for teams with shared workspace profiles)
- **Git hook integration** — Pre-commit hook that warns about orphaned entries before push

---

## 15. References

- Skill workspace profiles: `src/main/skills/skills-workspace-profile.ts`
- MCP workspace profiles: `src/main/mcp/mcp-workspace-profile.ts`
- GlobalNoticeToast: `src/renderer/components/GlobalNoticeToast.tsx`
- Zustand store (notice state): `src/renderer/store/index.ts`
- Session start handler: `src/main/index.ts` (line ~4360)
- Skills manager: `src/main/skills/skills-manager.ts` (`getAllSkills()`)
- MCP config store: `src/main/mcp/mcp-config-store.ts` (`getServers()`)
- Docker Compose orphan pattern: `WARN Found orphan containers... use --remove-orphans`
- VS Code workspace trust: persistent info bar with action button + dismiss
