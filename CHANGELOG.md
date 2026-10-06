# Changelog

All notable changes to the Sqowe Pilot AI agent desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.9] - 2026-10-06

### Changed

- **Where API keys are stored.** Keys and base URLs are now kept once per provider, and
  custom endpoints as a list of their own, instead of inside each config set. Existing
  settings are converted on the first start; config sets, their names, models and thinking
  levels are kept as they are. Where two config sets held different keys for the same
  provider, one key is kept — the active set's first.
  The conversion is one-way: if an older version of the app (1.0.8 or earlier) is started
  afterwards, it will not find the keys, and they have to be entered again there.
- **Settings → API Settings is now two tabs.** _Providers_ is where keys are entered: your
  custom endpoints as a list, each with a name of its own, and the key of every catalog
  provider. _Model Sets_ is where a config set chooses what it runs on — any provider, or
  one of your custom endpoints by name — and which model. Two custom endpoints can now be
  told apart and chosen between; before, both were just "Custom". An endpoint shows which
  config sets use it and cannot be deleted while one does.
- **A key can be tried before it is saved.** Both dialogs on the Providers tab have a
  connection check that runs against what is typed, saved or not, and says which model it
  tries. The custom-endpoint dialog has the ready-made setups and the hints under protocol
  and address again; an address that belongs to a provider the app lists itself —
  OpenRouter, Ollama, Gemini, Kimi Coding — is pointed at that provider's own entry. The
  Ollama dialog can find a server on this computer. Enter saves a dialog.
- **A key that was not kept is shown.** Where the conversion kept one key out of several
  (see above), the Providers tab says so on that provider or endpoint and names the config
  sets that had a different one. Saving the entry again confirms the key it has.
- **Config-set pickers show the model.** In the chat header and on the welcome screen a
  config set is listed as "name · model".
- Two custom endpoints on one host — a local gateway reached through two protocols — no
  longer get the same default name: the second is named with its protocol, for example
  `127.0.0.1:9000 (OpenAI)`. Names that already exist are not changed.

### Fixed

- An edit to the **Context window** or **Max output tokens** field in Settings → API now
  counts as an unsaved change. Before, a form that differed only there looked saved, so
  switching to another config set dropped the edit without asking.
- A config set on OpenRouter that still held a Claude model id in an older spelling
  (`anthropic/claude-sonnet-4-5`) is now stored in the current one (`…-4.5`), so a chat runs
  on the id that Settings shows. An id that ends in a date (`…-4-20250514`) is left as typed;
  before, opening Settings rewrote it.

## [1.0.8] - 2026-10-05

### Added

- **Trusted directories.** Settings → Bash Commands has a third list: the directories the
  agent may write to without being asked (for example `./` for the session's workspace, and
  `/tmp`). A write inside them runs; a write anywhere else asks. It covers the `write` and
  `edit` tools and the places a shell command visibly writes — output redirections and `tee`.
  For shell commands it only adds a condition: a command still has to pass the trusted and
  denied lists. Empty list = off, which is the default. The same setting works in the
  standalone `pi` extension (`trustedDirectories` in `bash-restrictions.json`), where
  `write` and `edit` otherwise run with no prompt at all.
  This is a check of visible writes, **not a sandbox**: what a program writes on its own
  cannot be seen. The home directory and the file-system root are not accepted as entries,
  and the permission settings files themselves always ask.
- The approval dialog now says **why** it appeared: which denied word matched, which part of
  the command is not on the trust list, what syntax could not be checked, or which path lies
  outside the trusted directories.

### Changed

