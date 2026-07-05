# Experience Memory → SQLite Storage Migration — Design

**Status:** Proposed (not started)
**Date:** 2026-07-03
**Owner:** @obodnikov
**Related:** [memory-system-architecture.md](memory-system-architecture.md),
[local-embeddings-default.md](local-embeddings-default.md),
[experience-memory-store.ts](../../src/main/memory/experience-memory-store.ts),
[database.ts](../../src/main/db/database.ts),
[memory-service.ts](../../src/main/memory/memory-service.ts),
[memory-lens-panel.md](memory-lens-panel.md)
**Prior discussion:** conversation of 2026-07-03 (MCP-access + storage sizing thread)

> Note: [memory-system-architecture.md §5](memory-system-architecture.md) still lists the
> storage root as `~/.open-cowork/memory/`. That is **stale** — the code default is
> `path.join(app.getPath('userData'), 'memory')` ([memory-service.ts:1211](../../src/main/memory/memory-service.ts)),
> i.e. `<userData>/sqowe-pilot/memory/` post-rebrand. Fix that doc alongside this work.

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
- ~4 KB per 768-dim vector as Float32 BLOB vs. ~18 KB as JSON text → **~4× smaller on disk**.

## 7. Homogeneous store & staleness (D5)

Cosine is only meaningful within one embedding space, and there is **no default model today** —
each install's dimension is whatever the user configured (1536 OpenAI, 1024 bge-m3, 768 local,
Ollama-various, or none). So at any moment the store holds **one** model's vectors.

- On load/query, assert every candidate row's `embedding_model` equals the active embedding
  config. On mismatch → treat as a stale index: fall back to lexical-only retrieval and surface
  the existing "rebuild memory index" prompt
  (`rebuildAll` / `rebuildWorkspace`, [memory-service.ts](../../src/main/memory/memory-service.ts);
  [local-embeddings-default.md §8](local-embeddings-default.md)).
- This makes the implicit "changing the model invalidates the index" rule **explicit and safe**,
  and lets the future MCP reader refuse to semantic-search vectors built with a different model
  instead of returning garbage.

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
- **Save → upsert.** `replaceSession` / `removeSession` / `removeBySourceWorkspace` become
  transactional `INSERT … ON CONFLICT` / `DELETE`, eliminating whole-file rewrites.
- **Lexical (optional, phase 2 of this migration).** Move the lexical half to `memory_chunks_fts`
  (FTS5) and combine with the JS vector score, keeping the same weighting. Ship phase 1 with
  lexical still in JS to de-risk.
- `cosineSimilarity` / `lexicalScore` in [memory-utils.ts](../../src/main/memory/memory-utils.ts)
  gain `Float32Array` support (currently `number[]`).

## 9. Migration / backfill

One-time, idempotent, on app start (after `storageRoot` is resolved, before memory serves reads):

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

- Unit: BLOB round-trip (Float32 fidelity), `cosineSimilarity` parity `number[]` vs `Float32Array`.
- Migration: JSON fixture → backfill → assert row counts, embeddings, workspace scoping, and
  `.bak` creation; idempotent re-run is a no-op; simulated mid-transaction crash leaves the JSON
  intact.
- Retrieval parity: same query yields the same ranked ids/scores from JSON store vs `memory.db`
  (reuse the eval harness).
- Staleness: rows tagged with a non-active `embedding_model` fall back to lexical-only + rebuild
  prompt.

## 13. Rollout / sequencing

1. Land and stabilize the local-embeddings branch first (don't destabilize an in-flight change).
2. Ship this migration behind the existing memory init path; backfill runs once on first launch of
   the new build. No user action; `.bak` retained one release cycle, then a follow-up prunes it.
3. Repoint the (future) read-only memory MCP reader at `memory.db` — it becomes simpler and
   race-free vs. reading a JSON mid-rewrite.

## 14. Risks

| Risk                                        | Mitigation                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Backfill data loss                          | Rename (not delete) JSON to `.bak`; single transaction; idempotent guard.                                                               |
| Float32 precision vs stored float64 JSON    | Embeddings are normalized unit vectors; Float32 is standard for on-disk vectors and ample for cosine ranking. Validate parity in tests. |
| `better-sqlite3` native/ABI after `npm` ops | Same existing constraint as `cowork.db`; `npm run rebuild` already documented.                                                          |
| Retrieval regression                        | Eval-harness parity gate before enabling.                                                                                               |
| Custom `storageRoot` edge cases             | `memory.db` resolves via the same `getPaths()` logic + `assertSafeMemoryPaths`.                                                         |

## 15. Open questions

1. Prune `experience_memory.json.bak` after N releases, or keep until the user runs export?
2. FTS5 lexical in the same PR (phase 2) or a follow-up? (Recommend follow-up.)
3. Should `getStatsBySourceWorkspace` power a lightweight "memory by workspace" UI now that it's a
   cheap `GROUP BY`?
