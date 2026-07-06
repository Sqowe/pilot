# Native Provider Catalog — Design & Implementation Plan

**Created:** 2026-07-06
**Status:** Implemented (all phases done 2026-07-06)
**Last updated:** 2026-07-06
**Author:** AI-assisted design session
**Scope:** "Level A" only — API-key ("coding plan") providers that pi-ai ships as
first-class `KnownProvider`s (z.ai, MiniMax, Kimi, DeepSeek, Groq, xAI, …). True OAuth
subscriptions (Codex, Claude Pro/Max, GitHub Copilot) are **out of scope** (see §12).
**Source of capabilities:** `@earendil-works/pi-ai/compat` — `getProviders()`,
`getModels()`, `env-api-keys.ts`. Verified against the SDK installed at
`v24.17.0/.../@earendil-works/pi-coding-agent` (docs: `docs/providers.md`,
`docs/custom-provider.md`).

---

## 1. Overview

pi-ai ships a built-in registry of ~35 providers (`KnownProvider` in
`pi-ai/dist/types.d.ts`), each with baked-in model lists, real pricing, correct base
URLs, and provider-specific streaming quirks (`thinkingFormat: "zai"`, `zaiToolStream`,
MiniMax context windows, etc.). Today Open Cowork exposes only a **closed 6-value
provider enum** and routes everything else through a generic `custom` escape hatch that
builds a _synthetic_ model — losing the registry's cost, context window, and quirks.

This plan adds those native providers as selectable options in
**Settings → API → Config Set**, driven by a **data-driven catalog** projected from the
SDK (no hand-maintained model lists), behind a redesigned **"featured chips + searchable
catalog"** provider picker. "Just add 35 buttons" is rejected as unusable; the closed
enum is widened to an open catalog id while preserving every existing config verbatim.

### Guiding principles (consistent with `ARCHITECTURE.md`)

- **Consume, never fork.** The catalog is a pure projection of pi-ai's public registry.
- **One source of truth.** Native model lists / pricing / base URLs come from
  `getModels()`, never re-typed by hand.
- **Additive and reversible.** Existing config sets load and behave identically; the
  6 legacy provider values simply become 6 catalog entries.
- **Custom stays.** "More Models" (Custom) remains a first-class chip and the escape
  hatch for anything not in the registry.

### Goals

- Native providers selectable with the _simplest_ possible flow: pick provider → pick
  model from an auto-populated dropdown → paste API key → done.
- Correct routing so `resolvePiRegistryModel('zai/glm-5')` resolves the **native** model
  (with quirks) instead of the synthetic fallback. This is the concrete bug-fix value.
- A provider picker that scales to 35+ entries without visual clutter.
- Zero-migration backward compatibility for existing persisted config.

### Non-goals

- OAuth / subscription login (Codex, Claude Pro/Max, Copilot) — "Level B", separate plan.
- Enterprise/cloud providers that need multi-field credentials (Amazon Bedrock, Google
  Vertex, Azure OpenAI, Cloudflare gateways). They don't fit the "paste one key" shape;
  they stay reachable via Custom/extensions and may become a later tier (§10).
- Changing the memory sub-config provider surface (`MemoryLLMRuntimeConfig`), except the
  incidental type-widening in §6.2. Its provider stays a `ProviderType`.

---

## 2. Background — current architecture

### 2.1 Data model (the closed enum)

`ProviderType` is a closed 6-value union declared **twice** (kept in sync by hand):

- `src/shared/api-model-presets.ts:1` — `SharedProviderType`
- `src/renderer/types/index.ts:841` — `ProviderType`
- `src/main/config/config-store.ts:58` — `ProviderType` (main-process copy)

`ApiConfigSet` (`src/renderer/types/index.ts:868`, mirrored in config-store) holds:

```ts
provider: ProviderType; // one of 6
customProtocol: CustomProtocolType; // 'anthropic' | 'openai' | 'gemini'
activeProfileKey: ProviderProfileKey; // 8 fixed keys
profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;
```

### 2.2 Profile keys

Credentials are stored **per provider slot** under `ProviderProfileKey`
(`src/renderer/types/index.ts:849`, `config-store.ts:66`):

```
'openrouter' | 'anthropic' | 'openai' | 'gemini' | 'ollama'
| 'custom:anthropic' | 'custom:openai' | 'custom:gemini'
```

Mapping helpers live in `useApiConfigState.ts`:
`profileKeyFromProvider()` (`:98`) and `profileKeyToProvider()` (`:114`). Switching
provider preserves each slot's saved key/baseUrl/model.

### 2.3 Routing to the SDK

- `resolvePiRouteProtocol()` (`pi-model-resolution.ts:44`) maps our provider → a route
  protocol (`anthropic`/`openai`/`gemini`).
- `resolvePiRegistryModel()` (`:358`) tries `getModel(provider, id)` over a candidate
  list from `buildPiModelLookupCandidates()` (`:255`); on miss it falls back to
  `buildSyntheticPiModel()` (`:157`) — **this is where native quirks are lost**.
- Auth: `agent-runner.ts:2569` calls `authStorage.setRuntimeApiKey(piProvider, apiKey)`,
  where `piProvider = provider === 'custom' ? customProtocol : provider`.

### 2.4 UI

`SettingsAPI.tsx:131` renders the 6 providers as a button grid. `custom` reveals a
protocol row (`:174`), base-URL row (`:209`), context/max-tokens (`:345`), and the
`CommonProviderSetupsCard` (`:388`) — a `<details>` table of ~8 hand-authored "setups"
(`api-provider-guidance.ts:45`) that pre-fill Custom. This table is effectively a
proto-catalog and is the conceptual seed for the redesign.

### 2.5 Validation gates (the migration surface)

On load, config-store coerces unknown values to fallbacks:

- `isProviderType()` — `config-store.ts:493` (hard 6-value check)
- `isProfileKey()` / `PROFILE_KEYS` — `config-store.ts:481,508`
- Renderer mirror: `isProfileKey` used at `useApiConfigState.ts:291`

