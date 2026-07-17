# Pi SDK 0.79–0.80 Feature Adoption — Design & Implementation Plan

**Created:** 2026-06-25
**Status:** Ready to implement — rebased onto the 0.80.10 baseline and all §8 questions
resolved on 2026-07-17 (except §4.2's, which is owned by its own investigation phase)
**Author:** AI-assisted design session
**Baseline:** **0.80.10** — `chore(deps): uplift pi-ai + pi-coding-agent 0.80.3 → 0.80.10`
(`eee3877`), landed. The original blocking dependency (the 0.78.1 → 0.80.2 uplift,
`c3509c3`) shipped on 2026-06-25; two further uplifts have landed since. Every feature
below assumes the **0.80.10** surface, not 0.80.2.
**Source of capabilities:** pi CHANGELOG 0.79.0 → 0.80.10
(`packages/coding-agent/CHANGELOG.md` in `github.com/earendil-works/pi`).

---

## 1. Overview

The 0.78.1 → 0.80.2 uplift (13 releases) shipped a number of SDK capabilities Open
Cowork can consume without forking pi. This plan turns the "Part 2 — new features"
analysis from the uplift session into a sequenced, codebase-grounded implementation
plan.

> **Rebase note (2026-07-17).** The baseline has moved to 0.80.10. The 0.80.8 model/auth
> rework did not merely extend this plan's assumptions — it changed some of them. §2's
> baseline is corrected, §5.3 is rewritten (the capability it wanted is now first-class,
> so the item gets _easier_), and §7 has one non-goal partly overtaken plus a new one
> derived from the SDK-only boundary. Nothing in T1 or T2 is invalidated.

Guiding principles (consistent with `ARCHITECTURE.md`):

- **Consume, never fork.** Every item is a pure consumer of a public SDK surface.
- **SDK-only, never the `pi` CLI's workflow.** See `ARCHITECTURE.md` §4.1. We consume the
  SDK, not the CLI agent's user config, catalogs, or network behavior. This rules some
  otherwise-attractive 0.80.8 capabilities out entirely — see §7.
- **One source of truth.** Where pi now exports a constant/helper we currently
  hand-roll (e.g. `CONFIG_DIR_NAME`, edit-diff helpers), adopt the export.
- **Additive and reversible.** Each feature is independently shippable; none is a
  prerequisite for another except where noted.
- **Security changes require explicit confirmation** (project-trust work, §4.2).

### Prioritization summary

| Tier   | Feature                                                                | SDK version          | Effort | Risk                |
| ------ | ---------------------------------------------------------------------- | -------------------- | ------ | ------------------- |
| **T1** | Compaction transparency — surface post-compaction token estimate       | 0.79.8               | S      | Low                 |
| **T1** | Prompt-cache hit visibility (CH)                                       | 0.79.0 + pi-ai usage | S–M    | Low                 |
| **T2** | `CONFIG_DIR_NAME` hardening                                            | 0.79.7               | S      | Low                 |
| **T2** | Native project-trust alignment (investigation → design)                | 0.79.0–0.79.1        | L      | **High (security)** |
| **T3** | Thinking-level surface — import the SDK type (§5.4 step 1)             | 0.80.6               | S      | Low                 |
| **T3** | Claude Fable 5 + refresh stale curation                                | 0.79.1–0.80.9        | S      | Low                 |
| **T3** | RPC extension UI typed surface                                         | 0.79.0               | S      | Low                 |
| **T3** | Provider/runtime config surface (httpProxy, Mistral cache, scoped env) | 0.79.5–**0.80.8**    | S–M    | Low                 |
| **T3** | Edit diff rendering via SDK helpers (reframed — see §4.1.3)            | 0.79.7               | M      | Low                 |

Recommended sequencing: **T1 first** (small, visible, low-risk wins that exercise the
new SDK in production), **T2 `CONFIG_DIR_NAME`** next (cleanup that reinforces §4.7),
**T2 project-trust** as its own investigation-led track (the only high-risk item), **T3**
opportunistically — starting with the two S items (§5.4 step 1 and the §5.1 curation
refresh), which are the cheapest and fix drift that already exists.

> **Rebase changes to this table (2026-07-17):** edit-diff helpers moved out of T2 into T3
> and grew to M — they are a feature, not a cleanup (§4.1.3). Thinking-level was added
> (§5.4). Provider/runtime config dropped from M to S–M (§5.3). Curation refresh is folded
> into the Fable 5 row, since it is the same edit (§5.1).

---

## 2. Dependency & baseline

- **Baseline met:** the blocking 0.80.2 uplift landed (`c3509c3`), followed by 0.80.3
  (`71c169c`) and 0.80.10 (`eee3877`). `estimatedTokensAfter`, the exported
  `CONFIG_DIR_NAME`, the edit-diff helpers, and the `project_trust` event are all present.
  No item below is dependency-blocked.
- **Version-lock churn happened anyway.** The original "all features stay on 0.80.2; no
  further bumps required" no longer holds — the tree is on **0.80.10**. `pi-ai` and
  `pi-coding-agent` remain version-locked to each other (`ARCHITECTURE.md` §4.1). Re-verify
  any capability below against 0.80.10 before building on it; the version column in the
  table records when a capability _appeared_, not the version we are on.
- **`/compat` caveat (still live):** value imports still route through
  `@earendil-works/pi-ai/compat`, which remains present but `@deprecated` in 0.80.10 and
  will be removed. None of the features below should add _new_ `/compat` imports — prefer
  the root entrypoint or `Models` methods. Partly overtaken by 0.80.8: `ModelRuntime`
  implements pi-ai's `Models`, so the shared runtime is already the post-`/compat` API.
  The remaining `/compat` users are `getModel`/`getModels` in `pi-model-resolution.ts` and
  `config-store.ts`, and `completeSimple` in `claude-sdk-one-shot.ts` /
  `memory-llm-client.ts`. Tracked separately.
- **SDK-only boundary is enforced in code.** `shared-auth.ts` constructs the shared
  `ModelRuntime` with `modelsPath: null` and `allowModelNetwork: false`. Any item below
  that wants dynamic catalogs, `models.json`, or pi.dev data conflicts with this and must
  be treated as a non-goal (§7), not an implementation detail.

---

## 3. Tier 1 — high-value, low-risk

### 3.1 Compaction transparency (post-compaction token estimate)

**SDK capability (0.79.8):** compaction-end events now carry
`estimatedTokensAfter?: number` (verified in
`pi-coding-agent/dist/.../*.d.ts`). The 0.79.10 `reason` / `willRetry` fields are
**already consumed** by Open Cowork.

**What we have today:**
[`agent-runner.ts:3990-4030`](../../src/main/claude/agent-runner.ts#L3990) handles
`compaction_start` / `compaction_end`, reading `event.reason`, `event.willRetry`,
`event.aborted`, `event.errorMessage`, and emitting a trace "thinking" step
("Compacting context (reason)…" → "Context compaction completed"). The
post-compaction size is **not** surfaced. Compaction settings are computed in
[`compaction-budget.ts`](../../src/main/claude/compaction-budget.ts) via
`selectCompactionSettings` ([`agent-runner.ts:3277`](../../src/main/claude/agent-runner.ts#L3277)).

**Change:** in the `compaction_end` handler, when `event.estimatedTokensAfter` is a
number and not aborted, append the estimate to the completed step title, e.g.
`Context compaction completed (~12k tokens)`, and feed the estimate into the ContextPanel
usage bar so the post-compaction drop shows immediately rather than waiting for the next
`message_end`.

**Phases:**

1. Surface the estimate in the trace step title (1 file, guarded on `typeof number`).
2. Bridge the estimate to the ContextPanel by emitting the existing
   `session.contextInfo` event from the `compaction_end` handler.

> **Decision (2026-07-17):** phase 2 is **in scope**, no longer "optional". The original
> question — "is it worth the extra IPC?" — rested on a false premise: there is no extra
> IPC. `session.contextInfo` already exists and is already emitted on a throttle
> (`CONTEXT_EMIT_INTERVAL_MS` / `CONTEXT_EMIT_MIN_DELTA`,
> [`agent-runner.ts:3616`](../../src/main/claude/agent-runner.ts#L3616)), consumed by
> [`useIPC.ts:347`](../../src/renderer/hooks/useIPC.ts#L347). Phase 2 reuses that channel;
> the cost is one emit on an event that fires rarely.

**Tests:** extend the agent-runner event-handling tests with a `compaction_end`
carrying `estimatedTokensAfter` (and one without, asserting graceful omission).

**Risk:** Low. Purely additive to an existing handler; field is optional.
**Effort:** Small.

### 3.2 Prompt-cache hit visibility ("CH")

**SDK capability (0.79.0 + pi-ai usage type):** pi's interactive footer shows the
latest prompt-cache hit rate ("CH"). The underlying data — `cacheRead`, `cacheWrite`,
`cacheWrite1h?` — lives on the pi-ai usage type (`pi-ai/dist/types.d.ts:251-254`) and
arrives on `message_end` usage.

**What we have today:**
[`context-usage.ts`](../../src/renderer/utils/context-usage.ts) computes a stacked
context-usage bar (conversation / tool-schema / output reservation) for the
[`ContextPanel`](../../src/renderer/components/ContextPanel.tsx). It does **not** model
cache reads/writes or a hit rate. `message_end` usage is consumed in
[`agent-runner.ts`](../../src/main/claude/agent-runner.ts#L3700) (around line 3700 /
3773).

**Change:** thread `cacheRead` / `cacheWrite` from `message_end` usage through the
existing usage payload to the renderer, compute a hit rate
(`cacheRead / (cacheRead + nonCachedInput)`), and display it as a small `CH NN%` chip in
the ContextPanel header, mirroring pi's footer. Cost transparency (cached vs fresh input)
is a natural extension since the usage type also carries per-segment `cost`.

> **Decision (2026-07-17):** **header chip**, not a tooltip or a per-message line. It is
> always visible, matches pi's footer, and the header is already a flex row
> (`px-3 h-10 flex items-center gap-2`,
> [`ContextPanel.tsx:1072`](../../src/renderer/components/ContextPanel.tsx#L1072)) — the
> chip drops in without relayout. A tooltip would hide the metric behind a hover; a
> per-message line would add noise to every turn.

**Phases:**

1. Main process: include `cacheRead`/`cacheWrite` in the usage object sent to the
   renderer on `message_end`. **Note:** `normalizeTokenUsage`
   ([`agent-runner.ts:556`](../../src/main/claude/agent-runner.ts#L556)) currently returns
   only `{ input, output }` and drops everything else — it is the choke point to widen.
2. Renderer: extend `context-usage.ts` with a pure `computeCacheHitRate(...)` + a
   small UI chip; unit-test the pure function (zero-division, no-cache, all-cache).

**Tests:** pure-function unit tests for the hit-rate math; a renderer source-grep or
render test that the chip appears when cache data is present.

**Risk:** Low. Display-only; no behavioral change to requests.
**Effort:** Small–Medium (mostly renderer plumbing).

---

## 4. Tier 2 — cleanup & alignment

### 4.1 `CONFIG_DIR_NAME` hardening + exported edit-diff helpers

**SDK capability (0.79.7):** `CONFIG_DIR_NAME` is exported from the coding-agent public
API (so extensions resolve project config paths without hardcoding `.pi`), along with
edit-diff helpers `generateDiffString`, `generateUnifiedPatch`, and the
`EditDiffResult` type.

**What we have today:**

- The pi bash extension already adopted `CONFIG_DIR_NAME` **defensively** with a `.pi`
  fallback ([`pi-extensions/bash-restrictions/config.ts:41-47`](../../pi-extensions/bash-restrictions/config.ts#L41)),
  written while still on a pre-0.79 SDK. Now that the toolchain is on 0.80.10, the
  constant is guaranteed present.
- **Correction (2026-07-17):** the original claim here — "the app/renderer renders
  edit-tool diffs with its own logic" — is **false**. There is no diff rendering at all.
  [`toolHelpers.tsx`](../../src/renderer/components/message/toolHelpers.tsx) (64 lines)
  maps `edit` to a pencil icon and the label `Edit <path>`, and
  [`ToolUseBlock.tsx:197`](../../src/renderer/components/message/ToolUseBlock.tsx#L197)
  renders the tool input as raw `JSON.stringify(block.input, null, 2)` in a `<pre>`. So
  the user sees escaped `old_string` / `new_string` blobs. No diff library is present in
  dependencies either.

**Change:**

1. **Bash extension:** keep the runtime fallback (the extension can be loaded by an
   older `pi` at the user's machine, so the guard stays correct) but update the comment
   to note 0.79+ is now the floor, and add a test asserting the exported constant is
   honored when present. Low-churn; mostly documentation accuracy for §4.7.
2. **App-side:** grep for hardcoded `.pi` / config-dir assumptions in the main process
   and, where they refer to _pi's_ config dir, source them from the exported constant
   (via the same namespace-import pattern). Out-of-scope: Open Cowork's _own_ `.cowork`
   workspace dir, which is independent of pi's.
3. **Edit-diff helpers — reframed (2026-07-17):** this is **not** a cleanup swapping our
   diff for pi's; it is a **readability feature**, because we render no diff today (see
   the correction above). Use `generateUnifiedPatch` / `generateDiffString` to show what
   an `edit` actually changed, instead of a raw JSON blob of escaped strings. The SDK
   export means we get this **without adding a diff library** to dependencies.

   The original framing ("only adopt if it reduces code without regressing the current
   UI") does not apply — there is no code to reduce and no diff UI to regress. It will
   _add_ code; the question is whether the UX win justifies it. Sizing changes from a
   Small–Medium spike to a Medium feature, and it no longer belongs in T2 "cleanup" —
   propose moving it to T3 or splitting it into its own item when picked up.

**Risk:** Low. **Effort:** Small (items 1–2); Medium for item 3 (now a feature, not a
swap).

### 4.2 Native project-trust alignment (investigation-led)

> **Security-sensitive — requires explicit confirmation before any code change.**

**SDK capability (0.79.0–0.79.1):**

- `project_trust` extension event — global/CLI extensions can decide/remember/defer
  trust before project-local resources load.
- `ctx.isProjectTrusted()` — observe the effective trust decision (incl. temporary).
- `defaultProjectTrust` global setting — ask / always-trust / never-trust default.

**What we have today (parallel, app-owned trust surfaces):**

- The bash extension's **project trust gate** (§4.7) — only honors project-scoped
  `.pi/bash-restrictions.json` for trusted projects.
- [`before-tool-call-hook.ts`](../../src/main/claude/before-tool-call-hook.ts),
  [`mcp-tool-permissions.ts`](../../src/main/mcp/mcp-tool-permissions.ts),
  [`mcp-workspace-profile.ts`](../../src/main/mcp/mcp-workspace-profile.ts),
  [`sandbox-adapter.ts`](../../src/main/sandbox/sandbox-adapter.ts), and
  permission-rules handling — each encodes its own notion of trust/permission.

**Problem:** Open Cowork maintains multiple parallel trust/permission mechanisms that
pi now models natively. Aligning could remove duplication and give one coherent trust
story — but trust is a security boundary, so this is **investigation-first**, not a
mechanical refactor.

**Phases:**

1. **Investigation (no code):** map every place OC makes a trust/permission decision
   vs. what pi's `project_trust` / `ctx.isProjectTrusted()` / `defaultProjectTrust`
   now cover. Produce a gap analysis: what pi covers, what is genuinely OC-specific
   (GUI permission dialogs, sandbox boundaries, MCP routing), and what is redundant.
2. **Design doc (separate):** propose a target architecture — e.g. OC's GUI permission
   layer _delegates_ the project-trust decision to pi's native event while keeping its
   own per-tool gating. Explicitly enumerate the security invariants that must not
   regress (path containment, sandbox boundaries, MCP host-only spawns).
3. **Implementation:** only after the design is approved. Behind a flag; extensive
   tests; security review.

**Risk:** **High** (security boundary). **Effort:** Large. Treat as its own epic.

---

## 5. Tier 3 — opportunistic

### 5.1 Claude Fable 5 + new model coverage (0.79.1 → 0.80.10)

**Capability:** Claude Fable 5 (Anthropic + Bedrock, adaptive thinking, `xhigh`),
plus GLM-5.2 routing fixes, MiniMax-M3, NVIDIA NIM, Mistral. The rebase adds more:
Claude Sonnet 5 (0.80.3), Fable 5 `xhigh`/`max` across generated catalogs (0.80.7), and
Kimi K3 + Grok 4.5 (0.80.9).

**What we have today:** model presets are built in
[`config-store.ts`](../../src/main/config/config-store.ts) — `PROVIDER_PRESETS`
overlaid with registry data via the (now `/compat`) dynamic `getModels` import and a
`PI_AI_CURATED` curation map (`getPiAiModelPresets`,
[`config-store.ts:469`](../../src/main/config/config-store.ts#L469)); the map itself lives
in [`api-model-presets.ts:145`](../../src/shared/api-model-presets.ts#L145).

The curated lists are **visibly stale**: OpenRouter picks still top out at
`anthropic/claude-opus-4-6` / `claude-sonnet-4-6` and `openai/gpt-5.4` — no Opus 4.8, no
Sonnet 5, no Fable 5. Native catalog entries are data-driven and surface new registry
models automatically (as the 0.80.3 uplift noted for Sonnet 5 and gpt-5.5); the curated
aggregator lists are hand-maintained and do not.

**Change:** refresh the curation map with currently-relevant model IDs. Drop the original
"confirm adaptive-thinking / `xhigh` options propagate" check — it is moot given the §5.4
decision, because the app hardcodes `medium`/`off` and never selects `xhigh`. Mostly data
plus a verification pass.

> **Decision (2026-07-17):** **refresh once, and add a curation check to the uplift
> checklist** — do not try to make aggregator lists data-driven. Measured on 0.80.10, the
> built-in catalog holds **1072** models: OpenRouter alone has **271**, vercel-ai-gateway
> 190, amazon-bedrock 109. A pick-list is therefore load-bearing UX, not tech debt — the
> picker cannot show 271 entries. The cost is that these lists rot silently between
> uplifts, which is exactly what happened here; the mitigation is a checklist item (§6),
> not an architecture change. A hybrid ("recommended" + a searchable "show all 271") was
> considered and deferred as a Medium UI feature.

**Note:** 0.80.9 removed Grok 3, Grok 3 Fast, Grok 4.20 variants, and Grok Code Fast 1
from the built-in xAI catalog. Verified as a non-issue — no xAI/Grok entries exist in the
curation map or presets.

**Risk:** Low. **Effort:** Small.

### 5.2 RPC extension UI typed surface (0.79.0)

**Capability:** RPC extension UI request/response types are now exported from the
public API.

**What we have today:** the IPC/RPC bridge and
[`agent-runtime-extension.ts`](../../src/main/extensions/agent-runtime-extension.ts)
use OC's own interfaces. Adopting the exported types where the bridge mirrors pi's
extension-UI protocol improves type-safety and reduces drift.

**Risk:** Low. **Effort:** Small (types-only).

### 5.3 Provider/runtime config surface

> **Rewritten on the 0.80.10 rebase.** This item was written against an API that no longer
> exists, and 0.80.8 made its main goal first-class — so it is now _smaller_ than
> originally scoped, not larger.

**Capabilities:** global `httpProxy` setting (0.79.5), provider-scoped `env` overrides
(0.79.5, reshaped by 0.80.8), Mistral prompt caching (0.79.8), OpenRouter Fusion alias
(0.79.8).

**What we have today:** provider/auth config in
[`config-store.ts`](../../src/main/config/config-store.ts),
[`auth-utils.ts`](../../src/main/config/auth-utils.ts), and runtime key injection via
`ModelRuntime.setRuntimeApiKey`
([`claude-sdk-one-shot.ts:236`](../../src/main/claude/claude-sdk-one-shot.ts#L236), plus
the ref-counted tracker in [`agent-runner.ts`](../../src/main/claude/agent-runner.ts)).

**What 0.80.8 changed:** request-auth assembly moved from
`ModelRegistry.getApiKeyAndHeaders()` to `ModelRuntime.getAuth()`, which accepts
`ModelRuntimeAuthOverrides` — `{ apiKey?, env? }`. Provider-scoped `env` is therefore no
longer something to plumb by hand: it is a parameter on a call we already make. Passing a
provider ID returns provider-scoped auth; passing a model also resolves built-in,
`models.json`, and extension model headers.

**Change:** expose `httpProxy` in OC settings for corporate-proxy users; surface
provider-scoped `env` via `ModelRuntimeAuthOverrides` where OC writes auth config. Mistral
caching is automatic on the current baseline — verify cost accounting flows into the
cache-hit display (§3.2).

**Gotcha (verified against 0.80.10):** `getAuth()` returns `{ auth: { apiKey, ... }, source }`
— the credential is nested under `.auth`, not top-level. `getProviderAuthStatus()` reports
`{ configured: true, source: 'runtime' }` for runtime-injected keys.

**Caveat:** the `env` overrides here are provider-scoped request auth, **not** pi's
`auth.json` workflow. We read auth via the SDK; we do not adopt the CLI's credential
management (§7).

**Risk:** Low. **Effort:** Small–Medium (settings UI + i18n) — down from Medium now that
`env` is a parameter rather than plumbing.

### 5.4 Thinking-level surface — `max` + drop the hand-rolled union (0.80.6)

**Capability:** 0.80.6 added an opt-in `max` thinking level above `xhigh` (natively on
GPT-5.6 and adaptive Claude models) across CLI, SDK, RPC, and model selection; themes can
define `thinkingMax`. 0.80.7 extended native `xhigh`/`max` to Claude Fable 5 across
generated provider catalogs.

**What we have today:**
[`agent-runner.ts:2871`](../../src/main/claude/agent-runner.ts#L2871) hand-rolls the union
and then uses almost none of it:

```ts
type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
const thinkingLevel: PiThinkingLevel = enableThinking ? 'medium' : 'off';
```

Thinking is a boolean in the UI — on → `medium`, off → `off`. The other four levels are
unreachable.

**Change:** two independent steps.

1. **Type hygiene (S).** pi-ai exports
   `ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
   (`pi-ai/dist/types.d.ts:22-23`). The local union is exactly that type minus `max` — it
   has _already_ drifted. Import it instead. Same "one source of truth" move as
   `CONFIG_DIR_NAME` in §4.1, and worth doing on its own even if step 2 never happens.
2. **UX (M) — deferred.** Actually expose the levels in the UI.

> **Decision (2026-07-17):** **step 1 only.** Import the SDK type; keep the on/off toggle.
> Step 1 stands on its own — it fixes a union that has already drifted, and costs nothing.
> Step 2 is deferred, not rejected: it needs per-model capability clamping (not every model
> supports `max`/`xhigh`) plus i18n across four locales, which is a real feature, not a
> by-product of an uplift. Revisit if users ask for finer control.

**Risk:** Low. **Effort:** Small (step 1 only, as decided).

---

## 6. Cross-cutting testing & rollout

- **Unit-first:** every pure computation (cache-hit rate, post-compaction display
  formatting) gets a pure function + vitest, consistent with `context-usage.ts` /
  `compaction-budget.ts` conventions.
- **Event-shape tests:** T1 items assert graceful handling when the new optional fields
  are absent (defensive against provider variance).
- **Manual smoke:** T1/T3 need one real app run (launch, send a turn, trigger
  compaction on a long thread, observe CH + post-compaction estimate).
- **Security gate:** §4.2 cannot merge without a design doc + security review.
- **Uplift checklist — model curation (added 2026-07-17):** every pi SDK uplift must
  re-check `PI_AI_CURATED_PRESETS`
  ([`api-model-presets.ts:145`](../../src/shared/api-model-presets.ts#L145)) against the
  new catalog: add newly-relevant models, and confirm nothing picked was removed upstream
  (0.80.9 dropped Grok 3 / Grok 4.20 / Grok Code Fast 1 — harmless for us only because we
  curate no xAI models). Native catalog entries update themselves; these lists do not.
  This is the agreed mitigation for §5.1's rot.
- **Docs:** on landing each tier, update `ARCHITECTURE.md` §4.x / stability table and
  cross-link this plan, mirroring how §4.7/§4.8 were documented.

---

## 7. Non-goals

- **Dynamic model catalogs and pi.dev data (0.80.8) — deliberately unused.** Live `/model`
  background refresh, `ModelRuntime.refresh()` / pi-ai `Models.refresh()`, file-backed
  catalogs in `models-store.json`, per-provider pi.dev overlays, Radius gateway support,
  and `pi update --models` are all out of scope **by architecture, not by priority**.
  `shared-auth.ts` constructs the shared runtime with `allowModelNetwork: false` and
  `modelsPath: null`; adopting any of these would breach the SDK-only boundary
  (`ARCHITECTURE.md` §4.1), re-couple the app to the pi CLI's config, and reintroduce
  network calls on every `setRuntimeApiKey()`. The app's native provider catalog is the
  source of truth. **If a future item seems to need these, that is a signal to revisit the
  boundary explicitly — not to flip the flags.**
- **Provider-owned `/login` and extension OAuth `modifyModels` (0.80.8).** pi's provider
  login discovery and ambient-auth flows are CLI-shaped. OC owns its credential UI and
  injects keys at runtime.
- Migrating off the `/compat` entrypoint to `createModels()` (tracked with the uplift, not
  here). **Partly overtaken:** `ModelRuntime` implements pi-ai's `Models`, so the shared
  runtime is already on the post-`/compat` API — see §2 for the remaining callers.
- TUI-only capabilities with no GUI analog (e.g. `Ctrl+J` newline keybinding,
  terminal theme auto-detection, OSC 8 hyperlinks, `Ctrl+X` transcript copy).
- Reworking Open Cowork's own `.cowork` workspace-config system (independent of pi's
  `CONFIG_DIR_NAME`).

---

## 8. Decisions

All questions opened with this plan were resolved on **2026-07-17**, during the 0.80.10
rebase. Each decision is recorded inline in the relevant section; this is the index.

| #   | Question                   | Decision                                                    | §        |
| --- | -------------------------- | ----------------------------------------------------------- | -------- |
| 1   | CH placement               | **Header chip** in ContextPanel, mirroring pi's footer      | §3.2     |
| 2   | Compaction estimate bridge | **In scope** — reuses the existing `session.contextInfo`    | §3.1     |
| 3   | Project-trust scope        | **Deferred by design** — it is phase 1's output             | §4.2     |
| 4   | Edit-diff helpers          | **Reframed** — a readability feature, not a cleanup swap    | §4.1.3   |
| 5   | Thinking levels            | **Step 1 only** — import the SDK type, keep the on/off UI   | §5.4     |
| 6   | Curation freshness         | **Refresh once** + a curation check in the uplift checklist | §5.1, §6 |

Two of these were resolved by reading the code rather than by preference, and both turned
out to rest on false premises:

- **#2** asked whether the bridge was "worth the extra IPC". There is no extra IPC —
  `session.contextInfo` already exists and already emits on a throttle.
- **#4** asked whether "the current renderer diff" was good enough to leave alone. There is
  no current diff: edit inputs render as raw JSON. The item is a feature, not a swap.

**#3 is not answered here on purpose.** §4.2 is explicitly investigation-first: "does
alignment _replace_ OC's trust surfaces or only _delegate_ the project-trust decision" is
the deliverable of its phase-1 gap analysis, not an input to it. Answering it from the
armchair — on a security boundary — is exactly the failure mode that section is structured
to avoid. It stays open, owned by §4.2 phase 1.

**Newly opened by the rebase** (tracked in `docs/design/test-verification-gaps.md`, not
here): whether to adopt `@electron/rebuild`, which install scripts to approve under npm 12,
and whether `shared-auth.ts` should actively detect a second `ModelRuntime` construction.
