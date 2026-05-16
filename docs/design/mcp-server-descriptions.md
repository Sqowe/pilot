# MCP Server Descriptions — Design Document

> Feature: User-facing and LLM-facing descriptions for MCP servers to improve tool routing
> Status: Draft
> Author: AI-assisted design session
> Date: 2026-05-16

---

## 1. Overview

Add a `description` field to MCP server configurations that helps the LLM choose the
correct server/tool when multiple MCP servers are connected. Descriptions are
auto-generated via the user's configured LLM on first server connection, with a
heuristic fallback when no LLM is available. Users always retain full control: they can
edit descriptions manually, and the system notifies (never auto-regenerates) when the
tool list changes.

**Problem:** When multiple MCP servers are connected, the LLM sees a flat list of tools
named `mcp__<ServerName>__<toolName>`. The only disambiguation signals are tool names
and their individual descriptions (which come from the MCP server and are often generic
or missing). There is no server-level context telling the LLM _what domain_ each server
covers.

**Solution:** A server-level description injected into the LLM's context as a routing
hint. Generated automatically from the tool list, editable by the user, with change
detection that notifies rather than silently overwrites.

---

## 2. Key Design Decisions

| #   | Decision                                               | Rationale                                                                 |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `description` field on MCPServerConfig                 | Minimal schema change, stored alongside existing config                   |
| 2   | Auto-generate via LLM one-shot on first tool discovery | Zero-effort for users; leverages existing `runPiAiOneShot` infrastructure |
| 3   | Heuristic fallback when LLM unavailable                | Works even before API key is configured                                   |
| 4   | Never auto-regenerate on tool change                   | User retains control; avoids overwriting manual edits                     |
| 5   | Notify user when tool list hash changes                | User decides whether to regenerate                                        |
| 6   | `descriptionSource: 'auto'                             | 'manual'` tracking                                                        | Suppress stale notifications for manually-written descriptions |
| 7   | Inject as "MCP Server Directory" in system prompt      | One-time token cost, clear routing map for the LLM                        |
| 8   | Async, non-blocking generation                         | Don't delay tool availability on server connect                           |

---

## 3. Data Model

### 3.1 MCPServerConfig Changes

```typescript
// In src/main/mcp/mcp-manager.ts
export interface MCPServerConfig {
  id: string;
  name: string;
  description?: string; // NEW: server-level description for LLM routing
  descriptionToolsHash?: string; // NEW: SHA-256 hash of tool list when description was last generated
  descriptionSource?: 'auto' | 'manual'; // NEW: how the description was created
  type: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}
```

### 3.2 Shared IPC Type (mirrors main)

```typescript
// In src/shared/ipc-types.ts
export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  descriptionToolsHash?: string;
  descriptionSource?: 'auto' | 'manual';
  type: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}
```

### 3.3 Tools Hash Computation

```typescript
function computeToolsHash(tools: MCPTool[]): string {
  // Deterministic: sort by name, include name + description
  const payload = tools
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}
```

Only tool names and descriptions are included in the hash — not schemas (too volatile
for minor parameter changes that don't affect the server's purpose).

---

## 4. Auto-Generation Flow

### 4.1 Trigger: First Tool Discovery

```
MCPManager.refreshTools() completes for a server
  │
  ├─ Tools loaded successfully
  │
  ├─ Check: config.description exists AND config.descriptionSource is set?
  │     └─ YES → skip generation (already has a description)
  │
  ├─ Check: LLM is configured and reachable?
  │     ├─ YES → call generateServerDescription() (async, non-blocking)
  │     └─ NO → use heuristic fallback
  │
  ├─ Save description + hash + source='auto' to config store
  │
  └─ Emit 'mcp:description-generated' event to renderer (for UI feedback)
```

### 4.2 LLM Generation

Uses the existing `runPiAiOneShot()` from `claude-sdk-one-shot.ts`:

