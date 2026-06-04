# Skill Workspace Profiles — Design Document

**Created:** 2026-06-04
**Status:** Draft
**Author:** AI-assisted design session

---

## 1. Problem Statement

With 50+ skills installed, the skills list becomes unmanageable. Every skill is always
loaded into the agent's context regardless of whether the current project needs it.
This causes:

- **Context window waste** — skills like `xlsx`, `pptx`, `docx` consume tokens even
  when working on a pure TypeScript API project
- **Model confusion** — more available skills = worse tool selection accuracy
- **UI clutter** — the pinning section shows all 50 skills as a flat wall of chips
- **No project awareness** — same skills active whether working on a legal research
  project or a React app

### Community Consensus

- "5–8 active tools per context" is the sweet spot (MindStudio research)
- "Active skills should reflect active use cases, not theoretical possibilities"
- "Don't install too many skills — you're wasting precious context window"

### Existing Solution for MCP Servers (proven pattern)

Open Cowork already solves this exact problem for MCP servers with a three-layer toggle:

```
Session override > Workspace profile (.cowork/mcp-servers.json) > Global config
```

The same architecture should extend to skills.

---

## 2. Goals

- Let users **remove** (disable) skills from the current session without uninstalling them
- Let users **pin** (prioritize) skills they want the agent to actively use
- Store both states in a **workspace profile** (`.cowork/skills-profile.json`) for persistence
- Provide a **"Save to workspace"** button (mirrors MCP Connectors pattern)
- Keep the existing pinning UX unchanged — just add the removal capability alongside it

### Non-Goals

- Named skill presets / profiles (future extension)
- Auto-categorization or usage-based suggestions (future extension)
- Skill grouping UI (keep flat list for now, solve scale with removal)

---

## 3. Design: Three States per Skill

Each skill in a session can be in one of three states:

| State         | Icon            | Meaning                                          | Effect on Agent                               |
| ------------- | --------------- | ------------------------------------------------ | --------------------------------------------- |
| **Available** | ☆ (empty star)  | Normal — skill exists, model can use if relevant | SKILL.md loaded into SDK resource loader      |
| **Pinned**    | ★ (filled star) | Prioritized — explicit directive injected        | SKILL.md loaded + `<pinned_skills>` directive |
| **Removed**   | ✕ (crossed out) | Disabled for this session — not available        | SKILL.md NOT loaded, skill invisible to model |

Transition diagram:

```
     [Pin] ←→ [Available] ←→ [Remove]
       ★            ☆             ✕
```

- Available → Pin (click star)
- Pin → Available (click star again)
- Available → Remove (click ✕ or toggle off)
- Remove → Available (click + or toggle on)
- Pin + Remove = invalid (removing unpins automatically)

---

## 4. UI Design

### 4.1 Right Sidebar (Context Panel) — "PINNED SKILLS" Section

Mirrors the MCP Connectors pattern with a 💾 save button:

