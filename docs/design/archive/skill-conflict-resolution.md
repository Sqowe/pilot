# Skill Conflict Resolution — Design Document

**Created:** 2026-06-04
**Status:** ✅ Done
**Author:** AI-assisted design session

---

## 1. Problem Statement

When a user has a custom skill (in `~/.claude/skills/` or a configured path) with the
same name as a built-in skill shipped with the app, the built-in silently wins. The
user's skill is never loaded, there is no warning, and no mechanism exists to override
or disable specific built-ins.

### Evidence

**Claude Code issue [#33080](https://github.com/anthropics/claude-code/issues/33080):**

> "Custom skills that were working under a given name (e.g. `/review`) break silently
> when a Claude Code update introduces a built-in with the same name. The built-in takes
> precedence, the custom skill is effectively displaced, and there is no mechanism to
> disable or override the built-in."

Community reactions:

- "zero warning, our skill just stopped being invoked"
- "we ended up prefixing all our custom skills with a namespace — that's a hack"
- "the error should say 'conflicts with built-in skill' not 'disable-model-invocation'"
- Organizations managing custom skills at scale hit this repeatedly

**Current Open Cowork behavior** (from `agent-runner.ts` `syncUserSkillsToAppDir()`):

```typescript
if (fs.existsSync(targetPath)) {
  const stat = fs.lstatSync(targetPath);
  if (!stat.isSymbolicLink()) {
    continue; // ← Built-in (real directory) silently wins
  }
}
```

### User Pain Points

| Pain                                                | Impact                                  | Frequency                            |
| --------------------------------------------------- | --------------------------------------- | ------------------------------------ |
| Custom skill silently ignored after app update      | Workflow breaks without warning         | Every app update that adds built-ins |
| No way to disable a built-in skill                  | User must namespace-prefix everything   | Ongoing friction                     |
| No visibility into which version is active          | Debugging "why isn't my skill working?" | On every conflict                    |
| App updates can introduce new conflicts at any time | No safe namespace for custom skills     | Unpredictable                        |

---

## 2. Goals

- Give users explicit control over which skill version is active when conflicts exist
- Warn users immediately when a conflict is detected (not silently override)
- Allow disabling individual built-in skills entirely
- Provide clear visibility into skill sources and active status
- Default behavior should match user intent: custom skills win

### Non-Goals

- Multi-level organizational skill hierarchies (enterprise feature, too complex for now)
- Automatic conflict resolution via content merging
- Skill versioning or rollback

---

## 3. Design

### 3.1 Conflict Resolution Policy

A global setting that determines what happens when a custom skill and built-in skill
share the same name.

| Policy                                | Behavior                                               | Use Case                    |
| ------------------------------------- | ------------------------------------------------------ | --------------------------- |
| **Custom wins** (recommended default) | User's skill is loaded, built-in is skipped            | Power users, organizations  |
| **Built-in wins** (current behavior)  | Built-in is loaded, user's skill is skipped            | Users who trust app quality |
| **Ask me**                            | Notification shown on conflict, user decides per-skill | Cautious users              |

### 3.2 Per-Skill Source Selector

When a skill name exists in multiple sources, the user can explicitly choose which
version to use via a per-skill override. This takes precedence over the global policy.

Sources (priority order when "Custom wins"):

1. **Project** — `<project>/.skills/<name>/` or `<project>/skills/<name>/`
2. **User** — `~/.claude/skills/<name>/`
3. **Configured** — `<globalSkillsPath>/<name>/` (user-set custom directory)
4. **Built-in** — app-bundled skills

### 3.3 Disable Capability

Any skill (including built-ins) can be individually disabled. A disabled skill:

- Is not loaded into the runtime directory
- Is not available to the agent
- Retains its files on disk (can be re-enabled)
- Shows as "Disabled" in the UI

### 3.4 Conflict Notification

When the app starts or updates and detects a new conflict (built-in introduced that
matches an existing custom skill):

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️  Skill conflict detected                                  │
│                                                              │
│ The built-in skill "pdf" conflicts with your custom skill    │
│ at ~/.claude/skills/pdf                                      │
│                                                              │
│ [Use Custom]  [Use Built-in]  [Open Settings]                │
└─────────────────────────────────────────────────────────────┘
```

This notification only appears once per conflict (tracked via acknowledged conflicts
list in config). If the global policy is not "Ask me", the notification is informational
only ("Using your custom version per your settings. [Change]").

---

## 4. Data Model

### 4.1 Config Store Addition

```typescript
interface SkillConflictConfig {
  /** Global policy when custom and built-in share a name */
  conflictPolicy: 'custom-wins' | 'builtin-wins' | 'ask';

  /** Skills explicitly disabled by the user (skill directory names) */
  disabledSkills: string[];

  /** Per-skill source override (skill name → preferred source) */
  sourceOverrides: Record<string, 'builtin' | 'user' | 'project' | 'configured'>;

  /** Conflicts that have been acknowledged (won't re-notify) */
  acknowledgedConflicts: string[];
}
```

**Defaults:**

```typescript
const DEFAULT_SKILL_CONFLICT_CONFIG: SkillConflictConfig = {
  conflictPolicy: 'custom-wins',
  disabledSkills: [],
  sourceOverrides: {},
  acknowledgedConflicts: [],
};
```

### 4.2 Skill Metadata Extension

The existing `Skill` interface gains source tracking:

```typescript
interface Skill {
  // ... existing fields ...
  source: 'builtin' | 'user' | 'project' | 'configured';
  sourcePath: string; // actual file path
  hasConflict: boolean; // another source has same name
  conflictSources: string[]; // other sources where this skill exists
  isActive: boolean; // whether this version is the one being used
}
```

---

## 5. Sync Logic Changes

### 5.1 Current Flow (broken)

```
1. Built-in skills synced to runtime dir (real directories)
2. ~/.claude/skills scanned
3. For each user skill:
   - If runtime dir already has non-symlink with same name → SKIP (silent)
   - Otherwise → create symlink
```

### 5.2 Proposed Flow

```
1. Discover all skill sources:
   - Scan built-in directory → collect names
   - Scan ~/.claude/skills → collect names
   - Scan configured path → collect names
   - Scan project .skills/ → collect names

2. Detect conflicts (same name in multiple sources)

3. For each conflict, resolve using:
   a. Per-skill sourceOverride (if set) → use that source
   b. Global conflictPolicy → apply policy
   c. If 'ask' and not yet acknowledged → queue notification

4. Sync resolved skills to runtime directory:
   - Winning source → copy/symlink to runtime dir
   - Losing sources → not synced (but tracked in metadata)
   - Disabled skills → removed from runtime dir

5. Emit conflict events to renderer (for notifications)
```

### 5.3 Key Code Change

In `agent-runner.ts` `syncUserSkillsToAppDir()`:

```typescript
private syncUserSkillsToAppDir(appSkillsDir: string): void {
  const userSkillsDir = this.getUserClaudeSkillsDir();
  if (!fs.existsSync(userSkillsDir)) return;

  const config = configStore.get('skillConflictConfig') || DEFAULT_SKILL_CONFLICT_CONFIG;
  const entries = fs.readdirSync(userSkillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const sourcePath = path.join(userSkillsDir, skillName);
    const targetPath = path.join(appSkillsDir, skillName);

    // Check if disabled
    if (config.disabledSkills.includes(skillName)) continue;

    // Check per-skill override
    const override = config.sourceOverrides[skillName];
    if (override === 'builtin') continue; // User explicitly chose built-in

    if (fs.existsSync(targetPath)) {
      const stat = fs.lstatSync(targetPath);
      if (!stat.isSymbolicLink()) {
        // Conflict: built-in exists as real directory
        const policy = override || config.conflictPolicy;

        if (policy === 'builtin-wins') continue;
        if (policy === 'ask' && !config.acknowledgedConflicts.includes(skillName)) {
          this.emitSkillConflict(skillName, sourcePath, targetPath);
          continue; // Use built-in until user decides
        }

        // 'custom-wins' or acknowledged 'ask' → replace built-in with user's
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }
    }

    // Symlink user skill to runtime dir
    try {
      fs.symlinkSync(sourcePath, targetPath, 'dir');
    } catch {
      this.copyDirectorySync(sourcePath, targetPath);
    }
  }
}
```

---

## 6. UI Design

### 6.1 Settings → Skills Page

#### Global Policy Section

```
┌─────────────────────────────────────────────────────────────────┐
│ CONFLICT RESOLUTION                                              │
│                                                                  │
│ When a custom skill and built-in share the same name:            │
│                                                                  │
│ ● Custom wins (recommended)                                      │
│   Your skills always take priority over built-ins.               │
│                                                                  │
│ ○ Built-in wins                                                  │
│   App-maintained skills take priority. Custom skills with        │
│   the same name are ignored.                                     │
│                                                                  │
│ ○ Ask me each time                                               │
│   Show a notification when a conflict is detected.               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Skill List Section

Each skill card shows:

```
┌─────────────────────────────────────────────────────────────────┐
│ 📄 pdf                                            [Enabled ✓]   │
│                                                                  │
│ PDF processing and form filling                                  │
│                                                                  │
│ Sources:                                                         │
│   ★ Built-in (v2.1)    ~/.claude/skills/pdf                     │
│                                                                  │
│ Active source: [Built-in ▾]                                      │
│                                                                  │
│ ⚠️ Conflict: custom version exists at ~/.claude/skills/pdf       │
└─────────────────────────────────────────────────────────────────┘
```

**When no conflict exists:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔍 semantic-index                                 [Enabled ✓]   │
│                                                                  │
│ Semantic code and documentation search                           │
│                                                                  │
│ Source: ~/.claude/skills/semantic-index                          │
└─────────────────────────────────────────────────────────────────┘
```

**When disabled:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 📊 xlsx                                           [Disabled]    │
│                                                                  │
│ Excel spreadsheet support                                        │
│                                                                  │
│ Source: Built-in                                                 │
│ Status: Disabled by user                                         │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Conflict Toast Notification

Shown once when a new conflict is detected (app update adds a built-in that
conflicts with an existing user skill):

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠️  New skill conflict: "pdf"                                    │
│                                                                  │
│ A built-in skill was added with the same name as your            │
│ custom skill at ~/.claude/skills/pdf                             │
│                                                                  │
│ Using your custom version (per your settings).                   │
│                                                                  │
│ [Change in Settings]                              [Dismiss]      │
└─────────────────────────────────────────────────────────────────┘
```

If policy is "Ask me":

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠️  Skill conflict: "pdf"                                        │
│                                                                  │
│ Both a built-in and your custom skill share this name.           │
│ Which version should be used?                                    │
│                                                                  │
│ [Use My Custom]  [Use Built-in]  [Open Settings]                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Skill Detail View (expandable)

Clicking a skill in the list expands to show:

- Full description (from SKILL.md)
- File path(s) for all sources
- Last modified date
- Content hash comparison (if conflict exists: "Files differ" or "Identical content")
- "Open in editor" button
- "Reset to built-in" button (for conflicted skills where user chose custom)

---

## 7. IPC & Events

### New IPC Handlers

| Handler                      | Payload                   | Returns               | Purpose                     |
| ---------------------------- | ------------------------- | --------------------- | --------------------------- |
| `skills.getConflictConfig`   | —                         | `SkillConflictConfig` | Load current settings       |
| `skills.setConflictPolicy`   | `{ policy }`              | `{ success }`         | Change global policy        |
| `skills.setSourceOverride`   | `{ skillName, source }`   | `{ success }`         | Per-skill choice            |
| `skills.toggleDisabled`      | `{ skillName, disabled }` | `{ success }`         | Enable/disable              |
| `skills.acknowledgeConflict` | `{ skillName, choice }`   | `{ success }`         | Resolve "ask" conflict      |
| `skills.getConflicts`        | —                         | `SkillConflict[]`     | List all detected conflicts |
| `skills.resetToBuiltin`      | `{ skillName }`           | `{ success }`         | Remove user override        |

### New Server Events

| Event                      | Payload                                  | When                             |
| -------------------------- | ---------------------------------------- | -------------------------------- |
| `skills.conflict-detected` | `{ skillName, builtinPath, customPath }` | New conflict on app start/update |
| `skills.conflict-resolved` | `{ skillName, winner }`                  | User makes a choice              |

---

## 8. Migration & Backward Compatibility

### First Launch After Update

1. If `skillConflictConfig` doesn't exist in config store → create with defaults
2. Scan for existing conflicts (user skills that share names with built-ins)
3. If `conflictPolicy` is 'custom-wins' (the new default):
   - For each conflict: replace built-in with user's symlink in runtime dir
   - No notification needed (user's version was previously silently ignored, now it works)
4. If user had `.user-modified` markers → migrate to `sourceOverrides` entries
5. `.user-modified` files continue to work as before (prevent built-in auto-update)

### Settings UI Availability

The conflict resolution UI is only shown when at least one conflict exists or the user
has skills in `~/.claude/skills/`. Otherwise the section is hidden (no noise for users
who only use built-ins).

---

## 9. Edge Cases

| Scenario                                                  | Behavior                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| User deletes custom skill while "custom wins"             | Next sync detects missing source, falls back to built-in automatically |
| User creates custom skill matching a built-in name        | On next query, conflict detected, policy applied                       |
| Built-in removed in app update                            | User's override becomes the only source, no conflict                   |
| Multiple custom sources (user + configured) for same name | "Configured path" wins over "~/.claude/skills" (explicit > implicit)   |
| Disabled skill gets updated by built-in sync              | Stays disabled regardless of content changes                           |
| Project-level skill conflicts with built-in               | Project always wins within its workspace (highest specificity)         |

---

## 10. Implementation Plan

### Phase 1: Data Model & Conflict Detection

1. Add `SkillConflictConfig` to config store with defaults
2. Add conflict detection logic (scan all sources, find overlapping names)
3. Add `skills.getConflicts` IPC handler
4. Emit `skills.conflict-detected` events on app start

### Phase 2: Sync Logic Update

1. Modify `syncUserSkillsToAppDir()` to respect conflict policy
2. Modify `syncConfiguredSkillsToRuntimeDir()` similarly
3. Add per-skill source override support
4. Add disable list support (skip disabled skills in sync)
5. Migrate `.user-modified` logic to use new config

### Phase 3: UI — Settings Page

1. Add "Conflict Resolution" section to Skills settings
2. Add source indicator and conflict badge to skill list
3. Add per-skill source dropdown (only for conflicted skills)
4. Add disable/enable toggle per skill
5. Add "Reset to built-in" action

### Phase 4: Notifications

1. Implement conflict toast notification on app update
2. Implement "Ask me" dialog for per-conflict decisions
3. Track acknowledged conflicts to avoid re-notification
4. Add conflict count badge to Settings navigation

### Phase 5: Tests

1. Unit tests for conflict detection (multiple sources, various policies)
2. Unit tests for sync logic with all policy combinations
3. Integration test: install custom skill → app update adds built-in → verify policy
4. UI tests: settings page renders correctly for conflict/no-conflict states

---

## 11. Future Considerations

- **Skill version comparison** — show diff between custom and built-in versions
- **Auto-merge** — for skills that only add content, merge both versions
- **Organization-level policies** — `.cowork/skills-policy.json` for team defaults
- **Skill marketplace** — centralized skill discovery with conflict-free naming
- **Skill namespacing** — `@org/skill-name` convention for collision avoidance

---

## 12. References

- [Claude Code #33080: Built-in skills silently conflict with custom skills](https://github.com/anthropics/claude-code/issues/33080)
- [Claude Code #35383: Skills with same name not properly namespaced](https://github.com/anthropics/claude-code/issues/35383)
- [Claude Code #36010: Skill named "batch" silently blocked with misleading error](https://github.com/anthropics/claude-code/issues/36010)
- [VS Code settings precedence: User → Workspace → Folder](https://code.visualstudio.com/docs/configure/settings)
- Existing implementation: `src/main/claude/agent-runner.ts` (`syncUserSkillsToAppDir`, `getBuiltinSkillsPath`)
- Existing implementation: `src/main/skills/skills-manager.ts` (`importUserSkills`, `loadGlobalSkills`)
- Related design: `docs/design/skill-pinning-ux.md`