- **Updated the pi SDK from 0.85.1 to 0.87.1** (`@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent`), six releases. No source change was required. The
  practical gain is model coverage: Claude Opus 5.5, GPT-6 Sol and GPT-6 Luna become
  selectable on the providers that carry them, Anthropic's Opus 5.5 with adaptive thinking
  and a 1M context window, and new xAI sessions now default to Grok 4.7.
  Six breaking changes ship in this range and none reaches this app, because all of them
  land on surfaces it does not use: the removed `shouldStopAfterTurn` agent option, the
  `ContextEditEntry` addition to the `SessionEntry` union, the expanded `TurnEndEvent` and
  `ExtensionEvent` unions, `user_bash` failing closed, the custom-provider switch from
  `Context` to `TranscriptContext`, and the narrowing of `ToolCall.arguments` /
  `ToolResultMessage.details` to JSON-compatible values. This app imports only
  `SessionManager`, `ModelRuntime`, `ToolDefinition`, `completeSimple` and a handful of
  types, and registers no extensions or custom providers.
  One change does touch a boundary this app depends on and was re-verified rather than
  assumed: 0.87.0 made `SessionManager` canonical for provider context, but
  `SessionManager.inMemory()` keeps its signature and merely gained an optional third
  `entries` parameter, so pi sessions still stay out of `~/.pi/agent/sessions/` and the app's
  own history remains authoritative. The thinking-level clamp that mirrors pi's algorithm was
  re-checked line by line against the new build and still matches.

- **Multi-line shell commands no longer prompt just for being multi-line.** A line break now
  separates commands exactly like `;`, and each one is checked against the lists on its own.
  A here-document (`python3 - <<'PY' … PY`) is read as data for its command; the denied list
  is still matched against its text. The old unconditional prompt added no protection — the
  same commands written on one line already went through the normal checks. A few multi-line
  shapes still ask: a here-document with no terminator, a `$(...)` in a here-document whose
  delimiter is not quoted, and a `#` comment that starts in the middle of a line. If you
  relied on "multi-line always asks" as a safety net with a broad trust list, add the
  commands you care about to the denied list.

### Security

- Cleared 7 of 13 reported dependency vulnerabilities: `electron` 41.3.0 → 41.10.7 (patch
  releases only — fixes, no breaking changes), `@vitest/coverage-v8` 4.1.0 → 4.1.11 (pulls
  `vitest` to the same, closing a path-traversal issue in the test mocker),
  `@turbodocx/html-to-docx` 1.22.0 → 1.22.2 (drops `image-size` for `probe-image-size`
  outright), and a `sharp` override to 0.35.4, which `@huggingface/transformers` cannot
  request itself because it pins `^0.34.5`.
- **`allowScripts` must be updated whenever those packages move.** It keys on exact
  versions, so bumping `electron` silently blocked its postinstall and left the binary
  undownloaded — the app would not start. `npm rebuild <pkg>` is then needed, since a plain
  `npm install` will not re-run an install script for an already-unpacked package. The same
  applies to `sharp`, `better-sqlite3`, `onnxruntime-node`, `esbuild` and `protobufjs`.
  A pre-existing mismatch was fixed at the same time: `protobufjs` was allowed at 7.6.1 while
  7.6.6 was installed, so its postinstall had been blocked.
- Two shapes that bash runs as commands were being read as harmless arithmetic and now
  ask: `$((cmd) | other)` — a command substitution — and `((cmd); other)` — a subshell.
  Arithmetic is still allowed, but only when it really closes with `))`. Also now asking:
  `cmd >1&`, where a background `&` hid behind a redirection target, and any command that
  uses `$'…'` or `$"…"` quoting — the shell rewrites those strings before running the
  command, so their text cannot be checked as written.
- **Do not run `npm audit fix --force` here.** The six remaining advisories have no real fix,
  and every remedy npm proposes is a downgrade that either fixes nothing or costs a feature:
  `ngrok@4.3.3` depends on the same vulnerable `extract-zip@^2.0.1` and `uuid@^7||^8` as the
  version in use, and the `adm-zip` remedy is a rollback of `@huggingface/transformers` from
  4.2.0 to 3.8.1, which would undo local embeddings. Both remaining paths are narrow:
  `extract-zip` runs only when ngrok first downloads its binary, and `adm-zip` only from
  onnxruntime-node's install script — neither during normal operation.

## [1.0.7] - 2026-09-09

### Changed

