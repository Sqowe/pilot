# Experience Memory → SQLite Storage Migration — Design

**Status:** Shipped — Phases 1–3 ✅, post-review fixes ✅, §16 follow-ups all settled ✅.
Manual verification (§17) in progress: A1–A3 passed on a real store 2026-07-22; A4–A5 and B–F pending.
**Date:** 2026-07-03
**Updated:** 2026-07-21
**Owner:** @obodnikov
**Branch:** `feat/memory2sql-migration`
**Related:** [memory-system-architecture.md](memory-system-architecture.md),
[local-embeddings-default.md](local-embeddings-default.md),
[experience-memory-store.ts](../../src/main/memory/experience-memory-store.ts),
[database.ts](../../src/main/db/database.ts),
[memory-service.ts](../../src/main/memory/memory-service.ts),
[memory-lens-panel.md](memory-lens-panel.md)
**Prior discussion:** conversation of 2026-07-03 (MCP-access + storage sizing thread)

## Rollout status

| Phase | Scope                                                           | Status  | Commit    |
| ----- | --------------------------------------------------------------- | ------- | --------- |
| 1     | SQLite store, migration, tests                                  | ✅ Done | `a19fc4f` |
| 2     | IPC bridge, renderer types, export/vacuum/status                | ✅ Done | `2bcc076` |
| 3     | Settings UI — DB status card, storage branching, i18n           | ✅ Done | `36a40f8` |
| 3.1   | Post-review fixes — §7 staleness gate, per-row model stamping   | ✅ Done | `5dd814d` |
| 3.2   | Search path narrowed to text-only rows; deprecated getters gone | ✅ Done | `69a1204` |
| 3.3   | Lazy transcript hydration — §1 goal #2 fully closed             | ✅ Done | `03a56c8` |
| 3.4   | Hardening — BLOB alignment, column-definition guard, doc sync   | ✅ Done | `5fcfd1b` |

> Note: [memory-system-architecture.md §5](memory-system-architecture.md)'s storage-root
> default is now **fixed** (`app.getPath('userData')/memory`). Its storage-layout tree is
> still stale, though: it lists `experience_memory.json` and has no `memory.db` entry.

---

## 1. Goal

Move **experience memory** from a single monolithic JSON file to a SQLite database, to remove
the two structural weaknesses of the JSON store that scale with total size regardless of how
much data a query actually needs:

1. **Whole-file rewrite on every mutation.** Every ingested session rewrites the entire file
   via atomic temp+rename (`saveJsonFile`, [memory-utils.ts:121](../../src/main/memory/memory-utils.ts),
   called by `ExperienceMemoryStore.save()` at
   [experience-memory-store.ts:340](../../src/main/memory/experience-memory-store.ts)).
2. **Whole-file load+parse on every read.** Answering a workspace-scoped query loads and parses
   the full file even though only a fraction of rows belong to that workspace.

Both are `O(total size)`. Aggregate write churn is worse than linear (~`O(n²)`): a growing file
is rewritten more times as sessions accumulate.

## 2. Non-goals

- **Not** moving `core_memory.json` (~20 KB / ~24 curated entries — a `WHERE` over 24 rows buys
  nothing) or `session_state.json` (small ingestion bookkeeping). Both stay JSON.
- **Not** adopting a dedicated vector database (LanceDB / Chroma / `sqlite-vec`). ANN indexes
  earn their keep at 10⁵–10⁶ vectors; this store holds ~10²–10³. Brute-force cosine over a
  workspace-filtered subset stays sub-millisecond. Revisit only past ~50–100k vectors.
- **Not** changing the retrieval scoring model, the ingestion pipeline, or the memory prompts.
  The public interface of `ExperienceMemoryStore` is preserved.
- **Not** piggybacking on the local-embeddings re-embed. The new local dimension applies to
  **new installs / opt-in only** ([local-embeddings-default.md §7](local-embeddings-default.md)),
  so most installs never re-embed. This migration is standalone.

## 3. Why now (sizing)

- Observed growth: **~24 MB in ~1 month** (91 sessions / 338 chunks). Linear extrapolation puts
  the store at **~100 MB within ~3 months**.
- At ~100 MB the felt pain is not query CPU but: a synchronous `writeFileSync` of the whole file
  per ingest (~100–300 ms main-process block) and a ~1 s `JSON.parse` on any full load.
- Therefore: **not urgent today, but a this-quarter task.** Sequence it as the next storage task
  **after** the local-embeddings branch stabilizes (§13).

## 4. Locked decisions

| #   | Decision                  | Choice                                                                                                                                                               |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Backing store             | **SQLite via `better-sqlite3`** (already compiled to the Electron ABI; powers `cowork.db`). Not a vector DB.                                                         |
| D2  | Scope                     | **Experience memory only.** `core_memory.json` + `session_state.json` stay JSON.                                                                                     |
| D3  | DB file location          | **Separate `memory.db` under the configurable `storageRoot`** (co-located with `core_memory.json`). Not folded into `cowork.db` — see §5.                            |
| D4  | Embedding column          | **`BLOB` (Float32) with per-row `embedding_model` + `embedding_dim`.** Schema does not hard-code a dimension.                                                        |
| D5  | Cross-model comparability | Store stays **homogeneous per install** (one model at a time). A model/provider switch invalidates and triggers a rebuild — the existing rule, made explicit via D4. |
| D6  | Interface                 | `ExperienceMemoryStore`'s public methods are **preserved**; only the internals swap JSON ↔ SQL.                                                                      |

## 5. DB location: separate `memory.db`, not `cowork.db`

Memory lives under `memoryRuntime.storageRoot` (user-configurable, default `<userData>/memory`),
whereas `cowork.db` is fixed at `<userData>/data/cowork.db`. Folding experience memory into
`cowork.db` would:

- break the property that **all memory lives under one relocatable `storageRoot`** (users who set
  a custom storageRoot expect memory — and its backups — to move together);
- couple memory-schema migrations to the chat DB;
- share a WAL between bursty ingestion writes and chat writes.

