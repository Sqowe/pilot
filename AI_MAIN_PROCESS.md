# Main Process Implementation Rules

Rules derived from real bugs, SDK uplifts, and architectural decisions
documented in `docs/chats/`. This file governs all code under `src/main/`.

---

## Pi SDK Integration (`@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai`)

### Version Management

- **Always version-lock `pi-ai` and `pi-coding-agent`** — they share a monorepo
  (`github.com/badlogic/pi-mono`) and must be upgraded together. A mismatch
  causes type errors and runtime failures.
- Both packages are pre-1.0 (currently 0.71.x). Breaking changes happen between
  minors. Budget time for code adaptations on every uplift.
- Known uplift history (0.60→0.71 required 5 adaptations):
  1. TypeBox migration (`@sinclair/typebox` → `typebox` 1.x)
  2. `ModelRegistry` factory change (static → instance method)
  3. `appendSystemPrompt` changed from `string` to `string[]`
  4. `tools` renamed to `customTools` in `createAgentSession`
  5. Event type renames in the subscribe callback
- After any uplift: run `npm run typecheck`, then manually test a full
  conversation with tool use, compaction trigger, and session reuse.

### Private Field Access

- **Never access underscore-prefixed SDK fields** (`_beforeToolCall`,
  `_agentEventQueue`, etc.) without documenting the risk and the exact
  version it was tested against.
- Current known reach-around: `installPermissionHook` accesses
  `(piSession as any).agent` and `(agent as any)._beforeToolCall` to chain
  the permission gate. This is fragile — any Pi minor bump may break it.
- Prefer the SDK's public extension points: `piSession.subscribe()`,
  `piSession.setModel()`, `piSession.setThinkingLevel()`, `prompt(text, options)`.

### Session Lifecycle

- One `createAgentSession()` call per chat session, cached in `this.piSessions`.
- Reused sessions hot-swap model and thinking level via public setters.
- Session cache is keyed by `sessionId` and evicted LRU when
  `MAX_CACHED_SESSIONS` is reached.
- A "runtime signature" (`buildPiSessionRuntimeSignature`) invalidates the
  cached session when cwd, model, tools, skills, or workspace-instructions
  fingerprint change. If your feature adds state that should trigger session
  recreation, add it to the signature.
- `piSession.prompt(text, options?)` is the only entry point for sending user
  messages. Pass `options.images` for multimodal input — never embed base64
  in the text string.

### Tool Wrapping Pattern

Tools are wrapped in layers before being passed to `createAgentSession`:

```
createCodingTools(cwd)          ← SDK built-in tools (read, write, edit, bash, glob, grep)
  → wrapBashToolForSudo(...)    ← intercepts sudo commands, prompts for password
  → wrapToolsForPermission(...) ← gates all tools via permission rules
  → passed as customTools[]     ← to createAgentSession
```

MCP tools follow the same wrapping chain. The wrapper signature is:

```typescript
private wrapXxx(tools: ToolDefinition[], sessionId: string, ...): ToolDefinition[]
```

Each wrapper clones the tool array, replaces `execute` with a function that
adds behaviour before/after calling `originalExecute`, and returns the new array.

**Rules for new wrappers:**

- Always call `originalExecute` on the happy path — never silently swallow.
- On deny/error, return a well-formed tool-result object (not throw) so the
  model sees a clean message and can recover.
- Wrap `requestPermission` in try/catch — fail closed (return error result),
  never fail open (execute without approval).
- Log at info level what happened: tool name, session ID, decision.

---

## IPC Patterns (`src/main/index.ts`)

### Handler Registration

- All IPC is routed through two entry points:
  - `ipcMain.on('client-event', ...)` — fire-and-forget from renderer
  - `ipcMain.handle('client-invoke', ...)` — request/response from renderer
- Plus ~40 direct `ipcMain.handle(channel, ...)` for typed operations
  (config._, mcp._, sandbox._, skills._, plugins.\*, etc.)
- Namespace new handlers with a dot-separated prefix matching the subsystem:
  `schedule.create`, `remote.getConfig`, etc.

### Event Streaming (main → renderer)

- Use `mainWindow.webContents.send('server-event', event)` via the
  `sendToRenderer` helper.
