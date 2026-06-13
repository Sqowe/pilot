# Architecture Overview — Open Cowork

## 1. Purpose of This Document

This is the architectural source of truth for Open Cowork, an Electron desktop AI agent
application. It describes the system as it exists today (v3.3.0-sqowe.8), not as imagined.

Any AI coder working on this repository MUST read this document first to understand
structure, boundaries, and where to find authoritative coding rules. This document
does NOT define coding rules — it points to them (see Section 8).

Target audience: AI coding assistants and new human contributors.
Last updated: 2026-05-27.

---

## 2. High-Level System Overview

Open Cowork is a desktop app that wraps the `@earendil-works/pi-coding-agent` SDK
(the "Pi" engine) inside an Electron shell, adding GUI, MCP tool bridging, sandbox
isolation, skills, permission gating, and remote-channel integrations.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Electron App                                 │
│                                                                     │
│  ┌─────────────┐    IPC bridge     ┌────────────────────────────┐  │
│  │  Renderer   │◄════════════════►│       Main Process          │  │
│  │  (React +   │  (preload shim)   │                            │  │
│  │   Zustand + │                   │  ┌──────────────────────┐  │  │
│  │   Tailwind) │                   │  │  ClaudeAgentRunner   │  │  │
│  └─────────────┘                   │  │  (pi-coding-agent)   │  │  │
│                                    │  └──────────┬───────────┘  │  │
│                                    │             │               │  │
│                                    │  ┌──────────▼───────────┐  │  │
│                                    │  │  Tool Dispatch Layer  │  │  │
│                                    │  │  • Built-in tools     │  │  │
│                                    │  │  • MCP bridge         │  │  │
│                                    │  │  • Permission gate    │  │  │
│                                    │  └──────────┬───────────┘  │  │
│                                    │             │               │  │
│                                    │  ┌──────────▼───────────┐  │  │
│                                    │  │  Sandbox Adapter      │  │  │
│                                    │  │  (Native/WSL/Lima)    │  │  │
│                                    │  └──────────────────────┘  │  │
│                                    └────────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐    │
│  │ Config Store │  │  SQLite DB   │  │ Remote Channels       │    │
│  │ (electron-   │  │ (sessions,   │  │ (Feishu/Slack/ngrok)  │    │
│  │  store)      │  │  memory)     │  │                       │    │
│  └──────────────┘  └──────────────┘  └───────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
         │                                        │
         ▼                                        ▼
   LLM Providers                           External MCP Servers
   (Anthropic, OpenAI,                     (stdio / SSE /
    Gemini, DeepSeek,                       Streamable HTTP)
    Ollama, etc.)
