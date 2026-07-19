# Per-Model Thinking Level — Inherit pi's Reasoning Capabilities

**Created:** 2026-07-19
**Status:** Design — not started. Extracts and supersedes
[`pi-sdk-080-feature-adoption-plan.md`](./pi-sdk-080-feature-adoption-plan.md) **§5.4 step 2**
(the deferred UX half). Step 1 — importing `ModelThinkingLevel` — already shipped
(`agent-runner.ts`, 2026-07-18).
**Author:** AI-assisted design session
**Baseline:** pi-ai / pi-coding-agent **0.80.10** (same as the §5.4 plan).

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
