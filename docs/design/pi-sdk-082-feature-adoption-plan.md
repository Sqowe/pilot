# Pi SDK 0.81–0.82 Feature Adoption — Design & Implementation Plan

**Created:** 2026-07-24
**Status:** Proposed — not started. Four items, each independently shippable.
**Author:** AI-assisted design session
**Baseline today:** **0.80.10** — both `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` are pinned there (`package.json:84-85`).
**Depends on:** the **0.82.0 uplift** landing first. Every item below consumes a
surface that appears in 0.81.0, 0.81.1, or 0.82.0. None can be built on 0.80.10.
See §2.
**Source of capabilities:** pi CHANGELOG entries for
[0.81.0], [0.81.1], [0.82.0] (verified against the installed 0.82.0 tarball's
`dist/` type declarations and `docs/`, not the changelog prose alone).

> **Sibling doc.** This continues the pattern of
> [`pi-sdk-080-feature-adoption-plan.md`](./pi-sdk-080-feature-adoption-plan.md) —
> a sequenced, codebase-grounded adoption plan for one uplift's worth of new SDK
> surface. That doc covered 0.79–0.80; this one covers 0.81–0.82. The
> [`thinking-level-per-model.md`](./thinking-level-per-model.md) design was
> extracted from the earlier plan the same way an item here might later be.

---

## 1. Overview

The 0.80.10 → 0.82.0 uplift (0.81.0, 0.81.1, 0.82.0) exposes four SDK capabilities
Open Cowork can consume without forking pi. This plan turns the "Worth adopting
deliberately" shortlist from the uplift analysis into sequenced, grounded work.

Guiding principles (unchanged from the sibling plan, consistent with
`ARCHITECTURE.md`):

- **Consume, never fork.** Every item is a pure consumer of a public SDK surface.
- **SDK-only, never the `pi` CLI's workflow** (`ARCHITECTURE.md` §4.1). We consume
  the SDK, not the CLI agent's user config, catalogs, or terminal UI.
- **Additive and reversible.** Each item is independently shippable; none is a
  prerequisite for another.
- **Security changes require explicit confirmation.** Item C touches what a
  model-invoked bash command can see about the session; Item D touches how tool
  arguments are constrained. Both get their security review below, not a hand-wave.

### Prioritization summary

| Item  | Feature                                                | SDK version   | Effort | Risk                     | Recommended |
| ----- | ------------------------------------------------------ | ------------- | ------ | ------------------------ | ----------- |
| **A** | Usage accounting for compaction, branch summary, tools | 0.81.0→0.82.0 | S–M    | Low                      | Yes         |
| **B** | Summary-retry progress in the compaction trace step    | 0.81.1        | S      | Low                      | Yes         |
| **C** | Session variables for the built-in bash tool           | 0.82.0        | S      | **Medium (surface)**     | Conditional |
| **D** | Constrained (strict-schema) tool sampling              | 0.82.0        | M      | **Medium (correctness)** | Investigate |

Recommended sequencing: **B first** (smallest, purely additive UI polish that
exercises the new event stream), **A second** (visible value — stops undercounting
spend), **C** only after its surface question is answered (§5.4), **D** as an
investigation that may or may not conclude in a change (§6.5).

---

## 2. Dependency & baseline

- **Blocked on the uplift.** We are on 0.80.10 for both packages
  (`package.json:84-85`). `pi-ai` and `pi-coding-agent` are version-locked to each
  other (`ARCHITECTURE.md` §4.1), so the uplift bumps both to 0.82.0 together. The
  uplift itself was assessed separately and judged low-risk: every symbol we import
  survives unchanged. That assessment is the precondition for this plan, not part
  of it.
- **Per-item version attribution** (when the capability _appeared_, not the version
  we will be on — which is 0.82.0 for all four):
  - Item A: usage accounting for tools/compaction/branch summaries landed in
    **0.81.0** (`#6671`); the entry-level `usage` fields and `CompactionResult.usage`
    are documented and typed as of **0.82.0**.
  - Item B: the resilient-summarization retry events landed in **0.81.1** (`#6901`).
  - Item C: the bash-tool session environment landed in **0.82.0**.
  - Item D: constrained tool sampling landed in **0.82.0**.
