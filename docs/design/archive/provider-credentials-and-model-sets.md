# Provider Credentials & Model Sets — Design & Implementation Plan

**Created:** 2026-10-02
**Status:** **Implemented — all phases done 2026-10-07.** Phases 0–4 shipped in app 1.0.9
(`b2c4d56b`, `330989ec`, `60d5277c`, `c381f8c3`, `b853c811`, `553c5da7`). Phase 5 — the first-run
wizard and the removal of what only the old dialog used (`994043f3`, `91e55d9b`) — and Phase 6, the
documents, are not in a release yet. §14 is the as-built summary.
**Author:** AI-assisted design session
**Baseline:** pi-ai / pi-coding-agent **0.87.1**, app **1.0.8** (HEAD `90136401`). Verified against
source 2026-10-03; §13 records what the original 0.85.1/1.0.7 draft got wrong.
**Provenance:** user-initiated redesign of Settings → API Settings. Replaces the single flat
provider form with two concerns: _which providers exist and how they authenticate_ (machine-level,
configured once) and _which model a config set uses_ (per-chat, chosen often).
**Security classification:** **Medium.** Changes _where_ credentials live in the config schema, not
_how_ they are protected — the encrypted `electron-store` boundary is unchanged (§9.1).

> **Reading note.** §§1–6 and §§8–13 are the design and its plan as they were written and
> approved, left intact. Their line references describe the code before each phase, and 11 of
> the document's links point at three files that have since been deleted (`useApiConfigState.ts`,
> `SettingsAPI.tsx`, `ProviderPicker.tsx`). What was built is recorded phase by phase in §7 — the
> decisions taken with the user, what the read before each phase found, the tests, the reviews and
> the manual passes — and summed up in §14, which also says where the build departed from the
> design and lists everything that was noticed and left alone.

---

## 1. Problem

### 1.1 The complaint

Today the config set is the unit of provider configuration, so **every config set must carry a
complete provider setup, credentials included**. Switching setups means re-entering an API key.
The user asked for API Settings to split in two — _provider configuration_ (where credentials are
entered) and _model settings_ (where a config set picks an already-configured provider).

### 1.2 As-built, and why it produces that pain

The persisted model is a **flat projection of the active config set** plus the set list:

```ts
// src/main/config/config-store.ts:116
export interface ProviderProfile {
  apiKey: string;
  baseUrl?: string;
  model: string; // ← model lives *inside* the credential object
  contextWindow?: number;
  maxTokens?: number;
}

// src/main/config/config-store.ts:124
export interface ApiConfigSet {
  id: string;
  name: string;
  isSystem?: boolean;
  provider: ProviderType;
  customProtocol: CustomProtocolType;
  activeProfileKey: ProviderProfileKey;
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>; // ← full credential map, per set
  enableThinking: boolean;
  thinkingLevel: ModelThinkingLevel;
  updatedAt: string;
}
```