- `ServerEvent` is a discriminated union on `type`. Add new event types to
  `src/renderer/types/index.ts`.
- Events are NOT buffered or replayed. If the renderer window isn't ready,
  events are lost. Design for this — the renderer should hydrate from
  persistent state (DB/config) on mount, not rely on catching every event.

### Event Streaming (renderer → main)

- `ClientEvent` is a discriminated union on `type`. The preload allowlists
  valid types in `ALLOWED_CLIENT_EVENTS` — add new types there or they'll
  be silently dropped.
- The `handleClientEvent` switch dispatches by `event.type`. Add new cases
  to this switch.

### Error Handling in IPC Handlers

- Wrap every handler body in try/catch.
- Return structured error objects, never throw across the IPC boundary.
- Log errors with `logError(message, error)` — includes stack trace.
- For `ipcMain.handle` channels, return `{ error: string }` on failure.

---

## MCP Tool Bridging (`src/main/mcp/`)

- `MCPManager` owns all MCP server connections (stdio / SSE / Streamable HTTP).
- MCP tools are bridged into Pi's `ToolDefinition` format via
  `buildMcpCustomTools(mcpManager)` in agent-runner.
- JSON Schema from MCP tools is wrapped as TypeBox `TSchema` using the
  `typebox` package (added during 0.60→0.71 uplift). Do not use
  `@sinclair/typebox` — it's the old package name.
- **MCP servers always run on the host** — never route spawns through
  sandbox bridges (WSL/Lima). The sandbox is for user-workspace commands only.
- MCP tool definitions contribute to the token budget. The compaction system
  accounts for them via `selectCompactionSettings({ customTools })`. Adding
  many MCP servers can make the context budget unworkable — log warnings.
- Tool schema tokens are estimated at `JSON.stringify(schema).length / 4`.

---

## SQLite Persistence (`src/main/db/`)

- Single `better-sqlite3` database, initialized in `initDatabase()`.
- **Native module** — must be rebuilt against Electron's ABI on every
  Electron version bump: `npm run rebuild`.
- All queries are synchronous (better-sqlite3 design). Do not wrap in
  `async` unless combining with other async operations.
- Schema migrations: add new tables/columns in `initDatabase()` using
  `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` with
  try/catch for "duplicate column" errors. No formal migration framework.
- Transactions: use `db.transaction(...)()` for multi-statement writes.
- Close the database in the `before-quit` handler via `closeDatabase()`.

---

## Config Store (`src/main/config/config-store.ts`)

- Uses `electron-store` (encrypted JSON on disk).
- `configStore.get(key)` / `configStore.getAll()` / `configStore.update(partial)`.
- New config fields require:
  1. Add to `AppConfig` type
  2. Add to `defaultConfig` with a safe default
  3. Add to `normalizeConfig` with validation/coercion
  4. Add to `DIRECT_READ_KEYS` if it should be readable without getAll()
  5. Add to the `update()` method's persistence block
  6. Mirror in `src/renderer/types/index.ts` AppConfig
- Config changes that affect the agent session should be reflected in the
  runtime signature so the cached pi session is invalidated.
- The renderer is the source of truth for settings UI state. Main-process
  caches (like `permission-rules-store.ts`) are hydrated from renderer via
  `settings.update` IPC on app bootstrap. Between launch and first hydration,
  defaults apply.

---

## Permission System (`src/main/config/permission-rules-store.ts`)

- Main-process cache of `PermissionRule[]` from the renderer.
- `decidePermission(sessionId, toolName, input)` → `'allow' | 'deny' | 'ask'`
- Matching order: bash lists (authoritative if non-empty) → session-scoped
  "always allow" memory → first matching rule → default `'ask'`.
- Bash trust/denylist is a separate layer on top (see `BASH_COMMAND_RESTRICTIONS.md`).
- `sanitizeRules()` validates all IPC input — unknown actions coerce to `'ask'`
  (fail-closed, never fail-open).
- Session-scoped "always allow" is cleared on session delete via
  `forgetSessionPermissions(sessionId)`.

---

## Security Boundaries

### Path Containment

- `isPathWithinRoot(filePath, root)` — rejects `..` traversal, symlink escape,
  and absolute paths outside the workspace.