- **`/compat` caveat (still live).** Value imports still route through
  `@earendil-works/pi-ai/compat`, verified present in 0.82.0
  (`pi-ai-0.82.0/dist/compat.d.ts`). None of the items below add a new value import
  from the pi-ai root, so this caveat does not grow.

---

## 3. Item A — Usage accounting for compaction, branch summary, and tools

### 3.1 What pi added

Three usage sources that were previously invisible to consumers are now reported:

- **Compaction summary usage.** `CompactionResult` gained
  `usage?: Usage` — _"Usage from the LLM call(s) that generated this summary"_
  (`pi-0.82.0/dist/core/compaction/compaction.d.ts:23-24`). This object is reachable
  from the event we already handle: `compaction_end` carries
  `result: CompactionResult | undefined`
  (`pi-0.82.0/dist/core/agent-session.d.ts:65-67`).
- **Branch-summary usage.** `BranchSummaryEntry.usage?: Usage` and the persisted
  compaction entry's `usage` field, both _"included in session token and cost
  totals"_ (`docs/session-format.md`, and
  `dist/core/session-manager.d.ts` — `appendCompaction(...)` and
  `branchWithSummary(...)` both gained a trailing `usage?: Usage` parameter).
- **Tool-execution usage.** `ToolResultMessage.usage?: Usage` —
  _"Usage from the tool execution itself, if available. **Not part of main LLM
  context accounting.**"_ (`pi-ai-0.82.0/dist/types.d.ts:293-299`). This is for tools
  that themselves call an LLM. In our app that is the memory tools and the
  chat-search tool — nested LLM work whose cost is currently unattributed.

The changelog summary: _"Tool, compaction, and branch-summary usage is persisted
and included in session totals"_ (0.81.0, `#6671`).

### 3.2 What we do today

We normalize usage in exactly one place — the `message_end` handler — and attach it
to the assistant message:

```ts
// src/main/claude/agent-runner.ts:3957-3978 (message_end)
const msgWithUsage = msg as { usage?: unknown };
const tokenUsage = normalizeTokenUsage(msgWithUsage.usage);
// ...
const assistantMsg: Message = { /* ... */ tokenUsage };
```

`normalizeTokenUsage` (`src/main/claude/token-usage-utils.ts:39`) is a pure helper
that copes with the three provider key-naming variants. It is the right funnel for
any new usage source.

Two gaps:

1. **The `compaction_end` handler ignores usage.** It reads
   `event.result?.estimatedTokensAfter` for the ContextPanel bar but never touches
   `event.result?.usage` (`src/main/claude/agent-runner.ts:4049-4090`). The tokens a
   compaction _spends_ generating its summary are silently dropped.
2. **No tool-execution usage is captured.** Our MCP tool wrapper
   (`buildMcpCustomTools`, `agent-runner.ts:451-484`) and memory tools return
   `{ content, details }` and never surface a `usage` field to the renderer.

There is no renderer-side "session total tokens/cost" surface today (searched: no
`sessionStats` / cumulative-usage aggregator in `src/renderer`). The ContextPanel
shows the _current context window_ fill, not a running spend total. So Item A's
value is realized only if we also decide where a running total should live.

### 3.3 Proposed change

Split into two independently shippable steps:

- **A1 — capture compaction summary usage (small).** In the `compaction_end`
  handler, feed `event.result?.usage` through `normalizeTokenUsage` and thread it to
  the same channel `message_end` uses. Lowest-effort, most-defensible: it stops the
  most expensive background LLM call in the app (summarizing a full context window)
  from being counted as free.
- **A2 — surface a running session total (medium).** Introduce a per-session usage
  accumulator in the main process (agent-runner already owns session lifecycle),
  summing assistant-message usage + compaction usage + tool usage, and expose it over
  the existing session IPC channel for a renderer "session spend" readout. This is the
  larger, optional half — it is a genuine feature, not a cleanup, and should not
  block A1.

### 3.4 Effort / risk

S for A1, M for A2. Risk Low: usage fields are all optional (`usage?`), so absent
data degrades to "counted as zero", exactly as today. No security surface.

### 3.5 Open questions

- Does the persisted pi session (`SessionManager`) _already_ fold compaction and
  branch-summary usage into a total we can read back, making A2 a read rather than a
  re-implementation? The 0.81.0 changelog mentions "session statistics" — verify
  whether `SessionManager` exposes a totals accessor before building our own
  accumulator.
