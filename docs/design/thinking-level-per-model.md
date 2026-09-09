# Per-Model Thinking Level — Inherit pi's Reasoning Capabilities

**Created:** 2026-07-19
**Status:** **Implemented — shipped 2026-07-20** (`9078c543`, `a5b628d2`). See §9 for the
as-built record, including four defects found in review and three deliberate divergences
from this design. Extracts and supersedes
[`pi-sdk-080-feature-adoption-plan.md`](./archive/pi-sdk-080-feature-adoption-plan.md) **§5.4 step 2**
(the deferred UX half). Step 1 — importing `ModelThinkingLevel` — already shipped
(`agent-runner.ts`, 2026-07-18).
**Author:** AI-assisted design session
**Baseline:** pi-ai / pi-coding-agent **0.80.10** (same as the §5.4 plan).

> **Reading note.** §§1-8 are the original design, left intact as written. Line references
> and the "Today" column in §3 describe the pre-implementation codebase and have since
> drifted. §9 records what was actually built.

---

## 1. Problem

Sqowe exposes reasoning as a **single boolean** — a checkbox in Settings → API. On maps to
thinking level `medium`, off maps to `off`; the other five pi levels
(`minimal`, `low`, `high`, `xhigh`, `max`) are unreachable.

```ts
// src/main/claude/agent-runner.ts:2846-2850
const enableThinking = configStore.get('enableThinking') ?? false;
const thinkingLevel: ModelThinkingLevel = enableThinking ? 'medium' : 'off';
```

Users running strong coders (Sonnet 5 with `xhigh`, GLM-5.2 with `max`) cannot dial effort
up; users on always-thinking or budget-only models get a toggle that doesn't reflect what the
model actually does. The §5.4 plan deferred the fix because it looked like a real feature:
_"it needs per-model capability clamping (not every model supports max/xhigh) plus i18n across
four locales."_

## 2. Key finding — the hard part is already solved in the SDK

