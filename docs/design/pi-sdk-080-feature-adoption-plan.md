# Pi SDK 0.79–0.80 Feature Adoption — Design & Implementation Plan

**Created:** 2026-06-25
**Status:** Draft
**Author:** AI-assisted design session
**Depends on:** `chore(deps): uplift pi-ai + pi-coding-agent 0.78.1 → 0.80.2` (branch
`chore/uplift-pi-sdk-0.80.2`) — **must land first**; every feature below assumes the
0.80.2 SDK surface.
**Source of capabilities:** pi CHANGELOG 0.79.0 → 0.80.2
(`packages/coding-agent/CHANGELOG.md` in `github.com/earendil-works/pi`).

---

## 1. Overview

The 0.78.1 → 0.80.2 uplift (13 releases) shipped a number of SDK capabilities Open
Cowork can consume without forking pi. This plan turns the "Part 2 — new features"
analysis from the uplift session into a sequenced, codebase-grounded implementation
plan.

Guiding principles (consistent with `ARCHITECTURE.md`):

- **Consume, never fork.** Every item is a pure consumer of a public SDK surface.
- **One source of truth.** Where pi now exports a constant/helper we currently
  hand-roll (e.g. `CONFIG_DIR_NAME`, edit-diff helpers), adopt the export.
- **Additive and reversible.** Each feature is independently shippable; none is a
  prerequisite for another except where noted.
- **Security changes require explicit confirmation** (project-trust work, §5.3).

### Prioritization summary

| Tier   | Feature                                                                | SDK version          | Effort | Risk                |
| ------ | ---------------------------------------------------------------------- | -------------------- | ------ | ------------------- |
| **T1** | Compaction transparency — surface post-compaction token estimate       | 0.79.8               | S      | Low                 |
| **T1** | Prompt-cache hit visibility (CH)                                       | 0.79.0 + pi-ai usage | S–M    | Low                 |
| **T2** | `CONFIG_DIR_NAME` hardening + exported edit-diff helpers               | 0.79.7               | S      | Low                 |
| **T2** | Native project-trust alignment (investigation → design)                | 0.79.0–0.79.1        | L      | **High (security)** |
| **T3** | Claude Fable 5 + new models in picker                                  | 0.79.1               | S      | Low                 |
| **T3** | RPC extension UI typed surface                                         | 0.79.0               | S      | Low                 |
| **T3** | Provider/runtime config surface (httpProxy, Mistral cache, scoped env) | 0.79.5–0.79.8        | M      | Low                 |

Recommended sequencing: **T1 first** (small, visible, low-risk wins that exercise the
new SDK in production), **T2 `CONFIG_DIR_NAME`/diff helpers** next (cleanup that
reinforces §4.7), **T2 project-trust** as its own investigation-led track (the only
high-risk item), **T3** opportunistically.

---

## 2. Dependency & baseline

- **Hard dependency:** the 0.80.2 uplift commit. Until merged, `estimatedTokensAfter`,
  the exported `CONFIG_DIR_NAME`, the edit-diff helpers, and the `project_trust` event
  are not guaranteed present.
- **No version-lock churn:** all features stay on 0.80.2; no further bumps required.
- **`/compat` caveat:** the uplift routes moved value imports through
  `@earendil-works/pi-ai/compat`, which pi will remove in a future release. None of the
  features below should add _new_ `/compat` imports — prefer the root entrypoint and the
  new `createModels()` factory where a value import is unavoidable. Tracked separately.

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
`Context compaction completed (~12k tokens)`. Optionally feed the estimate into the
ContextPanel usage bar so the post-compaction drop is reflected immediately rather
than waiting for the next `message_end`.

**Phases:**

1. Surface the estimate in the trace step title (1 file, guarded on `typeof number`).
2. (Optional) Bridge the estimate to the renderer ContextPanel usage display via the
   existing trace/IPC channel so the bar updates on compaction, not just on next turn.

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
(`cacheRead / (cacheRead + nonCachedInput)`), and display it — either as a small "CH
NN%" chip in the ContextPanel header (mirroring pi's footer) or as a tooltip on the
usage bar. Cost transparency (cached vs fresh input) is a natural extension since the
usage type also carries per-segment `cost`.

**Phases:**

