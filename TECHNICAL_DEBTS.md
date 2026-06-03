# Technical Debts

Tracked cleanup tasks, deferred work, and refactoring opportunities found in the codebase.

---

## 1. Dead Code: ToolExecutor & SandboxToolExecutor

**Files:**

- `src/main/tools/tool-executor.ts`
- `src/main/tools/sandbox-tool-executor.ts`

**Issue:** These classes implement `glob()`, `grep()`, `webFetch()`, `webSearch()`, `readFile()`, `writeFile()`, `editFile()`, `executeCommand()` etc. but are **never imported in production code**. The actual tool execution goes through the Pi SDK's `createCodingTools(cwd)` in `agent-runner.ts`. These files are only referenced in test files (`tests/tool-executor-sandbox.test.ts`, `tests/tool-executor-unc-paths.test.ts`) and README directory listings.

**Action:** Remove both executor classes and their associated tests, or repurpose them if there's a planned sandbox execution mode that would use them.

**Risk:** Low — no production imports exist.

---

## 2. Shared Types Duplication (Main ↔ Renderer)

**File:** `src/main/chat/export-markdown.ts`

**Issue:** `TODO: Move shared message/content types to src/shared/ for single-source-of-truth.` Types are duplicated between main and renderer processes to avoid cross-process import issues. If renderer types change, the export-markdown types must be manually updated.

**Action:** Extract shared message/content types into `src/shared/` and import from both processes.

**Risk:** Medium — type drift can cause silent bugs in markdown export.

---

## 3. Credential Delivery via System Prompt

**File:** `src/main/claude/agent-runner.ts` (line ~705)

**Issue:** `TODO: Credentials should be served via a secure MCP tool or IPC channel, not injected as plaintext into the system prompt.` The `getCredentialsPrompt()` method was removed, but the architectural problem remains — credentials that the agent needs should flow through a secure tool, not prompt injection.

**Action:** Implement a secure credential-serving MCP tool or IPC channel.

**Risk:** High (security) — if credential injection is re-added naively, credentials leak into conversation history/logs.

---

## 4. Skills Manager: MCP Server Lifecycle Not Implemented

**File:** `src/main/skills/skills-manager.ts` (lines ~696, ~718)

**Issue:** Two TODO markers:

- `TODO: Implement actual MCP server startup` — skill MCP servers are never actually spawned
- `TODO: Implement graceful shutdown` — no cleanup on skill MCP server stop

**Action:** Implement process spawning and lifecycle management for skill-bundled MCP servers.

**Risk:** Medium — skills with MCP server configs silently do nothing.

---

## 5. Permission Rules: Workspace Trust System Missing

**File:** `src/main/config/permission-rules-store.ts` (line ~520)

**Issue:** `TODO: integrate with workspace trust system when available.` Workspace MCP permission policies are permanently untrusted (`workspaceTrusted = false`). They can restrict but never grant access, even for projects the user has explicitly trusted.

