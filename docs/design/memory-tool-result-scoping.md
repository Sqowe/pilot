# Memory: Tool Result Scoping

**Created:** 2026-06-05
**Status:** Draft
**Problem:** MCP tool responses contaminate core memory across workspaces

---

## 1. Problem Statement

The memory profiler treats all content in the session transcript equally — user messages, assistant responses, and MCP tool results. This causes two issues:

### 1.1 Cross-Workspace Contamination

When the Claude CoWork Memory MCP server returns workspace-specific content (e.g., "Writing business plans for privden" from the Tree Hu workspace), the profiler extracts it as a core memory entry. If the same content is later "confirmed" in a second workspace (via another CoWork memory read), the entry promotes to global visibility and appears in every unrelated workspace.

**Observed behavior:**

```
Tree Hu session → cowork_read_memory returns privden context
  → profiler creates interests.privden (sourceWorkspaces: [tree-hu])
    → OpenHab session → profiler sees entry in existing core memory, confirms it
      → sourceWorkspaces: [tree-hu, openhab] → global → visible in GitLab workspace
```

### 1.2 Operational Noise

Generic MCP tool responses (firecrawl scrape results, filesystem reads, web search output) are operational artifacts. They should never influence the user profile. Currently they are included in the transcript and can produce spurious core memory entries.

---

## 2. Design Principles

1. **Only user-stated content can promote cross-workspace.** Cross-workspace promotion (the `sourceWorkspaces.length >= 2` rule) must only apply to entries derived from direct user/assistant conversation, not from tool-fetched external content.

2. **CoWork memory IS user memory, but workspace-scoped.** The CoWork memory MCP server returns accumulated knowledge from a specific project. This content is legitimate and should be available to the profiler for that workspace — but entries derived from it must stay pinned to that workspace.

3. **Other MCP tool results are operational data.** They should be excluded from core memory extraction entirely.

---

## 3. Classification of Tool Results

| Tool source                                      | Include in profiler transcript? | Can promote cross-workspace? |
| ------------------------------------------------ | ------------------------------- | ---------------------------- |
| User messages (role: user)                       | ✅ Yes                          | ✅ Yes                       |
| Assistant messages (role: assistant, type: text) | ✅ Yes                          | ✅ Yes                       |
| CoWork memory MCP tools (`cowork_*`)             | ✅ Yes                          | ❌ No — workspace-pinned     |
| All other MCP tool results                       | ❌ No — excluded                | N/A                          |
| Built-in tool results (read_file, bash, etc.)    | ❌ No — excluded                | N/A                          |

---

## 4. Implementation

### 4.1 New Field: `workspacePinned` on CoreMemoryEntry

```typescript
export interface CoreMemoryEntry {
  combinedKey: string;
  category?: CoreMemoryCategory;
  key: string;
  value: string;
  sourceWorkspaces?: string[];
  /** If true, entry never promotes to global — stays in its source workspace only. */
  workspacePinned?: boolean;
}
```

### 4.2 Modify `getEntriesForWorkspace()` in `core-memory-store.ts`

```typescript
getEntriesForWorkspace(currentWorkspace: string | null): CoreMemoryEntry[] {
  return this.getEntries().filter((entry) => {
    const workspaces = entry.sourceWorkspaces || [];
    if (workspaces.length === 0) return false;
    if (workspaces.includes(GLOBAL_WORKSPACE_SENTINEL)) return true;

    // Workspace-pinned entries: only show in their source workspace(s)
    if (entry.workspacePinned) {
      return currentWorkspace != null && workspaces.includes(currentWorkspace);
    }

    // Normal promotion rules
    if (workspaces.length >= 2) return true;
    if (currentWorkspace && workspaces.includes(currentWorkspace)) return true;
    return false;
  });
}
```

### 4.3 Modify `extractTextFromContent()` in `memory-utils.ts`

Current (includes everything):

```typescript
case 'tool_result':
  return block.content;
case 'tool_use':
  return `${block.name} ${JSON.stringify(block.input)}`;
```

New approach — add a filtering layer. The function needs context about which tool produced the result.