**A saved `provider: 'zai'` would today be silently reset to a fallback.** Widening
these two gates is the single load-bearing migration change (§7).

---

## 3. SDK capabilities we consume

From `@earendil-works/pi-ai/compat` (re-exported by `pi-coding-agent`):

| API                        | Returns                                                                          | Use                                 |
| -------------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| `getProviders()`           | `KnownProvider[]` (~35 ids)                                                      | enumerate native providers          |
| `getModels(providerId)`    | `Model[]` w/ `id,name,api,baseUrl,cost,contextWindow,maxTokens,reasoning,compat` | populate model dropdown + routing   |
| `getModel(providerId, id)` | single `Model`                                                                   | per-model resolution (already used) |
| `findEnvKeys(providerId)`  | `string[]` env var names                                                         | show "or set `$ZAI_API_KEY`" hint   |

> Note: `getModel`/`getModels`/`getProviders` are the `compat` aliases (marked
> `@deprecated` in favor of `Models.getModel()` / `getBuiltinModels` from
> `pi-ai/providers/all`). We already import `getModel` from `/compat`
> (`pi-model-resolution.ts:3`). **Decision:** keep using the `/compat` surface for
> consistency with existing code; migrating to `Models.*` is a separate chore.

The provider → env var map (from `pi-ai/dist/env-api-keys.js`) — used to derive
`keyEnvVar` and category hints:

```
zai→ZAI_API_KEY  zai-coding-cn→ZAI_CODING_CN_API_KEY  minimax→MINIMAX_API_KEY
minimax-cn→MINIMAX_CN_API_KEY  kimi-coding→KIMI_API_KEY  moonshotai→MOONSHOT_API_KEY
deepseek→DEEPSEEK_API_KEY  xai→XAI_API_KEY  groq→GROQ_API_KEY  cerebras→CEREBRAS_API_KEY
mistral→MISTRAL_API_KEY  together→TOGETHER_API_KEY  fireworks→FIREWORKS_API_KEY
nvidia→NVIDIA_API_KEY  huggingface→HF_TOKEN  ant-ling→ANT_LING_API_KEY
vercel-ai-gateway→AI_GATEWAY_API_KEY  opencode→OPENCODE_API_KEY  xiaomi→XIAOMI_API_KEY  …
```

---

## 4. Target design

### 4.1 Provider catalog (data model)

New module `src/shared/provider-catalog.ts`. A `ProviderCatalogEntry` describes _how the
form behaves_ and _how routing maps_, so `SettingsAPI` renders declaratively instead of
branching on 6 literals.

```ts
export type ProviderKind = 'builtin' | 'native' | 'custom';
export type ProviderCategory = 'featured' | 'coding-plan' | 'inference' | 'local' | 'custom';

export interface ProviderFormShape {
  apiKey: boolean; // show API key field (all except ollama-no-key)
  baseUrl: boolean; // show editable base URL (custom, ollama)
  protocol: boolean; // show anthropic/openai/gemini selector (custom only)
  contextWindow: boolean; // show context/maxTokens inputs (custom, ollama, unknown native)
  modelDropdown: boolean; // auto-populate models from registry (native, builtin)
  manualModelToggle: boolean; // allow free-text model id (native fallback, ollama, custom)
}

export interface ProviderCatalogEntry {
  id: string; // stable catalog id == ApiConfigSet.provider value
  name: string; // display name (i18n key or literal)
  kind: ProviderKind;
  category: ProviderCategory;
  piProvider: string; // pi-ai provider key for getModel/getModels/auth
  routeProtocol: 'anthropic' | 'openai' | 'gemini';
  baseUrl?: string; // fixed for native (informational); editable for custom
  keyEnvVar?: string; // e.g. 'ZAI_API_KEY' — for the key hint
  keyPlaceholder?: string;
  docsUrl?: string;
  formShape: ProviderFormShape;
  featured?: boolean; // pinned as a one-click chip
  regionOf?: string; // e.g. 'minimax' for 'minimax-cn' grouping
}
```

**Construction (data-driven):**

- **Builtin entries** (`openrouter`, `anthropic`, `openai`, `gemini`, `ollama`,
  `custom`) are hand-authored to preserve today's exact labels, presets, and form shapes.
  `gemini` keeps `piProvider: 'google'` (as `PI_AI_CURATED_PRESETS` already does).
- **Native entries** are generated **in the main process** (see §4.1a): iterate
  `getProviders()`, filter to the API-key coding/inference set (see §4.5 allowlist),
  attach `keyEnvVar` via `findEnvKeys()`, derive `routeProtocol` from the first model's
  `api` (`anthropic-messages`→anthropic, `google-*`→gemini, else openai), and mark
  `formShape.modelDropdown = true`. Display names + category come from a small static
  `NATIVE_PROVIDER_META` map (id → {name, category, docsUrl}); everything else is derived.
- **Custom** stays as the escape-hatch entry (`kind: 'custom'`, full form shape).

Rationale for the tiny `NATIVE_PROVIDER_META`: the SDK exposes ids but not
human-friendly display names/categories. The meta map is ~30 lines of labels only — no
models, no pricing, no URLs to maintain. Unknown providers not in the meta map still work
via a generated default name (title-cased id) so an SDK upgrade that adds a provider
degrades gracefully rather than hiding it.

### 4.1a Main-built, IPC-delivered (decision O1 = IPC)

**Decision:** the renderer does **not** import `@earendil-works/pi-ai/compat`. The native
half of the catalog is built in the **main process** and shipped to the renderer over
IPC, matching the existing presets-injection seam (`config-store.ts:445`, which already
takes an injected `getModels`). This keeps the pi-ai registry out of the renderer bundle
and preserves a single source of truth.

Concretely, `provider-catalog.ts` splits into two halves:

- **`shared/provider-catalog.ts`** — SDK-free: the `ProviderCatalogEntry` type,
  `BUILTIN_ENTRIES` (the 6, static), `NATIVE_PROVIDER_META`, `EXCLUDED_NATIVE`,
  `formShape` presets, and pure helpers (`getCatalogEntry`, `titleCase`, category
  ordering) that operate on an entry array. No `pi-ai` import — safe in the renderer.
