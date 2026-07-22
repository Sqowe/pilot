import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ChunkMemoryItem,
  FocusedChunkItem,
  MemoryTranscriptTurn,
  ProgressiveRetrievalResult,
  RawSessionCandidateItem,
  SessionContextItem,
  SessionMemoryItem,
} from './memory-types';
import {
  blobToEmbedding,
  cosineSimilarity,
  embeddingToBlob,
  lexicalScore,
  normalizeWorkspaceKey,
} from './memory-utils';
import { getMemoryMeta, setMemoryMeta } from './memory-db';

// ---------------------------------------------------------------------------
// Row shapes returned by better-sqlite3
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  session_id: string;
  source_workspace: string | null;
  source_workspace_label: string | null;
  source_session_id: string | null;
  source_session_title: string | null;
  source_session_date: string | null;
  summary: string;
  keywords: string;
  chunk_ids: string;
  raw_session: string | null;
  session_date: string | null;
  created_at: string | null;
  ingested_at: string | null;
  embedding: Buffer | null;
  embedding_model: string | null;
  embedding_dim: number | null;
}

interface ChunkRow {
  id: string;
  session_id: string;
  source_workspace: string | null;
  source_workspace_label: string | null;
  source_session_id: string | null;
  source_session_title: string | null;
  source_session_date: string | null;
  summary: string;
  details: string;
  keywords: string;
  source_turns: string;
  raw_text: string;
  session_date: string | null;
  created_at: string | null;
  ingested_at: string | null;
  embedding: Buffer | null;
  embedding_model: string | null;
  embedding_dim: number | null;
}

/**
 * Rows shaped for lexical search (`MemoryRetriever.searchExperience`): exactly the
 * fields that path reads, and nothing else — no `embedding` BLOB and no
 * `raw_session` transcript, neither of which lexical search touches.
 */
export interface ExperienceSessionSearchRow {
  sessionId: string;
  sourceWorkspace: string | null;
  sourceWorkspaceLabel?: string;
  sourceSessionId: string;
  sourceSessionTitle?: string;
  summary: string;
  keywords: string[];
  createdAt: string;
  ingestedAt: string;
}

export interface ExperienceChunkSearchRow extends ExperienceSessionSearchRow {
  id: string;
  details: string;
  rawText: string;
}

// Lightweight row for lexical pre-filtering — no BLOB embedding decoding.
interface ChunkRowLight {
  id: string;
  session_id: string;
  source_workspace: string | null;
  source_workspace_label: string | null;
  source_session_id: string | null;
  source_session_title: string | null;
  source_session_date: string | null;
  summary: string;
  details: string;
  keywords: string;
  source_turns: string;
  raw_text: string;
  session_date: string | null;
  created_at: string | null;
  ingested_at: string | null;
  // embedding intentionally omitted
}

interface SessionRowLight {
  id: string;
  session_id: string;
  source_workspace: string | null;
  source_workspace_label: string | null;
  source_session_id: string | null;
  source_session_title: string | null;
  source_session_date: string | null;
  summary: string;
  keywords: string;
  chunk_ids: string;
  session_date: string | null;
  created_at: string | null;
  ingested_at: string | null;
  // embedding and raw_session intentionally omitted — see getLightRows
}

function rowLightToChunkNoEmbed(
  row: ChunkRowLight
): Omit<ChunkMemoryItem, 'embedding'> & { embedding: never[] } {
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceWorkspace: row.source_workspace ?? null,
    sourceWorkspaceLabel: row.source_workspace_label ?? undefined,
    sourceSessionId: row.source_session_id ?? row.session_id,
    sourceSessionTitle: row.source_session_title ?? undefined,
    sourceSessionDate: row.source_session_date ?? undefined,
    summary: row.summary,
    details: row.details,
    keywords: parseJsonArray(row.keywords),
    sourceTurns: parseNumberArray(row.source_turns),
    rawText: row.raw_text,
    sessionDate: row.session_date ?? '',
    createdAt: row.created_at ?? '',
    ingestedAt: row.ingested_at ?? '',
    embedding: [],
  };
}

function rowLightToSessionNoEmbed(
  row: SessionRowLight
): Omit<SessionMemoryItem, 'embedding'> & { embedding: never[] } {
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceWorkspace: row.source_workspace ?? null,
    sourceWorkspaceLabel: row.source_workspace_label ?? undefined,
    sourceSessionId: row.source_session_id ?? row.session_id,
    sourceSessionTitle: row.source_session_title ?? undefined,
    sourceSessionDate: row.source_session_date ?? undefined,
    summary: row.summary,
    keywords: parseJsonArray(row.keywords),
    chunkIds: parseJsonArray(row.chunk_ids),
    // Transcripts are hydrated lazily, for the ranked top-K only — see retrieveProgressive.
    rawSession: [],
    sessionDate: row.session_date ?? '',
    createdAt: row.created_at ?? '',
    ingestedAt: row.ingested_at ?? '',
    embedding: [],
  };
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === 'number')
      : [];
  } catch {
    return [];
  }
}

function parseRawSession(value: string | null): MemoryTranscriptTurn[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((turn): MemoryTranscriptTurn | null => {
        if (!turn || typeof turn !== 'object') return null;
        const t = turn as Record<string, unknown>;
        const normalized: MemoryTranscriptTurn = {
          role: typeof t.role === 'string' ? t.role : 'unknown',
          content: typeof t.content === 'string' ? t.content : '',
        };
        if (typeof t.messageId === 'string') normalized.messageId = t.messageId;
        if (typeof t.timestamp === 'number') normalized.timestamp = t.timestamp;
        return normalized;
      })
      .filter((t): t is MemoryTranscriptTurn => t !== null);
  } catch {
    return [];
  }
}

/** Safely decode a BLOB embedding, returning [] on corruption rather than throwing. */
function safeDecodeEmbedding(blob: Buffer | null): number[] {
  if (!blob || blob.byteLength === 0) return [];
  try {
    return blobToEmbedding(blob);
  } catch {
    return [];
  }
}