`ProviderProfileKey` is the slot space: 8 builtin keys (`openrouter`, `anthropic`, `openai`,
`gemini`, `ollama`, `custom:anthropic`, `custom:openai`, `custom:gemini`) plus
`native:<piProvider>` ([`config-store.ts:106`](../../../src/main/config/config-store.ts#L106),
[`provider-ids.ts`](../../../src/shared/provider-ids.ts)). One slot per provider — the store is
**already keyed by provider**; what is wrong is that the map is nested inside each config set
instead of being global.

Three consequences, each verified in source:

1. **A new set starts with an empty key.** `buildBlankConfigSet()`
   ([`config-store.ts:2036`](../../../src/main/config/config-store.ts#L2036)) calls
   `cloneProfiles(undefined)`, which falls back to `defaultProfiles` — every one of which has
   `apiKey: ''` ([`config-store.ts:438-479`](../../../src/main/config/config-store.ts#L438)). Creating
   a second config set means pasting the same secret again.
2. **Cloning multiplies the secret.** `cloneConfigSet()`
   ([`config-store.ts:1952`](../../../src/main/config/config-store.ts#L1952)) deep-copies the entire
   profile map, so one key exists in N sets and must be rotated in N places.
3. **The form does not match the question being asked.** "Which model do I want for this chat?" and
   "what key do I have for Anthropic?" are answered by the same flat form, tracked by one dirty
   signature ([`buildApiConfigDraftSignature`](../../../src/renderer/hooks/useApiConfigState.ts#L520))
   and one Save button — so a model tweak can drag a key edit along with it.

### 1.3 What this change must not disturb

- **Runtime consumers read only the flat projection.** `agent-runner.ts:2397` (note: the file is
  `src/main/claude/agent-runner.ts`, **not** `src/main/agent/`), `api-diagnostics.ts:533`,
  `memory-llm-client.ts:106`, `session-manager.ts:704,1087,1098`. None of them knows about config
  sets, and none reads `.profiles` or `activeProfileKey`. If the projection keeps its current
  shape, this design is main-process + renderer only.
- **Config-set ids are referenced from SQLite** — `sessions.config_set_id` and
  `scheduled_tasks.config_set_id` ([`database.ts:75,122`](../../../src/main/db/database.ts#L75)),
  plus [`SettingsSchedule.tsx:592`](../../../src/renderer/components/settings/SettingsSchedule.tsx#L592),
  [`ChatView.tsx:158`](../../../src/renderer/components/ChatView.tsx#L158) and the Welcome screen. Set
  ids must survive migration unchanged.
- **`apiKey`, `baseUrl`, `provider`, `customProtocol`, `activeProfileKey` are `DIRECT_READ_KEYS`**
  ([`config-store.ts:415`](../../../src/main/config/config-store.ts#L415)) — read straight from the
  store, bypassing `getAll()` normalization. Any new field must either be added there or kept out
  of hot read paths. **Decision: `providerCredentials` and `customEndpoints` stay out** — neither
  is on a hot read path, and `apiKey`/`baseUrl` already are.
- **Exactly three files outside `config-store.ts` touch `.profiles` / `activeProfileKey`:**
  `useApiConfigState.ts` (78 references), `renderer/types/index.ts` (2, the mirrored types), and
  [`ChatView.tsx:405`](../../../src/renderer/components/ChatView.tsx#L405) (1 — the model-matching
  fallback for sessions predating `configSetId`). That is the whole renderer blast radius.

---

## 2. Design decisions (locked)

| #   | Decision               | Resolution                                                                                                                                                                                   |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Split depth            | **Full data-model split.** Credentials become a property of the provider, not of the config set.                                                                                             |
| 2   | Credential granularity | **One key slot per provider id, machine-wide.** No named variants, no per-set override. Accepted cost: two accounts on one provider need different providers or different machines.          |
| 3   | User-created endpoints | **Only for `custom`.** `customEndpoints[]` is the sole user-named credential object.                                                                                                         |
| 4   | Ollama                 | **One global slot** (`baseUrl` only, keyless). A second local server is a custom endpoint with the `openai` protocol.                                                                        |
| 5   | UI placement           | **Two sidebar entries** — `Providers` and `Model Sets` — replacing `API Settings`.                                                                                                           |
| 6   | Provider editing UX    | **Read-only catalog list with status dots + a `Configure provider…` dialog** that reuses today's provider form.                                                                              |
| 7   | First run              | **Two-step wizard**: create/confirm the provider credential, then choose the model.                                                                                                          |
| 8   | Migration              | **Derive, never invent.** One credential slot per provider from the first set that has one; one endpoint per distinct custom base URL. Set ids, names, models and thinking levels untouched. |
| 9   | Credential source UI   | **Skip** (was §11 Q1). No `stored key` / `env var` dropdown — the app has no resolver for pi's `$NAME` / `!command` forms. The catalog's `keyEnvVar` hint stays.                             |
| 10  | Endpoint default model | **Add `CustomEndpoint.defaultModel?`** (was §11 Q2). `custom` is excluded from registry model lists and has no discovery fallback, so wizard step 2 would otherwise be an empty picker.      |
| 11  | Endpoint ceiling       | **New `MAX_CUSTOM_ENDPOINT_COUNT = 20`** (was §11 Q3), separate from `MAX_CONFIG_SET_COUNT`. Sharing one constant would make the renderer's limit-error parse ambiguous.                     |
| 12  | `reasoning` field      | **Not in this project.** `model-reasoning-override.md` §4.1 targets `ProviderProfile`, which this design deletes; it gets a superseded banner in Phase 6, no code. See §10.5.                |

### 2.1 Why no "provider connection" object for catalog providers

The first draft of this design proposed user-named _connections_. It was rejected in session, and
the rejection is right: the catalog **already is** the list of providers — 6 builtin entries
([`provider-catalog.ts` `BUILTIN_ENTRIES`](../../../src/shared/provider-catalog.ts)),
24 native entries (`NATIVE_PROVIDER_META`), plus `custom`. For every one of those there is one
endpoint and normally one key, so a connections list would only ask the user to name entries the
catalog already names. pi takes the same position: `models.json` keys credentials **by provider
name**, one entry per provider, with no notion of a second credential for one provider
(pi `docs/models.md` § "Configure a compatible endpoint", lines 45-63).

Only `custom` breaks the one-to-one: the user supplies protocol **and** base URL, and may
legitimately run several at once (kiro-gateway, LiteLLM, an internal gateway). That is the entire
justification for `customEndpoints`.

---

## 3. Target data model

### 3.1 Provider credentials — global, one slot per provider

```ts
// src/main/config/config-store.ts
export interface ProviderCredentials {
  apiKey: string;
  /** Endpoint override: custom, ollama, or a native provider's own base URL. */
  baseUrl?: string;
}

/** Keyed by the existing ProviderProfileKey space — one slot per provider id. */
export type ProviderCredentialMap = Partial<Record<ProviderProfileKey, ProviderCredentials>>;
```

`AppConfig` gains `providerCredentials: ProviderCredentialMap`. It replaces the top-level
`profiles` field, which today is nothing but a copy of the active set's map
([`composeProjectedConfig`](../../../src/main/config/config-store.ts#L1611)).

### 3.2 Custom endpoints — the only user-created credentials

```ts
export interface CustomEndpoint {
  id: string; // 'custom-endpoint-1' — stable, never renumbered
  name: string; // 'kiro-gateway'
  protocol: CustomProtocolType; // 'anthropic' | 'openai' | 'gemini'
  baseUrl: string;
  apiKey: string;
  /**
   * Optional model to pre-fill when a set first points at this endpoint
   * (decision #10). `custom` is in BUILTIN_NO_REGISTRY_MODELS
   * (provider-catalog-native.ts:238) so it ships `modelOptions: []`, and
   * unlike `ollama` it has no Discover fallback — without this, wizard
   * step 2 is an empty picker for every gateway user.
   */
  defaultModel?: string;
  updatedAt: string;
}
```

`AppConfig` gains `customEndpoints: CustomEndpoint[]`, capped at `MAX_CUSTOM_ENDPOINT_COUNT`
(decision #11). Guard rail: a set referencing an endpoint cannot have that endpoint deleted (the
pattern OpenHands uses for its Provider Connections —
`https://docs.openhands.dev/openhands/usage/agent-canvas/llm-profiles`).

### 3.3 Config sets — pure model selection

```ts
export interface ApiConfigSet {
  id: ConfigSetId;
  name: string;
  isSystem?: boolean;
  provider: ProviderType; // catalog id ('anthropic' | 'zai' | 'ollama' | …)
  endpointId?: string; // set only when provider === 'custom'
  model: string; // hoisted out of profiles
  contextWindow?: number;
  maxTokens?: number;
  enableThinking: boolean;
  thinkingLevel: ModelThinkingLevel;
  updatedAt: string;
}
```

`profiles` is removed from the set, and `activeProfileKey` with it — both existed only to index the
per-set credential map. **`apiKey`, `baseUrl` and `customProtocol` no longer live on a set.**
`model`, `contextWindow` and `maxTokens` move up from `profiles[activeProfileKey]`: they describe
the model, not the credential. This matches the precedent set by
[`model-reasoning-override.md`](../model-reasoning-override.md) §4.1, which keeps `contextWindow` /
`maxTokens` scoped per endpoint and explicitly not global.

### 3.4 `AppConfig` after the change

```ts
export interface AppConfig {
  // credentials — global, one slot per provider
  providerCredentials: ProviderCredentialMap;
  customEndpoints: CustomEndpoint[];

  // model selection
  configSets: ApiConfigSet[];
  activeConfigSetId: ConfigSetId;

  // projection of the active set — UNCHANGED SHAPE, so agent-runner /
  // diagnostics / memory / scheduler need no edits at all
  provider: ProviderType;
  apiKey: string;
  baseUrl?: string;
  customProtocol?: CustomProtocolType;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  enableThinking: boolean;
  thinkingLevel: ModelThinkingLevel;
  // … rest unchanged
}
```

**The projection is the contract.** Every runtime consumer stays byte-compatible; only the
function that produces it changes.

---

## 4. Resolution — the single seam

`projectFromConfigSet()` ([`config-store.ts:1592`](../../../src/main/config/config-store.ts#L1592))
and `composeProjectedConfig()` ([`:1965`](../../../src/main/config/config-store.ts#L1965)) are the only
two places that turn a config set into runtime configuration. Everything downstream — model
resolution, auth injection, diagnostics, memory LLM, the scheduler — consumes the projection. That
makes them the whole blast radius of the main-process change.

```
set = { provider:'custom', endpointId:'ce-1', model:'claude-opus-5' }
                                  │
                                  ▼
        resolveCredentials(provider, endpointId, providerCredentials, customEndpoints)
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
   providerCredentials['anthropic']   customEndpoints['ce-1']
        { apiKey, baseUrl }              { protocol:'anthropic',
                                           baseUrl:'http://127.0.0.1:9000',
                                           apiKey }
                    └─────────────┬─────────────┘
                                  ▼
   projection: { provider, customProtocol, baseUrl, apiKey, model, … }
```

Precedence, in order:

1. `customEndpoints[set.endpointId]` when `set.provider === 'custom'`.
2. `providerCredentials[profileKeyFromProvider(set.provider, set.protocol)]`.
3. **Empty** (`apiKey: ''`, no `baseUrl`) — never a stale value from another set. A set pointing at
   a provider with no credential configured must fail loudly downstream (it already does: the
   diagnostics panel and `hasAnyUsableCredentials()`
   at [`config-store.ts:2518`](../../../src/main/config/config-store.ts#L2518)), not silently borrow a
   key from a different provider.

`ProviderProfileKey` derivation for catalog providers stays exactly as it is
([`provider-ids.ts`](../../../src/shared/provider-ids.ts)) — `gemini → 'gemini'` slot but `google`
pi provider, `native:<id>` for the rest — so the slot space is unchanged and only its _owner_
moves from the config set to `AppConfig`.

### 4.1 What stops being written where

`update()` ([`config-store.ts:2238`](../../../src/main/config/config-store.ts#L2238)) currently routes
credential writes into the active set via the `mutatesActiveSet` branch
([`:2277`](../../../src/main/config/config-store.ts#L2277)) and `PROFILE_KEYS` iteration. After the
change:

- `provider`, `endpointId`, `model`, `contextWindow`, `maxTokens`, `thinkingLevel` → **the active
  set**.
- `apiKey`, `baseUrl` → **`providerCredentials`**, or the referenced `customEndpoints` entry.
- `cloneProfiles`, `normalizeProfile`, `getDefaultProfile` shrink to credential-only duties
  (`:1285`, `:1253`, `:1236`); `model` handling leaves them entirely.

---

## 5. Migration — derive, never invent

The store is **validate-and-coerce, not version-migrated** (the same conclusion as
[`archive/native-provider-catalog.md`](./native-provider-catalog.md) §7). No schema bump,
no rewrite of the persisted file; normalization fills the new fields on read.

| On disk today                                                                        | Becomes                                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `set.profiles['anthropic'] = { apiKey:'sk-ant-…', model:'claude-opus-5' }`           | `providerCredentials['anthropic'].apiKey` **+** `set.model = 'claude-opus-5'` — one entry, named by the catalog, no duplicate created |
| `set.profiles['native:zai'] = { apiKey:'zai-…' }`                                    | `providerCredentials['native:zai']`                                                                                                   |
| `set.profiles['ollama'] = { baseUrl:'http://localhost:11434/v1' }`                   | `providerCredentials['ollama']` (keyless slot, decision #4)                                                                           |
| `set.profiles['custom:anthropic'] = { baseUrl:'http://127.0.0.1:9000', apiKey:'…' }` | one `customEndpoints` entry per **distinct base URL**, `provider:'custom'`, `endpointId` set on the set                               |
| `set.id`, `set.name`, `enableThinking`, `thinkingLevel`                              | untouched                                                                                                                             |

### 5.1 Rules

1. **Idempotent.** Re-running normalization must not mint a second endpoint entry for the same
   base URL, nor overwrite a populated credential with an empty one.
2. **First non-empty wins.** If two sets hold different keys for the same provider, the first (by
   `activeConfigSetId` order, then array order) populates the slot. The second is a no-op. This is
   the accepted cost of decision #2; the UI must not pretend the choice was lossless when it was
   not — see §9.3.
3. **Names come from what exists.** Endpoint names default to the base URL host
   (`http://127.0.0.1:9000`), because that is the only thing the old data knows. The user can
   rename afterwards.
4. **`defaultProfiles` keeps working as the credential fallback** for base URLs and placeholders
   (`:438`), so a fresh install still shows `http://localhost:11434/v1` for Ollama and
   `sk-or-v1-…` as the OpenRouter placeholder.
5. **Set ids, names, ordering and the `default` id never change**, so `sessions.config_set_id` and
   `scheduled_tasks.config_set_id` stay valid without a data migration.

### 5.2 Custom-endpoint seeding from existing guidance

[`COMMON_PROVIDER_SETUPS`](../../../src/shared/api-provider-guidance.ts#L45) already carries eight
hand-authored custom setups with a `matcher` and a `preferProviderTab` hint. Two consequences for
the Providers tab:

- The **`CommonProviderSetupsCard` moves into the custom-endpoint dialog** — it is a way to
  pre-fill one, not a way to configure a catalog provider.
- The `preferProviderTab` hint (e.g. a `custom:openai` base URL matching `openrouter.ai`) becomes
  stronger and now actionable: **"this looks like OpenRouter — set the key there instead"**. Under
  the old model that hint was cosmetic; under the new model it prevents creating an entry that
  duplicates a catalog provider.

---

## 6. UI

### 6.1 Settings sidebar

`API Settings` is replaced by two entries. Every hard-coded `'api'` tab id must move:

| Location                                                                                                                                              | Change                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [`SettingsPanel.tsx:36,50`](../../../src/renderer/components/SettingsPanel.tsx#L36)                                                                   | `TabId` union + `SettingsPanelProps.initialTab` |
| [`SettingsPanel.tsx:63`](../../../src/renderer/components/SettingsPanel.tsx#L63)                                                                      | `VALID_TABS`                                    |
| [`SettingsPanel.tsx:76`](../../../src/renderer/components/SettingsPanel.tsx#L76)                                                                      | default `initialTab`                            |
| [`SettingsPanel.tsx:120`](../../../src/renderer/components/SettingsPanel.tsx#L120), [`:294`](../../../src/renderer/components/SettingsPanel.tsx#L294) | `tabs` array, render switch                     |
| [`WelcomeView.tsx:707`](../../../src/renderer/components/WelcomeView.tsx#L707)                                                                        | `setSettingsTab('api')` → `'providers'`         |
| [`store/index.ts:677`](../../../src/renderer/store/index.ts#L677)                                                                                     | `setSettingsTab(tab \|\| 'api')`                |
| [`nav-server.ts:22`](../../../src/main/nav-server.ts#L22)                                                                                             | `GET /navigate?page=settings&tab=api`           |

Side-by-side:

```
┌──────────────┬──────────────────────────────────────────────┐
│ Providers    │  ▾ Featured                                  │
│ Model Sets   │    ● Anthropic     configured                │
│ Sandbox      │    ● OpenRouter    configured                │
│ Connectors   │    ⚠ OpenAI        key missing               │
│ Skills       │    ○ Gemini        not set                   │
│ …            │  ▾ Coding plans                               │
│              │    ● z.ai (GLM)    configured                │
│              │  ▾ Inference / Local                          │
│              │  ▾ Custom endpoints        ← user-created     │
│              │    ● kiro-gateway  anthropic  ✓              │
│              │    + Add endpoint                             │
└──────────────┴──────────────────────────────────────────────┘
```

### 6.2 Providers tab

- **Catalog list**, grouped by the existing `ProviderCategory` order already implemented for the
  picker (`categoryOrder()` at [`provider-catalog.ts:449`](../../../src/shared/provider-catalog.ts#L449)
  and `groupEntriesByCategory` at [`:493`](../../../src/shared/provider-catalog.ts#L493) — reuse, do not
  re-derive. Note there is no `CATEGORY_ORDER` constant; the earlier draft named one that does not
  exist). Each row: name, status dot (configured / key missing / not set, matching the picker's
  existing `StatusDotColor` contract — the type is exported from
  [`SearchableCombobox`](../../../src/renderer/components/SearchableCombobox.tsx), and
  [`SettingsAPI.tsx:145`](../../../src/renderer/components/settings/SettingsAPI.tsx#L145) is a
  consumer, not its definition), and the env-var hint (`ANTHROPIC_API_KEY`) from
  `ProviderCatalogEntry.keyEnvVar` ([`provider-catalog.ts:62`](../../../src/shared/provider-catalog.ts#L62)).
- **`Configure provider…` dialog** — the existing form, extracted from
  [`SettingsAPI.tsx`](../../../src/renderer/components/settings/SettingsAPI.tsx) largely verbatim:
  [`ProviderPicker`](../../../src/renderer/components/ProviderPicker.tsx), API key, protocol selector
  (`custom` only), base URL (`formShape.baseUrl`), model is **removed** (it belongs to a set), and
  the Ollama `Discover` button ([`:337`](../../../src/renderer/components/settings/SettingsAPI.tsx#L337)).
  Field visibility keeps coming from `ProviderCatalogEntry.formShape`, never from `provider === '…'`
  comparisons.
- **Diagnostics here.** [`ApiDiagnosticsPanel`](../../../src/renderer/components/ApiDiagnosticsPanel.tsx)
  takes an explicit `{ provider, apiKey, baseUrl, customProtocol, model }` input — `DiagnosticInput`
  at [`renderer/types/index.ts:1130`](../../../src/renderer/types/index.ts#L1130), consumed at
  [`api-diagnostics.ts:533`](../../../src/main/config/api-diagnostics.ts#L533) — so it can test any
  credential without touching the active set. The Model Sets tab keeps a second instance bound to
  the projected runtime, because end-to-end model reachability is a set-level question.
- **Custom endpoints section** — add / rename / edit / delete. Delete is refused while a config set
  references the entry, in both the UI and `config-store`.

### 6.3 Model Sets tab

`ApiConfigSetManager` ([`ApiConfigSetManager.tsx`](../../../src/renderer/components/ApiConfigSetManager.tsx))
moves here unchanged in behaviour — switch, save, new, rename, delete, and the unsaved-changes
dialog. Below it:

- **Provider** is now a **read-only summary chip** of the resolved credential source
  (`Anthropic · configured` / `kiro-gateway · anthropic`) with a `Change` action that opens the
  Providers tab. This is the answer to "which provider am I using", which used to require editing
  the key field to see.
- **Model** picker, options from the selected provider's catalog entry
  (`ProviderCatalogEntry.modelOptions`, delivered over IPC by `config.getProviderCatalog`). Note the
  asymmetry that motivates decision #10: `enrichBuiltinEntries`
  ([`provider-catalog-native.ts:248`](../../../src/main/config/provider-catalog-native.ts#L248)) fills
  `modelOptions` from the live pi-ai registry for every builtin **except** those in
  `BUILTIN_NO_REGISTRY_MODELS` ([`:238`](../../../src/main/config/provider-catalog-native.ts#L238)) —
  `custom` and `ollama`. Ollama recovers via runtime discovery; `custom` has nothing, hence
  `CustomEndpoint.defaultModel`.
- **Thinking level** — unchanged, including the per-model clamping already shipped.
- **Context window / max tokens** — per `formShape.contextWindow`.
- **Diagnostics** on the projected runtime, then **Save**.

### 6.4 Two independent dirty domains

Today one signature ([`buildApiConfigDraftSignature`](../../../src/renderer/hooks/useApiConfigState.ts#L520))
covers keys, base URLs, models and thinking level for the active set. Splitting storage means
splitting that too:

- The **Providers** tab tracks dirtiness of `providerCredentials` / `customEndpoints` and owns its
  own Save.
- The **Model Sets** tab tracks dirtiness of the active set (`provider`, `endpointId`, `model`,
  `contextWindow`, `maxTokens`, `thinkingLevel`) and owns its own Save.
- The cross-set pending-switch dialog in `ApiConfigSetManager` must keep working, but it now guards
  the _set_ draft only — a dirty key in the Providers tab is never silently discarded by switching
  sets, and a dirty model is never silently carried into a credential write.

This is the single most delicate behavioural change in the plan (§9.2).

### 6.5 First run

[`ConfigModal.tsx`](../../../src/renderer/components/ConfigModal.tsx) drives
[`useApiConfigState`](../../../src/renderer/hooks/useApiConfigState.ts) and is mounted as
`isFirstRun={!isConfigured}` ([`App.tsx:246`](../../../src/renderer/App.tsx#L246)). It becomes a
two-step wizard so the first screen teaches the new model:

```
┌── Step 1 of 2 · Provider ───────────────────────────┐
│  Provider   [ Anthropic                  ▾ ]        │
│  API key    [ sk-ant-…                      ] 👁    │
│  Base URL   (not required)                          │
│                        [ Test connection ]          │
│                    [ Continue → ]                   │
└─────────────────────────────────────────────────────┘
┌── Step 2 of 2 · Model ──────────────────────────────┐
│  Model   [ claude-opus-5                   ▾ ]      │
│                    [ Start chatting ]               │
└─────────────────────────────────────────────────────┘
```

Step 1 writes the credential and creates/updates the `default` set; step 2 writes the model,
pre-filled from `endpoint.defaultModel` (decision #10) or, for a base URL matching a known setup,
that setup's `exampleModel` ([`api-provider-guidance.ts`](../../../src/shared/api-provider-guidance.ts)).

### 6.6 Other surfaces

- **Chat / Welcome config-set pickers** ([`ChatView.tsx:158`](../../../src/renderer/components/ChatView.tsx#L158),
  [`WelcomeView`](../../../src/renderer/components/WelcomeView.tsx)): labels become `set · model`.
  The provider is no longer part of the identity of a set.
- **Session stamping** ([`session-manager.ts:704,1087,1098`](../../../src/main/session/session-manager.ts#L704))
  reads `configStore.get('model')` and `get('activeConfigSetId')` — both survive on the projection,
  so no change.
- **Schedule** ([`SettingsSchedule.tsx:592`](../../../src/renderer/components/settings/SettingsSchedule.tsx#L592))
  lists set names; unchanged.

---

## 7. Implementation phases

### 7.0 Progress

| Phase                   | Status                 | Landed                                                                        |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| 0 — baseline + doc fix  | ✅ **done** 2026-10-03 | ABI unblocked, doc corrected against HEAD, open questions → decisions         |
| 1 — main-process model  | ✅ **done** 2026-10-03 | types + one-directional derivation, 40 new tests, external review ✔️          |
| 2a — store inversion    | ✅ **done** 2026-10-03 | resolveCredentials + endpointId + CRUD/IPC, 28 new tests                      |
| 2b — write-path cutover | ✅ **done** 2026-10-03 | handleSave drops `profiles`; §9.4 holds structurally                          |
| 3 — renderer state      | ✅ **done** 2026-10-05 | old fields removed; two slices; 141 new tests; external review ✔️             |
| 4 — UI                  | ✅ **done** 2026-10-06 | step 1: tabs, endpoint list, chooser; step 2: dialogs, notice, labels         |
| 5 — first-run wizard    | ✅ **done** 2026-10-07 | A: the two-step wizard; B: the removal — both reviewed ✔️, checked in the app |
| 6 — docs                | ✅ **done** 2026-10-07 | wiki, README, rule documents, changelog; this document archived with §14      |

Every phase ends with `npm run typecheck` and `npm test` clean. Two of the three gates
(`AI_MAIN_PROCESS.md` preamble) must pass; `npm run test:coverage` is the CI gate and its
thresholds live in `vitest.config.mts` (lines 30 / functions 35 / branches 28 / statements 30 —
note `src/renderer/` is excluded from coverage, so Phase 3–5 work does not move these numbers).

**ABI prerequisite.** `npm test` runs under plain Node, so `better-sqlite3` must be built for the
**Node** ABI — `npm rebuild better-sqlite3`, which is exactly what CI does
([`.github/workflows/ci.yml:32`](../../../.github/workflows/ci.yml#L32)). `npm run rebuild`
(`electron-rebuild`) targets **Electron's** ABI and is for running the app. The two are mutually
exclusive: whichever ran last wins, and the other context fails with
`NODE_MODULE_VERSION 145 vs 137` across the 7 SQLite-backed test files (133 tests). If `npm test`
fails to load the module, run `npm rebuild better-sqlite3`; if the app fails to start, run
`npm run rebuild`. This is unrelated to this design but will otherwise be mistaken for a
regression at every phase gate.

### Phase 0 — baseline + doc correction (**done** 2026-10-03)

ABI fixed, full suite confirmed green (**3394 tests, 230 files**), this document corrected against
HEAD `90136401`, and the four open questions resolved into decisions #9–#12. §13 records the
corrections.

### Phase 1 — main-process model (**done** 2026-10-03, external review **APPROVED**)

**Shipped as a one-directional derivation, narrower than the table below originally implied.**
The table listed "credential writes in `update()`" for Phase 1, but doing that alongside the
existing per-set `profiles` writes would have made both stores live at once — exactly what §9.4
forbids. So Phase 1 adds the types and derives the new fields **from** `profiles` on every read,
without changing the projection or any write path. Phase 2 inverts the direction in one move, which
keeps the "never both live" invariant true at every commit.

As built:

| File                                              | Change                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/config/config-store.ts`                 | `ProviderCredentials`, `ProviderCredentialMap`, `CustomEndpoint` (with `defaultModel?`); `providerCredentials` + `customEndpoints` on `AppConfig` and `defaultConfig`; `MAX_CUSTOM_ENDPOINT_COUNT`; `customEndpointKey` / `defaultCustomEndpointName` helpers; `orderSetsForDerivation` / `deriveProviderCredentials` / `deriveCustomEndpoints`; both wired into `normalizeConfig` and `composeProjectedConfig` |
| `src/renderer/types/index.ts`                     | mirrored the three types; the two `AppConfig` fields are **optional** renderer-side (the Settings bootstrap predates them)                                                                                                                                                                                                                                                                                      |
| `tests/config-store-provider-credentials.test.ts` | **new**, 40 tests — derivation rules, idempotence, the lossy case, URL canonicalization, endpoint dedup/pruning/cap, persist→edit round-trips, and a group pinning that the projection is unchanged                                                                                                                                                                                                             |
| 2 test fixtures                                   | `src/tests/claude/claude-sdk-one-shot.test.ts`, `src/tests/memory/memory-llm-client.test.ts` — added the two new required fields to their `AppConfig` literals (predicted in §8.2)                                                                                                                                                                                                                              |

Not touched, deliberately: `src/shared/provider-ids.ts` (slot derivation unchanged, no endpoint-id
helper needed yet), `src/preload/index.ts` and `src/main/index.ts` (no IPC until a write path exists
in Phase 2).

**Gates:** `npm run typecheck` clean; `npm test` **3426 passed / 231 files** (3394 pre-existing + 32
new, zero regressions — the projection staying byte-identical is what bought this); `npm run lint` 0
errors, 16 warnings all pre-existing (identical count on a stashed tree).

**Verification beyond "tests pass":** seven mutations were injected into the new code to confirm the
tests are load-bearing. Six were caught (active-set ordering, dedup key, unparseable-URL dedup,
the populated-slot guard, the default-base-URL check, the `custom:*` exclusion). One survived — a
redundant trailing-slash `.replace` before a `URL` round-trip that already normalizes it — and was
removed as dead code, with a test added for the unparseable-URL branch that genuinely needs it.

**Two bugs found in external review and fixed** (both would have poisoned Phase 2, since it inherits
this map as the source of truth):

1. **Credential rotation silently no-opped.** `saveConfig` persists the whole normalized config, so
   the derived map lands on disk. The first implementation then _seeded_ from that persisted copy and
   skipped any slot it already held — so after one save, editing a profile's API key left the derived
   slot stale forever. Fixed by making the map a pure function of the config sets. Proven with a
   failing test (`OLD-KEY` surviving a rotation) before the fix.
2. **Editing a gateway URL left an orphan endpoint.** Persisted endpoints were kept wholesale and
   never pruned, so changing a `custom:*` base URL minted a second entry beside the old one.
   Repeated edits would fill `MAX_CUSTOM_ENDPOINT_COUNT` and start evicting live endpoints, because
   the cap was the only eviction policy. Fixed by pruning endpoints no profile still describes and
   taking only `id`/`name` from the persisted list.

**Second review round (approved, 5 non-blocking findings all fixed):**

- **URL canonicalization was split in two.** Endpoint identity used canonical comparison while the
  default-slot checks compared raw strings, so `https://api.anthropic.com/` read as a customization
  of the default and minted a keyless credential. Extracted `canonicalBaseUrl` and used it for both.
  Verified by probe first — the bug reproduced exactly as described.
- **Stored base URLs now canonical**, so the value no longer depends on which set won the race; and
  `updatedAt` is preserved unless the key or model changed, so a plain `update()` stops churning it.
- **Two guards turned out to be unreachable.** The review asked for `isProfileKey` / `isCustomProtocol`
  validation in `deriveCustomEndpoints` against hand-edited JSON. Added — but mutation testing then
  showed the new tests passed with the guards removed, because `cloneProfiles` strips invalid keys
  during set normalization long before derivation runs. The claim that `getAll()` could _throw_ was
  therefore not reproducible. Kept the guards as defence-in-depth and rewrote the test to pin the
  invariant that makes them unreachable, rather than leave a test that passes for the wrong reason.
- **`defaultModel` backfill is near-moot**: `normalizeProfile` substitutes the slot's default model
  for an empty one, so a profile-derived endpoint effectively always has a model. Documented in the
  test rather than asserting a behaviour that cannot occur.

Mutation testing was run again after these fixes; the two canonicalization branches now fail under a
raw-string mutation, having survived it before the extra tests were added.

A third, subtler trap surfaced while fixing #1 and is worth recording: an attempt to carry over
"slots no config set describes" does not work, because `cloneProfiles` materializes all 8 builtin
slots on every normalized set — presence proves nothing. Two successive attempts to patch around it
oscillated between two failing tests, which is the signal that the rule itself was wrong rather than
its implementation. The resolution: in Phase 1 nothing writes this map, so a persisted entry can
_only_ be a stale cache, and there is no legitimate hand-written slot to defend. Carry-over becomes
meaningful only in Phase 2, together with real writes.

**Derivation rules as implemented** (§5.1):

- A slot is populated when it has a non-empty `apiKey` **or** a `baseUrl` differing from the slot
  default. The second clause exists for `ollama`, which is legitimately keyless (decision #4) —
  keying on `apiKey` alone would silently drop a user's custom Ollama URL.
- First non-empty wins, **active set first** then array order (`orderSetsForDerivation`), so the
  lossy case resolves identically on every read.
- `custom:*` slots are excluded from `providerCredentials` and become `customEndpoints` entries,
  keyed by `protocol + normalized base URL` so two sets sharing a gateway yield one entry.
- `providerCredentials` is a **pure function of the config sets** — the persisted copy is not an
  input. Phase 1 has no write path into it, so anything on disk is the output of an earlier
  derivation; feeding that back in would let a stale value outvote the profile it came from and make
  key rotation silently no-op. (Reached via review: the first implementation seeded the persisted
  map and skipped keys it already held, which did exactly that.)
- `customEndpoints` takes **only identity** from the persisted list — `id` and a user-edited `name`
  for endpoints the profiles still describe. URLs and keys always come from the live profile, and an
  endpoint no profile produces is **pruned**; otherwise editing a gateway URL leaves an orphan, and
  accumulated orphans would consume `MAX_CUSTOM_ENDPOINT_COUNT` and evict real entries.
- `canonicalBaseUrl` (lowercased host, no trailing slash) is shared by endpoint identity **and** the
  "is this slot still at its default?" checks. `normalizeProfile` stores base URLs verbatim, so a raw
  string comparison would read `https://api.anthropic.com/` as a customization of
  `https://api.anthropic.com` and mint a keyless credential the user never configured.
- `updatedAt` is preserved from a matching persisted entry unless the key or model actually changed,
  so a plain `update()` does not churn it; stored base URLs are canonical, so the value does not
  depend on which set won the derivation race.
- Prototype-polluting and malformed slot keys are rejected via the existing `isProfileKey` guard.
  These are **unreachable today**: `cloneProfiles` materializes only the 8 valid builtin slots (plus
  `native:*`), so a hand-edited `custom:bogus` is stripped during set normalization and never reaches
  derivation. The guards are defence-in-depth for a future caller passing un-normalized sets; a test
  pins the invariant that makes them unreachable, so weakening `cloneProfiles` fails loudly instead
  of silently emitting an endpoint with a guessed protocol.
- Note `cloneProfiles` materializes all 8 builtin slots on every normalized set, so a slot's
  _presence_ in `profiles` proves nothing — only its contents do. Any "does a set describe this
  slot?" test must compare against the slot default, exactly as the populated check does.

### Phase 2 — invert the direction, migrate the tests

**Split into 2a (store) and 2b (renderer cutover)** — decided 2026-10-03, before any code.

The original single-phase plan could not land. Phase 2 is specified as main-process-only ("no UI
change") while also requiring `profiles` to be dropped from `ApiConfigSet` — but the renderer writes
that field back on every save. `handleSave`
([`useApiConfigState.ts:2119-2130`](../../../src/renderer/hooks/useApiConfigState.ts#L2119)) sends
`profiles` and `activeProfileKey` in its `config.save` payload, and it is the **only** credential
write path in the app (the other `config.save` callers — `App.tsx:139`,
`SettingsGeneral.tsx:80`, `SettingsSkills.tsx:388`, `SettingsMemory.tsx:652,2068` — touch unrelated
fields). Removing the field therefore breaks the renderer, and repairing it _is_ Phase 3's
`useApiConfigState` split.

A second consequence: §9.4's post-Phase-2 claim that "no write path writes credentials back into a
set" is false for as long as `handleSave` sends `profiles`, whatever the store does with it. The
split makes that invariant true at an identifiable commit instead of aspirationally.

- **Phase 2a — store only.** `endpointId` on `ApiConfigSet`; `model`/`contextWindow`/`maxTokens`
  hoisted up; `resolveCredentials()` with the §4 precedence; `projectFromConfigSet` reads
  credentials instead of profiles; `update()` routes `apiKey`/`baseUrl` to `providerCredentials` or
  the referenced endpoint; endpoint CRUD + delete guard + IPC. `profiles` **stays on the type** as
  accepted-but-never-written legacy input, read once for migration. The renderer keeps compiling
  untouched. The §8.1 assertions land here.
- **Phase 2b — write-path cutover (as shipped).** `handleSave` stops sending
  `profiles`/`activeProfileKey`, and `applyProfilesToCredentials` is deleted with its sole caller.
  §9.4 becomes structurally true: no write path puts a credential into a config set.

  **The type removal moved to Phase 3**, correcting this plan's "payload change plus a type removal"
  framing. `profiles` is not only written by the renderer, it is what the renderer _reads_ to build
  its form — `buildApiConfigSnapshot`
  ([`useApiConfigState.ts:458-476`](../../../src/renderer/hooks/useApiConfigState.ts#L458)) hydrates the
  API-key, base-URL and model fields from `config.profiles`, and the hook has **zero** references to
  `providerCredentials` / `customEndpoints`. Deleting the field therefore requires teaching the
  renderer the new model, which is Phase 3's described work on the very same helpers. Only the write
  path was separable; `profiles` stays as a **read-only** projection until Phase 3.

Phase 3 is unchanged: the full `useApiConfigState` split into two slices.

It carries the items the Phase 1 table listed but that could not land without breaking
§9.4's "never both live" invariant:

| File                                        | Change                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/config/config-store.ts`           | new `ApiConfigSet` shape (`endpointId`, hoisted `model`/`contextWindow`/`maxTokens`; drop `profiles`, `activeProfileKey`, `customProtocol`); `resolveCredentials()` with §4 precedence; `projectFromConfigSet` reads credentials instead of profiles; credential writes in `update()`; endpoint CRUD + delete guard |
| `src/shared/provider-ids.ts`                | endpoint-id helpers if needed; slot derivation unchanged                                                                                                                                                                                                                                                            |
| `src/preload/index.ts`, `src/main/index.ts` | IPC for custom-endpoint CRUD (or fold into `config.save` if the payload stays small)                                                                                                                                                                                                                                |

After this phase `profiles` is **read-only legacy input** — normalization reads it once on migration
and no write path writes credentials back into a set (§9.4).

Ships with the ten new assertions in §8.1 **and** the test-migration pass over the 11 files in §8.2.
Both land before any UI work, so the riskiest phase is reviewable on its own.

#### Phase 2a as built (**done** 2026-10-03)

| File                                               | Change                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/config/config-store.ts`                  | `endpointId` + hoisted `model`/`contextWindow`/`maxTokens` on `ApiConfigSet`; `resolveCredentials`; `linkCustomEndpointIds`; `writeCredential`; `applyProfilesToCredentials`; `generateCustomEndpointId`; endpoint CRUD + delete guard; `projectFromConfigSet` and `composeProjectedConfig` now take credentials explicitly |
| `src/main/index.ts`                                | three IPC handlers (`config.createCustomEndpoint` / `updateCustomEndpoint` / `deleteCustomEndpoint`), each through `syncConfigAfterMutation`                                                                                                                                                                                |
| `src/preload/index.ts`                             | matching bridge methods + `ElectronAPI` declarations                                                                                                                                                                                                                                                                        |
| `src/renderer/types/index.ts`                      | mirrored `ApiConfigSet` fields; deprecation markers on the legacy trio                                                                                                                                                                                                                                                      |
| `src/renderer/hooks/useApiConfigState.ts`          | two `ApiConfigSet` literals gained `model` (sourced from the active profile — the same migration the store does). Not the Phase 3 rework.                                                                                                                                                                                   |
| `tests/config-store-credential-resolution.test.ts` | **new**, 49 tests — §4 precedence, credential writes (incl. clearing), migration, the Phase 2a profiles bridge, CRUD + guards                                                                                                                                                                                               |
| `tests/config-store-provider-credentials.test.ts`  | 43 tests — precedence inverted to match, plus endpoint empty-vs-missing                                                                                                                                                                                                                                                     |
| `tests/config-store-profiles.test.ts`              | 3 tests updated — all three were asserting pre-split behaviour the design deliberately changes                                                                                                                                                                                                                              |

**Gates:** typecheck clean; `npm test` **3493 passed / 232 files**; lint 0 errors (16 pre-existing
warnings).

**The precedence had to invert, and that is the phase.** In Phase 1 nothing wrote
`providerCredentials`, so a persisted copy could only be a stale cache and was ignored outright —
feeding it back would have broken key rotation (the bug external review caught). Phase 2a routes
`update()` and the CRUD API there, so the persisted map is now **authoritative** and legacy per-set
`profiles` are consulted only for slots it does not already hold. Rotation stays correct because the
write targets the map itself rather than a profile. Four Phase 1 tests encoded the old rule and were
rewritten; the persist→edit round-trips that guard rotation still pass untouched.

**Three behavioural changes fell out of the design, each visible as an updated test:**

- A **new config set is immediately usable** — it resolves the global slot for its provider instead
  of starting with an empty key. This is §1.2 consequence 1, the original complaint.
- **Switching a set's provider no longer swaps its model.** `model` is now a property of the set, so
  it survives a provider change; the user picks a new one explicitly.
- **A native provider's `baseUrl` projects as `undefined`** rather than `''`, because the credential
  object omits the key entirely when there is nothing to store. The original concern behind that
  assertion (never persisting a literal `undefined`) still holds.

**Two implementation traps worth recording:**

- `saveConfig` re-normalizes, so an endpoint created through CRUD was initially **pruned as an
  orphan** — derivation only kept entries a `custom:*` profile described. Fixed by keeping
  explicitly persisted endpoints that no profile describes, while still pruning _derived_ ones whose
  source profile changed (the gateway-URL-edit case from Phase 1 review still prunes).
- `composeProjectedConfig` had to start accepting credentials explicitly. Re-deriving inside it
  would have discarded the write `update()` had just made.

`applyProfilesToCredentials` is the Phase 2a-only bridge: `handleSave` still sends the whole profile
map, and silently ignoring it would lose a key the user just typed, so each slot is forwarded to its
global home. It is deleted in Phase 2b along with the field.

**External review: 5 iterations, 9 blocking bugs found and fixed.** Not approved at the cap; the
remaining item is deferred by decision (see below). Every bug was reproduced with a failing probe
before the fix and re-verified by mutation. They cluster into one theme — **two sources of truth on
the read path while `profiles` is still live** — which is exactly what Phase 2b removes:

1. **Rotation silently no-opped.** The derived map was seeded from its own persisted output and
   skipped slots it already held, so a later profile edit could never update it.
2. **Gateway-URL edit left an orphan** endpoint; repeated edits would fill the cap and evict live
   entries.
3. **`update({ configSets })` deleted CRUD-created endpoints and their API keys.** The prune
   predicate ("unreferenced and undescribed") is precisely the shape of a user-created endpoint. The
   original test missed it by exercising `update({ provider, apiKey })`, which skips that path — a
   reminder that a test naming an invariant is not the same as a test reaching it.
4. **A stale inactive profile slot reverted a rotated key.** Fixed on both sides: writes are scoped
   to the active slot, and the projection re-mirrors _every_ slot from the authoritative store.
5. **`contextWindow` / `maxTokens` could never be cleared** — `...targetSet` copied the old value and
   the conditional spreads only add. Same three-state problem as `endpointId`.
6. **A profile URL could override a live `endpointId`**, so `updateCustomEndpoint({ baseUrl })` was
   silently retargeted back to a twin at the old address. A valid pin now always wins on read.
7. **Delete was undone by leftover mirrors** — derivation resurrected the endpoint (new id, key off
   the profile) on the next read. Delete now scrubs the matching `custom:*` profiles.
8. **A credential-only write reset the endpoint's protocol** from the set's diverged mirror.
   `writeCredential` now defaults to the endpoint's own protocol/URL and takes an explicit protocol
   only when the caller asked for one.
9. **A cleared endpoint key was revived from the legacy mirror** — the empty-vs-missing rule had been
   applied to `providerCredentials` but not to `customEndpoints`. Now symmetric.

**Deferred, not dropped — IPC error shape.** Review asked (four times) that the three endpoint CRUD
handlers return `{ success: false, error }` instead of throwing. Investigated and **deliberately not
changed in this phase**, because the premise is half right and the suggested fix would make things
worse:

- The `config.*` handlers split by purpose, not by accident: **queries** (`get`, `getPresets`,
  `isConfigured`, `test`, `diagnose`, `discover-local`) try/catch and return a safe fallback;
  **mutations** (`save`, `createSet`, `renameSet`, `deleteSet`, `switchSet`) throw and the renderer
  catches + translates (`useApiConfigState.ts:2422-2436`). The new handlers are mutations and follow
  the mutation pattern, so changing only them would make them the sole outlier.
- **But the declared type is wrong for all of them.** `preload/index.ts` promises
  `{ success: boolean; config: AppConfig }` while `success` is only ever `true`. That has already
  misled one call site: `App.tsx:139-143` guards on `if (result.success)` — dead code — with no
  try/catch, so a failed `config.save` silently does nothing.

The honest fix is to make the type tell the truth across **all** mutation handlers plus the `App.tsx`
call site. That is six pre-existing sites this phase did not introduce, so it landed as its own
commit rather than as a footnote inside a credential refactor.

**Done** (2026-10-03, the commit after this one). Investigating it corrected the claim above: the
contract is not uniformly dishonest, it is **inconsistent**. `config.save` genuinely does return
`success: false` — three times, for `httpProxy` validation — and that branch carries **no `config`**,
which the old type promised was always present. So the shape was wrong in both directions: a dead
`success` flag on the seven throwing mutations, and an absent `config` the type guaranteed on the one
fallible mutation. `ConfigSaveResult` (a discriminated union) and `ConfigMutationResult` (config only)
now distinguish them, which made the compiler surface the unguarded `result.config` read immediately.
Two further latent bugs were fixed at the same time: `App.tsx`'s dead `if (result.success)` with no
`catch`, and `SettingsGeneral`'s ignored `success: false` that reported “Saved” for a proxy the store
had refused — masked only because the renderer duplicates main's validation.

**Verification:** five mutations injected into the new logic — custom sets falling through to a
catalog slot, the endpoint's protocol being overridden by a stale set value, the delete guard
removed, model-hoisting disabled, and endpoint linking disabled. All five were caught.

#### Phase 2b as built (**done** 2026-10-03)

| File                                               | Change                                                                                                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/hooks/useApiConfigState.ts`          | `handleSave` payload drops `profiles` + `activeProfileKey`; both removed from the `useCallback` deps they no longer feed                                                                                                         |
| `src/main/config/config-store.ts`                  | `applyProfilesToCredentials` deleted (sole caller gone); the copy of an incoming `profiles` map onto the set deleted as dead code; `profiles` removed from the `mutatesActiveSet` trigger; field docs rewritten to say read-only |
| `tests/config-store-credential-resolution.test.ts` | +5 — the slimmed payload persists catalog creds, mints/pins an endpoint, rotates across sets, still mirrors for the renderer, and **ignores a `profiles` map for credential purposes**                                           |
| `tests/config-ipc-mutation-contract.test.ts`       | +5 — pins the payload shape and that no credential write path into a set remains                                                                                                                                                 |

**Gates:** typecheck clean; `npm test` **3516 passed / 233 files**; lint 0 errors (16 pre-existing
warnings — the cutover briefly added a 17th, an `exhaustive-deps` warning correctly flagging the two
now-unused dependencies, which was fixed rather than suppressed).

**§9.4 is now structural, not conventional.** The invariant — "no write path writes credentials back
into a set" — previously held only because `update()` forwarded the renderer's map carefully. It now
holds because nothing sends the map and nothing reads it for credentials. A test asserts that an
explicitly supplied `profiles` payload **cannot** change a credential, closing the rotation-reversal
vector Phase 2a had to guard against with a scoped write.

**`profiles` on input is now wholly inert.** Review flagged that a comment claimed incoming slots were
still normalized onto the set "so a legacy caller does not see its input vanish", contradicting the
test asserting the payload reaches nothing — correctly diagnosed as "either dead or a latent write
path". It was dead: deleting the copy loop broke none of 3516 tests, and a probe confirmed a supplied
map is observable in neither the credential map, the projection, the stored mirror, nor as an invented
slot. Removing it beat documenting it. `profiles` also left the `mutatesActiveSet` trigger, where it
was rewriting the active set — and churning its `updatedAt` — for a payload that changes nothing.

**One bridge deliberately kept.** The `update({ configSets })` pin-drop (which unpins a custom set
whose incoming `custom:*` profile URL contradicts its `endpointId`) survives. `handleSave` no longer
reaches it, but `update({ configSets })` is a public store API that still accepts the legacy shape —
removing support would silently turn a profile-URL edit into a no-op. Verified by deleting it: three
Phase 2a bridge tests fail. It goes in Phase 3 with the field.

### Phase 3 — renderer state and the type removal (**done** 2026-10-05)

The plan for this phase was: rework `useApiConfigState.ts` into two slices —
`useProviderCredentials` and `useModelSets` — with independent dirty tracking (§6.4); hydrate from
`providerCredentials` / `customEndpoints` instead of `config.profiles`; then delete `profiles` and
`activeProfileKey` from `ApiConfigSet` and `AppConfig`, the mirror overlay in `projectFromConfigSet`,
and the `update({ configSets })` pin-drop bridge.

All of that landed. Reading the code before starting turned up four things the plan did not have,
and each changed what was built.

#### What the pre-implementation read found

1. **`contextWindow` / `maxTokens` had stopped being saved in Phase 2b.** They never had top-level
   keys in the save payload — they travelled inside `profiles`, so dropping that field dropped them.
   `update()` only changes a limit when its key is present. The payload-shape test asserted
   `arrayContaining`, which is why nobody noticed. Fixed first, as its own commit (`ddecc9c6`). A
   second, older half of the same bug went with it: neither field was in the draft signature, so
   switching config sets dropped an edit to them without the unsaved-changes dialog (present in the
   released 1.0.8).
2. **Removing the fields from the types does not remove them from the file.** `saveConfig` calls
   `store.set(normalized)`, and conf's `set(object)` assigns the keys it is given and removes none
   (`conf/dist/source/index.js`, `set()`; the store's own comment on `httpProxy` says the same). The
   top-level `profiles` map would have stayed on disk for good: a frozen copy of every API key, and —
   because the legacy reader trusts those fields over a lone default set — an input that rolls a
   single-set install back to the frozen values. **Reproduced by mutation:** with the delete
   disabled, `keeps a model change on a single-set install across a restart` fails. `ensureNormalized`
   now deletes both keys once the migrated result is persisted.
3. **§9.3 had no phase, and this phase destroys its evidence.** Nothing recorded which sets lost a
   key, and once per-set `profiles` leave the file the disagreement can no longer be detected.
   Recorded now — see `credentialConflicts` below.
4. **There was no way to save a catalog provider's key without touching the active set.** The only
   write route was `config.save`, which writes to the active set's provider, and naming another
   provider there switches the set to it. Independent saves (§6.4) need one more call:
   `config.setProviderCredential`.

#### Decisions taken with the user before starting

| #   | Question                                               | Decision                                                                                   |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Token-limit fix inside Phase 3 or before it?           | Own commit, before.                                                                        |
| 2   | How do the current screens keep working until Phase 4? | `useApiConfigState` stays, as a thin layer over the two slices with the same interface.    |
| 3   | Add the credential-save call now?                      | Yes.                                                                                       |
| 4   | Which model shows when a set's provider changes?       | The new provider's default; what was typed per provider is remembered until save or close. |
| 5   | Remove `customProtocol` from the set too (§3.3)?       | Yes.                                                                                       |
| 6   | Record which providers had disagreeing keys (§9.3)?    | Yes — ids only, never a key.                                                               |
| 7   | Is "1.0.8 or older will not find the keys" acceptable? | Yes, with a changelog note.                                                                |

#### As built — main process

| File                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/config/config-store.ts`           | `ApiConfigSet` loses `profiles` / `activeProfileKey` / `customProtocol`; `AppConfig` loses `profiles` / `activeProfileKey` and gains `endpointId?` and `credentialConflicts`. The legacy reader becomes a **one-time migration** (`needsLegacyMigration` → `migrateLegacyCredentialShape`); the mirror overlay, the pin-drop bridge, `evictStaleDerivedEndpoints` and the profile scrub in `deleteCustomEndpoint` are deleted. New: `setProviderCredential`, `normalizeProviderCredentials`, `normalizeCustomEndpoints`, `detectCredentialConflicts`, `normalizeCredentialConflicts`. `update()` accepts `endpointId`. |
| `src/shared/custom-endpoint-key.ts`         | **new** — `canonicalBaseUrl` / `customEndpointKey` / `defaultCustomEndpointName`, moved out of the store so the renderer compares endpoint addresses the same way main does.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/main/index.ts`, `src/preload/index.ts` | `config.setProviderCredential` handler, bridge method and `ElectronAPI` declaration. Goes through `syncConfigAfterMutation`; logs the provider id only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**From "derive on every read" to "migrate once".** Through Phase 2b the legacy reader ran on every
`getAll()`, because the data it read (`profiles`) was still part of the shape. With the fields gone
it has nothing to read after the first start — but it must not _run_ either, since it also contains
the rule that rebuilds a lone default set from the flat fields. `needsLegacyMigration` decides from
what the config contains: a pre-split key anywhere, no config sets, or — for a config older than
`profiles` itself — flat fields that hold something the credential store and the lone default set do
not account for. In a current config the flat fields are _projected from_ the sets and the store, so
that last test can never be true. No `configSchemaVersion` bump: §5's "validate-and-coerce" holds.

**`AppConfig.endpointId`.** Not in §3.4. It is the active custom set's endpoint, projected like
`provider` and `model`, and accepted by `update()` — which is how a set is re-pointed (`''` unpins;
an unknown id is refused rather than stored as a dangling pointer; ignored for a catalog provider).
§4.1 lists `endpointId` among the fields `update()` routes to the active set, but there was no key
to carry it.

**`credentialConflicts`** (§9.3): `Array<{ target, setIds }>`. `target` is a credential slot or an
endpoint id, `setIds` the sets whose differing key was dropped — compared against the credential
that was _kept_, so the record says exactly what was lost. An entry clears when the user saves that
credential again (by any route) and is dropped when every set it names has been deleted. Phase 4
surfaces it on the provider row. Known imprecision: on a machine that ran the Phase 2a/2b
development builds, a key rotated there reads as a conflict, because those builds mirrored the new
key onto the active set's legacy profile only. It affects no released version.

**`update({ configSets })` takes the current shape only.** A pre-split `profiles` map on an incoming
set is ignored, not migrated: the migration reads the persisted file once and never a caller's
payload. Nothing in the app sends one (verified: no main-process caller passes `configSets`).

#### As built — renderer

| File                                                                                                              | Role                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/provider-credentials-state.ts`                                                                             | **new**, pure. Credential _targets_ (a provider slot, an endpoint, an endpoint not created yet), drafts per target, dirty detection, and the plan of save calls. |
| `hooks/model-sets-state.ts`                                                                                       | **new**, pure. Set list, the active set's draft, signature, save payload, per-session model memory, reducer.                                                     |
| `hooks/useProviderCredentials.ts`                                                                                 | **new**. Saves each edited credential through its own call: `setProviderCredential`, or the endpoint CRUD calls.                                                 |
| `hooks/useModelSets.ts`                                                                                           | **new**. Saves the active set through `config.save` with a payload that names no credential field; set CRUD; thinking capabilities.                              |
| `hooks/useApiConfigState.ts`                                                                                      | **rewritten**, 2577 → 759 lines. Composes the two slices behind the interface `SettingsAPI` and `ConfigModal` already use.                                       |
| `hooks/api-config-shared.ts`                                                                                      | **new**, pure. Helpers both slices use; the catalog and slot helpers moved here verbatim and are still re-exported from `useApiConfigState`.                     |
| `hooks/useApiConnectivity.ts`, `useCustomEndpointGuidance.ts`, `useApiConfigSource.ts`, `useApiConfigMessages.ts` | **new**. Connection test / diagnostics / Ollama discovery, custom-endpoint hints, loading, and the message line — moved out of the old hook.                     |
| `types/index.ts`                                                                                                  | Old fields removed; `providerCredentials` / `customEndpoints` / `credentialConflicts` required; `endpointId?`.                                                   |
| `components/ChatView.tsx`                                                                                         | The model-matching fallback reads `set.model`.                                                                                                                   |

`SettingsAPI.tsx` and `ConfigModal.tsx` are untouched.

**The two dirty domains (§6.4).** A credential edit is tracked against the credential it changes,
not against the open set — so a key typed for one provider is still pending after the form moves to
another, and Save writes every edited credential, not only the visible one. (Since Phase 2b a key
typed on another provider tab was dropped on save without notice.) Save runs credentials first, then
the set: an endpoint created in the first step is what the set has to point at. Each step is its own
call, so a failure in one leaves the other exactly as it was.

The one place both halves share a payload is `buildCombinedSavePayload`, used only when the caller
performs the save itself (`onSave` — the first-run dialog and the browser preview). There is one
provider and one set on first run, so the store routing the credential is exactly what is wanted.
Phase 5 replaces that dialog.

**Custom endpoints in a form that has no endpoint list yet.** Until Phase 4 the form is still "this
set's URL and key", so three rules stand in for the missing picker:

- A custom set shows the endpoint it points at; switching a catalog set to Custom shows a blank
  endpoint. An existing endpoint is never picked on the user's behalf — it may be shared, and typing
  into it would move every set on it.
- Typing an address that already has an endpoint points the set at that endpoint instead of creating
  a twin. The key on screen is passed on only if the user typed it in the same edit; otherwise it
  belongs to the endpoint being left.
- Editing the address or key of a set's own endpoint edits the endpoint in place, exactly as
  `update()` has done since Phase 2a. **This also moves every other set on that endpoint**, which
  the form cannot show. Phase 4's endpoint list is what makes that visible.

#### Behaviour that changed, each visible as a test

- **A blank set on a custom provider points at the same endpoint** as the set it was created from,
  and is usable straight away. Before, it resolved to an empty credential — the §1.2 complaint, left
  unfixed for the one provider where the "provider" is an endpoint.
- **A custom set is never given an invented model.** `defaultModelFor('custom')` returns the
  endpoint's own `defaultModel` or nothing; it used to fall back to the slot default (`glm-5` for an
  Anthropic-protocol gateway). The renderer shows a custom set's model as typed in every case —
  before, one that shared an id with a "More Models" preset was treated as picked, leaving the typed
  field empty while a model was in fact saved.
- **A new custom endpoint starts with an empty address** on the Anthropic protocol. The form used to
  show the store's default for that slot (`https://open.bigmodel.cn/api/anthropic`).
- **Saving a custom provider requires a base URL.** An endpoint is identified by its address; before,
  the store silently dropped the write.
- **Renaming a set, or deleting another one, keeps unsaved edits.** Both used to reload the whole
  form.
- **A legacy "Ollama on a custom OpenAI endpoint" set** is still shown as Ollama, but Ollama's own
  credential now shows its usual local address, not a copy of the endpoint's.

#### Tests

| File                                                  | Tests | Covers                                                                                                                                                               |
| ----------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/config-store-credential-migration.test.ts`     | 41    | **new** — migration from the 1.0.8 shape, on-disk key removal, one-time-ness across restarts, conflict record, `setProviderCredential`, set-only saves, `endpointId` |
| `tests/api-config-provider-credentials-state.test.ts` | 39    | **new** — targets, hydration, dirty detection, the save plan                                                                                                         |
| `tests/api-config-draft-independence.test.ts`         | 11    | **new** — §8.1's "Draft independence": the renderer's payloads fed to the real store, each half compared before and after                                            |
| `tests/api-config-state-render.test.ts`               | 9     | **new** — first render of the composed hook for eight config shapes                                                                                                  |
| `tests/api-config-state-config-sets.test.ts`          | 36    | rewritten for the set slice (was 8)                                                                                                                                  |
| `tests/api-config-state-thinking-level.test.ts`       | 15    | re-pointed at `modelSetsReducer`                                                                                                                                     |
| `tests/api-config-state.test.ts`                      | 48    | the eight snapshot and source-text tests re-expressed against the slices; the rest untouched                                                                         |
| 15 further files                                      | —     | assertions on the removed fields replaced; fixtures lose the two keys                                                                                                |

**Gates:** typecheck clean; `npm test` **3662 passed / 237 files** (3521 after the token-limit
commit); lint 0 errors, the same 16 pre-existing warnings.

**Verification beyond "tests pass":** 31 mutations were injected into the new store and state logic.
28 were caught at once. The other three were all informative:

- Two rules had no test reaching them — a flat-only config that differs from the defaults _only_ by
  its key, and an unknown `endpointId` sent for a catalog provider. Tests added; both mutations now
  fail.
- One piece of code was redundant: `migrateLegacyCredentialShape` stripped the pre-split fields from
  its output, but the rest of normalization reads only current fields, so they never reached the
  result anyway. Removed, and the comment that credited it with making the migration one-time was
  corrected — what does that is the persisted result plus the on-disk delete.

**External review: split into three parts, one approved, two not re-checked.** (Parts A and B
were reviewed again after the commit and approved — see "Second review of parts A and B" below.)
The change is
499,969 characters of diff against a 250,000 limit per review, and the two largest files alone come
to 224,000, so it could not go in two parts either. It was reviewed as three self-contained parts
from a scratch clone, so nothing in the working tree was staged, stashed or committed for the sake
of a review. The refused first run counts against the cap of five, which left one pass per part and
a single re-check:

| Part                                | First pass                  | After fixes                         |
| ----------------------------------- | --------------------------- | ----------------------------------- |
| A — store, IPC, store tests         | 1 blocking, 1 medium, 1 low | **not re-reviewed**                 |
| B — pure state modules and tests    | 1 blocking, 2 medium, 1 low | **not re-reviewed**                 |
| C — hooks and the tests beside them | 1 blocking, 3 medium        | **approved** (3 medium, 1 low left) |

What the review found, by outcome:

- **Real, fixed — a stale `endpointId` / `contextWindow` / `maxTokens` in the file** (part A). The
  same mechanism as finding 2 above, in a place it had not been applied: the optional projected
  fields are present only while the active set has them, and `set(object)` never removes one.
  `saveConfig` now deletes them. Harmless to every reader — none trusts the raw value — but the
  stored projection described a set that was no longer active.
- **Real, fixed — three rules for one address** (part B). What the form showed, what it compared and
  what it sent each treated the base URL slightly differently (Ollama's `/v1` normalization, a cloud
  provider's preset, an endpoint's canonical form). In practice the saved edit is dropped after a
  save, so nothing stuck — but that was the caller covering for the module. `savedBaseUrl` is now the
  one rule, and the store normalizes an Ollama address on write, as it did before the split.
- **Real, fixed — a config dropped in the browser preview** (part C). The loaded-config handler was
  put in a ref from an effect that runs _after_ the loader's. With IPC the loader awaits first and
  the order does not matter; with nothing to await it reported back to a ref that was still empty.
  Both refs are now assigned during render.
- **Real, fixed — two races the old hook already had** (part C): a connection test or diagnosis
  answer arriving after the form had moved on was still shown, and an Ollama discovery that changed
  the address triggered the address-change reset, which threw away the list discovery had just
  filled. Results are now generation-checked, and the reset fires only on a real change.
- **Real, fixed — a capability query that ran a render late** (part C): the protocol and address
  were handed to `useModelSets` as state set from an effect, so the first query after every open
  went to the wrong place. Now resolved during render.
- **Hardening, done** (part B): `buildConfigSets` copies the known fields instead of spreading what
  came over IPC, so nothing else on an incoming set can reach renderer state.
- **Not real, disproved by test** (part A, its blocking finding): "`setProviderCredential` never
  re-projects the flat fields, so `get('apiKey')` keeps the old key". `saveConfig` normalizes before
  it writes. Two tests now assert it against both the direct read and the file.
- **Not real** (part A): "`isFreshInstall` is unused" — it is used further down `normalizeConfig`,
  outside the lines the reviewer was shown. And part C's blocking finding overstated its reach:
  opening Settings did not wipe a saved Ollama model, because one that is not built-in loads as
  typed and the reset only ever cleared a _picked_ one.

The remarks left on part C's approval were applied afterwards and have **not** been reviewed: the
created-endpoint id handoff now fails loudly instead of saving a set that points at nothing, the
connection test asks for an address wherever Save does, and the custom-model debounce no longer
carries the previous set's model across a switch.

Five mutations of the review fixes were run afterwards; all five are caught.

**Manual pass (2026-10-06), partial.** The development build was started against the user's real
settings — backed up first, restored byte for byte afterwards — and the main-process log was
followed while the user worked in Settings → API. The suite cannot run the hooks' effects (there is
no component-test setup: `environment: 'node'`, no DOM library), so this is the only evidence for
them.

Seen working, each without an error in the log:

- **The conversion of a real 1.0.8 file.** `config.json` went from 12,305 to 5,841 bytes; the active
  set came up on its provider with its key, and the app reported itself configured.
- **A set save carries no credential.** Model and thinking-level changes sent only the set's fields,
  and the key was still set after each.
- **Token limits are saved**, as numbers, including an edit to max tokens alone.
- **Switching sets**, including to a custom set, which resolved its own address, key and model.
- **Renaming a set.**
- **A blank set created from a custom set** pointed at the same endpoint and started on that
  endpoint's default model.
- **Re-pointing by address.** Typing an address that already had an endpoint pointed the set at it,
  with no call that changes an endpoint; the key that was on screen from the previous endpoint was
  not written over the new one's.

Not exercised — none of these calls appears in the log: changing a key (`setProviderCredential` and
`updateCustomEndpoint` were never invoked), creating an endpoint from scratch, deleting a set, Ollama
discovery, and a restart of the converted build. Whether the unsaved-changes dialog appeared on the
switches cannot be told from the log.

**Found by the user: two custom providers cannot be told apart or chosen.** With a local gateway
and a hosted one both configured, the provider field says "Custom" for either, the endpoint's name
is shown nowhere, and the only way to move a set to the other is to retype its address. The store
keeps them apart correctly (each set ran against its own endpoint); what is missing is the chooser.
This is Phase 4's endpoint list and the provider control on the set — confirmed as the next thing
to build, not patched into the screen Phase 4 retires. Also now untrue on that screen: the hint
under API Key, `api.apiKeyDescription` ("Saved locally and scoped to the active configuration set").

Two practical notes for the next manual run. The development build uses the **same** data folder
as the installed app (`app.setName('sqowe-pilot')`,
[`migration/bootstrap.ts:22`](../../../src/main/migration/bootstrap.ts#L22)), so its first start
converts the installed app's settings file one-way: quit the installed app and back the file up
first. And when it is started from a terminal that an editor spawned, `ELECTRON_RUN_AS_NODE=1` is
inherited and Electron starts as plain Node (`electron.app` is undefined at the first line that uses
it) — start it with `env -u ELECTRON_RUN_AS_NODE npm run dev`.

**Second review of parts A and B (2026-10-06, after the commit).** Phase 3 went in as `c381f8c3`
with parts A and B reviewed once. The review script only sees uncommitted changes, so each part was
rebuilt as one: a scratch clone checked out at the parent commit (`ddecc9c6`) with that part's files
copied in from the working tree. Part A now also holds `src/shared/legacy-model-id.ts` and its test.
Four runs of the cap of five:

| Run | Part | Result                                         |
| --- | ---- | ---------------------------------------------- |
| 1   | A    | approved — 2 medium, 2 low                     |
| 2   | B    | needs changes — 2 blocking, 3 medium, 1 low    |
| 3   | B    | **approved** — 3 low, none needing a change    |
| 4   | A    | **approved** — 2 low, neither needing a change |

Every finding was checked against the code and settled with a test before anything was changed.
By outcome:

- **Real, fixed — an old OpenRouter address corrected on the projection only** (part A). A
  credential migrated with `https://openrouter.ai/api` kept that value in `providerCredentials`;
  only the projected `baseUrl` was moved to `/api/v1`. Chats were unaffected, but the form and the
  connection test read the credential store, so they used the old address. The rewrite now happens
  in `normalizeProviderCredentials`, which also repairs a store migrated by an earlier build.
- **Real, fixed — a dashed OpenRouter Claude id stored one way and shown another** (part A).
  Narrower than the finding said: the stored id and the projected one always agreed. The form was
  the odd one out — it rewrote `…-4-5` to `…-4.5` on load without reading as changed, so a chat ran
  on an id Settings did not show. It also reached new data: the store's default for OpenRouter is
  `anthropic/claude-sonnet-4-6`, a blank set starts on it, and since Phase 2a a blank set is usable
  without passing through Save. pi-ai 0.87.1 lists that model as `anthropic/claude-sonnet-4.6` only
  (`dist/providers/data/openrouter.json`). **Not verified:** whether OpenRouter rejects the dashed
  spelling. The rule moved to `src/shared/legacy-model-id.ts`, used by `normalizeConfigSet` and by
  the form, so there is one of it. `normalizeModelIds` became unreachable and was removed.
- **Narrowed on the way — the rewrite takes one or two digits.** The old pattern turned a dated id
  (`…-4-20250514`) into `…-4.20250514`. Harmless-looking while it only touched the form; it now
  runs on stored data, so a date is left as typed.
- **Real, fixed — a save rolled back while a pre-split key is in the file** (part A). The app never
  leaves one behind, so the reviewer's route ("if the delete fails") does not exist: a failed delete
  fails the constructor. But an older build pointed at the same file writes `profiles` back — and
  the development build shares its data folder with the installed app. With the key present every
  read re-runs the migration, which trusts it over a lone default set; a test showed a model change
  reverting at once. `saveConfig` now deletes those keys as well.
- **Real, fixed — "unsaved" with nothing to save** (part B). A key typed for a not-yet-created
  endpoint with no address counted as an unsaved change while the save plan skipped it. Left behind
  on another provider, it kept the form marked as changed after a save that had succeeded.
  `dirtyCredentialTargets` now leaves it out — as it already did for an endpoint that no longer
  exists — and `planCredentialSave` works from that list, so the two cannot disagree. **Accepted
  cost:** such a key is no longer behind the unsaved-changes prompt; Save still refuses a custom
  provider without an address and says so.
- **Removed — `SET_ENDPOINT_ID`** (part B). Nothing dispatched it, and it changed a set's endpoint
  without the per-endpoint model memory. A set moves between endpoints through `CHANGE_PROVIDER`;
  a test now walks endpoint 1 → 2 → 1. This is the action Phase 4's chooser uses.
- **Not a defect, now stated by a test.** A first start interrupted between the migration's two
  writes is finished by the next one (part A; replacing the stored object in one assignment was
  considered and rejected — it would bypass conf's per-key value checks). A key typed on a new
  OpenAI- or Gemini-protocol endpoint creates it at the pre-filled address (part B, raised as
  blocking): that address is the value of the field, on screen, and 1.0.8 saved it the same way;
  skipping it would save a set that points at nothing. A cleared address on an existing endpoint is
  still sent (part B): main refuses it, stores nothing, and the form shows why.
- **Not real.** `isFreshInstall` "unused" — raised a second time, and still passed on to
  `normalizeMemoryRuntimeConfig`, outside the lines shown. Endpoint fields "unchecked on arrival" —
  `normalizeCustomEndpoints` guarantees them before they cross IPC. A target key colliding with an
  endpoint whose id is `new` — ids are minted as `custom-endpoint-<n>`. `AppConfig` test fixtures
  missing the three new fields — those fixtures never held the full type, and `tests/` is outside
  `tsconfig`'s `include`. Store tests importing renderer modules — an effect of the split.
- **Confirmed on request.** Part B's reviewer asked whether main clears a set's `endpointId` when it
  moves to a catalog provider, since the form sends none. It does; a test now covers it, including
  that the pointer does not return.

Passing the reviewer facts about code outside the changed lines, in the script's context argument,
is what closed the disputed blocking finding: run 3 approved with the code unchanged on that point.

**Not reviewed:** the removal of the unused `setEndpointId` wrapper from `useModelSets.ts`, which is
part C.

**Gates after the follow-up:** typecheck clean; `npm test` **3684 passed / 238 files**; lint 0
errors, the same 16 pre-existing warnings.

**Left for later phases:** the error strings main throws for endpoints (duplicate address, cap
reached, in use) are shown untranslated — the form can now reach the first two. They belong with
Phase 4's endpoint UI and its four locale files.

#### What §§1–12 say that is no longer current

- §3.3 / §3.4 are now the shape in the code, plus `AppConfig.endpointId?` and
  `AppConfig.credentialConflicts`.
- §4: `projectFromConfigSet` and `composeProjectedConfig` take the credential store as it is; nothing
  is derived from a set outside the one-time migration.
- §9.4 is closed: there is one source of truth, and no code path that could create a second.
- §8.2's eleven coupled test files are all migrated. `chat-view-config-set-restore.test.ts` asserts
  source text, so it needed a new assertion rather than a migration; `provider-type-widening.test.ts`
  was missing from that list and needed no change, because the helpers it imports are still exported
  from `useApiConfigState`.

### Phase 4 — UI

Sidebar split (§6.1), `SettingsProviders.tsx`, `ProviderConfigDialog.tsx`,
`SettingsModelSets.tsx`; `SettingsAPI.tsx` retired.

Built in two steps. The user's priority inside the phase: two custom providers — a local gateway and
a hosted one — could be neither told apart nor chosen between, so the named endpoint list and the
chooser on a config set come first.

#### Step 1 as built (2026-10-06) — both tabs, endpoint list and chooser

##### Decisions taken with the user before starting

| #   | Question                                               | Decision                                                                                                                                   |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | §6.3's read-only provider chip, or a real chooser?     | **A chooser.** The chip's "Change" opened the Providers tab, which says which credentials exist, not which one a set uses.                 |
| 2   | What goes in the first commit?                         | Both tabs at once, with the endpoint list and the chooser complete and catalog providers in the plainest working form.                     |
| 3   | Where do custom endpoints sit on the Providers tab?    | **At the top.** §6.1's sketch has them last, below about thirty catalog providers.                                                         |
| 4   | Which tab does Settings open on? What about `api`?     | Model Sets. The welcome screen's "not configured" link opens Providers. The old `api` id keeps working and opens Providers.                |
| 5   | Can a set be saved while its provider has no key?      | **Yes**, with a warning and a link to Providers. The old form blocked Save, which no longer makes sense once the key lives on another tab. |
| 6   | An address that already has an endpoint, in the dialog | **An error.** The old single form silently pointed the set at the existing endpoint; a dialog that adds an endpoint has no set to point.   |

##### What the pre-implementation read found

1. **Translated error messages could not work, for any message.** A handler that throws reaches the
   renderer as a new error whose message Electron has put its own text in front of —
   `Error invoking remote method '<channel>': Error: <message>` (the string is in the installed
   Electron 41.10.7; Electron's `ipc-main` documentation says only that the error "is not the same"
   and points at issue #24427). `translateApiConfigErrorMessage` compared the whole text with fixed
   strings, so nothing could match, including the config-set messages that have existed since
   config sets did. The tests passed because they fed it the bare message. It now strips the prefix
   first, and its tests use the text the renderer really receives. Confirmed in the running app
   during the manual pass (below).
2. **Settings tabs stay mounted** once visited (`SettingsPanel.tsx`), and the old form created its
   state inside the screen. Two tabs each doing that would drift apart at the first save: an
   endpoint added on one would be missing from the chooser on the other. Hence one state above both.
3. **The suite cannot click a screen** (`environment: 'node'`, no DOM library). So the decisions go
   into plain functions with tests, the screens get first-render tests, and the clicking is a manual
   pass.

##### As built

| File                                                                                 | Role                                                                                                                                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/api-settings-view.ts`                                                         | **new**, pure. Chooser entries and their ids, credential status, which sets use what, the credential a set would run with, what each dialog opens on and sends.               |
| `hooks/useApiSettingsState.ts`                                                       | **new**. The state both tabs share: the credential store as main last returned it, the config-set half (`useModelSets`), and the four credential calls.                       |
| `hooks/useModelSetForm.ts`                                                           | **new**. The Model Sets tab as a form. Reads the credential behind the chosen provider and never writes one.                                                                  |
| `components/settings/ApiSettingsContext.tsx`                                         | **new**. Creates that state once, above both tabs.                                                                                                                            |
| `components/settings/SettingsProviders.tsx`, `ProviderListRows.tsx`                  | **new**. Custom endpoints as a named list, then the catalog providers.                                                                                                        |
| `components/CustomEndpointDialog.tsx`, `ProviderConfigDialog.tsx`                    | **new**. One credential each, with its own Save.                                                                                                                              |
| `components/settings/SettingsDialogFrame.tsx`                                        | **new**. The dialog frame (Escape, Tab kept inside, focus returned to the opener) and `useDialogSave` / `useSingleFlight`.                                                    |
| `components/settings/SettingsModelSets.tsx`, `ModelFieldsSection.tsx`                | **new**. Set manager, chooser, model, limits, thinking level, diagnostics, Save.                                                                                              |
| `components/ProviderChoicePicker.tsx`                                                | **new**. The chooser, on the existing `SearchableCombobox` (whose list entries can now carry a status dot).                                                                   |
| `components/settings/settings-tabs.ts`                                               | **new**. The tab ids and `resolveSettingsTab`, apart from the panel so they can be tested.                                                                                    |
| `components/SettingsPanel.tsx`, `WelcomeView.tsx`, `store/index.ts`, `nav-server.ts` | `api` → `providers` + `modelSets`.                                                                                                                                            |
| `hooks/api-config-shared.ts`                                                         | `stripIpcErrorPrefix`; endpoint messages in the translator; `protocolOf` moved here from `useApiConfigState`.                                                                 |
| `components/settings/SettingsAPI.tsx`                                                | **deleted**.                                                                                                                                                                  |
| `i18n/locales/{en,zh,ru,hu}.json`                                                    | `api.providers.*`, `api.modelSets.*`, the two tab names; `api.apiKeyDescription` corrected (it said a key belongs to the active config set); `settings.apiSettings*` removed. |

**One state, two halves.** `useApiSettingsState` holds the credential store as main last returned
it, with no unsaved credential edits at all: a credential is edited in a dialog with its own Save,
so there is nothing to track between opening and saving. Each credential call writes one credential
and names no config set; what comes back refreshes the set list but **keeps the unsaved edits to
the open set** (`rebase`). The config-set half is Phase 3's `useModelSets`, unchanged, whose save
names no credential. §6.4's two unsaved-change domains therefore came out as one: the set's. The
Phase 3 draft machinery for credentials (`provider-credentials-state.ts`) is still what the
first-run dialog uses, through `useApiConfigState`, until Phase 5.

**The chooser.** Every custom endpoint is its own entry, by name, with its protocol as a badge and
a status dot; the catalog follows in its usual grouping. The catalog's bare "Custom" is not listed —
a set cannot run on it without saying which endpoint. A custom set that points at none (never
pinned, or its endpoint deleted since) gets a "No endpoint chosen" entry, a warning, and is refused
on Save. Changing the choice goes through `CHANGE_PROVIDER`, so the model typed for each endpoint is
kept while the form moves between them.

**What a set is shown to run on is never made up.** `persistedCredentialFor` returns the endpoint's
own protocol, address and key, or the provider's slot — and for a custom set with no endpoint,
nothing. The Phase 3 hydration pre-fills a not-yet-created endpoint with its protocol's usual
address; shown here, that would claim the set runs somewhere it does not.

**A dialog opens on what is stored, and only that.** The provider dialog reads
`storedProviderCredential`, not the hydrated credential: an address nobody gave is an empty field
with the usual address as a hint. (Found in review — fed from the hydrated value, opening the
Ollama dialog and pressing Save stored `http://localhost:11434/v1` as if the user had typed it.) A
new endpoint likewise starts with an empty address. This is the "pre-filled address" question the
Phase 3 review raised, settled for the new screens by not pre-filling.

##### Behaviour that changed

- **Two custom endpoints are two things.** Each has a name, shown in the list and in the chooser;
  moving a set from one to the other is a choice, not retyping an address.
- **An endpoint says which config sets use it**, and cannot be deleted while one does — the button is
  off and says why. Editing an endpoint used by several sets says so in the dialog.
- **A credential has a status**: _Configured_; _Key missing_ (a set runs on it and it has no key);
  _Not set_ (nothing stored, nothing relies on it). A keyless provider is never "missing" a key, and
  a gateway on this computer may run without one.
- **A set can be saved without a key** (decision 5), and a custom set cannot be saved without an
  endpoint.
- **An address that is taken is refused in the dialog** (decision 6), with a translated message.
- **Ollama-only controls follow the Ollama provider.** `isOllamaMode` was "keyless with an address
  field"; it is now `provider === 'ollama'`, in this form and the old one. No visible change with
  today's catalog, where only Ollama has that shape.
- **Settings opens on Model Sets**; `api` still resolves, to Providers.

##### Not in step 1 — these were on the old screen and return in step 2

The ready-made setups card and the hints under protocol and address (in the endpoint dialog);
testing a key before saving it (in the dialogs — the Model Sets tab still runs diagnostics against
the saved credential); finding a local Ollama address. `tests/provider-guidance-ui.test.ts` carries
an `it.todo` for the first. Step 2 also adds what is new: the notice for a key dropped during
conversion (`credentialConflicts`) and `set · model` labels in the chat and welcome pickers.

##### Tests

| File                                      | Tests | Covers                                                                                                                |
| ----------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| `tests/api-settings-view.test.ts`         | 34    | chooser ids and entries, credential status, usage, the credential a set runs with, both dialogs' values and payloads  |
| `tests/api-settings-tabs-render.test.ts`  | 17    | first render of both tabs for five config shapes; rows; that no key is ever on the page                               |
| `tests/api-settings-state-render.test.ts` | 16    | first render of the shared state and the form: fields connected to the right values                                   |
| `tests/api-config-error-messages.test.ts` | 15    | the translator, fed the text the renderer really receives                                                             |
| `tests/settings-tabs.test.ts`             | 14    | tab ids, the old id, and that the four places outside the panel agree                                                 |
| `tests/api-settings-i18n.test.ts`         | 12    | every text key the new screens ask for exists in all four files, with the same placeholders                           |
| `tests/settings-dialog-save.test.ts`      | 6     | one save or delete at a time; the dialog stays open when a save is refused                                            |
| 4 existing files                          | —     | the tab id in `welcome-view-claude-layout`; wording in two; `provider-guidance-ui` adjusted, with the `it.todo` above |

**Gates:** typecheck clean; `npm test` **3798 passed / 245 files**, 1 todo (3684 before); lint 0
errors, the same 16 pre-existing warnings.

**Verification beyond "tests pass":** 14 mutations of the new logic. 13 were caught at once. One
survived and was informative — nothing covered an unsaved choice whose endpoint is deleted on the
other tab afterwards; a test now renders exactly that state.

**External review: approved on the fourth run of five.** Reviewed as one piece (195,685 characters
at first, 224,330 at the end) from a scratch clone, so the real index was never staged.

| Run | Result                                               |
| --- | ---------------------------------------------------- |
| 1   | needs changes — 1 blocking, 2 medium, 1 low          |
| 2   | needs changes — 1 blocking, 2 medium, 2 low          |
| 3   | needs changes — 2 blocking, 1 medium, 3 low          |
| 4   | **approved** — 2 medium, 1 low, deferred (see below) |

Every run found a further layer of smaller points in the dialogs; none touched the storage split,
the shared state or the chooser. By outcome:

- **Real, fixed:** `isOllamaMode` (above); the provider dialog opening on the hydrated address
  (above); focus not returning to the button that opened a dialog — the frame asked "what has
  focus?" in an effect, after its own `autoFocus` field had taken it, and now asks during its first
  render; the "saved" notice sitting where a provider far down the list could not see it — now on
  the row that was saved; a dialog surviving a tab change, which a click cannot cause but an outside
  navigation request can; the delete confirmation apart from its row; Tab leaving a dialog while
  everything in it is disabled; untranslated protocol names; a timer never cleared.
- **Hardened, not a defect:** a second save or delete while one is on its way. React flushes a
  click's state update before the next click is delivered, so the button is already disabled; both
  now go through `useSingleFlight` anyway.
- **Not real:** diagnostics surviving a provider change — `useApiConnectivity`'s reset already
  depends on the provider; a React warning for a state update after a dialog has closed — React
  18.3.1 no longer has one.

**Remarks on the approval, deferred to step 2**, which reworks both dialogs anyway, so that what is
committed for step 1 is exactly what was approved: Enter does not save in the dialogs (they are not
`<form>`s); when a dialog is closed by a tab change, focus returns to a button in a hidden tab; and
the chooser and model fields stay editable during the few milliseconds a set save is on its way,
when an edit made then is overwritten by what comes back — as it was on the old form.

Two comment lines that still named `SettingsAPI` were corrected after the approval and are the only
text not reviewed.

**Noticed and left alone:** `zh.json` lacks 60 keys the English file has, in other sections;
`settings.prompt` / `settings.promptDesc` are in none of the four files (the System Prompt tab falls
back to its inline English); `ProviderPicker` is used by no screen now and is kept for Phase 5's
wizard; `docs/wiki/features/models-and-api.md` still describes the single screen (Phase 6). In the
Russian texts a custom endpoint is «подключение»; the file's older hints use the untranslated
"endpoint", which does not decline.

**Manual pass (2026-10-06).** The development build was started against the user's real settings —
backed up first, restored afterwards and verified by checksum — and the main-process log was
followed while the user worked through a list; nine screenshots came back.

Seen working, each without an error in the log:

- **The conversion of the real 1.0.8 file**, again: 12,305 → 5,841 bytes, configured on its
  provider.
- **The endpoint list.** Five endpoints, one per protocol + address the old profiles described,
  each with its status and the sets that use it. Two were renamed (`updateCustomEndpoint` twice).
- **The chooser.** It lists every endpoint by name. A set was moved from one gateway to the other
  and saved: the payload was `activeConfigSetId`, `provider`, `endpointId`, `model`, the two limits
  and the thinking fields — no credential — and the endpoint's key was still set afterwards. (The
  log line prints `apiKey: ''` for every save; that is the handler masking the field, not the
  payload.)
- **One state for both tabs.** After that save the Providers tab showed the set under its new
  endpoint and the old one as unused, without Settings being reopened.
- **Delete.** The button is off for an endpoint in use; an unused one was deleted after the
  confirmation on its own row, during which no other row offered an action.
- **A catalog provider's key** (`setProviderCredential`): "Saved" on its row, then _Configured_.
- **The unsaved-changes mark and the prompt** on switching sets with an edited model.
- **The Russian texts.**
- **A duplicate address is refused in the dialog**, in words — by the dialog's own check, so main
  was never asked and this did not exercise the translator.

**Electron's prefix, observed.** Because the dialog catches the common cases first, the text of a
main-process error was read directly: through the debugging port the development build opens
(`remote-debugging-port`, `main/index.ts`), two calls that main refuses before writing anything
were made in the renderer. They rejected with
`Error invoking remote method 'config.deleteCustomEndpoint': Error: Custom endpoint not found` and
`Error invoking remote method 'config.renameSet': Error: Config set not found` — the shape the
translator now strips, and proof that before this step "Config set not found" could not have been
translated.

Not exercised: whether focus returns to the opening button when a dialog closes (asked for, not
reported); creating an endpoint successfully from the dialog (`createCustomEndpoint` does not
appear in the log); Ollama; the warning for a set whose provider has no key; the Chinese and
Hungarian texts; a restart of the converted build.

**Noticed in the pass:** two endpoints on one host with different protocols get the same default
name (`127.0.0.1:9000`), told apart only by the protocol badge and the address until renamed. A
candidate for step 2: add the protocol to the default name when the host is already taken.

#### Step 2 as built (2026-10-06) — what came back, the dropped-key notice, the leftovers

##### Decisions taken with the user before starting

| #   | Question                                                 | Decision                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Which check goes into the dialogs, and with which model? | **The five-step diagnostics run**, fed from the dialog's fields — not the single-request test of the first-run dialog. The model it tries is named on screen: for an endpoint its Default model field, else the model of a config set on it; for a provider the model of a config set on it, else the one a new set would start on. With none it stops short of a model and says so. |
| 2   | How does the dropped-key notice go away?                 | **By saving that credential again** — no separate call to main. The notice says so, on the row and in the dialog.                                                                                                                                                                                                                                                                    |
| 3   | What does the setups card list in the endpoint dialog?   | **The six setups that are custom endpoints**, as a compact list, for a new endpoint only. OpenRouter and Ollama are left to the hint, which has a button to that provider's own dialog; Save stays allowed and the typed key is not carried across. The generic setup sets the protocol only.                                                                                        |

##### What the pre-implementation read found

1. **The old Settings screen never had a "Test connection" button.** It had the diagnostics panel,
   fed from the values on screen; the single-request test (`config.test`) is only in the first-run
   dialog. That test needs a model, and the provider dialog has none: sent with no `model` it falls
   back to the active config set's (`buildProbeConfig`, `claude-sdk-one-shot.ts`), so an OpenAI key
   would be tried against a Claude model; sent with an empty one it answers `missing_model`. The
   diagnostics run skips its last step without a model — but its key check is then "list the
   models", where a 404 counts as passed, so a wrong key can pass on some services. Hence decision
   1: the diagnostics run, with a model wherever one is known, and words on screen where none is.
2. **Two of the eight ready-made setups are not custom endpoints.** OpenRouter and Ollama are
   catalog providers (`applyProvider`, `api-provider-guidance.ts`); on the old screen "Apply"
   switched the form to that provider, which a dialog that adds an endpoint cannot do. And the
   generic setup's address, `https://your-provider.example/v1`, is an example: filling it in would
   contradict step 1's rule that an address nobody gave is never a value.
3. **The existing hint named a "tab" that no longer exists** (`api.guidance.preferProviderTab`:
   "the dedicated {{provider}} tab"). The dialog has texts of its own; the old ones stay with the
   first-run dialog until Phase 5.
4. **The dropped-key record was discarded on arrival.** `credentialsOf` kept the credential map and
   the endpoint list and nothing else. And both dialogs always send the key, so any save of a
   credential removes its entry — including a save that changes nothing, and a rename of an
   endpoint. That is decision 2's mechanism, now said on screen instead of being a side effect.
5. **No test had ever drawn the inside of a dialog.** The frame draws into `document.body`, which
   the suite does not have, and the tab tests only render the tabs with no dialog open.
6. **The set switcher was open during a save as well** — the same loss as the model fields, in a
   component the first-run dialog shares.
7. **The two same-named endpoints came from the conversion, not from the dialog.** A default name
   is given in four places in the store; one rule for all four.

##### As built

| File                                                                                             | Role                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/credential-dialog-view.ts`                                                                | **new**, pure. Which setups an endpoint can be filled from and what filling does; the model a check tries; how an Ollama search is reported.                                                   |
| `hooks/useCredentialCheck.ts`                                                                    | **new**. The form's own check and Ollama search (`useApiConnectivity`), pointed at a dialog's fields, with what a dialog lacks switched off.                                                   |
| `components/CustomEndpointDialog.tsx`, `ProviderConfigDialog.tsx`                                | Each is now a state function (`useCustomEndpointDialog`, `useProviderConfigDialog`) plus the frame.                                                                                            |
| `components/CustomEndpointFields.tsx`, `ProviderCredentialFields.tsx`                            | **new**. Everything inside each dialog, drawn from that state — so a test can draw it without a page.                                                                                          |
| `components/settings/CredentialDialogParts.tsx`                                                  | **new**. What both dialogs share: the check section, the dropped-key notice, the footer with the one submit button.                                                                            |
| `components/settings/SettingsDialogFrame.tsx`                                                    | With `onSubmit` the body and footer are a real `<form>`; focus returns only to an opener that is still drawn (`canReturnFocusTo`).                                                             |
| `components/ProviderGuidance.tsx`                                                                | The setups card has a `list` layout for a narrow dialog; the table stays for the first-run dialog.                                                                                             |
| `components/settings/SettingsProviders.tsx`, `ProviderListRows.tsx`                              | The notice on rows; the values the dialogs need; the hand-over from the endpoint dialog to a provider's.                                                                                       |
| `hooks/api-settings-view.ts`, `useApiSettingsState.ts`                                           | `credentialConflicts` is carried with the credential store; `droppedKeySetNames`; rows say which sets lost a key.                                                                              |
| `hooks/useApiConnectivity.ts`                                                                    | One option, `listsModels`, default on. Off, Ollama's model list is not fetched as its address is typed.                                                                                        |
| `components/settings/SettingsModelSets.tsx`, `ModelFieldsSection.tsx`, `ApiConfigSetManager.tsx` | `isLocked` (a save or a switch is on its way) turns the chooser and every model field off; the set switcher and its New / Rename / Delete are off during a save as well.                       |
| `utils/config-set-label.ts`, `ChatView.tsx`, `WelcomeView.tsx`                                   | **new** helper; both pickers show `name · model`, and their closed width went from 120 / 140 px to 220 / 260 px so the model is not cut off at once.                                           |
| `shared/custom-endpoint-key.ts`, `main/config/config-store.ts`                                   | `defaultCustomEndpointName` takes the names already in use; all four places that name an endpoint pass them.                                                                                   |
| `i18n/locales/{en,zh,ru,hu}.json`                                                                | Ten texts under `api.providers` (`droppedKey`, `droppedKeyInDialog`, `catalogProviderHint`, `openCatalogProvider`, `ollamaSearchHint`, `check.*`), 12 lines per file and nothing else changed. |

**Enter saves, by the browser's own rule.** The dialog's body and footer are a `<form>` and Save is
its one `type="submit"` button, so Enter in any field does what a click on Save does. A key handler
was the alternative and was not taken: the browser already leaves out the two cases a handler
would have to get right — a disabled Save, and the Enter that finishes a character being composed
(the app has a Chinese locale). Every other button in a dialog is `type="button"`, which a test
counts. The submit is stopped inside the dialog: React's `createPortal` reference says events from
a portal travel up the React tree, not the page's.

**Focus goes back only to something that is drawn.** Closed by a change of tab, a dialog's opener
sits in a tab with `display: none`. `canReturnFocusTo` asks whether the element has a box on the
page; an element that has left the page has none either, so the one question covers both.

**From the endpoint dialog to a provider's.** The hint's button closes the endpoint dialog first
and opens the provider's in a later pass (`providerToOpen`, an effect in `SettingsProviders`). A
dialog remembers what had focus when it opened; opened in the same pass, the second would remember
a button inside the first — about to be removed — and the first one's closing would then pull
focus out from under it. React runs the cleanup of everything removed before any new effect, so by
the time the effect runs, focus is back on the "Add endpoint" button.

**What the check reuses.** `useApiConnectivity` already ran against the values on screen and
dropped an answer that arrived after they changed. `useCredentialCheck` hands it the dialog's
values and turns off what a dialog has no use for: there is no model to pick, so the model fields
are a no-op and Ollama's model list is not kept fresh (`listsModels: false`) — fetched on every
pause in typing it would put "cannot connect" next to an address still being typed. The Ollama
search runs silent and the dialog words the outcome itself (`ollamaSearchNote`), next to the
address field, which is held still while the search is out.

##### Behaviour that changed

- **A key can be tried before it is saved**, in both dialogs, and the dialog says what was tried.
- **The endpoint dialog guides again**: the setups list, the hint under the protocol (suits the
  service or does not), the hint under the address (what the service usually looks like).
- **An address that belongs to OpenRouter or Ollama says so**, with a button to that provider's
  own dialog. It is a hint: Save still works.
- **The Ollama dialog can find a local server.** It fills the address field and reports what it
  found; nothing is saved until Save.
- **A key the conversion dropped is visible**, on the row and in the dialog, with the names of the
  config sets that had another one, until that credential is saved again.
- **Pickers show `set · model`** in the chat header and on the welcome screen.
- **Enter saves a dialog.**
- **Nothing can be edited on Model Sets while a save or a switch is on its way**, and no other set
  can be chosen or created during a save.
- **A second endpoint on a host is named with its protocol** — `127.0.0.1:9000 (OpenAI)`; a
  further clash gets a number. An endpoint that has a name keeps it.

##### Tests

| File                                         | Tests | Covers                                                                                                                                            |
| -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/api-settings-dialogs-render.test.ts`  | 41    | **new** — first render of both dialogs for a range of credentials; what Save and the check send, with the bridge to main stood in for             |
| `tests/credential-dialog-view.test.ts`       | 22    | **new** — setups and what applying one does, the model a check tries, the wording of an Ollama search                                             |
| `tests/custom-endpoint-default-name.test.ts` | 17    | **new** — the naming rule, and each of the four places in the real store: the dialog, a save, a stored blank name, the conversion of a 1.0.8 file |
| `tests/config-set-label.test.ts`             | 5     | **new** — the label, and that both pickers use it                                                                                                 |
| `tests/settings-dialog-save.test.ts`         | 13    | +7 — the focus rule; that the dialog is a form with one submit button and every other button is plain                                             |
| `tests/api-settings-view.test.ts`            | 41    | +7 — which sets lost a key, by current name; rows                                                                                                 |
| `tests/api-settings-tabs-render.test.ts`     | 24    | +7 — the notice on rows; every field off while a save or a switch is on its way                                                                   |
| `tests/api-settings-state-render.test.ts`    | 18    | +2 — the record reaches the shared state                                                                                                          |
| `tests/provider-guidance-ui.test.ts`         | 5     | the `it.todo` is now three real tests                                                                                                             |
| `tests/api-settings-i18n.test.ts`            | 12    | six more source files scanned, so the guidance texts the dialogs now show are checked in all four languages                                       |

**Gates:** typecheck clean; `npm test` **3909 passed / 249 files**, no to-do left (3798 and one
to-do before); lint 0 errors, the same 16 pre-existing warnings.

**Verification beyond "tests pass":** 56 mutations of the new rules, one at a time, each against
the whole suite. 55 were caught at once. One survived and was informative: `canReturnFocusTo` also
asked whether the element was still on the page, and nothing could tell that half apart from the
other — an element that has left the page is not drawn either. The redundant half was removed.
Four tests were tightened before the run because they could have passed for the wrong reason; the
clearest was "the check does not run without an address", which an empty key was stopping first.

**Not reachable by a test:** anything that needs a key press, a click or an effect — Enter itself,
where focus lands, the hand-over between the two dialogs, a search for Ollama (it returns at once
outside Electron), and the plainer reading of a failed model step (`checkFailureHint`), which needs
a check that has come back. These are the manual pass.

**External review: approved on the first run, and again on the second with nothing left.**
Reviewed as one piece (179,572 characters, then 183,615) from a scratch clone, so the real index
was never staged. Two runs of the cap of five.

| Run | Result                                               |
| --- | ---------------------------------------------------- |
| 1   | **approved** — 1 medium, 2 low                       |
| 2   | **approved** — no remarks; "no further run required" |

Each remark of run 1 was checked against the code before anything was changed:

- **Real, fixed — a search for Ollama could be started while a check was out.** What the search
  finds is written into the address field, and a result is dropped as soon as the address it ran
  against changes; so the search would have cancelled the check the user was waiting for, without
  a word. The search button is now off while a check is on its way, as the check already was
  during a search. A test covers both directions and fails with the fix taken out. The address
  field itself stays open during a check: typing over an address drops the result run against it,
  which is the form's existing rule and what a user typing a new address means.
- **Not real — an old result beside "this endpoint needs an address".** The form's own reset
  (`useApiConnectivity`) clears the result whenever the address, key, protocol or model changes.
  An address can only become empty by changing, and that change removes the result before a check
  can be asked for; a new endpoint has none yet, because the check refuses to start. Outside the
  lines the reviewer was shown. A test now pins the reset's dependency list.
- **Not real — a search that fails without a word.** The search's whole body is one
  `try`/`catch`/`finally` that returns nothing on any failure, and "nothing" is reported as "not
  found". It cannot reject. No guard was added for a case that cannot be reached.

The facts about code outside the changed lines went into the script's context argument on both
runs, and on the second also what had been done with each remark and why. Run 2 confirmed all
three as settled.

**Gates after the review fix:** typecheck clean; `npm test` **3909 passed / 249 files**; lint 0
errors, the same 16 pre-existing warnings.

**Noticed and left alone:**

- The handler behind the Ollama search (`config.discover-local`, `main/index.ts`) returns an empty
  list when the search itself throws, where its type promises an object. The screens read the
  missing `available` field as "not found", which is the right answer for the wrong reason;
  `ollamaSearchNote` has a test for exactly that input.
- `api.diagnostic.skipped` is in none of the four language files, so "another run is already in
  progress" is shown in the panel's inline English. Main allows one diagnostics run at a time, and
  with a check in the dialogs as well as on Model Sets that message is a little easier to reach.
- The first-run dialog still shows the old hints that speak of a provider "tab", and still has the
  six-column setups table. Both go with that dialog in Phase 5.
- `SettingsProviders.tsx` is 356 lines, over the 300-line soft limit it was already at (301).
- The single-request test (`config.test`) still falls back to the active config set's model when
  it is sent none. Nothing in Settings calls it now; the first-run dialog does, and always sends
  one.

**Manual pass (2026-10-06).** The development build was started against the user's real settings —
backed up first, restored afterwards and verified by checksum — and done in two halves.

_The mechanical half, through the build's debugging port._ Clicks and key presses were sent as the
browser's own input (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`), not
as events made in page script: only real input focuses what a click hits and lets Enter submit a
form. A tab change "from outside" was a request to the navigation server (`nav-server.ts`). Every
write went to one throwaway endpoint, deleted at the end. Seen working, with no error in the log:

- **Focus after Escape** — the item step 1's pass could not confirm. Opening "Add endpoint" put the
  cursor in the name field; Escape returned focus to that button. The same for a row's Edit and a
  provider's Configure.
- **Enter saves.** In the address field it created the endpoint (`createCustomEndpoint` in the
  log — also left open by step 1's pass); in the name, key and default-model fields it saved an
  edit each time (`updateCustomEndpoint`); in a provider's key field it saved that credential
  (`setProviderCredential`). After each, the dialog closed, the row said "Saved", and focus was back
  on the button that had opened the dialog.
- **A check inside a dialog.** Against an address nothing listens on: five steps drawn, a
  translated failure at the connection step, the dialog still open, nothing saved.
- **The hand-over.** An OpenRouter address typed into the endpoint dialog showed the hint and its
  button; the button closed that dialog and opened OpenRouter's with the cursor in its key field;
  Escape returned focus to "Add endpoint".
- **A tab change from outside with a dialog open.** The dialog closed and focus was on nothing —
  not on a button in the hidden tab.
- **The search for Ollama**, with none running: "not found", the address left empty, nothing saved.
- **The "no key" warning** on Model Sets, by choosing a provider without a key and choosing the
  original again. Nothing was left unsaved.
- **Delete**, through the confirmation on the row.

_The half that needs eyes_, by the user, with five screenshots: the setups list as drawn; "Apply"
filling protocol, address and default model; a check with a real key in a provider's dialog — all
five steps passed, and the log shows it ran against the provider's stored address with the model
of the active config set; and the Providers tab in Hungarian.

**Seen on real data:**

- **The conversion of the real 1.0.8 file**, a third time: 12,305 → 5,841 bytes.
- **The second endpoint on a host is named with its protocol** — on the tab and in the chooser.
- **The dropped-key notice appeared on a provider's row**, naming two config sets, and again in that
  provider's dialog in its dialog wording. Saving the dialog removed it from the row — decision 2's
  mechanism, on a record the conversion itself had written.
- **Pickers show `set · model`** (read from the welcome screen).

**Not exercised:** the search for Ollama when one is running; Enter while a character is being
composed (it needs a Chinese input method); the picker in the chat header; a moment when a save
is on its way, which is too short to catch. **Not read by anyone who knows the language:** the ten
new Chinese texts. The Hungarian texts were seen on the tab; the ten new ones live in the dialogs.

**Noticed in the pass.** The first, third and last of these were then changed — see "After the
manual pass" below. The other two were left as they are, by decision.

- **The setups list stays open after "Apply"**, so what it filled in is below six rows of list.
- **Two hints repeat each other after "Apply"** — the one under the address recommends the address
  that is in the field. The old screen did the same.
- **After a check, keyboard focus is on nothing.** The check button is switched off while it runs
  and so drops focus; the next Tab goes to the dialog's first button. The panel is shared with the
  Model Sets tab, where the same happens.
- **A set named after its model reads twice** in a picker — `name · model` with the two alike.
- **Most of the ready-made setups are services the catalog now lists itself.** The list is older
  than the native catalog. Compared with pi-ai 0.87.1 (`dist/providers/data/*.json`) and the
  builtin presets:

  | Setup          | Its address, protocol                       | Catalog provider | That provider's address, protocol                             |
  | -------------- | ------------------------------------------- | ---------------- | ------------------------------------------------------------- |
  | Gemini         | `generativelanguage.googleapis.com`, Gemini | `gemini`         | the same address and protocol                                 |
  | Kimi Coding    | `api.kimi.com/coding`, Anthropic            | `kimi-coding`    | the same address and protocol                                 |
  | DeepSeek       | `api.deepseek.com/v1`, OpenAI               | `deepseek`       | `api.deepseek.com`, OpenAI                                    |
  | GLM / BigModel | `open.bigmodel.cn/api/anthropic`, Anthropic | `zai-coding-cn`  | `open.bigmodel.cn/api/coding/paas/v4`, OpenAI — another route |
  | MiniMax        | `api.minimax.chat/v1`, OpenAI               | `minimax`, `-cn` | `api.minimax.io/anthropic`, `api.minimaxi.com/anthropic`      |
  | Generic OpenAI | an example                                  | —                | —                                                             |

  Only OpenRouter and Ollama carry the mark (`preferProviderTab`) that sends an address to its
  catalog entry. For the first two rows an endpoint filled from the list is the catalog provider
  under another name. Whether those setups should send the user to the catalog instead is a
  decision for the guidance data, which the first-run dialog shares.

##### After the manual pass (2026-10-06) — three changes, and a rule for every pi uplift

Decided with the user on the strength of what the pass showed:

| #   | Question                                                    | Decision                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | The setups list stays open after "Apply"                    | **It folds itself away**, and focus goes to its heading.                                                                                                                                                  |
| 5   | Keyboard focus is lost after a check                        | **A button that runs something does not switch itself off for the run.** It says it is busy and ignores a second press.                                                                                   |
| 6   | Setups whose service the catalog lists itself               | **Gemini and Kimi Coding are sent to their catalog provider**, as OpenRouter and Ollama are. DeepSeek, GLM and MiniMax stay custom endpoints.                                                             |
| 7   | How is this kept true as the catalog grows?                 | **It is re-checked on every pi uplift and changed where the catalog has caught up** — written into `AI_MAIN_PROCESS.md` §1 and `CLAUDE.md`, and made into a test so the re-check does not rest on memory. |
| —   | Two hints repeating after "Apply"; a label that reads twice | Left as they are.                                                                                                                                                                                         |

**The list folds away** (`CommonProviderSetupsList`, `ProviderGuidance.tsx`). In the dialog the
`<details>` is controlled: "Apply" fills the form, closes the list, and moves focus to the list's
heading — the button that was pressed is folded away with the rest, and focus left on it would be
focus on nothing. The table layout of the first-run dialog is untouched.

**A pressed button keeps focus** (`ApiDiagnosticsPanel.tsx`, the Ollama search button). A disabled
button cannot hold focus, so one that disabled itself for the time its own action takes dropped
focus onto the page — behind the dialog. The two run buttons and the search button are now
`aria-disabled` while they work, look it, and ignore a second press; they are really `disabled`
only when the screen says the action cannot be taken at all (no key, a save on its way). This
changes the Model Sets tab as well, which has the same panel.

**Which setups belong to the catalog** (`catalogProvider`, `api-provider-guidance.ts`). A new
optional field beside `preferProviderTab`, read through `catalogProviderOfSetup`. A second field
because the first-run dialog words `preferProviderTab` as "the dedicated … tab" and can only name
a provider it has a button for; that dialog never reads the new field and behaves as before. The
endpoint dialog asks the catalog it is given (`catalogEntryOfSetup`): native providers arrive over
IPC after the first render, and until the catalog has the provider there is no entry to send
anyone to — the setup is an ordinary one again, and is listed. The hint names the provider as the
tab does ("Kimi (Moonshot)"), from the catalog entry.

Why these two and not the other three: for Gemini and Kimi Coding the setup's address is the
catalog provider's own, in the provider's own protocol — an endpoint made from the setup _is_ the
provider. GLM's setup is the Anthropic route of a host whose catalog provider speaks OpenAI on
another path, and MiniMax's address is one no catalog provider serves from. DeepSeek is the close
call: the same service and protocol, an address that differs by `/v1`. It stays a setup for now
and is the first to look at again.

**The rule for a pi uplift.** The setups list is older than the catalog, and the catalog is built
from the installed pi, so the comparison above goes out of date with every pi version.
`tests/provider-setups-vs-catalog.test.ts` is the comparison as a test. It reads the **installed**
pi's provider data — the one test that does so on purpose; the rest of the suite stands in for
it — builds the native entries by the app's own rule, and fails when the catalog providers found
on a setup's host are not the ones written down in it. Beside that table is a second one with the
decision taken for each setup and its reason. A failure after an uplift means "decide again", not
"broken". Its blind spot is stated where the rule is: it sees a provider that serves from a
setup's host, not a service pi starts to list under another address.

**Checked again in the running app**, the same way as the mechanical half above (settings backed
up, restored, checksum equal; nothing saved this time): the list shows four setups, folds away
after "Apply" with the filled address in view and focus on its heading; Google's address and
Kimi's coding address each bring the hint with a button to that provider's own dialog, by the
names the tab uses; DeepSeek's address brings the ordinary hints and no button; after a check, and
after a search for Ollama, focus is still on the button that was pressed, and the next Tab goes to
the next control.

One thing the manual pass itself left behind and the settings backup does not cover: the app's
language is kept in the window's own storage, not in `config.json`. It had been switched to
Hungarian for the pass and was put back to Russian.

| File                                        | Tests | Covers                                                                                                     |
| ------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `tests/provider-setups-vs-catalog.test.ts`  | 5     | **new** — the setups against the installed pi's catalog; a decision for every setup                        |
| `tests/api-settings-dialogs-render.test.ts` | 53    | +12 — Gemini and Kimi addresses, the catalog not loaded yet, the list after "Apply", buttons that are busy |
| `tests/credential-dialog-view.test.ts`      | 26    | +4 — which catalog entry a setup belongs to, with and without the catalog                                  |

**Gates:** typecheck clean; `npm test` **3930 passed / 250 files**; lint 0 errors, the same 16
pre-existing warnings. **25 more mutations** of these rules, each against the whole suite — two of
them standing in for a pi that drops a provider — were all caught.

**External review, third run: approved, no remarks** (212,510 characters, from the same scratch
clone; three runs of the cap of five in all). The context argument listed what had changed since
the approved diff and why, and the facts outside it — that the panel is shared with the Model Sets
tab, that a second diagnostics call is harmless, and when native catalog entries arrive.

### Phase 5 — first-run wizard

`ConfigModal.tsx` per §6.5.

Built in two steps: **A** — the wizard itself; **B** — the removal of what only the old dialog
used, as a change of its own so that neither review is about the other.

#### Step A as built (2026-10-07) — the wizard

##### Decisions taken with the user before starting

| #   | Question                                                        | Decision                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The notice's button when another config set can start a chat    | **It opens Settings → Model Sets.** The wizard is for "nothing is set up" only, so it has no config-set switcher.                                                                                                |
| 2   | When is the config set written? §6.5 has step 1 update it.      | **Continue saves the credential only; Start saves the config set** — provider, endpoint and model in one call. A wizard closed between the two leaves a saved key and an untouched config set.                   |
| 3   | What opens the wizard?                                          | **What opened the old dialog**: the notice's button, nothing else. It does not open by itself on a first start, and the welcome screen's link still opens Providers (Phase 4 step 1's decision 4).               |
| 4   | What does the first step choose from?                           | **The list the chooser on a config set has** — every custom endpoint by name, then the catalog — **plus one entry that adds an endpoint.** `ProviderPicker` is therefore not used after all, and goes in step B. |
| 5   | The single-request test (`config.test`)                         | **Not used.** The first step has the dialogs' five-step check, which names the model it tries. The whole `config.test` chain goes in step B.                                                                     |
| 6   | The old state layer (`useApiConfigState` and what is behind it) | **Removed in this phase**, in step B.                                                                                                                                                                            |

##### What the pre-implementation read found

1. **The "first-run dialog" does not open on a first run.** Nothing opens it but the button of a
   notice (`App.tsx`, `open_api_settings`) that main raises when a session is started while the
   active config set has no usable credential (`handleClientEvent`, `main/index.ts`). `useIPC`
   deliberately never opens it (`tests/use-ipc-config-modal-gate.test.ts`), and the welcome
   screen's "not configured" link goes to Settings. Left as it is (decision 3).
2. **The dialog had two modes, and "first run" was only one.** `isFirstRun` was `!isConfigured`,
   and `isConfigured` is "some config set has a usable credential" (`ConfigStore.isConfigured`).
   The notice is about the _active_ set. With another set usable the dialog opened as "API
   Settings": a second copy of the old single screen, set switcher included — the job the Model
   Sets tab has had since Phase 4. Hence decision 1.
3. **It offered six providers**, as buttons. None of the providers that only the installed pi
   knows could be set up from it.
4. **It was not a dialog in the sense the Settings dialogs are**: no Escape, no focus kept inside,
   no `role`, Enter saved nothing, its close button had no name.
5. **`config.test` is reachable from nowhere else**, and `probeWithClaudeSdk`, which it calls, is
   also what the diagnostics run uses for its last step — always with a model. So removing the
   chain (step B) leaves `buildProbeConfig`'s fallback to the active set's model with no caller.

Three more turned up only while building, because the wizard is the first place a **searchable
list sits inside the dialog frame**, which is a form:

6. **Escape with a list open closed the whole dialog.** The frame listens for the key before
   anything inside it and stops it there; the list, which closes itself on Escape, never heard it.
   The frame now leaves the key alone while something inside it is expanded (`hasOpenPopup`).
7. **Enter in a list's search box with nothing matching submitted the form.** The list's key
   handler returned before it reached Enter when there was nothing to pick, and the browser then
   took the key for "submit". Enter there is now always the list's own.
8. **A list would be cut off in the second step.** The frame's body scrolls, a list opens
   downwards inside it, and under the model field there is next to nothing — so the list would
   have nowhere to show. Worked out from the layout, not seen: both steps were given one minimum
   height with room for an open list, and the second step has the field first, before the app
   was started. The manual pass then measured it: enough, by 41 px.

##### As built

| File                                                                    | Role                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/first-run-wizard-view.ts`                                        | **new**, pure. The entries of the first step's list, which one it opens on, what an entry stands for, the model the second step starts on, whether a key is missing.                    |
| `hooks/useFirstRunWizard.ts`                                            | **new**. The step, the choice, and the two saves of the first step.                                                                                                                     |
| `components/FirstRunWizard.tsx`                                         | **new**. The frame, the body (list + the step on screen) and the two buttons.                                                                                                           |
| `components/FirstRunWizardSteps.tsx`                                    | **new**. The three things under the frame: a provider's credential, an endpoint's, the model.                                                                                           |
| `components/ConfigModal.tsx`                                            | **rewritten**, 498 → 22 lines. Mounts the wizard only while it is open.                                                                                                                 |
| `App.tsx`                                                               | The notice's button chooses between the wizard and Settings → Model Sets; Settings is not drawn under the wizard; `handleConfigSave` is gone — the app no longer saves a config itself. |
| `hooks/credential-dialog-view.ts`, `settings/SettingsProviders.tsx`     | `providerDialogValues`: what a provider's dialog opens on, moved out of the tab so the tab and the wizard share one rule. The tab is 331 lines (was 357).                               |
| `components/CustomEndpointDialog.tsx`, `CustomEndpointFields.tsx`       | One optional input, `catalogProviderAt`: the hint towards a catalog provider is worded for a tab or for the list above the fields.                                                      |
| `settings/ModelFieldsSection.tsx`                                       | The model field is a component of its own (`ModelPickerField`); the section draws it. The Model Sets tab is unchanged on screen.                                                        |
| `hooks/api-settings-view.ts`, `components/ProviderChoicePicker.tsx`     | A fourth kind of chooser entry, `new-endpoint`, which only the wizard lists.                                                                                                            |
| `settings/SettingsDialogFrame.tsx`, `components/SearchableCombobox.tsx` | Findings 6 and 7.                                                                                                                                                                       |
| `i18n/locales/{en,zh,ru,hu}.json`                                       | Seven texts under `api.firstRun`, nine lines per file and nothing else changed.                                                                                                         |

**The first step is the inside of a Settings dialog, not a form of its own.** Each Phase 4 dialog
was already a state function plus a component that draws from it, apart from the frame. The wizard
calls the same two — `useProviderConfigDialog` with `ProviderCredentialFields`,
`useCustomEndpointDialog` with `CustomEndpointFields` — so the key field, the address, the
connection check with the model it names, the search for a local Ollama, the ready-made setups
that fold away, the hints, the "used by" and the dropped-key notices are the ones Settings has.
What the wizard adds is what a save leads to. A dialog's state function calls its `onClose` after
a save that worked; the wizard passes "go to the second step" there.

**The second step is the Model Sets tab's own field.** `useModelSetForm` over the same shared
state, and `ModelPickerField`: the searchable list for a catalog provider, the models a local
Ollama reports, a typed model for an endpoint. Start is that form's Save. Token limits and the
thinking level are not asked for and stay as stored.

**Two saves, each through the call the tabs make.** The wizard holds a copy of the state the two
tabs share (`useApiSettingsState`) and builds no payload of its own:

- _Continue_ → `setProviderCredential`, or `createCustomEndpoint` / `updateCustomEndpoint`. What
  comes back refreshes the credential store and keeps the unsaved edits to the config set
  (Phase 4's `rebase`). The active set is then moved to what was saved **in unsaved state only**
  (`CHANGE_PROVIDER`) — unless it is already there, in which case its model is left alone.
- _Start_ → `config.save` with the set's own fields, no credential.

`buildCombinedSavePayload` — the one payload that carried both halves, and the reason
`App.tsx` had a save handler — has no caller left.

**Which model the second step starts on.** For a catalog provider, what a config set moved to it
on the Model Sets tab starts on: the first of its preset list, or nothing for Ollama and for a
provider that has only the catalog's list. For an endpoint, its Default model; failing that, the
example model of the well-known service its address belongs to (§6.5); failing that, nothing, and
the model is typed. The per-provider model memory of the config-set half means going back and
forth between the steps loses nothing.

**Continue asks for a key where one is needed.** The Settings dialogs save a credential without
one — it may be on its way. The wizard exists to end on a setup that can start a chat, so it keeps
the old dialog's rule: no key, no next step, unless the provider needs none or the endpoint is on
this computer. The refusal is the save's own result, so it shows next to the fields like any
other, and main is not asked.

**Who tells the frame what a submit means.** The frame is one for both steps, so that it is not
taken down and put up again when the step or the choice changes; the fields belong to whichever
step is on screen. That step puts its submit into a ref of the wizard's while it renders — the
way these files already keep a "latest value" (`applyLoadedRef`, the frame's `onCloseRef`). The
wizard clears the ref on every pass, so with no step on screen a submit reaches nothing.

**The two buttons.** The right-hand one is the frame's submit button in both steps, so Enter in a
field is Continue or Start. While its own save is out it is busy, not `disabled` (Phase 4 step
2's decision 5): refused, it is the button the user is still on. The second step's is a different
element from the first's, and when the second step arrives focus is put on the step as a whole —
from there Tab reaches the field, and a second Enter starts nothing. And because both steps have
their buttons in the same two places, the second half of a double click is ignored: a double
click on Continue would otherwise land on Start and save a model the user was never shown, and
one on Back would land on Cancel.

**One copy of the settings state at a time.** The wizard's copy is its own — it is opened from
outside Settings. So Settings is not drawn while the wizard is open (`settingsOnScreen`,
`App.tsx`), whatever asks for it meanwhile: the application menu has a shortcut that does, and a
panel drawn then would hold a copy the wizard's later saves never reach. It is drawn when the
wizard has closed, from what main then holds. Everything that follows "Settings is open" — the
collapsed sidebar, the hidden context panel — follows that same value, so a request for Settings
moves nothing under the wizard either. The wizard asks main for the config afresh each
time it opens, as the tabs do, rather than taking the app store's: handed that, it would reload —
and drop the unsaved move of the config set — the moment its own first save changed the store.

##### Behaviour that changed

- **The first-run dialog is two steps**, and both are saved separately: a key, then a model.
- **Any provider can be set up from it**, not six; an existing custom endpoint is chosen by name.
- **A key can be tried before Continue**, with the check the Settings dialogs have.
- **Escape closes it, Tab stays inside it, Enter goes on**, and focus returns to where it was.
- **With another config set usable, the notice's button opens Settings → Model Sets** instead of
  a second copy of the settings screen.
- **Closing after the first step keeps the key** and leaves the config set as it was.
- **Enter in the search box of a list never submits a form**, and **Escape closes an open list
  before the dialog around it** — in every dialog drawn in the frame.

##### Tests

| File                                       | Tests | Covers                                                                                                                                                                        |
| ------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/first-run-wizard-view.test.ts`      | 26    | **new** — the list, what it opens on, what an entry stands for, where a set points, the start model, the key rule                                                             |
| `tests/first-run-wizard-render.test.ts`    | 62    | **new** — first render of both steps for a range of configs; what Continue and Start send; the two buttons; what opens the wizard                                             |
| `tests/credential-dialog-view.test.ts`     | 33    | +7 — what a provider's dialog opens on                                                                                                                                        |
| `tests/settings-dialog-save.test.ts`       | 17    | +4 — Escape with a list open                                                                                                                                                  |
| `tests/api-settings-i18n.test.ts`          | 13    | +1 — three more source files scanned; the wizard's texts in all four languages, same placeholders, none unused                                                                |
| `tests/config-modal-claude-layout.test.ts` | —     | **deleted** (2): it read the old dialog's markup                                                                                                                              |
| 3 existing files                           | —     | four tests that read the old dialog's or the tab's source text now read where the rule is: `api-settings-tabs-render`, `config-ipc-mutation-contract`, `provider-guidance-ui` |

**Gates:** typecheck clean; `npm test` **4028 passed / 251 files** (3930 / 250 before); lint 0
errors, 15 warnings — the 16 from before less the one on the removed `handleConfigSave`.

**Verification beyond "tests pass":** 97 mutations of the new rules, one at a time, each against
the whole suite. 96 were caught at once. One survived and was informative: with the Back button
wired to close the wizard, nothing failed — no test can press a button, and none read which of
the two left-hand buttons does what. A test now does, for Cancel as well; both mutations fail.

**Not reachable by a test:** anything that needs a key press, a click or an effect — where focus
lands when a step or the choice changes, Enter and Escape themselves, the second half of a double
click, whether an open list has room, and the config the wizard asks main for when it opens.
These are the manual pass. So is one line the suite cannot tell from its absence: the wizard
clears the step's submit on every pass, which only shows over two passes, and a first render is
one.

**External review: approved on the first run, and again on the second with nothing left.**
Reviewed as one piece (159,780 characters, then 162,502) from a scratch clone, so the real index
was never staged. Two runs of the cap of five.

| Run | Result                                                |
| --- | ----------------------------------------------------- |
| 1   | **approved** — 1 medium, 1 low                        |
| 2   | **approved** — no remarks; "no code changes required" |

Each remark of run 1 was checked against the code before anything was changed:

- **Not real — "Back stays enabled while Start is saving".** The remark took the busy mark for
  something that arrives a render late. From the press of Start to the request to main nothing is
  awaited, and the config-set half marks itself as saving before its first `await`
  (`saveSet`, `useModelSets.ts` — outside the lines the reviewer was shown). React draws a state
  change made in a click, a key press or a form submit before the next one is delivered, so Back
  and the frame's close are off by the time anything else can be pressed. No guard was added for
  a moment that does not exist — and one would not have stopped the save, which main has by then
  been asked for. A test now reads the four stretches of source between the press and the mark
  and fails if an `await` appears in any of them.
- **Followed up, with a different fix — "the context panel now shows behind the wizard".** The
  suggested fix was to go back to hiding it whenever Settings is asked for; with the wizard open
  that would make the menu shortcut hide a panel that is on screen — the movement the remark was
  about. What did move was something it did not name: the sidebar, which collapsed whenever
  Settings was asked for, drawn or not. That was real. The request for Settings is now read in one
  place, where "Settings is on screen" is worked out, and the panel, the context panel and the
  sidebar all follow that.

The facts about code outside the changed lines went into the script's context argument on both
runs — what step B removes and why it is still in the tree, the six decisions, what the reused
state functions guarantee — and on the second also what had been done with each remark and why.

**Gates after the review:** typecheck clean; `npm test` **4028 passed / 251 files**; lint 0
errors, the same 15 warnings. Four more mutations, of the review fixes, are among the 97 above.

**Noticed and left alone:**

- **Everything step B removes is still in the tree and used by no screen**: `useApiConfigState`,
  `useProviderCredentials`, most of `provider-credentials-state.ts`, `buildCombinedSavePayload`,
  the `config.test` chain, `ProviderPicker`, the table layout of the setups card, and the texts
  only the old dialog showed. `tests/api-config-state-render.test.ts` still has a test named for
  "the interface the first-run dialog is written against"; the dialog no longer uses it.
- **A fresh install is still led to Settings first.** The welcome screen's link opens Providers
  and the wizard is reached only through the notice (decision 3) — so the screen that teaches
  "a key, then a model" is seen by someone who tried to send a message first.
- **The notice still says "API Settings"** (`api.configRequiredActiveSet`,
  `api.openSettingsAction`), the name of a screen that has been two tabs since Phase 4. It reads
  correctly for both places its button now leads to, and was left.
- **A provider that has only the catalog's model list starts the second step with nothing
  picked**, as a config set moved to it on the Model Sets tab does. The connection check's rule
  falls back to the first model the provider lists; the model field's does not.
- `providerDialogValues` carries one condition over verbatim that today's data never exercises:
  a native provider has no preset, so "no key hint for a native provider" holds with or without
  it.
- `SettingsDialogFrame` stays in `components/settings/`, though the wizard is drawn in it from
  outside Settings.
- `README.md` and `AI_FRONTEND.md` still list the old files, and `CHANGELOG.md` has no entry for
  the wizard yet: Phase 6, with step B's removals.

**Not read by anyone who knows the language:** the seven new Chinese texts.

**Manual pass (2026-10-07).** In two parts, because the wizard shows only when nothing at all is
set up — and the user's settings have config sets on gateways on this computer, which are usable
without a key.

_Part 1, the wizard, on an empty data folder._ The user's whole data folder was renamed aside and
an empty one put in its place, holding only the `.brand` marker: without that the app would have
adopted the older `open-cowork` folder next to it, old settings file and keys included
(`migrate-legacy-data.ts`). An empty settings file inside the real folder was not an option — it
would have started the memory system on its defaults over the user's real memory store. Every key
typed was made up, and no request went anywhere but to a port nothing listens on. Afterwards the
real folder was put back and compared with a fingerprint taken before: the same 2372 files, the
same bytes, the settings file's checksum equal.

Clicks and key presses were the browser's own input, sent through the debugging port; an event
recorder put into the page showed what each press had hit. Seen working, with no error from the
page or in the log:

- **It opens from the notice's button** when nothing is set up: 43 ms on the first opening of a
  freshly started app, 4 ms afterwards. Focus is in the key field.
- **The list**: 36 entries on a fresh install — "Add endpoint", then the whole catalog — open
  inside the dialog and not cut off. **Escape with the list open closes the list and leaves the
  wizard**, with focus in the list's search box and with focus on its button alike. **Enter in
  the search box with nothing matching does nothing** — no step, no save.
- **Choosing another entry** by keyboard or by a click puts the new fields on screen with focus in
  their first field. "Add endpoint" brings the endpoint's five fields and the setups list;
  "Apply" fills protocol, address and model, folds the list away and puts focus on its heading.
- **The hint towards a catalog provider** in its wording for a list, and its button moves the
  list to that provider with focus in the key field. In the Providers tab's dialog the same
  address still gets the tab's wording.
- **Continue without a key**: "API key is required" next to the fields, focus still on Continue,
  nothing sent. **With a key, by Enter in the field**: one `setProviderCredential` in the log —
  the provider's id only — and the second step, with focus on the step as a whole.
- **A double click on Continue** saved the credential once and stopped on the second step: the
  second press reached Start — it took focus — and started nothing. **A double click on Back**
  stopped on the first step.
- **The second step**: the model field, the provider's name, the line about the config set. Its
  list of 386 models opens whole, with 41 px to spare, and the body does not scroll — the room
  finding 8 reserved is enough. Escape with it open closes the list only. Back returns to the
  first step with the saved key in its field.
- **Settings asked for from outside with the wizard open** (the request the menu shortcut makes,
  sent through the navigation server): not drawn, the sidebar where it was. It appeared, with the
  sidebar collapsed, when the wizard closed.
- **A connection check** from the first step against an address nothing listens on: five steps
  drawn, a translated failure at the connection step, the model named beforehand, focus still on
  the button, nothing saved.
- **The two saves, in the log.** For an endpoint, Continue is `Creating custom endpoint` and
  leaves the config set on the provider it had (main re-applied that provider's environment).
  Start, by Enter in the model field, is one `Saving config` with the active set's id, `custom`,
  the endpoint's id, the model, the two limits and the thinking fields — no credential. The
  wizard closed and the app reported itself configured.
- **With another config set usable and the active one not**, the notice's button opened
  Settings → Model Sets, which showed its "no key" warning; no wizard.
- **An endpoint that exists** is in the list by name with its protocol, and choosing it shows its
  stored fields without the setups list.

One thing measured differently from what was written beforehand: the dialog is not the same
height in both steps — 590 px for a provider's key, 565 px for the model. The minimum height
keeps the second step from shrinking to a strip; it does not make the two equal. The comment that
said otherwise was corrected after the review and is the only text of step A not reviewed.

_Part 2, what earlier passes left open, on the user's real settings_ — backed up first, restored
afterwards with the checksum equal, the app's language put back to Russian. No connection check
was run and no credential saved.

- **A second start on a settings file that is already converted.** The first start converted the
  1.0.8 file again, 12,305 → 5,841 bytes. The file's checksum then changed on the next start with
  the size the same: the store is encrypted and written at every start, so the bytes differ each
  time. Compared by content instead — a fingerprint of the config as the app reads it, taken
  after the second start and after a third: identical, timestamps of every config set and
  endpoint included. A start on a converted file changes nothing.
- **The picker in the chat header**: six config sets as `name · model`, 220 px wide.
- **Deleting a config set**: a set created for the purpose, the confirmation naming it, then six
  sets again with the earlier one active and "deleted" said.
- **Eight of the ten Hungarian texts inside the two dialogs** were put on screen and captured:
  the dropped-key notice on a row and in its dialog, the check's heading and what it says
  beforehand with a model and without one, the search hint in Ollama's dialog, the hint and its
  button in the endpoint dialog. The other two are what the check says after it has passed, and
  no check that could pass was run.

**Not exercised:** the search for Ollama with one running (none was); Enter while a character is
being composed; the menu shortcut itself (its request was sent another way). **Not read by anyone
who knows the language:** the seven new Chinese texts. The Russian and Hungarian texts of the
wizard, and the Hungarian ones of the dialogs, were captured as pictures for the user to read.

**Noticed in the pass**, none of it the wizard's doing:

- **The notice that leads to the wizard is on screen for six seconds** (`GlobalNoticeToast`).
  Its button is the only way in.
- **A hint under a typed model is in English in every language** — "Use the exact model ID for
  the selected protocol or endpoint" comes from `getModelInputGuidance` untranslated. It has
  been on the Model Sets tab; the wizard's second step now shows it too.
- **On a first run the key field's dialog says "Used by: Default"**, which is true and reads
  oddly before anything has been set up.
- **The delete button of a config set has no name** — an icon alone — and pressing it, or
  confirming, leaves focus on nothing: the case step 2 of Phase 4 fixed in the dialogs, in a
  component neither phase touched.
- **A fresh profile logs an error from the skills watcher** — a loop of symbolic links under
  `claude/skills/knowledge-search`.
- **After `location.reload()` through the debugging port, input sent through it no longer
  reaches the page.** It looked for a while like a wizard that would not open; the recorder
  showed that no press had arrived at all. A tooling fact, not the app's.

#### Step B as built (2026-10-07) — the removal

Nothing on screen changes in this step. It deletes what only the old first-run dialog used, and
what the deletion left without a reader.

##### Decisions taken with the user before starting

The plan was the one listed in the brief for this step; the pre-implementation read found four
points where it and the code disagreed enough to ask.

| #   | Question                                                                                                                        | Decision                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `api.testError.missing_base_url` was on the list of texts to keep, and its only reader is the single-request test that goes.    | **It goes too.** The dialogs say the same thing with `api.providers.errors.baseUrlRequired`.                                   |
| 2   | Five helpers of `api-config-shared.ts` lose their last reader in the app; the plan had their tests re-pointed, not removed.     | **Removed, with their ten tests.** `isProfileKey`, `resolveProviderProtocol` and the three `isCustom…LoopbackGateway`.         |
| 3   | `AI_MAIN_PROCESS.md` §1 names the field `preferProviderTab`, which this step merges away; rule documents were left for Phase 6. | **Corrected in this step**: a rule file must not describe a field that does not exist.                                         |
| 4   | The pictures of the wizard's Russian and Hungarian texts from step A's manual pass                                              | **Read by the user, no remarks.** The seven Chinese texts of `api.firstRun` are still unread by anyone who knows the language. |

##### What the pre-implementation read found

1. **The two hints that spoke of "the dedicated … tab" could not be reached.** The provider list
   in the window starts as the built-in entries (`useApiConfigSource.ts`), which already hold
   OpenRouter and Ollama, and for an address whose provider the list has, the endpoint dialog
   blanks the protocol hint and the failure hint and shows "this is the provider X" instead. So
   removing them changes nothing on screen.
2. **`preferProviderTab` and `catalogProvider` were read through one function**,
   `catalogProviderOfSetup`, which took either. Merging the fields changes nothing it returns;
   the table of decisions in `tests/provider-setups-vs-catalog.test.ts` was not edited and passes.
3. **The hint kind `emptyProbePreferProvider` had to go, not move.** Read from `catalogProvider`
   it would fire for the Kimi and Gemini setups as well. On a pi that lacks those providers the
   address is an ordinary endpoint and the dialog shows the failure hint — which, with the kind's
   text removed, would have been nothing in place of "…returned an empty response, try protocol
   X". A recognised service now always gets the hint that names its protocol.
4. **`tests/api-config-state.test.ts` read the credential half directly** in five tests, through
   the state that is deleted. They read the same thing through `persistedCredentialFor` now.
5. **One more test of `api-config-draft-independence.test.ts` had nothing left to test**: "keeps a
   typed key across a config-set save". A key is typed only in a dialog that has its own Save, and
   no config set can be saved while one is open, so there is no unsaved key for a save to discard.
6. **The diff is larger than estimated**: 210,046 characters against the 110–140 thousand of the
   plan. The eight deleted files are 93 thousand; the rest is the tests re-expressed and the
   lines of context around each removal.

##### As built

| File                                                                                                              | What changed                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/useApiConfigState.ts`, `hooks/useProviderCredentials.ts`, `hooks/provider-credentials-state.ts`            | **deleted** — the old state layer, 1,421 lines. With it go `buildCombinedSavePayload` and every unsaved-credential rule: the tabs and the wizard have none.                                                                                             |
| `components/ProviderPicker.tsx`                                                                                   | **deleted.** The table of group names two files took from it (`CATEGORY_LABEL_KEY`) is in `ProviderChoicePicker.tsx`.                                                                                                                                   |
| `main/config/config-test-routing.ts`, `main/index.ts`, `preload/index.ts`                                         | **The `config.test` channel is gone**: the routing file, the handler, the preload method and its type.                                                                                                                                                  |
| `main/claude/claude-sdk-one-shot.ts`                                                                              | `buildProbeConfig`: a model that is not given is refused as `missing_model`, like an empty one, instead of being replaced by the active config set's.                                                                                                   |
| `hooks/api-settings-view.ts`                                                                                      | `providerCredentialFor`, **moved** from the deleted state: how a catalog provider's credential reads — the stored key, the stored address or the provider's usual one, Ollama's address in its `/v1` form. `persistedCredentialFor` uses it, as before. |
| `hooks/useApiConnectivity.ts`, `useModelSetForm.ts`, `useCredentialCheck.ts`                                      | The single-request test is gone — `handleTest`, its two pieces of state, and the `hasUnsavedChanges` option only it read. 465 → 384 lines.                                                                                                              |
| `components/ProviderGuidance.tsx`, `CustomEndpointFields.tsx`                                                     | The setups card has one layout, the list. The six-column table and the `layout` switch are gone. 224 → 148 lines.                                                                                                                                       |
| `hooks/useCustomEndpointGuidance.ts`, `components/CustomEndpointDialog.tsx`, `FirstRunWizardSteps.tsx`            | The two "tab" hints are gone, and with them the `presets` input that only they used — of the guidance and of the endpoint dialog.                                                                                                                       |
| `shared/api-provider-guidance.ts`, `hooks/credential-dialog-view.ts`                                              | `preferProviderTab` is merged into `catalogProvider`; OpenRouter and Ollama carry the latter. The hint kind `emptyProbePreferProvider` is removed (finding 3).                                                                                          |
| `hooks/api-config-shared.ts`                                                                                      | Six helpers with no reader left: the five of decision 2 and `providerTabLabel`.                                                                                                                                                                         |
| `i18n/locales/{en,zh,ru,hu}.json`                                                                                 | **24 texts removed from all four files alike**: the 23 of the plan and `api.testError.missing_base_url`. Each was confirmed to have no reader; none is built at run time.                                                                               |
| `AI_MAIN_PROCESS.md` §1, and comments in `config-store.ts`, `provider-ids.ts`, `model-sets-state.ts`, three tests | Sentences that named a removed file or field.                                                                                                                                                                                                           |

`SettingsProviders.tsx` is 330 lines (331 before): one input fewer.

##### Behaviour that changed

- **None on screen.**
- **The probe no longer borrows a model.** Asked without one, `probeWithClaudeSdk` answers
  `missing_model`. Its one caller, the last step of the connection check, skips itself when it has
  no model and otherwise always names it, so nothing reaches the new branch today; the fallback
  existed for `config.test`.
- **`window.electronAPI.config.test` does not exist.** Nothing called it.
- **An empty answer from a service the catalog lists is worded like any other recognised
  service's** — reachable only where the installed pi lacks that provider.

##### Tests

| File                                                  | Tests   | What happened                                                                                                                                                                        |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/api-config-provider-credentials-state.test.ts` | —       | **deleted** (43): 39 went with the unsaved-credential state, 4 moved                                                                                                                 |
| `tests/api-config-state-render.test.ts`               | —       | **deleted** (9): first render of the old state layer                                                                                                                                 |
| `tests/config-test-routing.test.ts`                   | —       | **deleted** (6)                                                                                                                                                                      |
| `tests/api-settings-view.test.ts`                     | 41 → 46 | +4 moved — how a catalog provider's credential reads; +1 new — the protocol it reads                                                                                                 |
| `tests/api-config-state.test.ts`                      | 48 → 38 | −10 with the helpers of decision 2; five re-pointed (finding 4); imports now from where the helpers are                                                                              |
| `tests/api-config-draft-independence.test.ts`         | 11 → 8  | The guarantee stays, on the real store, with the payloads the tabs and the wizard build. −3 of the combined payload, −1 of finding 5, +1: an endpoint created and saved moves no set |
| `tests/config-ipc-mutation-contract.test.ts`          | 30 → 25 | The eight about the old form's save go; three say the same of the tabs' — each credential call made once, in the shared state; no `config.save` there; a credential call rebases     |
| `tests/api-settings-dialogs-render.test.ts`           | 53 → 54 | −1 the table layout; +2 the card by itself                                                                                                                                           |
| `tests/provider-guidance.test.ts`                     | 7 → 8   | +1: finding 3                                                                                                                                                                        |
| `tests/claude-sdk-one-shot.test.ts`                   | 19 → 20 | +1: no model given                                                                                                                                                                   |
| `tests/api-settings-tabs-render.test.ts`              | 23 → 24 | +1: each group of providers under its own heading                                                                                                                                    |
| 5 more                                                | —       | wording, or an import re-pointed                                                                                                                                                     |

**Gates:** typecheck clean; **3961 passed / 248 files** (4028 / 251 before, 67 fewer); lint 0
errors, the same 15 warnings.

**Verification beyond "tests pass":** 22 deliberate breakages of the rules that moved or changed,
one at a time, each against the whole suite. 17 were caught at once. Four survived and each
showed a rule with no test; each has one now, and all four breakages fail:

- **the protocol a catalog provider's credential reads.** Every reader works the protocol out from
  the provider and ignores this field, so a wrong value changed nothing. Pinned, so the two can
  never disagree;
- **the card draws nothing when it has no setup to offer**, and
- **the card passes `disabled` on to its buttons** — both rewritten in this step, neither read by
  a test before;
- **which heading each group of providers gets.** The table moved files, and nothing looked at a
  heading on the Providers tab.

One survives and cannot be caught: `normalizeOllamaBaseUrl(raw) || presetBaseUrl` against
`|| ''`. Normalisation yields nothing only for an empty address, and the address is empty only
when the provider's usual one is empty too — the two are the same code. Carried over verbatim.

**External review: approved on the first run, with no remarks.** Reviewed as one piece (210,046
characters) from a scratch clone, so the real index was never staged. One run of the cap of five.
The facts about code outside the changed lines went into the script's context argument: that no
screen imported the deleted files, who still calls the probe and with what, why the two "tab"
hints could not be reached, why the hint kind is removed rather than moved, and what is
deliberately left as it is.

**Noticed and left alone:**

- **`api.testError.ollama_loading` is in all four language files and read by nothing** — not by
  the old dialog either. It is the only text left beside `missing_key` under `api.testError`.
- **The store still accepts a key and an address through `config.save`** (`ConfigStore.update`).
  No call from the window sends them any more: the five that are left save a proxy, the memory
  settings (two), a skills path and a config set's own fields. The path and its tests stay.
- **The probe still borrows a key.** `resolveProbeApiKey` takes the active config set's key when
  none is given — the same shape as the model fallback this step removed. The window always sends
  the key, so it cannot be reached; it was not in the plan.
- **Four helpers are called from tests only**, as they were before this step:
  `getFeaturedEntries`, `getNonFeaturedEntries`, `shouldAutoDiscoverLocalOllamaBaseUrl`,
  `testOllamaConnection`.
- **`src/tests/settings/provider-picker.test.ts` keeps its name** though the component is gone.
  Two of its blocks ("formShape display flag derivation", "activeIsNonFeatured derivation")
  re-state a rule of the old form inside the test and call no app code.
- `ProviderGuidanceHintCode` has two values nothing returns (`prefer_provider_tab`,
  `protocol_mismatch`).
- The names `ApiTestInput`, `ApiTestResult` and the option `testDetails` still say "test" for
  what is now only the last step of the connection check.
- §§6, 9.2 and 12 of this document still describe `useApiConfigState.ts` and `ProviderPicker`;
  `README.md` and `AI_FRONTEND.md` list the old files; `CHANGELOG.md` has no entry for the wizard.
  All Phase 6.

**Not read by anyone who knows the language:** the seven Chinese texts of `api.firstRun`
(step A). This step adds no text in any language.

**Check in the running app (2026-10-07).** Through the debugging port, on an empty data folder
set up as in part 1 of step A's pass: the user's whole data folder renamed aside, an empty one
with only the `.brand` marker in its place, and the real one put back afterwards — the same 2483
files, the same bytes, the checksums of the settings file and of the connector settings equal.
Every key typed was made up, and the one that was saved was taken out again before a message
could be sent with it; the only requests went to a port nothing listens on. The page was not
reloaded. The app ran in Russian.

Seen working, with no error from the page, and none in the log but the known one from the skills
watcher:

- **Start**: the welcome screen saying "not configured". `window.electronAPI.config` has no
  `test`.
- **The Providers tab**: 35 providers under their four headings — Popular, Coding plans, Fast
  inference, Local — and no heading for "Custom". **The Model Sets tab**: the default set on
  OpenRouter, with its "no key" warning.
- **The endpoint dialog** on the Providers tab: the setups as a list, no table, folded at first.
  Four are listed — the ones whose service the catalog does not list itself. "Apply" fills
  protocol, address and model, folds the list and puts focus on its heading. A connection check
  against the dead port: five steps drawn, a translated failure at the connection step, the model
  named beforehand, focus still on the button, nothing saved. Escape closes the dialog and focus
  is back on "Add endpoint".
- **The wizard**, from the notice's button: in the page 4 ms after the press arrives, focus in the
  key field, Settings not drawn under it. 36 entries in its list, under the same headings; Escape
  with the list open closes the list only. Continue without a key: "API key is required", focus
  on Continue, nothing sent. With a made-up key and Enter in the field: one
  `Saving provider credential`, then the second step with focus on the step as a whole. Back
  returns to the first step with the key in its field.
- **The wizard for a new endpoint**: "Add endpoint" brings the endpoint's fields, focus in the
  first, and the same list of four setups, which applies and folds as in the dialog. The check
  against the dead port fails at the connection step and saves nothing. Continue, by Enter in the
  address field: `Creating custom endpoint`, the config set still on the provider it had, the app
  still "not configured". The second step holds the endpoint's default model. Start: one
  `Saving config` — the set's id, `custom`, the endpoint's id, the model, the two limits and the
  thinking fields, no credential — the wizard closes and the app reports itself configured.
- **Afterwards, in Settings**: the Model Sets tab shows the set on the endpoint with no warning,
  and the tab's own connection check runs and fails at the connection step; the endpoint's row
  says which set uses it; a provider's dialog opens with focus in the key field, and Escape puts
  focus back on the row's button.

One thing looked like a fault and was not. The wizard appeared five seconds after its press was
sent. A recorder in the page showed the press itself arriving five seconds late and the dialog
4 ms after it, and calls to main were answered in 5 to 8 ms throughout. The app's window was not
on screen (`document.visibilityState` was `hidden`), and a mouse _move_ sent through the
debugging port to such a window is held for five seconds — with no message sent and no key
pressed before it as well. A press is not held. A tooling fact, not the app's.

**Noticed in the check**, not this step's doing: when the wizard closes, focus is left on the
page itself — the notice's button it was opened from is gone by then.

**Not exercised**, as after step A: the search for Ollama with one running; Enter while a
character is being composed; the menu shortcut for Settings itself with the wizard open; the two
Hungarian texts the connection check shows after it has passed. Nothing was looked at in a
language other than Russian.

### Phase 6 — docs

This document moves to `archive/` with an as-built section; a `§4.1 superseded` banner on
[`model-reasoning-override.md`](../model-reasoning-override.md) (decision #12, §10.5);
`docs/wiki/features/models-and-api.md` and `docs/wiki/reference/settings.md` rewritten; four locale
files (`src/renderer/i18n/locales/{en,zh,ru,hu}.json`) — **all four**, per the recorded i18n lesson;
`CHANGELOG.md`.

#### As built (2026-10-07)

Documents only. In code, four comments that name this document's path.

| Document                                             | What changed                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| this document                                        | Moved to `docs/design/archive/`. Its 77 relative links re-based; status and reading note at the top; §14 added. The path in `config-store.ts` and in three test files follows.                                                       |
| `docs/design/model-reasoning-override.md`            | The "§4.1 superseded" note (decision #12, §10.5): where `reasoning` belongs now, and the two things to check again.                                                                                                                  |
| `docs/wiki/features/models-and-api.md`               | Rewritten for the two tabs and the wizard, by the wiki's own rules: every step read out of the code, button names from `en.json`, a new flow diagram, the settings table on the present data model, a second screenshot stub.        |
| `docs/wiki/reference/settings.md`                    | "API" became "Providers" and "Model Sets". `isConfigured` is described as worked out, not stored. `localDevPath` moved to Skills, where its field is; `claudeCodePath` to the internal list — it has no control in Settings.         |
| `docs/wiki/getting-started.md`, `docs/wiki/index.md` | Not on the phase's list: the setup steps named the "API" tab, and the front page's diagram said "11 tabs" where there are 12.                                                                                                        |
| `docs/wiki/.last-update.json`                        | The sources of the Models & API page. Its commit and date are left as they were (2026-07-22): the rest of the wiki has not been compared with the code since, and a newer commit there would make the next update skip that stretch. |
| `README.md`, `AI_FRONTEND.md`, `ARCHITECTURE.md`     | File trees; README's "Configure" steps and its line that put the proxy under "Settings → API" (it is under General); the storage diagram, which said "API keys/profiles" and listed model presets, which are not stored.             |
| `CHANGELOG.md`                                       | Two entries under Unreleased, for the wizard. Step B has none: nothing on screen changed.                                                                                                                                            |

**One statement was dropped rather than carried over.** The old wiki page said that scheduling
and remote control "let you pick a config set per task". Remote control names no config set
anywhere, and a scheduled task records one that is not applied when it runs (§10.1). The
scheduling page still says a task uses its own config set; that is §10.1's ticket.

**Gates:** typecheck clean and the suite unchanged — the four code changes are comments. No
deliberate breakages (no rule is new) and no external review (the script leaves `.md` files out;
it would have been shown four comment lines), both agreed with the user beforehand.

**For a human to add**, as the wiki's rules ask to be listed: two screenshots of the Models & API
page (`models-and-api-providers.png`, `models-and-api-settings.png`) and the one of the setup
steps (`getting-started-configure-api.png`). None of the three exists yet.

---

## 8. Test plan

### 8.1 New assertions

| Test                  | Asserts                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projection precedence | a set with `provider:'custom'` + `endpointId` resolves protocol/baseUrl/key from the endpoint; a catalog set resolves from `providerCredentials`   |
| Missing credential    | a set pointing at an unconfigured provider yields `apiKey: ''` — never a key borrowed from another provider                                        |
| Migration round-trip  | a legacy config (profiles on sets, flat `apiKey`/`baseUrl`/`model` at top level) loads into the new shape with the same effective projection       |
| Migration idempotence | normalizing twice mints no second endpoint entry and overwrites nothing                                                                            |
| First-non-empty-wins  | two sets holding different keys for one provider resolve deterministically, documented as a lossy case                                             |
| Set-id stability      | migration preserves every `configSets[].id` and `activeConfigSetId`, including `default`                                                           |
| Endpoint delete guard | `deleteCustomEndpoint` refuses while a set references it, in the store (not just the UI)                                                           |
| Endpoint cap          | `MAX_CUSTOM_ENDPOINT_COUNT` is enforced and its error is distinguishable from the config-set cap (decision #11)                                    |
| Ollama slot           | keyless base-URL slot survives; `Discover` writes to the global slot                                                                               |
| Native slots          | `native:<id>` credentials round-trip and are not dropped by the `PROFILE_KEYS` iteration (the bug the native catalog work already had to fix once) |
| Draft independence    | a dirty credential and a dirty model produce independent save paths and neither discards the other                                                 |

### 8.2 Existing tests that must be migrated (decision: migrate, not retire)

**The original draft of this section was wrong.** It claimed coverage was thin — "only
`config-store-migration.test.ts` and `provider-picker.test.ts` touch it" — because it searched only
`src/tests/`. There is a **second test root at `tests/`** (192 files), included by
[`vitest.config.mts:18`](../../../vitest.config.mts#L18). Eleven files there assert the exact shape
this design removes, and they pass today:

| File                                             | Tests   | Coupling                                                    |
| ------------------------------------------------ | ------- | ----------------------------------------------------------- |
| `tests/api-config-state.test.ts`                 | 48      | `UIProviderProfile`, snapshot/signature/bootstrap helpers   |
| `tests/config-store-thinking-level.test.ts`      | 15      | per-profile thinking level + clamp                          |
| `tests/api-config-state-thinking-level.test.ts`  | 14      | renderer thinking level over profiles                       |
| `tests/chat-view-config-set-restore.test.ts`     | 14      | `set.profiles[set.activeProfileKey].model` matching         |
| `tests/config-store-profiles.test.ts`            | 13      | **the `native:zai` regression** — §8.1's "Native slots" row |
| `tests/api-diagnostics.test.ts`                  | 10      | `DiagnosticInput` shape (should survive — see §1.3)         |
| `tests/config-store-config-sets.test.ts`         | 8       | set CRUD, clone, cap                                        |
| `tests/api-config-state-config-sets.test.ts`     | 6       | set switching + pending-switch dialog                       |
| `tests/config-test-routing.test.ts`              | 6       | provider → protocol routing                                 |
| `tests/config-store-performance.test.ts`         | 3       | `getAll()` / normalize cost                                 |
| `tests/welcome-view-config-set-selector.test.ts` | 9       | set labels                                                  |
|                                                  | **146** |                                                             |

Consequence for §7: Phase 1 breaks these by construction, so "ends with `npm test` clean" is only
achievable once Phase 2's migration pass lands. They are also an **asset** — several are precisely
the regression tests §8.1 asks for, most importantly `config-store-profiles.test.ts:50`, which
exists to pin the `native:*` credential-dropping bug.

Four more files match on keywords but are **not** coupled and need no change:
`tests/mcp-workspace-profile.test.ts` and `tests/workspace-orphan-detector.test.ts` ("profile" in an
unrelated sense), `tests/compaction-budget.test.ts` (a `contextWindow` string-coercion case), and
`tests/scheduled-task-v2-ui-helpers.test.ts` (reads `configSets` as an opaque id list). Three
fixture-only users set `profiles: {}` / `configSets: []` on an `AppConfig` literal and will need the
new fields added: `src/tests/claude/claude-sdk-one-shot.test.ts`,
`tests/claude-sdk-one-shot.test.ts`, `src/tests/memory/memory-llm-client.test.ts`.

---

## 9. Risks

### 9.1 Security posture is unchanged — verify, don't assume

Credentials stay in the encrypted `electron-store`
([`createEncryptedStoreWithKeyRotation`](../../../src/main/utils/store-encryption.ts#L148)); only their
scope moves. Explicitly **not** in scope, and to be asserted in review:

- No credential is written to `localStorage`, the Zustand store, or any renderer-persisted state.
- No new IPC channel returns a credential the renderer could not already read.
- The renderer-facing diagnostics payload must keep receiving an explicit key only because it
  already does today (`api-diagnostics.ts:532`).

### 9.2 `useApiConfigState.ts` is the real work

2511 lines, built around a `UIProviderProfile` that fuses key, base URL and model. The split is
mechanical but wide; the risk is behavioural drift in the dirty-tracking and pending-switch logic
(§6.4), not in the types. Mitigated by Phase 2 landing first with real tests.

### 9.3 The lossy case must be visible

Decision #2 means a user who today has two Anthropic keys in two config sets ends up with one. The
migration is silent by design (no modal on boot), so the UI owes them a way to notice: the
Providers tab should flag any provider whose credential came from more than one set. Cheapest
honest version: record the losing value's origin during normalization and surface a one-line
notice on that provider row.

**Recorded since Phase 3** as `AppConfig.credentialConflicts` — ids only, never a key. It had to
land with the migration rather than with the UI: once per-set `profiles` leave the file, the
disagreement can no longer be detected. Showing it is Phase 4.

### 9.4 Two sources of truth during the transition

> **Closed in Phase 3.** `profiles` no longer exists on any type or in the persisted file, so there
> is nothing left to disagree with `providerCredentials`. The text below is the history.

`profiles` on a set and `providerCredentials` on `AppConfig` must never both be **authoritative**.

As of Phase 2a: `providerCredentials` / `customEndpoints` are authoritative — `resolveCredentials`
reads them and `update()` writes them. `profiles` is demoted to two narrow jobs, both read-only as
far as credentials go: a migration source for slots the global map does not yet hold, and a mirror on
the projection that the renderer still reads. **No write path puts a credential into a config set.**

The one remaining seam is that `handleSave` still _sends_ `profiles`, which Phase 2a forwards into
the global map via `applyProfilesToCredentials` rather than discarding (dropping it would lose a key
the user just typed in the current UI). Phase 2b removes the field from both types and deletes that
bridge, at which point the invariant holds structurally rather than by convention.

### 9.5 Test-coverage thresholds

`vitest.config.mts` enforces global v8 thresholds (lines 30 / functions 35 / branches 28 /
statements 30, [`:35-40`](../../../vitest.config.mts#L35)). **`src/renderer/` is excluded**
([`:27`](../../../vitest.config.mts#L27)), so only Phases 1–2 can move the numbers — and they move them
upward, since `config-store.ts` is already covered by the §8.2 suite. The real risk is the reverse
of what the first draft assumed: deleting coupled tests without replacing them would _drop_
coverage. Hence decision #1 (migrate, don't retire).

---

## 10. Out of scope (recorded, not silently dropped)

1. **The scheduler's ignored config set.** `isConfigSetValid()` is called before every run
   ([`scheduled-task-manager.ts:570`](../../../src/main/schedule/scheduled-task-manager.ts#L570),
   [`:895`](../../../src/main/schedule/scheduled-task-manager.ts#L895)) and wired at
   [`index.ts:1220`](../../../src/main/index.ts#L1220), but `executeTask`
   ([`index.ts:1176-1202`](../../../src/main/index.ts#L1176)) never applies `task.configSetId` — a
   scheduled task runs on whatever set is globally active. Verified 2026-10-03. It is a pre-existing
   bug. This design makes it _more_ visible (a task pinned to "Work" would run on whatever key the
   active set holds), but it is not required to ship the split and is not in any phase. Worth its
   own ticket.
2. **pi's credential indirection.** `apiKey` in pi's `models.json` accepts `$NAME` / `${NAME}`
   interpolation, a literal, or a leading `!command`, and `auth.json` accepts the `!` form too
   (pi `docs/models.md:63`, `docs/providers.md:72`). The app cannot use any of it today: credentials
   reach pi as a resolved string via `setRuntimeApiKey`
   ([`agent-runner.ts:2605`](../../../src/main/claude/agent-runner.ts#L2605)), not through
   `models.json`. A per-provider `credentialMode` is a natural follow-up once the global map exists
   — not in this plan (decision #9).
3. **OAuth / `/login`.** pi stores OAuth tokens in `auth.json` (pi `docs/providers.md:12`).
   The app deliberately does not adopt the CLI credential store — the SDK-only boundary in
   `ARCHITECTURE.md` §4.1 rules it out — so a GUI login flow is its own project.
4. **Multiple keys per provider.** Explicitly rejected in session (decision #2).
5. **The `reasoning` override.** [`model-reasoning-override.md`](../model-reasoning-override.md) is
   an independent not-started design whose §4.1 adds `reasoning?: boolean` to `ProviderProfile` —
   the interface this design deletes. Per decision #12 it gets a superseded banner in Phase 6 and no
   code. When it is picked up, `reasoning` belongs on `ApiConfigSet` beside `contextWindow` /
   `maxTokens` (its own §4.1 argues the scoping from that precedent, so the rationale carries over),
   and two of its claims need re-verification: "Migration: none" rests on `normalizeProfile`
   preserving optional fields — with the boolean guard being `typeof === 'boolean'`, **not** the
   truthiness check the numeric fields use, so a stored `false` survives — and its pi-ai
   `openai-completions.js` line cites were taken against 0.80.10, not the current 0.87.1.

   For context on what is **already** built, so the remaining gap is not overstated:
   `pi-model-resolution.ts` has three reasoning tiers — registry lookup (`resolvePiRegistryModel`,
   [`:607`](../../../src/main/claude/pi-model-resolution.ts#L607)), a wide registry sweep that borrows
   `reasoning` from any provider knowing that model id (`findRegistryReasoningTraits`,
   [`:515`](../../../src/main/claude/pi-model-resolution.ts#L515), from `a5b628d2`), and a filename
   regex ([`:67`](../../../src/main/claude/pi-model-resolution.ts#L67)) — with levels delegated
   entirely to pi's `getSupportedThinkingLevels`
   ([`:683`](../../../src/main/claude/pi-model-resolution.ts#L683)). The gap is only that
   `ThinkingCapabilities` ([`:624`](../../../src/main/claude/pi-model-resolution.ts#L624)) carries one
   boolean, so "pi knows it doesn't reason" and "pi has never seen it" both render as the factual
   claim at [`SettingsAPI.tsx:534`](../../../src/renderer/components/settings/SettingsAPI.tsx#L534) /
   `en.json:403`.

## 11. Open questions — resolved 2026-10-03

All three became decisions #9–#11 in §2; recorded here with the evidence that settled them.

1. ~~Credential-source dropdown?~~ **No** (#9). The app resolves credentials to a string before pi
   sees them (§10.2), so the control would have no backing resolver. The catalog's per-entry
   `keyEnvVar` hint already names the env var honestly without promising resolution.
2. ~~Optional default model on endpoints?~~ **Yes** (#10). `custom` is in
   `BUILTIN_NO_REGISTRY_MODELS` ([`provider-catalog-native.ts:238`](../../../src/main/config/provider-catalog-native.ts#L238))
   so it ships `modelOptions: []`, and unlike `ollama` it has no Discover fallback — wizard step 2
   would be an empty picker for exactly the gateway users most likely to hit it.
3. ~~Reuse `MAX_CONFIG_SET_COUNT`?~~ **No, separate `MAX_CUSTOM_ENDPOINT_COUNT = 20`** (#11). The
   renderer recovers the cap by parsing the thrown message
   ([`useApiConfigState.ts:677`](../../../src/renderer/hooks/useApiConfigState.ts#L677)
   — `/^Config set limit reached: max\s+(\d+)$/`), so one shared constant across two entity types
   would make that parse ambiguous. `MAX_CONFIG_SET_COUNT` is at
   [`config-store.ts:405`](../../../src/main/config/config-store.ts#L405) (not `:318`).

---

## 12. File map

**Main process**

- `src/main/config/config-store.ts` — types, defaults, normalization, migration, resolution,
  projection, endpoint CRUD
- `src/shared/provider-ids.ts` — endpoint-id helpers (slot derivation unchanged)
- `src/shared/provider-catalog.ts` — unchanged; the form-shape and category machinery is reused
- `src/shared/api-provider-guidance.ts` — unchanged; its setups seed the custom-endpoint dialog
- `src/main/index.ts` — IPC handlers; also the site of the out-of-scope scheduler fix
- `src/main/nav-server.ts:22` — `tab=api` → new tab ids
- `src/preload/index.ts` — preload surface + `ElectronAPI` type

**Renderer**

- `src/renderer/types/index.ts` — mirrored types
- `src/renderer/hooks/useApiConfigState.ts` — split into two slices (Phase 3)
- `src/renderer/components/SettingsPanel.tsx` — tab ids, entries, render switch
- `src/renderer/components/settings/SettingsProviders.tsx` — **new**
- `src/renderer/components/settings/SettingsModelSets.tsx` — **new**
- `src/renderer/components/ProviderConfigDialog.tsx` — **new** (extracted form)
- `src/renderer/components/settings/SettingsAPI.tsx` — retired
- `src/renderer/components/ApiConfigSetManager.tsx` — unchanged, relocated
- `src/renderer/components/ConfigModal.tsx` — two-step wizard
- `src/renderer/components/ChatView.tsx` — tab id + labels, and `:405`'s `.profiles` read
- `src/renderer/components/WelcomeView.tsx`, `store/index.ts` — tab id + labels
- `src/renderer/i18n/locales/{en,zh,ru,hu}.json` — all four

**Tests / docs**

- `src/tests/config/` — new: projection, migration, endpoint guard + cap, set-id stability (§8.1)
- `tests/` — migrate the 11 coupled files, 146 tests (§8.2); add new fields to 3 `AppConfig`
  fixtures
- `docs/design/model-reasoning-override.md` — §4.1 superseded banner (decision #12)
- `docs/wiki/features/models-and-api.md`, `docs/wiki/reference/settings.md`, `CHANGELOG.md`

---

## 13. Phase 0 record — what the first draft got wrong

> The line numbers in the right-hand column below are the **values as of Phase 0** and are kept as a
> historical record. Phase 1 added ~320 lines to `config-store.ts`, so they have moved again; the
> live references in §§1–12 were updated to post-Phase-1 values and are the ones to trust.

The design was written against pi 0.85.1 / app 1.0.7; HEAD is **0.87.1 / 1.0.8** (`90136401`).
Everything structural held up — the per-set credential map, the three consequences in §1.2, the
two-function seam in §4, the narrow renderer blast radius, the SQLite set-id constraint, and pi's
one-credential-per-provider position. Corrected here:

| Claim                                                   | Reality                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Coverage is thin — two files touch it"                 | **16 files**, 11 genuinely coupled, **146 tests**, in a `tests/` root the draft never searched (§8.2)                                                                                                                                                                                         |
| `src/main/agent/agent-runner.ts`                        | `src/main/claude/agent-runner.ts`                                                                                                                                                                                                                                                             |
| `CATEGORY_ORDER` constant                               | No such constant — it is the function `categoryOrder()` (`provider-catalog.ts:449`)                                                                                                                                                                                                           |
| `StatusDotColor` defined at `SettingsAPI.tsx:145`       | Exported from `SearchableCombobox`; that line is a consumer                                                                                                                                                                                                                                   |
| Line numbers throughout                                 | Drifted — `projectFromConfigSet` 1247→1254, `composeProjectedConfig` 1611→1619, `update()` 1875→1883, `buildBlankConfigSet` 1673→1681, `cloneConfigSet` 1598→1606, `hasAnyUsableCredentials` 2234→2246, `DIRECT_READ_KEYS` 320→326, `MAX_CONFIG_SET_COUNT` 318→324, `defaultProfiles` 343→349 |
| §9.5 "new files land in a thin area"                    | Inverted — the area is well covered; the risk is _losing_ coverage by retiring tests                                                                                                                                                                                                          |
| Silent conflict with `model-reasoning-override.md` §4.1 | Now recorded as §10.5 + decision #12                                                                                                                                                                                                                                                          |

Also established, and not in the original draft: `npm test` and the app need **different**
`better-sqlite3` ABIs, which is the first thing to check when a phase gate appears to fail (§7).

---

## 14. As built — summary (2026-10-07)

§7 holds the full record of every phase. This is the short form: what exists now, where it
differs from §§1–12, and what was left open.

### 14.1 What shipped

| Phase    | Commit     | In app       | What                                                                                                 |
| -------- | ---------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| 1        | `b2c4d56b` | 1.0.9        | `providerCredentials` and `customEndpoints` in the store, derived one way from the config sets       |
| 2a       | `330989ec` | 1.0.9        | The credential store becomes the source: `resolveCredentials`, `endpointId` on a set, endpoint calls |
| 2b       | `60d5277c` | 1.0.9        | Nothing writes a credential into a config set any more                                               |
| 3        | `c381f8c3` | 1.0.9        | Per-set credential fields removed; old settings files converted once; the form state split in two    |
| 4 step 1 | `b853c811` | 1.0.9        | The Providers and Model Sets tabs, the endpoint list, the chooser on a config set                    |
| 4 step 2 | `553c5da7` | 1.0.9        | The dialogs' connection check, ready-made setups and hints; the dropped-key notice; `set · model`    |
| 5 step A | `994043f3` | not released | The first-run dialog as a two-step wizard                                                            |
| 5 step B | `91e55d9b` | not released | Removal of the old state layer, `config.test`, `ProviderPicker` and the setups table                 |
| 6        | —          | not released | Documents                                                                                            |

### 14.2 The shape as built

**Stored** (`AppConfig`, `config-store.ts`):

- `providerCredentials` — one slot per provider: its key and, where it has one, its address.
- `customEndpoints` — up to 20, each with an id, a name, a protocol, an address, a key and an
  optional default model.
- `configSets` — up to 20, each with a provider, an `endpointId` when the provider is `custom`,
  a model, the two limits and a thinking level. No credential.
- `credentialConflicts` — ids only, never a key: which providers and endpoints had a different
  key in some config set that the conversion did not keep.
- The flat `provider` / `apiKey` / `baseUrl` / `model` fields are worked out from the active set
  and its credential each time. They are never a second store.

**Calls from the window:** `config.save` for a config set's own fields;
`config.setProviderCredential`, `config.createCustomEndpoint`, `config.updateCustomEndpoint` and
`config.deleteCustomEndpoint` for credentials; `config.diagnose` for the connection check.
`config.test` no longer exists.

**The window** — this replaces §12's file map for `src/renderer/`:

| Files                                                                                          | Role                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/useApiSettingsState.ts`                                                                 | The state both tabs and the wizard share: the credential store as main last returned it, and the four credential calls. No unsaved credential. |
| `hooks/useModelSets.ts`, `model-sets-state.ts`, `useModelSetForm.ts`                           | Config sets, and the unsaved edits to the open one                                                                                             |
| `hooks/api-settings-view.ts`, `credential-dialog-view.ts`, `first-run-wizard-view.ts`          | The rules, as plain functions with tests                                                                                                       |
| `hooks/useApiConnectivity.ts`, `useCredentialCheck.ts`, `useCustomEndpointGuidance.ts`         | The connection check, the search for Ollama, the hints for an address being typed                                                              |
| `components/settings/SettingsProviders.tsx`, `SettingsModelSets.tsx`, `ModelFieldsSection.tsx` | The two tabs                                                                                                                                   |
| `components/ProviderConfigDialog.tsx`, `CustomEndpointDialog.tsx` and their `…Fields.tsx`      | The two credential dialogs: a state function and the fields it draws, which the wizard reuses                                                  |
| `components/ProviderChoicePicker.tsx`                                                          | The chooser on a config set, and the first step of the wizard                                                                                  |
| `components/FirstRunWizard.tsx`, `FirstRunWizardSteps.tsx`, `ConfigModal.tsx`                  | The wizard                                                                                                                                     |

### 14.3 Where the build departed from §§1–12

| The design said                                                              | What was built                                                                                                                                            | Recorded in                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| §3.3–3.4: the data model                                                     | As designed, plus `AppConfig.endpointId?` and `credentialConflicts`                                                                                       | Phase 3                             |
| §6.1: custom endpoints last on the Providers tab                             | First, above some thirty catalog providers                                                                                                                | Phase 4 step 1, decision 3          |
| §6.2: "Configure provider…" is the old form, with its provider picker        | One dialog per credential with fields of its own and no picker in it. Its check is the five-step diagnostics run, with the model it tries named on screen | Phase 4 step 1; step 2, decision 1  |
| §6.3: the provider of a set as a read-only chip with "Change"                | A chooser: custom endpoints by name, then the catalog. A set can be saved while its provider has no key, with a warning                                   | Phase 4 step 1, decisions 1 and 5   |
| §6.4: the Providers tab tracks unsaved credentials and has its own Save      | No unsaved credential state exists. Each credential is saved from its own dialog                                                                          | Phase 4 step 1; Phase 5 step B      |
| §6.5: step 1 of the wizard writes the credential and updates the default set | Continue saves the credential only; Start saves the config set. A wizard closed in between leaves a key and an untouched set                              | Phase 5 step A, decision 2          |
| §6.5: the wizard is what an unconfigured app shows                           | Only the notice's button opens it, and only when nothing at all is set up. With another set usable the button opens Settings → Model Sets                 | Phase 5 step A, decisions 1 and 3   |
| §6.5: a provider picker and "Test connection"                                | The chooser's list plus "Add endpoint"; the dialogs' connection check                                                                                     | Phase 5 step A, decisions 4 and 5   |
| §9.2: `useApiConfigState.ts` is split into two slices                        | Split in Phase 3 and kept as a thin layer for the old screens; deleted in Phase 5 step B with the credential slice                                        | Phases 3 and 5                      |
| §9.3: the lossy case must be visible                                         | A notice on the row and in the dialog of each credential that lost a key, naming the config sets; saving that credential again clears it                  | Phase 3, decision 6; Phase 4 step 2 |
| §12: the file map                                                            | 14.2 above                                                                                                                                                | —                                   |

Built without being in the design:

- **Ready-made setups and the catalog.** A setup whose service the catalog lists itself sends its
  address to that provider (`catalogProvider`), and `tests/provider-setups-vs-catalog.test.ts`
  compares the setups with the installed pi's catalog, so the list is decided again at every pi
  uplift (Phase 4 step 2, "After the manual pass"; `AI_MAIN_PROCESS.md` §1).
- **A model remembered per provider** while a config set is being edited, until it is saved or
  closed (Phase 3, decision 4).
- **Dialog behaviour**: a button that runs something stays focusable while it runs; the setups
  list folds away after "Apply"; Escape closes an open list before the dialog around it; Enter in a
  list's search box never submits a form (Phases 4 and 5).
- **Error texts from main are translated at all**: Electron's own prefix is stripped first
  (Phase 4 step 1, finding 1).
- **The probe refuses a missing model** instead of borrowing the active set's (Phase 5 step B).

### 14.4 Left open

One list, gathered from the "Noticed and left alone" and "Noticed in the pass" paragraphs of §7.
None of it belongs to this design's work; each line is a candidate for a ticket of its own.

**Behaviour**

- **Scheduled tasks do not apply their own config set** (§10.1). The wiki's scheduling page says
  they do.
- A fresh install is led to Settings first, and the wizard is reached only through a notice that
  stays on screen for six seconds. The notice still says "API Settings".
- A provider that has only the catalog's model list starts the wizard's second step with nothing
  picked.
- On a first run the key dialog says "Used by: Default".
- When the wizard closes, focus is left on the page itself. The delete button of a config set has
  no name, and pressing it drops focus.
- The settings file is written again at every start. A fresh profile logs an error from the
  skills watcher.
- Two hints repeat each other after "Apply", and a config set named after its model reads twice
  in a picker — both left by decision.
- The handler behind the Ollama search returns an empty list when the search itself throws.
- The probe still borrows the active config set's key when it is given none, and the store still
  accepts a key through `config.save`. The window sends neither.
- The DeepSeek setup is the first to look at again at the next pi uplift.

**Texts**

- `zh.json` lacks 60 keys the English file has. The Chinese texts written in Phases 4 and 5 are
  unread by anyone who knows the language.
- `settings.prompt`, `settings.promptDesc` and `api.diagnostic.skipped` are in none of the four
  language files; `api.testError.ollama_loading` is in all four and read by nothing.
- The hint under a typed model is in English in every language.
- The older Russian hints use the untranslated "endpoint" where the newer texts say «подключение».

**Code**

- `SettingsProviders.tsx` is 330 lines, over the 300-line soft limit.
- Four helpers are called from tests only: `getFeaturedEntries`, `getNonFeaturedEntries`,
  `shouldAutoDiscoverLocalOllamaBaseUrl`, `testOllamaConnection`.
  `src/tests/settings/provider-picker.test.ts` keeps the name of a component that is gone, and two
  of its blocks re-state a rule of the old form without calling app code.
- `ProviderGuidanceHintCode` has two values nothing returns. `ApiTestInput`, `ApiTestResult` and
  the option `testDetails` still say "test" for what is now the last step of the connection check.
- `SettingsDialogFrame` lives in `components/settings/` though the wizard is drawn in it from
  outside Settings.

**Never checked in the running app**

- The search for Ollama with one running; Enter while a character is being composed; the menu
  shortcut for Settings with the wizard open; the two Hungarian texts the connection check shows
  after it has passed.
