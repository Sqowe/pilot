# Local Embeddings by Default — Implementation Plan

**Status:** ✅ **DONE** — all phases shipped (Phases 1–6). See §13 for the as-built outcomes, decisions, and empirical validation.
**Date:** 2026-07-02
**Updated:** 2026-07-04
**Owner:** @obodnikov
**Related:** [memory-system-architecture.md](memory-system-architecture.md),
[memory-llm-client.ts](../../src/main/memory/memory-llm-client.ts),
[config-store.ts](../../src/main/config/config-store.ts),
[SettingsMemory.tsx](../../src/renderer/components/settings/SettingsMemory.tsx)
**Prior art:** [memory-embedding-inheritance-configuration-and-provider-resolution-2026-05-08.md](../chats/memory-embedding-inheritance-configuration-and-provider-resolution-2026-05-08.md)
**Research inputs:** `~/Downloads/Я-сейчас-использую-модель-BAAIbge-m3-как-embed-2026-07-02.md` (BGE-M3 → e5-small local migration discussion), `~/src/semantic-index-skill/semantic-index/scripts/lib/providers/huggingface.py` (Python `sentence-transformers` prior art — not reusable directly, see §3), live web research (2026-07-02) on `@huggingface/transformers` and EmbeddingGemma-300M.

---

## 1. Goal

Today, Experience Memory's semantic search (`useEmbedding`) is **off by default**, and turning it on requires the user to explicitly configure an embedding provider, model, and API key (OpenAI/OpenRouter/Ollama/custom). This is correct for power users but is a wall for anyone who doesn't know what "embeddings" means — which is most of the target audience for a memory feature that's supposed to "just work."

This plan does two things:

1. Adds a **local, in-process embedding provider** (`provider: 'local'`) that runs a small multilingual ONNX model via `@huggingface/transformers` directly inside the Electron main process — no API key, no network calls per-query, no external cost.
2. Makes it the **default for new installs**: `useEmbedding: true`, `embedding.provider: 'local'` out of the box. Existing installs are explicitly migrated to keep their current behavior untouched (§7) — this is a new-user-experience change, not a silent behavior change for people who already configured memory.

### Non-goals

- Replacing or touching the LLM (`memoryRuntime.llm`) config — this plan is embedding-only.
- Changing the Python `semantic-index` skill (separate project, separate runtime, out of scope).
- Building a generic "bring your own local model" picker in v1. One fixed default model; advanced users can still point `embedding.provider` at any OpenAI-compatible endpoint (including `ollama`) exactly as today.
- Bundling model weights into the installer (locked decision, see §2 D2).

---

## 2. Locked decisions

Confirmed with the user before writing this plan:

| #   | Decision                     | Choice                                                                                                                                                                                                                                                                |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Default model                | **`onnx-community/embeddinggemma-300m-ONNX`** (Google, 300M params, 100+ languages incl. RU/EN/HU, MRL 768→128, quantized `q8` ≈ <200MB RAM). Chosen over `Xenova/multilingual-e5-small` for stronger/newer multilingual training and purpose-built on-device design. |
| D2  | Distribution                 | **Download on first use.** Model is _not_ bundled in the installer. Fetched from the HF Hub on first local-embedding call, cached under the app's own storage root. Installer size stays unchanged for users who never trigger it.                                    |
| D3  | Default state (new installs) | **Local embeddings ON by default.** Fresh installs get `useEmbedding: true`, `embedding.provider: 'local'` with no user action required.                                                                                                                              |
| D4  | Existing installs            | **Untouched.** Migration (§7) freezes current behavior for anyone with a pre-existing config file, using the existing `configSchemaVersion` mechanism. No existing user's embedding provider, cost profile, or network behavior changes without opting in.            |

---

## 3. Why not reuse the Python `sentence-transformers` provider directly

`~/src/semantic-index-skill` already has a working local embedding provider
(`scripts/lib/providers/huggingface.py`) using `sentence-transformers` + `torch`. It cannot be
reused as-is:

| Constraint          | Python skill                                                             | open-cowork                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime             | Python 3.14 venv, invoked as a CLI subprocess                            | Electron **main process**, TypeScript/Node ≥22                                                                                                                                                                                                                                               |
| Embedding call site | `scripts/lib/embedder.py` → subprocess boundary is fine (batch CLI tool) | `MemoryLLMClient.embed()` — in-process, called per chunk during live ingestion; a subprocess-per-call round trip would be slow and fragile to package cross-platform                                                                                                                         |
| Dependency weight   | `sentence-transformers>=3.0.0` + `torch>=2.0.0` — **2-4 GB** install     | Already ships a **small, targeted** bundled Python runtime (`resources/python/{darwin,win32,linux}-*` in `electron-builder.yml`) for GUI-automation helpers (Pillow/pyobjc/Quartz) only. Adding torch there would balloon every platform's installer and bundled-Python maintenance surface. |

