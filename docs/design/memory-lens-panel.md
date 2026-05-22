# Memory Lens Panel — UX Design

**Date:** 2026-05-22  
**Status:** Concept  
**Author:** Discussion between user and AI  
**Location:** Right toolbox (ContextPanel), new collapsible section

---

## Problem Statement

The in-app memory system works automatically and invisibly. Users have no way to know:

1. Whether memory is active and which system is in use (in-app vs skill)
2. What the AI "knows" about them (core profile)
3. Whether memory was actually retrieved for the current message
4. How much context window budget memory is consuming
5. What was learned from past sessions about the current project

### User Pain Points (from community research)

| Pain                                 | Source                             | Frequency        |
| ------------------------------------ | ---------------------------------- | ---------------- |
| "What does it remember about me?"    | Reddit, ChatGPT forums, HCI papers | Very common      |
| "It doesn't remember" / "amnesia"    | r/claude, r/ClaudeCode             | Top complaint    |
| "Did it use my past context?"        | AI agent forums                    | Common           |
| "Memory is a secret diary"           | UX design literature               | Design principle |
| "How much context is memory eating?" | Power users, token-conscious       | Moderate         |

### Design Principles Applied

From [7 Design Paradigms for Human-AI Interfaces](https://medium.com/design-bootcamp/7-design-paradigms-for-human-ai-interfaces-you-probably-havent-heard-of-but-should-care-about-7c909f2db3db):

- **Memory as a shared, editable space** — not a hidden system
- **Explanation-centered interaction** — show what influenced the output
- **Privacy-aware architecture** — visible logs, delete controls, data modes
- **Accuracy controls** — show confidence/provenance of retrieved memories

---

## Design Overview

A new collapsible section in the ContextPanel (right toolbox), positioned between
"Pinned Skills" and "MCP Connectors". Follows the same accordion pattern as
existing sections (Artifacts, Pinned Skills, MCP Connectors).

---

## Panel Layout

### Collapsed State (section header)

```
┌─────────────────────────────────────────────────────────┐
│ 🧠 MEMORY                              ● Active    ▾   │
└─────────────────────────────────────────────────────────┘
```

- Green dot = enabled, red dot = disabled
- "Active" / "Disabled" label
- Chevron to expand/collapse (same as other sections)

### Expanded State — Full Panel

```
┌─────────────────────────────────────────────────────────┐
│ 🧠 MEMORY                              ● Active    ▴   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ┌─ Status ────────────────────────────────────────────┐ │
│ │ In-app memory: ON                                   │ │
│ │ Skill fallback: OFF (auto-disabled)                 │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Profile (9 entries) ──────────────────── [Edit →] ┐ │
│ │                                                     │ │
│ │ Interests                                           │ │
│ │  • IT company Armenia                          [×]  │ │
│ │  • Political analysis (Hungary)                [×]  │ │
│ │  • Government spending influence               [×]  │ │
│ │                                                     │ │
│ │ Preferences                                         │ │
│ │  • LLC structures                              [×]  │ │
│ │  • Tax incentives research                     [×]  │ │
│ │                                                     │ │
│ │ Skills                                              │ │
│ │  • Business registration processes             [×]  │ │
│ │  • Political data analysis                     [×]  │ │
│ │                                                     │ │
│ │ +2 more...                                          │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ This Workspace ───────────────────────────────────┐ │
│ │ 📂 Tree HU                                         │ │
│ │                                                     │ │
│ │ Sessions: 5    Chunks: 14    Last learned: 2h ago   │ │
│ │                                                     │ │
│ │ Recent topics:                                      │ │
│ │  • Jurisdiction decision                            │ │
│ │  • AIFC vs Astana Hub                               │ │
│ │  • IT company registration Armenia                  │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Last Retrieval ───────────────────────────────────┐ │
│ │                                                     │ │
│ │ 📌 Core: 3 entries matched                          │ │
│ │ 🔍 Experience: 2 chunks retrieved                   │ │
│ │    ↳ 1 expanded by navigator                        │ │
│ │ 📊 ~1,200 tokens injected                          │ │
│ │                                                     │ │
│ │ Sources:                                            │ │
│ │  • "Tree HU" — jurisdiction decision (expanded)     │ │
│ │  • "Investments" — AIFC comparison (summary)        │ │
│ │                                                     │ │
│ │ ⏱ Retrieval: 340ms                                  │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [Full Memory View]              [Settings]              │
└─────────────────────────────────────────────────────────┘
```

---

## Section Breakdown

### 1. Status Bar

**Purpose:** Answer "Is memory working? Which system?"

| Field                  | Source                                                  | Update frequency |
| ---------------------- | ------------------------------------------------------- | ---------------- |
| In-app memory: ON/OFF  | `configStore.get('memoryEnabled')`                      | On config change |
| Skill fallback: ON/OFF | `skillsManager.getSkillEnabled('global-cowork-memory')` | On skill toggle  |

Shows both systems so the user understands the relationship. When in-app is ON,
skill shows "OFF (auto-disabled)" in muted text.

### 2. Profile Section

**Purpose:** Answer "What does it know about me?"

Displays core memory entries grouped by category (interests, preferences, skills, identity).
Each entry has a [×] delete button. "Edit →" opens the full Memory settings page.

| Field             | Source                                          | Update frequency     |
| ----------------- | ----------------------------------------------- | -------------------- |
| Entry list        | `core_memory.json` via `memory.getOverview` IPC | After each ingestion |
| Category grouping | `entry.category` field                          | Static per entry     |
| Entry count       | Array length                                    | After each ingestion |

**Interactions:**

- [×] button → calls `memory.deleteCoreEntry(key)` IPC → removes from core memory
- [Edit →] → navigates to Settings → Memory page
- "+N more..." → expands to show all entries (or scrolls)

### 3. This Workspace Section

**Purpose:** Answer "Does it know about THIS project?"

Shows workspace-scoped statistics for the current session's CWD.

| Field          | Source                                                     | Update frequency  |
| -------------- | ---------------------------------------------------------- | ----------------- |
| Workspace name | Last path segment of `session.cwd`                         | On session change |
| Session count  | `experience_memory.json` filtered by `sourceWorkspace`     | After ingestion   |
| Chunk count    | Same, count chunks                                         | After ingestion   |
| Last learned   | `session_state.json` → `lastIngestedAt` for this workspace | After ingestion   |
| Recent topics  | Top 3 chunk summaries by recency for this workspace        | After ingestion   |

**Interactions:**

- Clicking a topic → shows the full chunk details (modal or inline expand)
- Workspace name is a link to the workspace folder

### 4. Last Retrieval Section

**Purpose:** Answer "Did it use memory for this message? How much?"

Updated after each agent turn. Shows what `buildPromptPrefix()` actually did.

| Field                       | Source                                        | Update frequency |
| --------------------------- | --------------------------------------------- | ---------------- |
| Core entries matched        | Count of non-empty core entries in prompt     | After each turn  |
| Experience chunks retrieved | `retrieveProgressive` result count            | After each turn  |
| Expanded by navigator       | Count of navigator expansion actions          | After each turn  |
| Tokens injected             | `promptPrefix.length / 4` (rough estimate)    | After each turn  |
| Sources list                | Top chunks with workspace + summary           | After each turn  |
| Retrieval time              | `Date.now()` delta around `buildPromptPrefix` | After each turn  |

**States:**

- Before first message: "No retrieval yet — send a message to see memory activity"
- After message with no memory found: "No relevant memory found for this query"
- After message with memory: Full display as shown above

---

## Data Flow

### New IPC Endpoints Needed

```typescript
// Get memory panel state (called on panel mount + after each turn)
'memory.getPanelState' → {
  enabled: boolean;
  skillFallbackEnabled: boolean;
  coreEntries: Array<{ category: string; key: string; value: string }>;
  workspaceStats: {
    name: string;
    sessionCount: number;
    chunkCount: number;
    lastIngestedAt: number | null;
    recentTopics: string[];  // top 3 chunk summaries
  } | null;
  lastRetrieval: {
    coreMatched: number;
    chunksRetrieved: number;
    chunksExpanded: number;
    tokensInjected: number;
    sources: Array<{ workspace: string; summary: string; expanded: boolean }>;
    durationMs: number;
  } | null;
}

// Delete a core memory entry
'memory.deleteCoreEntry' → { success: boolean }

// Event pushed to renderer after each turn
'memory.retrievalUpdate' → LastRetrievalData
```

### Renderer State

Add to the Zustand store:

```typescript
interface MemoryPanelState {
  memoryEnabled: boolean;
  skillFallbackEnabled: boolean;
  coreEntries: CoreEntry[];
  workspaceStats: WorkspaceStats | null;
  lastRetrieval: LastRetrievalData | null;
  memoryPanelOpen: boolean;
}
```

### Main Process Changes

1. **Instrument `buildPromptPrefix()`** — capture retrieval metrics (counts, timing,
   sources) and store them on the session object or emit via event.

2. **Add `memory.getPanelState` IPC handler** — aggregates data from:
   - `memoryService.isEnabled()`
   - `skillsManager.getAllSkills()` → find cowork-memory skill state
   - `memoryService.getOverview(cwd)` → core entries + workspace stats
   - Last retrieval metrics (stored per-session)

3. **Emit `memory.retrievalUpdate` event** — after each `beforeSessionRun` completes,
   push retrieval metrics to the renderer via `sendToRenderer()`.

---

## Visual Design

### Color Coding

| Element           | Color                                       | Meaning               |
| ----------------- | ------------------------------------------- | --------------------- |
| Green dot (●)     | `text-green-500`                            | Memory active         |
| Red dot (●)       | `text-red-500`                              | Memory disabled       |
| Core entries      | Default text                                | Stable profile        |
| [×] delete        | `text-text-muted` → `text-red-500` on hover | Destructive action    |
| Token count       | `text-amber-600`                            | Resource awareness    |
| Retrieval sources | `text-text-secondary`                       | Supporting detail     |
| "expanded" badge  | `text-accent`                               | Navigator took action |

### Typography

- Section headers: `text-xs font-medium text-text-muted uppercase tracking-wider` (matches existing)
- Entry text: `text-xs text-text-primary`
- Stats numbers: `text-sm font-semibold text-text-primary`
- Muted labels: `text-xs text-text-muted`

### Spacing

- Section padding: `px-4 py-2.5` (matches existing accordion sections)
- Entry list: `space-y-1`
- Between sub-sections: `border-b border-border-muted` divider

---

## Interaction States

### Empty States

| Condition               | Display                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| Memory disabled         | "Memory is disabled. Enable in Settings to start learning from your sessions." |
| No core entries yet     | "No profile built yet. The system learns about you after a few sessions."      |
| No workspace data       | "No sessions recorded for this workspace yet."                                 |
| No retrieval yet        | "Send a message to see memory activity."                                       |
| Retrieval found nothing | "No relevant memory found for the last query."                                 |

### Loading States

- Panel mount: skeleton shimmer for 200ms while `memory.getPanelState` resolves
- After turn: "Last Retrieval" section shows a brief pulse animation when updated

### Error States

- If `memory.getPanelState` fails: "Unable to load memory status" with retry button
- If delete fails: toast notification "Failed to delete memory entry"

---

## Accessibility

- All interactive elements have `aria-label` and keyboard focus
- [×] delete buttons have `aria-label="Delete memory: {entry value}"`
- Section expand/collapse uses `aria-expanded`
- Color indicators have text labels (not color-only)
- Token count uses `aria-live="polite"` for screen reader updates after each turn

---

## Implementation Plan

### Phase 1: Static Panel (read-only) ✅ DONE (2026-05-22)

1. Create `MemoryLensSection.tsx` component
2. Add `memory.getPanelState` IPC handler
3. Wire into ContextPanel as a new collapsible section
4. Display status + core entries + workspace stats
5. "Last Retrieval" shows placeholder until Phase 2

### Phase 2: Live Retrieval Metrics ✅ DONE (2026-05-22)

1. Instrument `buildPromptPrefix()` to capture metrics
2. Store metrics per-session in memory
3. Emit `memory.retrievalUpdate` event to renderer
4. Update "Last Retrieval" section in real-time after each turn

### Phase 3: Interactive Features (2026-05-22)

1. [×] delete buttons for core entries ✅
2. Inline editing of core memory values ✅
3. "Full Memory View" modal with search/filter — deferred (added "View all →" link to Settings → Memory as interim)
4. Click-to-expand on retrieval sources (show full chunk text) ✅

### Phase 4: Polish

1. Animations (pulse on update, smooth expand/collapse)
2. Token budget visualization (bar showing memory % of total context)
3. Historical retrieval log (last 5 turns, not just the latest)
4. "Memory contributed to this response" indicator in chat messages

---

## Open Questions

1. **Should the panel show memory from ALL workspaces or only the current one?**
   Current design shows current workspace stats + retrieval sources from any workspace.
   Could add a "Cross-workspace" toggle.

2. **Should users be able to add manual entries from the panel?**
   Core memory is currently LLM-extracted only. A "Remember this" button could
   let users manually pin facts. This blurs the line with the cowork-memory skill.

3. **Token budget visualization — absolute or relative?**
   **Decision: absolute.** Show `~1,200 tokens` as-is. Users who care about token
   budgets think in absolute numbers. The relative % is already visible in the
   Context Usage bar above.
   "~1,200 tokens" is absolute. Could also show "3% of context window" as a
   progress bar. Depends on whether the user cares about absolute numbers or
   relative impact.

4. **Should retrieval sources be clickable to show the full chunk?**
   Useful for debugging but adds complexity. Could be a Phase 3 feature.

5. **Notification when memory learns something new?**
   After ingestion, could show a brief toast: "Learned 3 new things from this session."
   Risk: notification fatigue.

---

## References

- Existing panel: `src/renderer/components/ContextPanel.tsx`
- Memory service: `src/main/memory/memory-service.ts`
- Memory extension: `src/main/memory/memory-extension.ts`
- Core memory store: `src/main/memory/core-memory-store.ts`
- Experience store: `src/main/memory/experience-memory-store.ts`
- Design paradigms: [7 Design Paradigms for Human-AI Interfaces](https://medium.com/design-bootcamp/7-design-paradigms-for-human-ai-interfaces-you-probably-havent-heard-of-but-should-care-about-7c909f2db3db)
- Memory settings UI: `src/renderer/components/settings/SettingsMemory.tsx`