- Uplifted `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from **0.82.0 to
  0.85.1**, nine releases. No source change was needed: the two breaking changes in the
  range do not reach this app. 0.84.0's removal of the cumulative `message` and
  `assistantMessageEvent.partial` fields applies only to the JSON and RPC wire protocols,
  and this app subscribes to session events in-process, where both fields remain; 0.83.0's
  TypeBox 1.3.7 upgrade removed no API this app uses. `typecheck` is clean and all 3141
  tests pass. Note for anything reading the SDK version: 0.85.1 no longer exports the
  `./package.json` subpath, so that path must be read from disk rather than required.
  Pin **0.85.1, not 0.85.0** — 0.85.0 shipped broken SDK imports.
- The skills shipped with the app now live in `resources/skills/` instead of `.claude/skills/`.
  That directory belongs to Claude Code, which loaded the app's own product content as if it
  were tooling for working on the repository — `skill-creator`, for one, appeared twice. The
  new location sits next to the other things bundled into the build (`resources/node`,
  `resources/python`, `resources/tools`). **Installed copies are unaffected**: the packaged
  layout is still `<Resources>/skills`, and the `.builtin-hash` stamps and `.user-modified`
  markers under the user data directory keep working, since no skill content changed.
- Four copies of the built-in-skills directory lookup were replaced by one
  (`src/main/skills/builtin-skills-path.ts`). The candidate each copy labelled "development"
  resolved to the parent of the project directory and never matched; the fallbacks reading
  from inside `app.asar` are gone with it, as nothing has been packaged that way since skills
  moved to `extraResources`. The two branches that copied a skill instead of linking it when
  the source sat inside the archive went the same way — they could no longer be reached, and
  the comment beside one of them claimed the link was made only during development, when in
  fact installed builds link too.

## [1.0.6] - 2026-07-22

### Added

- Settings → Memory now reports **embedding coverage** — how many stored chunks actually
  carry a vector. A chunk without one is found by keyword but not by meaning, and until now
  nothing said so: the page reported successful ingestion, which was true and beside the
  point. The card turns amber when records are missing vectors and red, with the reason,
  when an embedding call failed.
- **Backfill embeddings**, an action on that card, computes the missing vectors for records
  already in the database. Unlike **Rebuild all** it runs no LLM extraction and deletes
  nothing — the text a vector is built from is already stored, so only the embedding calls
  are needed. It also picks up records whose vectors came from a previously-configured
  model. Progress is reported per record, and an interrupted run resumes where it stopped.
  The prompts that appear after changing the embedding provider or model now offer this
  instead of a full rebuild — a model change invalidates the vectors, not the summaries.

### Changed

- Experience memory now lives in a SQLite database (`memory.db`) instead of a single
  `experience_memory.json`. The JSON store rewrote the whole file on every ingested session
  and re-parsed it in full on every read, both scaling with total size; at the observed
  growth (~24 MB in a month) that meant a multi-hundred-millisecond main-process stall per
  ingest and a ~1 s parse per read. Reads are now indexed queries and writes are row-level
  upserts. **Migration is automatic and requires no action**: on first launch the JSON is
  copied across in a single transaction and then renamed to `experience_memory.json.bak`,
  which is retained as a rollback artefact. Nothing is deleted. Core memory and session
  state stay JSON by design — they are small enough that indexing buys nothing.
- Rebuilding memory for a workspace is now crash-safe. It clears and re-ingests inside one
  transaction, so an interrupted rebuild can no longer leave a workspace cleared but not
  repopulated.
- Settings → Memory: "Raw File Viewer" is now "Memory Storage". `memory.db` is binary, so
  selecting it shows a status card — schema version, journal mode, size, session/chunk
  counts, embedding model and dimension, integrity check, and a per-workspace breakdown —
  with **Export JSON** and **Vacuum** actions. Export produces a full-fidelity backup in the
  original `{ sessions, chunks }` shape, preserving the raw-inspection capability the JSON
  file used to provide. The other entries are still JSON and open in the raw viewer.
- Memory search no longer decodes embeddings or conversation transcripts it never uses.
  Keyword search over past sessions read every stored embedding and full transcript in order
  to score text; workspace scoping is now applied in SQL rather than in JS.
- Recall no longer parses every stored transcript on each query. Transcripts are the largest
  data in the store and were parsed in full to populate just the top few results; they are
  now fetched only for the sessions that actually rank, bounding the cost by the result count
  rather than by store size. This runs on every prompt, so the saving is in the latency budget
  of each message.

### Fixed

- Embeddings are no longer skipped because of which **chat** provider happens to be selected.
  The embedding path checked the provider against a fixed list of the six original built-in
  providers; once native catalog providers (minimax, zai, deepseek and the rest) were added,
  any of them being active caused embeddings to be silently abandoned and the chunk stored
  without a vector. A configuration that names its own embedding endpoint and model is now
  honoured regardless of the active chat provider — it does not depend on it — and every
  other case is judged by the provider's actual API protocol rather than by its name.
  A provider that genuinely cannot embed now says so instead of failing quietly.
- Settings → Memory refreshes its counters when the tab is reopened. Previously the page
  read them once and kept showing that snapshot for as long as Settings stayed open.
- Changing the embedding model no longer silently degrades search results. Similarity is
  only meaningful within one model's embedding space, so previously a model switch left
  stored vectors being compared against queries from a different space — returning noise
  ranked as though it were relevant. The mismatch is now detected and retrieval falls back
  to keyword-only until the vectors are recomputed, with a prompt offering to do so.

## [1.0.5] - 2026-07-20

### Added

- HTTP proxy setting for routing model API requests through a corporate/egress proxy
  (Settings → API), alongside a refreshed curated model list.
- Single searchable provider and model pickers in Settings → API, backed by the live
  pi-ai registry (replaces the split featured/catalog pickers).
- Compaction estimate in the Context Panel, surfacing when the conversation is
  approaching the auto-compaction threshold (pi SDK 0.80 adoption).
- Per-model thinking level selector in Settings → API, replacing the "Enable
  thinking" on/off checkbox. The offered levels now come straight from pi-ai's
  per-model capability tables (`getSupportedThinkingLevels`), so each model
  shows only the reasoning levels it actually supports (e.g. Sonnet 4.6 hides
  `xhigh`, GLM-5.2 collapses `low`/`medium` into `high`, MiniMax is
  budget-only) and follows pi's updates automatically. Existing `enableThinking`
  settings migrate losslessly (`true → medium`, `false → off`); the stored value
  stays unclamped so switching models never erases the preference. Models reached
  through a Custom endpoint are now detected as reasoning-capable when pi knows
  the model under any provider (previously only OpenAI/Anthropic/Google were
  consulted, so e.g. MiniMax-M3 and z-ai/glm-5.1 were reported as non-reasoning).

### Changed

- Uplifted `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from 0.80.3 to 0.80.10.
- The SDK's `ModelThinkingLevel` type now flows through the config layer,
  agent-runner, IPC, and the Settings UI (previously adopted as an internal
  type only).

