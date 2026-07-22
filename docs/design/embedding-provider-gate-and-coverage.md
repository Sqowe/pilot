# Embedding Provider Gate, Coverage Visibility & Backfill — Design

**Status:** Implemented ✅ — gate fix, coverage card, panel refresh, and backfill all shipped
on `feat/memory2sql-migration`. Manual verification (§8) pending on a real store.
**Date:** 2026-07-22
**Owner:** @obodnikov
**Branch:** `feat/memory2sql-migration`
**Related:** [local-embeddings-default.md](archive/local-embeddings-default.md),
[native-provider-catalog.md](archive/native-provider-catalog.md),
[memory-storage-sqlite-migration.md](memory-storage-sqlite-migration.md),
[memory-llm-client.ts](../../src/main/memory/memory-llm-client.ts),
[memory-service.ts](../../src/main/memory/memory-service.ts),
[SettingsMemory.tsx](../../src/renderer/components/settings/SettingsMemory.tsx)
**Prior discussion:** conversation of 2026-07-22 (embedding-coverage investigation)

---

## 1. What was wrong

Semantic search over Experience Memory had been silently degraded for weeks. On a real
store, 23 of 443 chunks carried a vector (5%). The remaining 420 were retrievable by
keyword only.

The initial reading — "embeddings stopped working on 21.07" — was wrong, and worth
recording because the wrong frame nearly sent the investigation at the SQLite migration
that shipped the same week. The per-day breakdown showed embeddings present on **3 days
out of 54**, and absent on the other 51. It had never worked steadily. Two chunks ingested
40 minutes apart on the same day, from different workspaces, differed in outcome.

## 2. Root cause

Two defects, coupled. Either alone is survivable; together they made a valid configuration
fail with no user-visible signal.

### 2.1 The provider gate was stale

`MemoryLLMClient.embed()` gated the call on a hardcoded comparison against the six legacy
builtin provider ids:

```ts
const isOpenAiCompatible =
  provider === 'openai' ||
  provider === 'openrouter' ||
  provider === 'ollama' ||
  (provider === 'custom' && protocol === 'openai');
```

`ProviderType` was widened to an open `string` on 2026-07-06 (commit `89ddab99`,
"widen ProviderType + profile key scheme for native providers (P1)") so the native provider
catalog could carry ids like `minimax`, `zai`, `deepseek`. The catalog work never touched
`memory-llm-client.ts` — `git log --since=2026-07-01` on that file ends at 07-04.

So every native catalog provider fell through the gate. `embed()` returned `[]` with only a
`logWarn`, ingestion continued, and the chunk was stored without a vector.

Note the same file's `complete()` had been catalog-aware all along, resolving the protocol
via `resolvePiRouteProtocol()`. The LLM path was updated; the embedding path was not.

### 2.2 The gate was asking the wrong question in Custom mode

`SettingsMemory` writes Custom mode as `provider: undefined, inheritFromActive: false`.
`normalizeModelConfig` then resolves:

```ts
const rawProvider = inherit ? activeProvider : input?.provider || activeProvider;
```

`undefined || activeProvider` → **the active chat provider**. Meanwhile `apiKey`, `baseUrl`
and `model` all came from the user's own override, and `resolveOpenAICredentials` never
looks at `provider` at all.

The observed configuration was therefore fully self-contained — model `BAAI/bge-m3`, base
URL `https://openrouter.ai/api/v1`, own API key — and was blocked solely because the
unrelated active chat provider was `minimax` (which routes over the Anthropic protocol and
has no embeddings API of its own).

This also explains the intermittency in §1: the embedding config had not changed in weeks.
What changed, day to day, was which chat provider happened to be selected.

### 2.3 Why nobody noticed

The only trace was a `logWarn`. Log rotation keeps 5 files; on inspection the oldest
surviving entry postdated the failing ingest by 48 minutes. The evidence of the failure that
prompted the investigation had already been overwritten.

Nothing in the UI reported embedding coverage. The Memory settings page showed
"All sessions ingested successfully" — which was true. The chunks _were_ ingested. They just
had no vectors.

## 3. Decisions