function rowToSession(row: SessionRow): SessionMemoryItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceWorkspace: row.source_workspace ?? null,
    sourceWorkspaceLabel: row.source_workspace_label ?? undefined,
    sourceSessionId: row.source_session_id ?? row.session_id,
    sourceSessionTitle: row.source_session_title ?? undefined,
    sourceSessionDate: row.source_session_date ?? undefined,
    summary: row.summary,
    keywords: parseJsonArray(row.keywords),
    chunkIds: parseJsonArray(row.chunk_ids),
    rawSession: parseRawSession(row.raw_session),
    sessionDate: row.session_date ?? '',
    createdAt: row.created_at ?? '',
    ingestedAt: row.ingested_at ?? '',
    embedding: safeDecodeEmbedding(row.embedding),
  };
}

function rowToChunk(row: ChunkRow): ChunkMemoryItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceWorkspace: row.source_workspace ?? null,
    sourceWorkspaceLabel: row.source_workspace_label ?? undefined,
    sourceSessionId: row.source_session_id ?? row.session_id,
    sourceSessionTitle: row.source_session_title ?? undefined,
    sourceSessionDate: row.source_session_date ?? undefined,
    summary: row.summary,
    details: row.details,
    keywords: parseJsonArray(row.keywords),
    sourceTurns: parseNumberArray(row.source_turns),
    rawText: row.raw_text,
    sessionDate: row.session_date ?? '',
    createdAt: row.created_at ?? '',
    ingestedAt: row.ingested_at ?? '',
    embedding: safeDecodeEmbedding(row.embedding),
  };
}

// ---------------------------------------------------------------------------
// Scoring helpers (unchanged from the JSON store)
// ---------------------------------------------------------------------------

function workspaceBoost(currentWorkspace: string | null, sourceWorkspace?: string | null): number {
  if (!currentWorkspace) {
    return sourceWorkspace ? 0 : -0.03;
  }
  if (sourceWorkspace === currentWorkspace) {
    return 0.3;
  }
  if (!sourceWorkspace) {
    return -0.04;
  }
  return 0;
}

function recencyBoost(
  ingestedAt: string,
  now = Date.now(),
  floor = 0.05,
  ceiling = 0.25,
  decayDays = 90
): number {
  const timestamp = Date.parse(ingestedAt);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
  return floor + (ceiling - floor) * Math.max(0, 1 - ageDays / decayDays);
}

function keywordOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b.map((k) => k.toLowerCase()));
  let matches = 0;
  for (const keyword of a) {
    if (setB.has(keyword.toLowerCase())) matches++;
  }
  return matches / Math.max(a.length, b.length);
}

// ---------------------------------------------------------------------------
// ExperienceMemoryStore — SQLite-backed, same public API as the JSON store
// ---------------------------------------------------------------------------

export class ExperienceMemoryStore {
  private readonly db: Database.Database;
  private readonly dbPath: string;

  // Prepared statements (lazy-initialised once on first use)
  private stmts: ReturnType<typeof ExperienceMemoryStore.buildStatements> | null = null;

  // Light-row cache: avoids full-table scans on every retrieveProgressive() call.
  // Invalidated on every write (replaceSession, removeSession, removeBySourceWorkspace, clear).
  // NOTE: This cache assumes this ExperienceMemoryStore instance is the only writer
  // to the database. The data_version pragma is checked to detect unexpected external
  // writes and invalidate accordingly.
  private lightCache: {
    chunks: ReturnType<typeof rowLightToChunkNoEmbed>[];
    sessions: ReturnType<typeof rowLightToSessionNoEmbed>[];
    dataVersion: number;
  } | null = null;

  private invalidateCache(): void {
    this.lightCache = null;
  }

  private getLightRows(): {
    chunks: ReturnType<typeof rowLightToChunkNoEmbed>[];
    sessions: ReturnType<typeof rowLightToSessionNoEmbed>[];
  } {
    // Check SQLite data_version to detect external writes (e.g., another process).
    const currentVersion =
      (this.db.pragma('data_version') as Array<{ data_version: number }>)[0]?.data_version ?? 0;
    if (this.lightCache && this.lightCache.dataVersion !== currentVersion) {
      this.lightCache = null;
    }
    if (!this.lightCache) {
      const stmts = this.getStmts();
      this.lightCache = {
        chunks: (stmts.getAllChunksLight.all() as ChunkRowLight[]).map(rowLightToChunkNoEmbed),
        sessions: (stmts.getAllSessionsLight.all() as SessionRowLight[]).map(
          rowLightToSessionNoEmbed
        ),
        dataVersion: currentVersion,
      };
    }
    return this.lightCache;
  }

  constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  private getStmts() {
    if (!this.stmts) {
      this.stmts = ExperienceMemoryStore.buildStatements(this.db);
    }
    return this.stmts;
  }