### Fixed

- Corrected OpenRouter Anthropic model slugs to the dot form so those models resolve.
- Native provider profiles now persist without crashing `config.save`.
- Native model diagnostics now probe each provider against its own registry endpoint
  instead of defaulting to the OpenAI endpoint.

### Removed

- Removed the prompt-cache hit (CH) chip from the Context Panel — it was buggy and
  redundant next to the Context Usage readout.

## [1.0.4] - 2026-07-06

### Added

- Native provider catalog: z.ai, MiniMax, Kimi, DeepSeek, Groq, xAI and other pi-ai
  first-class providers are now selectable in Settings → API, driven by a data-driven
  projection of the SDK registry (real pricing, context windows, base URLs, and
  provider-specific streaming quirks) behind a searchable model picker. The Custom
  entry remains as the escape hatch. Existing config sets load and behave identically.
- Local embedding hardening: exponential backoff, retry, and warm-up-on-select for
  first-use model downloads; embedding-model validation that blocks chat models and
  warns on misconfiguration; EmbeddingGemma query/document prefixes for better
  retrieval quality; and a "Rebuild now" prompt when the on-disk index format is stale.
- Chat input now refocuses when you start typing outside an editable field.

### Changed

- Uplifted `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from 0.80.2 to 0.80.3.
- Renamed internal `OPEN_COWORK_*` environment variables to `SQOWE_PILOT_*` (rebrand cleanup).

### Fixed

- Externalized `onnxruntime-node` and `sharp` in the build so local embeddings load
  correctly in the packaged app.
- Native provider catalog is now warmed at startup, fixing cold-start routing.

## [1.0.3] - 2026-07-04

### Added

- Local ONNX embedding provider for memory, running fully offline in-process
  (EmbeddingGemma-300M via transformers.js) — the default for new installs, with no
  Python and no API key required.
- Settings UI to select the local embedding provider and model.

## [1.0.2] - 2026-07-02

### Added

- Priority-based workspace-instructions auto-discovery: instead of picking one exact
  filename, the app scans the working directory for a fixed candidate set
  (`CLAUDE.md`, `AGENTS.md`, `.cowork/instructions.md`, `memory.md`, `instructions.md`)
  and injects the first one that exists, in a user-reorderable priority order.
- Animated "agent is working" indicator in the chat input.

### Fixed

- Workspace-instructions migration now reads the decrypted config store.
- Workspace-instructions badge no longer shows a phantom filename when no instructions
  file is found.
- Hungarian and Russian Electron locales are retained during the after-pack cleanup.

## [1.0.1] - 2026-07-01

### Added

- Right-click "Copy" context menu for arbitrary text selections in the chat window.
- Chat export to DOCX and PDF, with format chosen via the save dialog's file-type
  filter (format-as-parameter, no new menu items).

### Fixed

- Skill conflict config and orphan dismissals now persist via `ConfigStore.update`.

## [1.0.0] - 2026-06-25

> Fresh product identity after the **Open Cowork → Sqowe Pilot** rebrand — a deliberate
> version reset and clean break from the `3.3.0-sqowe.N` fork series. Entries below this
> point document the prior Open Cowork lineage under its original versioning.

### Changed

- Rebranded the product to **Sqowe Pilot**: application identity (`appId com.sqowe.pilot`),
  packaging (`productName`, DMG, copyright), runtime strings, documentation, and the
  repository home (`github.com/sqowe/pilot`).

### Added

- First-launch data migration: existing users' data is copied losslessly from the legacy
  `<appData>/open-cowork` directory to `<appData>/sqowe-pilot`, including the encrypted
  config (decrypts transparently — encryption seeds are unchanged). The migration is
  fork-fingerprint gated, copy-not-move, and idempotent via a `.brand` marker.

### Removed

- Dead upstream GitHub automation (Codex PR/issue bots, Homebrew tap workflow), the
  bundled marketing website, and the Chinese README.

## [3.3.0-sqowe.8] - 2026-06-04

### Changed

- Updated default system prompt sections to Sqowe Pilot identity with expanded behavioral rules and tool-routing policies
- Uplifted `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from 0.78.0 to 0.78.1