| #   | Decision                   | Choice                                                                                                                                                                                       |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Self-contained overrides   | A Custom-mode config carrying both `baseUrl` and `model` bypasses the provider gate entirely. The active chat provider contributes nothing to such a request and must not veto it.           |
| D2  | Gate for every other case  | Resolve the route protocol via `resolvePiRouteProtocol()` and require `'openai'` — the same helper `complete()` already uses. No more hardcoded id lists.                                    |
| D3  | Fail loudly                | `embed()` throws `EmbeddingUnsupportedError` instead of returning `[]`. Callers still degrade to lexical-only, but record the reason first.                                                  |
| D4  | Coverage gets its own card | Not folded into "Ingestion status". A chunk stored without a vector was ingested successfully — reporting it as an ingestion failure would be false, and would keep the real problem hidden. |
| D5  | Backfill, not rebuild      | Re-embedding stored rows needs no LLM extraction, so it gets its own action rather than routing users at `rebuildAll` (which deletes core memory and re-extracts everything).                |

## 4. The gate fix

[memory-llm-client.ts](../../src/main/memory/memory-llm-client.ts), in `embed()`:

```ts
const override = appConfig.memoryRuntime.embedding;
const isSelfContainedOverride =
  override?.inheritFromActive === false &&
  Boolean(override.baseUrl?.trim()) &&
  Boolean(override.model?.trim());

const isOpenAiCompatible = resolvePiRouteProtocol(provider, protocol) === 'openai';

if (!isSelfContainedOverride && !isOpenAiCompatible) {
  throw new EmbeddingUnsupportedError(provider);
}
```

`baseUrl` is load-bearing in the self-contained test: without it `normalizeModelConfig` falls
back to the active provider's base URL, so the request would leave for someone else's
endpoint and the gate must still apply.

`resolvePiRouteProtocol` returns `provider || 'anthropic'` for unknown ids, so an
unrecognised provider is still blocked — the change widens the gate to _known_ openai-protocol
providers, it does not open it.

`MemoryLLMClient.probeEmbedding` (behind "Check models availability") now surfaces the thrown
reason rather than a generic "empty vector" message.

## 5. Coverage visibility

`MemoryOverview` gained four fields: `embeddingEnabled`, `embeddedChunkCount`,
`embeddingError`, `embeddingErrorAt`. The counters come from prepared statements that already
existed for `hasEmbeddings()`; the count is only computed when `useEmbedding` is on.

`MemoryService.lastEmbeddingError` holds the most recent failure for the process lifetime.
Deliberately not persisted: it answers "is this broken right now", not "what happened in
March". A successful non-empty embedding clears it.

The card renders green at full coverage, amber when rows lack vectors, red when a failure is
recorded (with its message and timestamp).

### 5.1 The panel had to be told when it is visible

The card was correct and still showed a stale number, because `SettingsPanel` keeps visited
tabs **mounted** and merely hides them with CSS (`viewedTabs` only ever grows). The overview
was read once, on first open, and never again short of an explicit save/rebuild.

Fixed by adopting the `isActive` convention already used by `SettingsSkills`,
`SettingsConnectors` and `SettingsSchedule`: `SettingsMemory` takes `isActive` and re-reads
when the tab becomes visible. The stale-format banner had the same defect (its `useCallback`
has empty deps, so it was stable forever) and was fixed alongside.

## 6. Backfill

### 6.1 Why it is cheap

The embedded text is derived **entirely from persisted columns**:

| kind    | text                           | columns                          |
| ------- | ------------------------------ | -------------------------------- |
| chunk   | `summary + details + keywords` | `summary`, `details`, `keywords` |
| session | `summary + keywords`           | `summary`, `keywords`            |

So re-embedding needs zero LLM calls. On the store that prompted this work: 414 chunks +
110 sessions, ~864 characters each — a few hundred thousand tokens of embedding, and nothing
else. `rebuildAll` by contrast runs `extractExperienceBundles` over every session and first
deletes `core_memory.json`, `session_state.json` and the eval artifacts.

### 6.2 The ordering bug this exposed

Ingestion used to build the embedded text _before_ resolving the keyword fallback:

```ts
const searchableText = [summary, details, ...chunk.keywords].join(' '); // extractor's keywords
keywords: chunk.keywords.length ? chunk.keywords : extractKeywords(searchableText); // stored
```

When the extractor returned no keywords, the **stored** keywords were derived ones that were
never part of the embedded text. Reconstructing from the stored columns would then produce a
different string, and backfilled vectors would land slightly off from freshly-ingested ones —
silently, since nothing compares them.

