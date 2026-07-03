# Code Assistant Tab — Implementation Plan

**Status:** ❌ Abandoned — implemented instead as a VS Code extension: **sqowe-wingman**
**Date:** 2026-06-19
**Owner:** @obodnikov
**Related:** [agent-runner.ts](../../src/main/claude/agent-runner.ts), [App.tsx](../../src/renderer/App.tsx), [pi-bash-restrictions-extension.md](pi-bash-restrictions-extension.md), [file-tool-path-permissions.md](file-tool-path-permissions.md), `node_modules/@earendil-works/pi-coding-agent/docs/{sdk,rpc}.md`

---

## 1. Goal

Add a **Code Assistant** experience as a new top-level view ("tab") in the Electron app — a
project-directory-centric coding agent — that **reuses the app's existing engine, configuration,
providers, skills, MCP servers, and permission system** rather than introducing a parallel stack.

### The core realization (why this is mostly UX, not engine work)

The app **already embeds the `pi` coding agent**. [agent-runner.ts](../../src/main/claude/agent-runner.ts)
runs `createAgentSession(...)` with `createCodingTools(effectiveCwd)` (read/write/edit/bash/grep/find/ls),
**bridges MCP servers as `customTools`** (~line 3114), loads skills, resolves providers/models, and
installs the permission gate. The current "chat" tab and a "code assistant" tab are the **same
engine** — they differ in _persona_ (system prompt), _UX_ (chat vs. code-centric), and _workspace
model_. So this feature is built by **adding a mode on top of the runner we already have**, not by
embedding or re-implementing anything.

### Non-goals

- Embedding the standalone `pi` CLI binary in a terminal (xterm/PTY). See §3 (rejected alternative)
  — it _reduces_ reuse and adds a native dep.
- A full IDE (no editing surface, debugger, LSP). This is an agent view with code-aware rendering.
- Changing the chat tab's behavior.

---

## 2. What's reused vs. net-new (the whole point)

### Reused as-is (zero or near-zero work)

| Capability                                                      | Where it already lives                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent engine + coding tools                                     | `createAgentSession` + `createCodingTools` — [agent-runner.ts](../../src/main/claude/agent-runner.ts)                                                                                                                                                                                |
| MCP servers (bridged as customTools)                            | `agent-runner.ts` (~3114), `mcp-manager.ts`                                                                                                                                                                                                                                          |
| Skills (load, pin, workspace profiles)                          | skills loader, `skills-workspace-profile.ts`                                                                                                                                                                                                                                         |
| **Permissions** (bash trust/deny + the new workspace path-lock) | `decidePermission` — [permission-rules-store.ts](../../src/main/config/permission-rules-store.ts)                                                                                                                                                                                    |
| Providers / models                                              | `pi-model-resolution.ts`                                                                                                                                                                                                                                                             |
| Session lifecycle + persistence                                 | `SessionManager` + SQLite                                                                                                                                                                                                                                                            |
| cwd / workspace model                                           | sessions are already cwd-bound; `cwd`-keyed MCP/skills/workspace profiles                                                                                                                                                                                                            |
| Message / tool-call / tool-result / code rendering              | [MessageCard](../../src/renderer/components/MessageCard.tsx), [ToolUseBlock](../../src/renderer/components/message/ToolUseBlock.tsx), [ToolResultBlock](../../src/renderer/components/message/ToolResultBlock.tsx), [CodeBlock](../../src/renderer/components/message/CodeBlock.tsx) |
| IPC streaming                                                   | `session.start`, `server-event`/`client-event`                                                                                                                                                                                                                                       |
| System-prompt section system                                    | `prompt-loader.ts` (editable sections + workspace overrides)                                                                                                                                                                                                                         |

### Net-new (the actual work)

1. A **third top-level view** + nav state (today it's a `showSettings` boolean toggling
   `<SettingsPanel>`/`<ChatView>` in [App.tsx:193](../../src/renderer/App.tsx)).
2. A **coding persona** — a system-prompt section for the Code mode (reusing `prompt-loader`).
3. A **project-bound session model** — pick a project directory; Code sessions are scoped to it.
4. **Code-centric UI** — chiefly a **diff-focused render** for `edit`/`write` results; optionally a
   project file tree and a change-review pane. (Message/tool/code rendering is reused.)

---

## 3. Decision: reuse the runner (Approach B), not embed the CLI (Approach A)