## [3.3.0-sqowe.7] - 2026-05-27

### Added

- Per-server MCP tool permission policies to reduce permission fatigue
  - Server-level default policy: allow-all, allow-reads, ask-all, deny-all
  - Per-tool permission overrides (sparse, exception-based)
  - Workspace-shareable policies via `.cowork/mcp-permissions.json`
  - Progressive trust tracking (suggests auto-allow after 5 manual approvals)
  - Read-only tool classification heuristic (get*\*, list*\_, search\_\_, etc.)
  - Workspace trust boundary (untrusted repos can restrict but not grant)
  - Canonical server-name normalization with collision detection (fail-closed)
  - Runtime validation for workspace policy JSON
  - Settings UI panel with policy selector and per-tool override management
  - Shared classification module (`src/shared/mcp-tool-classification.ts`)
  - 54 new tests for permission resolution, classification, and caching

## [3.3.0-sqowe.6] - 2026-05-17

### Added

- Per-session and per-workspace MCP server toggle for context window optimization
  - Toggle switches in Context Panel to disable/enable MCP servers mid-conversation
  - Session-level overrides are ephemeral (in-memory only, reset on new session)
  - Workspace-level profiles via `.cowork/mcp-servers.json` (committable to git)
  - Three-layer resolution: session override > workspace profile > global config
  - Input validation and bounded state to prevent memory growth
  - 25 new tests for override precedence, validation, and cleanup

## [3.3.0-sqowe.5] - 2026-05-14

