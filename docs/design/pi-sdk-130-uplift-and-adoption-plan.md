# Pi SDK 0.87.1 → 1.3.0 — Uplift Report & Adoption Plan

**Created:** 2026-10-20
**Status:** **Uplift implemented in the working tree** (not committed or released yet).
Two adoption items shipped with it (§8.1). The rest of §8 is the live adoption backlog.
**Author:** AI-assisted design session
**Baseline before:** 0.87.1 · **after:** 1.3.0 — `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` pinned exactly in `package.json`; `pi-agent-core`,
`pi-tui`, `pi-codemode`, `pi-mcp` and `pi-telemetry` resolve to 1.3.0 transitively.
**Supersedes:** [`archive/pi-sdk-085-feature-adoption-plan.md`](./archive/pi-sdk-085-feature-adoption-plan.md);
its open items are carried forward in §8.2 under the same letters.
**Related:** [`permission-gate-tool-call-event.md`](./permission-gate-tool-call-event.md) —
moving the permission gate to pi's public `tool_call` event, and the workspace-extension
loading issue found during this uplift (§6.4).

---

## 1. Summary

Twelve pi releases (0.99.0 … 1.3.0; versions 0.88–0.98 were never published; 1.3.0 is
`latest` on npm, released 2026-10-15). No pi SDK call in this app had to change, but the
uplift was not source-free:

| #   | Change the uplift needed                                                           | Why                                                                                                   |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| R1  | Pin the app's `openai` → 7.19.0 and `@anthropic-ai/sdk` → 0.129.0                  | The main build keeps both external, so the bundled pi-ai loads **our** copies (§4.1)                  |
| R2  | Kimi: drop the hand-set `routeProtocol`, move the ready-made setup to `/coding/v1` | pi 1.3.0 serves `kimi-coding` over OpenAI Chat Completions at `https://api.kimi.com/coding/v1` (§4.2) |
| R3  | Add `azure` and `typesafe` to `EXCLUDED_NATIVE`                                    | Both would otherwise appear on the Providers tab (§4.3)                                               |
| R4  | Versions and citations in rule files, tests and docs                               | Line numbers moved; "pre-1.0" no longer true (§4.4)                                                   |

Gates on the result: `npm run typecheck` clean; `npm run test:coverage` 253 files /
3976 tests passing, thresholds met; `npm run lint` 0 errors, 15 warnings, none in a line
this work touched.

## 2. How it was checked

- **Source:** only the project's own copy — 1.3.0 installed from registry.npmjs.org into
  `node_modules/@earendil-works/` — plus the published 0.87.1 tarball (`npm pack`) for the
  "before" side. Never a locally installed `pi` CLI, whose copy and version are the user's
  (rule added to `CLAUDE.md` and `AI_MAIN_PROCESS.md` §13).
- **Read:** `pi-coding-agent/CHANGELOG.md` from 1.3.0 back to 0.87.1; the `.d.ts` surface of
  every symbol the app imports; the `dist/` code behind each behavioural claim below.
- **Run:** a scratch clone with 1.3.0 installed first (typecheck, full test suite, `vite build`),
  then the project itself; a dump of `getProviders()` / `getModels()` from both versions;
  pi-ai 1.3.0 against a local mock server for `openai-completions`, `openai-responses` and
  `anthropic-messages`, once with its own SDK copies and once with the app's top-level ones.

## 3. Breaking changes 0.99.0 – 1.3.0, against this app