- Should tool-execution usage (memory/chat-search nested LLM calls) be shown
  separately from model usage? pi deliberately keeps it _out_ of main context
  accounting; mirroring that separation avoids double-counting.

---

## 4. Item B — Summary-retry progress in the compaction trace step

### 4.1 What pi added

0.81.1 made compaction and branch-summary generation retry transient provider
failures instead of failing outright, and exposed the retry lifecycle as three
session-stream events
(`pi-0.82.0/dist/core/agent-session.d.ts:83-97`):

```ts
{
  type: 'summarization_retry_scheduled';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}
{
  type: 'summarization_retry_attempt_start';
  source: 'branchSummary';
}
{
  type: 'summarization_retry_attempt_start';
  source: 'compaction';
  reason: 'manual' | 'threshold' | 'overflow';
}
{
  type: 'summarization_retry_finished';
}
```

The SDK docs list them among the handled event `case`s
(`docs/sdk.md`, the three new cases added to the example switch).

### 4.2 What we do today

Our subscribe callback switches on `event.type`
(`src/main/claude/agent-runner.ts:3763`). It has **no `default:` case and no
exhaustiveness assertion** — unknown event types fall through the switch untouched
(verified: the switch closes at `agent-runner.ts:4100` with no default). So after the
uplift these three events already arrive and are already safely ignored. Nothing
breaks; nothing is shown either.

Our compaction trace is a single step tracked by one id:

```ts
// compaction_start → create step (agent-runner.ts:4036-4047)
compactionStepId = `compaction-${Date.now()}`;
this.sendTraceStep(session.id, {
  id: compactionStepId,
  type: 'thinking',
  status: 'running',
  title: `Compacting context (${event.reason})...` /* ... */,
});
// compaction_end → resolve step (agent-runner.ts:4049-4090)
```

Between start and end, a retrying summary looks stalled — the step sits at
"running" with no indication that pi is waiting out a backoff.

### 4.3 Proposed change

Add three `case`s to the existing switch that update the _existing_
`compactionStepId` step's title (no new step, no new IPC channel):

- `summarization_retry_scheduled` → title like
  `Compacting context — retry ${attempt}/${maxAttempts} in ${delayMs}ms…`
- `summarization_retry_attempt_start` (source `"compaction"`) → back to
  `Compacting context (${reason})…`
- `summarization_retry_finished` → leave the step; `compaction_end` still resolves it.

The `"branchSummary"` source has no trace step today; either ignore it (keep scope
tight) or add a minimal one. Recommend ignoring it in the first cut.

### 4.4 Effort / risk

S. A few lines in a switch we already own. Risk Low — purely additive UI text on an
already-additive event stream; if pi renames a field the worst case is a stale title,
not a crash.

---

## 5. Item C — Session variables for the built-in bash tool

### 5.1 What pi added

0.82.0 injects current session/model metadata into commands run by the built-in
(and `createBashTool`-created) bash tool
(`pi-0.82.0/docs/environment-variables.md`):

| Variable             | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `PI_SESSION_ID`      | Current session ID                                                   |
| `PI_SESSION_FILE`    | **Absolute path** to the session JSONL; unset for ephemeral sessions |
| `PI_PROVIDER`        | Selected model provider                                              |
| `PI_MODEL`           | Selected model ID                                                    |
| `PI_REASONING_LEVEL` | Effective reasoning level (`off`…`max`)                              |

`createBashTool()` exposes these **by default** (`exposeSessionEnvironment: true`),
and can be told not to: `createBashTool(cwd, { exposeSessionEnvironment: false })`
(`docs/environment-variables.md`). Injection happens before any `spawnHook`.

### 5.2 What we do today

We build the bash tool via `createCodingTools(effectiveCwd)`
(`src/main/claude/agent-runner.ts:3194`), then wrap it twice:
`wrapBashToolWithDefaultTimeout` (`:1941`) and `wrapBashToolForSudo` (`:1840`).

The sudo wrapper has **two execution paths** (`agent-runner.ts:1849-1931`):

- **Non-sudo commands** delegate to `originalExecute(...)` — pi's own bash tool
  (`agent-runner.ts:1930`). This path inherits pi's session-env injection for free
  once we are on 0.82.0, **assuming** `createCodingTools` builds its bash tool with
  the exposing default (see §5.4).