The per-model capability logic lives in **two pure functions of the resolved `Model`**,
exported from `@earendil-works/pi-ai/compat` — the _same_ subpath Sqowe already imports
`getModel`/`getModels` from in
[`pi-model-resolution.ts:3`](../../src/main/claude/pi-model-resolution.ts#L3):

```js
// @earendil-works/pi-ai/dist/models.js  (verified, 0.80.10)
const EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function getSupportedThinkingLevels(model) {
  if (!model.reasoning) return ['off'];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false; // null → hidden from UI
    if (level === 'xhigh' || level === 'max') return mapped !== undefined; // extended levels: only if explicitly mapped
    return true; // off/minimal/low/medium/high: default-available
  });
}

export function clampThinkingLevel(model, level) {
  // returns `level` if supported; else nearest supported UP, then DOWN, then 'off'
}
```

The pi **session** methods are thin wrappers over these plus `model.reasoning`:

| Session method                 | Implementation                                          |
| ------------------------------ | ------------------------------------------------------- |
| `supportsThinking()`           | `!!model.reasoning`                                     |
| `getAvailableThinkingLevels()` | `getSupportedThinkingLevels(model)`                     |
| `setThinkingLevel(level)`      | clamps via `clampThinkingLevel(model, level)` then sets |
| `cycleThinkingLevel()`         | index walk over `getAvailableThinkingLevels()`          |

**Consequence:** the "per-model capability clamping" that blocked step 2 is a solved problem.
Sqowe already resolves the pi `Model` (`resolvePiRegistryModel`). Every per-model table from
the reasoning investigation — Sonnet 4.6 hides `xhigh`; Sonnet 5 exposes all seven; GLM-5.2
collapses `low`/`medium` into `high` and adds `max`; MiniMax is budget-only — is encoded in
each model's `thinkingLevelMap` in the pi-ai registry. **We inherit those tables; we never
replicate or hardcode them.** When pi updates a model's map, our UI follows for free.

The `setThinkingLevel` plumbing and session-reuse invalidation already exist and already work
for _any_ level ([`agent-runner.ts:3287-3295`](../../src/main/claude/agent-runner.ts#L3287)) —
only the boolean at the front needs to become a level.

## 3. Current wiring (what changes touch)

| Concern      | Location                                                                                                                 | Today                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Stored value | [`config-store.ts`](../../src/main/config/config-store.ts) — `enableThinking: boolean` per ConfigSet, in `SETTABLE_KEYS` | boolean                             |
| Type         | [`types/index.ts:897,983`](../../src/renderer/types/index.ts#L897)                                                       | `enableThinking: boolean`           |
| Read/hydrate | `useApiConfigState.ts` (`enableThinking`), `config-store.ts` `projectFromConfigSet` / `normalizeConfigSet`               | boolean                             |
| Consumption  | [`agent-runner.ts:2846-2850`](../../src/main/claude/agent-runner.ts#L2846)                                               | `enableThinking ? 'medium' : 'off'` |
| UI           | [`SettingsAPI.tsx:529-548`](../../src/renderer/components/settings/SettingsAPI.tsx#L529)                                 | `<input type="checkbox">`           |
| i18n         | `i18n/locales/{en,zh,ru,hu}.json` — `api.enableThinking*` (en.json:365-367)                                              | 3 keys × 4 locales                  |

## 4. Design — "inherit, don't replicate"

Five pieces. None introduces a hardcoded per-model table.

### 4.1 Main — capability helper + IPC (S)

Add a pure helper in [`pi-model-resolution.ts`](../../src/main/claude/pi-model-resolution.ts)
next to the existing resolvers:

```ts
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

export function resolveThinkingCapabilities(
  modelString: string,
  options: PiModelLookupOptions
): { supportsThinking: boolean; levels: ModelThinkingLevel[] } {
  const model =
    resolvePiRegistryModel(modelString, options) ??
    /* synthetic fallback — buildSyntheticPiModel already sets `reasoning` */ undefined;
  if (!model) return { supportsThinking: false, levels: ['off'] };
  const levels = getSupportedThinkingLevels(model) as ModelThinkingLevel[];
  return { supportsThinking: !!model.reasoning, levels };
}
```

Expose via a new IPC handler `config.getThinkingLevels` in
[`src/main/index.ts`](../../src/main/index.ts) (mirror the `config.listModels` shape) taking
`{ provider, model, customProtocol, baseUrl }` and returning the struct above. Add the channel
to `src/preload/index.ts` and a typed wrapper in `useIPC`/the renderer API surface.

- Synthetic/Ollama models resolve through `buildSyntheticPiModel`, which already sets
  `reasoning` from `REASONING_MODEL_PATTERN` — so this path returns a sane result there too.
- Pure and registry-only: no network, no session, safe to call on every model/provider change.

### 4.2 Config — store the level, migrate the boolean (S)

- Add `thinkingLevel?: ModelThinkingLevel` to the `ConfigSet` type
  ([`types/index.ts`](../../src/renderer/types/index.ts)) and to `SETTABLE_KEYS`.
- **Migration (no data loss, no reset):** where the store reads `enableThinking` today
  (`projectFromConfigSet`, `normalizeConfigSet`, `normalizeRaw*`), derive:
  `thinkingLevel = configSet.thinkingLevel ?? (enableThinking ? 'medium' : 'off')`.
  Keep writing `enableThinking` for one release for backward/rollback safety (`level !== 'off'`),
  or drop it — decide at implementation time.
- Keep the value **unclamped** in storage (it's model-independent intent); clamp at
  consumption (§4.3) so switching models never corrupts the stored preference.

### 4.3 agent-runner — consume the stored level, clamped (XS)

`piModel` is already resolved above line 2850, so clamping is free and makes an invalid level
impossible to send:

```ts
import { clampThinkingLevel } from '@earendil-works/pi-ai/compat';

const stored = configStore.get('thinkingLevel') ?? 'off';
const thinkingLevel: ModelThinkingLevel = clampThinkingLevel(piModel, stored);
```

This also hardens the **OpenRouter hazard** (§6): even where the registry entry is permissive,
we never emit a level the model can't take.

### 4.4 Renderer — segmented level control (M)

Replace the checkbox in [`SettingsAPI.tsx`](../../src/renderer/components/settings/SettingsAPI.tsx)
with a segmented selector driven by `config.getThinkingLevels(provider, model, …)`:

- `supportsThinking === false` → hide the control (or render disabled with a hint).
- Otherwise render one segment per returned level, in canonical order
  (`off · minimal · low · medium · high · xhigh · max`, minus whatever the model omits).
- Re-query on model / provider / profile change (same triggers the model dropdown already uses).
- Persist selection to `thinkingLevel`. If the stored level isn't in the returned set, show the
  clamped value as active (mirror `clampThinkingLevel`) so UI and runtime agree.

### 4.5 i18n — four locales (S)

Add level labels + a group heading across `en`, `zh`, `ru`, `hu`
(project has **four** locales — always `ls src/renderer/i18n/locales/`). pi's own theme keys
name them `thinkingOff … thinkingMax` (`docs/tui.md:427`); reuse that vocabulary. Repurpose the
existing `api.enableThinkingHint` / `api.enableThinkingOllamaHint` copy rather than deleting it.

## 5. Effort

| Piece                       | Size |
| --------------------------- | ---- |
| 4.1 helper + IPC + preload  | S    |
| 4.2 config type + migration | S    |
| 4.3 agent-runner clamp      | XS   |
| 4.4 segmented UI + re-query | M    |
| 4.5 i18n ×4                 | S    |

Net **Small–Medium** — down from the §5.4 "M, blocked" estimate, because clamping is now a
one-line SDK call rather than a table we own.

## 6. Inherited limitations (document, don't fix here)

- **OpenRouter over-exposure.** For a model routed via OpenRouter whose registry entry lacks a
  restrictive `thinkingLevelMap` (e.g. GLM-5.2), pi reports all six non-off levels even though
  the underlying provider (Z.ai) only honors `high`/`max`. We inherit that. The §4.3 clamp
  keeps it _safe_ (never an API error), but the UI would still _show_ levels that collapse
  server-side. A real fix = user-supplied per-model `thinkingLevelMap` overrides (see below) —
  out of scope for this doc.
- **MiniMax budget-only.** Native MiniMax maps `minimal…high` to token _budgets_, not a
  qualitative switch; `xhigh`/`max` are absent. The control renders correctly from the map;
  the semantics are the provider's, not ours.

## 7. Optional follow-up (separate epic) — user thinkingLevelMap overrides

The reasoning investigation's recommendation was to add per-model `thinkingLevelMap` overrides
(e.g. pin GLM-via-OpenRouter to `{minimal:null, low:'high', medium:'high', high:'high',
max:'max'}`). pi supports this via `modelOverrides` in models.json / provider config
(`docs/models.md:341`). Surfacing that as Sqowe config would close the OpenRouter gap — but it's
a distinct feature (config schema + editor UI) and should not block the core level selector.

## 8. Verification

- **Unit:** `resolveThinkingCapabilities` for representative models — Sonnet 4.6 (no `xhigh`),
  Sonnet 5 (all seven), a `reasoning:false` model (`['off']`), a synthetic/Ollama reasoning
  model. Assert against `getSupportedThinkingLevels` directly (pure, deterministic).
- **Migration:** `enableThinking:true → 'medium'`, `false/absent → 'off'`; explicit
  `thinkingLevel` wins over legacy boolean.
- **Clamp:** stored `max` + Sonnet-4.6-shaped model → `high`; stored `xhigh` + non-`xhigh`
  model → nearest.
- **Manual:** switch models in Settings, confirm the segment set changes and runtime logs
  `thinkingLevel=<clamped>` at [`agent-runner.ts:3255`](../../src/main/claude/agent-runner.ts#L3255).

---

## 9. As built (2026-07-20)

Shipped in `9078c543` (feature + three defects) and `a5b628d2` (Custom-endpoint
detection). Verified against the code at time of writing.

### 9.1 Status by section

| §   | Piece                    | Status  | Notes                                                              |
| --- | ------------------------ | ------- | ------------------------------------------------------------------ |
| 4.1 | Capability helper + IPC  | ✅ Done | `resolveThinkingCapabilities`, `config.getThinkingLevels`, preload |
| 4.2 | Config field + migration | ✅ Done | `thinkingLevel` on `ConfigSet`/`AppConfig`; legacy boolean derived |
| 4.3 | agent-runner clamp       | ✅ Done | Diverged — clamps the resolved `Model`, not a re-resolved string   |
| 4.4 | Segmented level control  | ✅ Done | Diverged — storage stays unclamped, display clamps (see 9.3)       |
| 4.5 | i18n ×4                  | ✅ Done | Keys renamed `enableThinking*` → `thinkingLevel*`                  |
| 6   | Inherited limitations    | ➖ N/A  | Documented only; still accurate                                    |
| 7   | User `thinkingLevelMap`  | ⬜ Open | Partly overtaken — see 9.4                                         |
| 8   | Verification             | ✅ Done | 49 tests across 4 files (see 9.6)                                  |

### 9.2 Defects found in review, fixed before/after ship

The design was implemented as written; review and manual testing then surfaced four
bugs, three of them variations on a single root cause — **treating "unknown" as a
known negative, and letting derived data overwrite user intent.**

1. **Clamp direction inverted.** The renderer searched down-then-up; pi searches
   up-then-down (`pi-ai/dist/models.js:404-422`). Settings could show a level the agent
   never ran at. Consolidated into `src/shared/thinking-levels.ts`
   (`clampToSupportedLevel`), verified against pi across all 448 map/level combinations.
2. **Mount-time reset.** The capability effect runs once before `profiles` loads, with no
   model resolvable. That dispatched "unsupported", which forced the stored level to
   `off` — destroying the loaded preference, which the next save then persisted. Fixed by
   splitting `CLEAR_THINKING_CAPABILITIES` (unknown) from `SET_THINKING_CAPABILITIES`
   (known); only the latter may affect the level.
3. **Spurious unsaved-changes.** Clamping into state changed `thinkingLevel`, which is
   part of the draft signature — so merely opening Settings marked the config set dirty
   and the unsaved-changes gate **blocked config-set switching**. Fixed by 9.3.
4. **Custom endpoints reported as non-reasoning.** Detection searched only
   `COMMON_FALLBACK_PROVIDERS` (3 of pi's 35), so `MiniMax-M3`, `z-ai/glm-5.1` and
   others were declared to have no reasoning support. Fixed in `a5b628d2` — see 9.4.

### 9.3 Divergence 1 — storage stays unclamped (§4.4)

The design said the UI should "show the clamped value as active." The first
implementation clamped into reducer state, making it the stored value and causing
defect 3.

As built: `thinkingLevel` holds the user's model-independent intent verbatim and is never
written by capability loading. A derived `effectiveThinkingLevel` clamps **for display
only**; `agent-runner` clamps again at consumption. This is what §4.2 already required
("keep the value unclamped in storage… so switching models never corrupts the stored
preference") — the two sections were in tension and §4.2 won.

Consequence worth knowing: switching to a non-reasoning model and back now **restores**
the previous level rather than having silently erased it.

Related rule, learned the hard way and worth preserving: **`off` is sticky.** Capability
data must never move a user off `off`, or switching models could silently enable billed
reasoning. Covered by a test.

### 9.4 Divergence 2 — reasoning traits, not whole models (§7)

§7 proposed user-supplied `thinkingLevelMap` overrides as a separate epic. `a5b628d2`
took a narrower path first: `findRegistryReasoningTraits` sweeps every registry provider
for a matching model id and borrows **only** the `reasoning` flag.

Model _resolution_ is deliberately unchanged. Adopting a foreign provider's entry
wholesale would import its `compat` quirks, pricing and context limits for an endpoint
the user is not calling — `claude-opus-4.8` resolves under `github-copilot`,
`z-ai/glm-5.1` under `opencode`. `thinkingLevelMap` is likewise not borrowed: pi gates
`xhigh`/`max` behind explicit per-vendor mapping, and the donor is by definition not the
endpoint being called.

Still open, now with its own design note: models pi has **never seen** (a proxy serving
something newer than the pinned pi-ai) remain undetectable, and the panel still asserts
they lack reasoning support. See
[`model-reasoning-override.md`](./model-reasoning-override.md).

### 9.5 Divergence 3 — small corrections to the design's assumptions

- **`SETTABLE_KEYS` (§4.2) does not exist** in this codebase. `ConfigStore.update()` takes
  `Partial<AppConfig>`; the `mutatesActiveSet` guard was extended instead.
- **No `useIPC` wrapper (§4.1).** `useIPC.ts` does not wrap `config.*` at all —
  `useApiConfigState` calls `window.electronAPI.config.*` directly (11 sites). The new
  call follows that existing convention; adding a wrapper for one method would have been
  the inconsistent choice.
- **`supportsThinking` is `nonOff.length > 0`, not `!!model.reasoning`** (§4.1). These
  agree except when `reasoning: true` but every non-off level is mapped `null` — where
  the implemented form is the more correct answer.

### 9.6 Tests

| File                                                 | Tests | Covers                                    |
| ---------------------------------------------------- | ----- | ----------------------------------------- |
| `tests/config-store-thinking-level.test.ts`          | 15    | Migration, normalization, persistence     |
| `tests/pi-model-resolution-thinking.test.ts`         | 15    | Capability resolution, clamping (mocked)  |
| `tests/api-config-state-thinking-level.test.ts`      | 14    | Reducer, clamp parity, draft signature    |
| `tests/pi-model-resolution-reasoning-traits.test.ts` | 5     | Trait borrowing (real registry, unmocked) |

The last file is deliberately unmocked: it asserts things about pi's actual model tables,
which mocked tables cannot verify. Note that the mocked file stubs `getProviders` to `[]`
on purpose — without that stub the traits lookup degrades silently and those tests would
pass for the wrong reason.