```
┌─────────────────────────────────────────────────────────────┐
│ PINNED SKILLS (3/14 active · 6 removed)          💾   ∧    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Pinned:                                                     │
│  ★ semantic-index                                    [✕]    │
│  ★ firecrawl                                         [✕]    │
│  ★ context7-mcp                                      [✕]    │
│                                                             │
│ Available:                                                  │
│  ☆ docx                                              [✕]    │
│  ☆ pdf                                               [✕]    │
│  ☆ skill-creator                                     [✕]    │
│  ☆ xlsx                                              [✕]    │
│  ☆ pptx                                             [✕]    │
│                                                             │
│ Removed (6):                                         [▾]    │
│  ┊ firecrawl-agent                                   [+]    │
│  ┊ firecrawl-browser                                 [+]    │
│  ┊ firecrawl-crawl                                   [+]    │
│  ┊ firecrawl-download                                [+]    │
│  ┊ firecrawl-map                                     [+]    │
│  ┊ firecrawl-scrape                                  [+]    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Key elements:**

- **Header counter:** `3/14 active · 6 removed` — instant status at a glance
- **💾 Save button:** Appears when session state differs from workspace profile.
  Writes current pinned + removed state to `.cowork/skills-profile.json`
- **[✕] button** on available/pinned skills — removes from session
- **[+] button** on removed skills — adds back to session
- **Removed section** — collapsible, muted styling (like MCP's "off this session")
- **Star toggle** — unchanged from current behavior (click star to pin/unpin)

### 4.2 Welcome Page — "Prioritize skills for this chat"

Add a third visual state for removed skills:

```
┌─────────────────────────────────────────────────────────────┐
│ ☆ Prioritize skills for this chat                    ∧      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ┌──────────────────┐  ┌──────────────────┐                  │
│ │ ★ semantic-index │  │ ★ firecrawl      │  ...             │
│ │ Search code...   │  │ Web scraping...  │                  │
│ └──────────────────┘  └──────────────────┘                  │
│                                                             │
│ ┌──────────────────┐  ┌──────────────────┐                  │
│ │ ☆ docx           │  │ ☆ pdf            │  ...             │
│ │ Word docs...     │  │ PDF files...     │                  │
│ └──────────────────┘  └──────────────────┘                  │
│                                                             │
│ ┌──────────────────┐  ┌──────────────────┐                  │
│ │ ✕ firecrawl-agent│  │ ✕ firecrawl-map  │  ...             │
│ │ (removed)        │  │ (removed)        │                  │
│ └──────────────────┘  └──────────────────┘                  │
│                                                             │
│ 14 active · 6 removed from workspace profile                │
└─────────────────────────────────────────────────────────────┘
```

**Interactions on Welcome page:**

- Click star on available → pin (filled star)
- Click star on pinned → unpin (empty star)
- Click card on removed skill → restore to available
- Long-press or right-click on available → remove (or add ✕ icon to card corner)

**Loading workspace defaults:** When starting a new chat with a workspace that has
`.cowork/skills-profile.json`, the Welcome page pre-applies the profile (removed
skills shown as removed, pinned skills shown as pinned).

### 4.3 Interaction Flow

```
User opens project /Users/me/src/my-api/
  │
  ├─ Load .cowork/skills-profile.json:
  │   { "pinned": ["semantic-index", "firecrawl"],
  │     "disabled": ["xlsx", "pptx", "docx", "firecrawl-agent", ...] }
  │
  ├─ Welcome page shows:
  │   - 2 skills pre-pinned (★)
  │   - N skills as available (☆)
  │   - 6 skills as removed (✕)
  │
  ├─ User starts chat → session created with this state
  │
  ├─ Mid-conversation: user removes "pdf" from Context Panel
  │   → 💾 save button appears (state differs from profile)
  │
  ├─ User clicks 💾 → writes updated state to .cowork/skills-profile.json
  │
  └─ Next time user opens this project → profile auto-applied
