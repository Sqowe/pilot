<p align="center">
  <img src="resources/logo.png" alt="Sqowe Pilot Logo" width="280" />
</p>

<h1 align="center">🚀 Sqowe Pilot: Your Personal AI Agent Desktop App</h1>

<p align="center">
  • Open Source Claude Cowork • One-Click Install 
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#demo">Demo</a> •
  <a href="#installation">Downloads</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#skills">Skills Library</a> •
  <a href="#-mcp-subsystem">MCP</a> •
  <a href="#-memory-subsystem">Memory</a> •
  <a href="#sqowe-specific-features">Sqowe Features</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/Node.js-24+-brightgreen" alt="Node.js" />
  <a href="https://discord.gg/pynjtQDf"><img src="https://img.shields.io/discord/1493588403260883078?logo=discord&label=Discord&color=5865F2" alt="Discord" /></a>
</p>

---

Sqowe Pilot is a free, open-source AI agent desktop application for Windows and macOS. It wraps Claude Code, OpenAI, Gemini, DeepSeek, and other AI models into a user-friendly GUI with one-click installation — no coding required. Key capabilities include VM-level sandbox isolation (WSL2 on Windows, Lima on macOS), a built-in Skills system for generating PPTX, DOCX, XLSX, and PDF documents, MCP (Model Context Protocol) integration for connecting to browsers, Notion, and other desktop apps, GUI automation via computer use, and remote control through Feishu (Lark) and Slack. Sqowe Pilot is the open-source implementation of Claude Cowork, designed to make AI-powered desktop automation accessible to everyone.

---

## 📖 Introduction

**Sqowe Pilot** is an open-source implementation of **Claude Cowork**, with one-click installers for **Windows** and **macOS**—no coding required.

It provides a sandboxed workspace where AI can manage files, generate professional outputs (PPTX, DOCX, XLSX, etc.) through our built-in **Skills** system, and **connect to desktop apps via MCP** (browser, Notion, etc.) for better collaboration.

> [!WARNING]
> **Disclaimer**: Sqowe Pilot is an AI collaboration tool. Please exercise caution with its operations, especially when authorizing file modifications or deletions. We support VM-based sandbox isolation, but some operations may still carry risks.

---

<a id="features"></a>

## ✨ Key Features

|               | MCP & Skills | Remote Control | GUI Operation |
| ------------- | ------------ | -------------- | ------------- |
| Claude Cowork | ✓            | ✗              | ✗             |
| OpenClaw      | ✓            | ✓              | ✗             |
| Sqowe Pilot   | ✓            | ✓              | ✓             |

- **One-Click Install, Ready to Use**: Pre-built installers for Windows and macOS, no environment setup needed—just download and start using.
- **Flexible Model Support**: Supports **Claude**, **OpenAI-compatible APIs**, and Chinese models like **GLM**, **MiniMax**, **Kimi**. Use your OpenRouter, Anthropic, or other API keys with flexible configuration. A searchable provider/model picker is backed by the live pi-ai registry, and a **per-model Thinking Level** selector exposes exactly the reasoning effort each model supports. More models coming soon!
- **HTTP Proxy Support**: Route model API requests through a corporate or egress proxy (Settings → General).
- **Remote Control**: Connect to collaboration platforms like **Feishu (Lark)** and other remote services to automate workflows and cross-platform operations.
- **GUI Operation**: Control and interact with various desktop GUI applications on your computer. **Recommended model: Gemini-3-Pro** for optimal GUI understanding and control.
- **Smart File Management**: Read, write, and organize files within your workspace.
- **Cross-Session Memory**: The agent remembers across conversations — stable preferences are always present, and past sessions are retrieved on demand rather than dumped into every prompt. Stored in SQLite, with embeddings that run offline and in-process by default. Settings → Memory reports how much of the store is actually searchable by meaning, and fills the gaps on request.
- **Skills System**: Built-in workflows for PPTX, DOCX, PDF, XLSX generation and processing. **Supports custom skill creation and deletion.** Workspace profiles let you disable unused skills per-project, and conflict resolution handles name collisions between custom and built-in skills automatically.
- **Task Scheduling**: Anacron-style in-app task scheduling with fuzzy time windows (morning/afternoon/evening/night), autonomous execution mode, missed-task catch-up policies, per-run token/time budgets, and full run history tracking.
- **MCP External Service Support**: Integrate browser, Notion, custom apps and more through **MCP Connectors** to extend AI capabilities. **Per-session toggle** lets you disable unused servers on-the-fly to reclaim context window tokens.
- **Skill Pinning**: Star specific skills to tell the AI "use these for this session" — no more manually typing tool instructions every time.
- **Plugin System**: Install plugin bundles from the Claude marketplace or local `.plugin`/`.zip` archives. Plugins group multiple skills into a coherent unit with automatic orchestrator detection. Pin entire plugins to inject compact directives into the system prompt (~60-80 tokens vs ~1480 for individual skills), bypassing the 10-skill pinning cap.
- **Skill Workspace Profiles**: Remove unused skills from sessions to save context window tokens. Skills have three states — Pinned (prioritized), Available (normal), and Removed (disabled). State persists via `.cowork/skills-profile.json` for per-project defaults. Configure on the Welcome page or toggle mid-conversation from the Context Panel.
- **Skill Conflict Resolution**: When custom and built-in skills share the same name, a policy engine determines which version loads. Choose "Custom wins", "Built-in wins", or "Ask me each time". Per-skill overrides and a conflict badge in Settings give full control.
- **Multimodal Input**: Drag & drop files and images directly into the chat input for seamless multimodal interaction.
- **Real-time Trace**: Watch AI reasoning and tool execution in the Trace Panel.
- **Secure Workspace**: All operations confined to your chosen workspace folder.
- **VM-Level Isolation**: WSL2 (Windows) and Lima (macOS) VM isolation—all commands execute in an isolated VM to protect your host system.
- **UI Enhancements**: Beautiful and flexible UI design, system language switching, comprehensive MCP/Skills/Tools call display.