|                    | A. Embed `pi` CLI in a terminal tab                                                                                                  | **B. Code view on the existing runner (chosen)**      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Engine             | spawn `pi` binary                                                                                                                    | already in-process                                    |
| Config / providers | **manual sync** electron-store → `~/.pi/`                                                                                            | **automatic** (same store)                            |
| Skills             | sync to `~/.pi/agent/skills/`                                                                                                        | automatic                                             |
| **MCP**            | **hard** — standalone CLI has no MCP-server config (no `mcp` doc; settings.json has no MCP section); would need a bridging extension | automatic (already bridged)                           |
| Permissions        | `pi`'s own / bypasses app gate                                                                                                       | **inherits app gate** incl. bash + path-lock features |
| Native deps        | node-pty (ABI rebuild pain)                                                                                                          | none                                                  |
| Net-new            | PTY + config/skill/provider sync + MCP bridge + dual config/permission worlds                                                        | a view + coding session + code UI                     |

**A wins only if** the literal `pi` terminal TUI (its slash commands, interactive rendering,
extension ecosystem running verbatim) is the explicit goal and config reuse is acceptable as a sync
problem. For the stated reuse goal, **B is correct** and is the lower-risk, higher-reuse path. (A
third option — drive `pi` via its RPC mode, `docs/rpc.md` — is more complex than reusing the
in-process runner and offers no reuse advantage; not pursued.)

---

## 4. Architecture

```
┌ Renderer ───────────────────────────────────────────────┐
│ Top-level view state: 'chat' | 'code' | 'settings'      │
│   chat     → <ChatView/>        (today)                  │
│   code     → <CodeView/>        (NEW: reuses message/    │
│              project switcher    tool/code rendering)    │
│   settings → <SettingsPanel/>   (today)                  │
└──────────────┬──────────────────────────────────────────┘
               │ session.start { mode: 'code', cwd: <projectDir>, … }
               ▼
┌ Main ───────────────────────────────────────────────────┐
│ SessionManager → ClaudeAgentRunner (SAME runner)         │
│   • createCodingTools(projectCwd)   ← already used       │
│   • MCP customTools bridge          ← already used       │
│   • skills + permission gate        ← already used       │
│   • coding persona system prompt    ← NEW prompt section │
└──────────────────────────────────────────────────────────┘
```

A Code session is **just another `SessionManager` session** bound to a project directory, tagged
with a `mode: 'code'` so the runner selects the coding persona and the renderer routes it to
`<CodeView>`. Everything else flows through the existing pipeline.

---

## 5. Coding session configuration

- **Persona:** add a `coding` system-prompt section to `prompt-loader.ts` (editable like the others;
  workspace override supported). Assembled only for `mode: 'code'` sessions. Emphasizes: operate on
  the project, prefer the file tools, use skills, propose diffs.
- **Tools:** `createCodingTools(projectCwd)` — already the runner's tool set. No change.
- **Working directory:** the session's `cwd` = the chosen project dir; the runner already resolves
  `effectiveCwd` and updates `cwdRef` per run, so the permission gate (and the path-lock feature)
  evaluates against the project root automatically.
- **Skills / MCP / permissions:** inherited from global + the project's `.cowork/` workspace
  profiles (already cwd-keyed) — no new wiring.

---

## 6. UI

### Reused

`MessageCard`, `ToolUseBlock`, `ToolResultBlock`, `ContentBlockView`, `CodeBlock` render the
conversation, tool calls, tool output, and syntax-highlighted code today. `<CodeView>` composes the
same message stream + the existing composer.

### Net-new

- **Project switcher** — choose / recent project directories; starts/binds a Code session per project.
- **Diff rendering** for `edit`/`write` results. `pi`'s edit tool already produces a unified patch
  (`generateUnifiedPatch`); v1 renders it as a colored diff (a dedicated `DiffBlock`, or enhance
  `ToolResultBlock` to detect patch output). **Confirm during Phase 4 whether `ToolResultBlock`
  already surfaces the patch.**
- **(Optional / later)** project file tree; a change-review pane aggregating edits in the session.

---

## 7. Implementation phases — unit tests where they fit; integration + e2e last

> GUI-heavy phases lean on store/prompt/component unit tests; full cross-process behavior is the
> final phase.

### Phase 1 — Coding session backend (mode + persona)