- **`main/config/provider-catalog-native.ts`** — imports `pi-ai/compat`, runs
  `buildNativeEntries()` + `getNativeModelOptions()`, and exposes the result via a new IPC
  channel `config:getProviderCatalog` (returning `ProviderCatalogEntry[]` incl. each
  native entry's model options). Called once on Settings mount; cached in the renderer
  store. Reuses the same injected-`getModels` pattern as the presets seam for testability.

The renderer merges `BUILTIN_ENTRIES` (local, static) with the IPC-delivered native
entries into the full catalog the `ProviderPicker` renders.

### 4.2 UI — featured chips + searchable catalog

```
Provider
[ Anthropic ] [ OpenAI ] [ OpenRouter ] [ Gemini ] [ Ollama ] [ More Models (Custom) ]

  All providers ⌄   🔍 [ mini| ]
   ── Coding plans ──   z.ai (GLM) · MiniMax · Kimi · DeepSeek · Moonshot · GLM (CN) …
   ── Fast inference ── Groq · Cerebras · xAI · Mistral · Together · Fireworks · NVIDIA …
   ── Local ──          Ollama
```

- **Featured chips**: the 6 `featured` entries, rendered exactly as today's grid
  (`SettingsAPI.tsx:130`). Selecting a chip == today's `changeProvider`. Zero learning
  curve for existing users; Custom keeps its "More Models" label.
- **Searchable combobox** ("All providers"): a new `ProviderPicker` component. Typeahead
  filters by name/id/alias; results grouped by `category`. Selecting an entry sets
  `provider = entry.id`. The currently-selected native provider shows as a chip/summary
  above the combobox with its name + key-status.
- The featured chip for a provider and its combobox entry are the _same_ catalog entry —
  selecting from either path is identical state.

### 4.3 Form adapts to `formShape`

`SettingsAPI` reads `formShape` for the active entry instead of `provider === 'custom'`
checks:

| Field                | native                               | custom            | ollama          | builtin cloud |
| -------------------- | ------------------------------------ | ----------------- | --------------- | ------------- |
| API key              | ✔                                    | ✔                 | optional        | ✔             |
| Base URL             | ✖ (registry)                         | ✔                 | ✔               | ✖             |
| Protocol selector    | ✖                                    | ✔                 | ✖               | ✖             |
| Model                | **searchable** list from `getModels` | searchable/manual | detected/manual | searchable    |
| Context / max tokens | ✖ (registry)                         | ✔                 | ✔               | ✖             |
| Manual model toggle  | ✔ (for new/unknown ids)              | ✔                 | ✔               | ✖             |

Net effect: native providers render a **shorter** form than Custom — key + model field
only. The `CommonProviderSetupsCard` remains, shown only when the Custom entry is active.

**Model field = searchable combobox (decision O2 = show all + searchable).** Wherever the
form shows a registry-backed model list (native, builtin, custom-with-dropdown), the
`<select>` is replaced by a searchable combobox that lists **all** models the registry
returns for the provider — no cap, no curation. It reuses the `ProviderPicker` typeahead
component (§6.7) so a short coding-plan list (z.ai/MiniMax) reads as a simple dropdown
while a long aggregator list (OpenRouter) stays navigable by typing. The existing
manual-model toggle still switches the field to free-text for ids not yet in the registry.
This retires the per-provider `PI_AI_CURATED_PRESETS` curation for native/registry paths.

### 4.4 Routing & auth

- `resolvePiRouteProtocol` and `buildPiModelLookupCandidates` gain awareness of the
  catalog: for a native entry, the candidate list includes `{ provider: piProvider,
model: id }` first, so `getModel('zai','glm-5')` hits the native model. No synthetic
  fallback for known native models.
- Auth: `agent-runner.ts:2569` uses `entry.piProvider` for `setRuntimeApiKey`. For a
  native provider the model's own `provider` already equals `piProvider`, so the
  secondary `setRuntimeApiKey(piModel.provider, …)` at `:2573` is a no-op — correct.

### 4.5 Native provider allowlist (v1)

Included (simple single-key providers): `zai`, `zai-coding-cn`, `minimax`, `minimax-cn`,
`kimi-coding`, `moonshotai`, `moonshotai-cn`, `deepseek`, `xai`, `groq`, `cerebras`,
`mistral`, `together`, `fireworks`, `nvidia`, `ant-ling`, `huggingface`,
`vercel-ai-gateway`, `opencode`, `opencode-go`, `xiaomi*`.

Excluded from v1 (multi-field creds or OAuth — remain via Custom/extensions):
`amazon-bedrock`, `google-vertex`, `azure-openai-responses`, `cloudflare-workers-ai`,
`cloudflare-ai-gateway`, `github-copilot`, `openai-codex`.

The allowlist is expressed as an exclude-set over `getProviders()` so new SDK providers
appear automatically unless explicitly excluded.

**Region duplicates (decision = separate tagged entries).** Regional variants
(`minimax` + `minimax-cn`, `zai` + `zai-coding-cn`, `moonshotai` + `moonshotai-cn`) are
surfaced as **distinct catalog entries**, each its own selectable provider with its own
credential slot — _not_ collapsed behind a region toggle. Each carries a `regionOf`
pointer to its base id and a short region tag (e.g. "CN") rendered as a chip in the
picker so the pair reads as related without hiding either. This keeps selection explicit
and keys independent (a user may hold only the CN or only the global key).

---

## 5. File-by-file change map

| Area             | File                                                       | Change                                                                                           |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Catalog (shared) | `src/shared/provider-catalog.ts` **(new)**                 | SDK-free: entry type, `BUILTIN_ENTRIES`, `NATIVE_PROVIDER_META`, `EXCLUDED_NATIVE`, pure helpers |
| Catalog (main)   | `src/main/config/provider-catalog-native.ts` **(new)**     | imports `pi-ai/compat`; `buildNativeEntries()` + model options                                   |
| IPC              | main IPC registration + `preload`/renderer client          | new `config:getProviderCatalog` channel returning `ProviderCatalogEntry[]`                       |
| Types            | `src/shared/api-model-presets.ts:1`                        | widen `SharedProviderType` to `string` alias + keep 6 as consts                                  |
| Types            | `src/renderer/types/index.ts:841,849`                      | widen `ProviderType`, add `native:` `ProviderProfileKey` variant                                 |
| Types            | `src/main/config/config-store.ts:58,66`                    | mirror widening                                                                                  |
| Validation       | `config-store.ts:493,481,508`                              | `isProviderType`/`isProfileKey` accept catalog ids                                               |
| Profile keys     | `useApiConfigState.ts:98,114`                              | `profileKeyFromProvider`/`toProvider` handle `native:<id>`                                       |
| Routing          | `pi-model-resolution.ts:44,255`                            | catalog-aware protocol + candidate ordering                                                      |
| Auth             | `agent-runner.ts:2562-2576`                                | use `entry.piProvider`                                                                           |
| State            | `useApiConfigState.ts`                                     | `changeProvider(id)`, model options from `getModels`, form-shape derivation                      |
| UI               | `src/renderer/components/SearchableCombobox.tsx` **(new)** | generic typeahead primitive (provider picker + model field)                                      |
| UI               | `src/renderer/components/ProviderPicker.tsx` **(new)**     | `SearchableCombobox` fed the catalog (grouped, tagged)                                           |
| UI               | `settings/SettingsAPI.tsx:123-393`                         | featured chips + `ProviderPicker`; searchable model field (`:323`); `formShape`-driven fields    |
| i18n             | `locales/{en,zh,ru,hu}/*`                                  | picker strings + native provider names/categories (all **four** locales)                         |
| Tests            | `src/tests/...`                                            | catalog generation, migration round-trip, native model resolution                                |

---

## 6. Detailed implementation

### 6.1 Catalog modules (shared + main, per O1 = IPC)

**`shared/provider-catalog.ts` (SDK-free, renderer-safe):**

- `NATIVE_PROVIDER_META: Record<string, { name; category; docsUrl?; regionOf?; regionTag? }>`
  — labels/metadata only, no models.
- `EXCLUDED_NATIVE = new Set([...cloud/oauth ids...])`.
- `BUILTIN_ENTRIES: ProviderCatalogEntry[]` — the 6, authored to match current behavior.
- `getCatalogEntry(catalog, id): ProviderCatalogEntry | undefined`, with a `custom`
  fallback for unknown ids so a stale saved id never crashes the form.
- Pure helpers: `titleCase(id)`, category ordering/grouping for the picker.
- **No `pi-ai` import** — this is what the renderer bundles.

**`main/config/provider-catalog-native.ts` (imports `pi-ai/compat`):**

- `buildNativeEntries(deps?)`: `getProviders().filter(id => !EXCLUDED_NATIVE.has(id))`,
  `.map(id => …)` deriving `routeProtocol` from `getModels(id)[0]?.api`, `keyEnvVar` from
  `findEnvKeys(id)?.[0]`, `name`/`category`/`regionOf` from `NATIVE_PROVIDER_META` or a
  `titleCase(id)` default, and attaching that entry's `modelOptions` from
  `getModels(id)`. `deps` allows injecting `getProviders`/`getModels` in tests (same
  pattern as the presets seam at `config-store.ts:445`).
- `getFullProviderCatalog()` = `BUILTIN_ENTRIES` ++ `buildNativeEntries()` (memoized).

**IPC:** register `config:getProviderCatalog` → returns the full catalog (builtin +
native, each native entry carrying its `modelOptions`). Renderer calls it once on Settings
mount and caches it; `getCatalogEntry` then operates on the cached array. Because builtin
entries are also present in `BUILTIN_ENTRIES` locally, the picker can render featured chips
instantly and hydrate the native list when the IPC resolves.

### 6.2 Type widening

- `ProviderType` becomes `string` **at the storage boundary** but keep a
  `BuiltinProviderType` union for the 6 where exhaustive logic still benefits. Concretely:
  `export type ProviderType = string;` plus
  `export type BuiltinProviderType = 'openrouter' | 'anthropic' | 'custom' | 'openai' | 'gemini' | 'ollama';`
  Audit every `switch`/comparison on `ProviderType` — most already use `===` against a
  literal and keep working; none rely on exhaustiveness except the validators (§7).
- `EmbeddingProviderType` unchanged (still `ProviderType | 'local'`); memory LLM provider
  stays constrained to builtin ids via a narrower validator.

### 6.3 Profile keys — `native:<piProvider>`

Extend `ProviderProfileKey` to `BuiltinProfileKey | \`native:${string}\``. Update:

- `profileKeyFromProvider(provider, protocol)`: if the catalog entry is `kind:'native'`,
  return `native:${entry.piProvider}`; else current behavior.
- `profileKeyToProvider(key)`: `native:*` → `{ provider: <catalog id>, customProtocol:
routeProtocol }`.
- `modelPresetForProfile` / `defaultProfileForKey`: native keys derive default model from
  `getNativeModelOptions(entry)[0]`.

Each native provider thus gets its own saved-credential slot, exactly like the existing
per-provider slots — switching between z.ai and MiniMax preserves both keys.

### 6.4 Validation gates

- `isProviderType(v)` → `typeof v === 'string' && getCatalogEntry(v) !== undefined`
  (accept any catalog id; unknown strings still coerce to fallback).
- `isProfileKey(v)` → builtin set **or** `/^native:[a-z0-9-]+$/` with a known piProvider.
- Keep these permissive-but-bounded: an id absent from the current catalog (e.g. an
  excluded/removed provider) coerces to the default set rather than throwing.

### 6.5 Routing

- `resolvePiRouteProtocol(provider, customProtocol)`: first consult
  `getCatalogEntry(provider)`; if native, return `entry.routeProtocol`. Preserve existing
  branches for the 6 builtin/custom cases as the fallback.
- `buildPiModelLookupCandidates(modelString, { configProvider, rawProvider })`: when
  `rawProvider` is a native catalog id, unshift `{ provider: entry.piProvider, model }`
  so the native `getModel` hit precedes generic fallbacks. Existing candidate logic
  (parsed `provider/model`, `COMMON_FALLBACK_PROVIDERS`) stays as the tail.
- Result: native providers resolve registry models (correct `compat`, cost, window);
  synthetic fallback only fires for genuinely-unknown model ids (still supported via the
  manual-model toggle → context/maxTokens inputs shown).

### 6.6 `useApiConfigState`

- `changeProvider(id: string)`: look up the catalog entry; set `provider`, derive
  `customProtocol = entry.routeProtocol` (for storage compatibility), switch the active
  profile key via `profileKeyFromProvider`, hydrate model options from
  `getNativeModelOptions` (native) or presets (builtin) or empty (custom/ollama).
- `presets`/`currentPreset`/`modelOptions`: native path pulls from the registry; builtin
  path keeps `API_PROVIDER_PRESETS`.
- `requiresApiKey`, `isOllamaMode`, guidance: derive from `formShape` flags.

### 6.7 UI components

- `SearchableCombobox.tsx` **(new, generic)**: controlled typeahead. Props: `items:
{id;label;group?;badge?}[]`, `value`, `onChange`, `placeholder`, `t`. Renders a trigger
  button (selected label + optional status dot) and a filterable, optionally group-headed
  popover list. Keyboard nav + `aria` roles. Theme-aware Tailwind matching the existing
  config-set `<select>` styling. This is the single reusable primitive behind both the
  provider picker and the model field (decision O2).
- `ProviderPicker` = `SearchableCombobox` fed the catalog: items grouped by `category`,
  region tag as `badge`, key-status as the trigger status dot.
- **Model field** = `SearchableCombobox` fed the active provider's model options (all of
  them, per O2). Below a small threshold (e.g. ≤ 8 items) it may render as a plain list
  for zero-friction selection, but it's the same component — no separate model `<select>`.
  The manual-model toggle swaps it for a free-text input as today.