```

---

## 3. Repository Structure

```
open-cowork/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── claude/              # Agent runner, SDK integration, hooks
│   │   ├── config/             # Config store, permission rules
│   │   ├── db/                 # SQLite persistence (better-sqlite3)
│   │   ├── mcp/               # MCP manager + GUI-operate server
│   │   ├── memory/            # Memory system (experimental)
│   │   ├── prompts/           # System prompt loader (editable sections)
│   │   ├── remote/            # Feishu/Slack remote channels
│   │   ├── sandbox/           # WSL2/Lima/Native execution adapters
│   │   ├── schedule/          # Anacron-style task scheduling (v2)
│   │   ├── session/           # Session lifecycle management
│   │   ├── skills/            # Skill loader + hot-reload
│   │   ├── tools/             # Tool executor, path containment
│   │   └── utils/             # Shared main-process utilities
│   ├── preload/                # IPC bridge (contextBridge)
│   ├── renderer/               # React UI
│   │   ├── components/        # UI components (settings, chat, etc.)
│   │   ├── hooks/             # React hooks
│   │   ├── i18n/              # en.json / zh.json localization
│   │   ├── store/             # Zustand state stores
│   │   └── styles/            # Tailwind + custom CSS
│   ├── shared/                 # Types/utils shared across processes
│   └── tests/                  # Vitest unit tests
├── scripts/                    # Build, download, deploy scripts
├── resources/                  # Bundled runtimes (Node, Python, skills)
├── docs/                       # Documentation + chat history
│   └── chats/                 # Exported conversation logs (context)
├── .claude/skills/             # Dev-time skills (docx, pdf, pptx, etc.)
├── adaptations/                # Issue tracking + patch notes
├── website/                    # Landing page source
├── dist-electron/              # Compiled main process output
├── dist-mcp/                   # Bundled MCP servers
├── dist-wsl-agent/             # Compiled WSL agent
├── dist-lima-agent/            # Compiled Lima agent
├── AI_ELECTRON.md              # ⚡ AI rules: Electron/packaging
├── BASH_COMMAND_RESTRICTIONS.md # ⚡ AI rules: bash permission engine
├── ARCHITECTURE.md             # ← this file
├── ROADMAP.md                  # Feature roadmap
└── package.json                # Node 22+, Electron 41, Vite 7
```

---

## 4. Core Components

### 4.1 Agent Engine (`src/main/claude/`)

The heart of the app. `ClaudeAgentRunner` (~2600 lines) wraps `@earendil-works/pi-coding-agent`
SDK via `createAgentSession()`. One session per chat — full conversation context sent on
each reasoning step (ReAct loop). Context compaction is SDK-driven when usage exceeds
`contextWindow − reserveTokens`.

Key files: `agent-runner.ts`, `pi-model-resolution.ts`, `before-tool-call-hook.ts`,
`claude-sdk-one-shot.ts` (title generation).

Critical constraint: `pi-ai` and `pi-coding-agent` MUST be version-locked together
(same monorepo, pre-1.0, frequent breaking changes).

### 4.2 Renderer (`src/renderer/`)

React 18 + Zustand + Tailwind CSS. Zero direct Node/Electron imports — all main-process
communication goes through `window.electronAPI` (defined in `src/preload/index.ts`).
Supports English and Chinese (i18next). Markdown rendering via `react-markdown` + remark/rehype.

### 4.3 MCP & Tools (`src/main/mcp/`, `src/main/tools/`)

`MCP Manager` connects to external MCP servers (stdio/SSE/Streamable HTTP) and bridges
their tools into the Pi agent as `customTools`. `gui-operate-server.ts` (~6800 lines)
is a built-in MCP server providing GUI automation via vision models.

MCP servers run on the HOST, never inside the sandbox VM.

**Per-server tool permission policies:**

Each MCP server can have a default tool permission policy that controls whether its
tools are auto-approved, require prompting, or are blocked. This eliminates "permission
fatigue" for trusted read-only servers while maintaining security for write-capable ones.

Policy levels (first match wins):

1. **Workspace override** — `.cowork/mcp-permissions.json` (committable to git, team-shared)
2. **Per-tool override** — `MCPServerConfig.toolPermissions` (sparse, exception-based)
3. **Server default policy** — `MCPServerConfig.defaultToolPolicy`:
   - `allow-all`: auto-approve every tool without prompting
   - `allow-reads`: auto-approve tools classified as read-only (uses MCP `annotations.readOnlyHint` if available, falls back to name-based heuristic detecting action verbs as prefix or infix)
   - `ask-all`: always prompt (default, backward-compatible)
   - `deny-all`: block all tools from this server
4. **Generic permission rules** — existing `PermissionRule[]` engine (fallback)

**Progressive trust:** The system tracks how many times each MCP tool is manually
approved across sessions. After 5 approvals, it can suggest promoting the tool to
permanent auto-allow in the server's `toolPermissions`.

Key files: `mcp-manager.ts`, `mcp-config-store.ts`, `mcp-tool-permissions.ts`,
`mcp-description-generator.ts`, `mcp-workspace-profile.ts`.

**Per-session & per-workspace MCP toggle:**

MCP tool definitions consume significant context window tokens. To optimize usage,
servers can be selectively disabled at three levels (highest priority wins):

1. **Session override** (ephemeral) — user toggles in ContextPanel, stored in-memory
   in `SessionManager.sessionDisabledMcpServers` Map. Cleared on session delete.
2. **Workspace profile** — `{cwd}/.cowork/mcp-servers.json` file with `disabled`/`enabled`
   arrays. Follows the same pattern as `.cowork/prompts/` overrides. Committable to git.
3. **Global config** — per-server `enabled` boolean in `electron-store` (Settings UI).

Resolution happens in `agent-runner.ts` before building the SDK tool list each query:
`getEnabledServers() → applyWorkspaceOverrides() → applySessionOverrides()`.

Key files: `mcp-manager.ts`, `mcp-config-store.ts`, `mcp-workspace-profile.ts`.

**Per-session skill pinning:**

Skills (semantic-index, firecrawl, docx, pdf, etc.) are always available to the agent,
but it doesn't reliably use them unless explicitly told. Skill pinning lets users
"star" specific skills to inject explicit directives into the system prompt, telling
the agent to prioritize those skills. This is emphasis, not restriction — unpinned
skills remain fully available.

Pinning is session-scoped and ephemeral (in-memory only):

- **Welcome screen** — user selects skills before starting a chat; passed as
  `initialPinnedSkills` in the `session.start` payload.
- **ContextPanel** — user can pin/unpin skills mid-conversation via
  `skills.toggleSessionPin` IPC.
- **Prompt injection** — `agent-runner.ts` calls `buildPinnedSkillsDirective(sessionId)`
  which assembles a `<pinned_skills>` XML block appended to the system prompt.

Validation: skill IDs are validated for format (`SAFE_SKILL_ID_REGEX`), existence,
and enabled state. Hard limit of `MAX_PINNED_SKILLS_PER_SESSION` (10) prevents
prompt bloat. Shared constants live in `src/shared/skill-pinning-constants.ts`.

Key files: `session-manager.ts` (state), `agent-runner.ts` (directive injection),
`skill-pinning-constants.ts` (shared validation).

**Per-session skill disable & workspace profiles:**

Skills can be disabled per-session to reduce context window usage. The pattern mirrors
MCP server toggles with a three-layer resolution (highest priority wins):

1. **Session override** (ephemeral) — user removes skills in ContextPanel, stored in-memory
   in `SessionManager.sessionDisabledSkills` Map. Cleared on session delete.
2. **Workspace profile** — `{cwd}/.cowork/skills-profile.json` with `pinned`/`disabled` arrays.
   Committable to git, team-shared. Seeded into session state on `session.start`.
3. **Global config** — `skillConflictConfig.disabledSkills` in electron-store (Settings UI).

Agent-runner filters disabled skills from `additionalSkillPaths` before passing to the SDK.
Welcome page and ContextPanel both load/save workspace profiles via IPC.

Key files: `skills-workspace-profile.ts` (loader), `session-manager.ts` (state),
`agent-runner.ts` (filtering), `skill-conflict-types.ts` (shared types),
`skills-profile-derive.ts` (renderer dirty-state utility).

**Skill conflict resolution:**

When a custom skill and built-in skill share the same name, the conflict policy
(`custom-wins` / `builtin-wins` / `ask`) determines which version is loaded at runtime.
The detector scans builtin, user, and configured directories. Per-skill source overrides
allow explicit choices. Conflicts are surfaced via toast notifications and Settings UI.

Key files: `skill-conflict-detector.ts` (engine), `agent-runner.ts` (sync decisions),
`useSkillConflicts.ts` (renderer hook), `SettingsSkills.tsx` (conflict UI).

**Plugin system:**

Plugins are bundles of skills, commands, agents, hooks, and MCP configs installed from
the Claude marketplace or local `.plugin`/`.zip` archive files. The plugin runtime manages
source/runtime directory materialization, per-component enablement, and the plugin registry.

Key capabilities:

- **Archive install** — users can import `.plugin` or `.zip` files via Settings UI;
  extraction uses `yauzl` with path traversal protection, symlink rejection, and size limits.
- **Orchestrator detection** — at install time, SKILL.md frontmatter is scanned for
  orchestrator keywords (`orchestrat`, `coordinat`, `delegates to`). The detected entry
  point is stored as `InstalledPlugin.orchestratorSkill` and advertised to the LLM.
- **Plugin pinning** — session-scoped, ephemeral. Users pin entire plugins in the
  ContextPanel; `buildPinnedPluginsDirective()` generates a `<pinned_plugins>` XML block
  injected into the system prompt (~60-80 tokens per plugin vs ~1480 for individual skills).
  Validates plugin enabled state and per-component skill enablement before injection.
  Plugin metadata is XML-escaped and framed as untrusted data.

Key files: `plugin-runtime-service.ts` (install, archive, orchestrator, runtime),
`plugin-registry-store.ts` (electron-store persistence), `plugin-catalog-service.ts`
(marketplace), `session-manager.ts` (sessionPinnedPlugins), `agent-runner.ts`
(buildPinnedPluginsDirective), `ContextPanel.tsx` (pinning UI), `SettingsSkills.tsx`
(archive import UI).

### 4.4 Sandbox & Security (`src/main/sandbox/`)

Platform-aware execution facade: `SandboxAdapter` routes to WSL2 (Windows), Lima (macOS),
or Native fallback. Currently `sandboxEnabled: false` by default — backend is code-complete
but UI toggle is hidden pending stabilization.

Security layers: PathGuard (blocks escape from session dir), path containment
(`isPathWithinRoot`), permission hooks (trust/denylist for bash), workspace path constraints.

### 4.5 System Prompt (`src/main/prompts/`)

The AI's system prompt is assembled from user-editable section files stored in
`{userData}/prompts/`. This is a key customization feature — users can modify the AI's
personality, behavioral rules, and tool routing without touching code.

**Architecture:**

```
Global sections:  {userData}/prompts/
                  ├── identity.md
                  ├── behavioral-rules.md
                  ├── citations.md
                  ├── tool-routing.md
                  └── _meta.json (enabled/disabled state)

