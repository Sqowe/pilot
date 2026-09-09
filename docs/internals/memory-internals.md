# Memory System Internals

This document explains two key aspects of the memory subsystem:
how the embedding/LLM configuration inherits from the active API,
and how the workspace (working directory) partitions memory per project.

---

## 1. Embedding and LLM Configuration

> **Verified against the code on 2026-09-09.** This section previously described a single
> `MemoryModelRuntimeConfig`, claimed the embedding provider could not be set from the UI,
> and documented a hard-coded provider allow-list with a manual workaround. All three were
> out of date — the local-embedding work and the 1.0.6 provider-gate fix changed them. §2
> was re-checked at the same time and needed no changes.

The memory runtime has two model sub-configs, `llm` and `embedding`. They share a common
base but differ in one field, because only embedding can run in-process:

```typescript
// src/main/config/config-store.ts
export interface MemoryModelRuntimeConfigBase {
  inheritFromActive: boolean;
  customProtocol?: CustomProtocolType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
}

/** LLM sub-config: provider is always a ProviderType (never 'local'). */
export interface MemoryLLMRuntimeConfig extends MemoryModelRuntimeConfigBase {
  provider?: ProviderType;
}

/** Embedding sub-config: provider may be 'local' for in-process ONNX inference. */
export interface MemoryEmbeddingRuntimeConfig extends MemoryModelRuntimeConfigBase {
  provider?: EmbeddingProviderType;
}
```

`MemoryModelRuntimeConfig` still exists as a `@deprecated` union alias so older consumers
keep compiling. New code should name the specific one.

### Three embedding modes, all set from the UI

`SettingsMemory.tsx` models the embedding choice as `EmbeddingMode = 'local' | 'inherit' |
'custom'` and writes `embedding.provider` accordingly. The older claim that `provider` and
`customProtocol` were UI-invisible is no longer true for embedding:

| Mode      | Meaning                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `local`   | In-process ONNX inference. No network, no credentials, no active-API coupling |
| `inherit` | Follow the active chat API for endpoint and credentials                       |
| `custom`  | An explicitly named endpoint, key and model, independent of the chat API      |

For the **LLM** sub-config the older statement still holds: the UI exposes the inherit
toggle plus model/base-URL/API-key overrides, and `provider` / `customProtocol` are only
reachable programmatically or by editing the config file.

### Resolution Logic

`normalizeModelConfig()` in `src/main/memory/memory-llm-client.ts` resolves the remote
case. The local case never reaches it — `embed()` checks
`memoryRuntime.embedding?.provider === 'local'` first and routes to the in-process pipeline,
bypassing all credential resolution:

```typescript
const inherit = input?.inheritFromActive !== false;

const rawProvider = inherit ? activeProvider : input?.provider || activeProvider;
// 'local' is handled before this function is called; if it somehow arrives, fall back.
const provider: ProviderType =
  rawProvider === 'local' ? activeProvider : (rawProvider as ProviderType);
const customProtocol = inherit ? activeProtocol : input?.customProtocol || activeProtocol;
const apiKey = inherit ? activeApiKey : input?.apiKey || '';
const baseUrl = inherit ? activeBaseUrl : input?.baseUrl || activeBaseUrl;
const model = (input?.model || (inherit ? activeModel : '') || fallbackModel).trim();
const timeoutMs = Math.max(5_000, input?.timeoutMs || 180_000);
```

### What "Inherit Active API" Actually Inherits

When `inheritFromActive: true`:

| Field            | Source                                                                     |
| ---------------- | -------------------------------------------------------------------------- |
| `provider`       | App's active provider (e.g., `openrouter`, `anthropic`)                    |
| `customProtocol` | App's active custom protocol                                               |
| `apiKey`         | App's active API key                                                       |
| `baseUrl`        | App's active base URL                                                      |
| `model`          | **Model override field first**, then active model, then hardcoded fallback |

Everything is inherited except the model, which prioritises the override field:

1. `input.model` (the "Model override" field)
2. Active model from the main API config
3. Hardcoded fallback (`'text-embedding-3-small'`)

### When embedding is actually attempted

`embed()` returns an empty vector early if `useEmbedding` is off. Past that, two conditions
decide whether a remote embedding call is made — **neither is a provider name allow-list**,
which is what this section used to describe:

```typescript
// A config that names its own endpoint and model does not depend on the chat provider.
const isSelfContainedOverride =
  override?.inheritFromActive === false &&
  Boolean(override.baseUrl?.trim()) &&
  Boolean(override.model?.trim());

// ProviderType is an open string (native catalog ids like 'minimax', 'zai', 'deepseek'),
// so matching against the 6 legacy builtin ids is not enough — resolve the route protocol
// the same way complete() does.
const isOpenAiCompatible = resolvePiRouteProtocol(provider, protocol) === 'openai';

if (!isSelfContainedOverride && !isOpenAiCompatible) {
  /* warn, return [] */
}
```

This is the 1.0.6 fix. Previously the check was a fixed list of six builtin provider ids, so
selecting any native catalog provider for **chat** silently disabled embedding. Two
consequences worth knowing:

- A `custom` embedding config with its own base URL and model works regardless of which
  chat provider is active. The old advice to "uncheck inherit and point at an
  OpenAI-compatible endpoint" is now simply what the `custom` mode is for, not a workaround.
- Judgement is by the provider's actual route protocol, not by its name.

With the default `local` provider neither condition is consulted at all.

### Default Configuration

```typescript
memoryRuntime: {
  llm: {
    inheritFromActive: true,
    provider: undefined,
    customProtocol: undefined,
    apiKey: '',
    baseUrl: '',
    model: '',            // empty → uses active model
    timeoutMs: 180000,
  },
  embedding: {
    inheritFromActive: false,
    provider: 'local',    // in-process ONNX by default
    customProtocol: undefined,
    apiKey: '',
    baseUrl: '',
    // Safe fallback for non-local providers. Ignored when provider === 'local',
    // since the model id is hardcoded in local-embedding-provider.ts.
    model: 'text-embedding-3-small',
    timeoutMs: 180000,
  },
  useEmbedding: true,     // embedding is ON by default
  // ...
}
```

Note both defaults inverted from what this document previously stated: embedding no longer
inherits the active API, and `useEmbedding` is on.

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