<a id="demo"></a>

## 🎬 Demo

See Sqowe Pilot in action:

### 1. Folder Organization & Cleanup 📂

https://github.com/user-attachments/assets/dbeb0337-2d19-4b5d-a438-5220f2a87ca7

### 2. Generate PPT from Files 📊

https://github.com/user-attachments/assets/30299ded-0260-468f-b11d-d282bb9c97f2

### 3. Generate XLSX Spreadsheets 📉

https://github.com/user-attachments/assets/f57b9106-4b2c-4747-aecd-a07f78af5dfc

### 4. GUI Operation🖥

https://github.com/user-attachments/assets/75542c76-210f-414d-8182-1da988c148f2

### 5. Remote control with Feishu(Lark) 🤖

https://github.com/user-attachments/assets/05a703de-c0f5-407b-9a43-18b6a172fd74

---

<a id="installation"></a>

## 📦 Installation

### Option 1: Download Installer

Get the latest version from our [Releases Page](https://github.com/sqowe/pilot/releases).

| Platform                              | File Type |
| ------------------------------------- | --------- |
| **Windows** (64-bit)                  | `.exe`    |
| **macOS 13 or later** (Apple Silicon) | `.dmg`    |

The macOS app is not notarized by Apple. The first time you open a downloaded copy,
macOS blocks it: go to **System Settings → Privacy & Security** and click
**Open Anyway**.

### Option 2: Build from Source

For developers who want to contribute or modify the codebase:

```bash
git clone https://github.com/sqowe/pilot.git sqowe-pilot
cd sqowe-pilot
npm install
npm run dev
```

To build the installer locally: `npm run build`

### Security Configuration: 🔒 Sandbox Support

Sqowe Pilot provides **multi-level sandbox protection** to keep your system safe:

| Level        | Platform | Technology | Description                                    |
| ------------ | -------- | ---------- | ---------------------------------------------- |
| **Basic**    | All      | Path Guard | File operations restricted to workspace folder |
| **Enhanced** | Windows  | WSL2       | Commands execute in isolated Linux VM          |
| **Enhanced** | macOS    | Lima       | Commands execute in isolated Linux VM          |

- **Windows (WSL2)**: When WSL2 is detected, all Bash commands are automatically routed to a Linux VM. The workspace is synced bidirectionally.
- **macOS (Lima)**: When [Lima](https://lima-vm.io/) is installed (`brew install lima`), commands run in an Ubuntu VM with `/Users` mounted.
- **Fallback**: If no VM is available, commands run natively with path-based restrictions.

**Setup (Optional, Recommended)**

- **Windows**: WSL2 is auto-detected if installed. [Install WSL2](https://docs.microsoft.com/en-us/windows/wsl/install)

- **macOS**:
  Lima is auto-detected if installed. Install command:

```bash
brew install lima
# Sqowe Pilot will automatically create and manage a 'claude-sandbox' VM
```

---

<a id="quick-start"></a>

## 🚀 Quick Start Guide

### 1. Get an API Key

You need an API key to power the agent. We support **OpenRouter**, **Anthropic**, and various cost-effective **Chinese Models**.

| Provider           | Get Key / Coding Plan                                                      | Base URL (Required)                      | Recommended Model    |
| ------------------ | -------------------------------------------------------------------------- | ---------------------------------------- | -------------------- |
| **OpenRouter**     | [OpenRouter](https://openrouter.ai/)                                       | `https://openrouter.ai/api`              | `claude-4-5-sonnet`  |
| **Anthropic**      | [Anthropic Console](https://console.anthropic.com/)                        | (Default)                                | `claude-4-5-sonnet`  |
| **Zhipu AI (GLM)** | [GLM Coding Plan](https://bigmodel.cn/glm-coding) (⚡️Chinese Deal)         | `https://open.bigmodel.cn/api/anthropic` | `glm-4.7`, `glm-4.6` |
| **MiniMax**        | [MiniMax Coding Plan](https://platform.minimaxi.com/subscribe/coding-plan) | `https://api.minimaxi.com/anthropic`     | `minimax-m2`         |
| **Kimi**           | [Kimi Coding Plan](https://www.kimi.com/membership/pricing)                | `https://api.kimi.com/coding/`           | `kimi-k2`            |

### 2. Configure

1. Open the app and click the ⚙️ **Settings** icon in the bottom left.
2. On the **Providers** tab, find your provider, click **Configure**, paste your **API Key** and save. For a service the list does not have, click **Add endpoint** and enter its **Base URL** from the table above.
3. On the **Model Sets** tab, choose that provider and the **Model** you want to use, then click **Save Settings**.

If you send a message before this is done, a notice offers **Open API Settings**: a two-step dialog that asks for the same two things — a provider and its key, then a model.

### 3. Start Coworking

1. **Select a Workspace**: Choose a folder where Claude is allowed to work.
2. **Enter a Prompt**:
   > "Read the financial_report.csv in this folder and create a PowerPoint summary with 5 slides."

### 📝 Important Notes

1.  **macOS Installation**: If you see a security warning after opening the DMG, go to **System Settings > Privacy & Security** and click **Open Anyway**.
2.  **Network Access**: For tools like `WebSearch`, you may need to enable "Virtual Network Interface" (TUN Mode) in your proxy settings to ensure connectivity.
3.  **Notion Connector**: Besides setting the integration token, you also need to add connections in a root page. See https://www.notion.com/help/add-and-manage-connections-with-the-api for more details.

---

<a id="skills"></a>

## 🧰 Skills Library

Sqowe Pilot ships with built-in skills under `resources/skills/`, and supports user-added or custom skills, including:

- `pptx` for PowerPoint generation
- `docx` for Word document processing
- `pdf` for PDF handling and forms
- `xlsx` for Excel spreadsheet support
- `skill-creator` for creating custom skills

### Built-in Skill Auto-Update

Built-in skills are automatically kept in sync with app updates using content-hash versioning. When you install a new version of Sqowe Pilot:

1. Each bundled skill's `SKILL.md` is hashed (SHA-256)
2. The hash is compared against the runtime copy's `.builtin-hash` stamp
3. If the hash differs (or no stamp exists), the runtime copy is replaced with the fresh bundled version
4. Skills that haven't changed are left untouched — no unnecessary I/O

This means app updates reliably deliver skill improvements without requiring manual cache clearing or reinstallation.

### Protecting Customized Skills

If you've modified a built-in skill and want to prevent it from being overwritten on app updates, create a `.user-modified` marker file inside the skill's runtime directory:

```bash
# macOS
touch ~/Library/Application\ Support/sqowe-pilot/claude/skills/docx/.user-modified

# Windows
type nul > "%APPDATA%\sqowe-pilot\claude\skills\docx\.user-modified"
```

When the marker is present, the auto-update will skip that skill and log a warning instead. To resume receiving updates, simply delete the `.user-modified` file.

---

<a id="sqowe-specific-features"></a>

## 🔧 Sqowe-Specific Features

This is the **Sqowe** variant of Sqowe Pilot. It tracks upstream functionality and adds the following on top:

- **Bash Command Restrictions**: A configurable allow/deny engine that gates every bash command the agent runs. Trusted patterns run automatically, denied patterns always prompt, and everything else requires explicit approval. See [BASH_COMMAND_RESTRICTIONS.md](BASH_COMMAND_RESTRICTIONS.md) for configuration details, pattern syntax, and edge cases.
- **Configurable Permission Timeout**: Permission dialogs auto-deny after a configurable timeout (default: 5 minutes). Set to 0 for infinite wait. Configurable in Settings → Bash Commands.
- **Customizable System Prompt**: The AI's system prompt is fully editable via Settings → System Prompt. Each section (identity, behavioral rules, citations, tool routing) is a separate file that can be independently edited, disabled, or reset. Workspace-level overrides in `.cowork/prompts/` replace global sections per-project. Template variables (`{{cwd}}`, `{{project_name}}`, `{{date}}`, `{{model}}`) are resolved at runtime.
- **Per-Session MCP Server Toggle**: Disable/enable MCP servers on-the-fly from the Context Panel without restarting the session. Reduces context window token usage by shedding unused tool schemas mid-conversation. Supports workspace-level profiles via `.cowork/mcp-servers.json` (committable to git) for team-wide defaults.
- **Skill Pinning**: Star/pin specific skills (semantic-index, firecrawl, docx, etc.) to explicitly tell the AI to prioritize them for the current session. All skills remain available — pinning adds emphasis, not restriction. Select skills on the Welcome screen before starting a chat, or pin/unpin mid-conversation from the Context Panel. Enforces a max of 10 pinned skills per session with full validation.
- **Skill Workspace Profiles**: Disable unused skills per-session to reduce context window usage. Three-layer resolution: Session > Workspace profile (`.cowork/skills-profile.json`) > Global config. Welcome page loads the workspace profile automatically and shows three skill states (★ Pinned, ☆ Available, ✕ Removed). Context Panel supports mid-conversation remove/restore with a 💾 save button to persist changes. New sessions immediately respect the workspace profile.
- **Skill Conflict Resolution**: Policy engine for resolving name collisions between custom and built-in skills. Three policies: `custom-wins` (recommended), `builtin-wins`, or `ask` (notification + manual choice). Per-skill source overrides, global disable toggles, conflict count badge in Settings sidebar, and toast notifications on new conflicts. Managed via Settings → Skills.

---

## 🔌 MCP Subsystem

Sqowe Pilot integrates [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) to connect the AI agent with external tools and services — browsers, databases, Notion, custom APIs, and more. MCP servers run on the host machine and their tools are bridged into the agent's tool dispatch layer as first-class capabilities.

### Transport Types

| Transport           | Use Case                                    | Example                         |
| ------------------- | ------------------------------------------- | ------------------------------- |
| **stdio**           | Local CLI tools, spawned as child processes | Firecrawl, Context7, filesystem |
| **SSE**             | Remote servers with HTTP streaming          | Self-hosted services            |
| **Streamable HTTP** | Modern remote servers (MCP 2025+)           | Cloud-hosted MCP endpoints      |

### Server Descriptions (Auto-Generated LLM Routing)

When multiple MCP servers are connected, the LLM sees a flat list of tools named `mcp__<ServerName>__<toolName>`. Without additional context, it can struggle to pick the right server for a task. Sqowe Pilot solves this with **server-level descriptions** — concise summaries of what each server does, injected into the system prompt as a routing map.

**How it works:**

1. **Auto-generation on first connect** — When a server's tools are discovered for the first time, Sqowe Pilot generates a description using the user's configured LLM (one-shot call, ~150–300 input tokens, negligible cost). The prompt asks for a single sentence (max 25 words) describing the server's domain and capabilities.

2. **Heuristic fallback** — If no LLM is available (no API key configured, network error), a template-based summary is generated from tool names and descriptions. Examples:
   - Firecrawl → `"Web scraping, crawling, search, and structured data extraction from websites."`
   - Context7 → `"Library and framework documentation lookup with version-specific code examples."`
   - A generic server → `"My Server (8 tools)"`

3. **MCP Server Directory in system prompt** — All descriptions are assembled into a `<mcp_server_directory>` block injected into the agent's system prompt:

   ```
   Available MCP servers and their capabilities:
   - Firecrawl: Web scraping, crawling, search, and structured data extraction from websites.
   - Context7: Library and framework documentation lookup with version-specific code examples.
   - Software_Development: File system operations, code search, and project workspace management.

   Use the appropriate server's tools based on the task domain.
   ```

   Token cost: ~15–25 tokens per server (negligible compared to tool schemas themselves).

4. **Change detection** — A SHA-256 hash of the tool list (names + descriptions) is stored alongside the description. When tools change (server update, new tools added), the system detects the mismatch and notifies the user — it never silently overwrites.

5. **User control** — Descriptions can be manually edited at any time. The system tracks whether a description is `auto` (generated) or `manual` (user-written). Manual descriptions suppress stale-tool notifications, since the user wrote them intentionally.

**UI actions:**

- **Edit** — Make the description field editable, sets source to `manual` on save
- **Regenerate** — Re-run LLM one-shot, replaces description, source stays `auto`
- **Dismiss** — Acknowledge tool changes without regenerating (keeps current description)

### Per-Session & Per-Workspace Server Toggle

MCP tool schemas consume significant context window tokens. To optimize usage, servers can be selectively disabled at three levels (highest priority wins):

1. **Session override** (ephemeral) — Toggle in the Context Panel mid-conversation. Stored in-memory, cleared on session delete.
2. **Workspace profile** — `.cowork/mcp-servers.json` with `disabled`/`enabled` arrays. Committable to git for team-wide defaults.
3. **Global config** — Per-server `enabled` boolean in Settings UI.

**Save to Workspace button** — The MCP Connectors section header includes a 💾 save icon that appears when you have session-disabled servers and a working directory set. Clicking it writes the current session toggle state to `.cowork/mcp-servers.json`, making your MCP setup persistent and shareable with your team via git.

**Workspace profile example** (`.cowork/mcp-servers.json`):

```json
{
  "disabled": ["firecrawl", "gui-operate"],
  "enabled": ["context7"]
}
```

- Servers in `disabled` are excluded from the session (overrides global enabled state)
- Servers in `enabled` are explicitly included (overrides the `disabled` list)
- Servers not mentioned in either array pass through unchanged — their global config `enabled` state is preserved as-is (globally enabled → stays enabled, globally disabled → stays disabled)
- Accepts both server IDs (`mcp-1716547200000`) and display names (`"EU Law"`) — the resolver matches against both

### Configuration

MCP servers are configured in the app's Settings panel. Each server entry includes:

- **Name** — Display name (used in tool prefixes)
- **Type** — `stdio`, `sse`, or `streamable-http`
- **Command/URL** — How to connect (command + args for stdio, URL for HTTP-based)
- **Environment variables** — Passed to stdio processes
- **Description** — Auto-generated or manually written routing hint
- **Enabled** — Global on/off toggle
- **Tool timeout** — Per-server timeout override (0 = use global default)
- **Tool permissions** — Per-server default policy + per-tool overrides

### Tool Permissions

Each MCP server supports a default tool permission policy to reduce "permission fatigue":

| Policy        | Behavior                                                                        |
| ------------- | ------------------------------------------------------------------------------- |
| `ask-all`     | Every tool requires manual approval (default)                                   |
| `allow-reads` | Read-only tools (get*\*, list*\_, search\_\_) auto-approved; write tools prompt |
| `allow-all`   | All tools auto-approved without prompting                                       |
| `deny-all`    | All tools blocked                                                               |

Per-tool overrides let you make exceptions (e.g., allow-reads but always ask for `capture_realtime_ws`).

**Workspace-level policies** can be shared via `.cowork/mcp-permissions.json`:

```json
{
  "EODHD": {
    "defaultPolicy": "allow-reads",
    "overrides": {
      "execute_trade": "deny",
      "capture_realtime_ws": "ask"
    }
  }
}
```

**Progressive trust:** The system tracks manual approvals per tool. After 5 approvals of the same tool, it suggests promoting it to permanent auto-allow.

Key files: `src/main/mcp/mcp-manager.ts`, `src/main/mcp/mcp-config-store.ts`, `src/main/mcp/mcp-tool-permissions.ts`, `src/main/mcp/mcp-description-generator.ts`.

---

## 🧠 Memory Subsystem

Sqowe Pilot includes a two-layer memory system that persists knowledge across sessions. The agent accumulates learnings from past conversations and uses them to provide better, more contextual responses in future sessions.

### How It Works

Memory uses a **passive + active** architecture:

- **Core memory** (preferences, identity) is passively injected into every prompt
- **Experience memory** (past conversations) is actively retrieved on-demand via tools the model can call

```
User sends message
       │
       ▼
Memory Extension (beforeSessionRun)
       │
       ├─ 1. Inject core memory into prompt (passive, always present)
       ├─ 2. Register search_workspace_chats tool (active, on-demand)
       ├─ 3. Register read_workspace_chat tool (active, on-demand)
       │
       ▼
LLM receives: core_memory context + workspace chat search tools
       │
       ▼
LLM decides: "Do I need context from past conversations?"
       │ YES                              │ NO
       ▼                                  ▼
tool_call: search_workspace_chats    Respond directly
       │
       ▼
Workspace-scoped results from experience memory
       │
       ▼
(optional) tool_call: read_workspace_chat for full details
       │
       ▼
LLM synthesizes answer with retrieved context
       │
       ▼
Memory Extension (afterSessionRun)
       │
       ├─ Extract reusable chunks from the conversation
       ├─ Update core memory if stable preferences were revealed
       │
       ▼
Done — knowledge persisted for future sessions
```

### Two Levels of Memory

**Core Memory** — stable user profile (passively injected every turn)

Stores durable information that persists across all sessions and workspaces:

- Identity: role, background, recurring context
- Preferences: communication style, workflow, tools
- Skills: competencies, toolchains, strengths
- Interests: recurring domains and deep topics

Core memory is small (typically <20 entries) and updated conservatively. Only information with strong evidence of being stable across time gets stored here. It's always present in the prompt — no tool call needed.

**Experience Memory** — past session knowledge (actively retrieved via tools)

Stores reusable work units extracted from past conversations:

- Goals the user was trying to accomplish
- Decisions and their rationale
- Implementation choices and important steps
- Constraints, caveats, failure modes, tradeoffs
- Concrete outcomes and unresolved follow-ups

Each session produces 1–8 chunks, each with an embedding vector for semantic search. The model retrieves these on-demand using `search_workspace_chats` when it needs context from prior sessions — for example, when the user references a past decision or asks to continue previous work.

### Active Retrieval Tools

The model has two workspace-scoped tools for searching past conversations:

| Tool                     | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `search_workspace_chats` | Search past conversations by natural language query |
| `read_workspace_chat`    | Read full details of a specific search result       |

These tools are workspace-scoped by default — they search only conversations from the current project. The model decides autonomously when to use them based on the user's question.

### Why Active Over Passive for Experience Memory

The previous approach pre-injected experience memory into every prompt. The active approach is better because:

- **Saves context window** — no tokens wasted on irrelevant past conversations
- **Model decides relevance** — the model is a better judge of what it needs than a one-shot pre-query
- **Iterative refinement** — model can search multiple times, refining its query
- **Provenance** — model explicitly knows what came from past conversations vs current context
- **No false confidence** — model won't accidentally treat injected memory as current-session facts

### Retrieval Scoring

Experience memory is ranked using a hybrid scoring algorithm:

| Signal                         | Description                                                   |
| ------------------------------ | ------------------------------------------------------------- |
| Vector similarity              | Cosine similarity between query embedding and chunk embedding |
| Lexical score                  | Keyword overlap between query and chunk text                  |
| Workspace boost (+0.3)         | Chunks from the same workspace rank higher                    |
| Recency boost (+0.02 to +0.08) | Newer chunks get a small boost (decays over 45 days)          |

### Search Scope

- **Core memory** is always global — included regardless of workspace
- **Experience memory** (via tools) is workspace-scoped by default — searches only conversations from the current project directory

### Progressive Retrieval

The system uses a multi-step retrieval process:

1. **Broad summaries** — initial ranked list of chunk/session summaries
2. **Navigator decision** — a lightweight LLM call decides if more detail is needed
3. **Expansion** — specific chunks or sessions are expanded (details, raw text, or full transcript)
4. **Repeat** — up to `maxNavSteps` iterations until the navigator deems context sufficient

This avoids injecting too much irrelevant context while ensuring important details are available when needed.

### Storage

Memory data lives at `~/Library/Application Support/sqowe-pilot/memory/` (macOS):

| File                 | Contents                                             |
| -------------------- | ---------------------------------------------------- |
| `core_memory.json`   | Stable user profile (interests, preferences, skills) |
| `memory.db`          | Session summaries, chunks, and embeddings (SQLite)   |
| `session_state.json` | Tracks which sessions have been ingested             |

Experience memory used to be a single `experience_memory.json`, which was rewritten in full on
every ingest and re-parsed in full on every read. It now lives in a SQLite database. **The
migration is automatic**: on first launch the JSON is copied into `memory.db` in one transaction
and then renamed to `experience_memory.json.bak`, which is kept as a rollback artefact. No action
is required, and nothing is deleted.

Because `memory.db` is a binary file, **Settings → Memory → Memory Storage** shows a status card
for it instead of a raw dump — schema version, size, session/chunk counts, embedding model,
integrity, and a per-workspace breakdown — with **Export JSON** (a full-fidelity backup in the old
`{ sessions, chunks }` shape) and **Vacuum** (reclaim space after clearing). The other entries are
still plain JSON and open in the raw viewer as before.

### Local Embeddings (Default)

By default, memory embeddings run **fully offline and in-process** via ONNX (EmbeddingGemma-300M through transformers.js) — no Python, no API key, and no data leaves your machine. The model downloads once on first use. Switch to a remote embedding provider in **Settings → Memory** if you prefer.

**Switching the embedding model invalidates stored vectors.** Similarity is only meaningful within a single model's embedding space, so comparing a fresh query against vectors built by a different model returns noise rather than matches. Sqowe Pilot detects the mismatch and falls back to keyword-only retrieval — degraded, but never wrong — and offers to recompute the vectors. Until then, search keeps working without semantic ranking.

**Embedding coverage** is shown in **Settings → Memory**: how many stored chunks actually carry a vector. Records without one are still found by keyword, just not by meaning — a distinction that is otherwise invisible, since ingestion itself succeeds either way. The card turns amber when records are missing vectors, and red with the reason when an embedding call failed.

**Backfill embeddings**, on that card, fills the gaps. It computes vectors for records already in the database — including ones embedded with a previously-configured model — and is much cheaper than **Rebuild all**: the text a vector is built from is already stored, so no LLM extraction runs and nothing is deleted. Progress is reported per record, and an interrupted run resumes where it stopped. Reach for Rebuild all only when the extracted summaries themselves need redoing.

### Configuration

Memory is enabled by default. Toggle it in **Settings → Memory** or via the Memory panel in the sidebar. Disabling memory stops future ingestion and auto-recall but keeps existing records intact.

When in-app memory is enabled, the legacy `cowork-memory` skill (manual Python scripts) is automatically disabled to avoid redundancy. If you disable in-app memory, the skill is re-enabled as a fallback.

### Memory Sources Indicator (UI)

When the model uses `search_workspace_chats` to retrieve context from past conversations, a visual indicator appears at the top of the response:

- **Simple case** (core memory only): `🧠 Memory contributed to this response`
- **Active search** (workspace chats searched): `🧠 Referenced N past conversation(s) from this workspace` — clickable to expand a list of referenced sessions with titles and summaries

This indicator is positioned above the response content (not below) because:

- It frames the response as grounded in prior context before you read it
- It reflects the actual action order (search happened before generation)
- It builds trust by signaling provenance upfront

The expanded sources list shows which specific past conversations were referenced, giving full transparency into what the model "remembered."

---

## 🏗️ Architecture

```
sqowe-pilot/
├── src/
│   ├── main/                    # Electron Main Process (Node.js)
│   │   ├── index.ts             # Main entry point
│   │   ├── claude/              # Agent SDK & Runner
│   │   │   └── agent-runner.ts  # AI agent execution logic
│   │   ├── config/              # Configuration management
│   │   │   └── config-store.ts  # Persistent settings storage
│   │   ├── db/                  # Database layer
│   │   │   └── database.ts      # SQLite/data persistence
│   │   ├── ipc/                 # IPC handlers
│   │   ├── memory/              # Memory management
│   │   │   └── memory-manager.ts
│   │   ├── sandbox/             # Security & Path Resolution
│   │   │   └── path-resolver.ts # Sandboxed file access
│   │   ├── session/             # Session management
│   │   │   └── session-manager.ts
│   │   ├── schedule/            # Task scheduling (v2)
│   │   │   └── scheduled-task-manager.ts
│   │   ├── skills/              # Skill Loader & Manager
│   │   │   └── skills-manager.ts
│   │   └── tools/               # Tool execution
│   │       └── tool-executor.ts # Tool call handling
│   ├── preload/                 # Electron preload scripts
│   │   └── index.ts             # Context bridge setup
│   └── renderer/                # Frontend UI (React + Tailwind)
│       ├── App.tsx              # Root component
│       ├── main.tsx             # React entry point
│       ├── components/          # UI Components
│       │   ├── ChatView.tsx     # Main chat interface
│       │   ├── ConfigModal.tsx  # First-run setup wizard
│       │   ├── ContextPanel.tsx # File context display
│       │   ├── MessageCard.tsx  # Chat message component
│       │   ├── PermissionDialog.tsx
│       │   ├── SettingsPanel.tsx # Settings (tabs in settings/)
│       │   ├── Sidebar.tsx      # Navigation sidebar
│       │   ├── Titlebar.tsx     # Custom window titlebar
│       │   ├── TracePanel.tsx   # AI reasoning trace
│       │   └── WelcomeView.tsx  # Onboarding screen
│       ├── hooks/               # Custom React hooks
│       │   └── useIPC.ts        # IPC communication hook
│       ├── store/               # State management
│       │   └── index.ts
│       ├── styles/              # CSS styles
│       │   └── globals.css
│       ├── types/               # TypeScript types
│       │   └── index.ts
│       └── utils/               # Utility functions
├── .claude/
│   └── skills/                  # Default Skill Definitions
│       ├── pptx/                # PowerPoint generation
│       ├── docx/                # Word document processing
│       ├── pdf/                 # PDF handling & forms
│       ├── xlsx/                # Excel spreadsheet support
│       └── skill-creator/       # Skill development toolkit
├── resources/                   # Static Assets (icons, images)
├── electron-builder.yml         # Build configuration
├── vite.config.ts               # Vite bundler config
└── package.json                 # Dependencies & scripts
```

---

## 🗺️ Roadmap

See our full **[ROADMAP.md](ROADMAP.md)** for detailed plans.

**Completed:** Core installers · Filesystem sandboxing · VM isolation (WSL2/Lima) · Skills (PPTX/DOCX/PDF/XLSX) · Skill conflict resolution · Skill workspace profiles · MCP connectors · Multi-model support · Rich input · i18n · Task scheduling (v2) · Cross-session memory (local embeddings) · Per-model thinking levels · HTTP proxy · Plugin system · Computer use

**Coming next:** Linux support · Stable release

---

## ❓ FAQ

**What is Sqowe Pilot?**
Sqowe Pilot is a free, open-source desktop application that provides a local AI agent workspace. It wraps AI models (Claude, GPT, Gemini, DeepSeek, etc.) into a GUI with one-click installers for Windows and macOS — no terminal or coding knowledge required.

**How is Sqowe Pilot different from Claude Cowork?**
Sqowe Pilot is the open-source implementation of Claude Cowork. It adds multi-model support (not just Claude), GUI automation via computer use, remote control through Feishu/Slack, and VM-level sandbox isolation. See the [feature comparison table](#features) for details.

**What AI models does Sqowe Pilot support?**
Claude (via Anthropic or OpenRouter), OpenAI-compatible APIs, and Chinese models including GLM (Zhipu AI), MiniMax, and Kimi. Any provider offering an OpenAI-compatible API endpoint can be configured.

**Is Sqowe Pilot free?**
Yes. Sqowe Pilot itself is completely free and open-source under the MIT license. You only need to pay for the AI model API usage from your chosen provider.

**Does Sqowe Pilot work on Linux?**
Currently, Sqowe Pilot provides pre-built installers for Windows and macOS only. Linux users can build from source — see the [Build from Source](#installation) section.

**How does sandbox isolation work?**
Sqowe Pilot offers multi-level protection: basic path-based restrictions on all platforms, and enhanced VM-level isolation using WSL2 (Windows) or Lima (macOS). When a VM is available, all commands execute inside an isolated Linux environment, protecting your host system.

**What are Skills and how do I create custom ones?**
Skills are built-in workflows for specific tasks like generating PPTX, DOCX, PDF, or XLSX files. Sqowe Pilot ships with default skills under `resources/skills/` and includes a `skill-creator` tool to help you build your own custom skills.

**What is MCP and how does it work?**
MCP (Model Context Protocol) lets AI connect to external tools and services. Sqowe Pilot supports MCP connectors for browsers, Notion, and other desktop apps — extending the AI's capabilities beyond just file management and code.

**How do I set up remote control via Feishu or Slack?**
Sqowe Pilot supports remote control through Feishu (Lark) and Slack integration, allowing you to send commands and receive results from collaboration platforms. Check the app settings for remote control configuration.

**Is my data safe? Does Sqowe Pilot send data to external servers?**
Sqowe Pilot runs locally on your machine. Your files stay in your workspace. The only external communication is with the AI model API you configure (e.g., Anthropic, OpenRouter). No data is sent to Sqowe Pilot servers.

---

## 🛠️ Contributing

We welcome contributions! Whether it's a new Skill, a UI fix, or a security improvement:

1. Fork the repo.
2. Create a branch (`git checkout -b feature/NewSkill`).
3. Submit a PR.

---

## 💬 Community

Join our community for support and discussion:

- **Discord**: [Join our Discord server](https://discord.gg/pynjtQDf) — for real-time chat, support, and development discussion.

---

## Attribution

Sqowe Pilot is a fork of [Open Cowork](https://github.com/OpenCoworkAI/open-cowork),
originally released under the MIT License. The original copyright and license are retained
in [LICENSE](./LICENSE). Sqowe Pilot has since diverged substantially — see
[docs/SQOWE_PILOT_VS_OPEN_COWORK.md](./docs/SQOWE_PILOT_VS_OPEN_COWORK.md).

---

## 📄 License

MIT © Sqowe Pilot Team

---

<p align="center">
  Made with ❤️ by the Sqowe Pilot Team with the help of opus4.5
</p>