**Option A: Filter at transcript construction time (preferred)**

Change `messagesToTranscript()` to accept a tool classification function and produce two separate transcript segments:

```typescript
export interface TranscriptBuildOptions {
  /** Tool names whose results should be included but workspace-pinned */
  pinnedToolPatterns: RegExp[];
  /** If not matched by pinnedToolPatterns, tool results are excluded entirely */
}

export interface TranscriptResult {
  /** Turns from user/assistant text + pinned tool results */
  turns: MemoryTranscriptTurn[];
  /** Whether any pinned tool results were included */
  hasPinnedToolContent: boolean;
}
```

Default `pinnedToolPatterns`: `[/^mcp__claude_cowork_memory__cowork_/]`

This regex matches all tools from the `claude-cowork-memory` MCP server (tool names follow the pattern `mcp__<serverName>__<toolName>`).

**Filtering logic:**

```typescript
export function messagesToTranscript(
  messages: Message[],
  options?: TranscriptBuildOptions
): TranscriptResult {
  const pinnedPatterns = options?.pinnedToolPatterns ?? [/^mcp__claude_cowork_memory__cowork_/];
  let hasPinnedToolContent = false;

  const turns = messages
    .map((message): MemoryTranscriptTurn | null => {
      const content = extractTextFromContentFiltered(message.content, pinnedPatterns);
      if (!content.text) return null;
      if (content.hasPinnedContent) hasPinnedToolContent = true;
      return {
        role: message.role,
        content: content.text,
        messageId: message.id,
        timestamp: message.timestamp,
      };
    })
    .filter((item): item is MemoryTranscriptTurn => Boolean(item));

  return { turns, hasPinnedToolContent };
}
```

**Updated content extraction:**

```typescript
function extractTextFromContentFiltered(
  content: ContentBlock[],
  pinnedToolPatterns: RegExp[]
): { text: string; hasPinnedContent: boolean } {
  let hasPinnedContent = false;

  const parts = content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'thinking':
          return block.thinking;
        case 'tool_result': {
          // Find the corresponding tool_use to check the tool name
          const toolName = findToolNameForResult(content, block.toolUseId);
          if (toolName && pinnedPatterns.some((p) => p.test(toolName))) {
            hasPinnedContent = true;
            return block.content; // Include — but will be pinned
          }
          return ''; // Exclude all other tool results
        }
        case 'tool_use': {
          if (pinnedPatterns.some((p) => p.test(block.name))) {
            return `${block.name} ${JSON.stringify(block.input)}`;
          }
          return ''; // Exclude non-pinned tool calls too
        }
        case 'file_attachment':
          return `[file] ${block.filename}`;
        case 'image':
          return '[image]';
        default:
          return '';
      }
    })
    .filter(Boolean);

  return { text: parts.join('\n').trim(), hasPinnedContent };
}
```

### 4.4 Pass `hasPinnedToolContent` to Core Memory Extraction

When the transcript includes pinned tool content, the `CoreMemoryExtractor` marks any newly extracted entries as `workspacePinned: true`.

In `memory-service.ts`, the ingestion pipeline passes this flag through:

```typescript
const { turns, hasPinnedToolContent } = messagesToTranscript(messages, {
  pinnedToolPatterns: this.getPinnedToolPatterns(),
});

// ... later in updateCoreMemory():
const actions = await this.coreExtractor.extract({
  sessionId,
  sessionDate,
  turns,
  existingCorePromptBlock,
  sourceWorkspace,
});

// If transcript contained pinned content, mark all new entries as workspace-pinned
if (hasPinnedToolContent) {
  for (const action of actions) {
    if (action.op === 'upsert') {
      action.workspacePinned = true;
    }
  }
}
```

### 4.5 Modify `applyActions()` to Preserve Pin Flag

In `memory-utils.ts` / `applyCoreMemoryActions()`:

```typescript
// On upsert: if the action has workspacePinned=true, set it on the entry
// If an existing entry is NOT pinned, don't downgrade it — pinned flag only adds restriction
if (action.workspacePinned && !existingEntry?.workspacePinned === false) {
  entry.workspacePinned = true;
}
```