- `SettingsAPI.tsx`: replace the hard-coded provider `.map` (`:131`) with (a) featured
  chips from `catalog.filter(e => e.featured)` and (b) `<ProviderPicker>` for the rest;
  replace the model `<select>` (`:323`) with the model-field combobox. Gate the
  protocol/base-URL/context/setups blocks on `formShape.*` instead of
  `provider === 'custom' | 'ollama'`.

### 6.8 i18n (all four locales)

Per project memory, locales are **en/zh/ru/hu** (not EN+ZH). Add:
`api.provider.allProviders`, `api.provider.searchPlaceholder`,
`api.provider.categories.{codingPlan,inference,local,featured}`,
`api.provider.keyEnvHint` ("or set {{envVar}}"), and native provider display names under
`api.provider.native.*`. Fallback to English + title-cased id when a name key is missing,
so an SDK-added provider is never blank. Run `ls locales/` before editing (memory note).

---

## 7. Migration & backward compatibility

**Persisted config is never rewritten.** The change is additive:

1. The 6 legacy `provider` values are valid catalog ids → existing `ApiConfigSet`s load
   unchanged, same active profile key, same model.
2. `isProviderType`/`isProfileKey` widen (§6.4) so a _newly saved_ native id/profile key
   survives a load round-trip. Without this, native selections would be silently reset —
   this is the one mandatory migration change.