Workspace overrides:  {cwd}/.cowork/prompts/
                      └── identity.md (replaces global identity.md)
```

**Assembly order:** identity → behavioral-rules → citations → tool-routing → workspace-info
(dynamic) → bundled-path-hints (dynamic).

**Workspace overrides (Option A):** If `{cwd}/.cowork/prompts/{section}.md` exists, it
completely replaces the corresponding global section for that workspace.

**Template variables:** `{{cwd}}`, `{{project_name}}`, `{{date}}`, `{{model}}` are resolved
at assembly time.

**Performance:** Uses mtime+size fingerprinting — checks file stats on each message (fast
syscall), only re-reads content when files have changed. Prompt files are read by the main
process on the host, never inside the sandbox.

Key file: `prompt-loader.ts`. Settings UI: `SettingsPrompt.tsx`.

### 4.6 Memory System (`src/main/memory/`)

Two-layer memory architecture: **passive core injection** + **active experience retrieval**.

**Core Memory (passive)** — stable user profile entries (preferences, identity, skills)
are always injected into the prompt via `<memory_context>` XML block. Small, stable,
workspace-filtered. Updated conservatively after each session.

**Experience Memory (active)** — past conversation chunks are NOT pre-injected. Instead,
the model receives `search_workspace_chats` and `read_workspace_chat` tools that it can
invoke on-demand when it needs context from prior sessions. This saves context window
budget and ensures retrieved experience is relevant to the model's actual needs.

```
User sends message
       │
       ▼
