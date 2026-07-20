# Manual Reasoning Override for Unrecognised Models

**Created:** 2026-07-20
**Status:** Design — not started.
**Author:** AI-assisted design session
**Baseline:** pi-ai / pi-coding-agent **0.80.10**
**Follows:** [`thinking-level-per-model.md`](./thinking-level-per-model.md) (shipped `9078c543`)
and its Custom-endpoint fix (`a5b628d2`). This doc covers the case neither can reach.

---

## 1. Problem

Settings → API tells the user, as a statement of fact:

> This model does not support adjustable reasoning, so thinking stays off.

For a model behind a **Custom** provider, we cannot know that. The message is shown
whenever capability detection comes back negative, and detection has no way to
distinguish _"pi knows this model has no reasoning"_ from _"pi has never heard of this
model."_ The user is told **no** when the honest answer is **unknown**, and the control
is hidden, so they cannot correct it.

Reported case: a local proxy on `http://127.0.0.1:9000/v1` serving `claude-opus-4.8`.
The model reasons; the panel says it cannot; there is no way to say otherwise.

This is the same unknown-vs-unsupported conflation that produced three earlier bugs in
the parent feature — surfaced here at the data layer rather than the state layer.

## 2. Why the shipped fixes don't cover it

`a5b628d2` added `findRegistryReasoningTraits`: for a model reached through a Custom
endpoint, sweep every pi registry provider for a matching model id and borrow the
`reasoning` flag (only that flag — see that commit for why transport and
`thinkingLevelMap` deliberately stay put).

That resolves any model **already in pi's tables** — `MiniMax-M3`, `z-ai/glm-5.1`. It
cannot resolve a model pi has never seen, which is precisely the interesting case:

- a model newer than the pinned pi-ai version (`claude-opus-4.8` today),
- an in-house or fine-tuned model behind a gateway,
- a model renamed by a proxy (`my-router/fast-thinker`).

For these, the synthetic fallback infers `reasoning` from `REASONING_MODEL_PATTERN`
([`pi-model-resolution.ts`](../../src/main/claude/pi-model-resolution.ts)), a filename
regex naming `thinking`, `reasoner`, `deepseek-r1`, `kimi-k2`, `qwen3`. Anything else
is reported as non-reasoning. Widening that regex would mean maintaining a per-model
table — exactly what the parent design forbids ("inherit, don't replicate").

**No amount of detection closes this.** The information does not exist locally. Only
the user has it.

## 3. Key constraint — the flag is load-bearing at runtime

Verified in `@earendil-works/pi-ai/dist/api/openai-completions.js` (0.80.10): **every**
reasoning branch is gated on `model.reasoning` — lines 497, 508, 511, 517, 523, 535,
547, 553, 560, and the general case at 569/573. Line 407 additionally clamps via
`clampThinkingLevel(model, options.reasoning)`.

Consequence: with `reasoning: false`, pi emits **no** reasoning parameter at all. A UI
that merely offered levels for undetected models would be theatre — the selection would
be silently dropped on every request. The override must reach the `Model` object handed
to pi, not just the panel.

## 4. Design

### 4.1 Config — one optional field on `ProviderProfile` (S)

```ts
// src/renderer/types/index.ts
export interface ProviderProfile {
  apiKey: string;
  baseUrl?: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean; // undefined = auto-detect
}
```