| Change (version)                                                                                                             | Reaches the app? | Why                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kimi-coding` → Chat Completions at `/coding/v1` (1.3.0)                                                                     | **Yes**          | R2                                                                                                                                                         |
| Internal pi dependencies pinned to exact versions (1.3.0)                                                                    | **Yes**          | R1                                                                                                                                                         |
| Model switch drops the previous model's thinking (1.3.0)                                                                     | Behaviour, good  | The runner hot-swaps models with `setModel()`; the new model no longer sees the old one's reasoning as text                                                |
| `before_agent_start` becomes a union; session busy while a run starts; `sendUserMessage()` needs `deliverAs` (1.2.0)         | No               | The app registers no pi extensions and starts runs only with `prompt()`; `pi-extensions/bash-restrictions` listens to `session_start` and `tool_call` only |
| Config schemas on pi.dev, theme schema moved; `pi mcp list --json` (1.2.0)                                                   | No               | CLI / TUI only                                                                                                                                             |
| Removed `./client`, `./experimental/plugin`, `pi-client`, `pi-protocol`, `chord` (1.2.0)                                     | No               | Never imported                                                                                                                                             |
| `serializeConversation()` omits thinking (1.2.0)                                                                             | No (good)        | Smaller compaction requests                                                                                                                                |
| `azure-openai-responses` renamed `azure` (1.0.3)                                                                             | **Yes**          | R3                                                                                                                                                         |
| `npm-shrinkwrap.json` dropped from the package (1.0.1)                                                                       | Indirectly       | Transitive versions are now fixed only by our `package-lock.json`                                                                                          |
| Built-in `mcp` / `codemode` / `tool-search` / `llama.cpp` extensions (0.99.0)                                                | No               | Only the CLI passes them (`dist/main.js:454`); `docs/sdk.md:116`: "SDK sessions do not" load them                                                          |
| Build moved to TypeScript 7, ES2024 target (0.99.0)                                                                          | No               | Our TypeScript 5.9 reads the declarations; typecheck clean                                                                                                 |
| MCP tool names `-` → `_` (0.99.2)                                                                                            | No               | That is pi's own MCP; ours bridges its own tool names                                                                                                      |
| `bash` structured result up to 1 MiB, empty output `""` (0.99.0)                                                             | No               | Structured result is for codemode; the model-facing text still says `(no output)`                                                                          |
| `pi-agent-core` drops the whole `harness/` tree (110 declaration files) and re-exports                                       | No               | Not imported directly                                                                                                                                      |
| `pi-ai` root drops `images-models`, `assistant-message-frame`; `getModel`/`getModels`/`getProviders` deprecated in `/compat` | No (yet)         | Not imported; the three `/compat` reads still work and are what `pi-model-resolution.ts` and the native catalog use                                        |
| `ToolDefinition.execute` 5th argument becomes `ExtensionToolContext`; `steer()`/`followUp()` return a disposition (0.99.0)   | No               | Typecheck clean; not called                                                                                                                                |

## 4. What the uplift changed — as built

### 4.1 R1 — the SDK copies the bundled pi-ai actually loads

`vite.config.ts` keeps `openai` and `@anthropic-ai/sdk` external, so the built
`anthropic-messages-*.js`, `openai-*.js` chunks `require()` them from the top-level
`node_modules` — the app's versions, not pi-ai's nested pins. Tests resolve the Node way and
reach the nested copy, so nothing in `npm test` can see a mismatch.

- On 0.87.1 they already differed: pi-ai pinned `@anthropic-ai/sdk` 0.124.0, the bundle ran
  the app's 0.92.0.
- 1.3.0 pins `openai` 7.19.0 (a major ahead of our 6.40.0) and `@anthropic-ai/sdk` 0.129.0.
  A plain-text reply works against the mock server with either set; tools, thinking, images
  and caching were not exercised that way, so the mismatched set is not one to ship.
- Fix: both pinned exactly to pi-ai's versions; the nested copies disappear. `openai` 7.0's
  only breaking change is a Node 22 floor. The app's own callers (`api-diagnostics.ts`,
  `memory-llm-client.ts`) typecheck and pass unchanged.
- Guard: `src/tests/bundled-externals-versions.test.ts` reads the main build's `external`
  list and fails when any pi dependency on it is installed at another version.

### 4.2 R2 — Kimi

`pi-ai/dist/providers/kimi-coding.js:10,21` (1.3.0): `baseUrl: "https://api.kimi.com/coding/v1"`,
`api: openAICompletionsApi()`. The app had `routeProtocol: 'anthropic'` on `kimi-coding` in
`NATIVE_PROVIDER_META`, and `deriveRouteProtocol` returns that override before looking at the
catalog (`provider-catalog-native.ts:101`) — so Diagnose Connection
(`api-diagnostics.ts:115`) and the synthetic fallback for unlisted Kimi models would have
used the Anthropic client against an OpenAI address. Chat with a catalog model was never at
risk: it takes `api` and `baseUrl` from the registry model.

- The override is removed; the catalog derives `openai`, which is also the cold-start default.
- The ready-made setup now recommends `openai` at `https://api.kimi.com/coding/v1` and still
  sends the address to the catalog's `kimi-coding`; `/coding` is still recognised. A custom
  endpoint at `/coding` with the Anthropic protocol now gets the "protocol mismatch" hint.