A separate `memory.db` co-located under `storageRoot` keeps memory relocatable and independently
rebuildable, and keeps the future **read-only MCP reader symmetric with today** (open a file under
`storageRoot`, read-only). The only thing lost is a cross-DB SQL join from experience rows to
`sessions`/`messages` — which retrieval does not need (rows already denormalize
`source_session_title` / `_date` / `source_workspace`; `source_session_id` is retained for
reference and can be joined in-app by opening both handles if ever required).

**Alternative (rejected for now):** single `cowork.db` with `memory_*` tables — simpler one-file
ops and native joins. Reconsider only if storageRoot relocation is dropped as a feature.

## 6. Proposed schema (`memory.db`)

Mirrors the additive-migration idiom in `initializeSchema`
([database.ts:248](../../src/main/db/database.ts)) — `CREATE TABLE IF NOT EXISTS` + `ensureColumn`.
Dates are kept as ISO-8601 **TEXT** to preserve source fidelity (the current normalizers read
`created_at` / `ingested_at` / `session_date` as strings); ISO-8601 sorts lexicographically.

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS memory_sessions (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  source_workspace       TEXT,                 -- the scope key (resolved abs path)
  source_workspace_label TEXT,
  source_session_id      TEXT,
  source_session_title   TEXT,
  source_session_date    TEXT,
  summary                TEXT NOT NULL DEFAULT '',
  keywords               TEXT NOT NULL DEFAULT '[]',  -- JSON array
  chunk_ids              TEXT NOT NULL DEFAULT '[]',  -- JSON array
  raw_session            TEXT,                 -- JSON transcript turns
  session_date           TEXT,
  created_at             TEXT,
  ingested_at            TEXT,
  embedding              BLOB,                 -- Float32 little-endian, length = embedding_dim
  embedding_model        TEXT,                 -- e.g. onnx-community/embeddinggemma-300m-ONNX
  embedding_dim          INTEGER               -- e.g. 768; validates comparability
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  source_workspace       TEXT,                 -- denormalized for fast scoping
  source_workspace_label TEXT,
  source_session_id      TEXT,
  source_session_title   TEXT,
  source_session_date    TEXT,
  summary                TEXT NOT NULL DEFAULT '',
  details                TEXT NOT NULL DEFAULT '',
  keywords               TEXT NOT NULL DEFAULT '[]',
  source_turns           TEXT NOT NULL DEFAULT '[]',
  raw_text               TEXT NOT NULL DEFAULT '',
  session_date           TEXT,
  created_at             TEXT,
  ingested_at            TEXT,
  embedding              BLOB,
  embedding_model        TEXT,
  embedding_dim          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mem_chunks_workspace  ON memory_chunks(source_workspace);
CREATE INDEX IF NOT EXISTS idx_mem_chunks_session    ON memory_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_mem_sessions_workspace ON memory_sessions(source_workspace);

-- Optional (migration phase 2): FTS5 over chunk text to replace the JS lexical scorer.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
  summary, details, raw_text, keywords,
  content='memory_chunks', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, migrated_from
```

### Embedding encoding

- Write: `Buffer.from(new Float32Array(embedding).buffer)`.
- Read: `new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)` → pass to
  `cosineSimilarity` (accept `Float32Array | number[]`; add a small overload — see §8).
  **As built:** the signature was widened, but `blobToEmbedding` returns `number[]`, so the view is
  never handed to the scorer. That was measured and settled as won't-do — see §16.4.
- ~4 KB per 768-dim vector as Float32 BLOB vs. ~18 KB as JSON text → **~4× smaller for the
  embedding column**. Note this is a claim about that column only, _not_ about total file size.
  Measured on a real store (2026-07-22, 117 sessions / 443 chunks): `memory.db` came out 35.0 MB
  against a 36.4 MB JSON — barely 4% smaller, because the bulk is transcript text, which is stored
  as-is either way (`sessions.raw_session` 23.4 MB, `chunks.raw_text` 5.4 MB, all embeddings
  0.1 MB). Expect the disk win to be negligible unless a store is embedding-dense. The migration's
  value is in the access pattern (§1), not in file size.

## 7. Homogeneous store & staleness (D5)

Cosine is only meaningful within one embedding space, and there is **no default model today** —
each install's dimension is whatever the user configured (1536 OpenAI, 1024 bge-m3, 768 local,
Ollama-various, or none). So at any moment the store holds **one** model's vectors.

- On load/query, assert the stored `embedding_model` equals the active embedding config.
  On mismatch → treat as a stale index: fall back to lexical-only retrieval and surface
  the existing "rebuild memory index" prompt
  (`rebuildAll` / `rebuildWorkspace`, [memory-service.ts](../../src/main/memory/memory-service.ts);
  [local-embeddings-default.md §8](local-embeddings-default.md)).
- This makes the implicit "changing the model invalidates the index" rule **explicit and safe**,
  and lets the future MCP reader refuse to semantic-search vectors built with a different model
  instead of returning garbage.

### As built (`5dd814d`)

Shipped as `MemoryService.isEmbeddingModelStale()`, with two deliberate departures from the
sketch above:

- **Reads `memory_meta.embedding_model`, not every candidate row.** Under D5 the store is
  homogeneous, so meta is authoritative and the check is O(1) instead of a per-query scan.
  It is also _more_ robust: installs migrated before `5dd814d` have per-row tags that lag by
  one ingest (the bug that commit fixed), so a row-level assert would false-positive on them.
  Per-row `embedding_model`/`embedding_dim` remain correct-going-forward and stay the
  substrate for the future MCP reader, which can afford the row-level check.
- **Unknown ≠ stale.** If no model is configured, or the store predates model recording,
  the gate returns `false`. Retrieval degrades only on _positive_ evidence of a mismatch —
  silently dropping to lexical-only on missing metadata would be worse than the risk it avoids.

Gate point: `buildPromptPrefix` skips `embedText()` entirely when stale, so no query vector is
computed and `retrieveProgressive` scores lexically. The warning logs once per staleness episode
(this path runs on every prompt). The existing amber Settings banner now fires on either
condition and reuses the already-translated `memory.rebuildOnProviderChange` string, so the
feature added **no new i18n keys**. IPC `memory.isEmbeddingFormatStale` gained an additive
`modelStale` field rather than a second channel.

Unlike `isEmbeddingFormatStale` (deliberately gated to the local provider, since only its
computation changed), this gate is **provider-agnostic**: switching model invalidates the index
no matter who computed the vectors.

## 8. Retrieval path changes

Keep the `ExperienceMemoryStore` public surface (`getSession`, `getChunk`, `getChunksBySession`,
`getStatsBySourceWorkspace`, `replaceSession`, `removeSession`, `removeBySourceWorkspace`, `clear`,
`retrieveProgressive`) so callers (`memory-retriever.ts`, `memory-service.ts`) are untouched.
Swap the internals:

- **Load → query.** Replace `loadJsonFile` of the whole file with prepared statements. The hot path
  (`retrieveProgressive` / the private scorer at
  [experience-memory-store.ts:~502](../../src/main/memory/experience-memory-store.ts)) first selects
  the candidate set via `WHERE source_workspace = ? OR source_workspace IS NULL` (∪ global), then
  runs the **existing** JS scoring — `cosineSimilarity` + `lexicalScore` + `workspaceBoost` +
  `recencyBoost` + supersession penalty — over that subset. Scoring math is unchanged.

  > **As built — the SQL workspace pre-filter was NOT adopted.** It would have changed results.
  > `workspaceBoost` is a _boost_, not a filter: a `WHERE source_workspace = ?` restriction
  > drops cross-workspace rows that the JSON store ranked (merely with a lower score), so the
  > filter is not retrieval-preserving. The shipped path loads **all** rows as embedding-free
  > "light rows" into a process cache (invalidated on write, and on `PRAGMA data_version`
  > change for external writers) and applies the unchanged JS scoring over them. Pinned by
  > `retrieveProgressive` tests asserting cross-workspace results still surface.
  >
  > What this does buy: BLOBs are off the scan path entirely (they are batch-fetched by id,
  > in ≤900-id `IN` batches, only for the pre-filtered candidate window), which is the bulk of
  > the bytes. What it does not: see §16 — light rows still parse `raw_session`.

- **Save → upsert.** `replaceSession` / `removeSession` / `removeBySourceWorkspace` become
  transactional `INSERT … ON CONFLICT` / `DELETE`, eliminating whole-file rewrites.
- **Lexical (optional, phase 2 of this migration).** Move the lexical half to `memory_chunks_fts`
  (FTS5) and combine with the JS vector score, keeping the same weighting. Ship phase 1 with
  lexical still in JS to de-risk.
- `cosineSimilarity` / `lexicalScore` in [memory-utils.ts](../../src/main/memory/memory-utils.ts)
  gain `Float32Array` support (currently `number[]`).

## 9. Migration / backfill

One-time and idempotent, run after `storageRoot` is resolved and before memory serves any read:

> **As built — this is lazy, not eager.** It runs from `ensureStores()`, which is called on the
> _first actual memory access_ (`getExperienceStore()` / `getOverview()` / `listFiles()`), not
> during app startup. `new MemoryService(...)` opens nothing. So after installing a build that
> migrates, `memory.db` does not appear until something touches memory — opening Settings → Memory
> or sending a message. A check for the file straight after launch will find nothing and look like
> a failed migration; it is not. (This wording cost a live debugging round on 2026-07-22.)

1. If `memory.db` exists and `memory_meta.schema_version` is current → no-op.
2. Else create schema, then stream `experience_memory.json` through the existing normalizers
   (`normalizeSession` / `normalizeChunk`) and `INSERT` all rows in a **single transaction**,
   encoding `embedding` → BLOB and stamping `embedding_model` / `embedding_dim` from the active
   memory config at migration time (the store is homogeneous, §7).
3. On success: rename `experience_memory.json` → `experience_memory.json.bak` (keep as rollback),
   write `memory_meta` (`schema_version`, `migrated_from`, `migrated_at`).
4. If the JSON is absent (embeddings never enabled) → just create the empty schema.

- **Idempotency:** guarded by `memory_meta.schema_version`; a crash mid-transaction rolls back
  (WAL) and retries next launch (the `.json` is renamed only after commit).
- **Rollback:** delete `memory.db`, rename `.bak` back. Document a one-liner.
- **Backfill cost:** ~429 rows today — well under a second. Even at 10× it is a one-time
  sub-second transaction.

## 10. Code impact

| File                                                  | Change                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/memory/experience-memory-store.ts`          | Reimplement internals against `memory.db` (prepared statements); preserve public methods. Largest change.                                                                                                                                                                      |
| `src/main/memory/memory-utils.ts`                     | `cosineSimilarity` / `lexicalScore` accept `Float32Array`; add BLOB ↔ Float32 helpers. Keep `saveJsonFile`/`loadJsonFile` (still used by core/state).                                                                                                                          |
| `src/main/memory/memory-service.ts`                   | `getPaths()` gains `experienceDbPath` under `storageRoot`; open a dedicated `better-sqlite3` handle (separate from `getDatabase()`); run the backfill (§9); `listFiles`/`readFile` updated, add `getExperienceDbStatus` / `exportExperienceJson` / `vacuumExperienceDb` (§11). |
| `src/main/db/*`                                       | Optionally factor the `better-sqlite3` open/WAL boilerplate into a shared helper reused by `memory.db`. No change to `cowork.db` schema.                                                                                                                                       |
| `src/renderer/components/settings/SettingsMemory.tsx` | Rename "Raw File Viewer" → "Memory Storage"; branch entries on `storage` (`file` → raw pane, `sqlite` → DB-status card); wire `[Vacuum]` / `[Export JSON]`. Maintenance buttons keep their verbs (§11).                                                                        |
| `src/preload/index.ts`                                | Add `memory.getExperienceDbStatus` / `exportExperienceJson` / `vacuumExperienceDb` bridges + their `ipcMain` handlers; existing `rebuild*` / `clear*` / `listFiles` / `readFile` IPCs unchanged (§11).                                                                         |
| `src/renderer/types/index.ts` (+ shared)              | `MemoryDebugFileInfo` gains `storage: 'file' \| 'sqlite'`; add `ExperienceDbStatus` type (§11).                                                                                                                                                                                |
| `src/tests/memory/*`                                  | Harnesses that build JSON stores (`memory-service.test.ts`, `memory-eval-harness.test.ts`, `memory-smoke-harness.test.ts`) switch to seeding `memory.db`; add a JSON→SQLite backfill test.                                                                                     |