3. New native providers only _add_ profile-key slots; no existing slot changes shape.
4. `customProtocol` remains populated for every entry (native → `routeProtocol`), so any
   downstream reader that still consults it keeps working.
5. **Forward-compat / downgrade:** if a user saves a native provider then downgrades to a
   build without it in the catalog, `getCatalogEntry` misses → coerced to default set
   (the config-set's saved `custom:*`/builtin profiles are untouched, so no data loss;
   only the active selection resets). Document this in the PR.

No schema-version bump is required (the config store is validate-and-coerce, not
versioned-migrate). Add a targeted test asserting a round-trip of a `zai` config set
(§8.2).

---

## 8. Testing plan

### 8.1 Catalog

- `getProviderCatalog()` returns the 6 builtin + expected native ids; excluded ids absent.
- Every native entry has a non-empty `name`, a valid `routeProtocol`, and (where the SDK
  provides one) a `keyEnvVar`.
- `getNativeModelOptions('zai')` is non-empty and includes a GLM id.

### 8.2 Migration / config-store

- Load a fixture config set with `provider:'openrouter'` → identical output (no regressn).
- Load a fixture with `provider:'zai', activeProfileKey:'native:zai'` → preserved
  (post-widening), not coerced.
- Load a fixture with `provider:'bedrock'` (excluded) → coerced to default, no throw.

### 8.3 Routing

- `resolvePiRegistryModel('zai/glm-5', { rawProvider:'zai' })` returns a registry model
  with `compat.thinkingFormat === 'zai'` (native, not synthetic).
- `resolvePiRouteProtocol('minimax')` → matches the registry model's api family.
- Unknown native model id → synthetic fallback still produced (manual-model path).

### 8.4 State / UI (renderer)

- `changeProvider('minimax')` hydrates model options from the registry and swaps the
  profile slot without clobbering the previously-active provider's saved key.
- `formShape` hides base-URL/protocol for native, shows them for custom/ollama.

### 8.5 Manual smoke (via `/run`)

Configure z.ai with a real key, pick `glm-5`, run a one-shot; confirm thinking/tool
streaming works (validates `zaiToolStream`/`thinkingFormat`). Repeat for MiniMax.

---

## 9. Decisions & open questions

### Resolved

- **O1 — Renderer bundling vs IPC → IPC.** The native catalog is built in the main
  process and delivered over the `config:getProviderCatalog` IPC channel; the renderer
  never imports `pi-ai/compat`. Reuses the injected-`getModels` seam at
  `config-store.ts:445`. Details in §4.1a / §6.1.
- **O2 — Model list size → show all + searchable model field.** The model dropdown for a
  native provider lists **every** model `getModels(piProvider)` returns — no curation, no
  cap — and the model field is a **searchable combobox** (reuse the `ProviderPicker`
  typeahead pattern) so long-tail aggregators (OpenRouter-style) stay usable while
  short-list coding plans (z.ai/MiniMax/Kimi) read as a simple list. The manual-model
  toggle remains for ids not yet in the registry. Details in §4.3.