- Used by `NativeExecutor`, `PathGuard`, and workspace-system-prompt loader.
- Always resolve with `fs.realpathSync` before comparison to catch symlinks.

### Sandbox Adapter

- `SandboxAdapter` routes execution to WSL2 / Lima / Native based on platform
  and `sandboxEnabled` config.
- Currently `sandboxEnabled: false` by default — all execution is native.
- `PathGuard` blocks escape from the session sandbox directory inside VMs.
- Never route MCP server spawns through the sandbox — they run on host.

### Workspace Path Constraints

- `getUnsupportedWorkspacePathReason()` rejects UNC paths on Windows when
  sandbox is enabled (WSL cannot map UNC).
- Validate workspace paths before accepting them as `effectiveCwd`.

---

## Event Subscribe Pattern (agent-runner.ts)

The `piSession.subscribe(callback)` handler is the central event router:

```typescript
const unsubscribe = piSession.subscribe((event) => {
  switch (event.type) {
    case 'message_update': // streaming deltas → renderer
    case 'tool_execution_start': // tool trace → renderer
    case 'tool_execution_end': // tool result → renderer + DB
    case 'turn_end': // turn boundary
    case 'agent_end': // session complete → cleanup
    case 'auto_compaction_start': // context compaction
    case 'auto_compaction_end':
    // ... etc
  }
});
```

**Rules:**

- Never block inside the subscribe callback — it runs synchronously in the
  SDK's event queue. Blocking here (e.g., awaiting a dialog) disrupts event
  ordering and causes renderer state desync.
- If you need async user interaction (permission dialogs, confirmations),
  do it in the tool's `execute` wrapper, NOT in the subscribe handler.
- The subscribe handler calls `sendMessage()` which both persists to DB and
  forwards to renderer. DB write succeeding does NOT guarantee the renderer
  received the event (IPC is fire-and-forget).

---

## Cold-Start History Rebuild

When a session is reopened and the SDK doesn't have history, the agent-runner
rebuilds a `<conversation_history>` preamble from DB messages:

- Budget: `0.3 × contextWindow` (or 0.15 for small Ollama models).
- Token estimation: `text.length / 4` (systematically underestimates CJK and
  dense JSON — known limitation).
- Content blocks: serialize `text`, `thinking` (as `<thinking>` tags),
  `tool_use`, `tool_result`. Do NOT drop non-text blocks — DeepSeek and other
  thinking models require `reasoning_content` on every assistant message.
- Images are excluded from history rebuild (too large for preamble budget).

---

## Dependency Upgrade Checklist

Before upgrading any Tier 1 dependency (see `docs/dependency-tiers.md`):

1. Read the changelog/release notes for breaking changes
2. Check if `pi-ai` and `pi-coding-agent` need coordinated uplift
3. Run `npm run typecheck` — catch type-level breaks
4. Run `npm test` — catch behavioral breaks
5. Manually test: new session, tool use, session reuse, compaction trigger
6. For `better-sqlite3`: run `npm run rebuild` after any Electron bump
7. Update `docs/dependency-tiers.json` with new installed version
8. Document adaptations needed in the commit message body

---

## Common Pitfalls (from real bugs)

| Bug                                        | Root cause                                                                        | Rule                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Images not visible to LLM                  | `piSession.prompt(text)` only — images not passed via `options.images`            | Always check if user message has image blocks and pass them         |
| DeepSeek 400 error on cold start           | History rebuild dropped `thinking` blocks via `.filter(c => c.type === 'text')`   | Preserve all content block types in history serialization           |
| Permission dialog breaks renderer state    | `setBeforeToolCall` hook blocked the SDK's internal event queue during async wait | Never do async user interaction in SDK hooks — use execute wrappers |
| Context overflow 400                       | Compaction threshold didn't account for tool schema tokens (31K+)                 | Use `selectCompactionSettings` which includes tool token budget     |
| Session uses stale system prompt           | Cached pi session kept old `appendSystemPrompt` after config change               | Add state to runtime signature so cache invalidates on change       |
| `better-sqlite3` crash after Electron bump | Native module compiled against wrong ABI                                          | Always `npm run rebuild` after Electron version change              |
| MCP tools fail in sandbox                  | MCP spawn routed through Lima/WSL bridge                                          | MCP servers must run on host, never in sandbox                      |