- The note text changed in en / ru / hu / zh (the zh text has not been read by a person
  who reads Chinese).

### 4.3 R3 — providers that would have appeared

`buildNativeEntries` lists every pi provider not in `EXCLUDED_NATIVE`. New in 1.3.0:
`azure` (45 models, no address — the renamed `azure-openai-responses`, excluded on purpose
because it needs the Azure resource) and `typesafe` (no chat models, classifiers only). Both
are excluded. Also new in the catalog: Claude Haiku 5.5 and Sonnet 5.5, GPT-6.1 Sol,
Gemini 4 Argon; OpenCode Zen / Go moved to `opencode.ai/inference`; some OpenRouter, Fireworks
and Together models were removed (saved model sets naming them fall back like any unlisted
model).

### 4.4 R4 — citations

`src/shared/thinking-levels.ts` (pi's clamp is unchanged byte for byte, now
`pi-ai/dist/models.js:692-710`), `tests/provider-setups-vs-catalog.test.ts` (tables and
"last checked"), `AI_MAIN_PROCESS.md` §1 and §13, `CLAUDE.md`, `docs/dependency-tiers.*`
(stale since 0.78.1), `CHANGELOG.md` (Unreleased).

## 5. Boundaries re-asserted

- **In-memory session and settings managers.** `SessionManager.inMemory(cwd?, options?, entries?)`
  and `SettingsManager.inMemory(settings?, options?)` are unchanged
  (`session-manager.d.ts:386`, `settings-manager.d.ts:70`); the `compaction` and `retry` keys
  the runner passes are unchanged (`settings-schema.js:14-53`).
  `tests/sdk-only-session-isolation.test.ts` passes.
- **Thinking-level clamp.** `EXTENDED_THINKING_LEVELS`, `getSupportedThinkingLevels` and
  `clampThinkingLevel` are textually identical to 0.87.1.
- **Ready-made setups vs catalog.** The test failed on Kimi only, as designed; decided in §4.2.
- **Files pi loads relative to itself.** `photon_rs_bg.wasm` is still emitted next to the
  bundle. New: codemode's worker (`pi-codemode/dist/runtime/host.js`) and QuickJS wasm
  (`wasm.js`) — not needed while codemode is not loaded; their chunks are in the bundle but
  only load on use. Bundle size unchanged (13 MB).
- **Built-in extensions stay out.** The app's `DefaultResourceLoader` gets no
  `extensionFactories`, so its built-in map is empty (`resource-loader.js:249-251`) and
  `package-manager.js:739` adds no `builtin:*` paths.
- **Permission gate shape.** `beforeToolCall(context, signal)` and `{ block, reason }` are
  unchanged; pi installs its own hook once, in the session constructor
  (`agent-session.js:204,322`), so the app's replacement persists. **New gap:** calls a tool
  makes through `ctx.executeTool()` run `this._beforeToolCall(context, parentId)` directly
  (`agent-session.js:405`), not `agent.beforeToolCall` — they would bypass the gate. Nothing in
  the app makes such calls today; the rule and the fix are in `AI_MAIN_PROCESS.md` §1 and the
  [gate design](./permission-gate-tool-call-event.md).

## 6. Found on the way (present on 0.87.1 too)

