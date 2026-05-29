# NPM Dependency Tiers

> Scope: runtime `dependencies` from `package.json` (v3.3.0). DevDependencies excluded — they affect the build pipeline, not end-user features.
> Last updated: 2026-05-23 (pi-coding-agent + pi-ai uplift 0.74→0.75.5).
>
> Purpose: identify which upstream libraries most directly drive end-user features so uplifts can be prioritized and new capabilities adopted quickly. The machine-readable companion lives at [`docs/dependency-tiers.json`](./dependency-tiers.json).

## How the tiers are defined

Importance is judged by **direct impact on end-user features, with extra weight for anything in the LLM / model communication path**.

| Tier                    | Meaning                                                                                                                                    | Monitor cadence | Uplift priority |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | --------------- |
| **Tier 1 — Core**       | LLM SDKs, MCP protocol, agent runtime engine. New model support and protocol features land here first.                                     | Weekly          | High            |
| **Tier 2 — Platform**   | App shell (Electron/React), storage, remote channel integrations (Slack, Feishu), auto-update. Visible features, but APIs are more stable. | Bi-weekly       | Medium          |
| **Tier 3 — Supporting** | Rendering, i18n, utilities. Mostly commodity with stable APIs. Uplift for security or quality of life.                                     | Monthly         | Low             |

---

## Tier 1 — Core (LLM, Model, Agent Runtime)

These six libraries are **the AI pipeline**. A new Claude / GPT / Gemini model, a new MCP transport, or a new agent capability all arrive through these packages first. They are the highest-value release feeds to track.