1. Main process: include `cacheRead`/`cacheWrite` in the usage object sent to the
   renderer on `message_end`.
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
  written while still on a pre-0.79 SDK. Now that the toolchain is pinned to 0.80.2, the
  constant is guaranteed present.
- The app/renderer renders edit-tool diffs with its own logic (no use of the exported
  helpers).

**Change:**

1. **Bash extension:** keep the runtime fallback (the extension can be loaded by an
   older `pi` at the user's machine, so the guard stays correct) but update the comment
   to note 0.79+ is now the floor, and add a test asserting the exported constant is
   honored when present. Low-churn; mostly documentation accuracy for §4.7.
2. **App-side:** grep for hardcoded `.pi` / config-dir assumptions in the main process
   and, where they refer to _pi's_ config dir, source them from the exported constant
   (via the same namespace-import pattern). Out-of-scope: Open Cowork's _own_ `.cowork`
   workspace dir, which is independent of pi's.
3. **Edit-diff helpers (optional):** evaluate replacing bespoke diff rendering for the
   edit tool with `generateUnifiedPatch` / `generateDiffString` for parity with pi's
   own output. Spike first — only adopt if it reduces code without regressing the
   current UI.

**Risk:** Low. **Effort:** Small (items 1–2); Small–Medium spike for item 3.

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

### 5.1 Claude Fable 5 + new model coverage (0.79.1)

**Capability:** Claude Fable 5 (Anthropic + Bedrock, adaptive thinking, `xhigh`),
plus GLM-5.2 routing fixes, MiniMax-M3, NVIDIA NIM, Mistral.

**What we have today:** model presets are built in
[`config-store.ts`](../../src/main/config/config-store.ts) — `PROVIDER_PRESETS`
overlaid with registry data via the (now `/compat`) dynamic `getModels` import and a
`PI_AI_CURATED` curation map (`getPiAiModelPresets`,
[`config-store.ts:387`](../../src/main/config/config-store.ts#L387)).

**Change:** add Fable 5 (and any newly-relevant model IDs) to the curation map so they
surface in the model picker; confirm adaptive-thinking / `xhigh` options propagate.
Mostly data + a verification pass.

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

**Capabilities:** global `httpProxy` setting (0.79.5), provider-scoped `auth.json`
`env` overrides (0.79.5), Mistral prompt caching (0.79.8), OpenRouter Fusion alias
(0.79.8).

**What we have today:** provider/auth config in
[`config-store.ts`](../../src/main/config/config-store.ts),
[`auth-utils.ts`](../../src/main/config/auth-utils.ts), and runtime key injection via
`AuthStorage.setRuntimeApiKey` ([`claude-sdk-one-shot.ts:234`](../../src/main/claude/claude-sdk-one-shot.ts#L234)).

**Change:** expose `httpProxy` in OC settings for corporate-proxy users; surface
provider-scoped `env` where OC writes auth config. Mistral caching is automatic once on
0.80.2 — verify cost accounting flows into the new cache-hit display (§3.2).

**Risk:** Low. **Effort:** Medium (settings UI + i18n).

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
- **Docs:** on landing each tier, update `ARCHITECTURE.md` §4.x / stability table and
  cross-link this plan, mirroring how §4.7/§4.8 were documented.

---

## 7. Non-goals

- Migrating off the `/compat` entrypoint to `createModels()` (tracked with the uplift,
  not here).
- TUI-only capabilities with no GUI analog (e.g. `Ctrl+J` newline keybinding,
  terminal theme auto-detection, OSC 8 hyperlinks).
- Reworking Open Cowork's own `.cowork` workspace-config system (independent of pi's
  `CONFIG_DIR_NAME`).

---

## 8. Open questions

1. **CH placement:** header chip vs. usage-bar tooltip vs. per-message cost line — needs
   a quick UX decision (§3.2).
2. **Compaction estimate bridging:** is updating the ContextPanel bar on
   `compaction_end` worth the extra IPC, or is the trace-step title sufficient (§3.1)?
3. **Project-trust scope:** does alignment aim to _replace_ OC's trust surfaces or only
   _delegate the project-trust decision_ while keeping GUI permission gating (§4.2)?
4. **Edit-diff helpers:** adopt for parity, or is the current renderer diff good enough
   to leave alone (§4.1.3)?
   </content>
   </invoke>