- **Sudo commands** are re-spawned by us directly with Node's `spawn`, and crucially
  **without an `env` option** (`agent-runner.ts:1892-1896`) — so that path inherits
  the _main process_ environment, not pi's session env. It would _not_ see
  `PI_SESSION_ID` et al. unless we add them.

### 5.3 Proposed change

There are two separable decisions:

1. **Whether to expose at all.** The variables are useful to bundled skills (a skill
   command can read `PI_MODEL` / `PI_REASONING_LEVEL` to adapt). But `PI_SESSION_FILE`
   hands a model-invoked command the absolute path to the full conversation
   transcript on disk — a broader read surface than the model otherwise has. Under our
   sandbox model that path may not even be reachable from inside the sandbox, in which
   case the variable is harmlessly dangling; if it _is_ reachable, exposing it lets an
   agent read its own (and prior) session history off disk. This is the "Medium
   (surface)" risk in the table and needs an explicit decision, not a default-on
   inheritance.
2. **Parity across the two paths.** If we expose, the sudo re-spawn path should get
   the same variables for consistency (add them to the `spawn` `env`). If we suppress,
   we should pass `exposeSessionEnvironment: false` so the common path does not leak
   what the sudo path withholds.

Recommended first cut: **expose the four non-file variables, suppress
`PI_SESSION_FILE`** until we confirm sandbox reachability. Whether pi lets us mask a
single variable (vs. all-or-nothing `exposeSessionEnvironment`) is an open question
(§5.4) — if it is all-or-nothing, either accept `PI_SESSION_FILE` after confirming the
sandbox blocks it, or suppress the whole set and inject the four safe ones ourselves in
the wrappers.

### 5.4 Open questions (must answer before building)

- Does `createCodingTools()` construct its bash tool with
  `exposeSessionEnvironment` defaulted on? The doc states the default for
  `createBashTool`; confirm `createCodingTools` does not override it. Check
  `pi-0.82.0/dist/core/tools/bash.*` after the uplift.
- Is `PI_SESSION_FILE` reachable from inside our sandbox executors
  (`src/main/sandbox/native-executor.ts`, `.../lima-agent`)? If the sandbox root does
  not contain the pi session directory, the path is inert.
- Can a single variable be masked, or is it all-or-nothing? Determines whether §5.3's
  "expose four, suppress one" is a one-liner or needs our own injection.

### 5.5 Effort / risk

S to wire, but gated on the §5.4 answers. Risk Medium until the `PI_SESSION_FILE`
surface question is settled — this is why the item is "Conditional", not "Yes".

---

## 6. Item D — Constrained (strict-schema) tool sampling

### 6.1 What pi added

Tools may now request that the model's emitted arguments be constrained to the
declared schema (`pi-ai-0.82.0/dist/types.d.ts:339-351`):

```ts
type ConstrainedSamplingConfig =
  | { type: 'json_schema'; strict: 'prefer' | 'require' }
  | { type: 'grammar'; variants: GrammarVariants };

interface Tool<TParameters> {
  // ...
  constrainedSampling?: false | ConstrainedSamplingConfig;
}
```

It is gated by per-model capability flags so an unsupported request is never sent:
`supportsStrictTools` (Anthropic, `types.d.ts:531`), `supportsStrictMode`
(Bedrock and others, `types.d.ts:455/476/542`), plus the grammar-tool flags. The
0.82.0 changelog: _"model capability metadata preventing unsupported requests."_

`strict: "prefer"` means "constrain if the model supports it, otherwise proceed
normally" — it degrades gracefully. `strict: "require"` means "fail if unsupported."

### 6.2 What we do today

Our MCP tools are wrapped as pi tool definitions in `buildMcpCustomTools`
(`src/main/claude/agent-runner.ts:451-484`). The parameters schema is the raw MCP
`inputSchema` wrapped verbatim:

```ts
// agent-runner.ts:455-457
const parameters = Type.Unsafe<Record<string, unknown>>(
  mcpTool.inputSchema as Record<string, unknown>
);
```

MCP `inputSchema` comes straight from third-party servers
(`src/main/mcp/mcp-manager.ts:1441-1447`) and is passed through with only
`properties` / `required` preserved. This is the single injection point where a
`constrainedSampling` field would go.

### 6.3 Proposed change