**Edge case:** If a user directly types "I'm working on privden business plans" (without tool involvement), the entry gets created WITHOUT the pin. Later, if CoWork memory returns the same fact, the pin should NOT be added retroactively — the user's direct statement takes precedence.

Rule: `workspacePinned` is only set on **new** entries created from pinned-tool-containing transcripts. Existing unpinned entries are never downgraded.

---

## 5. Configuration

### 5.1 Pinned Tool Patterns (config-store)

```typescript
interface MemoryRuntimeConfig {
  // ... existing fields ...
  /** Tool name patterns whose results are included in extraction but workspace-pinned */
  pinnedToolPatterns?: string[]; // RegExp source strings
}
```

Default: `["^mcp__claude_cowork_memory__cowork_"]`

Configurable via Settings → Memory → Advanced Configuration.

### 5.2 Future Extension

If more MCP servers produce "legitimate user memory that's workspace-scoped" (e.g., a Notion MCP that reads per-project notes), users can add their tool patterns to the pinned list.

---

## 6. Migration

### 6.1 Existing Contaminated Entries

No automatic migration. Users can:

- Delete contaminated entries via the Memory Lens panel (× button)
- Manually mark entries as workspace-pinned via the Edit UI (new checkbox)
- Rebuild memory from scratch (`memory.rebuildAll`) — entries re-extracted with new rules will be correctly scoped

### 6.2 Storage Format

`core_memory.json` entries gain optional `workspacePinned: true` field. Old entries without the field are treated as `workspacePinned: false` (current behavior preserved).

---

## 7. Test Cases

| Scenario                                                  | Expected                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| CoWork memory returns "prefers TypeScript" in workspace A | Entry created, `workspacePinned: true`, visible only in A                         |
| Same fact returned in workspace B                         | Entry gets workspace B added to `sourceWorkspaces`, but still pinned — NOT global |
| User directly types "I prefer TypeScript" in workspace C  | New unpinned entry (or existing one stays unpinned), promotes normally            |
| Firecrawl returns page content mentioning "loves Rust"    | Excluded from transcript entirely — no entry created                              |
| bash tool returns output with user config                 | Excluded from transcript — no entry created                                       |
| User types "I love Rust" in workspace A, then again in B  | Normal promotion → global entry ✓                                                 |
| Existing unpinned entry, CoWork memory confirms it        | Entry stays unpinned (user's direct statement takes precedence)                   |

---

## 8. Implementation Order

| Step                                                          | Effort | Files                                               |
| ------------------------------------------------------------- | ------ | --------------------------------------------------- |
| 1. Add `workspacePinned` field to types                       | Low    | `memory-types.ts`, `renderer/types/index.ts`        |
| 2. Update `getEntriesForWorkspace()` to respect pin           | Low    | `core-memory-store.ts`                              |
| 3. Refactor `extractTextFromContent()` to filter tool results | Medium | `memory-utils.ts`                                   |
| 4. Update `messagesToTranscript()` with filtering             | Medium | `memory-utils.ts`                                   |
| 5. Pass pin flag through ingestion pipeline                   | Low    | `memory-service.ts`                                 |
| 6. Update `applyActions()` to handle pin                      | Low    | `memory-utils.ts`                                   |
| 7. Add config for pinnedToolPatterns                          | Low    | `config-store.ts`                                   |
| 8. UI: show pinned indicator in Memory Lens                   | Low    | `MemoryLensSection.tsx`                             |
| 9. Tests                                                      | Medium | `core-memory-store.test.ts`, `memory-utils.test.ts` |

Total effort: Medium. No architectural changes — additive flag + filtering layer.

---

## 9. Risks

- **False exclusion:** If a user discusses something important while an MCP tool happens to be called in the same message, the user's text is still included (we only exclude tool_result blocks, not the surrounding conversation).
- **CoWork memory patterns hardcoded:** If the MCP server name changes, the regex won't match. Mitigated by making it configurable.
- **Existing contaminated entries:** Users must manually clean up or rebuild. We could add a one-time migration that scans for entries with suspiciously detailed project-specific content, but that's fragile.