### Added

- Configurable permission dialog timeout (Settings → Bash Commands)
  - Default: 300s (was hardcoded 60s). Set to 0 for infinite (no timeout).
- New "System Prompt" settings tab with editable prompt sections
  - Sections stored as files in {userData}/prompts/ (identity, behavioral-rules, citations, tool-routing)
  - Each section can be independently edited, disabled, or reset to default
  - Workspace-level overrides via .cowork/prompts/ (full replace model)
  - Template variables: {{cwd}}, {{project_name}}, {{date}}, {{model}}
  - mtime+size fingerprint cache for efficient change detection

### Changed

- Moved "Workspace instructions file" selector from General to System Prompt tab

## [3.3.0-sqowe.4] - 2026-05-12

### Changed

- Migrate Pi SDK from deprecated `@mariozechner/pi-*` scope to `@earendil-works/pi-*`
- Uplift pi-coding-agent and pi-ai from 0.71.0 to 0.74.0
- Update all source imports, test mocks, and documentation references

## [3.3.0-sqowe.3] - 2026-05-08

### Changed

- Uplift Electron from 35.7.5 to 41.3.0 (Chromium 146, Node 24.14, V8 14.6)
- Update .nvmrc from 22 to 24 to match host environment
- Route renderer clipboard writes through main process IPC (Electron 40+ deprecation)
- Rename readme.md → README.md
- Document native module rebuild step in README and CONTRIBUTING

## [3.3.0-sqowe.2] - 2026-05-05

### Fixed

- Pass user-attached images to pi-coding-agent SDK prompt (images were silently dropped)

## [3.3.0-sqowe.1] - 2026-05-02