**Action:** Implement a workspace trust system (similar to VS Code's workspace trust) and integrate with MCP permission policy evaluation.

**Risk:** Low — fails safe (deny), but limits useful workspace-level policy configuration.

---

## 6. Remote Gateway: Incomplete Channel Support

**Files:** `src/main/remote/remote-manager.ts`, `src/main/remote/gateway.ts`, `src/main/remote/message-router.ts`

**Issues:**

- `TODO: Register other channels (WeChat, Telegram, DingTalk)` — only Feishu/Slack implemented
- `TODO: Add tunnel support` — publicUrl always undefined
- `TODO: Check channel-specific group settings` — groups always require mention
- `TODO: Download image and convert to base64` — image messages not processed
- `TODO: Transcribe voice message` — voice messages get placeholder text

**Action:** Implement missing channel types and media handling as needed.

**Risk:** Low — features clearly marked as unimplemented, no silent failures.

---

## 7. Feishu Channel: Encrypted Webhooks Unsupported

**File:** `src/main/remote/channels/feishu/feishu-channel.ts` (line ~230)

**Issue:** `TODO: Implement message decryption` — returns HTTP 501 when Feishu sends encrypted webhooks. Users must disable encryption in Feishu app settings to work around this.

**Action:** Implement AES-256-CBC decryption using the configured `encryptKey`.

**Risk:** Medium — blocks enterprise deployments where encryption is mandatory.

---

## 8. Scheduled Tasks: Bounded Occurrence Replay Missing

**File:** `src/main/schedule/scheduled-task-manager.ts` (line ~824)

**Issue:** `TODO: Implement bounded occurrence replay in a future iteration.` When the app restarts after being offline, missed recurring tasks are detected but the replay logic lacks bounds (safety cap for how many missed occurrences to execute).

**Action:** Add a bounded replay mechanism (e.g., max 5 missed runs) with user notification for large gaps.

**Risk:** Low currently — but unbounded replay could cause issues if implemented naively later.

---

## 9. Permission Hook: Renderer UI Desync on Async Permission Dialogs

**File:** `src/main/claude/agent-runner.ts` (line ~1036)

**Issue:** `Known limitation: the async requestPermission wait (user dialog) causes the renderer to miss UI update events. The tool executes correctly on the backend, but the renderer's loading spinner may not clear. This is a renderer-side issue tracked as a follow-up.`

**Action:** Fix the renderer event subscription to handle async permission waits without missing state updates.

**Risk:** Low — cosmetic issue, tool execution still works correctly.

---

## 10. Windows Tray Icon Missing

**File:** `src/main/index.ts` (line ~380)

**Issue:** `TODO: create resources/tray-icon.ico from tray-icon.png for full Windows tray fidelity` — Windows uses a PNG instead of a native ICO file for the system tray.

**Action:** Generate a proper `.ico` file and include in resources.

**Risk:** Negligible — cosmetic only.

---

## 11. Permission Rules: No Main-Process Persistence

**File:** `src/main/config/permission-rules-store.ts` (line ~152)

**Issue:** Session-scoped "always allow" memories and bash trust/deny lists live in-memory on the main process and are hydrated from the renderer on each bootstrap. A `follow-up could migrate both to main-process persistence.`

**Action:** Persist session permission memories to SQLite or config store so they survive renderer restarts without re-hydration from frontend.

**Risk:** Low — current approach works but adds a bootstrap dependency on renderer timing.

---

## 12. Legacy Encryption Key Rotation Overhead

**Files:** `src/main/utils/store-encryption.ts`, `src/main/config/config-store.ts`, `src/main/remote/remote-config-store.ts`

**Issue:** Multiple legacy encryption key derivation strategies (`getLegacyDerivedKeyHexes`, `getLegacyDerivedKeyBuffers`, `LEGACY_SCRYPT_OPTIONS`) are maintained for backward compatibility. Every config store initialization tries multiple legacy keys before settling on the stable key.

**Action:** After sufficient user migration time, remove legacy key candidates and simplify store initialization. Consider a one-time migration prompt.

**Risk:** Low — removing too early breaks config for users who haven't opened the app since the key rotation.

---

## 13. Before-Tool-Call Hook: Fragile SDK Shape Detection

**File:** `src/main/claude/before-tool-call-hook.ts`

**Issue:** Supports two SDK shapes (modern `beforeToolCall` property + legacy `setBeforeToolCall` setter). The `_beforeToolCall` private field is also accessed. Each Pi SDK bump risks breaking the detection — documented as "fragile" in `AI_MAIN_PROCESS.md`.

**Action:** After dropping support for pi-coding-agent < 0.74, remove the legacy `setBeforeToolCall` path and simplify to property-only.

**Risk:** Medium — a silent failure here disables ALL permission checks.

---

## 14. Legacy Ollama Config Detection

**File:** `src/main/config/auth-utils.ts`

**Issue:** `isOllamaLegacyCustomOpenAIConfig()` exists to handle old-style Ollama configurations from before Ollama had a first-class provider entry.

**Action:** Remove after migration period when no users have the legacy config shape.

**Risk:** Low — helper is isolated and tested.

---

## 15. Deprecated Sandbox Sync Methods

**Files:**

- `src/main/sandbox/sandbox-sync.ts` — `@deprecated Use syncToWindows instead`
- `src/main/sandbox/lima-sync.ts` — deprecated `copyFileToSandbox`

**Issue:** Deprecated methods with `@deprecated` tags that haven't been removed yet.

**Action:** Remove deprecated aliases and update any remaining callers to use the new methods.

**Risk:** Low — find callers via grep, replace, delete.

---
