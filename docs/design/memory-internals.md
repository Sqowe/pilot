# Memory System Internals

This document explains two key aspects of the memory subsystem:
how the embedding/LLM configuration inherits from the active API,
and how the workspace (working directory) partitions memory per project.

---

## 1. Embedding "Inherit Active API"

### Config Structure

The memory runtime has two model sub-configs — `llm` and `embedding` — both
sharing the same `MemoryModelRuntimeConfig` interface:

```typescript
// src/main/config/config-store.ts
export interface MemoryModelRuntimeConfig {
  inheritFromActive: boolean;
  provider?: ProviderType; // NOT exposed in the Settings UI
  customProtocol?: CustomProtocolType; // NOT exposed in the Settings UI
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
}
```

The Settings UI (`SettingsMemory.tsx`) exposes only:

- **Inherit active API** toggle (`inheritFromActive`)
- **Model override** (`model`)
- **Base URL override** (`baseUrl`)
- **API Key override** (`apiKey`)

The `provider` and `customProtocol` fields exist in the type but are **not
configurable from the UI** — they can only be set programmatically or via
raw config file edits.

### Resolution Logic

The core resolution happens in `normalizeModelConfig()` inside
`src/main/memory/memory-llm-client.ts`:

```typescript
function normalizeModelConfig(
  appConfig: AppConfig,
  input: MemoryModelConfig | undefined,
  fallbackModel: string
): ResolvedMemoryModelConfig {
  const inherit = input?.inheritFromActive !== false;

  const provider = inherit ? activeProvider : input?.provider || activeProvider;
  const customProtocol = inherit ? activeProtocol : input?.customProtocol || activeProtocol;
  const apiKey = inherit ? activeApiKey : input?.apiKey || '';
  const baseUrl = inherit ? activeBaseUrl : input?.baseUrl || activeBaseUrl;
  const model = (input?.model || (inherit ? activeModel : '') || fallbackModel).trim();
  const timeoutMs = Math.max(5_000, input?.timeoutMs || 180_000);

  return { provider, customProtocol, apiKey, baseUrl, model, timeoutMs };
}
```

### What "Inherit Active API" Actually Inherits

When `inheritFromActive: true` (the checkbox is checked):

| Field            | Source                                                                     |
| ---------------- | -------------------------------------------------------------------------- |
| `provider`       | App's active provider (e.g., `openrouter`, `anthropic`)                    |
| `customProtocol` | App's active custom protocol                                               |
| `apiKey`         | App's active API key                                                       |
| `baseUrl`        | App's active base URL                                                      |
| `model`          | **Model override field first**, then active model, then hardcoded fallback |

**Key insight:** Everything is inherited from the active API config **except
the model**, which prioritizes the "Model override" field. The resolution
order for model is:

1. `input.model` (the "Model override" field — e.g., `text-embedding-3-small`)
2. Active model from the main API config (e.g., `claude-sonnet-4-6`)
3. Hardcoded fallback (`'text-embedding-3-small'` for embedding)

Since the default config ships with `model: 'text-embedding-3-small'` in the
embedding section, that value wins over the active model.

### Provider Compatibility Warning

The `embed()` method in `MemoryLLMClient` checks whether the resolved provider
supports embeddings:

```typescript
const isOpenAiCompatible =
  provider === 'openai' ||
  provider === 'openrouter' ||
  provider === 'ollama' ||
  (provider === 'custom' && protocol === 'openai');

if (!isOpenAiCompatible) {
  logWarn(
    '[MemoryLLMClient] Embedding requested for unsupported provider; returning empty embedding:',
    provider
  );
  return [];
}
```

If your active provider is **Anthropic** (which doesn't have an embeddings
endpoint), and you have "Inherit active API" checked, embedding calls will
**silently return empty arrays**. The memory system won't crash, but semantic
search quality degrades to keyword-only.

**Workaround:** If using Anthropic as your main provider, uncheck "Inherit
active API" for embedding and manually set the Base URL and API Key to an
OpenAI-compatible endpoint (e.g., OpenRouter or OpenAI directly).

### Default Configuration

```typescript
const DEFAULT_MEMORY_RUNTIME: MemoryRuntimeConfig = {
  llm: {
    inheritFromActive: true,
    apiKey: '',
    baseUrl: '',
    model: '', // empty → uses active model
    timeoutMs: 180000,
  },
  embedding: {
    inheritFromActive: true,
    apiKey: '',
    baseUrl: '',
    model: 'text-embedding-3-small', // always overrides active model
    timeoutMs: 180000,
  },
  useEmbedding: false, // embedding is OFF by default
  // ...
};
```

---

## 2. Memory Workspace (Working Directory)

### What "Current workspace" Means on the Memory Settings Page

The Memory settings page displays "Current workspace" which is resolved in
`SettingsMemory.tsx` as:

```typescript
const currentSession = sessions.find((session) => session.id === activeSessionId);
const currentWorkspace = currentSession?.cwd || workingDir || '';
```

Resolution priority:

1. **Active session's cwd** — the chat you currently have open
2. **Global workingDir** from the app store — if no active session or it has no cwd
3. **Empty string** — fallback

### How Working Directories Are Assigned to Sessions