```typescript
// New file: src/main/mcp/mcp-description-generator.ts

import { runPiAiOneShot } from '../claude/claude-sdk-one-shot';
import { configStore } from '../config/config-store';
import type { MCPTool } from './mcp-manager';

const SYSTEM_PROMPT = `You generate concise MCP server descriptions for LLM tool routing.
Given a server name and its tool list, write a single sentence (max 25 words) describing
what this server does. Focus on the domain and capabilities, not individual tools.
Reply with only the description text, no quotes, no prefix.`;

export async function generateServerDescription(
  serverName: string,
  tools: MCPTool[]
): Promise<string | null> {
  const toolList = tools
    .map((t) => `- ${t.name}: ${t.description || '(no description)'}`)
    .join('\n');

  const userPrompt = `Server name: "${serverName}"\nTools:\n${toolList}`;

  try {
    const config = configStore.getAll();
    const result = await runPiAiOneShot(userPrompt, SYSTEM_PROMPT, config, {
      temperature: 0,
      maxTokens: 100,
    });
    return result.text.trim() || null;
  } catch {
    return null;
  }
}
```

**Token cost estimate:** ~150–300 input tokens (depending on tool count), ~20–30 output
tokens. Negligible cost, runs once per server.

### 4.3 Heuristic Fallback

When the LLM is unavailable (no API key, network error, etc.):

```typescript
export function generateHeuristicDescription(serverName: string, tools: MCPTool[]): string {
  // Extract unique action verbs from tool names
  const verbs = new Set<string>();
  const prefix = findCommonPrefix(tools.map((t) => t.name));

  for (const tool of tools) {
    // Strip common prefix and extract first word (usually a verb)
    const stripped = tool.name.replace(prefix, '').replace(/^_/, '');
    const firstWord = stripped.split(/[_\-]/)[0];
    if (firstWord && firstWord.length > 2) {
      verbs.add(firstWord);
    }
  }

  const verbList = Array.from(verbs).slice(0, 5).join(', ');
  const cleanName = serverName.replace(/[_\-]/g, ' ');

  return verbList ? `${cleanName}: ${verbList}` : `${cleanName} (${tools.length} tools)`;
}

function findCommonPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const sorted = [...names].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let i = 0;
  while (i < first.length && first[i] === last[i]) i++;
  // Only use prefix if it ends at a word boundary
  const prefix = first.slice(0, i);
  const lastSep = Math.max(prefix.lastIndexOf('_'), prefix.lastIndexOf('-'));
  return lastSep > 0 ? prefix.slice(0, lastSep + 1) : '';
}
```

**Examples:**

- Firecrawl tools → `"Firecrawl: scrape, search, crawl, map, extract"`
- Context7 tools → `"Context7: resolve, query"`
- A generic server → `"My Server (8 tools)"`

---

## 5. Tool List Change Detection

### 5.1 Detection (on every refreshTools)

```
MCPManager.refreshTools() completes
  │
  ├─ Compute new hash from current tool list
  │
  ├─ Compare with config.descriptionToolsHash
  │     └─ MATCH → done, no action
  │
  ├─ MISMATCH detected:
  │     ├─ Update descriptionToolsHash in config (always track latest)
  │     ├─ Check descriptionSource:
  │     │     ├─ 'manual' → do NOT notify (user wrote it intentionally)
  │     │     └─ 'auto' → emit notification to renderer
  │     └─ Emit 'mcp:tools-changed' event with { serverId, serverName, oldHash, newHash }
  │
  └─ Renderer shows notification (see UI section)
```

### 5.2 User Actions on Notification

- **"Regenerate"** → fires LLM one-shot, updates description + hash, source stays 'auto'
- **"Dismiss"** → updates hash only (acknowledges change, keeps current description)
- **"Edit"** → opens description editor, source becomes 'manual' on save

---

## 6. LLM Context Injection

### 6.1 System Prompt Section

When building the system prompt for a query, inject a "MCP Server Directory" section
listing all connected servers with descriptions:

```typescript
// In agent-runner.ts, during system prompt assembly

function buildMcpServerDirectory(mcpManager: MCPManager): string {
  const servers = mcpConfigStore.getEnabledServers();
  const statuses = mcpManager.getServerStatus();
  const connected = statuses.filter((s) => s.connected);

  if (connected.length === 0) return '';

  const lines = connected.map((server) => {
    const config = servers.find((s) => s.id === server.id);
    const description = config?.description || `(${server.toolCount} tools)`;
    return `- ${config?.name || server.name}: ${description}`;
  });

  return `\n## MCP Server Directory\n\nAvailable MCP servers and their capabilities:\n${lines.join('\n')}\n\nUse the appropriate server's tools based on the task domain.\n`;
}
```

**Example output injected into system prompt:**

```
## MCP Server Directory