Add `constrainedSampling: { type: 'json_schema', strict: 'prefer' }` to the tool
definitions built in `buildMcpCustomTools` (and, if we choose, to our own custom
tools). `'prefer'` is the only safe default here: it means capable models
(Anthropic strict-tools, Bedrock strict-mode) get schema-constrained arguments —
fewer malformed tool calls — while everything else is unaffected.

### 6.4 The correctness caveat (why this is "Investigate", not "Yes")

Strict JSON-Schema sampling forces the model's output to _validate_ against the
schema. Third-party MCP `inputSchema`s are frequently **not** written to be strict —
they omit `additionalProperties: false`, use loose types, or rely on the model to be
lenient. Under `strict: "require"` a non-conforming-but-workable schema would break
the tool outright. Even under `strict: "prefer"`, a schema that the provider's strict
encoder rejects (rather than silently ignores) is a risk we must verify empirically,
not assume. This is the "Medium (correctness)" entry in the table.

### 6.5 Recommended approach

Treat D as an **investigation that may conclude in a small change**:

1. Confirm which of our commonly-used models actually set `supportsStrictTools` /
   `supportsStrictMode` in the 0.82.0 catalog (Anthropic models do; verify our
   OpenRouter routing to Anthropic preserves the flag).
2. On one such model, enable `strict: "prefer"` for a couple of well-formed MCP tools
   and confirm tool calls still succeed.
3. Only then decide whether to enable it broadly, and never move past `"prefer"`
   without per-schema validation.

### 6.6 Effort / risk

M (the change is one line per tool; the _investigation_ is the work). Risk Medium
until §6.5 step 2 passes.

---

## 7. Cross-cutting testing & rollout

- **Gate on the uplift.** Nothing here compiles against 0.80.10. Land the 0.82.0
  uplift (typecheck + tests green, `npm run rebuild` for better-sqlite3) first.
- **Per-item, independently shippable.** Recommended order B → A1 → (A2, C, D as
  their questions resolve).
- **Tests.** Items A1 and B are unit-testable against synthesized `compaction_end`
  and `summarization_retry_*` events without a live provider — extend the existing
  agent-runner event-handling tests. Item C needs a manual check that a bash command
  sees (or does not see) the variables under each sandbox. Item D needs a live
  model call and cannot be meaningfully unit-tested.
- **Manual smoke per item:** A1 — trigger a compaction, confirm summary tokens are
  counted. B — force a summary retry (or replay a scheduled-retry event) and confirm
  the trace step narrates it. C — run `printf '%s\n' "$PI_MODEL"` from an agent bash
  call. D — issue an MCP tool call on a strict-capable model.

---

## 8. Non-goals

- **Reading or writing pi session files ourselves.** The new `retainedTail` /
  `usage` fields in the session format are consumed _by pi_; we never parse session
  JSONL (verified: no `retainedTail` / `firstKeptEntryId` / `CompactionEntry` reads
  in `src/`). We stay a `SessionManager` consumer.
- **The OpenRouter / Kimi `/login` OAuth flows.** These are wired to pi's terminal
  `/login` command; reusing the underlying `pi-ai` OAuth in our GUI is a separate
  investigation (the type-only `@earendil-works/pi-ai/oauth` entrypoint and
  `dist/auth/oauth/openrouter.*` exist, but adopting them is its own design), not
  part of this "small follow-up" plan.
- **llama.cpp model management, Qwen/Kimi subscription providers, grammar-based
  constrained sampling.** Out of scope; grammar variants (`type: "grammar"`) are only
  relevant if we ever need regex/Lark-constrained tools, which we do not today.

---

## 9. Open decisions

1. **A2 build-vs-read:** does `SessionManager` already expose session usage totals
   (0.81.0 "session statistics")? Answering this decides whether A2 is a read or a
   re-implementation (§3.5).
2. **C exposure policy:** expose the session variables to agent bash commands at all,
   and specifically whether `PI_SESSION_FILE` is safe under each sandbox (§5.4). This
   is the one decision with a genuine security surface and needs explicit sign-off.
3. **D scope:** does `strict: "prefer"` hold up against real third-party MCP schemas
   on our strict-capable models (§6.5)? If not, D closes as "investigated, declined."

[0.81.0]: https://github.com/earendil-works/pi — packages/coding-agent/CHANGELOG.md
[0.81.1]: https://github.com/earendil-works/pi — packages/coding-agent/CHANGELOG.md
[0.82.0]: https://github.com/earendil-works/pi — packages/coding-agent/CHANGELOG.md