### 6.1 The mid-loop overflow guard never ran — removed

The runner installed it only if `'_onPayload' in agent`; pi-agent-core's field is
`onPayload` (0.87.1 and 1.3.0 `agent.js:102`), so the app logged "SDK agent does not expose
\_onPayload — skipping mid-loop overflow guard" on every new session (seen in the app log on
2026-10-20). With it, two side jobs never ran either: the live context-bar estimate and
`num_ctx` for Ollama.

Removed rather than renamed (decided 2026-10-20):

- pi already compacts before each further model call in the tool loop once the threshold is
  crossed (`_compactBeforeNextAssistantResponse`, `agent-session.js:424`), against the
  tool-aware reserve the app configures — which is why the dead guard went unnoticed.
- The context bar updates after every model reply anyway: the panel falls back to the last
  assistant message's `tokenUsage.input` (`renderer/utils/context-usage.ts`).
- `num_ctx` cannot work there: the app talks to Ollama over its OpenAI-compatible `/v1`
  endpoint, and Ollama's docs say "The OpenAI API does not have a way of setting the
  context size" (`ollama/docs/api/openai-compatibility.mdx`); the runner also put the field
  at the top level of the request, not under `options`.

Deleted: the block in `agent-runner.ts`, `mid-loop-overflow-guard.ts` and its 801-line test.
When the guard broke was not established — no older pi was installed to compare.

### 6.2 Models whose output limit is nearly the window — checked, already handled

First reported here as open, then withdrawn on 2026-10-20. Taken alone,
`compaction-budget.ts:203-212` reserves `maxTokens + tool schemas + margin`, so a
`maxTokens` close to `contextWindow` would leave no room for input — and the pre-request
guard (`pre-request-guard.ts:277-283`) would abort a session's first prompt. 1.3.0 adds such
models (`moonshotai/kimi-k3`: output limit 131072 → 1048576 with a 1048576 window; DeepSeek
V4 / V4.1 Flash on OpenRouter at ~90%).

But the runner caps `piModel.maxTokens` before any of that runs: above 50% of the window it
becomes 20% of the window (`agent-runner.ts:2553-2574`), which also limits what pi asks the
provider for. Compaction budget, pre-request guard and context bar all read the capped value.
Kimi K3 therefore plans with 209715 tokens of output. No change; the proposed second cap would
only have moved compaction later for models at 25–50% (for example Claude Sonnet 4.5,
200K / 64K), where nothing is wrong.

### 6.3 Documentation drift — fixed

`AI_MAIN_PROCESS.md` said the gate is installed through the `tool_call` extension event; it
replaces `agent.beforeToolCall`. Corrected, with the nested-call rule beside it.

### 6.4 Workspace extensions and packages were loaded — fixed 2026-10-20 (security)

The runner builds `DefaultResourceLoader` without a `settingsManager`, so pi makes a
file-backed one with `projectTrusted = options.projectTrusted ?? true`
(`settings-manager.js:238`). With project trust on, pi loads
`<workspace>/.pi/extensions/*` into the main process (`package-manager.js:2036`) and reads
`<workspace>/.pi/settings.json`, whose `packages` entries it installs with npm when missing
(`package-manager.js:1014`). Verified on 0.87.1 and 1.3.0 by loading a probe extension from a
scratch workspace with the runner's loader options: the extension's code ran. The npm path
was read, not run. Fixed as phase 0 of
[`permission-gate-tool-call-event.md`](./permission-gate-tool-call-event.md) §2:
`src/main/claude/pi-resource-loader.ts` gives the loader an in-memory, untrusted settings
manager and `noExtensions`; `src/tests/claude/pi-resource-loader-boundary.test.ts` guards it.
Workspace `.pi/skills` and `.agents/skills` are no longer picked up — accepted. On
2026-10-21 `noSkills` followed (gate design §2.4): pi had also loaded the runtime skills dir
and `~/.agents/skills` on its own, so skills disabled for a session still loaded.

## 7. What comes with 1.3.0 without code