- **O3 — Region duplicates → separate tagged entries.** `minimax`/`minimax-cn`,
  `zai`/`zai-coding-cn`, `moonshotai`/`moonshotai-cn` are distinct selectable entries,
  each with its own credential slot and a region tag chip. Details in §4.5.
- **O4 — Diagnostics → registry-aware (fixed post-ship).** The diagnostics engine keyed
  off `provider`/`baseUrl` and only knew the 6 builtin presets, so a native provider
  (empty user `baseUrl`) fell through to a `localhost` fallback — the connection test hit
  `localhost:443` and failed at TCP. Fixed by `resolveNativeProviderInfo(provider, model)`
  in `pi-model-resolution.ts`, which returns the registry base URL + route protocol for
  native catalog providers (catalog-warm and cold-start paths). `api-diagnostics.ts` now
  uses it in `resolveEffectiveUrl`, `resolveClientBaseUrl`, and the
  `isOpenAICompatible`/`isAnthropicCompatible`/`isGeminiProtocol` predicates so native
  providers are probed against their real endpoint with the correct SDK client.

---

## 10. Phased rollout / task checklist

- [x] **P0 — Catalog modules** — `shared/provider-catalog.ts` (SDK-free) +
      `main/config/provider-catalog-native.ts` (pi-ai) + `config:getProviderCatalog` IPC
      channel + unit tests. No UI wiring. **Done 2026-07-06** — see §10a.
- [x] **P1 — Type & validator widening** (shared + renderer + config-store) + migration
      tests. Behavior-neutral; native ids now _survivable_ but not yet selectable.
      **Done 2026-07-06** — see §10b.
- [x] **P2 — Routing** (`pi-model-resolution.ts`) + auth (`agent-runner.ts`) +
      resolution tests (§8.3). Native models resolve correctly if selected.
      **Done 2026-07-06** — see §10c.
- [x] **P3 — State** (`useApiConfigState`) + profile keys (`native:<id>`).
      **Done 2026-07-06** — see §10d.
- [x] **P4 — UI** (`ProviderPicker` + `SettingsAPI` form-shape) + i18n (4 locales). **Done 2026-07-06** — see §10e.
- [x] **P5 — Smoke** (§8.5), docs, and move this file's Status → Implemented; add an
      as-built note to `docs/design/archive/` if it diverges. **Done 2026-07-06** — see §10f.

Each phase is independently reviewable; P0–P2 ship no user-visible change, de-risking the
UI work in P3–P4.

### §10a — P0 as-built notes

Delivered exactly as designed with these clarifications discovered during implementation:

- `findEnvKeys()` from `pi-ai/compat` is runtime-env-dependent (returns `undefined` when
  the env var isn't set). Env var names are hard-coded in `NATIVE_PROVIDER_META` instead.
- `getProviders()` and `getModels()` are confirmed synchronous in the current SDK. The
  `ProviderCatalogDeps` interface accepts sync or async for forward-compat.
- `mistral` uses `mistral-conversations` API (not `openai-completions`). `apiToRouteProtocol`
  uses `startsWith('google-')` prefix matching (not exact strings) for gemini variants.
- `deriveRouteProtocol` inspects ALL models (not just the first) and takes priority:
  anthropic > gemini > openai. A `routeProtocol` override in `NATIVE_PROVIDER_META` wins.
- Cache strategy: promise-memoised on success only. Import failures clear the cache so the
  next IPC call retries (transient startup recovery).
- 57 unit tests in `src/tests/config/provider-catalog.test.ts`.

### §10b — P1 as-built notes

Delivered with significant hardening beyond the original design spec:

- `src/shared/provider-ids.ts` (new) — single source of truth for all provider-id and
  profile-key logic. Used by both main process and renderer to prevent drift.
  - `normalizeProviderId`: trims, rejects `'local'` (reserved for embedding), and rejects
    dangerous prototype keys (`__proto__`, `constructor`, `prototype`).
  - `isValidProfileKey`: strict canonical form — `'native: zai '` is rejected (suffix must
    equal its normalized form), preventing duplicate credential slots.
  - `isNativeProfileKey`, `deriveProfileKey`, `profileKeyToProviderInfo`.
- `ProviderType = string` (open) + `BuiltinProviderType` (6-value union for exhaustive
  switches). `ProviderProfileKey = BuiltinProfileKey | \`native:\${string}\``.
- Profile key scheme: native providers use `native:<piProvider>` (e.g. `native:zai`), not
  the raw provider id. This ensures `isValidProfileKey` accepts it on load.
- `getPresetForProvider()` helper in `shared/api-model-presets.ts` uses own-property checks
  to prevent prototype-chain surprises when indexing preset objects.
- Memory LLM sub-config provider stays constrained to builtin ids via `isBuiltinProviderId`
  (design §6.2 preserved).
- `modelPresetForProfile` returns `SharedProviderPreset | undefined`; callers use
  `modelPresetForProfileSafe` (wraps with `EMPTY_PRESET`) where a guaranteed value is needed.
- 44 unit tests in `src/tests/config/provider-type-widening.test.ts` using real shared
  implementations (no inline mirrors).

### §10c — P2 as-built notes

Delivered exactly as designed with these implementation details:

- `getCachedProviderCatalogSync()` added to `provider-catalog-native.ts` — a
  parallel `resolvedCatalogSync` variable is populated when the promise settles
  (success only; failures keep it null). This gives `resolvePiRouteProtocol` and
  `buildPiModelLookupCandidates` synchronous access to the catalog without
  threading it as a parameter through every call site.
- `resetProviderCatalogCache()` now also clears `resolvedCatalogSync` so tests
  that call it get a clean slate on both fields.
- `resolvePiRouteProtocol`: builtins (`custom`, `ollama`, `openai`, `openrouter`,
  `gemini`) return immediately via the existing fast-path branches — the catalog
  lookup is only reached for unknown/native ids, so the mock assertion
  `expect(mockGetCachedCatalog).not.toHaveBeenCalled()` holds for all five
  builtin fast paths.
- `buildPiModelLookupCandidates`: native candidate is unshifted before the
  existing logic. Deduplication via the `seen` set prevents the same
  `provider/model` pair from appearing twice in the tail fallbacks. For a
  prefixed model string `zai/glm-5` where the prefix matches `piProvider`,
  the bare `glm-5` id is extracted; for non-matching prefixes the full string
  is passed through unchanged.
- `agent-runner.ts` auth block: consults `getCachedProviderCatalogSync()` to
  derive `piProvider` from `entry.piProvider` for native entries; falls back
  to the existing `provider === 'custom' ? customProtocol : provider` logic
  for builtins and when the catalog isn't yet populated.
- 13 new P2 tests in `tests/pi-model-resolution.test.ts` (32 total in that
  file). `vi.mock('../src/main/config/provider-catalog-native', ...)` with a
  `vi.fn()` mock that each test controls via `mockReturnValue`.
- 2818/2818 tests passing, `tsc --noEmit` clean.

### §10d — P3 as-built notes

Delivered as designed with these implementation details:

- `useApiConfigState` gains a `providerCatalogRef` (sync, always-current) and
  `providerCatalog` state (drives re-renders). Both are initialised to `BUILTIN_ENTRIES`
  so the hook is functional before the IPC call completes.
- Catalog loaded in the existing `load()` effect alongside presets and config, via
  `window.electronAPI.config.getProviderCatalog()` with a `.catch(() => BUILTIN_ENTRIES)`
  fallback. `cancelled` guard prevents stale updates after unmount.
- `changeProvider(id)`: reads `providerCatalogRef.current` (synchronous, no re-render
  cost), derives `resolvedProtocol` from `entry.routeProtocol` for native entries,
  dispatches `SET_ACTIVE_PROFILE_KEY` with the derived profile key.
- `activeCatalogEntry` = `getCatalogEntry(providerCatalog, provider)` (memo).
- `activeFormShape` = `activeCatalogEntry?.formShape ?? null`.
- `modelOptions`: native path uses `activeCatalogEntry.modelOptions` (cast to
  `ProviderModelInfo[]`); builtin/ollama path unchanged.
- `requiresApiKey`: native path uses `!activeFormShape.apiKey`; builtin/custom path
  keeps the existing loopback-gateway logic. `isOllamaMode` uses
  `activeFormShape.baseUrl && !activeFormShape.apiKey` for native (correct for any
  future keyless local provider), falls back to `provider === 'ollama'`.
- Return value gains `providerCatalog`, `activeCatalogEntry`, `activeFormShape`.
- 13 new P3 tests in `tests/api-config-state.test.ts` covering catalog lookup,
  profile key derivation, formShape contract, modelOptions, and source-level wiring
  assertions. 2856/2856 tests passing.

### §10e — P4 as-built notes

Delivered as designed with these implementation details:

- `src/renderer/components/SearchableCombobox.tsx` **(new)** — generic controlled
  typeahead combobox. Implements the ARIA combobox pattern: `role="combobox"` on
  the always-present trigger button plus the search input (when open), with
  `aria-controls`, `aria-expanded`, `aria-activedescendant`, and stable
  `useId()`-scoped option ids. `getElementById` used for scroll-to-focused (avoids
  CSS-selector crash with colon-containing `useId()` output). `filterItems` helper
  extracted to prevent double-computation in `onChange` + `useMemo`. `focusedIndex`
  clamped via a `useEffect` when item list shrinks asynchronously. `disabled` effect
  closes popover when prop flips true mid-interaction. Selected label falls back to
  raw `value` string when item is not yet in list (async loading).
- `src/renderer/components/ProviderPicker.tsx` **(new)** — thin wrapper: feeds
  non-featured catalog entries (grouped by `ProviderCategory`) into
  `SearchableCombobox`. `CATEGORY_LABEL_KEY` typed as `Record<ProviderCategory, string>`
  — exhaustive, no string-indexed fallback.
- `src/renderer/components/settings/SettingsAPI.tsx` — featured chips rendered from
  `getFeaturedEntries(providerCatalog)`; `<ProviderPicker>` below for the full catalog.
  Active native provider shown as a summary chip with optional docs link.
  `showProtocol` hard-gated to `provider === 'custom'` (not formShape-derived) to
  prevent protocol selector appearing for native providers. `showModelDropdown`
  defaults to `false` when `activeFormShape` is null so builtins keep the legacy
  `<select>`. `activeIsNonFeatured` fully null-safe guard. `getPresetName()` helper
  replaces `unknown` cast for preset label resolution.
- `api.providerPicker.*` keys added to all four locales (en/zh/ru/hu) under a new
  namespace that does not collide with the existing `api.provider` string key.
- `src/tests/settings/provider-picker.test.ts` **(new)** — 30 tests covering:
  `filterItems` (empty/label/id/partial/no-match), `buildGroupedList` (group headers,
  deduplication, ungrouped), catalog mapping (featured/non-featured/sorting/grouping/
  regionTag), `formShape` display-flag derivation (native/custom/ollama/builtin),
  `activeIsNonFeatured` null-safety, and `NATIVE_PROVIDER_META` completeness.
- 2901/2901 tests passing, `tsc --noEmit` clean.

### §10f — P5 as-built notes

Automated test suite fully green (2901/2901 tests, `tsc --noEmit` clean). Manual smoke
(§8.5) requires real API keys and is deferred to the first QA pass with live credentials.
Key divergences from the design discovered across all phases, recorded here as the
authoritative as-built reference:

- **IPC channel name:** design doc wrote `config:getProviderCatalog` (colon) throughout;
  the implementation uses `config.getProviderCatalog` (dot) to match the existing IPC
  naming convention in this codebase (`ipcMain.handle('config.getProviderCatalog', …)`,
  `ipcRenderer.invoke('config.getProviderCatalog')`). Preload bridge exposes it as
  `window.electronAPI.config.getProviderCatalog()`.
- **`NATIVE_PROVIDER_IDS` and `NATIVE_ROUTE_PROTOCOL_MAP` constants** added to
  `shared/provider-catalog.ts` — derived from `NATIVE_PROVIDER_META` keys at module
  load time. Used by `pi-model-resolution.ts` for synchronous catalog-aware routing
  without threading the full catalog array through call sites.
- **`moonshotai-cn`** included in `NATIVE_PROVIDER_META` and the v1 allowlist (design
  §4.5 listed it; Appendix A omitted it — the implementation follows §4.5).
- **`opencode-go`** is a separate `NATIVE_PROVIDER_META` entry (not collapsed with
  `opencode`); both carry `OPENCODE_API_KEY` and appear as distinct catalog entries.
- **`xiaomi` provider family:** four entries in practice — `xiaomi`, `xiaomi-coding`,
  `xiaomi-speed`, `xiaomi-cn` — each with its own env var; all included.
- **`formShape` presets** (`BUILTIN_SHAPE`, `NATIVE_SHAPE`, `CUSTOM_SHAPE`,
  `OLLAMA_SHAPE`) defined as named constants in `shared/provider-catalog.ts` and
  referenced directly rather than inlined per entry.
- **`showProtocol`** in `SettingsAPI.tsx` is hard-gated to `provider === 'custom'` (not
  derived from `formShape.protocol`) to prevent the protocol selector appearing for
  native entries whose `formShape.protocol` is false — a belt-and-suspenders guard
  given the protocol field is only meaningful for the custom escape hatch.
- **`CATEGORY_LABEL_KEY`** in `ProviderPicker.tsx` typed as
  `Record<ProviderCategory, string>` (exhaustive) — compiler catches any future
  `ProviderCategory` additions that are missing a label.
- **`monotonicGeneration` counter** in `provider-catalog-native.ts` — prevents an
  in-flight promise that resolves after `resetProviderCatalogCache()` from overwriting
  the cleared state. Not in the original design; added for test correctness.
- **`src/tests/` vs `tests/`:** P0–P1 tests live under `src/tests/config/`; P2–P3
  tests live under the top-level `tests/` directory (matching the existing split for
  main-process unit tests). P4 picker tests are in `src/tests/settings/`.
- Archived to `docs/design/archive/native-provider-catalog.md`.

### Later tiers (not this plan)

- **T-Cloud:** Bedrock/Vertex/Azure/Cloudflare as structured multi-field providers.
- **Level B:** OAuth subscriptions (Codex, Claude Pro/Max, Copilot) via
  `AuthStorage.login` + `OAuthLoginCallbacks` (needs main↔renderer OAuth UI).

---

## 11. Appendix A — native providers (v1 allowlist)

| pi id                      | Suggested name       | Category    | Env var                 | Route             |
| -------------------------- | -------------------- | ----------- | ----------------------- | ----------------- |
| `zai`                      | z.ai (GLM)           | coding-plan | `ZAI_API_KEY`           | anthropic/openai¹ |
| `zai-coding-cn`            | z.ai Coding (CN)     | coding-plan | `ZAI_CODING_CN_API_KEY` | "                 |
| `minimax`                  | MiniMax              | coding-plan | `MINIMAX_API_KEY`       | openai            |
| `minimax-cn`               | MiniMax (CN)         | coding-plan | `MINIMAX_CN_API_KEY`    | openai            |
| `kimi-coding`              | Kimi (Moonshot)      | coding-plan | `KIMI_API_KEY`          | anthropic         |
| `moonshotai`               | Moonshot             | coding-plan | `MOONSHOT_API_KEY`      | openai            |
| `deepseek`                 | DeepSeek             | coding-plan | `DEEPSEEK_API_KEY`      | openai            |
| `xai`                      | xAI (Grok)           | inference   | `XAI_API_KEY`           | openai            |
| `groq`                     | Groq                 | inference   | `GROQ_API_KEY`          | openai            |
| `cerebras`                 | Cerebras             | inference   | `CEREBRAS_API_KEY`      | openai            |
| `mistral`                  | Mistral              | inference   | `MISTRAL_API_KEY`       | openai²           |
| `together`                 | Together AI          | inference   | `TOGETHER_API_KEY`      | openai            |
| `fireworks`                | Fireworks            | inference   | `FIREWORKS_API_KEY`     | openai            |
| `nvidia`                   | NVIDIA NIM           | inference   | `NVIDIA_API_KEY`        | openai            |
| `ant-ling`                 | Ant Ling             | coding-plan | `ANT_LING_API_KEY`      | openai            |
| `huggingface`              | Hugging Face         | inference   | `HF_TOKEN`              | openai            |
| `vercel-ai-gateway`        | Vercel AI Gateway    | inference   | `AI_GATEWAY_API_KEY`    | openai            |
| `opencode` / `opencode-go` | OpenCode Zen/Go      | coding-plan | `OPENCODE_API_KEY`      | openai            |
| `xiaomi*`                  | Xiaomi MiMo (+plans) | coding-plan | `XIAOMI_*_API_KEY`      | openai            |

¹ z.ai exposes both an Anthropic-style and OpenAI-style surface; `routeProtocol` is
derived per the registry model's `api`. ² Mistral migrated to `mistral-conversations` in
the SDK — verify the registry model's `api` and let it flow through rather than forcing
`openai-completions` (see `docs/custom-provider.md` migration note).

_Names/categories above seed `NATIVE_PROVIDER_META`; the model lists, base URLs, pricing,
and quirks are **not** listed here — they come live from `getModels()`._

## 12. Appendix B — why z.ai/MiniMax are "Level A", not subscriptions

pi's true subscriptions (`docs/providers.md` §Subscriptions) are OAuth-only: ChatGPT
Plus/Pro (Codex), Claude Pro/Max, GitHub Copilot. z.ai and MiniMax "coding plans" are
**API-key** providers — you obtain a key from your plan and set it like any other key.
They therefore need no OAuth machinery, which is exactly why this plan is tractable and
OAuth subscriptions are deferred to Level B.