The Node/Electron-native equivalent is **`@huggingface/transformers`** (transformers.js v3/v4):
pure JS + ONNX Runtime, no Python, no API key, runs fully in-process. It's the standard pattern
for local embeddings in Electron apps (reference: `Mintplex-Labs/transformersjs-electron`). Its
native dependency, `onnxruntime-node`, ships prebuilt binaries per platform — the same packaging
shape the app already handles for `better-sqlite3` and `@img/sharp` (`npmRebuild: true` +
`asarUnpack` in `electron-builder.yml`).

The Python skill's `references/embedding-models.md` research (model comparison table, RU/HU
language-coverage analysis) directly informed the model choice in D1 and is reproduced in
Appendix A.

---

## 4. Current architecture (as-is)

| Layer          | File                                                                                                                                                                                                                                             | Behavior                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config schema  | [config-store.ts:219](../../src/main/config/config-store.ts#L219)                                                                                                                                                                                | `MemoryModelRuntimeConfig` (`inheritFromActive`, `provider?`, `customProtocol?`, `apiKey?`, `baseUrl?`, `model?`, `timeoutMs`); `MemoryRuntimeConfig.embedding` + `useEmbedding: boolean`.                                                                       |
| Defaults       | [config-store.ts:~367](../../src/main/config/config-store.ts#L367)                                                                                                                                                                               | `embedding: { inheritFromActive: true, model: 'text-embedding-3-small', ... }`, `useEmbedding: false`.                                                                                                                                                           |
| Normalization  | [config-store.ts:538](../../src/main/config/config-store.ts#L538), [:559](../../src/main/config/config-store.ts#L559)                                                                                                                            | `normalizeMemoryModelRuntimeConfig` / `normalizeMemoryRuntimeConfig` — **any field absent in the persisted JSON falls back to `defaultConfig`**. This is the exact mechanism that makes D4's migration necessary (§7).                                           |
| Provider type  | [config-store.ts:58](../../src/main/config/config-store.ts#L58)                                                                                                                                                                                  | `ProviderType = 'openrouter' \| 'anthropic' \| 'custom' \| 'openai' \| 'gemini' \| 'ollama'` — no `'local'` today.                                                                                                                                               |
| Embedding call | [memory-llm-client.ts:220](../../src/main/memory/memory-llm-client.ts#L220)                                                                                                                                                                      | `MemoryLLMClient.embed(text)` — resolves config via `normalizeModelConfig`, checks `isOpenAiCompatible` (openai/openrouter/ollama/custom+openai), else logs a warning and returns `[]`. Constructs an `OpenAI` client and calls `client.embeddings.create(...)`. |
| Call sites     | [memory-service.ts:1101](../../src/main/memory/memory-service.ts#L1101) (`embedText`), used at [:848](../../src/main/memory/memory-service.ts#L848) (chunk ingestion) and [:873](../../src/main/memory/memory-service.ts#L873) (session summary) | Guarded by `appConfig.memoryRuntime?.useEmbedding`.                                                                                                                                                                                                              |
| Settings UI    | [SettingsMemory.tsx:688-737](../../src/renderer/components/settings/SettingsMemory.tsx#L688-L737)                                                                                                                                                | "Embedding Configuration" box: inherit toggle + model/baseUrl/apiKey override fields. No provider selector exists in the UI at all today (confirmed in prior-art chat).                                                                                          |
| Packaging      | [electron-builder.yml](../../src/electron-builder.yml)                                                                                                                                                                                           | `asarUnpack` already covers `.node`/`.dylib`/`.dll`/`.so` for `@img` and `better-sqlite3`; `npmRebuild: true`.                                                                                                                                                   |

---

## 5. Target architecture

```
                         ┌─────────────────────────────┐
                         │ memoryRuntime.embedding      │
                         │ .provider                    │
                         └──────────────┬────────────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │ 'local'            │ openai/openrouter/   │
                    │                    │ ollama/custom+openai │
                    ▼                    ▼
        ┌───────────────────────┐   ┌───────────────────────┐
        │ LocalEmbeddingProvider │   │ OpenAI SDK client      │
        │ (in-process, ONNX)     │   │ (existing, unchanged)  │
        └───────────┬─────────────┘   └───────────────────────┘
                    │
                    ▼
        @huggingface/transformers
        pipeline('feature-extraction',
          'onnx-community/embeddinggemma-300m-ONNX',
          { dtype: 'q8' })
                    │
                    ▼
        Model cache: {storageRoot}/models/
        (downloaded once, ~100-200MB, from HF Hub)
```

`MemoryLLMClient.embed()` gains a branch **before** the existing `isOpenAiCompatible` check: if
`embedConfig.provider === 'local'`, delegate to the new module instead of constructing an
`OpenAI` client. Everything downstream (`memory-service.ts` call sites, scoring, storage) is
untouched — the interface stays `Promise<number[]>`.

---

## 6. File-by-file implementation plan

### 6.1 Dependency

- **`package.json`**: add `"@huggingface/transformers": "^4.x"` (pulls `onnxruntime-node`
  transitively). Node ≥22 is already required (per `CLAUDE.md`), which `@huggingface/transformers`
  v4 supports.

### 6.2 New module — `src/main/memory/local-embedding-provider.ts`

```ts
// Sketch — not final code
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';
const DTYPE = 'q8';
const DIMENSIONS = 768; // EmbeddingGemma native; matches D1

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

export interface LocalEmbeddingProgress {
  status: 'downloading' | 'ready' | 'error';
  file?: string;
  progress?: number; // 0-100
}

export function configureLocalEmbeddingCacheDir(storageRoot: string): void {
  env.cacheDir = path.join(storageRoot, 'models');
}

async function getPipeline(
  onProgress?: (p: LocalEmbeddingProgress) => void
): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = pipeline('feature-extraction', MODEL_ID, {
      dtype: DTYPE,
      progress_callback: (p) => onProgress?.(mapProgress(p)),
    });
  }
  return pipelinePromise;
}

export async function embedLocal(
  text: string,
  onProgress?: (p: LocalEmbeddingProgress) => void
): Promise<number[]> {
  const extractor = await getPipeline(onProgress);
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

export function localEmbeddingDimensions(): number {
  return DIMENSIONS;
}
```

Design notes:

- **Singleton pipeline**, lazily created on first call — matches the existing lazy-dependency
  pattern the Python provider documents ("dependencies are never loaded if this provider is not
  selected").
- **Cache dir override**: point `env.cacheDir` at `{storageRoot}/models` (not the OS-default
  `~/.cache/huggingface`) so the download is covered by the app's own storage/cleanup story and
  is easy to find/delete via the existing `memory.listFiles`/debug tooling.
- **`dtype: 'q8'`**: quantized weights (~<200MB per D1) rather than fp32, matching the
  "small model for non-experts" goal and the RAM figures verified against the HF model card.
- **Progress callback**: surfaced up through IPC so the UI can show "Downloading local model…
  (43%)" on first use instead of an unexplained multi-second hang.
- **Prefix handling — REQUIRED (this note's original assumption was wrong; corrected in Phase 6).**
  EmbeddingGemma _does_ require a task prefix, and the feature-extraction pipeline does **not**
  apply it. Memory retrieval is an **asymmetric** retrieval task (short query vs stored
  documents), not the symmetric similarity the original note assumed, so we prepend the model-card
  retrieval prefixes: `task: search result | query: ` for queries and `title: none | text: ` for
  documents. See §13.4 for the decision, the local-only scoping, and the empirical validation.

### 6.3 Config schema — `src/main/config/config-store.ts`

- Extend `ProviderType` (line 58) is **not** the right place — `provider` on the _main_ API
  config must never be settable to `'local'` (there's no "local" chat model in this plan). Instead,
  add a **separate, narrower union** scoped to the embedding sub-config only:

  ```ts
  export type EmbeddingProviderType = ProviderType | 'local';
  ```

  and change `MemoryModelRuntimeConfig.provider?: ProviderType` (line 221) to
  `provider?: EmbeddingProviderType` **only for the `embedding` field** — requires splitting
  `MemoryModelRuntimeConfig` into a shared base plus an embedding-specific variant, or (simpler,
  less invasive) widening `provider` on the shared type and asserting elsewhere that `llm.provider`
  is never `'local'` in `MemoryLLMClient.complete()`. **Recommend the simpler widening** — it's a
  one-line type change and the `complete()` path already ignores `provider === 'local'` implicitly
  (it's never set there), so no new failure mode is introduced. Flag in code review.

- **Defaults** (`defaultConfig.memoryRuntime`, ~line 367): change to
  `useEmbedding: true`, `embedding: { ...current, provider: 'local', model: '' }` (model is
  irrelevant for the local provider; leave blank so the UI doesn't show a stale
  `text-embedding-3-small` placeholder when local is active).

- **Normalization** (`normalizeMemoryModelRuntimeConfig`, line 538): add `'local'` to whatever
  `isProviderType`-equivalent guard is used for the embedding field (needs its own
  `isEmbeddingProviderType` guard since `isProviderType` at line 469 validates against the
  6-value `ProviderType` union and would reject `'local'`).

- **Migration** (§7 below) is the load-bearing piece — see next section.

### 6.4 `memory-llm-client.ts`

- In `embed()` (line 220), before the `isOpenAiCompatible` branch (line 238):

  ```ts
  if (provider === 'local') {
    configureLocalEmbeddingCacheDir(appConfig.memoryRuntime?.storageRoot || defaultStorageRoot());
    return embedLocal(trimmed, (p) => emitLocalEmbeddingProgress(p)); // IPC event, see 6.6
  }
  ```

- `normalizeModelConfig`'s `fallbackModel` param (`'text-embedding-3-small'`, called at
  `memory-service.ts` — verify all call sites) is irrelevant when `provider === 'local'`; no
  model string is needed since the model ID is hardcoded in `local-embedding-provider.ts` per D1.

### 6.5 UI — `SettingsMemory.tsx`

- Replace the current embedding block's mental model. Today: inherit-toggle + 3 override fields,
  always visible. New: a **provider selector** with three states, matching the "Locked decisions"
  framing from the earlier conversation:
  1. **"Built-in local model"** (new default) — no fields shown beyond a status line ("Model:
     EmbeddingGemma-300M · ~180MB · downloaded" / "not yet downloaded") and a progress bar during
     first-use download.
  2. **"Inherit active API"** — existing behavior, unchanged.
  3. **"Custom"** — existing override fields (model/baseUrl/apiKey), unchanged.
- Wire the download-progress IPC event (6.6) into a small inline progress indicator so users
  aren't confused by a multi-second delay on first memory ingestion after enabling.
- Add a **"Remove downloaded model"** action (deletes `{storageRoot}/models`) next to the
  existing `memory.clearWorkspace`/`memory.clearCoreMemory` actions, for users who want to
  reclaim disk space or force a re-download.

### 6.6 IPC

- New event channel, e.g. `memory.localEmbeddingProgress`, pushed from main → renderer during
  first-use download (status/file/progress as sketched in 6.2). Follows the existing
  `memory.*` IPC naming convention (§7 of `memory-system-architecture.md`).
- No new _invoke_ endpoints strictly required — `memory.getPanelState` can be extended to include
  `localModelDownloaded: boolean` so the Settings page shows correct state on open (before any
  progress event has fired).

### 6.7 Packaging — `electron-builder.yml`

- Add to `files`:
  ```yaml
  - node_modules/@huggingface/transformers/**/*
  - node_modules/onnxruntime-node/**/*
  ```
- Add to `asarUnpack` (native binaries must live outside the asar archive, same reasoning as the
  existing `better-sqlite3`/`@img` entries):
  ```yaml
  - node_modules/onnxruntime-node/**/*.node
  - node_modules/onnxruntime-node/**/*.dll
  - node_modules/onnxruntime-node/**/*.dylib
  - node_modules/onnxruntime-node/**/*.so
  ```
- `npmRebuild: true` already covers rebuilding native deps for Electron's ABI — verify
  `onnxruntime-node` ships prebuilt binaries compatible with electron-rebuild (it does, via
  `node-pre-gyp`-style prebuilds); if not, add it to the `npm run rebuild` script alongside
  `better-sqlite3`.
- **No `extraResources` entry** — per D2, the model is not bundled; only the inference engine
  ships in the installer.

### 6.8 i18n

- Per project convention ([[feedback_i18n_four_locales]] — always check `ls locales/`, not just
  en+zh), add new strings to **all four** locale files:
  `src/renderer/i18n/locales/{en,ru,hu,zh}.json`. New keys needed:
  - `memory.embeddingProviderLocal` ("Built-in local model")
  - `memory.embeddingProviderInherit` ("Inherit active API")
  - `memory.embeddingProviderCustom` ("Custom")
  - `memory.localModelDownloading` (with `{{progress}}` interpolation)
  - `memory.localModelReady` / `.localModelNotDownloaded`
  - `memory.removeDownloadedModel` + confirmation copy
  - Plain-language blurb explaining what "local" means for the non-expert audience this feature
    targets (no cost, runs on-device, ~180MB one-time download, works offline after that).

---

## 7. Migration strategy for existing installs (D4)

**Problem:** `normalizeMemoryRuntimeConfig` (config-store.ts:559) falls back to
`defaultConfig.memoryRuntime.*` for **any field absent from the persisted `config.json`**. If we
simply flip the default (`useEmbedding: true`, `embedding.provider: 'local'`), every existing
user who never touched the Memory → Advanced settings — i.e., nearly everyone — would silently
have local embeddings turned on and a 300MB model downloaded on their next memory ingestion. That
violates D4 and is a surprise cost/behavior change for people who explicitly left embeddings off
or configured their own provider.

**Fix:** reuse the existing `configSchemaVersion` migration mechanism (already used for
`migrateFromLegacy`, confirmed at config-store.ts:~1300 — "stamped `configSchemaVersion: 1`").

1. Bump the schema version constant to `2`.
2. Add a migration step that runs once, at load time, keyed off the _previous_ version:
   - If `configSchemaVersion` was **absent or `0`** (true fresh install — no `config.json` existed,
     or it predates the schema-version field entirely) → nothing to freeze; the new defaults
     (`useEmbedding: true`, `provider: 'local'`) apply naturally, and the file is stamped `2`.
   - If `configSchemaVersion` was **`1`** (an existing installed user, regardless of whether they
     ever touched Memory settings) → **explicitly write** `memoryRuntime.useEmbedding` and
     `memoryRuntime.embedding.provider` into the persisted config using **today's defaults**
     (`false` / whatever `provider` they currently resolve to, which today is always `undefined`
     falling through to "inherit"). This makes the fields **present** in the JSON, so
     `normalizeMemoryRuntimeConfig`'s fallback-to-`defaultConfig` never triggers for them again —
     the user's effective behavior is bit-for-bit identical after the upgrade, even though
     `defaultConfig` itself changed.
   - Stamp `configSchemaVersion: 2`.
3. Add a migration unit test (mirroring whatever test coverage `migrateFromLegacy` already has)
   asserting: (a) a v1 config with no explicit `useEmbedding` key stays `useEmbedding: false`
   after migration; (b) a config with no `configSchemaVersion` at all ends up with
   `useEmbedding: true, embedding.provider: 'local'`.

This is the only correct way to change a default in a system with partial-fallback config
normalization — silently changing `defaultConfig` alone is **not sufficient** and would be a bug,
not a feature.

---

## 8. Rebuild / re-embed flow

Switching `embedding.provider` (local ↔ remote) or model changes vector dimensions
(EmbeddingGemma: 768-dim vs. `text-embedding-3-small`: 1536-dim), which already invalidates
comparability between old and new vectors per the existing "changing the model invalidates the
index" behavior documented for the Python skill and implicit in this app's cosine-similarity
scoring (`experience-memory-store.ts:508`).

- No new mechanism needed: the existing `memory.rebuildAll` / `memory.rebuildWorkspace` IPC
  endpoints (already documented in `memory-system-architecture.md` §7) are the correct path.
  Detect a dimension/provider change in the Settings UI save handler and prompt the user
  ("Switching embedding provider requires rebuilding your memory index — rebuild now?") exactly
  as any other model-changing settings action should.
- For **new installs** (local by default from day one), there's no legacy index to invalidate —
  this only matters for existing users who later opt into local embeddings via Settings.

---

## 9. Testing plan

| Layer                   | File                                                                                                  | Coverage                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit — local provider   | `src/tests/memory/local-embedding-provider.test.ts` (new)                                             | Mock `@huggingface/transformers`'s `pipeline()`; assert singleton reuse across calls, correct `dtype`/model ID, cache-dir configuration, dimension output, progress callback invocation shape.                                                                                                              |
| Unit — client dispatch  | `src/tests/memory/memory-llm-client.test.ts` (existing)                                               | Add cases: `provider: 'local'` routes to the local module and never constructs an `OpenAI` client; existing OpenAI-compatible cases remain green (regression).                                                                                                                                              |
| Unit — config migration | `src/tests/config/config-store-migration.test.ts` (new or extend existing migration tests if present) | The two scenarios in §7 step 3.                                                                                                                                                                                                                                                                             |
| Integration             | `src/tests/memory/memory-service.test.ts` (existing)                                                  | End-to-end ingestion with `useEmbedding: true, provider: 'local'` using a mocked pipeline (no real model download in CI) — assert chunks get non-empty embedding vectors and search scoring works.                                                                                                          |
| Manual / smoke          | —                                                                                                     | `npm run dev`, fresh `userData` dir (simulate new install), verify: first memory ingestion triggers a real model download with visible progress, subsequent ingestions are fast (no re-download), Settings UI shows correct state, "Remove downloaded model" works and a subsequent ingestion re-downloads. |

CI must **not** download the real ~180MB model — all automated tests mock
`@huggingface/transformers`'s `pipeline()`. Only the manual smoke pass exercises the real
network/download path.

---

## 10. Rollout phases

1. ✅ **Phase 1 + 2 — provider + backend wiring + migration** _(complete 2026-07-03)_:
   `@huggingface/transformers` dependency added; `local-embedding-provider.ts` written (ONNX
   pipeline, dtype fallback q8→fp16→fp32, pinned model revision, Set-based progress listeners,
   dimension validation, mkdirp cache dir). Config schema extended (`EmbeddingProviderType`,
   split `MemoryLLMRuntimeConfig` / `MemoryEmbeddingRuntimeConfig`). Schema v2 migration
   implemented (schema-version-aware normalization, `isFreshInstall` flag, `mergeMemoryRuntime`
   deep-merge for partial updates). `MemoryLLMClient.embed()` local branch wired with throttled
   IPC progress events. Packaging updated (`electron-builder.yml`). 2650 tests passing.
   _D3 (default flip) and D4 (migration) are both shipped: fresh installs get
   `useEmbedding: true`, `provider: 'local'`; existing v1 installs are frozen at their current
   behavior via schema-version-aware normalization._
2. ~~**Phase 2 — migration**~~: _Merged into Phase 1 above._
3. ✅ **Phase 3 — UI** (6.5, 6.6, 6.8) _(complete 2026-07-04, commit 45abaac)_: Settings UI
   three-way provider selector, download progress indicator, "Remove downloaded model" action,
   i18n across all four locales (en/ru/hu/zh).
4. ✅ **Phase 4 — rebuild-prompt-on-provider-change** (§8) _(complete 2026-07-04, commit c4ea702)_:
   detect an embedding provider/model change on save and offer an immediate `rebuildAll`; skips
   local↔local (hardcoded model ID).
5. ✅ **Phase 5 — download resilience + config safety** _(complete 2026-07-04, commits cb26253,
   8e2c1f8)_: exponential-backoff download retry, warm-up-on-select, persistent error banner +
   manual retry (`local-embedding-state.ts`); Custom-mode model-override validation (chat models
   blocked, prefix-needing models warned); "Check models availability" gate before Save. See
   §13.1–§13.3.
6. ✅ **Phase 6 — EmbeddingGemma prefixes + format-version rebuild** _(complete 2026-07-04, commit
   403e748)_: apply the required query/document task prefixes (local-only); `EMBEDDING_FORMAT_VERSION`
   stamp + stale-index detection + rebuild banner. Empirically validated. See §13.4–§13.5.

---

## 11. Risks & mitigations

| Risk                                                                                                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onnxruntime-node` native binary fails to load on some platform/arch combo (e.g., Windows ARM, which isn't in the current `win: target: nsis: arch: [x64]` build matrix anyway) | Matches the app's existing supported-arch matrix (`electron-builder.yml`: mac arm64, win x64, linux x64) — no new platform exposure. Add a guarded try/catch around pipeline creation that surfaces a clear error and offers to fall back to "Inherit active API" instead of silently breaking memory.                                                                                                                                |
| First-use download fails (offline, firewall, HF Hub down)                                                                                                                       | Local provider should surface a clear, actionable error via the existing ingestion-error classification pattern (`classifyIngestionError` in `SettingsMemory.tsx:42`) — add a `'modelDownloadFailed'` case. Memory ingestion should degrade gracefully (skip embedding, keep lexical-only scoring) rather than fail the whole ingestion pipeline, matching the current "returns `[]`" degradation behavior for unsupported providers. |
| Download-on-first-use surprises users on metered/slow connections                                                                                                               | The UI blurb (6.8) sets expectations before the download starts; consider gating the very first download behind an explicit confirmation dialog even though it's "on by default" — open question, see §12.                                                                                                                                                                                                                            |
| Main-process CPU spike during embedding (ONNX inference is synchronous-ish CPU work)                                                                                            | `ingestionConcurrency` already exists as a throttle (`memoryRuntime.ingestionConcurrency`, default 4) — verify it's respected for local embedding calls same as remote ones; consider a lower default concurrency specifically for the local path since it's CPU-bound rather than I/O-bound.                                                                                                                                         |
| Model card details (prefix requirements, exact dimensions, license) drift before implementation                                                                                 | Verify against the live `onnx-community/embeddinggemma-300m-ONNX` model card at implementation time, not just this doc's research snapshot (2026-07-02).                                                                                                                                                                                                                                                                              |

---

## 12. Open questions — all resolved

1. **First-download confirmation dialog → RESOLVED: no dialog.** Decided against a confirmation
   prompt ("we must download it anyway"). Instead: auto-download on select/first-use, with a
   visible progress bar, **exponential-backoff retry** on failure, a **persistent error banner**
   ("running in keyword-only mode"), and a **manual "Retry download"** button. Warm-up now fires
   the moment the user selects local mode, so failures surface on-panel rather than silently on
   the next ingestion. See §13.1.
2. **Local-specific `ingestionConcurrency` → RESOLVED: not applicable as framed.** Reading the
   code showed embeddings run **sequentially** (the `ingestionConcurrency` pool only governs the
   LLM _extraction_ phase; `persistBundle` awaits each `embedText` one at a time). So the feared
   concurrency oversubscription can't occur via this path — no local-specific default is needed.
   The residual (main-process CPU during a large sequential rebuild) is a responsiveness question
   whose correct fix is a **worker thread**, not a lower concurrency number; deferred until jank
   is actually observed. See §13.3.
3. **EmbeddingGemma task/prefix → RESOLVED: prefixes ARE required and are now applied.** The
   §6.2 "symmetric, no prefix" assumption was wrong. The model card mandates task prefixes that
   the pipeline does not auto-apply, and memory retrieval is asymmetric. Implemented the retrieval
   prefixes (query vs document), local-only, and **empirically validated** across EN/RU/HU. See
   §13.4–§13.5.

---

## 13. As-built outcomes, decisions & findings

Everything below is what actually shipped, keyed to the commits on
`feat/local-embeddings-default`. This supersedes the forward-looking plan above where they differ.

### 13.1 Download resilience — no confirmation dialog, backoff + retry instead _(commit cb26253)_

Resolves open question #1. The model downloads automatically (on selecting local mode, or on
first ingestion), never behind a confirmation dialog. Failure handling was the real gap:

- **New `src/main/memory/local-embedding-state.ts`** (dependency-free — no `@huggingface/transformers`
  import, so IPC can read status without loading the ML runtime): exponential backoff
  (`60s → 2m → 4m … capped at 30m`) + a coarse runtime status (`idle | loading | ready | error`)
  - `LocalModelBackoffError`.
- `getPipeline()` refuses a fresh attempt inside the backoff window, so a failing download no
  longer re-attempts a full download on **every** ingested chunk (embeddings run sequentially —
  see §13.3 — so without backoff a single ingestion could trigger dozens of failed downloads).
  `embedText` degrades to lexical-only instantly during the cooldown.
- `warmUpLocalModel(root, { force })` downloads without embedding; `force` clears backoff for a
  manual retry. `resetLocalEmbeddingPipeline()` also clears runtime/backoff state (post-deletion).
- IPC: `memory.getLocalModelStatus` (cache presence + runtime state) and `memory.warmUpLocalModel`.
- **UI**: selecting "Built-in local model" warms up immediately (errors surface on-panel, not
  silently later); a **persistent error banner** ("running in keyword-only mode") with a **Retry
  download** button replaces the old transient one-liner; status is seeded on mount so a prior
  failure is visible whenever Settings opens.
- Graceful degradation was already correct: `embedText` catches the throw and returns `[]`
  (lexical-only) rather than failing ingestion.

### 13.2 Config safety — model-override validation + "Check models availability" _(commit 8e2c1f8)_

Two Settings guards, since the remote embedding path only handles prefix-free models correctly:

- **`src/renderer/components/settings/embedding-model-validation.ts`** — `classifyEmbeddingModel()`:
  - `chat` (gpt-\*, claude, o3, llama, …): **blocks Save** with a red error — chat models can't
    embed.
  - `prefix` (E5, Nomic): soft amber warning — they work but under-perform because we don't apply
    their model-specific prefixes.
  - OpenAI `text-embedding-*`, BGE, other `*-embedding-*` pass clean; unrecognized-but-plausible
    models are not nagged.
- **"Check models availability" gate**: Save is disabled when nothing changed; when the LLM or
  embedding config changes, the button becomes "Check models availability" and Save is re-enabled
  only after a successful probe (editing a model field re-requires the check; non-model changes
  save directly). `MemoryLLMClient.checkAvailability()` probes both providers against the **unsaved
  draft** (1-token completion for the LLM; tiny `embed('ping')` for embeddings, which warms up the
  local model); `memory.checkModelAvailability` builds a throwaway client on the draft so nothing
  is persisted.

### 13.3 `ingestionConcurrency` finding (open question #2)

Not applicable as originally framed. `ingestionConcurrency` (default 4) governs only the LLM
**extraction** phase (`extractExperienceBundles`' worker pool). Embeddings are computed
**sequentially** — `ingestExtractedBundle` runs in a plain `for` loop and `persistBundle` awaits
each chunk's `embedText` one at a time. So local ONNX inference never runs concurrently, and no
local-specific concurrency default is needed. If a large sequential rebuild ever makes the main
process janky, the fix is to offload inference to a **worker thread**, not to lower a number.

### 13.4 EmbeddingGemma prefixes — the retrieval-quality fix (open question #3) _(commit 403e748)_

Verified against the live `onnx-community/embeddinggemma-300m-ONNX` model card: the task prefixes
are **mandatory** and are **not** applied by the `feature-extraction` pipeline (the official JS
example prepends them by hand). Memory retrieval is an **asymmetric** retrieval task, so we use the
model-card retrieval prefixes:

| kind     | prefix (verbatim)                |
| -------- | -------------------------------- |
| query    | `task: search result \| query: ` |
| document | `title: none \| text: `          |

Design:

- **Provider-neutral `EmbeddingKind = 'query' \| 'document'`** (mirrors sentence-transformers
  `encode_query`/`encode_document`), threaded `embedText → embed → embedLocal`. The three call
  sites pass `'document'` for ingested chunks/session summaries and `'query'` for the search
  prompt.
- The prefix **strings live only in `local-embedding-provider.ts`** and are applied only in the
  local branch. **Remote providers ignore `kind`** — prepending Gemma's strings to OpenAI/BGE
  (both prefix-free) would _degrade_ them. `kind` is the reusable plumbing; a future E5/Nomic
  provider would add its own `kind → prefix` map. (This is why `kind` is still threaded even though
  the remote list is effectively OpenAI/BGE: the query-vs-document fact only exists at the call
  site and is consumed inside the local provider.)

### 13.5 Empirical validation of the prefix fix

A standalone smoke test (real model, no DB/config/index touched) embedded query/relevant/unrelated
triples in EN/RU/HU, with and without prefixes, and compared the **margin** (relevant − unrelated
similarity):

| lang | with-prefix margin | no-prefix margin | gain       |
| ---- | ------------------ | ---------------- | ---------- |
| EN   | 0.4470             | 0.3277           | **+0.119** |
| RU   | 0.3821             | 0.3499           | **+0.032** |
| HU   | 0.1424             | 0.0676           | **+0.075** |

Prefixes widen the relevant/unrelated separation in every language (relevant still out-ranks
unrelated in all cases). Hungarian — a target locale and the weakest case — more than doubled its
margin. This closes open question #3 empirically, not just from the model card.

### 13.6 Format-version stamp + stale-index rebuild _(commit 403e748)_

Because prefixed vectors stay 768-dim, old (prefix-less) and new (prefixed) local vectors would be
_compared_ by cosine and give subtly-wrong scores — the dimension guard in `cosineSimilarity`
(which returns 0 on a size mismatch) does **not** catch this. So:

- **`EMBEDDING_FORMAT_VERSION`** (in `shared/local-embedding-types.ts`, bumped to **2**: v1 = raw
  text, v2 = prefixes). The experience store stamps it on `save()` and reads it on load (absent →
  1).
- `MemoryService.isEmbeddingFormatStale()` flags a stale index, **gated to the local provider** so
  remote users are never prompted to re-embed (which would re-incur API cost for a change that
  didn't affect them). Surfaced via `memory.isEmbeddingFormatStale`, driving an amber "Rebuild now"
  banner in Settings; a rebuild re-stamps the format and clears the flag. This is the durable,
  provider-aware generalization of the Phase 4 rebuild prompt.

### 13.7 Test coverage added

`local-embedding-state` (backoff math + status transitions); provider prefix/`kind` assertions
(query/document/default) and the backoff+forced-warm-up retry; `checkAvailability` orchestration
(ok/fail/skip); `classifyEmbeddingModel` (chat/prefix/clean); experience-store format-version
round-trip. All green under `npm test` (native rebuild); CI never downloads the real model — the
§13.5 smoke test is manual only.

---

## Appendix A — Model comparison (condensed from research)

| Model                                                      | Params | RAM (quantized)           | Context  | Languages                             | ONNX-ready                                       | License                                       |
| ---------------------------------------------------------- | ------ | ------------------------- | -------- | ------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| **`onnx-community/embeddinggemma-300m-ONNX`** (chosen, D1) | 300M   | <200MB (q8/uint8)         | 2048 tok | 100+ (Gemma 3)                        | Yes, purpose-built for on-device/transformers.js | Gemma license (open, on-device use permitted) |
| `Xenova/multilingual-e5-small`                             | 0.1B   | ~470MB fp32 / ~120MB fp16 | 512 tok  | 100 (XLM-R)                           | Yes                                              | MIT                                           |
| `Xenova/bge-m3` (current remote default, `BAAI/bge-m3`)    | 568M   | ~1.5-2GB                  | 8192 tok | 100+                                  | Yes                                              | Apache 2.0                                    |
| `nomic-ai/nomic-embed-text-v1.5`                           | 137M   | ~500MB                    | 8192 tok | Weak outside English (esp. Hungarian) | Yes (`trust_remote_code`)                        | Apache 2.0                                    |

Full research detail (RU/HU-specific coverage analysis, OpenRouter pricing table, MTEB scores) is
in `~/src/semantic-index-skill/semantic-index/references/embedding-models.md` and the Downloads
discussion doc; not duplicated here to avoid drift — treat those as historical research inputs,
this table as the load-bearing decision record for _this_ app.