MemoryExtension.beforeSessionRun()
       │
       ├─ 1. Inject core memory (passive, always present)
       ├─ 2. Register search_workspace_chats tool (active, on-demand)
       ├─ 3. Register read_workspace_chat tool (active, on-demand)
       │
       ▼
LLM receives: core_memory + tools available
       │
       ▼
LLM decides: "Do I need past conversation context?"
       │ YES                              │ NO
       ▼                                  ▼
tool_call: search_workspace_chats    Respond directly
       │
       ▼
Results from workspace experience memory
       │
       ▼
(optional) tool_call: read_workspace_chat for full details
       │
       ▼
LLM synthesizes answer with retrieved context
```

Key files: `memory-extension.ts` (extension hook), `memory-chat-search-tool.ts`
(active retrieval tools), `memory-service.ts` (core logic), `memory-tools.ts`
(legacy search/read tools for Settings UI).

---

## 5. Data Flow & Runtime Model

### Agent turn lifecycle (single user message → response)

```
User msg → AgentRunner → pi-coding-agent (ReAct loop) ←→ LLM Provider
                              │
                         tool_call? ──NO──→ stream text to renderer
                              │YES
                              ▼
                      Permission Gate (bash list + dialog)
                              │
                              ▼
                      Tool Exec (MCP / built-in / sandbox)
                              │
                              ▼
                      result → append to context → next iteration
