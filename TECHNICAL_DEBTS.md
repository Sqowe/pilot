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

## 16. Chat Export: Phase 3 (Rich Export) Not Implemented

**Design doc:** `docs/design/chat-export-markdown.md`

**Status:** Phases 1 (Full Export) and 2 (Selective Export) are ✅ Done. Phase 3 is unimplemented.

**Remaining work:**

- Folder export mode (directory picker + image extraction as separate files)
- Persist user's last-used export options in electron-store
- Batch export from sidebar (select multiple sessions → export all)
- Keyboard shortcut (`Cmd+Shift+E` for export)

**Risk:** Low — quality-of-life feature, no functional regression.

---

## 17. Chat Smart Scrolling: Entirely Unimplemented

**Design doc:** `docs/design/chat-smart-scrolling.md`

**Status:** Concept only. No implementation started.

**Designed features (none done):**

- Sticky day separator that pins to viewport top while scrolling (IntersectionObserver + fixed overlay)
- Click day separator to jump — date list popover for quick navigation
- Jump-to-date picker for very long conversations (calendar icon)

**Dependencies:** Requires existing day separators from `chat-timestamps.md` Phase 1 (✅ done).

**Risk:** Low — UX enhancement for long conversations only.

---

## ~~18. MCP Server Descriptions~~ ✅ DONE

**Design doc:** `docs/design/mcp-server-descriptions.md`

**Status:** Fully implemented. All 6 phases complete:

- Data model (`description`, `descriptionToolsHash`, `descriptionSource` on MCPServerConfig)
- Generator module (`mcp-description-generator.ts`) with LLM one-shot + heuristic fallback
- MCPManager integration (auto-generate on first connect, change detection via hash)
- System prompt injection (`buildMcpServerDirectory()` in agent-runner with `<mcp_server_directory>` XML block)
- IPC endpoints (`mcp.regenerateDescription`, manual edit saves with `descriptionSource: 'manual'`)
- UI (description display, ✨/✍️ source badge, Regenerate button, manual edit in server config dialog)

---

## 19. Memory: Contradiction Annotation at Retrieval Time

**Design doc:** `docs/design/memory-fact-staleness-problem.md`

**Status:** Recommendations 6.1 (aggressive core memory updates) and 6.3 (stronger recency + supersession) are ✅ Done. Recommendation 6.2 is next in priority but unimplemented.

**Remaining work (6.2):**

- When `search_workspace_chats` returns results, cross-reference against current core memory
- If a chunk contains a value contradicting a core memory entry, annotate it with a warning
- Model sees explicit "⚠️ This chunk may contain outdated info" annotations

**Higher-effort remaining items (6.4, 6.5):**

- Fact layer with structured fact extraction and contradiction tracking (High effort)
- Write-time contradiction detection for experience memory (High effort)

**Risk:** Medium — without annotation, models still sometimes act on stale experience memory.

---

## 20. Memory Lens Panel: Phase 3/4 Incomplete Items

**Design doc:** `docs/design/memory-lens-panel.md`

**Status:** Phases 1, 2 mostly done. Phase 3 partially done. Phase 4 partially done.

**Remaining work:**

- "Full Memory View" modal with search/filter (deferred — only "View all →" link exists)
- Animations (pulse on update, smooth expand/collapse)
- Historical retrieval log (last 5 turns, not just the latest)

**Risk:** Low — cosmetic polish items.

---

## ~~21. Skill Pinning UX~~ ✅ DONE

**Design doc:** `docs/design/skill-pinning-ux.md`

**Status:** Fully implemented with comprehensive test coverage (`tests/skill-pinning.test.ts`):

- Welcome screen skill pinning picker (star/unstar with limit enforcement)
- ContextPanel section with pin/unpin toggle per skill
- `buildPinnedSkillsDirective()` in agent-runner injects `<pinned_skills>` block into system prompt
- `SessionManager.toggleSessionPinnedSkill()` with validation and per-session storage
- IPC endpoints (`skills.toggleSessionPin`, `skills.getSessionPinnedSkills`)
- Preload bridge exposure
- Shared constants (`SAFE_SKILL_ID_REGEX`, `MAX_PINNED_SKILLS_PER_SESSION`, `isValidSkillId`)
- Defense-in-depth: sanitization of skill IDs before prompt injection
- `initialPinnedSkills` passed on session creation from WelcomeView
- Cleanup on session delete

---

## 22. Scheduler v2: Sandbox Integration Not Wired

**Design doc:** `docs/design/scheduler-v2.md`

**Status:** All 5 implementation phases (Data Model, Engine, IPC, UI, Testing) are ✅ Done. The `sandboxMode` field exists in the schema but is **not functionally wired**.

**Remaining work:**

- When `sandboxEnabled` is un-gated in Settings UI, wire `sandboxMode` into `ScheduledTaskManager.handleTrigger()`
- Implement `'require'` mode (refuse execution without sandbox)
- Implement `'skip'` mode (always run native even when sandbox is global)

**Risk:** Low — schema is future-proofed. Implementation deferred until sandbox feature ships.

---

## 23. Memory: Known Architectural Limitations

**Design doc:** `docs/design/memory-system-architecture.md` (Section 9)

**Documented limitations without planned fixes:**

- No temporal versioning (facts don't carry valid_from/valid_until)
- Experience memory is append-only (old chunks never updated/invalidated)
- No confidence/strength scoring (all entries equally weighted regardless of confirmation count)
- No fact extraction from experience (stores narrative chunks, not structured facts)
- Core memory update is per-session (profiler can't assess cross-session frequency)

**Risk:** These are known architectural constraints. The staleness problem doc proposes solutions, but most require High/Very High effort.

---