Sqowe fork variant based on upstream `3.3.0`. Tracks upstream functionality with fork-specific customizations layered on top. See the [Sqowe-Specific Features](readme.md#sqowe-specific-features) section in the README for details.

## [3.3.0] - 2026-04-18

First stable release of the 3.3.x series. Graduated from 9 beta releases with 30+ commits since beta.9.

### Added

- Pairing mode UI guidance and approval panel for Feishu remote control (#109)
- Official project website with VitePress (#122)
- Codex-powered PR review bot with GPT-5.3-codex (#94)
- Codex issue auto-response workflow (#95)
- Platform-based issue auto-assignment (#96)
- ROADMAP.md with versioned planning (v3.4.0+)
- SEO optimizations — llms.txt, social preview, FAQ
- Dependency management policy in CONTRIBUTING.md

### Fixed

- Feishu DM policy now correctly syncs to gateway auth mode (#107)
- Feishu WebSocket connection failures (#93, #105)
- Screenshot tool results display as images instead of bloating text context (#135, #124)
- GUI tool-result image deduplication via content hashing
- Gemini and other providers: empty probe response handling (#88)
- Model probe error causes now preserved in diagnostics (#121)
- MCP: prefer system npx on Windows (#120)
- Security: zip-slip and path traversal hardening (#139)
- Dark/light theme switching on website
- Outdated model fallbacks updated to current versions (claude-sonnet-4-6, gemini-3-flash-preview, gpt-5.4-mini)

### Changed

- OpenAI model presets updated: gpt-5.4-mini, gpt-5.4-nano, o4-mini (replaced retired gpt-4.1)
- CI: platform builds moved to release-only, smoke tests added
- Dependabot: grouped CI actions, separated production patch/minor, ignored Electron major

### Removed

- Unused credentials store module and Keychain integration (eliminated macOS Keychain popup on startup)

### Contributors

- [@hqhq1025](https://github.com/hqhq1025)
- [@Sun-sunshine06](https://github.com/Sun-sunshine06)
- [@JackXFan](https://github.com/JackXFan)
- [@andoan16](https://github.com/andoan16)

## [3.3.0-beta.8] - 2026-03-29

### Added

- Build verification and post-install reliability checks for Windows and macOS installers
- ~100 test files with coverage thresholds enforced in CI pipeline

### Fixed

- 8 critical + 10 high security findings from Round 3 security audit
- 20 medium-severity hardening fixes across sandbox and MCP modules
- VM sandbox security against command injection and symlink attacks (WSL2 & Lima)
- MCP server staging and lifecycle issues for external tool integration
- Skills ENOTDIR error when built-in skills (PPTX, DOCX, PDF, XLSX) symlink into .asar archive
- Remote gateway null check in `loadPairedUsers` for Feishu/Slack integration
- Scrypt `maxmem` parameter for startup key derivation performance
- CI pipeline stabilization for cross-platform builds

## [3.2.0] - 2026-03-02

### Added

- GUI automation support for Windows desktop applications (computer use with WeChat workflow)
- Drag-and-drop file and image attachments with bubble layout in chat interface

### Changed

- Updated Open Cowork app icons for Windows and macOS packaging (branding refresh)
- Widened chat content area layout for better readability

### Fixed

- Improved `key_press` robustness for GUI automation on Windows and macOS

## [3.1.0] - 2026-02-13

### Added

- Full V2 plugin runtime and management system for custom MCP connectors
- Demo videos showcasing file organization, PPTX generation, XLSX creation, and GUI operation

### Fixed

- Custom Anthropic API timeout handling for Claude model requests
- Agent runner `sdkPlugins` runtime ReferenceError in multi-model configurations
- Hardcoded Chinese text removed from config modal and titlebar (full English/Chinese localization)
- Sensitive log redaction hardened for API keys and credentials
- Packaged app version alignment to 3.0.0 for consistent update detection

## [3.0.0] - 2026-02-08

### Changed

- **Breaking**: Removed proxy layer — all AI model requests now go through Claude Agent SDK directly
- Architecture redesigned to SDK-first approach for better multi-model support (Claude, OpenAI, Gemini, DeepSeek)

### Fixed

- GUI dock click targeting and verification gating for macOS computer use

## [2.0.0] - 2026-01-25

### Changed

- Major architecture overhaul: Electron-based desktop app with React UI, sandbox isolation, and Skills system

## [1.0.0 — Open Cowork] - 2025-12-01

### Added

- Initial release of Open Cowork — open-source AI agent desktop app with one-click install for Windows and macOS

[Unreleased]: https://github.com/sqowe/pilot/compare/v1.0.9...HEAD
[1.0.9]: https://github.com/sqowe/pilot/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/sqowe/pilot/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/sqowe/pilot/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/sqowe/pilot/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/sqowe/pilot/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/sqowe/pilot/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/sqowe/pilot/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/sqowe/pilot/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/sqowe/pilot/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/sqowe/pilot/releases/tag/v1.0.0
[3.3.0-sqowe.8]: https://github.com/sqowe/pilot/compare/v3.3.0-sqowe.7...v3.3.0-sqowe.8
[3.3.0-sqowe.7]: https://github.com/sqowe/pilot/compare/v3.3.0-sqowe.6...v3.3.0-sqowe.7
[3.3.0-sqowe.6]: https://github.com/sqowe/pilot/compare/v3.3.0-sqowe.5...v3.3.0-sqowe.6
[3.3.0-sqowe.5]: https://github.com/sqowe/pilot/compare/v3.3.0-sqowe.4...v3.3.0-sqowe.5
[3.3.0-sqowe.4]: https://github.com/sqowe/pilot/compare/v3.3.0-sqowe.3...v3.3.0-sqowe.4
[3.3.0-sqowe.3]: https://github.com/sqowe/pilot/compare/v3.3.0-sqowe.2...v3.3.0-sqowe.3
[3.3.0-sqowe.2]: https://github.com/sqowe/pilot/compare/v3.3.0-sqowe.1...v3.3.0-sqowe.2
[3.3.0-sqowe.1]: https://github.com/sqowe/pilot/compare/v3.3.0...v3.3.0-sqowe.1
[3.3.0-beta.8]: https://github.com/sqowe/pilot/compare/v3.2.0...v3.3.0-beta.8
[3.2.0]: https://github.com/sqowe/pilot/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/sqowe/pilot/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/sqowe/pilot/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/sqowe/pilot/compare/v1.0...v2.0.0
[1.0.0 — Open Cowork]: https://github.com/OpenCoworkAI/open-cowork/releases/tag/v1.0