```

### IPC event streaming (main ↔ renderer)

```
Main ──server-event──► Renderer    (message_update, tool_execution_*, agent_end)
Main ◄──client-event── Renderer    (stop_generation, send_message)
```

### Persistence

```
electron-store (JSON)          better-sqlite3
├── API keys/profiles          ├── Sessions
├── Model presets              ├── Messages
├── Bash trust/denylist        ├── Memory entries
├── UI preferences             ├── Schedule tasks
└── Sandbox config             └── Skill metadata
```

---

## 6. Configuration & Environment Assumptions

| Item              | Value                            | Notes                                                 |
| ----------------- | -------------------------------- | ----------------------------------------------------- |
| Node.js           | ≥22                              | `.nvmrc` pinned; bundled Node shipped in `resources/` |
| Electron          | 41.x                             | `better-sqlite3` must rebuild against Electron ABI    |
| Package manager   | npm                              | `package-lock.json` committed; no yarn/pnpm           |
| Build tool        | Vite 7 + vite-plugin-electron    | `vite.config.ts`                                      |
| Test runner       | Vitest 4                         | `vitest.config.mts`; run with `npm test`              |
| Linter            | ESLint 8 + Prettier              | `.eslintrc.cjs`, `.prettierrc`                        |
| CSS               | Tailwind 3 + PostCSS             | `tailwind.config.js`                                  |
| TypeScript        | 5.3+                             | Strict mode; `tsconfig.json` + `tsconfig.node.json`   |
| OS targets        | macOS (arm64/x64), Windows (x64) | Linux: build-from-source only                         |
| Python            | Optional, for skills             | Bundled via `scripts/prepare-python.js`               |
| uv                | Required for skill scripts       | PEP 723 inline deps; user-installed or bundled        |
| Commit convention | Conventional Commits             | `commitlint.config.cjs` + Husky                       |

Environment variables (`.env.example`): `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`CLAUDE_MODEL`, `CLAUDE_CODE_PATH`. All optional — users configure via Settings UI.

---

## 7. Stability Zones

| Zone                | Components                                                                                                                | Notes                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ✅ **Stable**       | Renderer UI, Config Store, IPC bridge, Session management, i18n, electron-updater, Skills loader, MCP Manager (stdio/SSE) | Production-ready, low risk                                             |
| ✅ **Stable**       | Skill conflict resolution, Skill workspace profiles, Skill pinning                                                        | Phase 0–5 complete; policy engine, session disable, profile save/load  |
| ✅ **Stable**       | Bash permission engine (trust/denylist), Path containment                                                                 | Security-critical, well-tested                                         |
| ✅ **Stable**       | System prompt loader (editable sections, workspace overrides, template variables)                                         | 46 tests, file-based, no external deps                                 |
| 🔄 **Semi-Stable**  | `ClaudeAgentRunner` + pi-coding-agent integration                                                                         | Functional but coupled to pre-1.0 SDK; breaks on Pi upgrades           |
| 🔄 **Semi-Stable**  | Remote channels (Feishu/Slack), GUI-operate server                                                                        | Working but APIs evolve; Feishu SDK updates frequently                 |
| 🔄 **Semi-Stable**  | SQLite persistence layer                                                                                                  | Schema may evolve with memory system                                   |
| ⚠️ **Experimental** | Sandbox (WSL2/Lima)                                                                                                       | Code-complete, UI-gated, not user-facing yet                           |
| ⚠️ **Experimental** | Memory system (`src/main/memory/`)                                                                                        | Active retrieval via tools + passive core injection                    |
| 🔄 **Semi-Stable**  | Schedule system (`src/main/schedule/`)                                                                                    | v2 complete: time windows, catch-up, budgets, run history              |
| 🔄 **Semi-Stable**  | Plugin system (`src/main/skills/plugin-runtime-service.ts`)                                                               | Archive install, orchestrator detection, session-scoped plugin pinning |
| 🔮 **Planned**      | Multi-agent orchestration                                                                                                 | See `ROADMAP.md`                                                       |
| 🔮 **Planned**      | Linux first-class support                                                                                                 | Build-from-source only today                                           |
| 🔮 **Planned**      | Web version (server mode)                                                                                                 | Architecture supports it (clean IPC boundary)                          |