```

---

## 5. Data Model

### 5.1 Workspace Profile File

**Location:** `<project>/.cowork/skills-profile.json`

```json
{
  "pinned": ["semantic-index", "firecrawl", "context7-mcp"],
  "disabled": [
    "firecrawl-agent",
    "firecrawl-browser",
    "firecrawl-crawl",
    "firecrawl-download",
    "firecrawl-map",
    "firecrawl-scrape",
    "xlsx",
    "pptx",
    "docx"
  ]
}
```

**Rules:**

- `pinned` — skill IDs to pre-pin on session creation (injected as directives)
- `disabled` — skill IDs to exclude from the session (not loaded into agent)
- A skill in both arrays → `pinned` wins (explicit include overrides disable)
- Skills not in either array → available (normal, loaded but not prioritized)
- Accepts skill IDs matching `SAFE_SKILL_ID_REGEX` (existing validation)
- File is optional — missing file = all skills available, none pinned

### 5.2 Session State (in-memory)

Extends existing `sessionPinnedSkills` Map:

```typescript
// In SessionManager
private sessionPinnedSkills: Map<string, Set<string>>;    // existing
private sessionDisabledSkills: Map<string, Set<string>>;  // NEW
```

### 5.3 Resolution (three layers, highest wins)

```
Session disabled override > Workspace profile disabled > All available (global)
Session pinned override > Workspace profile pinned > Nothing pinned
```

If a skill is in `sessionDisabledSkills` → not loaded, regardless of workspace profile.
If a skill is in `sessionPinnedSkills` → directive injected, regardless of workspace profile.

### 5.4 Config Store (global defaults, optional)

```typescript
interface SkillProfileDefaults {
  /** Skills disabled globally (across all workspaces) */
  globalDisabledSkills: string[];
}
```

This allows users to globally disable skills they never use without needing a workspace
profile in every project. Resolution becomes:

```
Session > Workspace profile > Global disabled > All available
```

---

## 6. Agent Integration

### 6.1 Skills Loading (agent-runner.ts)

The Pi SDK's `DefaultResourceLoader` discovers skills from the `agentDir` and
`additionalSkillPaths`. Currently all skills in these paths are loaded.

**Change:** Before passing `additionalSkillPaths`, filter out disabled skill directories:

```typescript
// In agent-runner.ts, during session setup
const allSkillPaths = this.discoverSkillPaths(appSkillsDir);
const disabledSkills = this.getEffectiveDisabledSkills(session.id, effectiveCwd);
const activeSkillPaths = allSkillPaths.filter((p) => !disabledSkills.has(path.basename(p)));
```

### 6.2 Pinned Skills Directive (existing, unchanged)

`buildPinnedSkillsDirective()` already reads from `sessionPinnedSkills`. No change needed
if workspace profile pins are seeded into `sessionPinnedSkills` on session creation.

### 6.3 Workspace Profile Seeding on Session Start

When a new session is created:

```typescript
// In session.start handler (main/index.ts)
const workspaceProfile = loadSkillsWorkspaceProfile(cwd);
if (workspaceProfile) {
  // Seed disabled skills from workspace profile
  if (workspaceProfile.disabled?.length) {
    for (const id of workspaceProfile.disabled) {
      sessionManager.toggleSessionDisabledSkill(sessionId, id, true);
    }
  }
  // Seed pinned skills from workspace profile
  if (workspaceProfile.pinned?.length) {
    for (const id of workspaceProfile.pinned) {
      sessionManager.toggleSessionPinnedSkill(sessionId, id, true);
    }
  }
}
```

---

## 7. IPC Endpoints

### New Handlers

| Handler                           | Payload                            | Returns                          | Purpose                         |
| --------------------------------- | ---------------------------------- | -------------------------------- | ------------------------------- |
| `skills.toggleSessionDisabled`    | `{ sessionId, skillId, disabled }` | `{ success, disabledSkills }`    | Remove/restore skill in session |
| `skills.getSessionDisabledSkills` | `{ sessionId }`                    | `string[]`                       | Get currently removed skills    |
| `skills.getWorkspaceProfile`      | `{ cwd }`                          | `SkillsWorkspaceProfile \| null` | Load workspace profile          |
| `skills.saveWorkspaceProfile`     | `{ cwd, pinned, disabled }`        | `{ success }`                    | Write workspace profile         |

### Existing Handlers (unchanged)

- `skills.toggleSessionPin` — pin/unpin (already implemented)
- `skills.getSessionPinnedSkills` — get pinned list (already implemented)
- `skills.getAll` — get all available skills (already implemented)

### New Events

| Event                             | Payload                         | When                   |
| --------------------------------- | ------------------------------- | ---------------------- |
| `skills.session-disabled-changed` | `{ sessionId, disabledSkills }` | Skill removed/restored |

---

## 8. Save to Workspace Flow

Mirrors the MCP Connectors "💾 Save" button exactly:

1. **Visibility:** 💾 appears in section header when session state differs from workspace profile
   (or when no workspace profile exists but user has made changes)

2. **Click action:**
   - Reads current `sessionPinnedSkills` and `sessionDisabledSkills` for active session
   - Resolves workspace CWD
   - Validates CWD is authorized (same as MCP workspace profile validation)
   - Writes `.cowork/skills-profile.json` with `{ pinned: [...], disabled: [...] }`
   - Creates `.cowork/` directory if needed
   - Hides 💾 button after successful save

3. **File cleanup:** If resulting profile is empty (`pinned: [], disabled: []`), remove the file
   (same as MCP profile behavior)

4. **Conflict:** If `.cowork/skills-profile.json` already exists, merge:
   - Session state takes precedence for skills that were explicitly toggled
   - Existing profile entries for skills not touched this session are preserved

---

## 9. Welcome Page Integration

### Loading Workspace Defaults

When the Welcome page renders with a workspace selected:

```typescript
useEffect(() => {
  const loadProfile = async () => {
    const profile = await window.electronAPI?.skills?.getWorkspaceProfile(workingDir);
    if (profile) {
      // Pre-set disabled skills (shown as removed)
      setRemovedSkillIds(new Set(profile.disabled || []));
      // Pre-set pinned skills (shown with filled star)
      setPinnedSkillIds(new Set(profile.pinned || []));
    }
  };
  loadProfile();
}, [workingDir]);
```

### Passing to Session Creation

When starting a new chat, pass both sets:

```typescript
await window.electronAPI.session.start({
  title,
  content: prompt,
  workingDir,
  initialPinnedSkills: pinnedSkillIds.size > 0 ? Array.from(pinnedSkillIds) : undefined,
  initialDisabledSkills: removedSkillIds.size > 0 ? Array.from(removedSkillIds) : undefined,
});
```

---

## 10. Visual Design

### Removed Skill Chip (Sidebar)

```
┌─────────────────────────────────┐
│ ┊ firecrawl-agent          [+]  │  ← muted text, strikethrough, dashed border
└─────────────────────────────────┘
```

- Text color: `text-text-muted`
- Border: `border-dashed border-border-muted`
- Optional: `line-through` on skill name
- `[+]` button: restore to available state
- `(off this session)` label like MCP servers (optional)

### Available Skill Chip (Sidebar)

```
┌─────────────────────────────────┐
│ ☆ docx                    [✕]   │  ← normal styling, star + remove
└─────────────────────────────────┘
```

### Pinned Skill Chip (Sidebar)

```
┌─────────────────────────────────┐
│ ★ semantic-index           [✕]   │  ← accent color star, remove still available
└─────────────────────────────────┘
```

### Header Counter

```
PINNED SKILLS (3/14 active · 6 removed)          💾   ∧
```

Format: `{pinned}/{active} active · {removed} removed`

- `pinned` = skills with filled star
- `active` = total available to model (pinned + unpinned but not removed)
- `removed` = disabled skills count

---

## 11. Implementation Plan

### Phase 1: Session-Level Skill Disable

1. Add `sessionDisabledSkills` Map to SessionManager
2. Add `skills.toggleSessionDisabled` IPC handler
3. Add `skills.getSessionDisabledSkills` IPC handler
4. Modify agent-runner to filter `additionalSkillPaths` based on disabled set
5. Add preload bridge for new endpoints
6. Tests: toggle, cleanup on session delete, filtering

### Phase 2: Context Panel UI

1. Add [✕] remove button to each skill chip
2. Add "Removed" collapsible section with [+] restore buttons
3. Add counter in section header (`3/14 active · 6 removed`)
4. Muted/strikethrough styling for removed skills
5. Tests: UI state transitions

### Phase 3: Workspace Profile

1. Create `src/main/skills/skills-workspace-profile.ts` (mirror `mcp-workspace-profile.ts`)
2. Implement `loadSkillsWorkspaceProfile(cwd)` with mtime caching
3. Implement `saveSkillsWorkspaceProfile(cwd, profile)` with validation
4. Add `skills.getWorkspaceProfile` and `skills.saveWorkspaceProfile` IPC handlers
5. Add 💾 save button to sidebar section header
6. Seed session state from workspace profile on session creation
7. Tests: load/save/merge/validation

### Phase 4: Welcome Page Integration

1. Load workspace profile on workspace selection
2. Show removed skills as disabled cards (muted, clickable to restore)
3. Show pinned skills as pre-starred
4. Pass `initialDisabledSkills` to session.start
5. Tests: profile loading, session creation with profile

### Phase 5: Global Defaults (optional, lower priority)

1. Add `globalDisabledSkills` to config store
2. Add Settings → Skills section with global enable/disable toggles
3. Resolution: session > workspace > global > all available

---

## 12. Relationship to Existing Features

| Feature                           | Relationship                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------- |
| **Skill Pinning**                 | Kept unchanged. Pinning = prioritize. This adds the inverse: disable.         |
| **MCP Workspace Profile**         | Same UX pattern (💾 save, three-layer resolution). Separate file.             |
| **MCP Session Toggle**            | Same concept applied to skills.                                               |
| **Skill Conflict Resolution**     | Orthogonal. Conflict = which _version_ to use. This = whether to load at all. |
| **MAX_PINNED_SKILLS_PER_SESSION** | Unchanged. Limit applies to pinned count, not available count.                |

---

## 13. Edge Cases

| Scenario                                                | Behavior                                  |
| ------------------------------------------------------- | ----------------------------------------- |
| Skill uninstalled while in disabled list                | Silently ignored in profile (no error)    |
| New skill installed not in profile                      | Appears as available (default state)      |
| Profile has skill in both `pinned` and `disabled`       | `pinned` wins (explicit include)          |
| Save with no changes from profile                       | 💾 button hidden (no-op)                  |
| Empty profile after all restored                        | Delete `.cowork/skills-profile.json` file |
| `initialDisabledSkills` + `initialPinnedSkills` overlap | Pin wins, skill is active + pinned        |
| Session switch with different workspace                 | Load that workspace's profile             |

---

## 14. Future Extensions

- **Skill Profiles/Presets** — named combinations (e.g., "Research mode") as UI shortcuts
- **Usage tracking** — count skill invocations, suggest removing unused skills
- **Auto-disable suggestions** — "You haven't used xlsx in 3 weeks in this workspace. Remove?"
- **Context budget display** — show token cost per active skill in the header
- **Bulk operations** — "Remove all firecrawl-\*" pattern matching

---

## 15. References

- MCP workspace profile implementation: `src/main/mcp/mcp-workspace-profile.ts`
- MCP Context Panel toggle: `src/renderer/components/ContextPanel.tsx`
- Skill pinning implementation: `src/main/claude/agent-runner.ts` (`buildPinnedSkillsDirective`)
- Skill pinning constants: `src/shared/skill-pinning-constants.ts`
- Session manager pinning: `src/main/session/session-manager.ts` (`toggleSessionPinnedSkill`)
- Community research: [MindStudio — Claude Code Skills Common Mistakes](https://www.mindstudio.ai/blog/claude-code-skills-common-mistakes-guide/)
- Community research: [paddo.dev — Skills Controllability Problem](https://paddo.dev/blog/claude-skills-controllability-problem/)
- Claude Code issue #33080: Built-in skills conflict problem