## 11. UI surfaces: Settings "Raw File Viewer" + ContextPanel Lens

Two renderer surfaces read the raw stores today and both must change:

1. **Settings → Memory "Raw File Viewer"**
   ([SettingsMemory.tsx](../../src/renderer/components/settings/SettingsMemory.tsx)) — a file list +
   raw-content pane driven by `memory.listFiles()` / `memory.readFile()`
   ([preload:633](../../src/preload/index.ts); `memory-service.ts:306/347`).
2. **ContextPanel Memory Lens** ([memory-lens-panel.md](memory-lens-panel.md)) — status +
   per-workspace stats; already consumes `getStatsBySourceWorkspace`, which becomes a cheap indexed
   `GROUP BY` (see that doc's "Post-Migration Opportunity: Memory-by-Workspace View").

### It's a hybrid, not a wholesale "files → DB status" swap

Three of the four entries stay files; only experience becomes a DB. So rename the section
**"Raw File Viewer" → "Memory Storage"** and give each entry a storage type:

| Entry                    | After migration | Viewer                                          |
| ------------------------ | --------------- | ----------------------------------------------- |
| `core_memory.json`       | JSON file       | raw-JSON pane (unchanged)                       |
| `session_state.json`     | JSON file       | raw-JSON pane (unchanged)                       |
| `eval-artifacts/`        | directory       | as-is                                           |
| `experience_memory.json` | **`memory.db`** | **DB-status card** (a raw byte dump is useless) |

### Experience DB-status card

Replaces the raw pane for the `memory.db` entry. Every field is cheap (`COUNT` / `PRAGMA` / the
`GROUP BY` breakdown):

```
┌─ memory.db — Experience DB ──────────────────────────┐
│ Schema v1 · WAL · 24.1 MB                             │
│ 91 sessions · 338 chunks                              │
│ Model: onnx-community/embeddinggemma-300m · dim 768   │
│ Integrity: ok                                         │
│ By workspace:  Tree HU 5·14 · Investments 9·41 · …    │
│ [Rebuild all]   [Vacuum]   [Export JSON]              │
└───────────────────────────────────────────────────────┘
```

`Export JSON` dumps the DB back to the `{ sessions, chunks }` shape — this **preserves the
raw-inspection capability** power users have today and gives a portable backup, without shipping a
SQL browser.

### Backend / type deltas

- `MemoryDebugFileInfo` gains a `storage: 'file' | 'sqlite'` discriminator; the experience entry
  flips to `sqlite` and points at `memory.db`. The renderer branches: `file` → existing raw pane,
  `sqlite` → status card.
- Add `memory.getExperienceDbStatus` IPC (counts, `embedding_model`/`embedding_dim` from
  `memory_meta` + rows, `PRAGMA integrity_check`, size, per-workspace breakdown). Keep `readFile`
  for **files only** so the raw path stays clean.
- Add `memory.exportExperienceJson` (dump DB → JSON) and `memory.vacuumExperienceDb` (`VACUUM`).
  Reuse existing `rebuildAll` / the `getWorkspaceBreakdown` from the Lens doc.
- Update the section's helper text (currently "View raw on-disk files: core / unified experience /
  session_state / eval artifacts") — "unified experience" is now the DB.

Keep the two surfaces in sync: the Lens "Memory-by-Workspace" view and this Settings DB card both
read `getWorkspaceBreakdown`.

### Maintenance actions (rebuild / clear)

The same Settings page has a **Maintenance** block with four buttons. All keep their existing IPCs;
three route through experience-store verbs (now indexed `DELETE` / row inserts), and one is out of
scope:

| Button                    | IPC                       | Backend                                                                                                                                                            | Under SQLite                                                                                                           |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Rebuild current workspace | `memory.rebuildWorkspace` | `rebuildWorkspace()` ([memory-service.ts:481](../../src/main/memory/memory-service.ts)) — clears then re-ingests ([:487](../../src/main/memory/memory-service.ts)) | `DELETE WHERE source_workspace = ?` + row inserts, **in one transaction**                                              |
| Rebuild all memory        | `memory.rebuildAll`       | `rebuildAll()` ([memory-service.ts:500](../../src/main/memory/memory-service.ts))                                                                                  | same across the store; **re-stamps every row's `embedding_model`/`embedding_dim`** (the §7 model-change recovery path) |
| Clear current workspace   | `memory.clearWorkspace`   | `clearWorkspace()` → `removeBySourceWorkspace()` ([memory-service.ts:521/528](../../src/main/memory/memory-service.ts))                                            | indexed `DELETE`; follow with `VACUUM` (DB-card action) to reclaim pages                                               |
| Clear core memory         | `memory.clearCoreMemory`  | `clearCoreMemory()` ([memory-service.ts:534](../../src/main/memory/memory-service.ts))                                                                             | **unaffected** — core stays JSON (D2)                                                                                  |

Key points:

- **Rebuild = clear + re-ingest must be one transaction.** `rebuildWorkspace` clears the workspace
  then re-ingests. On the JSON store that is ≥2 whole-file writes with a window where the workspace
  is empty on disk — a crash between them leaves it cleared-but-not-repopulated. Wrapping the
  clear+reinsert in a single SQLite transaction makes rebuild **atomic and crash-safe** (and drops
  the repeated whole-file rewrites). A correctness win, not just performance.
- **"Rebuild all" and a model/provider switch are the same operation** — both delete and re-embed
  every row with the active model tag. Keep them on one code path, behind the same Settings
  save-handler prompt (§7).
- After a **Clear**, freed pages are not returned to the OS until `VACUUM` (or
  `PRAGMA incremental_vacuum`); expose it via the DB-status card's `[Vacuum]` action.
- **Clear core memory** touches `core_memory.json` only — no migration impact.

## 12. Testing

- ✅ Unit: BLOB round-trip (Float32 fidelity), `cosineSimilarity` parity `number[]` vs `Float32Array`.
- ✅ Migration: JSON fixture → backfill → assert row counts, embeddings, workspace scoping, and
  `.bak` creation; idempotent re-run is a no-op; simulated mid-transaction crash leaves the JSON
  intact.
- ⚠️ Retrieval parity: same query yields the same ranked ids/scores from JSON store vs `memory.db`
  (reuse the eval harness). **Not done as a back-to-back A/B** — the JSON store was removed in the
  same commit that added the SQLite one (`a19fc4f`), so there is no longer a reference
  implementation to diff against. Mitigated instead by: the scoring functions being moved
  verbatim (`workspaceBoost` / `recencyBoost` / `keywordOverlap` / `rankItems` are unchanged
  code), and by behavioural tests pinning the semantics most at risk from the storage swap —
  cross-workspace results still surfacing, `chunkIds` ordering preserved, semantic-only matches
  surviving the lexical pre-filter. Worth accepting as-is; reconstructing the JSON store purely
  to A/B it would cost more than it now proves.
- ✅ Staleness: covered at the service level (`isEmbeddingModelStale`) rather than per-row, per
  the §7 "As built" note — match, mismatch, embeddings-disabled, empty store, and the
  pre-recording install all asserted.
- ✅ Per-row `embedding_model`/`embedding_dim` stamping (added in `5dd814d` after the review;
  its absence is what let the stamping bug ship).

## 13. Rollout / sequencing

1. ✅ Land and stabilize the local-embeddings branch first (done — shipped 2026-07-04).
2. ✅ Ship this migration behind the existing memory init path; backfill runs once on first launch
   of the new build. No user action; `.bak` retained one release cycle, then a follow-up prunes it.
   **Done:** `memory-db-migration.ts` runs on `ensureStores()`, idempotent, crash-safe.
3. ⏳ Repoint the (future) read-only memory MCP reader at `memory.db` — it becomes simpler and
   race-free vs. reading a JSON mid-rewrite. (Pending — tracked as §16.7.)

### As-built notes (2026-07-21)

**Phase 1 (commit `a19fc4f`):** SQLite store, migration, tests.

- `memory-db.ts` — schema, WAL, `busy_timeout=5000`, `ensureColumn`, unique index on `session_id`.
- `memory-db-migration.ts` — `INSERT OR REPLACE`, workspace normalization on insert,
  timestamped `.bak` (never overwrites existing backup), crash-safe single transaction.
- `experience-memory-store.ts` — full internal rewrite; same public API; light-row cache with
  `data_version` invalidation; batch IN-clause embedding fetch (900-id batches);
  `safeDecodeEmbedding` for BLOB resilience; semantic fallback at zero lexical score;
  `replaceSessionWithMeta` for atomic session+meta commit.
- `memory-utils.ts` — `cosineSimilarity` accepts `Float32Array`; `embeddingToBlob`/`blobToEmbedding`
  with `byteLength % 4` validation.
- `memory-service.ts` — `experienceDbPath` in `MemoryPaths`; db handle lifecycle (open, close before
  rebuild); migration on init; `getExperienceDbStatus` / `exportExperienceJson` /
  `vacuumExperienceDb` / `exportExperienceJsonToFile`; `readFile` blocks binary db;
  `resolveReadablePath` allows `.bak*` artefacts; `rebuildAll` closes db before deleting files.
- 199 tests passing.

**Phase 2 (commit `2bcc076`):** IPC bridge, renderer types.

- Three new `ipcMain.handle` registrations: `memory.getExperienceDbStatus`,
  `memory.exportExperienceMemoryToFile`, `memory.vacuumExperienceDb`.
- `ExperienceDbStatus` and `ExperienceExportResult` discriminated union in `renderer/types/index.ts`.
- `storage` discriminator on `MemoryDebugFileInfo`.
- Atomic file export (temp+bak+rename); `vacuumExperienceDbQueued` always resolves with
  `{ success, error? }`.
- 202 tests passing.

**Phase 3 (commit `36a40f8`):** Settings UI — DB-status card, storage branching, i18n.

- `SettingsMemory.tsx` — section renamed "Raw File Viewer" → "Memory Storage"; the right pane
  branches on `MemoryDebugFileInfo.storage`: `file` → existing raw-JSON pane (unchanged),
  `sqlite` → new `ExperienceDbStatusCard`. The `memory.db` list entry shows a `SQLite` badge.
- `handleSelectFile` / `refreshFiles` — selecting the `memory.db` entry calls `getExperienceDbStatus`
  instead of `readFile` (which the backend refuses on the binary DB). Selection is sequenced via a
  `selectionRequestRef` token (bumped on every select/refresh/deselect) so in-flight status/file
  reads whose selection has changed are discarded — no stale content or status messages.
- `ExperienceDbStatusCard` — renders schema version · journaling mode (data-driven via
  `db.pragma('journal_mode')`, `—` on read failure) · size · session/chunk counts · embedding model
  - dim · integrity · per-workspace breakdown; actions `[Export JSON]` + `[Vacuum]`.
    `[Rebuild all]` is intentionally NOT duplicated here — it lives in the Maintenance block below.
    All fields are defensively normalized (`workspaceBreakdown ?? []`, `Number.isFinite(sizeBytes)`,
    count coalescing) so a partial IPC payload degrades gracefully instead of throwing.
- `handleVacuumExperienceDb` / `handleExportExperienceJson` — capture the selection token so a
  selection change mid-action doesn't clobber the new entry's status; export uses an
  `error`/`canceled`-explicit branch so a failure is never silently misclassified as a cancel.
- `memory-service.ts` — `getExperienceDbStatus` now also reports `journalMode` (read via PRAGMA,
  `null` on failure); field added to `ExperienceDbStatus` in both `memory-types.ts` and
  `renderer/types/index.ts`.
- i18n — 23 new keys added to all four locales (`en/zh/ru/hu`); `filesTitle`/`filesDescription`
  updated; busy-state strings use `…` to match existing `memory.*` convention.
- 216 tests passing; strengthened `getExperienceDbStatus` shape test to assert `journalMode === 'wal'`.

#### Manual QA checklist (Phase 3 — no renderer component-test infra exists)

- [ ] Settings → Memory → "Memory Storage": four entries listed; `memory.db` shows a `SQLite` badge.
- [ ] Click `core_memory.json` → raw-JSON pane; click `memory.db` → **DB-status card** (schema/mode/size/counts/model/integrity/workspace breakdown).
- [ ] Rapidly switch `memory.db` ↔ a JSON file mid-load → only the latest selection's content/status shows (stale-guard).
- [ ] Hit **Refresh** while a load is in-flight → no stale content; clearing a missing selection resets the pane.
- [ ] `[Export JSON]` → save dialog; cancel it → no error shown; complete it → success message with path.
- [ ] `[Vacuum]` → success message persists (status reload is silent); card size updates.
- [ ] Select `memory.db` when no DB exists yet (fresh install, pre-ingestion) → card shows the not-created-yet message, not "select again".
- [ ] Switch UI language (en/zh/ru/hu) → card labels translate; no raw keys shown.

**Phase 3.1 (commit `5dd814d`):** post-review fixes. Found by a code review of phases 1–3;
each was verified against a running store before being fixed.

- **Per-row `embedding_model` was stamped one ingest behind.** `replaceSessionWithMeta` wrote
  `memory_meta` _after_ `_replaceSessionInner` had already read it to tag each row, so the first
  ingest on a fresh store wrote `NULL` and every later ingest carried the _previous_ model.
  Reproduced: ingesting `model-A` then `model-B` left rows `[s1=null, s2=model-A]`. Meta is now
  stamped before the inserts, and the active model is passed down explicitly; `replaceSession`
  still falls back to meta, since it carries no fresh model of its own. No user-visible breakage
  had occurred — nothing read the column yet — but it is the substrate for D4/§7.
- **§7 model-staleness gate implemented** (see §7 "As built"). This was the one substantive part
  of the design that phases 1–3 omitted.
- **`buildPromptPrefix` emptiness check used the deprecated `sessions`/`chunks` getters**, which
  `SELECT *` and decode every embedding BLOB and transcript — on _every prompt_, defeating the
  migration's read-path goal. Now `getCounts()`.
- **Dead code removed:** `getSessionsForWorkspace`, `getChunksForWorkspace`, `deleteChunkById` —
  prepared statements left behind by the §8 deviation above, never called.
- 11 new tests (3089 → **3100 passing**): per-row stamping (first ingest, post-switch, vector-less
  rows, `embedding_dim`, `replaceSession` fallback, clearing) and `isEmbeddingModelStale`
  (match, mismatch, embeddings-disabled, empty store, pre-recording install).

## 14. Risks

| Risk                                        | Mitigation                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Backfill data loss                          | Rename (not delete) JSON to `.bak`; single transaction; idempotent guard.                                                                  |
| Float32 precision vs stored float64 JSON    | Embeddings are normalized unit vectors; Float32 is standard for on-disk vectors and ample for cosine ranking. Validate parity in tests.    |
| `better-sqlite3` native/ABI after `npm` ops | Same existing constraint as `cowork.db`; `npm run rebuild` already documented.                                                             |
| Retrieval regression                        | Eval-harness parity gate before enabling. **Not executed as designed** — see §12; scoring code moved verbatim + behavioural tests instead. |
| Custom `storageRoot` edge cases             | `memory.db` resolves via the same `getPaths()` logic + `assertSafeMemoryPaths`.                                                            |

## 15. Open questions

1. Prune `experience_memory.json.bak` after N releases, or keep until the user runs export?
2. FTS5 lexical in the same PR (phase 2) or a follow-up? (Resolved: **follow-up** — not built;
   `memory_chunks_fts` is absent from the shipped schema and lexical scoring stays in JS.)
3. Should `getStatsBySourceWorkspace` power a lightweight "memory by workspace" UI now that it's a
   cheap `GROUP BY`?

## 16. Follow-ups

Gaps found by the post-ship review. Items are resolved in place rather than deleted, so the
reasoning stays attached to the entry — including the ones closed **without** code (§16.4 measured
and declined, §16.7 not actionable). All seven are now settled: 1, 2, 3, 5, 6 shipped; 4 won't do;
7 reframed as a constraint for a feature that does not exist yet.

1. ✅ **DONE (`69a1204`) — `searchExperience` loaded full rows for a lexical scan.** It iterated
   the deprecated `store.sessions` / `store.chunks` getters, decoding every embedding BLOB and
   parsing every `raw_session` transcript to score text it then ignored — the same full-parse cost
   §1's goal #2 set out to remove, on every user-triggered search.

   Fixed by `ExperienceMemoryStore.getSearchRows(sourceWorkspace)`, which selects only the columns
   the search path maps (no `embedding`, no `raw_session`) and **pushes the workspace filter into
   SQL**. That push-down is available here precisely because scoping is a _hard_ filter in search,
   unlike the soft `workspaceBoost` that forced §8 to reject the same optimization for retrieval.

   > ⚠️ The SQL deliberately omits `OR source_workspace IS NULL`. A scoped **search** excludes
   > global rows — the pre-existing JS semantics (`null !== key`), which `WHERE source_workspace = ?`
   > reproduces since `NULL = 'x'` is NULL, not true. Copying §8's union into this path would
   > silently widen results. Pinned by an explicit regression test.

   With `buildPromptPrefix` already fixed in `5dd814d`, this removed the getters' last caller, so
   **both deprecated getters are now deleted** — the footgun is retired, not merely annotated.

2. ✅ **DONE (`03a56c8`) — light rows parsed `raw_session` for every session.** The cache is
   dropped on every write, so each ingest made the _next prompt_ re-parse every transcript in the
   store — on the main process, inside the latency budget of every message (§3 puts that at ~1 s
   at ~100 MB). This was the last piece of §1's goal #2 still outstanding.

   `raw_session` never participated in scoring — the session text selector covers summary,
   keywords, workspace and title only — and fed exactly one consumer, `rawSessionCandidates`,
   built from the ranked sessions at the very end. So the column left the light scan entirely and
   `fetchRawSessions` now pulls transcripts by id **after** ranking, bounded by `sessionTopK`
   (default 5) rather than by store size. The ranked records are hydrated in place, so both
   `rankedSessions[].rawSession` and `rawSessionCandidates` keep their previous contents.
   Side benefit: the cache no longer holds every parsed transcript in memory.

   > Testing note: five of the six new tests are contract tests that pass **both** before and
   > after — behaviour is unchanged by design, so they cannot detect a regression. The sixth is
   > deliberately white-box: it asserts no unfiltered scan of `memory_sessions` mentions
   > `raw_session`, and that the transcript is fetched by id. It was verified to fail when the
   > column is put back into the light scan. Without it, a revert to eager parsing would be
   > completely silent — the pattern is worth reusing for the remaining perf items here.

   **Discovered while doing this, still open:** `rawSessionCandidates`, `rankedChunks` and
   `rankedSessions` are declared on `ProgressiveRetrievalResult` and populated, but **no
   production code reads any of them** — `rankedChunks`/`rankedSessions` are used only as test
   handles, and the nav loop's `get_raw_session` fetches transcripts on demand via `getSession()`
   ([memory-service.ts:1251](../../src/main/memory/memory-service.ts)). The lazy hydration above
   therefore fills a field nobody consumes. Left in place rather than deleted, since removing
   fields from a public result type is a judgement call about reserved API, not a cleanup —
   worth a decision of its own.

3. ✅ **DONE (`5fcfd1b`) — `blobToEmbedding` guarded `byteLength % 4` but not `byteOffset % 4`.**
   Still verified unreachable through better-sqlite3, which returns `byteOffset === 0` for every
   BLOB (probed over 200 rows of varying size) — so this was hardening, not a live bug. It was
   worth closing anyway because of the asymmetry: the store swallows decode failures via
   `safeDecodeEmbedding`, while `exportExperienceJson` decodes with no `try/catch`, so one sliced
   or pooled `Buffer` reaching that path would have thrown mid-export. Fixed at the source rather
   than by adding a second `try/catch`: on an unaligned offset the bytes are copied into a fresh
   `ArrayBuffer`, which is offset 0 by construction.
4. ❌ **WON'T DO — hand the `Float32Array` view straight to the scorer.** `blobToEmbedding`
   returns `Array.from(f32)`, so the widened `cosineSimilarity` signature is never exercised in
   production. §8's intent was to skip that per-candidate `number[]` materialization. Measured
   before deciding — 500 candidates × 768 dims, per query:

   | Operation                            | Time         |
   | ------------------------------------ | ------------ |
   | decode: `Array.from(view)` — today   | **3.984 ms** |
   | decode: view, no copy — proposed     | **0.015 ms** |
   | score: `number[] × number[]` — today | 0.238 ms     |
   | score: `Float32Array × Float32Array` | **0.767 ms** |

   Net ≈ **3.4 ms/query saved at 500 candidates**. Two things that changes:
   - **§8's premise is half wrong.** The whole win is in not copying (3.984 → 0.015 ms). Scoring a
     `Float32Array` is ~3× _slower_ than scoring a `number[]` — every read converts float32→float64
     — so handing the view to the scorer gives back ~15% of the gain it just won.
   - **The absolute number is small where the path actually runs.** `SEMANTIC_CAP` defaults to
     `max(chunkTopK, sessionTopK) × 5` = **50** candidates, i.e. ~0.34 ms/query — below perception.
     500 only occurs in the semantic-fallback branch (all lexical scores zero). For scale: §16.2
     removed ~1 s of transcript parsing from this same path, so this is ~0.3% of that.

   Against that: widening the item types to `number[] | Float32Array` reaches into the export and
   migration paths, and `JSON.stringify(new Float32Array([0.1]))` yields `{"0":0.1}` rather than
   `[0.1]` — a leak would silently corrupt exports. Trading a sub-millisecond win for a
   silent-data-corruption class of bug is a bad deal.

   The widened `cosineSimilarity` signature **stays**: it is correct and covered by parity tests,
   and unlike the deprecated getters it is not a footgun — merely unused.

   **If this path ever does become a bottleneck**, the arithmetic is the better target, not the
   copy: §14 states embeddings are normalized unit vectors, so cosine degenerates to a dot product
   and two of the three accumulator loops plus both `sqrt` calls disappear. That needs the
   normalization claim verified **per provider** first (true for OpenAI; depends on the pooling /
   normalize settings for local EmbeddingGemma), but it touches neither the types, the export, nor
   the migration.

5. ✅ **DONE (`5fcfd1b`) — `ensureColumn`'s validator did not actually validate.** It
   prefix-matched `ALLOWED_COLUMN_TYPES` and then interpolated the remainder verbatim into a
   `db.exec()`, which executes multiple statements. So
   `probe TEXT NOT NULL DEFAULT ''; DROP TABLE memory_chunks; --` passed the check — confirmed by
   running the payload against the old implementation, which accepted it and dropped the table.

   Not a live vulnerability: every call site is a hardcoded constant, and nothing routes user
   input here. But "the guard is fine because no caller abuses it" is an argument that expires the
   moment someone adds a caller. Replaced with a single end-anchored pattern covering the whole
   definition, `DEFAULT` literals limited to a quoted string, a number, or `NULL`. `ensureColumn`
   is now exported so the rejection is testable.

6. ✅ **DONE (`5fcfd1b`) — `memory-system-architecture.md` still described the JSON store.**
   The storage tree now shows `memory.db` (plus its WAL sidecars and the `.bak` artefact). Four
   further stale references were found beyond the tree and fixed in the same pass: the layer table
   at the top, the extraction-pipeline diagram, the ingestion flow, and the staleness paragraph —
   which now points at `memory_meta.embedding_format_version` and cross-references §7 for the
   separate model-change signal.
7. **Not actionable yet — note for whoever builds the memory MCP reader.** There is no such
   reader in the codebase today ([src/main/mcp/](../../src/main/mcp/) has the gui-operate server,
   config store and manager, nothing for memory), so this is not a task that can be picked up: it
   is a constraint to honour when that feature is designed. When it is: point it at `memory.db`
   rather than the JSON — it is simpler and race-free versus reading a file mid-rewrite — and have
   it assert per-row `embedding_model`, which it can afford and which §7's O(1) service-level gate
   deliberately skips.

## 17. Verification plan (manual)

Scope: what the automated suite **cannot** reach. The 3119 unit/integration tests already cover
BLOB round-trip, migration idempotency on fixtures, workspace scoping, lazy hydration and the
column-definition guard — re-checking those by hand buys nothing. What follows targets real data,
real UI, and real latency.

Run order matters: **§0 first**, then A. B–F are independent.

### 0. Back up first (mandatory)

The backfill runs once, against a real store.

```bash
cp -R ~/Library/Application\ Support/sqowe-pilot/memory \
      ~/Desktop/memory-backup-$(date +%Y%m%d)
```

Record the baseline to compare against:

```bash
python3 -c "
import json,os; p=os.path.expanduser('~/Library/Application Support/sqowe-pilot/memory/experience_memory.json')
d=json.load(open(p)); print('sessions:', len(d['sessions']), 'chunks:', len(d['chunks']))
print('chunks with embedding:', sum(1 for c in d['chunks'] if c.get('embedding')))"
```

### A. Migration against real data — the highest risk

| #   | Step                                                                                                                                              | Expected                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A1  | Launch the build, then **open Settings → Memory** (or send a message) — see §9: the migration is lazy, so nothing happens until memory is touched | `memory.db` appears; `experience_memory.json` → `.bak`                      |
| A2  | Compare the DB-status card against the §0 baseline                                                                                                | session/chunk counts match exactly                                          |
| A3  | Same card                                                                                                                                         | integrity `ok`; embedding model and dim populated; workspace breakdown sane |
| A4  | Restart the app                                                                                                                                   | no re-migration: `migrated_at` unchanged, no second `.bak`                  |
| A5  | `Export JSON`, diff against `.bak`                                                                                                                | same ids, same vector dimensions                                            |

**Rollback if anything is wrong:** quit the app → delete `memory.db*` → rename `.bak` back to
`experience_memory.json`.

Useful for A2/A3 — aggregates only, no content:

```bash
DB=~/Library/Application\ Support/sqowe-pilot/memory/memory.db
sqlite3 "$DB" "SELECT key, value FROM memory_meta;"
sqlite3 "$DB" "SELECT COALESCE(embedding_model,'(none)'), COALESCE(embedding_dim,-1), COUNT(*) \
               FROM memory_chunks GROUP BY 1,2;"
sqlite3 "$DB" "PRAGMA quick_check;"
```

Logs are under `<userData>/logs/`, **not** `~/Library/Logs/`:

```bash
grep -h "MemoryMigration" ~/Library/Application\ Support/sqowe-pilot/logs/*.log | tail -20
```

### B. Retrieval parity — this is what `.bak` is for

There was never a back-to-back A/B against the JSON store (§12), so the `.bak` is the only
reference for "what memory used to know". Keep it until this block passes.

- **B1.** Ask 3–5 questions whose answers are definitely in old memory → the right sessions surface.
- **B2.** Search in Settings → Memory for a term from an old session → it is found.
- **B3.** **The NULL trap.** In a workspace-scoped search, a record with `source_workspace = null`
  (global) must **not** appear. This is the one place the implementation deliberately diverges from
  §8, and the failure would be silent.
- **B4.** Open a session from another workspace → `read_workspace_chat` returns the full transcript
  (lazy hydration, §16.2, on real data).

### C. Model-staleness gate (§7) — new behaviour

- **C1.** Settings → Memory → change the embedding model → save.
- **C2.** The amber rebuild banner appears.
- **C3.** **Without** rebuilding, ask a question → memory still returns lexical matches, no semantic
  ranking. The log shows `falling back to lexical-only retrieval` **once**, not per prompt.
- **C4.** `Rebuild all` → banner clears, semantic ranking returns.
- **C5.** Restore the original model (otherwise the index is left rebuilt on a model you did not want).

### D. Settings UI

Covered by the Phase 3 checklist in §13 — badge, pane switching, selection race, export cancel,
vacuum, four locales. Not duplicated here.

### E. Latency — checking our own claims

- **E1.** End a session (triggers ingest) → no UI stall. This used to be a synchronous whole-file
  `writeFileSync`.
- **E2.** Send a prompt immediately after that ingest → no perceptible pause. This is precisely the
  case where the cache has been dropped and every transcript used to be re-parsed (§16.2).
- **E3.** `Vacuum` after `Clear workspace` → the size on the card drops.

### F. Edge cases

- **F1.** Fresh profile (rename the `memory` folder away) → app starts; the card shows the
  not-created-yet message rather than an error.
- **F2.** Change `storageRoot` in settings → `memory.db` moves with the rest of memory (the whole
  point of §5's decision not to fold it into `cowork.db`).
- **F3.** Disable memory → ingestion and auto-recall stop; existing data is untouched.

**If time is short:** all of A, plus B1 and B3. A because it is irreversible; B3 because it is the
one deliberate divergence from the design and it fails silently.

### First run — results (2026-07-22)

A1–A3 executed against a real 36.4 MB store. Migration faithful: `.bak` holds 117 sessions / 443
chunks, `memory.db` reports the same; 23 chunks + 6 sessions carry 1024-dim vectors in both, so
nothing was dropped. `quick_check` → `ok`, `migrated_from = experience_memory.json`.

Two things this surfaced, neither caused by the migration:

- **Only ~5% of the store has embeddings** (23/443 chunks, 6/117 sessions). Pre-existing, and
  invisible while the data sat in one large JSON. `embedText` swallows provider failures and
  returns `[]` ([memory-service.ts](../../src/main/memory/memory-service.ts)), so a misconfigured
  or unreachable embedding provider silently ingests sessions with no vector. Worth confirming
  whether a `Rebuild all` restores coverage; if it comes back 23/443, embeddings are failing _now_
  and that is its own investigation.
- **The disk win is ~4%, not ~4×** — see the note in §6. Nothing is wrong; the store is
  transcript-dominated, not embedding-dominated.

A4 (restart, no re-migration) and A5 (export vs `.bak`) not yet run.