This follows an existing, proven precedent rather than inventing a mechanism:
`contextWindow` and `maxTokens` are already per-profile manual overrides for the same
class of problem — registry metadata being absent or wrong for a given endpoint. They
are applied at
[`agent-runner.ts:2504-2520`](../../src/main/claude/agent-runner.ts#L2504) as
`piModel = { ...piModel, contextWindow: … }`, and the UI already frames it correctly:
_"Leave empty for auto-detection. Override only if the model reports incorrect limits."_

**Semantics (tri-state):**

| Value       | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `undefined` | Auto-detect (registry → borrowed traits → regex) |
| `true`      | Force reasoning-capable                          |
| `false`     | Force non-reasoning                              |

`false` costs one branch to honour and avoids a migration if we later expose it, so the
data model carries all three from day one. **v1 UI exposes only `undefined ↔ true`** —
see §6.

**Scope: per profile, per config set.** The same model id reached through two different
endpoints can legitimately differ, and this matches how `model`/`baseUrl`/limits are
already scoped. No global state, no second source of truth.

**Migration: none.** Absent field = `undefined` = today's behaviour.
`normalizeProfile` ([`config-store.ts:1105`](../../src/main/config/config-store.ts#L1105))
preserves optional fields only when valid; add the boolean case alongside the two
numeric ones. Note the numeric guards use truthiness (`> 0`) — the boolean guard must
use `typeof profile?.reasoning === 'boolean'` so a stored `false` survives.

### 4.2 Capability resolution — a third state (S)

`ThinkingCapabilities` gains a field distinguishing the two negatives:

```ts
export interface ThinkingCapabilities {
  supportsThinking: boolean;
  levels: ModelThinkingLevel[];
  /** How supportsThinking was arrived at. */
  detection: 'registry' | 'borrowed' | 'override' | 'undetected';
}
```

`undetected` means: the model resolved only synthetically, no registry entry lent it
reasoning traits, and the regex did not match. That is the state that earns the manual
control. Precedence:

1. explicit profile `reasoning` override
2. registry entry (`resolvePiRegistryModel`)
3. borrowed traits (`findRegistryReasoningTraits`, from `a5b628d2`)
4. `REASONING_MODEL_PATTERN`

**Levels when forced on:** `off · minimal · low · medium · high`. Not a guess —
`getSupportedThinkingLevels` returns exactly these for any `reasoning: true` model with
no `thinkingLevelMap` (`pi-ai/dist/models.js:392-403`); `xhigh`/`max` require an explicit
map entry. Consistent with why `a5b628d2` declines to borrow maps.

The IPC payload (`config.getThinkingLevels`) gains the profile's `reasoning` value.

### 4.3 Runtime — apply beside the existing overrides (XS)

In `agent-runner`, next to the `contextWindow`/`maxTokens` overrides:

```ts
if (typeof runtimeConfig.reasoning === 'boolean' && runtimeConfig.reasoning !== piModel.reasoning) {
  log(
    '[ClaudeAgentRunner] User reasoning override:',
    piModel.reasoning,
    '→',
    runtimeConfig.reasoning
  );
  piModel = { ...piModel, reasoning: runtimeConfig.reasoning };
}
```

Must run **before** `clampThinkingLevelForModel`, which short-circuits to `'off'` for
`reasoning: false` models. Applies to registry and synthetic models alike, so a wrong
registry entry can also be corrected.

### 4.4 Renderer — three states, one new control (M)

The Thinking Level section currently has two states. It gains a third:

| Detection              | UI                                                    |
| ---------------------- | ----------------------------------------------------- |
| supported              | level selector (unchanged)                            |
| `undetected`           | "Couldn't detect reasoning support" + enable checkbox |
| unsupported (known-no) | current message, unchanged                            |

Checking the box writes `reasoning: true` to the active profile and reveals the level
selector; clearing it removes the field (back to auto). The stored `thinkingLevel` is
untouched throughout — it is the user's model-independent intent, per parent design
§4.2, and the display clamp handles the rest.

Because `reasoning` becomes part of the saved profile, it must join the draft signature
so the Save button enables — but **must not** be written by detection, only by the user.
Detection writing to persisted state is what caused the config-set switching bug in the
parent feature; that lesson applies directly here.

### 4.5 i18n — four locales (S)

Three keys × `en`/`zh`/`ru`/`hu` (always `ls src/renderer/i18n/locales/`): the
undetected heading, the checkbox label, and a caution that an endpoint may reject
reasoning parameters. Reuse the `contextWindowHint` register — it already says the right
kind of thing.

## 5. Effort

| Piece                            | Size |
| -------------------------------- | ---- |
| 4.1 profile field + normalize    | S    |
| 4.2 detection state + IPC        | S    |
| 4.3 runtime override             | XS   |
| 4.4 three-state UI + persistence | M    |
| 4.5 i18n ×4                      | S    |

Net **Small–Medium**.

## 6. Decisions

**Why not pi's `models.json`.** pi supports user-defined models and `modelOverrides`
with `reasoning` and `thinkingLevelMap` via `~/.pi/agent/models.json`
(`pi-coding-agent/docs/models.md:320-341`), and Sqowe already passes `agentDir`
([`agent-runner.ts:3354`](../../src/main/claude/agent-runner.ts#L3354)) so the SDK would
read `<userData>/claude/models.json` today. **We deliberately do not use it.** It is a
global file outside the per-config-set profile model, creating a second source of truth
for settings the user manages in the GUI, and an undiscoverable one. Its _semantics_
(`reasoning` as a per-model boolean) are worth mirroring; its storage is not.

**Why v1 hides force-off.** The failing case is the false negative. The mirror case — a
registry entry claiming support the endpoint rejects — is rarer and fails loudly with an
API error rather than a silent wrong result. Storing `false` is supported; exposing it
is additive and can wait for evidence it's needed.

**Why per-profile, not per-model-id.** A global "claude-opus-4.8 reasons" table is the
per-model table this project's rules exclude, and it would be wrong the moment two
endpoints serve the same id with different capabilities.

## 7. Risks

- **Endpoint rejects reasoning parameters.** Forcing `reasoning: true` makes pi send
  `reasoning_effort` (or a `thinkingFormat` variant). An endpoint that doesn't accept it
  may 400. Mitigated by explicit opt-in and a UI caution; the user can uncheck. If this
  proves common, the escape hatch is `compat.supportsReasoningEffort` — out of scope here.
- **Sandbox/proxy drift.** The override lives on the profile, so switching profiles or
  config sets carries the right value automatically. No extra handling needed, but worth
  a test.
- **Detection regressions.** Adding `detection` to `ThinkingCapabilities` touches the IPC
  contract consumed by the reducer. The parent feature's tests cover the reducer's
  refusal to mutate stored state; extend rather than replace them.

## 8. Verification

- **Unit — precedence:** override beats registry, registry beats borrowed traits,
  borrowed beats regex; `undefined` reproduces today's result exactly.
- **Unit — persistence:** `reasoning: false` survives `normalizeProfile` (guard against
  a truthiness check), absent stays absent, per-profile isolation holds.
- **Unit — runtime:** `reasoning: true` on a synthetic model yields a non-`off` clamped
  level; without it the same input yields `'off'`.
- **Unit — no detection writes:** a capabilities payload never alters the persisted
  profile or the draft signature (regression guard from the parent feature).
- **Manual:** Custom + `http://127.0.0.1:9000/v1` + `claude-opus-4.8` → undetected state,
  check the box, pick `high`, save, reopen, confirm it sticks and that
  `thinkingLevel stored=high clamped=high` appears in the runtime log.

## 9. Out of scope

- Per-model `thinkingLevelMap` overrides (`xhigh`/`max` for custom endpoints). Parent
  design §7. Needs a schema and an editor; the boolean covers the reported need.
- Auto-probing an endpoint for reasoning support. Costs a live request, and a negative
  is not conclusive.
- Broadening `REASONING_MODEL_PATTERN`. That is the per-model table this design exists
  to avoid.
