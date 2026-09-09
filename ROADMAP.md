# 🗺️ Sqowe Pilot Roadmap

> Development direction for Sqowe Pilot, a fork of Open Cowork. This roadmap is
> derived from [TECHNICAL_DEBTS.md](./TECHNICAL_DEBTS.md) and the design docs in
> [docs/design/](./docs/design/). For discussion and feature requests, see
> [GitHub Issues](https://github.com/sqowe/pilot/issues).

---

## ✅ Completed

**Core & Platform**

- Stable Windows & macOS installers with build verification
- **Rebrand to Sqowe Pilot (v1.0.0)** — packaging identity, `appId`, on-disk data
  migration from legacy `open-cowork` directory, attribution to upstream
- Full filesystem sandboxing + path-traversal / zip-slip hardening
- WSL2 (Windows) and Lima (macOS) VM-level sandbox isolation (experimental)
- English / Chinese / Russian / Hungarian localization
- CI/CD: automated builds, smoke tests, PR review bot

**Models & Providers**

- Multi-model: Claude, GPT, Gemini, DeepSeek, Qwen, GLM, Kimi, Grok, MiniMax, Ollama
- Up-to-date model catalogs + corporate-CLI provider support (kiro gateway)

**Agent Engine & Tools**

- Pi SDK 0.80.2 engine (`@earendil-works/pi-coding-agent`)
- MCP connectors: custom servers (stdio / SSE / Streamable HTTP), enable/disable,
  "Save to Workspace" profiles, per-server tool permission policies, LLM-generated
  server descriptions, orphan detection & cleanup
- Rich input: file upload + image input in chat
- Bash command restrictions (trusted/denylist, complex pipes) — both in-app and as
  a standalone `pi` extension (`pi-extensions/bash-restrictions`)

**Memory System**

- Two-layer memory (core profile + workspace-scoped experience), cross-session
  retrieval, active retrieval via tools, embedding-based scoring, Settings UI +
  Memory Lens panel
- Aggressive core-memory updates + configurable recency/supersession scoring (6.1, 6.3)
- Workspace-aware core-memory filtering (prevents cross-project contamination)

**Skills & Plugins**

- PPTX / DOCX / PDF / XLSX skills + custom skill management + hot-reload
- Skill pinning (per-session directives)
- **Skill conflict resolution** — policy engine (custom-wins/builtin-wins/ask),
  per-skill source overrides, disable capability, toast notifications, Settings UI
- **Skill workspace profiles** — per-session disable/restore, `.cowork/skills-profile.json`,
  Welcome page + Context Panel integration
- **Plugin system** — archive (`.plugin`) install, plugin-level pinning,
  orchestrator-skill auto-detection, version-stamped auto-update
- Stale workspace-config cleanup (orphan detection + one-click remediation)

**UX**

- Chat timestamps + date separators (with sticky separator)
- Markdown chat export (full + selective message export)
- Context usage bar, prompt-cache/source badges

**Scheduling**

- Scheduler v2 — anacron-style fuzzy time windows, explicit config-set binding,
  autonomous execution mode, budget controls, catch-up panel, run history

**Remote Control**

- Feishu (Lark) bot integration with pairing mode + approval panel

---

## 🚧 In Progress

- **Chat Export — Multi-format (DOCX + PDF)** — [`docs/design/chat-export-multiformat.md`](docs/design/chat-export-multiformat.md).
  One shared HTML serializer feeding DOCX (`@turbodocx/html-to-docx`) and PDF
  (`webContents.printToPDF`); format chosen via native save-dialog filter. Design
  complete; implementation pending.
- **Memory: Contradiction Annotation at Retrieval** — [`docs/design/memory-fact-staleness-problem.md`](docs/design/memory-fact-staleness-problem.md) §6.2
  (= TECHNICAL_DEBTS #19). Cross-reference retrieved chunks against core memory and
  annotate stale values with warnings.

---

## 📋 Planned

### Near-term — security, correctness & quick wins

**Security & correctness (TECHNICAL_DEBTS P1)**

- **Credential delivery via secure channel** (#3) — replace prompt injection with a
  secure MCP tool / IPC channel for secrets the agent needs.
- **Simplify `beforeToolCall` hook** (#13) — drop the legacy `setBeforeToolCall` path
  once `pi-coding-agent ≥ 0.74` is the floor; eliminate the silent permission-bypass risk.

**Pi SDK 0.83–0.85 feature adoption** — [`docs/design/pi-sdk-085-feature-adoption-plan.md`](docs/design/pi-sdk-085-feature-adoption-plan.md)

The 0.85.1 uplift landed on 2026-09-08 (typecheck clean, 3141 tests green). The adoption
backlog from the 0.80 and 0.82 plans is consolidated there; both predecessors are archived.

- **Items A & B:** session usage totals via `getSessionStats()` (now a read, not an
  accumulator) and compaction failure/retry narration in the trace.
- **Item E:** verify path containment against 0.85.0's `ctx.cwd` fix in the built-in tools.
- **Item S:** settle the bash session-variable exposure policy. Four `PI_*` variables reach
  agent bash commands; `PI_SESSION_FILE` is not among them, because the app's pi session is
  in-memory. Worth a regression test pinning that, since the safety depends on it.
- **Item F:** edit-diff rendering — the transcript still shows raw JSON for `edit` calls.
- **Item G:** reproduce the stuck loading indicator during a permission wait before
  deciding how to fix it; the wait itself is already tracked in the main process.
- **Opportunistic:** RPC extension-UI types, provider-scoped `env` overrides.

**Tool completeness (API-key users)**

- Native `TodoWrite`, `AskUserQuestion`, `Glob`, `Grep`, `WebFetch`, `WebSearch` tool
  schemas + handlers for users without a bundled skill set.

**Chat Export — Phase 3** — [`docs/design/chat-export-markdown.md`](docs/design/chat-export-markdown.md)

- Folder export with extracted images, persist last-used options, batch sidebar export,
  `Cmd+Shift+E` shortcut.

---

### Mid-term — memory, permissions & code health

**Memory hardening**

- **Tool-result scoping** — [`docs/design/memory-tool-result-scoping.md`](docs/design/memory-tool-result-scoping.md)
  (staleness §6.7). Exclude operational MCP/bash tool results from the profiler
  transcript; workspace-pin CoWork-memory-derived entries. Prevents cross-workspace
  contamination.
- **Fact layer with contradiction tracking** (staleness §6.4, high effort) — structured
  facts that get superseded only on explicit contradiction, weighted by mention count.

**Permissions**

- **File-tool path permissions (workspace zone)** — [`docs/design/file-tool-path-permissions.md`](docs/design/file-tool-path-permissions.md).
  Auto-allow inside-workspace + temp-dir file operations; ask outside. Shared engine
  for both the app and the `pi` extension; universal tool-agnostic dialog.

**Functional gaps (TECHNICAL_DEBTS P2)**

- **Skills MCP server lifecycle** (#4) — actually spawn + gracefully shut down
  skill-bundled MCP servers (currently silently no-op).
- **Feishu webhook encryption** (#7) — AES-256-CBC decryption for enterprise
  deployments.
- **Plugin skills through conflict-resolution pipeline** (#24) — inject
  `PluginRuntimeService` into `SkillsManager` so plugin skills pass through conflict
  detection/resolution like builtin/user skills.
- **Shared types dedup** (#2) — move main↔renderer message/content types to `src/shared/`.

**Code health & performance**

- **App slimming** — reduce installer (~156 MB → ~80 MB): on-demand Python/Node download,
  lazy-load Feishu SDK, strip unused files.
- **Code cleanup** — split god files (`index.ts`, `gui-operate-server.ts`), lazy imports,
  remove dead `ToolExecutor`/`SandboxToolExecutor` (#1) and deprecated sandbox methods (#15).

**UX**

- **Code Assistant tab** — [`docs/design/code-assistant-tab.md`](docs/design/code-assistant-tab.md).
  A project-directory-centric coding-agent view that reuses the existing engine, tools,
  MCP, skills, and permission system. Mostly renderer/UX work.
- **Chat smart scrolling** — [`docs/design/chat-smart-scrolling.md`](docs/design/chat-smart-scrolling.md).
  Click-to-jump day separators and a jump-to-date picker for very long conversations.

---

### Long-term & exploratory

- **Native project-trust alignment** — [`docs/design/native-project-trust-alignment.md`](docs/design/native-project-trust-alignment.md).
  Consolidate Open Cowork's parallel trust/permission surfaces around pi's native
  `project_trust` event / `ctx.isProjectTrusted()`. Security-sensitive, investigation-first.
- **Plugin-as-Agent** — [`docs/design/plugin-as-agent-future.md`](docs/design/plugin-as-agent-future.md).
  Activate a plugin's orchestrator skill as a scoped subagent (depends on Pi SDK
  subagent/delegation support stabilizing).
- **Sandbox stabilization + scheduler wiring** — harden WSL2/Lima reliability and
  startup performance; wire the existing `sandboxMode` field into Scheduler v2
  execution (TECHNICAL_DEBTS #22).
- **Linux support** — first-class Linux builds (currently build-from-source only).
- **Computer Use (CUA)** — GUI automation via screen capture + mouse/keyboard control.
- **Multi-Agent orchestration** — coordinate multiple agents for complex workflows.
- **Mobile companion** — lightweight app for monitoring and quick interactions.

---

## 🧹 Backlog — deferred technical debts

Low-risk / demand-driven items from [TECHNICAL_DEBTS.md](./TECHNICAL_DEBTS.md),
addressed opportunistically: workspace trust system (#5), remote channels beyond
Feishu/Slack (#6), Windows tray icon (#10), permission persistence (#11), legacy
encryption-key rotation (#12), legacy Ollama config (#14), scheduler bounded replay
(#8), permission UI desync (#9), memory Lens polish (#20), memory architectural
limits (#23).

---

_Last updated: 2026-06-27_
_Want to contribute? Check the [Contributing Guide](CONTRIBUTING.md) and issues
labeled `good first issue`._