- **Models:** Claude Haiku 5.5 / Sonnet 5.5, GPT-6.1 Sol, Gemini 4 Argon; Opus 5 gains the
  `off` level; corrected thinking levels for Mistral, Xiaomi MiMo, Gemini 4 Argon, Claude
  Haiku 5.5 — inherited through `getSupportedThinkingLevels`.
- **Retries:** `server_busy`, "Unable to forward upstream stream", "temporarily unavailable"
  (which also failed compaction on the first try), "The upstream provider returned an
  error", "Selected model is at capacity", Bedrock stalled streams.
- **Anthropic:** tools whose schemas use keywords strict mode rejects (`minimum`/`maximum`,
  common in MCP) are sent non-strict; a refused strict tool set is retried non-strict; error
  tool results with images no longer 400.
- **Tool calls:** malformed final JSON now fails validation instead of running with partial
  arguments; invalid `\u` escapes no longer drop fields.
- **Other:** thinking no longer shown after the answer behind LiteLLM-style proxies; Mistral
  long thinking no longer cut by the request timeout; prompt-length price tiers counted;
  prompt submission no longer slows down with session length.

## 8. Adoption

### 8.1 Shipped with the uplift

| Item   | What                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | **Durations.** `tool_execution_end.durationMs` → the tool's trace step `duration` (persisted; the tool card already had a slot for it but looked up a step type that never exists); `AssistantMessage.durationMs` → `Message.executionTimeMs` (persisted) → "Response time: 4.1s" under each model reply. `src/main/claude/pi-durations.ts`, `src/renderer/utils/format-duration.ts`. |
| **T2** | **MCP error results.** A `CallToolResult` with `isError: true` is returned to pi as `{ …, isError: true }` (honoured since pi 0.99.0, `agent-loop.js:582`) instead of as a success. The timeout wrapper's `isError: true`, ignored by 0.87.1 (`agent-loop.js:556` there), now takes effect too.                                                                                       |

### 8.2 Backlog

| Item   | Feature                                                                                                          | Origin    | Effort | Risk               | Recommendation                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------- | --------- | ------ | ------------------ | ------------------------------------------------------------------------------------------ |
| **P**  | Permission gate on the public `tool_call` event (phase 0, extension-loading lock-down, done 2026-10-20)          | 1.3.0 gap | M      | Security — confirm | Phase 1 deferred; gate tests first (§8.3) — [design](./permission-gate-tool-call-event.md) |
| **S**  | Bash session-variable exposure policy                                                                            | 0.85 plan | S      | Low                | Yes                                                                                        |
| **A**  | Session usage totals via `getSessionStats()`                                                                     | 0.85 plan | S      | Low                | Yes                                                                                        |
| **B**  | Compaction failure / retry narration (`session_compact_failed`)                                                  | 0.85 plan | S      | Low                | Yes                                                                                        |
| **F**  | Edit-diff rendering                                                                                              | 0.85 plan | M      | Low                | Yes                                                                                        |
| **G**  | Waiting on a human as a distinct state                                                                           | 0.85 plan | S      | Low                | Diagnose first                                                                             |
| **D**  | Constrained tool sampling for MCP tools                                                                          | 0.85 plan | M      | Medium             | Re-scope: pi now falls back to non-strict for Anthropic by itself                          |
| **TS** | `tool_search` with MCP tools declared `deferred` — schemas stay out of the context until the model looks them up | 0.99.0    | M      | Medium             | **Not now** (decided 2026-10-21, §8.3)                                                     |
| **H**  | Provider-scoped `env` overrides                                                                                  | 0.80 plan | S      | Low                | Opportunistic                                                                              |
| **I**  | RPC extension-UI typed surface                                                                                   | 0.80 plan | S      | Low                | Opportunistic                                                                              |
| **X**  | Image generation / classifiers through `ModelRuntime.generateImages()` / `classify()`                            | 0.99.0    | L      | —                  | Later, if a feature asks                                                                   |