Fixed by resolving keywords first and building the text from the resolved list, via shared
`buildChunkEmbeddingText` / `buildSessionEmbeddingText` used by both paths. This is the
invariant the feature rests on, so it has a dedicated regression test (§7).

### 6.3 Selection

A row is selected when it has no vector **or** its `embedding_model` differs from the active
one. SQLite's `IS NOT` is used rather than `!=` so NULL compares correctly. This keeps the
store homogeneous per install, which `isEmbeddingModelStale` depends on (D5 of the SQLite
migration design).

`MAX_CONSECUTIVE_FAILURES = 5` aborts a doomed run — a misconfigured provider fails every
call, and grinding through 500 of them helps nobody — while tolerating a transient blip.
Meta is re-stamped only if at least one row was embedded.

### 6.4 Placement

The action sits on the coverage card itself (via `InfoCard`'s existing `action` prop), shown
only when there is something to backfill. It is the card that reports the problem, so it is
the card that offers the fix. On completion the panel refreshes regardless of outcome:
success must show the new numbers, failure must show the recorded reason.

### 6.5 Progress reporting

Shipped after first use on a real store made the omission obvious: a run over 524 rows took
minutes behind a static "Embedding…" label, and the coverage number could only be seen to
move by leaving the tab and coming back. The card is a snapshot; it cannot advance on its own.

`backfillEmbeddings(onProgress?)` reports `{ processed, total }` per row, including an initial
`0 / total` so the scale is visible before the first row completes. `memory.backfillProgress`
carries it to the renderer, throttled to 100 ms exactly as the local-model download events
are — with first and last events exempt so the scale appears immediately and the run is always
seen to finish.

The renderer subscribes unconditionally rather than only while running, and derives
`isBackfilling` from the events (`processed < total`) rather than only from its own handler.
A panel mounted mid-run therefore reports correctly, and cannot be left stuck on "running" by
a run it did not start. While a backfill is in flight the progress line replaces the coverage
hint, since the coverage number above it is a snapshot that is known to be out of date.

## 7. Tests

| Area                    | Coverage                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate                    | Native provider + self-contained override embeds; inherit-mode over a non-openai protocol throws `EmbeddingUnsupportedError`; native openai-protocol provider passes; Custom override missing `baseUrl` is still gated. |
| Backfill                | Embeds stored rows without re-extraction; disabled-embeddings no-op; already-current rows untouched; rows reselected after a model change.                                                                              |
| Text reconstructibility | Backfill embeds byte-identical text to ingestion — asserted both for extractor-supplied keywords and for the derived-keyword fallback, with an explicit non-vacuity assertion.                                          |
| Panel wiring            | `memory-integration-files.test.ts` asserts the `isActive` prop is wired, so the staleness fix cannot silently regress.                                                                                                  |

`resolvePiRouteProtocol` is mocked per-test in `memory-llm-client.test.ts`; because
`vitest.config` sets `mockReset: true`, the default implementation is restored in `beforeEach`.

## 8. Manual verification — pending

1. Coverage card reads 27 / 441 (6%) on the reference store, amber, with a Backfill action.
2. One agent turn in a memory-enabled chat produces chunks **with** vectors (ingestion fires
   on `afterSessionRun`, i.e. per turn — not on session close).
3. Switching away from the Memory tab and back updates the counters without closing Settings.
4. Backfill on the reference store embeds ~524 rows, runs no LLM extraction (verify against
   provider usage), leaves `experienceChunkCount` unchanged, and turns the card green.
5. With embeddings pointed at an Anthropic-protocol provider in **inherit** mode, the card
   turns red and names the provider.

## 9. Follow-ups not taken

- ~~**Backfill progress reporting.**~~ Deferred, then built the same day — see §6.5. The
  first real run made the case: minutes of silence behind a static label. Recorded because
  the deferral was wrong, not because it was close.
- **Cancelling a backfill.** A run over a large store cannot be stopped short of quitting
  the app. Partial progress is durable and a re-run resumes, so the cost of not having this
  is bounded; revisit if stores grow enough for a run to take more than a few minutes.
- **Persisting `lastEmbeddingError`.** Would survive restarts, at the cost of a schema field
  and a dismissal story. The process-lifetime value answers the question that matters now.
- **A provider selector in Custom mode.** Would make D1 unnecessary by letting the user state
  the protocol directly. D1 is the better default regardless: a fully-specified endpoint
  should not need a second opinion.
