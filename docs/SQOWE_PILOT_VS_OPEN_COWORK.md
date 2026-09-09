# Why Sqowe Pilot Is Not Open Cowork

**Sqowe Pilot** began as a fork of [Open Cowork](https://github.com/OpenCoworkAI/open-cowork)
(MIT) but has diverged substantially. It is now developed as a standalone product, hosted
privately on GitLab. This document records the concrete, shipped differences — the features,
subsystems, and engineering decisions that make Sqowe Pilot a distinct product rather than a
re-skin.

> Attribution: the original Open Cowork copyright and MIT license are retained in
> [LICENSE](../LICENSE). See also the upstream project at
> <https://github.com/OpenCoworkAI/open-cowork>.

Each section below points at the source of truth in this repository so the claims are
verifiable, not marketing.

---

## 1. Memory subsystem

A two-layer, workspace-aware memory architecture that does not exist upstream
([ARCHITECTURE.md §4.6](../ARCHITECTURE.md)).

- **Passive core memory** — stable user-profile entries (preferences, identity, durable
  facts) are always injected into the prompt as a `<memory_context>` XML block. Small,
  stable, and **workspace-filtered** so unrelated projects don't pollute context.
- **Active experience retrieval** — past conversations are _not_ pre-injected. The model is
  given `search_workspace_chats` and `read_workspace_chat` tools and decides on-demand when
  it needs prior context. This saves context-window budget, gives clean provenance
  (retrieved vs current-session), and avoids false confidence from stale injected text.
- **Hybrid retrieval scoring** — ranking combines vector cosine similarity, lexical keyword
  overlap, a **workspace boost (+0.3)**, and a **recency boost (+0.02–0.08, decaying over
  45 days)** ([README.md](../README.md), "Retrieval Scoring").
- **Fact-staleness handling** — a dedicated design addresses when remembered facts go out of
  date ([docs/design/memory-fact-staleness-problem.md](design/memory-fact-staleness-problem.md)).
- **Unified memory access for Claude tools** — memory is exposed through a consistent tool
  surface rather than buried in settings.

Key files: `memory-extension.ts`, `memory-chat-search-tool.ts`, `memory-service.ts`.

## 2. Skills & plugins

Upstream ships skills; Sqowe Pilot adds a full plugin lifecycle
([ARCHITECTURE.md §4.3](../ARCHITECTURE.md)).

- **Archive install** — import `.plugin` or `.zip` bundles from the Settings UI. Extraction
  uses `yauzl` with **path-traversal protection, symlink rejection, and size limits**.
- **Orchestrator auto-detection** — at install time, `SKILL.md` frontmatter is scanned for
  orchestrator keywords (`orchestrat`, `coordinat`, `delegates to`); the detected entry point
  is stored as `InstalledPlugin.orchestratorSkill` and advertised to the LLM.
- **Plugin-level pinning** — session-scoped pins inject a compact `<pinned_plugins>` directive
  (~60–80 tokens per plugin vs ~1480 for individual skills) via `buildPinnedPluginsDirective()`;
  plugin metadata is XML-escaped and framed as untrusted.
- **Conflict resolution** — explicit handling of skill name/ID collisions
  (`src/shared/skill-conflict-types.ts`).
- **Workspace profiles** — per-workspace skill enablement persisted in
  `.cowork/skills-profile.json`.
- **Version-stamped auto-update** — installed plugins/skills carry version metadata for
  update detection.

Key files: `plugin-runtime-service.ts`, `plugin-registry-store.ts`, `plugin-catalog-service.ts`.

## 3. MCP management

Beyond upstream's basic MCP bridging:

- **Per-server enable/disable toggles** in the UI.
- **"Save to Workspace" connector profiles** — committable MCP server definitions
  (`SettingsConnectors.tsx`, `.cowork/mcp-servers.json`).
- **Default tool permissions** per server.
- **LLM-generated server descriptions** to make connectors self-documenting.
- **Orphan detection + cleanup** — when a skill or MCP server is removed, stale references
  left in committed workspace config are detected on activation and surfaced in a
  non-blocking cleanup modal following a `detect → inform → fix → dismiss` pattern
  ([ARCHITECTURE.md §4.8](../ARCHITECTURE.md), `workspace-orphan-detector.ts`).

## 4. Scheduler v2

An anacron-style, in-app task scheduler ([docs/design/archive/scheduler-v2.md](design/archive/scheduler-v2.md)).

- **Named fuzzy time windows** (morning/afternoon/evening/night) — tasks run _sometime within_
  a window, not at a precise second; the system picks the moment.
- **Catch-up policies** for missed windows, with a batch run/skip recovery panel.
- **Explicit config-set binding** per task (no implicit LLM-config inheritance) and an
  autonomous `executionMode: 'auto'` that blocks on any non-trusted (`ask`) command.
- **Per-run token/time budgets** to prevent runaway autonomous tasks.
- **Window-tied lifecycle** — the scheduler lives and dies with the app window; no OS-level
  daemons or background processes.

Key file: `src/main/schedule/time-window.ts`.

## 5. Internationalization

Sqowe Pilot ships **four** locales versus upstream's English + Chinese: English (`en`),
Chinese (`zh`), and fork-added **Russian (`ru`)** and **Hungarian (`hu`)**
(`src/renderer/i18n/locales/{en,zh,ru,hu}.json`).

## 6. Custom MCP servers (bundled)

Two purpose-built legal-research MCP servers ship in `tools/`:

- **EU Law** (`tools/eu-law-mcp`) — search and retrieve EU legislation and CJEU case-law via
  the Cellar SPARQL endpoint and EUR-Lex (by CELEX number / ECLI). No auth, with in-memory
  TTL caching and rate limiting.
- **Hungarian Law** (`tools/hungarian-law-mcp`) — Hungarian legislation via njt.hu (Nemzeti
  Jogszabálytár) and the Magyar Közlöny gazette, using HTTP + cheerio scraping.

## 7. Bash command restrictions

A **pure, stateless** trust/denylist permission engine that is the single source of truth for
both the engine logic and its settings schema
([ARCHITECTURE.md §4.7](../ARCHITECTURE.md), [BASH_COMMAND_RESTRICTIONS.md](../BASH_COMMAND_RESTRICTIONS.md)).

- Consumed by two hosts unchanged: the Electron main process (`before-tool-call-hook.ts`) and
  a drop-in standalone `pi` CLI extension (`pi-extensions/bash-restrictions/`) that subscribes
  to `pi`'s public `tool_call` event — **no fork of the SDK**.
- Adding a new permission setting is a one-place change in `src/shared/bash-restrictions/`;
  both hosts pick it up. Handles trusted lists, denylists, and complex pipe parsing.

## 8. Sandbox isolation

A platform-aware execution facade (`SandboxAdapter`) that routes to **WSL2** (Windows),
**Lima** (macOS), or a native fallback, layered with `PathGuard` escape prevention and path
containment (`isPathWithinRoot`) ([ARCHITECTURE.md §4.4](../ARCHITECTURE.md)). The backend is
code-complete; the UI toggle is hidden pending stabilization (`sandboxEnabled: false` default).

## 9. Corporate-CLI model providers

Use a corporate CLI subscription (e.g. **kiro-gateway**) as a local, OpenAI-compatible model
provider — the gateway runs on `localhost`, refreshes corporate SSO/IdC tokens, and translates
the OpenAI API to the vendor's
([docs/guides/kiro-gateway-enterprise-setup.md](guides/kiro-gateway-enterprise-setup.md)). This
lets the app run against enterprise-gated models without leaving the desktop.

## 10. Customizable system prompt

The system prompt is assembled from **user-editable section files** in `{userData}/prompts/`
(`identity`, `behavioral-rules`, `citations`, `tool-routing`) with **per-workspace overrides**
in `{cwd}/.cowork/prompts/` and template variables (`{{cwd}}`, `{{project_name}}`, `{{date}}`,
`{{model}}`) resolved at assembly time ([ARCHITECTURE.md §4.5](../ARCHITECTURE.md)). The default
sections carry the **Sqowe Pilot** identity, not Open Cowork's.

## 11. Chat export

One-click **Markdown export** of conversations (`src/main/chat/export-markdown.ts`,
`ChatView.tsx`).

## 12. SDK foundation

Sqowe Pilot tracks the `@earendil-works/pi-*` SDK line (currently
`@earendil-works/pi-coding-agent` + `pi-ai` 0.80.2, post the upstream scope migration), wrapped
with the GUI, MCP bridging, sandbox, skills, memory, and permission-gating layers above.

---

_This document is a living record. As batches of the rebrand and feature work land, update the
relevant section and keep each claim anchored to a file in the repository._