Details of S, A, B, D, F, G, H, I are unchanged from the archived plan; every surface they
consume still exists in 1.3.0 (`exposeSessionEnvironment`, `getSessionStats`,
`session_compact_failed`, `summarization_retry_*`, `ui_prompt_start`, `constrainedSampling`).

### 8.3 Decisions of 2026-10-21 — `tool_search` (TS) and gate phase 1 (P)

**`tool_search`: not now.** What it does (pi 1.3.0): tools given `exposure: 'deferred'` are
not declared to the model; the model gets one `tool_search` tool instead, which ranks the
not-yet-active searchable tools by their names and descriptions (BM25) and activates up to 8
matches for the next model call (`dist/extensions/tool-search/tool.js:12`, `:140-155`). It
runs no tool itself — the model then calls the found tools as ordinary top-level calls, so the
current gate sees them and TS does not depend on P. Why not now:

- The per-session and per-workspace MCP switches already keep unused servers out of a chat,
  and do so before `tool_search` could see them (off servers' tools are never passed to pi).
  On the author's machine (app log, 2026-10-18 to 10-21): 327 MCP tools configured, chats ran
  with 7–145 of them; where the log has the estimate, all tool schemas came to 2.2K–36K
  tokens per request.
- It costs every chat an extra model step (search, then call) and a chance that the model
  does not find the tool.
- The app runs its own MCP (`MCPManager`), not pi's MCP extension, which is what lists
  deferred servers in the system prompt; the app's own `<mcp_server_directory>` would have to
  do that, and today it ignores the session and workspace switches.

Revisit when a chat needs a large server whole (EODHD: 100 tools) but uses a few of its
tools — then as a per-server choice (`deferred` for large servers only), not for all. First
fix the switches for open chats: a cached pi session keeps the tools it was created with, so
turning a server off in an open chat did not reach its agent (found and fixed 2026-10-21,
`session-mcp-tools.ts`).

**Gate phase 1: deferred.** Nothing in the app makes nested calls (`ctx.executeTool()`); phase
1 is needed for codemode or an own tool that calls other tools, and neither is planned. Done
instead, next: move the gate body out of the runner into a module, unit-test every branch,
and add a session-level test on pi-ai's faux provider, keeping today's
`agent.beforeToolCall` install. That covers the risk that matters now: a pi uplift that
stops reading `agent.beforeToolCall` per run (`pi-agent-core/dist/agent.js:316`) would
disable every permission check silently — `before-tool-call-hook.ts` checks only that the
property exists. With that in place, phase 1 itself becomes a small change.

**Not recommended:** codemode and pi's own MCP (they duplicate `MCPManager`, their nested
calls bypass today's gate, and their worker and wasm are not next to the bundle); virtual
models (experimental); per-key OpenRouter model lists (need network inside
`ModelRuntime.create`, which the app turns off); `samplingParamsByThinkingLevel` (read only
from `models.json`, which the app does not use).

## 9. Testing & rollout

Automated: §1. Manual pass on a built app, per `AI_MAIN_PROCESS.md` §13 step 5 — new
session, tool use, session reuse, compaction trigger, permission prompt, stop/cancel, an
attached image — plus:

1. Switch model mid-conversation with thinking on; the new model's answer must not quote the
   old model's reasoning.
2. Diagnose Connection on Anthropic and on OpenAI (the app's own SDK calls on the new
   `@anthropic-ai/sdk` / `openai`).
3. An MCP tool that returns an error: red card, model told it failed. A tool card shows its
   duration; a model reply shows "Response time".
4. Kimi, if a key is available: chat and Diagnose Connection.
5. Providers tab: no Azure, no TypeSafe.

## 10. Open decisions

1. ~~**§6.2 compaction reserve.**~~ Withdrawn — the runner already caps such models (§6.2).
2. **Item P.** Phase 0 (loader lock-down, §6.4) approved and implemented 2026-10-20; phase 1
   deferred 2026-10-21 in favour of gate tests (§8.3).
3. **Release:** version, commit and the manual pass above.