  private static buildStatements(db: Database.Database) {
    return {
      getSessionBySessionId: db.prepare<[string]>(
        `SELECT * FROM memory_sessions WHERE session_id = ?`
      ),
      getChunkById: db.prepare<[string]>(`SELECT * FROM memory_chunks WHERE id = ?`),
      getChunksBySessionId: db.prepare<[string]>(
        `SELECT * FROM memory_chunks WHERE session_id = ? ORDER BY rowid ASC`
      ),
      // raw_session is deliberately absent: it is the largest column by far, and the
      // scan only needs text to score. Transcripts are fetched by id for the ranked
      // top-K afterwards (see retrieveProgressive), not for every row on every rebuild.
      getAllSessionsLight: db.prepare(
        `SELECT id, session_id, source_workspace, source_workspace_label,
                source_session_id, source_session_title, source_session_date,
                summary, keywords, chunk_ids,
                session_date, created_at, ingested_at
           FROM memory_sessions`
      ),
      getAllChunksLight: db.prepare(
        `SELECT id, session_id, source_workspace, source_workspace_label,
                source_session_id, source_session_title, source_session_date,
                summary, details, keywords, source_turns, raw_text,
                session_date, created_at, ingested_at
           FROM memory_chunks`
      ),
      // Search rows: no embedding BLOB, no raw_session transcript.
      // The `ForWorkspace` variants push what is a *hard* filter in the search path
      // into SQL. Note the absence of `OR source_workspace IS NULL`: a scoped search
      // deliberately excludes global rows (see getSearchRows).
      searchSessions: db.prepare(
        `SELECT session_id, source_workspace, source_workspace_label, source_session_id,
                source_session_title, summary, keywords, created_at, ingested_at
           FROM memory_sessions`
      ),
      searchSessionsForWorkspace: db.prepare<[string]>(
        `SELECT session_id, source_workspace, source_workspace_label, source_session_id,
                source_session_title, summary, keywords, created_at, ingested_at
           FROM memory_sessions WHERE source_workspace = ?`
      ),
      searchChunks: db.prepare(
        `SELECT id, session_id, source_workspace, source_workspace_label, source_session_id,
                source_session_title, summary, details, keywords, raw_text,
                created_at, ingested_at
           FROM memory_chunks`
      ),
      searchChunksForWorkspace: db.prepare<[string]>(
        `SELECT id, session_id, source_workspace, source_workspace_label, source_session_id,
                source_session_title, summary, details, keywords, raw_text,
                created_at, ingested_at
           FROM memory_chunks WHERE source_workspace = ?`
      ),
      deleteSessionBySessionId: db.prepare<[string]>(
        `DELETE FROM memory_sessions WHERE session_id = ?`
      ),
      deleteChunksBySessionId: db.prepare<[string]>(
        `DELETE FROM memory_chunks WHERE session_id = ?`
      ),
      deleteSessionsByWorkspace: db.prepare<[string]>(
        `DELETE FROM memory_sessions WHERE source_workspace = ?`
      ),
      deleteChunksByWorkspace: db.prepare<[string]>(
        `DELETE FROM memory_chunks WHERE source_workspace = ?`
      ),
      countSessions: db.prepare<[]>(`SELECT COUNT(*) as n FROM memory_sessions`),
      countChunks: db.prepare<[]>(`SELECT COUNT(*) as n FROM memory_chunks`),
      countSessionsWithEmbedding: db.prepare<[]>(
        `SELECT COUNT(*) as n FROM memory_sessions WHERE embedding IS NOT NULL AND length(embedding) > 0`
      ),
      countChunksWithEmbedding: db.prepare<[]>(
        `SELECT COUNT(*) as n FROM memory_chunks WHERE embedding IS NOT NULL AND length(embedding) > 0`
      ),
      // Backfill selection: a row needs (re-)embedding when it has no vector at
      // all, or when its vector came from a different model than the active one.
      // Cosine similarity is only meaningful within one embedding space, so a
      // model change invalidates the vector as surely as its absence — see
      // MemoryService.isEmbeddingModelStale (design D5: the store is homogeneous).
      countChunksNeedingEmbedding: db.prepare<[string | null]>(
        `SELECT COUNT(*) as n FROM memory_chunks
         WHERE embedding IS NULL OR length(embedding) = 0
            OR embedding_model IS NOT ?`
      ),
      countSessionsNeedingEmbedding: db.prepare<[string | null]>(
        `SELECT COUNT(*) as n FROM memory_sessions
         WHERE embedding IS NULL OR length(embedding) = 0
            OR embedding_model IS NOT ?`
      ),
      selectChunksNeedingEmbedding: db.prepare<[string | null]>(
        `SELECT id, summary, details, keywords FROM memory_chunks
         WHERE embedding IS NULL OR length(embedding) = 0
            OR embedding_model IS NOT ?
         ORDER BY ingested_at`
      ),
      selectSessionsNeedingEmbedding: db.prepare<[string | null]>(
        `SELECT id, summary, keywords FROM memory_sessions
         WHERE embedding IS NULL OR length(embedding) = 0
            OR embedding_model IS NOT ?
         ORDER BY ingested_at`
      ),
      updateChunkEmbedding: db.prepare<[Buffer, string | null, number, string]>(
        `UPDATE memory_chunks SET embedding = ?, embedding_model = ?, embedding_dim = ? WHERE id = ?`
      ),
      updateSessionEmbedding: db.prepare<[Buffer, string | null, number, string]>(
        `UPDATE memory_sessions SET embedding = ?, embedding_model = ?, embedding_dim = ? WHERE id = ?`
      ),
      statsGroupByWorkspace: db.prepare(`
        SELECT 'session' as kind, source_workspace, COUNT(*) as cnt FROM memory_sessions GROUP BY source_workspace
        UNION ALL
        SELECT 'chunk' as kind, source_workspace, COUNT(*) as cnt FROM memory_chunks GROUP BY source_workspace
      `),
      insertSession: db.prepare(`
        INSERT OR REPLACE INTO memory_sessions (
          id, session_id, source_workspace, source_workspace_label,
          source_session_id, source_session_title, source_session_date,
          summary, keywords, chunk_ids, raw_session,
          session_date, created_at, ingested_at,
          embedding, embedding_model, embedding_dim
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertChunk: db.prepare(`
        INSERT OR REPLACE INTO memory_chunks (
          id, session_id, source_workspace, source_workspace_label,
          source_session_id, source_session_title, source_session_date,
          summary, details, keywords, source_turns, raw_text,
          session_date, created_at, ingested_at,
          embedding, embedding_model, embedding_dim
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    };
  }

  // ---------------------------------------------------------------------------
  // Public API — identical to the former JSON store
  // ---------------------------------------------------------------------------

  getPath(): string {
    return this.dbPath;
  }

  getSession(sessionId: string): SessionMemoryItem | undefined {
    const row = this.getStmts().getSessionBySessionId.get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  getChunk(chunkId: string): ChunkMemoryItem | undefined {
    const row = this.getStmts().getChunkById.get(chunkId) as ChunkRow | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  getChunksBySession(sessionId: string): ChunkMemoryItem[] {
    const session = this.getSession(sessionId);
    if (!session) {
      // Preserve prior behavior: missing session returns empty array.
      return [];
    }
    if (!session.chunkIds.length) {
      return [];
    }
    // Preserve session.chunkIds ordering (stable, insertion-derived) to match
    // the prior JSON store's behaviour.
    const rows = (this.getStmts().getChunksBySessionId.all(sessionId) as ChunkRow[]).map(
      rowToChunk
    );
    const byId = new Map(rows.map((c) => [c.id, c]));
    const ordered = session.chunkIds
      .map((id) => byId.get(id))
      .filter((c): c is ChunkMemoryItem => c !== undefined);
    // Append any rows not referenced in chunkIds (shouldn't happen, but be safe).
    const referenced = new Set(session.chunkIds);
    for (const row of rows) {
      if (!referenced.has(row.id)) ordered.push(row);
    }
    return ordered;
  }

  getStatsBySourceWorkspace(): Array<{
    workspaceKey: string;
    sessionCount: number;
    chunkCount: number;
  }> {
    const rows = this.getStmts().statsGroupByWorkspace.all() as Array<{
      kind: string;
      source_workspace: string | null;
      cnt: number;
    }>;

    const stats = new Map<
      string,
      { workspaceKey: string; sessionCount: number; chunkCount: number }
    >();
    for (const row of rows) {
      const key = row.source_workspace ?? '(none)';
      const entry = stats.get(key) ?? { workspaceKey: key, sessionCount: 0, chunkCount: 0 };
      if (row.kind === 'session') entry.sessionCount += row.cnt;
      else entry.chunkCount += row.cnt;
      stats.set(key, entry);
    }
    return [...stats.values()].sort(
      (a, b) => b.sessionCount + b.chunkCount - (a.sessionCount + a.chunkCount)
    );
  }

  /**
   * Atomically replace a session+chunks AND stamp embedding meta in the same
   * SQLite transaction, so a crash can never leave embeddings present with
   * stale/missing meta.
   */
  replaceSessionWithMeta(
    sessionId: string,
    sessionInput: Omit<SessionMemoryItem, 'id'> & { id?: string },
    chunkInputs: Array<Omit<ChunkMemoryItem, 'id'> & { id?: string }>,
    meta: { embeddingModel: string | null; embeddingFormatVersion: number }
  ): SessionMemoryItem {
    const stmts = this.getStmts();

    const doReplace = this.db.transaction(() => {
      // Stamp meta BEFORE inserting rows: _replaceSessionInner stamps each row's
      // embedding_model, and the caller-supplied model is the authoritative value
      // for the vectors being written now. Writing meta afterwards would leave every
      // row tagged with the *previous* ingest's model (and NULL on a fresh store).
      // Explicitly set or clear embedding_model so meta never stays stale.
      setMemoryMeta(this.db, 'embedding_model', meta.embeddingModel ?? '');
      setMemoryMeta(this.db, 'embedding_format_version', String(meta.embeddingFormatVersion));
      return this._replaceSessionInner(
        stmts,
        sessionId,
        sessionInput,
        chunkInputs,
        meta.embeddingModel ?? null
      );
    });

    const session = doReplace();
    this.invalidateCache();
    return session;
  }

  replaceSession(
    sessionId: string,
    sessionInput: Omit<SessionMemoryItem, 'id'> & { id?: string },
    chunkInputs: Array<Omit<ChunkMemoryItem, 'id'> & { id?: string }>
  ): SessionMemoryItem {
    const stmts = this.getStmts();
    const session = this.db.transaction(() =>
      this._replaceSessionInner(stmts, sessionId, sessionInput, chunkInputs)
    )();
    this.invalidateCache();
    return session;
  }

  /**
   * @param embeddingModel Model tag to stamp on rows carrying a vector. Pass the
   *   caller's active model when known; `undefined` falls back to the value already
   *   recorded in memory_meta (correct for `replaceSession`, which has no fresh
   *   model information of its own).
   */
  private _replaceSessionInner(
    stmts: ReturnType<typeof ExperienceMemoryStore.buildStatements>,
    sessionId: string,
    sessionInput: Omit<SessionMemoryItem, 'id'> & { id?: string },
    chunkInputs: Array<Omit<ChunkMemoryItem, 'id'> & { id?: string }>,
    embeddingModel?: string | null
  ): SessionMemoryItem {
    // Normalize workspace keys at the persistence boundary so SQL filtering,
    // stats grouping, and removeBySourceWorkspace all use the same canonical form.
    // Guard against null/undefined — normalizeWorkspaceKey returns null for falsy input.
    const normalizedWorkspace = sessionInput.sourceWorkspace
      ? normalizeWorkspaceKey(sessionInput.sourceWorkspace)
      : null;

    // Enforce sessionId consistency: always use the argument sessionId so that
    // the delete and insert target the same row, regardless of what sessionInput carries.
    const canonicalSessionId = sessionId;

    // Resolve the model to stamp on rows: prefer the caller's active model, else
    // fall back to whatever meta already records.
    const activeEmbeddingModel =
      embeddingModel !== undefined
        ? embeddingModel || null
        : getMemoryMeta(this.db, 'embedding_model') || null;

    // Remove existing session and its chunks.
    stmts.deleteChunksBySessionId.run(canonicalSessionId);
    stmts.deleteSessionBySessionId.run(canonicalSessionId);

    // Insert new chunks — enforce chunk.sessionId = canonicalSessionId.
    const chunks: ChunkMemoryItem[] = chunkInputs.map((item) => {
      const chunk: ChunkMemoryItem = {
        ...item,
        id: item.id ?? randomUUID(),
        sessionId: canonicalSessionId,
        sourceWorkspace: item.sourceWorkspace ? normalizeWorkspaceKey(item.sourceWorkspace) : null,
      };
      const emb = chunk.embedding.length ? embeddingToBlob(chunk.embedding) : null;
      const embDim = chunk.embedding.length || null;
      stmts.insertChunk.run(
        chunk.id,
        chunk.sessionId,
        chunk.sourceWorkspace ?? null,
        chunk.sourceWorkspaceLabel ?? null,
        chunk.sourceSessionId,
        chunk.sourceSessionTitle ?? null,
        chunk.sourceSessionDate ?? null,
        chunk.summary,
        chunk.details,
        JSON.stringify(chunk.keywords),
        JSON.stringify(chunk.sourceTurns),
        chunk.rawText,
        chunk.sessionDate,
        chunk.createdAt,
        chunk.ingestedAt,
        emb,
        emb ? activeEmbeddingModel : null, // embedding_model per-row
        embDim
      );
      return chunk;
    });

    // Insert new session — enforce session.sessionId = canonicalSessionId.
    const session: SessionMemoryItem = {
      ...sessionInput,
      id: sessionInput.id ?? randomUUID(),
      sessionId: canonicalSessionId,
      sourceWorkspace: normalizedWorkspace,
      chunkIds: chunks.map((c) => c.id),
    };
    const emb = session.embedding.length ? embeddingToBlob(session.embedding) : null;
    const embDim = session.embedding.length || null;
    stmts.insertSession.run(
      session.id,
      session.sessionId,
      session.sourceWorkspace ?? null,
      session.sourceWorkspaceLabel ?? null,
      session.sourceSessionId,
      session.sourceSessionTitle ?? null,
      session.sourceSessionDate ?? null,
      session.summary,
      JSON.stringify(session.keywords),
      JSON.stringify(session.chunkIds),
      JSON.stringify(session.rawSession),
      session.sessionDate,
      session.createdAt,
      session.ingestedAt,
      emb,
      emb ? activeEmbeddingModel : null, // embedding_model per-row
      embDim
    );

    return session;
  }

  removeSession(sessionId: string): void {
    const stmts = this.getStmts();
    this.db.transaction(() => {
      stmts.deleteChunksBySessionId.run(sessionId);
      stmts.deleteSessionBySessionId.run(sessionId);
    })();
    this.invalidateCache();
  }

  removeBySourceWorkspace(sourceWorkspace: string): void {
    const normalized = normalizeWorkspaceKey(sourceWorkspace);
    if (!normalized) return;
    const stmts = this.getStmts();
    this.db.transaction(() => {
      // Delete chunks first (no FK cascade — memory.db is a standalone file).
      stmts.deleteChunksByWorkspace.run(normalized);
      stmts.deleteSessionsByWorkspace.run(normalized);
    })();
    this.invalidateCache();
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM memory_chunks`);
      this.db.exec(`DELETE FROM memory_sessions`);
    })();
    this.invalidateCache();
    // No save() needed — already committed.
  }

  /**
   * No-op: mutations are committed immediately in SQLite.
   * Kept for interface compatibility with callers that call store.save().
   */
  save(): void {
    // intentional no-op
  }

  /** Embedding format version the stored vectors were written with. */
  getEmbeddingFormatVersion(): number {
    const raw = getMemoryMeta(this.db, 'embedding_format_version');
    if (!raw) return 1; // pre-migration installs treated as version 1
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 1;
  }

  /** Stamp the current embedding format version into memory_meta. */
  setEmbeddingFormatVersion(version: number): void {
    setMemoryMeta(this.db, 'embedding_format_version', String(version));
  }

  /** Store the active embedding model name in memory_meta. */
  setEmbeddingModel(model: string): void {
    setMemoryMeta(this.db, 'embedding_model', model);
  }

  /** The active embedding model recorded in memory_meta, or null. */
  getEmbeddingModel(): string | null {
    const val = getMemoryMeta(this.db, 'embedding_model');
    // Empty string is used as a sentinel for "explicitly cleared" (no model).
    return val && val.length > 0 ? val : null;
  }

  /** True if any stored session or chunk carries an embedding vector. */
  hasEmbeddings(): boolean {
    const sessions = (this.getStmts().countSessionsWithEmbedding.get() as { n: number }).n;
    if (sessions > 0) return true;
    const chunks = (this.getStmts().countChunksWithEmbedding.get() as { n: number }).n;
    return chunks > 0;
  }

  /**
   * Count of sessions and chunks (cheap — no full table scan on large sets).
   * Used by memory-service.getOverview() and getExperienceDbStatus().
   */
  getCounts(): { sessionCount: number; chunkCount: number } {
    const sessionCount = (this.getStmts().countSessions.get() as { n: number }).n;
    const chunkCount = (this.getStmts().countChunks.get() as { n: number }).n;
    return { sessionCount, chunkCount };
  }

  /**
   * Count of sessions and chunks that actually carry an embedding vector.
   * Drives the embedding-coverage card in Settings → Memory: a chunk stored
   * without a vector is invisible to semantic search, and nothing else reports it.
   */
  getEmbeddedCounts(): { sessionCount: number; chunkCount: number } {
    const sessionCount = (this.getStmts().countSessionsWithEmbedding.get() as { n: number }).n;
    const chunkCount = (this.getStmts().countChunksWithEmbedding.get() as { n: number }).n;
    return { sessionCount, chunkCount };
  }

  /**
   * How many rows would a backfill touch: those with no vector, plus those whose
   * vector predates the currently-active embedding model.
   */
  countRowsNeedingEmbedding(activeModel: string | null): {
    sessionCount: number;
    chunkCount: number;
  } {
    const stmts = this.getStmts();
    return {
      sessionCount: (stmts.countSessionsNeedingEmbedding.get(activeModel) as { n: number }).n,
      chunkCount: (stmts.countChunksNeedingEmbedding.get(activeModel) as { n: number }).n,
    };
  }

  /**
   * Rows a backfill must re-embed, carrying only the columns the embedded text is
   * built from — no vectors, no transcripts. `keywords` is the stored JSON array.
   */
  listRowsNeedingEmbedding(activeModel: string | null): {
    sessions: Array<{ id: string; summary: string; keywords: string[] }>;
    chunks: Array<{ id: string; summary: string; details: string; keywords: string[] }>;
  } {
    const stmts = this.getStmts();
    const parseKeywords = (raw: string): string[] => {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        return [];
      }
    };
    const sessions = (
      stmts.selectSessionsNeedingEmbedding.all(activeModel) as Array<{
        id: string;
        summary: string;
        keywords: string;
      }>
    ).map((r) => ({ id: r.id, summary: r.summary, keywords: parseKeywords(r.keywords) }));
    const chunks = (
      stmts.selectChunksNeedingEmbedding.all(activeModel) as Array<{
        id: string;
        summary: string;
        details: string;
        keywords: string;
      }>
    ).map((r) => ({
      id: r.id,
      summary: r.summary,
      details: r.details,
      keywords: parseKeywords(r.keywords),
    }));
    return { sessions, chunks };
  }

  /** Write a freshly-computed vector onto an existing row, leaving its content untouched. */
  updateChunkEmbedding(id: string, embedding: number[], model: string | null): void {
    if (!embedding.length) return;
    this.getStmts().updateChunkEmbedding.run(
      embeddingToBlob(embedding),
      model,
      embedding.length,
      id
    );
    this.invalidateCache();
  }

  /** Write a freshly-computed vector onto an existing row, leaving its content untouched. */
  updateSessionEmbedding(id: string, embedding: number[], model: string | null): void {
    if (!embedding.length) return;
    this.getStmts().updateSessionEmbedding.run(
      embeddingToBlob(embedding),
      model,
      embedding.length,
      id
    );
    this.invalidateCache();
  }

  // ---------------------------------------------------------------------------
  // Progressive retrieval
  // ---------------------------------------------------------------------------

  retrieveProgressive(
    query: string,
    options?: {
      chunkTopK?: number;
      sessionTopK?: number;
      queryEmbedding?: number[];
      currentWorkspace?: string | null;
      recencyFloor?: number;
      recencyCeiling?: number;
      recencyDecayDays?: number;
      supersessionPenalty?: number;
      supersessionKeywordThreshold?: number;
    }
  ): ProgressiveRetrievalResult {
    const chunkTopK = options?.chunkTopK ?? 10;
    const sessionTopK = options?.sessionTopK ?? 5;
    // Normalize the workspace key exactly once — scoring must use the same
    // normalized value to match the prior in-memory store behavior.
    // NOTE: We load ALL rows (no SQL workspace filter) and apply workspaceBoost
    // in JS scoring — exactly matching the prior JSON store semantics.
    const currentWorkspace = normalizeWorkspaceKey(options?.currentWorkspace || null);
    const queryEmbedding = options?.queryEmbedding;
    const scoringConfig = {
      recencyFloor: options?.recencyFloor ?? 0.05,
      recencyCeiling: options?.recencyCeiling ?? 0.25,
      recencyDecayDays: options?.recencyDecayDays ?? 90,
      supersessionPenalty: options?.supersessionPenalty ?? 0.2,
      supersessionKeywordThreshold: options?.supersessionKeywordThreshold ?? 0.5,
    };

    // Step 1: Load lightweight rows from cache (avoids full-table scan on repeated queries).
    const { chunks: chunkLightItems, sessions: sessionLightItems } = this.getLightRows();

    // Step 2: Lexical-score all rows (no embeddings yet) to identify survivors.
    const chunkTextSelector = (item: ReturnType<typeof rowLightToChunkNoEmbed>) =>
      [
        item.summary,
        item.details,
        item.rawText,
        ...item.keywords,
        item.sourceWorkspace || '',
        item.sourceSessionTitle || '',
      ].join(' ');
    const sessionTextSelector = (item: ReturnType<typeof rowLightToSessionNoEmbed>) =>
      [
        item.summary,
        ...item.keywords,
        item.sourceWorkspace || '',
        item.sourceSessionTitle || '',
      ].join(' ');

    // Step 2: Pre-filter candidates.
    // When queryEmbedding is present, we keep all rows as candidates (semantic
    // similarity can surface items with zero lexical overlap). When only lexical
    // scoring is available, filter to items with positive lexical evidence.
    const PRE_FILTER_MULTIPLIER = 5;

    let chunkPreFilter: ReturnType<typeof rowLightToChunkNoEmbed>[];
    let sessionPreFilter: ReturnType<typeof rowLightToSessionNoEmbed>[];

    if (queryEmbedding?.length) {
      // With embeddings: sort by lexical score descending and cap at SEMANTIC_CAP
      // to bound BLOB fetches and prevent OOM on large stores. Items near the top
      // by lexical score are most likely relevant; purely semantic matches without
      // any lexical signal are deprioritized but not excluded within the cap window.
      const SEMANTIC_CAP = Math.max(chunkTopK, sessionTopK) * PRE_FILTER_MULTIPLIER;

      const scoredChunks = chunkLightItems
        .map((item) => ({ item, lex: lexicalScore(query, chunkTextSelector(item)) }))
        .sort((a, b) => b.lex - a.lex);
      const scoredSessions = sessionLightItems
        .map((item) => ({ item, lex: lexicalScore(query, sessionTextSelector(item)) }))
        .sort((a, b) => b.lex - a.lex);

      // Semantic fallback: when the top lexical score is 0 (pure semantic query),
      // expand the candidate window to the larger of SEMANTIC_CAP or total row count
      // so high-similarity zero-lexical items are not excluded.
      const chunkTopLex = scoredChunks[0]?.lex ?? 0;
      const sessionTopLex = scoredSessions[0]?.lex ?? 0;
      const chunkCap =
        chunkTopLex === 0 ? Math.max(SEMANTIC_CAP, scoredChunks.length) : SEMANTIC_CAP;
      const sessionCap =
        sessionTopLex === 0 ? Math.max(SEMANTIC_CAP, scoredSessions.length) : SEMANTIC_CAP;

      chunkPreFilter = scoredChunks.slice(0, chunkCap).map((x) => x.item);
      sessionPreFilter = scoredSessions.slice(0, sessionCap).map((x) => x.item);
    } else {
      // Lexical-only: only keep items with positive evidence.
      chunkPreFilter = chunkLightItems
        .map((item) => ({ item, lex: lexicalScore(query, chunkTextSelector(item)) }))
        .filter((x) => x.lex > 0)
        .sort((a, b) => b.lex - a.lex)
        .slice(0, chunkTopK * PRE_FILTER_MULTIPLIER)
        .map((x) => x.item);
      sessionPreFilter = sessionLightItems
        .map((item) => ({ item, lex: lexicalScore(query, sessionTextSelector(item)) }))
        .filter((x) => x.lex > 0)
        .sort((a, b) => b.lex - a.lex)
        .slice(0, sessionTopK * PRE_FILTER_MULTIPLIER)
        .map((x) => x.item);
    }

    // Batch IN-clause helper: splits ids into chunks of <=900 to stay under
    // SQLite's SQLITE_MAX_VARIABLE_NUMBER (default 999).
    const batchFetchEmbeddings = (
      table: 'memory_chunks' | 'memory_sessions',
      idCol: string,
      ids: string[]
    ): Map<string, number[]> => {
      const BATCH = 900;
      const result = new Map<string, number[]>();
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const placeholders = batch.map(() => '?').join(',');
        const rows = this.db
          .prepare(`SELECT ${idCol}, embedding FROM ${table} WHERE ${idCol} IN (${placeholders})`)
          .all(...batch) as Array<{ [key: string]: string | Buffer | null }>;
        for (const r of rows) {
          const key = r[idCol] as string;
          const emb = r.embedding as Buffer | null;
          result.set(key, safeDecodeEmbedding(emb));
        }
      }
      return result;
    };

    // Step 3: Batch-load embeddings for the candidate set.
    const candidateChunks: ChunkMemoryItem[] = (() => {
      if (!queryEmbedding?.length) {
        return chunkPreFilter.map((item) => ({ ...item, embedding: [] as number[] }));
      }
      const ids = chunkPreFilter.map((c) => c.id);
      if (!ids.length) return [];
      const embMap = batchFetchEmbeddings('memory_chunks', 'id', ids);
      return chunkPreFilter.map((item) => ({ ...item, embedding: embMap.get(item.id) ?? [] }));
    })();

    const candidateSessions: SessionMemoryItem[] = (() => {
      if (!queryEmbedding?.length) {
        return sessionPreFilter.map((item) => ({ ...item, embedding: [] as number[] }));
      }
      const sessionIds = sessionPreFilter.map((s) => s.sessionId);
      if (!sessionIds.length) return [];
      const embMap = batchFetchEmbeddings('memory_sessions', 'session_id', sessionIds);
      return sessionPreFilter.map((item) => ({
        ...item,
        embedding: embMap.get(item.sessionId) ?? [],
      }));
    })();

    const rankedChunks = this.rankItems(
      query,
      candidateChunks,
      chunkTopK,
      queryEmbedding,
      currentWorkspace,
      (item) =>
        [
          item.summary,
          item.details,
          item.rawText,
          ...item.keywords,
          item.sourceWorkspace || '',
          item.sourceSessionTitle || '',
        ].join(' '),
      scoringConfig
    );

    const rankedSessions = this.rankItems(
      query,
      candidateSessions,
      sessionTopK,
      queryEmbedding,
      currentWorkspace,
      (item) =>
        [
          item.summary,
          ...item.keywords,
          item.sourceWorkspace || '',
          item.sourceSessionTitle || '',
        ].join(' '),
      scoringConfig
    );

    // Step 4: hydrate transcripts for the ranked sessions only.
    // `rawSession` is needed solely to build `rawSessionCandidates` below — at most
    // `sessionTopK` rows (default 5). Parsing it during the scan instead would mean
    // JSON-parsing every transcript in the store on every cache rebuild, which is the
    // single largest cost on this path and is hit after every ingest (writes drop the
    // cache). Fetching by id here keeps that bounded by K rather than by store size.
    if (rankedSessions.length) {
      const transcripts = this.fetchRawSessions(
        rankedSessions.map((item) => item.record.sessionId)
      );
      for (const item of rankedSessions) {
        item.record = { ...item.record, rawSession: transcripts.get(item.record.sessionId) ?? [] };
      }
    }

    const broadSummaries = [
      ...rankedChunks.map(
        (
          item
        ): { score: number; payload: ProgressiveRetrievalResult['broadSummaries'][number] } => ({
          score: item.score,
          payload: {
            type: 'chunk',
            id: item.record.id,
            sessionId: item.record.sessionId,
            sourceWorkspace: item.record.sourceWorkspace,
            sourceSessionTitle: item.record.sourceSessionTitle,
            summary: item.record.summary,
          },
        })
      ),
      ...rankedSessions.map(
        (
          item
        ): { score: number; payload: ProgressiveRetrievalResult['broadSummaries'][number] } => ({
          score: item.score,
          payload: {
            type: 'session',
            id: item.record.sessionId,
            sessionId: item.record.sessionId,
            sourceWorkspace: item.record.sourceWorkspace,
            sourceSessionTitle: item.record.sourceSessionTitle,
            summary: item.record.summary,
          },
        })
      ),
    ]
      .sort((a, b) => b.score - a.score)
      .map((item) => item.payload);

    const focusedChunks: FocusedChunkItem[] = rankedChunks.map((item) => ({
      chunkId: item.record.id,
      sessionId: item.record.sessionId,
      sourceWorkspace: item.record.sourceWorkspace,
      sourceSessionTitle: item.record.sourceSessionTitle,
      details: item.record.details,
      summary: item.record.summary,
      keywords: item.record.keywords,
      sourceTurns: item.record.sourceTurns,
    }));

    const sessionContexts: SessionContextItem[] = rankedSessions.map((item) => ({
      sessionId: item.record.sessionId,
      sourceWorkspace: item.record.sourceWorkspace,
      sourceSessionTitle: item.record.sourceSessionTitle,
      sessionSummary: item.record.summary,
      sessionDate: item.record.sessionDate,
      chunkIds: item.record.chunkIds,
    }));

    const rawSessionCandidates: RawSessionCandidateItem[] = rankedSessions.map((item) => ({
      sessionId: item.record.sessionId,
      sourceWorkspace: item.record.sourceWorkspace,
      sourceSessionTitle: item.record.sourceSessionTitle,
      sessionDate: item.record.sessionDate,
      rawSession: item.record.rawSession,
    }));

    return {
      broadSummaries,
      focusedChunks,
      sessionContexts,
      rawSessionCandidates,
      finalContext: '',
      rankedChunks: rankedChunks.map((item) => item.record),
      rankedSessions: rankedSessions.map((item) => item.record),
    };
  }

  /**
   * Fetch and parse `raw_session` transcripts for the given session ids.
   *
   * Batched at 900 ids to stay under SQLite's SQLITE_MAX_VARIABLE_NUMBER (default
   * 999), matching the embedding fetch — though in practice the caller passes at
   * most `sessionTopK` ids.
   */
  private fetchRawSessions(sessionIds: string[]): Map<string, MemoryTranscriptTurn[]> {
    const BATCH = 900;
    const result = new Map<string, MemoryTranscriptTurn[]>();
    for (let i = 0; i < sessionIds.length; i += BATCH) {
      const batch = sessionIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT session_id, raw_session FROM memory_sessions WHERE session_id IN (${placeholders})`
        )
        .all(...batch) as Array<{ session_id: string; raw_session: string | null }>;
      for (const row of rows) {
        result.set(row.session_id, parseRawSession(row.raw_session));
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private scoring — identical logic to the former JSON store
  // ---------------------------------------------------------------------------

  private rankItems<
    T extends {
      embedding: number[];
      ingestedAt: string;
      sourceWorkspace?: string | null;
      keywords?: string[];
      sessionDate?: string;
    },
  >(
    query: string,
    items: T[],
    topK: number,
    queryEmbedding: number[] | undefined,
    currentWorkspace: string | null,
    textSelector: (item: T) => string,
    scoringConfig: {
      recencyFloor: number;
      recencyCeiling: number;
      recencyDecayDays: number;
      supersessionPenalty: number;
      supersessionKeywordThreshold: number;
    }
  ): Array<{ record: T; score: number }> {
    const scored = items
      .map((record) => {
        const lexical = lexicalScore(query, textSelector(record));
        const embedding =
          queryEmbedding && queryEmbedding.length && record.embedding.length
            ? cosineSimilarity(queryEmbedding, record.embedding)
            : 0;
        const evidenceScore = lexical + embedding;
        const score =
          evidenceScore +
          workspaceBoost(currentWorkspace, record.sourceWorkspace) +
          recencyBoost(
            record.ingestedAt,
            Date.now(),
            scoringConfig.recencyFloor,
            scoringConfig.recencyCeiling,
            scoringConfig.recencyDecayDays
          );
        return { record, score, evidenceScore };
      })
      .filter((item) => item.evidenceScore > 0)
      .sort((a, b) => b.score - a.score);

    if (scoringConfig.supersessionPenalty > 0) {
      for (let i = 0; i < scored.length; i++) {
        const item = scored[i];
        const itemKeywords = (item.record as { keywords?: string[] }).keywords || [];
        if (!itemKeywords.length) continue;
        const itemTimestamp = Date.parse(
          (item.record as { sessionDate?: string }).sessionDate || item.record.ingestedAt
        );
        if (!Number.isFinite(itemTimestamp)) continue;

        let superseded = false;
        for (let j = 0; j < scored.length; j++) {
          if (i === j) continue;
          const other = scored[j];
          const otherTimestamp = Date.parse(
            (other.record as { sessionDate?: string }).sessionDate || other.record.ingestedAt
          );
          if (!Number.isFinite(otherTimestamp)) continue;
          if (otherTimestamp <= itemTimestamp) continue;

          const otherKeywords = (other.record as { keywords?: string[] }).keywords || [];
          if (!otherKeywords.length) continue;

          const itemWs = normalizeWorkspaceKey(item.record.sourceWorkspace || null);
          const otherWs = normalizeWorkspaceKey(other.record.sourceWorkspace || null);
          if (itemWs && otherWs && itemWs === otherWs) {
            const overlap = keywordOverlap(itemKeywords, otherKeywords);
            if (overlap >= scoringConfig.supersessionKeywordThreshold) {
              superseded = true;
              break;
            }
          }
        }
        if (superseded) {
          item.score -= scoringConfig.supersessionPenalty;
        }
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // ---------------------------------------------------------------------------
  // Lexical search support
  // ---------------------------------------------------------------------------

  /**
   * Rows for lexical search, carrying neither embeddings nor transcripts — the
   * search path scores text only, so decoding either would be pure waste.
   *
   * `sourceWorkspace` is a **hard filter** here, unlike the soft `workspaceBoost`
   * that `retrieveProgressive` applies, so it is pushed down into SQL.
   *
   * IMPORTANT: a non-null `sourceWorkspace` deliberately **excludes** rows whose
   * `source_workspace` is NULL (global rows). That is the pre-existing search
   * semantics, and `WHERE source_workspace = ?` reproduces it exactly, since
   * `NULL = 'x'` is NULL rather than true. Do **not** add the `OR source_workspace
   * IS NULL` union from §8 — that belongs to the retrieval path, not this one, and
   * would silently widen search results.
   */
  getSearchRows(sourceWorkspace: string | null): {
    sessions: ExperienceSessionSearchRow[];
    chunks: ExperienceChunkSearchRow[];
  } {
    const stmts = this.getStmts();
    // Normalize to the canonical stored form. If a non-empty key normalizes away,
    // fall back to the raw value so it still matches nothing — same as the prior
    // JS `item.sourceWorkspace !== sourceWorkspace` comparison.
    const key = sourceWorkspace
      ? (normalizeWorkspaceKey(sourceWorkspace) ?? sourceWorkspace)
      : null;

    const sessionRows = (
      key ? stmts.searchSessionsForWorkspace.all(key) : stmts.searchSessions.all()
    ) as Array<{
      session_id: string;
      source_workspace: string | null;
      source_workspace_label: string | null;
      source_session_id: string | null;
      source_session_title: string | null;
      summary: string;
      keywords: string;
      created_at: string | null;
      ingested_at: string | null;
    }>;

    const chunkRows = (
      key ? stmts.searchChunksForWorkspace.all(key) : stmts.searchChunks.all()
    ) as Array<{
      id: string;
      session_id: string;
      source_workspace: string | null;
      source_workspace_label: string | null;
      source_session_id: string | null;
      source_session_title: string | null;
      summary: string;
      details: string;
      keywords: string;
      raw_text: string;
      created_at: string | null;
      ingested_at: string | null;
    }>;

    return {
      sessions: sessionRows.map((row) => ({
        sessionId: row.session_id,
        sourceWorkspace: row.source_workspace ?? null,
        sourceWorkspaceLabel: row.source_workspace_label ?? undefined,
        sourceSessionId: row.source_session_id ?? row.session_id,
        sourceSessionTitle: row.source_session_title ?? undefined,
        summary: row.summary,
        keywords: parseJsonArray(row.keywords),
        createdAt: row.created_at ?? '',
        ingestedAt: row.ingested_at ?? '',
      })),
      chunks: chunkRows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        sourceWorkspace: row.source_workspace ?? null,
        sourceWorkspaceLabel: row.source_workspace_label ?? undefined,
        sourceSessionId: row.source_session_id ?? row.session_id,
        sourceSessionTitle: row.source_session_title ?? undefined,
        summary: row.summary,
        details: row.details,
        keywords: parseJsonArray(row.keywords),
        rawText: row.raw_text,
        createdAt: row.created_at ?? '',
        ingestedAt: row.ingested_at ?? '',
      })),
    };
  }
}