Each chat session stores its own `cwd` in the SQLite database. The flow:

1. **New chat creation** (`WelcomeView` → `session.start`):
   - The WelcomeView reads `workingDir` from the app store (whatever folder
     is currently displayed in the UI)
   - Passes it as `cwd` to `startSession(title, content, workingDir)`
   - `SessionManager.createSession()` stores it:
     `effectiveCwd = cwd || process.env.COWORK_WORKDIR || process.env.WORKDIR || process.env.DEFAULT_CWD`
   - The cwd is **persisted to the database** with the session

2. **Switching between chats:**
   - The UI resolves: `activeSession?.cwd || workingDir`
   - Each session retains its own stored cwd independently

3. **Changing workdir mid-chat** (`workdir.set` with sessionId):
   - Stops any active agent run (Claude SDK sessions are bound to cwd)
   - Updates the DB: new cwd, clears `claude_session_id` and `openai_thread_id`
   - Clears in-memory SDK session cache (forces fresh session on next query)
   - Notifies renderer via `session.update`

### The Global Default

At app startup, `initializeDefaultWorkingDir()` creates:

```
/Users/<user>/Library/Application Support/open-cowork/default_working_dir
```

This is the **permanent global fallback**. It never changes after initialization.
New sessions created without selecting a folder get this path as their cwd.

### How Memory Uses the Workspace Key

The memory system uses the session's cwd as a **partitioning key** via
`normalizeWorkspaceKey()`:

```typescript
// src/main/memory/memory-utils.ts
export function normalizeWorkspaceKey(cwd?: string | null): string | null {
  if (!cwd) return null;
  try {
    return path.resolve(cwd);
  } catch {
    return cwd;
  }
}
```

This is simply `path.resolve(cwd)` — the absolute path becomes the workspace key.

During ingestion, each session's memories are tagged with its workspace key:

```typescript
const sourceWorkspace = normalizeWorkspaceKey(session.cwd);
```

### Memory Scoping Behavior

| Scenario                                | Workspace Key                                             | Memory Isolation                       |
| --------------------------------------- | --------------------------------------------------------- | -------------------------------------- |
| Chat with cwd `/Users/me/src/project-a` | `/Users/me/src/project-a`                                 | Memories scoped to project-a           |
| Chat with cwd `/Users/me/src/project-b` | `/Users/me/src/project-b`                                 | Memories scoped to project-b           |
| Chat with no folder selected            | `.../Application Support/open-cowork/default_working_dir` | All "homeless" chats share this bucket |

### Memory Search Scoping

From the Memory settings page, search uses the current workspace:

```typescript
const nextResults = await window.electronAPI.memory.search({
  query: trimmed,
  cwd: hasWorkspace ? currentWorkspace : undefined,
  scope: scope, // 'workspace' | 'all' | 'global'
  sourceWorkspace: scope === 'workspace' ? currentWorkspace : sourceWorkspaceFilter || undefined,
  limit: 20,
});
```

- **workspace** scope: only memories from sessions with the same cwd
- **all** scope: memories from all workspaces
- **global** scope: core memory entries (workspace-independent)

### Memory Context Injection at Query Time

When the agent runs a query, `MemoryExtension.beforeSessionRun()` injects core memory
passively and registers workspace chat search tools for active retrieval:

```typescript
// Core memory: always injected (passive)
const relevantEntries = this.getCoreStore().getEntriesForWorkspace(currentWorkspace);

// Experience memory: available via tools (active, on-demand)
customTools: createWorkspaceChatSearchTools(this.memoryService, session.cwd);
```

The model receives `search_workspace_chats` and `read_workspace_chat` tools scoped to
the current workspace. It decides autonomously when to search past conversations —
for example, when the user references a prior decision or asks to continue previous work.

This replaces the previous approach where experience memory was pre-injected into every
prompt via a Navigator LLM. The active approach saves context window budget and gives
the model explicit control over what past context it retrieves.

### Practical Implications

1. **Always select a project folder** when starting a new chat if you want
   proper memory isolation per project.

2. Sessions created with the `default_working_dir` path get their memories
   grouped together — this is rarely useful since it mixes unrelated conversations.

3. The "Current workspace" on the Memory settings page reflects whichever
   chat is currently active. Switch to a different chat to see/search that
   project's memories.

4. **Rebuild workspace** and **Clear workspace** operations on the Memory
   settings page only affect the currently displayed workspace key.

---

## Key Files

| File                                                  | Role                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `src/main/memory/memory-llm-client.ts`                | Embedding and LLM client with `normalizeModelConfig`            |
| `src/main/memory/memory-service.ts`                   | Core memory service (ingestion, search, rebuild)                |
| `src/main/memory/memory-utils.ts`                     | `normalizeWorkspaceKey`, file helpers                           |
| `src/main/config/config-store.ts`                     | `MemoryRuntimeConfig` type and defaults                         |
| `src/renderer/components/settings/SettingsMemory.tsx` | Memory settings UI                                              |
| `src/main/session/session-manager.ts`                 | Session creation and cwd management                             |
| `src/main/index.ts`                                   | `initializeDefaultWorkingDir`, `setWorkingDir`, `getWorkingDir` |