- **Code:** `mode: 'code'` on `SessionManager` sessions; `prompt-loader` `coding` section selected
  for code sessions; bind session `cwd` to a project dir; runner path unchanged otherwise.
- **Tests:** session created with `mode:'code'` uses coding tools + coding persona + project cwd;
  MCP/skills/permission wiring identical to chat (assert reuse, not duplication). Existing session
  tests pass.
- **Gate:** `npm test` + typecheck.

### Phase 2 — Top-level "Code" view + nav

- **Code:** extend renderer top-level state from `showSettings` boolean to a `view: 'chat' | 'code'
| 'settings'` enum (or add a parallel flag); `<CodeView>` reusing the message/tool/code rendering;
  route `mode:'code'` sessions to it.
- **Tests:** store/selector tests for view switching; `<CodeView>` renders a code session's stream.
- **Gate:** typecheck + lint + renderer tests.

### Phase 3 — Project model (picker + project-bound sessions)

- **Code:** project directory picker (reuse the existing folder-selection / local-dev-path
  mechanism); project-scoped Code session list; persist last project(s).
- **Tests:** session-list scoping by project; persistence; `session.start { mode:'code', cwd }` IPC.
- **Gate:** typecheck + lint + tests.

### Phase 4 — Code-centric rendering (diffs)

- **Code:** `DiffBlock` (or enhanced `ToolResultBlock`) rendering edit/write patches as colored
  diffs; wire into `<CodeView>`.
- **Tests:** diff component snapshot/parse tests over sample unified patches (add/modify/delete).
- **Gate:** typecheck + lint + tests.

### Phase 5 (LAST) — Integration + e2e + docs

- **Integration:** start a Code session in a real temp project; confirm reuse — MCP tools available,
  skills load, providers/models resolve, and **the bash + workspace path-lock permissions apply** to
  the file tools in the project.
- **e2e (manual + scripted where feasible):** open Code tab → pick project → ask for an edit →
  diff renders → approve/deny via the existing permission dialog; switch projects; reopen persists.
- **Docs:** user docs for the Code tab; update [ARCHITECTURE.md](../../ARCHITECTURE.md) (renderer
  views + "one engine, two front-ends" note).

---

## 8. Risks

- **Multi-session concurrency.** The runner is "one session per chat"; a Code session alongside an
  active chat means two live sessions. `SessionManager` already manages multiple sessions, but verify
  no shared mutable state assumes a single active session (e.g., `cwdRef` is per-session — good).
- **View-state refactor.** Moving from a `showSettings` boolean to a tri-state view touches `App.tsx`
  - store + any code reading `showSettings`. Mechanical but broad; do it as its own (Phase 2) step.
- **Diff rendering scope creep.** Keep v1 to read-only colored diffs of tool output; defer staging /
  partial-apply / file tree.
- **Persona drift.** A separate coding system prompt is another prompt surface to maintain; reuse the
  editable-sections system so users can tune it, and keep it short.
- **No new native deps** (unlike Approach A) — keeps the build matrix unchanged.

---

## 9. Open decisions (recommendations inline — to confirm before/early in build)

1. **Navigation model:** separate top-level **view** ("Code" beside Chat/Settings) _(recommended)_
   vs. a per-session mode toggle inside the chat view.
2. **Session/project model:** Code tab has its **own project-bound session list** _(recommended)_
   vs. reusing the chat session list with a coding flag.
3. **v1 UI scope:** **MVP = reused chat rendering + diff view + project switcher** _(recommended)_;
   defer file tree + change-review/staging.
4. **Persona source:** a **new `coding` prompt-loader section** _(recommended)_ vs. a workspace
   prompt override only.
5. **Concurrency:** **single active Code session (one project at a time)** for v1 _(recommended)_;
   multiple project tabs later.

---

## 10. Effort summary

- **Reused (free):** engine, coding tools, MCP, skills, permissions (incl. bash + path-lock),
  providers/models, session persistence, message/tool/code rendering, IPC, prompt-section system.
- **Net-new (the work):** a top-level view + nav state, a coding persona section, a project-bound
  session model, and diff rendering — i.e., **mostly renderer/UX plus a thin session-mode seam**.
- **Overall:** moderate, front-loaded on UX. No engine integration, no native deps, no config/MCP
  bridging — those are the parts that would have made the embed-the-CLI route hard.
