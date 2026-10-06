# Provider Credentials & Model Sets — Design & Implementation Plan

**Created:** 2026-10-02
**Status:** Design approved. **Phases 0, 1, 2a, 2b, 3 complete** (Phase 3: 2026-10-05). Phase 4
next. Each phase stops for review.
**Author:** AI-assisted design session
**Baseline:** pi-ai / pi-coding-agent **0.87.1**, app **1.0.8** (HEAD `90136401`). Verified against
source 2026-10-03; §13 records what the original 0.85.1/1.0.7 draft got wrong.
**Provenance:** user-initiated redesign of Settings → API Settings. Replaces the single flat
provider form with two concerns: _which providers exist and how they authenticate_ (machine-level,
configured once) and _which model a config set uses_ (per-chat, chosen often).
**Security classification:** **Medium.** Changes _where_ credentials live in the config schema, not
_how_ they are protected — the encrypted `electron-store` boundary is unchanged (§9.1).

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
`native:<piProvider>` ([`config-store.ts:106`](../../src/main/config/config-store.ts#L106),
[`provider-ids.ts`](../../src/shared/provider-ids.ts)). One slot per provider — the store is
**already keyed by provider**; what is wrong is that the map is nested inside each config set
instead of being global.

Three consequences, each verified in source:

1. **A new set starts with an empty key.** `buildBlankConfigSet()`
   ([`config-store.ts:2036`](../../src/main/config/config-store.ts#L2036)) calls
   `cloneProfiles(undefined)`, which falls back to `defaultProfiles` — every one of which has
   `apiKey: ''` ([`config-store.ts:438-479`](../../src/main/config/config-store.ts#L438)). Creating
   a second config set means pasting the same secret again.
2. **Cloning multiplies the secret.** `cloneConfigSet()`
   ([`config-store.ts:1952`](../../src/main/config/config-store.ts#L1952)) deep-copies the entire
   profile map, so one key exists in N sets and must be rotated in N places.
3. **The form does not match the question being asked.** "Which model do I want for this chat?" and
   "what key do I have for Anthropic?" are answered by the same flat form, tracked by one dirty
   signature ([`buildApiConfigDraftSignature`](../../src/renderer/hooks/useApiConfigState.ts#L520))
   and one Save button — so a model tweak can drag a key edit along with it.

### 1.3 What this change must not disturb

- **Runtime consumers read only the flat projection.** `agent-runner.ts:2397` (note: the file is
  `src/main/claude/agent-runner.ts`, **not** `src/main/agent/`), `api-diagnostics.ts:533`,
  `memory-llm-client.ts:106`, `session-manager.ts:704,1087,1098`. None of them knows about config
  sets, and none reads `.profiles` or `activeProfileKey`. If the projection keeps its current
  shape, this design is main-process + renderer only.
- **Config-set ids are referenced from SQLite** — `sessions.config_set_id` and
  `scheduled_tasks.config_set_id` ([`database.ts:75,122`](../../src/main/db/database.ts#L75)),
  plus [`SettingsSchedule.tsx:592`](../../src/renderer/components/settings/SettingsSchedule.tsx#L592),
  [`ChatView.tsx:158`](../../src/renderer/components/ChatView.tsx#L158) and the Welcome screen. Set
  ids must survive migration unchanged.
- **`apiKey`, `baseUrl`, `provider`, `customProtocol`, `activeProfileKey` are `DIRECT_READ_KEYS`**
  ([`config-store.ts:415`](../../src/main/config/config-store.ts#L415)) — read straight from the
  store, bypassing `getAll()` normalization. Any new field must either be added there or kept out
  of hot read paths. **Decision: `providerCredentials` and `customEndpoints` stay out** — neither
  is on a hot read path, and `apiKey`/`baseUrl` already are.
- **Exactly three files outside `config-store.ts` touch `.profiles` / `activeProfileKey`:**
  `useApiConfigState.ts` (78 references), `renderer/types/index.ts` (2, the mirrored types), and
  [`ChatView.tsx:405`](../../src/renderer/components/ChatView.tsx#L405) (1 — the model-matching
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
([`provider-catalog.ts` `BUILTIN_ENTRIES`](../../src/shared/provider-catalog.ts)),
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
([`composeProjectedConfig`](../../src/main/config/config-store.ts#L1611)).

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
[`model-reasoning-override.md`](./model-reasoning-override.md) §4.1, which keeps `contextWindow` /
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

`projectFromConfigSet()` ([`config-store.ts:1592`](../../src/main/config/config-store.ts#L1592))
and `composeProjectedConfig()` ([`:1965`](../../src/main/config/config-store.ts#L1965)) are the only
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
   at [`config-store.ts:2518`](../../src/main/config/config-store.ts#L2518)), not silently borrow a
   key from a different provider.

`ProviderProfileKey` derivation for catalog providers stays exactly as it is
([`provider-ids.ts`](../../src/shared/provider-ids.ts)) — `gemini → 'gemini'` slot but `google`
pi provider, `native:<id>` for the rest — so the slot space is unchanged and only its _owner_
moves from the config set to `AppConfig`.

### 4.1 What stops being written where

`update()` ([`config-store.ts:2238`](../../src/main/config/config-store.ts#L2238)) currently routes
credential writes into the active set via the `mutatesActiveSet` branch
([`:2277`](../../src/main/config/config-store.ts#L2277)) and `PROFILE_KEYS` iteration. After the
change:

- `provider`, `endpointId`, `model`, `contextWindow`, `maxTokens`, `thinkingLevel` → **the active
  set**.
- `apiKey`, `baseUrl` → **`providerCredentials`**, or the referenced `customEndpoints` entry.
- `cloneProfiles`, `normalizeProfile`, `getDefaultProfile` shrink to credential-only duties
  (`:1285`, `:1253`, `:1236`); `model` handling leaves them entirely.

---

## 5. Migration — derive, never invent

The store is **validate-and-coerce, not version-migrated** (the same conclusion as
[`archive/native-provider-catalog.md`](./archive/native-provider-catalog.md) §7). No schema bump,
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

[`COMMON_PROVIDER_SETUPS`](../../src/shared/api-provider-guidance.ts#L45) already carries eight
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

| Location                                                                                                                                        | Change                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [`SettingsPanel.tsx:36,50`](../../src/renderer/components/SettingsPanel.tsx#L36)                                                                | `TabId` union + `SettingsPanelProps.initialTab` |
| [`SettingsPanel.tsx:63`](../../src/renderer/components/SettingsPanel.tsx#L63)                                                                   | `VALID_TABS`                                    |
| [`SettingsPanel.tsx:76`](../../src/renderer/components/SettingsPanel.tsx#L76)                                                                   | default `initialTab`                            |
| [`SettingsPanel.tsx:120`](../../src/renderer/components/SettingsPanel.tsx#L120), [`:294`](../../src/renderer/components/SettingsPanel.tsx#L294) | `tabs` array, render switch                     |
| [`WelcomeView.tsx:707`](../../src/renderer/components/WelcomeView.tsx#L707)                                                                     | `setSettingsTab('api')` → `'providers'`         |
| [`store/index.ts:677`](../../src/renderer/store/index.ts#L677)                                                                                  | `setSettingsTab(tab \|\| 'api')`                |
| [`nav-server.ts:22`](../../src/main/nav-server.ts#L22)                                                                                          | `GET /navigate?page=settings&tab=api`           |

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
  picker (`categoryOrder()` at [`provider-catalog.ts:449`](../../src/shared/provider-catalog.ts#L449)
  and `groupEntriesByCategory` at [`:493`](../../src/shared/provider-catalog.ts#L493) — reuse, do not
  re-derive. Note there is no `CATEGORY_ORDER` constant; the earlier draft named one that does not
  exist). Each row: name, status dot (configured / key missing / not set, matching the picker's
  existing `StatusDotColor` contract — the type is exported from
  [`SearchableCombobox`](../../src/renderer/components/SearchableCombobox.tsx), and
  [`SettingsAPI.tsx:145`](../../src/renderer/components/settings/SettingsAPI.tsx#L145) is a
  consumer, not its definition), and the env-var hint (`ANTHROPIC_API_KEY`) from
  `ProviderCatalogEntry.keyEnvVar` ([`provider-catalog.ts:62`](../../src/shared/provider-catalog.ts#L62)).
- **`Configure provider…` dialog** — the existing form, extracted from
  [`SettingsAPI.tsx`](../../src/renderer/components/settings/SettingsAPI.tsx) largely verbatim:
  [`ProviderPicker`](../../src/renderer/components/ProviderPicker.tsx), API key, protocol selector
  (`custom` only), base URL (`formShape.baseUrl`), model is **removed** (it belongs to a set), and
  the Ollama `Discover` button ([`:337`](../../src/renderer/components/settings/SettingsAPI.tsx#L337)).
  Field visibility keeps coming from `ProviderCatalogEntry.formShape`, never from `provider === '…'`
  comparisons.
- **Diagnostics here.** [`ApiDiagnosticsPanel`](../../src/renderer/components/ApiDiagnosticsPanel.tsx)
  takes an explicit `{ provider, apiKey, baseUrl, customProtocol, model }` input — `DiagnosticInput`
  at [`renderer/types/index.ts:1130`](../../src/renderer/types/index.ts#L1130), consumed at
  [`api-diagnostics.ts:533`](../../src/main/config/api-diagnostics.ts#L533) — so it can test any
  credential without touching the active set. The Model Sets tab keeps a second instance bound to
  the projected runtime, because end-to-end model reachability is a set-level question.
- **Custom endpoints section** — add / rename / edit / delete. Delete is refused while a config set
  references the entry, in both the UI and `config-store`.

### 6.3 Model Sets tab

`ApiConfigSetManager` ([`ApiConfigSetManager.tsx`](../../src/renderer/components/ApiConfigSetManager.tsx))
moves here unchanged in behaviour — switch, save, new, rename, delete, and the unsaved-changes
dialog. Below it:

- **Provider** is now a **read-only summary chip** of the resolved credential source
  (`Anthropic · configured` / `kiro-gateway · anthropic`) with a `Change` action that opens the
  Providers tab. This is the answer to "which provider am I using", which used to require editing
  the key field to see.
- **Model** picker, options from the selected provider's catalog entry
  (`ProviderCatalogEntry.modelOptions`, delivered over IPC by `config.getProviderCatalog`). Note the
  asymmetry that motivates decision #10: `enrichBuiltinEntries`
  ([`provider-catalog-native.ts:248`](../../src/main/config/provider-catalog-native.ts#L248)) fills
  `modelOptions` from the live pi-ai registry for every builtin **except** those in
  `BUILTIN_NO_REGISTRY_MODELS` ([`:238`](../../src/main/config/provider-catalog-native.ts#L238)) —
  `custom` and `ollama`. Ollama recovers via runtime discovery; `custom` has nothing, hence
  `CustomEndpoint.defaultModel`.
- **Thinking level** — unchanged, including the per-model clamping already shipped.
- **Context window / max tokens** — per `formShape.contextWindow`.
- **Diagnostics** on the projected runtime, then **Save**.

### 6.4 Two independent dirty domains

Today one signature ([`buildApiConfigDraftSignature`](../../src/renderer/hooks/useApiConfigState.ts#L520))
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

[`ConfigModal.tsx`](../../src/renderer/components/ConfigModal.tsx) drives
[`useApiConfigState`](../../src/renderer/hooks/useApiConfigState.ts) and is mounted as
`isFirstRun={!isConfigured}` ([`App.tsx:246`](../../src/renderer/App.tsx#L246)). It becomes a
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
that setup's `exampleModel` ([`api-provider-guidance.ts`](../../src/shared/api-provider-guidance.ts)).

### 6.6 Other surfaces

- **Chat / Welcome config-set pickers** ([`ChatView.tsx:158`](../../src/renderer/components/ChatView.tsx#L158),
  [`WelcomeView`](../../src/renderer/components/WelcomeView.tsx)): labels become `set · model`.
  The provider is no longer part of the identity of a set.
- **Session stamping** ([`session-manager.ts:704,1087,1098`](../../src/main/session/session-manager.ts#L704))
  reads `configStore.get('model')` and `get('activeConfigSetId')` — both survive on the projection,
  so no change.
- **Schedule** ([`SettingsSchedule.tsx:592`](../../src/renderer/components/settings/SettingsSchedule.tsx#L592))
  lists set names; unchanged.

---

## 7. Implementation phases

### 7.0 Progress

| Phase                   | Status                 | Landed                                                                |
| ----------------------- | ---------------------- | --------------------------------------------------------------------- |
| 0 — baseline + doc fix  | ✅ **done** 2026-10-03 | ABI unblocked, doc corrected against HEAD, open questions → decisions |
| 1 — main-process model  | ✅ **done** 2026-10-03 | types + one-directional derivation, 40 new tests, external review ✔️  |
| 2a — store inversion    | ✅ **done** 2026-10-03 | resolveCredentials + endpointId + CRUD/IPC, 28 new tests              |
| 2b — write-path cutover | ✅ **done** 2026-10-03 | handleSave drops `profiles`; §9.4 holds structurally                  |
| 3 — renderer state      | ✅ **done** 2026-10-05 | old fields removed end to end; two state slices; 141 new tests        |
| 4 — UI                  | —                      | —                                                                     |
| 5 — first-run wizard    | —                      | —                                                                     |
| 6 — docs                | —                      | —                                                                     |

Every phase ends with `npm run typecheck` and `npm test` clean. Two of the three gates
(`AI_MAIN_PROCESS.md` preamble) must pass; `npm run test:coverage` is the CI gate and its
thresholds live in `vitest.config.mts` (lines 30 / functions 35 / branches 28 / statements 30 —
note `src/renderer/` is excluded from coverage, so Phase 3–5 work does not move these numbers).

**ABI prerequisite.** `npm test` runs under plain Node, so `better-sqlite3` must be built for the
**Node** ABI — `npm rebuild better-sqlite3`, which is exactly what CI does
([`.github/workflows/ci.yml:32`](../../.github/workflows/ci.yml#L32)). `npm run rebuild`
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
([`useApiConfigState.ts:2119-2130`](../../src/renderer/hooks/useApiConfigState.ts#L2119)) sends
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
  ([`useApiConfigState.ts:458-476`](../../src/renderer/hooks/useApiConfigState.ts#L458)) hydrates the
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

**External review: split into three parts, one approved, two not re-checked.** The change is
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
[`migration/bootstrap.ts:22`](../../src/main/migration/bootstrap.ts#L22)), so its first start
converts the installed app's settings file one-way: quit the installed app and back the file up
first. And when it is started from a terminal that an editor spawned, `ELECTRON_RUN_AS_NODE=1` is
inherited and Electron starts as plain Node (`electron.app` is undefined at the first line that uses
it) — start it with `env -u ELECTRON_RUN_AS_NODE npm run dev`.

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

### Phase 5 — first-run wizard

`ConfigModal.tsx` per §6.5.

### Phase 6 — docs

This document moves to `archive/` with an as-built section; a `§4.1 superseded` banner on
[`model-reasoning-override.md`](./model-reasoning-override.md) (decision #12, §10.5);
`docs/wiki/features/models-and-api.md` and `docs/wiki/reference/settings.md` rewritten; four locale
files (`src/renderer/i18n/locales/{en,zh,ru,hu}.json`) — **all four**, per the recorded i18n lesson;
`CHANGELOG.md`.

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
[`vitest.config.mts:18`](../../vitest.config.mts#L18). Eleven files there assert the exact shape
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
([`createEncryptedStoreWithKeyRotation`](../../src/main/utils/store-encryption.ts#L148)); only their
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
statements 30, [`:35-40`](../../vitest.config.mts#L35)). **`src/renderer/` is excluded**
([`:27`](../../vitest.config.mts#L27)), so only Phases 1–2 can move the numbers — and they move them
upward, since `config-store.ts` is already covered by the §8.2 suite. The real risk is the reverse
of what the first draft assumed: deleting coupled tests without replacing them would _drop_
coverage. Hence decision #1 (migrate, don't retire).

---

## 10. Out of scope (recorded, not silently dropped)

1. **The scheduler's ignored config set.** `isConfigSetValid()` is called before every run
   ([`scheduled-task-manager.ts:570`](../../src/main/schedule/scheduled-task-manager.ts#L570),
   [`:895`](../../src/main/schedule/scheduled-task-manager.ts#L895)) and wired at
   [`index.ts:1220`](../../src/main/index.ts#L1220), but `executeTask`
   ([`index.ts:1176-1202`](../../src/main/index.ts#L1176)) never applies `task.configSetId` — a
   scheduled task runs on whatever set is globally active. Verified 2026-10-03. It is a pre-existing
   bug. This design makes it _more_ visible (a task pinned to "Work" would run on whatever key the
   active set holds), but it is not required to ship the split and is not in any phase. Worth its
   own ticket.
2. **pi's credential indirection.** `apiKey` in pi's `models.json` accepts `$NAME` / `${NAME}`
   interpolation, a literal, or a leading `!command`, and `auth.json` accepts the `!` form too
   (pi `docs/models.md:63`, `docs/providers.md:72`). The app cannot use any of it today: credentials
   reach pi as a resolved string via `setRuntimeApiKey`
   ([`agent-runner.ts:2605`](../../src/main/claude/agent-runner.ts#L2605)), not through
   `models.json`. A per-provider `credentialMode` is a natural follow-up once the global map exists
   — not in this plan (decision #9).
3. **OAuth / `/login`.** pi stores OAuth tokens in `auth.json` (pi `docs/providers.md:12`).
   The app deliberately does not adopt the CLI credential store — the SDK-only boundary in
   `ARCHITECTURE.md` §4.1 rules it out — so a GUI login flow is its own project.
4. **Multiple keys per provider.** Explicitly rejected in session (decision #2).
5. **The `reasoning` override.** [`model-reasoning-override.md`](./model-reasoning-override.md) is
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
   [`:607`](../../src/main/claude/pi-model-resolution.ts#L607)), a wide registry sweep that borrows
   `reasoning` from any provider knowing that model id (`findRegistryReasoningTraits`,
   [`:515`](../../src/main/claude/pi-model-resolution.ts#L515), from `a5b628d2`), and a filename
   regex ([`:67`](../../src/main/claude/pi-model-resolution.ts#L67)) — with levels delegated
   entirely to pi's `getSupportedThinkingLevels`
   ([`:683`](../../src/main/claude/pi-model-resolution.ts#L683)). The gap is only that
   `ThinkingCapabilities` ([`:624`](../../src/main/claude/pi-model-resolution.ts#L624)) carries one
   boolean, so "pi knows it doesn't reason" and "pi has never seen it" both render as the factual
   claim at [`SettingsAPI.tsx:534`](../../src/renderer/components/settings/SettingsAPI.tsx#L534) /
   `en.json:403`.

## 11. Open questions — resolved 2026-10-03

All three became decisions #9–#11 in §2; recorded here with the evidence that settled them.

1. ~~Credential-source dropdown?~~ **No** (#9). The app resolves credentials to a string before pi
   sees them (§10.2), so the control would have no backing resolver. The catalog's per-entry
   `keyEnvVar` hint already names the env var honestly without promising resolution.
2. ~~Optional default model on endpoints?~~ **Yes** (#10). `custom` is in
   `BUILTIN_NO_REGISTRY_MODELS` ([`provider-catalog-native.ts:238`](../../src/main/config/provider-catalog-native.ts#L238))
   so it ships `modelOptions: []`, and unlike `ollama` it has no Discover fallback — wizard step 2
   would be an empty picker for exactly the gateway users most likely to hit it.
3. ~~Reuse `MAX_CONFIG_SET_COUNT`?~~ **No, separate `MAX_CUSTOM_ENDPOINT_COUNT = 20`** (#11). The
   renderer recovers the cap by parsing the thrown message
   ([`useApiConfigState.ts:677`](../../src/renderer/hooks/useApiConfigState.ts#L677)
   — `/^Config set limit reached: max\s+(\d+)$/`), so one shared constant across two entity types
   would make that parse ambiguous. `MAX_CONFIG_SET_COUNT` is at
   [`config-store.ts:405`](../../src/main/config/config-store.ts#L405) (not `:318`).

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