---

## 8. AI Coding Rules and Behavioral Contracts

**This document does NOT define coding rules.** All AI coders MUST locate and follow
the dedicated rule files listed below.

### Authoritative AI Rule Files

| File                           | Scope                                                                                             | Status    |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | --------- |
| `AI_ELECTRON.md`               | Electron packaging, resource paths, window lifecycle, PyInstaller, external tools, sleep recovery | ✅ Active |
| `BASH_COMMAND_RESTRICTIONS.md` | Bash permission engine internals, trust/denylist semantics, pipeline splitting, shell syntax      | ✅ Active |
| `AI_FRONTEND.md`               | React/Zustand/Tailwind conventions, i18n, accessibility                                           | ✅ Active |
| `AI_MAIN_PROCESS.md`           | Pi SDK integration, IPC patterns, MCP bridging, SQLite, security boundaries                       | ✅ Active |
| `AI_SKILLS_MAINTENANCE.md`     | Builtin skill dependency management, PEP 723 metadata, upstream sync rules                        | ✅ Active |

### Rule Precedence (Highest → Lowest)

1. **Explicit user instructions** in the current task
2. **Stack-specific `AI_*.md`** files (e.g., `AI_ELECTRON.md` for packaging questions)
3. **`BASH_COMMAND_RESTRICTIONS.md`** for bash permission behavior
4. **This `ARCHITECTURE.md`** (architectural constraints only)
5. **`docs/dependency-tiers.md`** for dependency upgrade decisions
6. **Implicit conventions** inferred from existing code patterns
7. **`docs/chats/`** for historical context and prior decisions

### Behavioral Contracts for AI Coders

- **Never modify `@earendil-works/pi-*` packages** — we are a pure consumer of the SDK
- **Never access Pi private fields** (`_beforeToolCall`, etc.) without documenting the risk
- **Version-lock `pi-ai` and `pi-coding-agent`** — always upgrade together
- **MCP servers run on host only** — never route MCP spawns through sandbox bridges
- **Renderer must never import Node/Electron directly** — all access via `window.electronAPI`
- **Security changes require explicit confirmation** — path containment, permission hooks, sandbox boundaries
- **Builtin skill scripts use `uv run`** — all `.claude/skills/*/scripts/*.py` with third-party imports must have PEP 723 inline metadata; after upstream sync run `scripts/reapply-skill-deps.py`
- **Check `docs/chats/` for prior decisions** before proposing architectural changes
- If any rule conflict or ambiguity is detected, **stop and ask for clarification**

### Steering Files

Additional runtime guidance lives in `.kiro/steering/`:

- `search-first.md` — search codebase + docs/chats before answering

---

## 9. Quick Start for AI Assistants

1. **Read this file** — understand the system in <5 minutes
2. **Read the relevant `AI_*.md`** for your change area (Section 8 table)
3. **Search `docs/chats/`** for prior discussions on the topic
4. **Check `docs/dependency-tiers.md`** before touching dependencies
5. **Identify the stability zone** (Section 7) — be conservative with ⚠️/🔮 components
6. **Run `npm run typecheck`** after changes to verify TypeScript
7. **Run `npm test`** to verify existing tests pass
8. **Never push to main** — always use a feature branch

Key commands:

```bash
npm run dev              # Start dev server (Vite + Electron)
npm run typecheck        # TypeScript check (no emit)
npm test                 # Vitest (watch mode)
npm run lint             # ESLint
npm run build            # Full production build
```

Key entry points:

- Main process: `src/main/index.ts`
- Agent engine: `src/main/claude/agent-runner.ts`
- Renderer: `src/renderer/App.tsx`
- IPC schema: `src/preload/index.ts`
- Config: `src/main/config/config-store.ts`
