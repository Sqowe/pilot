# Architecture Overview — Open Cowork

## 1. Purpose of This Document

This is the architectural source of truth for Open Cowork, an Electron desktop AI agent
application. It describes the system as it exists today (v3.3.0), not as imagined.

Any AI coder working on this repository MUST read this document first to understand
structure, boundaries, and where to find authoritative coding rules. This document
does NOT define coding rules — it points to them (see Section 8).

Target audience: AI coding assistants and new human contributors.
Last updated: 2026-05-12.

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

### 4.4 Sandbox & Security (`src/main/sandbox/`)

Platform-aware execution facade: `SandboxAdapter` routes to WSL2 (Windows), Lima (macOS),
or Native fallback. Currently `sandboxEnabled: false` by default — backend is code-complete
but UI toggle is hidden pending stabilization.

Security layers: PathGuard (blocks escape from session dir), path containment
(`isPathWithinRoot`), permission hooks (trust/denylist for bash), workspace path constraints.

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
| Commit convention | Conventional Commits             | `commitlint.config.cjs` + Husky                       |

Environment variables (`.env.example`): `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`CLAUDE_MODEL`, `CLAUDE_CODE_PATH`. All optional — users configure via Settings UI.

---

## 7. Stability Zones

| Zone                | Components                                                                                                                | Notes                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| ✅ **Stable**       | Renderer UI, Config Store, IPC bridge, Session management, i18n, electron-updater, Skills loader, MCP Manager (stdio/SSE) | Production-ready, low risk                                   |
| ✅ **Stable**       | Bash permission engine (trust/denylist), Path containment                                                                 | Security-critical, well-tested                               |
| 🔄 **Semi-Stable**  | `ClaudeAgentRunner` + pi-coding-agent integration                                                                         | Functional but coupled to pre-1.0 SDK; breaks on Pi upgrades |
| 🔄 **Semi-Stable**  | Remote channels (Feishu/Slack), GUI-operate server                                                                        | Working but APIs evolve; Feishu SDK updates frequently       |
| 🔄 **Semi-Stable**  | SQLite persistence layer                                                                                                  | Schema may evolve with memory system                         |
| ⚠️ **Experimental** | Sandbox (WSL2/Lima)                                                                                                       | Code-complete, UI-gated, not user-facing yet                 |
| ⚠️ **Experimental** | Memory system (`src/main/memory/`)                                                                                        | Under active development (PR #138)                           |
| 🔄 **Semi-Stable**  | Schedule system (`src/main/schedule/`)                                                                                    | v2 complete: time windows, catch-up, budgets, run history    |
| 🔮 **Planned**      | Plugin system, Multi-agent orchestration                                                                                  | See `ROADMAP.md`                                             |
| 🔮 **Planned**      | Linux first-class support                                                                                                 | Build-from-source only today                                 |
| 🔮 **Planned**      | Web version (server mode)                                                                                                 | Architecture supports it (clean IPC boundary)                |

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