| Package                           | Installed | Role                                                                                                                                                           |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@earendil-works/pi-coding-agent` | 0.75.5    | Agent execution engine. Drives `src/main/claude/agent-runner.ts` (~1500 lines) — session lifecycle, tool dispatch, streaming. Heart of the app.                |
| `@earendil-works/pi-ai`           | 0.75.5    | Unified LLM abstraction — provider routing, model registry, auth. Resolves which concrete SDK/endpoint to call. Must be version-locked with `pi-coding-agent`. |
| `@modelcontextprotocol/sdk`       | 1.27.1    | MCP client + server (stdio, SSE, Streamable HTTP). Powers the entire MCP connector ecosystem in `src/main/mcp/mcp-manager.ts`.                                 |
| `@anthropic-ai/sdk`               | 0.92.0    | Official Anthropic SDK. Used for Claude diagnostics and probes. Tracks new Claude model families.                                                              |
| `openai`                          | 6.32.0    | Official OpenAI SDK. Used across all OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, DashScope, custom proxies).                                      |
| `@google/genai`                   | 1.44.0    | Official Gemini SDK. Used in auth diagnostics; tracks new Gemini model previews.                                                                               |

**Why these are Tier 1:** if OpenAI ships a new Responses API feature, Anthropic ships a new `claude-opus-5`, or MCP publishes a new transport — the only way to expose that in the app is to bump the relevant package here. A missed release = a missed feature.

**Special note on `@earendil-works/pi-*`:** both packages live in a single monorepo (formerly `github.com/badlogic/pi-mono`, now under the `earendil-works` org). They are pre-1.0, ship frequently, and must be uplifted together. The old `@mariozechner/pi-*` scope is deprecated as of 0.73.1. Current: 0.75.5 (uplifted 2026-05-23).

---

## Tier 2 — Platform (App Shell, Storage, Integrations)

These power significant end-user features — remote channels, persistence, auto-update, the UI shell. New features here are real product capability, but APIs are more stable and release cadence is slower than Tier 1.

| Package                   | Installed    | Role                                                                                    |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `electron-updater`        | 6.8.3        | Auto-update mechanism. Without this, shipped users do not receive new versions.         |
| `electron-store`          | 11.0.2       | All user settings and profiles — API keys, model presets, UI state.                     |
| `better-sqlite3`          | 12.8.0       | Native SQLite binding. Entire persistence layer (sessions, messages, memory, schedule). |
| `@larksuiteoapi/node-sdk` | 1.62.0       | Feishu/Lark remote channel — WebSocket long-connection + REST.                          |
| `@slack/bolt`             | 4.7.0        | Slack app framework — Socket Mode and webhook handling.                                 |
| `@slack/web-api`          | 7.15.1       | Slack Web API client (paired with Bolt).                                                |
| `ngrok`                   | 5.0.0-beta.2 | Tunnel manager — exposes the gateway so Slack/Feishu webhooks can reach it.             |
| `ws`                      | 8.19.0       | WebSocket server for the Remote Gateway. Security-sensitive.                            |
| `chokidar`                | 4.0.3        | File watcher powering Skills hot-reload.                                                |
| `react`                   | 18.3.1       | Entire renderer UI framework. React 19 is out — major uplift candidate.                 |
| `react-dom`               | 18.3.1       | Locked in step with `react`.                                                            |
| `zustand`                 | 5.0.12       | Client-side state management.                                                           |
| `archiver`                | 7.0.1        | Zip/tar generation (artifacts, skill exports, diagnostics).                             |
| `dotenv`                  | 17.2.3       | Environment variables for the main process.                                             |

**Watch items in this tier:**

- **`react` 18 → 19** is a real upgrade path. Actions, `use()`, asset loading. Plan for a dedicated uplift.
- **`better-sqlite3`** requires `npm rebuild` against Electron ABI on every Electron bump. Coordinate with `electron` (devDep) major upgrades.
- **`ngrok` 5.0.0-beta.2** is a pre-release of a community wrapper. Official ngrok v2 JS SDK is a potential swap target if stability becomes an issue.
- **`ws`** — treat any new release as potentially security-driven.

---

## Tier 3 — Supporting (Rendering, i18n, Utilities)

Commodity libraries with stable APIs. Uplift when convenient, or for security patches.

| Package                            | Installed | Role                                                           |
| ---------------------------------- | --------- | -------------------------------------------------------------- |
| `react-markdown`                   | 9.1.0     | Renders model output as Markdown.                              |
| `remark-gfm`                       | 4.0.1     | GFM tables / task lists / strikethrough.                       |
| `remark-math`                      | 6.0.0     | Math block parsing.                                            |
| `rehype-katex`                     | 7.0.1     | KaTeX rendering bridge.                                        |
| `rehype-sanitize`                  | 6.0.0     | **Security-relevant** — sanitizes LLM HTML output against XSS. |
| `katex`                            | 0.16.45   | Math typesetting engine.                                       |
| `highlight.js`                     | 11.11.1   | Syntax highlighting for code blocks.                           |
| `i18next`                          | 25.10.1   | Translation engine.                                            |
| `react-i18next`                    | 16.6.0    | React bindings for i18next.                                    |
| `i18next-browser-languagedetector` | 8.2.1     | Auto-detects user language.                                    |
| `lucide-react`                     | 0.468.0   | Icon set.                                                      |
| `glob`                             | 10.5.0    | Filesystem globbing.                                           |
| `uuid`                             | 11.1.0    | ID generation.                                                 |

**Exception:** `rehype-sanitize` is marked `monitor_releases: true` in the JSON despite being Tier 3 because it's an XSS boundary on untrusted LLM output. CVEs here matter.

**Coordination notes:** the `react-markdown` + `remark-*` + `rehype-*` + `katex` + `highlight.js` stack is best uplifted as a group — they evolve as a family in the unified/remark ecosystem.

---

## Summary of monitoring priorities

Packages with `monitor_releases: true` in `dependency-tiers.json` (18 total):

**Tier 1 (6):** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `openai`, `@google/genai`

**Tier 2 (11):** `electron-updater`, `electron-store`, `better-sqlite3`, `@larksuiteoapi/node-sdk`, `@slack/bolt`, `@slack/web-api`, `ngrok`, `ws`, `chokidar`, `react`, `react-dom`

**Tier 3 (1):** `rehype-sanitize` (security boundary)

The remaining packages use `monitor_releases: false` — check them opportunistically during routine maintenance or when `npm audit` flags something.

---

---

## Bundled Runtimes & Tools

> Non-npm executables bundled into the packaged app via `extraResources`. These provide the agent runtime environment for Skills, MCP servers, and GUI automation. Managed by dedicated download/prepare scripts, not npm.

| Runtime      | Version           | Platforms                                      | Bundle Path         | Script                         | EOL      |
| ------------ | ----------------- | ---------------------------------------------- | ------------------- | ------------------------------ | -------- |
| **Node.js**  | 22.22.0           | darwin-arm64, darwin-x64, win32-x64, linux-x64 | `Resources/node/`   | `scripts/download-node.js`     | Apr 2027 |
| **Python**   | 3.12.11           | darwin-arm64, darwin-x64, linux-x64            | `Resources/python/` | `scripts/prepare-python.js`    | Oct 2028 |
| **cliclick** | latest (Homebrew) | darwin-arm64, darwin-x64                       | `Resources/tools/`  | `scripts/prepare-gui-tools.js` | —        |

**Node.js** — Runs MCP servers (via bundled npx), npm packages, and Node.js-based Skills. LTS v22 (Active LTS until Oct 2025, Maintenance until Apr 2027). Bundled npx uses a custom shell wrapper to avoid broken `require()` paths in the extracted layout.

**Python** — GUI automation runtime. Bundles `pillow` (image processing) and `pyobjc-framework-Quartz` (macOS screen capture). Source: [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone) release `20260510`. Upgraded from 3.10 → 3.12 on 2026-05-13 (3.10 EOL Oct 2026).

**cliclick** — macOS-only GUI click automation binary. Copied from Homebrew on the build machine. No version pinning. Low change frequency.

### Bundled MCP Servers

| Server                      | Source                                        | Bundle                                         | Build                        |
| --------------------------- | --------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| gui-operate-server          | `src/main/mcp/gui-operate-server.ts`          | `Resources/mcp/gui-operate-server.js`          | esbuild (self-contained CJS) |
| software-dev-server-example | `src/main/mcp/software-dev-server-example.ts` | `Resources/mcp/software-dev-server-example.js` | esbuild (self-contained CJS) |

---

## Next step

When you want recent-version research and uplift recommendations, hand me `docs/dependency-tiers.json` and I'll use firecrawl / npm registry queries to compare `installed_version` against the latest, read release notes, and flag breaking changes — prioritized by tier.