Available MCP servers and their capabilities:
- Firecrawl: Web scraping, crawling, search, and structured data extraction from websites.
- Context7: Library and framework documentation lookup with version-specific code examples.
- Software_Development: File system operations, code search, and project management.

Use the appropriate server's tools based on the task domain.
```

### 6.2 Token Budget Impact

Estimated cost per server: ~15–25 tokens for the description line.
With 5 servers: ~100–150 tokens total for the directory section.
This is negligible compared to the tool schemas themselves (which can be 500+ tokens each).

### 6.3 Alternative: Prefix on Tool Descriptions

As a complementary signal, optionally prepend the server description to each tool's
description in `buildMcpCustomTools()`:

```typescript
description: config?.description
  ? `[${mcpTool.serverName}] ${mcpTool.description}`
  : mcpTool.description || `MCP tool from ${mcpTool.serverName}`,
```

**Recommendation:** Use the system prompt directory as the primary signal. The per-tool
prefix is optional and adds token overhead proportional to tool count. Start without it
and add only if the directory alone proves insufficient.

---

## 7. IPC Events

### New server events (main → renderer)

| Event                       | Payload                                              | When                                        |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| `mcp:description-generated` | `{ serverId, serverName, description, source }`      | Description auto-generated on first connect |
| `mcp:tools-changed`         | `{ serverId, serverName, toolsAdded, toolsRemoved }` | Tool list hash mismatch detected            |

### New IPC handlers (renderer → main)

| Handler                     | Payload                     | Returns           | When                            |
| --------------------------- | --------------------------- | ----------------- | ------------------------------- |
| `mcp.regenerateDescription` | `{ serverId }`              | `{ description }` | User clicks "Regenerate"        |
| `mcp.saveDescription`       | `{ serverId, description }` | `{ success }`     | User manually edits description |

---

## 8. UI Components

### 8.1 MCP Server Settings Card

Extend the existing server configuration card with:

```
┌─────────────────────────────────────────────────────────┐
│  Firecrawl                              [Connected ●]    │
│                                                          │
│  Description:                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Web scraping, crawling, and structured data       │  │
│  │ extraction from websites.              [✨ auto]   │  │
│  └────────────────────────────────────────────────────┘  │
│  [Edit] [Regenerate]                                     │
│                                                          │
│  Type: stdio                                             │
│  Command: npx @anthropic/firecrawl-mcp-server            │
│  Tools: 12 connected                                     │
└─────────────────────────────────────────────────────────┘
```

- **Description field:** Read-only by default, shows current description with source badge
- **[Edit] button:** Makes field editable, sets `descriptionSource: 'manual'` on save
- **[Regenerate] button:** Fires LLM one-shot, replaces description, sets source to 'auto'
- **✨ auto badge:** Indicates description was auto-generated (helps user know it's safe to override)
- **✍️ manual badge:** Indicates user wrote it (suppresses stale notifications)

### 8.2 Tools Changed Notification

When tool list hash changes and `descriptionSource === 'auto'`:

```
┌─────────────────────────────────────────────────────────┐
│  ⚠️  Tools changed for "Firecrawl"                       │
│                                                          │
│  2 tools added, 1 removed since description was          │
│  generated. Description may be outdated.                 │
│                                                          │
│  [Regenerate Description]  [Dismiss]  [Edit Manually]    │
└─────────────────────────────────────────────────────────┘
```

This appears as:

- A toast notification, OR
- An inline warning badge on the server card in settings

### 8.3 Empty State (first connection, generating)

While the LLM is generating the description:

```
Description: Generating... ⏳
```

If generation fails:

```
Description: Firecrawl: scrape, search, crawl, map, extract  [heuristic]
[Regenerate with AI]
```

---

## 9. Implementation Plan

### Phase 1: Data Model & Config Store

1. Add `description`, `descriptionToolsHash`, `descriptionSource` to `MCPServerConfig`
2. Mirror changes in `src/shared/ipc-types.ts` (`McpServerConfig`)
3. Update `MCPConfigStore` serialization/deserialization
4. Add `computeToolsHash()` utility
5. Ensure backward compatibility (existing configs without new fields work unchanged)

### Phase 2: Description Generator Module

1. Create `src/main/mcp/mcp-description-generator.ts`
2. Implement `generateServerDescription()` (LLM one-shot)
3. Implement `generateHeuristicDescription()` (fallback)
4. Unit tests for heuristic generation (deterministic, no LLM needed)

### Phase 3: Integration with MCPManager

1. Hook into `refreshTools()` — trigger generation when description is empty
2. Hook into `refreshTools()` — detect tool list hash changes
3. Emit events to renderer on generation complete / tools changed
4. Ensure async/non-blocking (don't delay tool availability)

### Phase 4: System Prompt Injection

1. Implement `buildMcpServerDirectory()` in agent-runner
2. Inject into system prompt assembly (after MCP servers config is built)
3. Verify token budget impact with multiple servers

### Phase 5: IPC & Renderer Integration

1. Add `mcp.regenerateDescription` IPC handler
2. Add `mcp.saveDescription` IPC handler
3. Wire `mcp:description-generated` and `mcp:tools-changed` events
4. Handle events in renderer state management

### Phase 6: UI

1. Add description display to MCP server settings card
2. Add Edit/Regenerate buttons
3. Add source badge (auto/manual)
4. Add tools-changed notification (toast or inline warning)
5. Add loading state during generation

---

## 10. Presets Update

Update `MCP_SERVER_PRESETS` in `mcp-config-store.ts` to include default descriptions
for built-in servers:

```typescript
export const MCP_SERVER_PRESETS = {
  chrome: {
    name: 'Chrome',
    description: 'Browser automation and DevTools interaction via Chrome.',
    // ...
  },
  'software-development': {
    name: 'Software_Development',
    description: 'File system operations, code search, and project workspace management.',
    // ...
  },
  'gui-operate': {
    name: 'GUI_Operate',
    description: 'GUI automation via vision models — click, type, screenshot desktop apps.',
    // ...
  },
};
```

Preset descriptions use `descriptionSource: 'auto'` so users can still regenerate them.

---

## 11. Edge Cases

| Scenario                                | Behavior                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Server has 0 tools (connects but empty) | Heuristic: `"ServerName (no tools discovered)"`                          |
| Server has 50+ tools                    | Truncate tool list in LLM prompt to first 30 tools (token budget)        |
| LLM returns empty/garbage               | Fall back to heuristic, log warning                                      |
| User clears description field           | Set to empty string, source='manual', no auto-generation triggered       |
| Server disconnects and reconnects       | Keep existing description, only check hash on successful tool refresh    |
| Multiple servers with same name         | Each has independent description (keyed by server ID, not name)          |
| Config migration (existing servers)     | Fields default to undefined — first successful refreshTools triggers gen |

---

## 12. Security Considerations

- The description is generated from tool names/descriptions that come from the MCP server.
  These are **untrusted input**. The generated description is sanitized before injection
  into the system prompt (strip control characters, limit length to 200 chars).
- The LLM one-shot call uses the user's own API key and model — no external service.
- Descriptions are stored locally in the config store (same security boundary as other
  MCP config like env vars and API keys).

---

## 13. Future Considerations (not in scope)

- **Per-tool routing hints** — more granular than server-level (complexity vs. benefit)
- **Description quality scoring** — rate how well a description disambiguates from others
- **Multi-language descriptions** — generate in user's UI language
- **Description sharing** — export/import descriptions for common server setups
- **MCP spec proposal** — upstream a `serverDescription` field to the MCP protocol itself

---

## 14. References

- MCP Tools Specification: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Existing one-shot LLM utility: `src/main/claude/claude-sdk-one-shot.ts`
- MCP config store: `src/main/mcp/mcp-config-store.ts`
- MCP manager (tool bridging): `src/main/mcp/mcp-manager.ts`
- Agent runner (system prompt assembly): `src/main/claude/agent-runner.ts`
- Architecture doc: `ARCHITECTURE.md` (Section 4.3: MCP & Tools)
- AI coding rules: `AI_MAIN_PROCESS.md` (MCP Tool Bridging section)
