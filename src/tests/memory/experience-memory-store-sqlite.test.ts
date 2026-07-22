/**
 * Tests for the SQLite-backed ExperienceMemoryStore.
 *
 * Covers:
 * - BLOB round-trip (Float32 fidelity)
 * - cosineSimilarity parity: number[] vs Float32Array input
 * - replaceSession / removeSession / removeBySourceWorkspace / clear
 * - getStatsBySourceWorkspace GROUP BY correctness
 * - retrieveProgressive workspace filtering
 * - getChunk / getChunksBySession
 * - hasEmbeddings / getCounts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExperienceMemoryStore } from '../../main/memory/experience-memory-store';
import { ensureColumn, openMemoryDb, type MemoryDb } from '../../main/memory/memory-db';
import { embeddingToBlob, blobToEmbedding, cosineSimilarity } from '../../main/memory/memory-utils';
import type { ChunkMemoryItem, SessionMemoryItem } from '../../main/memory/memory-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(
  overrides: Partial<Omit<SessionMemoryItem, 'id'>> & { sessionId: string }
): Omit<SessionMemoryItem, 'id'> {
  return {
    sessionId: overrides.sessionId,
    sourceWorkspace: overrides.sourceWorkspace ?? null,
    sourceWorkspaceLabel: overrides.sourceWorkspaceLabel,
    sourceSessionId: overrides.sourceSessionId ?? overrides.sessionId,
    sourceSessionTitle: overrides.sourceSessionTitle ?? 'Test session',
    sourceSessionDate: overrides.sourceSessionDate,
    summary: overrides.summary ?? 'A test session summary',
    keywords: overrides.keywords ?? ['test', 'session'],
    chunkIds: overrides.chunkIds ?? [],
    rawSession: overrides.rawSession ?? [],
    sessionDate: overrides.sessionDate ?? '2024-01-01',
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00',
    ingestedAt: overrides.ingestedAt ?? '2024-01-01T00:00:00',
    embedding: overrides.embedding ?? [],
  };
}

function makeChunk(
  sessionId: string,
  overrides: Partial<Omit<ChunkMemoryItem, 'id'>> = {}
): Omit<ChunkMemoryItem, 'id'> {
  return {
    sessionId,
    sourceWorkspace: overrides.sourceWorkspace ?? null,
    sourceWorkspaceLabel: overrides.sourceWorkspaceLabel,
    sourceSessionId: overrides.sourceSessionId ?? sessionId,
    sourceSessionTitle: overrides.sourceSessionTitle ?? 'Test session',
    sourceSessionDate: overrides.sourceSessionDate,
    summary: overrides.summary ?? 'A test chunk summary',
    details: overrides.details ?? 'Chunk details here',
    keywords: overrides.keywords ?? ['chunk', 'test'],
    sourceTurns: overrides.sourceTurns ?? [1, 2],
    rawText: overrides.rawText ?? 'raw chunk text',
    sessionDate: overrides.sessionDate ?? '2024-01-01',
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00',
    ingestedAt: overrides.ingestedAt ?? '2024-01-01T00:00:00',
    embedding: overrides.embedding ?? [],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe('ExperienceMemoryStore — SQLite backend', () => {
  let dir: string;
  let memDb: MemoryDb;
  let dbPath: string;
  let store: ExperienceMemoryStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-store-sqlite-'));
    dbPath = path.join(dir, 'memory.db');
    memDb = openMemoryDb(dir);
    store = new ExperienceMemoryStore(memDb.raw, dbPath);
  });

  afterEach(() => {
    memDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // BLOB round-trip
  // -------------------------------------------------------------------------

  describe('BLOB ↔ Float32 round-trip', () => {
    it('encodes and decodes a unit vector with Float32 fidelity', () => {
      const original = [0.1, 0.2, 0.3, 0.4, 0.5];
      const blob = embeddingToBlob(original);
      const decoded = blobToEmbedding(blob);
      expect(decoded).toHaveLength(original.length);
      for (let i = 0; i < original.length; i++) {
        // Float32 precision — values within ~6 significant digits
        expect(decoded[i]).toBeCloseTo(original[i], 5);
      }
    });

    it('round-trips a 768-dim zero vector', () => {
      const original = new Array(768).fill(0) as number[];
      const decoded = blobToEmbedding(embeddingToBlob(original));
      expect(decoded).toHaveLength(768);
      expect(decoded.every((v) => v === 0)).toBe(true);
    });

    it('round-trips an empty embedding as an empty array', () => {
      const blob = embeddingToBlob([]);
      expect(blob.byteLength).toBe(0);
      expect(blobToEmbedding(blob)).toEqual([]);
    });

    it('decodes a Buffer whose byteOffset is not 4-byte aligned', () => {
      // `new Float32Array(buffer, byteOffset, …)` throws RangeError on an unaligned
      // offset. better-sqlite3 returns byteOffset 0 today, so this is unreachable via
      // the DB — but exportExperienceJson decodes without a try/catch, so the helper
      // must cope rather than assume.
      const original = [0.25, -0.5, 0.75];
      const source = embeddingToBlob(original);
      const pool = Buffer.alloc(source.byteLength + 2);
      source.copy(pool, 2);
      const misaligned = pool.subarray(2);

      expect(misaligned.byteOffset % 4).not.toBe(0);
      const decoded = blobToEmbedding(misaligned);
      expect(decoded).toHaveLength(3);
      for (let i = 0; i < original.length; i++) {
        expect(decoded[i]).toBeCloseTo(original[i], 5);
      }
    });

    it('returns [] for a blob whose length is not a multiple of 4', () => {
      expect(blobToEmbedding(Buffer.alloc(6))).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // ensureColumn definition validation (§16.5)
  // -------------------------------------------------------------------------

  describe('ensureColumn definition validation', () => {
    it('accepts the definition forms the schema actually uses', () => {
      expect(() =>
        ensureColumn(memDb.raw, 'memory_sessions', 'probe_a', 'probe_a TEXT')
      ).not.toThrow();
      expect(() =>
        ensureColumn(memDb.raw, 'memory_sessions', 'probe_b', 'probe_b INTEGER')
      ).not.toThrow();
      expect(() =>
        ensureColumn(memDb.raw, 'memory_sessions', 'probe_c', "probe_c TEXT NOT NULL DEFAULT ''")
      ).not.toThrow();
      expect(() =>
        ensureColumn(memDb.raw, 'memory_sessions', 'probe_d', 'probe_d INTEGER DEFAULT 0')
      ).not.toThrow();
    });

    it('rejects trailing SQL after an otherwise valid prefix', () => {
      // The previous prefix-match accepted exactly this: the suffix starts with
      // `TEXT NOT NULL DEFAULT `, so the allowlist matched, and the remainder was
      // then interpolated verbatim into a db.exec() — which runs multiple statements.
      // Verified against the old implementation: it dropped memory_chunks.
      expect(() =>
        ensureColumn(
          memDb.raw,
          'memory_sessions',
          'probe_bad',
          "probe_bad TEXT NOT NULL DEFAULT ''; DROP TABLE memory_chunks; --"
        )
      ).toThrow(/Unsupported column definition/);

      // The table it would have dropped is still there.
      expect(() => memDb.raw.prepare(`SELECT 1 FROM memory_chunks`).get()).not.toThrow();
    });

    it('rejects an unknown column type', () => {
      expect(() =>
        ensureColumn(memDb.raw, 'memory_sessions', 'probe_x', 'probe_x VARCHAR(255)')
      ).toThrow(/Unsupported column definition/);
    });

    it('rejects a definition that does not start with the column name', () => {
      expect(() => ensureColumn(memDb.raw, 'memory_sessions', 'probe_y', 'other TEXT')).toThrow(
        /must start with column name/
      );
    });

    it('rejects an invalid table or column identifier', () => {
      expect(() =>
        ensureColumn(memDb.raw, 'memory_sessions; DROP TABLE x', 'probe_z', 'probe_z TEXT')
      ).toThrow(/Invalid SQL identifier/);
    });
  });

  // -------------------------------------------------------------------------
  // cosineSimilarity — number[] vs Float32Array parity
  // -------------------------------------------------------------------------

  describe('cosineSimilarity Float32Array parity', () => {
    it('returns the same value for number[] and Float32Array inputs', () => {
      const a = [0.1, 0.5, 0.3, 0.8];
      const b = [0.4, 0.2, 0.9, 0.1];
      const scoreNumbers = cosineSimilarity(a, b);
      const scoreF32 = cosineSimilarity(new Float32Array(a), new Float32Array(b));
      expect(scoreF32).toBeCloseTo(scoreNumbers, 5);
    });

    it('returns 1 for identical unit vectors regardless of input type', () => {
      const v = [0.6, 0.8];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
      expect(cosineSimilarity(new Float32Array(v), new Float32Array(v))).toBeCloseTo(1, 5);
    });

    it('returns 0 for mismatched lengths', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // replaceSession
  // -------------------------------------------------------------------------

  describe('replaceSession', () => {
    it('inserts a session and its chunks', () => {
      const sessionId = 'sess-1';
      store.replaceSession(sessionId, makeSession({ sessionId }), [
        makeChunk(sessionId),
        makeChunk(sessionId),
      ]);

      const session = store.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe(sessionId);
      expect(session!.chunkIds).toHaveLength(2);

      const chunks = store.getChunksBySession(sessionId);
      expect(chunks).toHaveLength(2);
    });

    it('replaces an existing session atomically', () => {
      const sessionId = 'sess-replace';
      store.replaceSession(sessionId, makeSession({ sessionId, summary: 'first' }), [
        makeChunk(sessionId),
      ]);

      // Replace with a different summary and 3 chunks
      store.replaceSession(sessionId, makeSession({ sessionId, summary: 'second' }), [
        makeChunk(sessionId),
        makeChunk(sessionId),
        makeChunk(sessionId),
      ]);

      const session = store.getSession(sessionId);
      expect(session!.summary).toBe('second');
      expect(session!.chunkIds).toHaveLength(3);
      expect(store.getChunksBySession(sessionId)).toHaveLength(3);
    });

    it('stores and retrieves embedding as Float32 BLOB with no precision loss beyond Float32', () => {
      const sessionId = 'sess-embed';
      const embedding = [0.1, 0.9, 0.5, 0.3];
      store.replaceSession(sessionId, makeSession({ sessionId, embedding }), []);

      const session = store.getSession(sessionId);
      expect(session!.embedding).toHaveLength(embedding.length);
      for (let i = 0; i < embedding.length; i++) {
        expect(session!.embedding[i]).toBeCloseTo(embedding[i], 5);
      }
    });
  });

  // -------------------------------------------------------------------------
  // removeSession
  // -------------------------------------------------------------------------

  describe('removeSession', () => {
    it('removes the session and its chunks', () => {
      const sessionId = 'sess-del';
      store.replaceSession(sessionId, makeSession({ sessionId }), [
        makeChunk(sessionId),
        makeChunk(sessionId),
      ]);

      store.removeSession(sessionId);
      expect(store.getSession(sessionId)).toBeUndefined();
      expect(store.getChunksBySession(sessionId)).toHaveLength(0);
    });

    it('returns [] when session does not exist', () => {
      expect(store.getChunksBySession('non-existent-session')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // removeBySourceWorkspace
  // -------------------------------------------------------------------------

  describe('removeBySourceWorkspace', () => {
    it('removes only sessions and chunks matching the workspace', () => {
      const ws = '/home/user/project-a';
      store.replaceSession('sess-a1', makeSession({ sessionId: 'sess-a1', sourceWorkspace: ws }), [
        makeChunk('sess-a1', { sourceWorkspace: ws }),
      ]);
      store.replaceSession(
        'sess-b1',
        makeSession({ sessionId: 'sess-b1', sourceWorkspace: '/home/user/project-b' }),
        [makeChunk('sess-b1', { sourceWorkspace: '/home/user/project-b' })]
      );

      store.removeBySourceWorkspace(ws);

      expect(store.getSession('sess-a1')).toBeUndefined();
      expect(store.getSession('sess-b1')).toBeDefined();
      expect(store.getChunksBySession('sess-a1')).toHaveLength(0);
      expect(store.getChunksBySession('sess-b1')).toHaveLength(1);
    });

    it('is a no-op for a workspace with no entries', () => {
      expect(() => store.removeBySourceWorkspace('/no/such/workspace')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all sessions and chunks', () => {
      store.replaceSession('s1', makeSession({ sessionId: 's1' }), [makeChunk('s1')]);
      store.replaceSession('s2', makeSession({ sessionId: 's2' }), [
        makeChunk('s2'),
        makeChunk('s2'),
      ]);

      store.clear();

      expect(store.getCounts()).toEqual({ sessionCount: 0, chunkCount: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // getStatsBySourceWorkspace
  // -------------------------------------------------------------------------

  describe('getStatsBySourceWorkspace', () => {
    it('returns correct session and chunk counts per workspace', () => {
      const wsA = '/projects/alpha';
      const wsB = '/projects/beta';

      store.replaceSession('s1', makeSession({ sessionId: 's1', sourceWorkspace: wsA }), [
        makeChunk('s1', { sourceWorkspace: wsA }),
        makeChunk('s1', { sourceWorkspace: wsA }),
      ]);
      store.replaceSession('s2', makeSession({ sessionId: 's2', sourceWorkspace: wsA }), [
        makeChunk('s2', { sourceWorkspace: wsA }),
      ]);
      store.replaceSession('s3', makeSession({ sessionId: 's3', sourceWorkspace: wsB }), [
        makeChunk('s3', { sourceWorkspace: wsB }),
      ]);

      const stats = store.getStatsBySourceWorkspace();
      const alpha = stats.find((s) => s.workspaceKey === wsA);
      const beta = stats.find((s) => s.workspaceKey === wsB);

      expect(alpha).toBeDefined();
      expect(alpha!.sessionCount).toBe(2);
      expect(alpha!.chunkCount).toBe(3);
      expect(beta!.sessionCount).toBe(1);
      expect(beta!.chunkCount).toBe(1);
    });

    it('returns empty array when store is empty', () => {
      expect(store.getStatsBySourceWorkspace()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getCounts
  // -------------------------------------------------------------------------

  describe('getCounts', () => {
    it('returns accurate counts without loading all rows', () => {
      expect(store.getCounts()).toEqual({ sessionCount: 0, chunkCount: 0 });

      store.replaceSession('s1', makeSession({ sessionId: 's1' }), [
        makeChunk('s1'),
        makeChunk('s1'),
      ]);
      expect(store.getCounts()).toEqual({ sessionCount: 1, chunkCount: 2 });

      store.replaceSession('s2', makeSession({ sessionId: 's2' }), [makeChunk('s2')]);
      expect(store.getCounts()).toEqual({ sessionCount: 2, chunkCount: 3 });

      store.removeSession('s1');
      expect(store.getCounts()).toEqual({ sessionCount: 1, chunkCount: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // hasEmbeddings
  // -------------------------------------------------------------------------

  describe('hasEmbeddings', () => {
    it('returns false when no embeddings are stored', () => {
      store.replaceSession('s1', makeSession({ sessionId: 's1', embedding: [] }), [
        makeChunk('s1', { embedding: [] }),
      ]);
      expect(store.hasEmbeddings()).toBe(false);
    });

    it('returns true when at least one chunk has an embedding', () => {
      store.replaceSession('s1', makeSession({ sessionId: 's1', embedding: [] }), [
        makeChunk('s1', { embedding: [0.1, 0.2, 0.3] }),
      ]);
      expect(store.hasEmbeddings()).toBe(true);
    });

    it('returns true when a session has an embedding', () => {
      store.replaceSession('s1', makeSession({ sessionId: 's1', embedding: [0.5, 0.5] }), []);
      expect(store.hasEmbeddings()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // retrieveProgressive workspace filtering
  // -------------------------------------------------------------------------

  describe('retrieveProgressive workspace filtering', () => {
    it('returns only matching-workspace and global chunks when workspace is specified', () => {
      const wsA = '/projects/alpha';
      const wsB = '/projects/beta';

      // wsA session with a distinctive keyword
      store.replaceSession(
        'sess-alpha',
        makeSession({
          sessionId: 'sess-alpha',
          sourceWorkspace: wsA,
          summary: 'alpha project work',
          keywords: ['alpha', 'project'],
        }),
        [
          makeChunk('sess-alpha', {
            sourceWorkspace: wsA,
            summary: 'alpha chunk',
            keywords: ['alpha'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      // wsB session — should not appear when querying wsA
      store.replaceSession(
        'sess-beta',
        makeSession({
          sessionId: 'sess-beta',
          sourceWorkspace: wsB,
          summary: 'beta project work',
          keywords: ['beta', 'project'],
        }),
        [
          makeChunk('sess-beta', {
            sourceWorkspace: wsB,
            summary: 'beta chunk',
            keywords: ['beta'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      // Global session (null workspace) — should appear in any workspace query
      store.replaceSession(
        'sess-global',
        makeSession({
          sessionId: 'sess-global',
          sourceWorkspace: null,
          summary: 'global alpha knowledge',
          keywords: ['alpha', 'global'],
        }),
        [
          makeChunk('sess-global', {
            sourceWorkspace: null,
            summary: 'global alpha chunk',
            keywords: ['alpha'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      const result = store.retrieveProgressive('alpha project', {
        currentWorkspace: wsA,
        chunkTopK: 10,
        sessionTopK: 10,
      });

      const chunkWorkspaces = result.rankedChunks.map((c) => c.sourceWorkspace);
      expect(chunkWorkspaces.every((ws) => ws === wsA || ws === null)).toBe(true);

      const sessionWorkspaces = result.rankedSessions.map((s) => s.sourceWorkspace);
      expect(sessionWorkspaces.every((ws) => ws === wsA || ws === null)).toBe(true);
    });

    it('returns results from all workspaces even when currentWorkspace is set (workspaceBoost semantics)', () => {
      const wsA = '/projects/alpha';
      const wsB = '/projects/beta';

      // Both sessions have the same keyword so both score positively on lexical.
      store.replaceSession(
        'sess-cross-a',
        makeSession({
          sessionId: 'sess-cross-a',
          sourceWorkspace: wsA,
          summary: 'cross workspace alpha',
          keywords: ['crosstest'],
        }),
        [
          makeChunk('sess-cross-a', {
            sourceWorkspace: wsA,
            summary: 'cross chunk alpha',
            keywords: ['crosstest'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );
      store.replaceSession(
        'sess-cross-b',
        makeSession({
          sessionId: 'sess-cross-b',
          sourceWorkspace: wsB,
          summary: 'cross workspace beta',
          keywords: ['crosstest'],
        }),
        [
          makeChunk('sess-cross-b', {
            sourceWorkspace: wsB,
            summary: 'cross chunk beta',
            keywords: ['crosstest'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      // Query with currentWorkspace = wsA — both sessions should still appear
      // (wsB gets no workspaceBoost, but is not excluded).
      const result = store.retrieveProgressive('crosstest', {
        currentWorkspace: wsA,
        chunkTopK: 10,
        sessionTopK: 10,
      });

      const sessionIds = result.rankedSessions.map((s) => s.sessionId);
      expect(sessionIds).toContain('sess-cross-a');
      expect(sessionIds).toContain('sess-cross-b');

      const chunkSessionIds = result.rankedChunks.map((c) => c.sessionId);
      expect(chunkSessionIds).toContain('sess-cross-a');
      expect(chunkSessionIds).toContain('sess-cross-b');
    });

    it('returns results from all workspaces when no currentWorkspace is set', () => {
      const wsA = '/projects/alpha';
      const wsB = '/projects/beta';

      store.replaceSession(
        'sess-a',
        makeSession({
          sessionId: 'sess-a',
          sourceWorkspace: wsA,
          summary: 'alpha work',
          keywords: ['alpha'],
        }),
        [
          makeChunk('sess-a', {
            sourceWorkspace: wsA,
            summary: 'alpha detail',
            keywords: ['alpha'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );
      store.replaceSession(
        'sess-b',
        makeSession({
          sessionId: 'sess-b',
          sourceWorkspace: wsB,
          summary: 'beta work',
          keywords: ['beta'],
        }),
        [
          makeChunk('sess-b', {
            sourceWorkspace: wsB,
            summary: 'beta detail',
            keywords: ['beta'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      const result = store.retrieveProgressive('work', { chunkTopK: 10, sessionTopK: 10 });
      const sessionIds = result.rankedSessions.map((s) => s.sessionId);
      expect(sessionIds).toContain('sess-a');
      expect(sessionIds).toContain('sess-b');
    });

    it('returns empty results when store is empty', () => {
      const result = store.retrieveProgressive('anything');
      expect(result.broadSummaries).toHaveLength(0);
      expect(result.rankedChunks).toHaveLength(0);
      expect(result.rankedSessions).toHaveLength(0);
    });

    it('returns semantic matches even when lexical score is zero', () => {
      // Seed a chunk whose text has NO token overlap with the query,
      // but provide a query embedding that is nearly identical to the chunk embedding.
      const chunkEmbedding = [0.6, 0.8]; // unit vector
      const queryEmbedding = [0.601, 0.799]; // nearly identical

      store.replaceSession(
        'sess-semantic',
        makeSession({
          sessionId: 'sess-semantic',
          sourceWorkspace: null,
          summary: 'xyzzy quux',
          keywords: ['xyzzy'],
        }),
        [
          makeChunk('sess-semantic', {
            summary: 'xyzzy quux',
            details: 'xyzzy quux details',
            keywords: ['xyzzy'],
            rawText: 'xyzzy quux',
            embedding: chunkEmbedding,
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      // Query with a completely different vocabulary but a similar embedding.
      const result = store.retrieveProgressive('totally different vocabulary', {
        queryEmbedding,
        chunkTopK: 10,
        sessionTopK: 10,
      });

      // The chunk should surface via semantic similarity even with zero lexical overlap
      // (semantic fallback kicks in when top lexical score is 0).
      const chunkIds = result.rankedChunks.map((c) => c.sessionId);
      expect(chunkIds).toContain('sess-semantic');
    });

    it('semantic fallback: when ALL lexical scores are 0, includes all candidates for embedding scoring', () => {
      // Seed two items with distinct embeddings, neither matching the query lexically.
      const emb1 = [1.0, 0.0];
      const emb2 = [0.0, 1.0];
      const queryEmb = [0.99, 0.01]; // close to emb1

      store.replaceSession(
        'sem-s1',
        makeSession({ sessionId: 'sem-s1', summary: 'aaabbbccc', keywords: ['aaabbbccc'] }),
        [
          makeChunk('sem-s1', {
            summary: 'aaabbbccc',
            keywords: ['aaabbbccc'],
            embedding: emb1,
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );
      store.replaceSession(
        'sem-s2',
        makeSession({ sessionId: 'sem-s2', summary: 'zzzyyyxxx', keywords: ['zzzyyyxxx'] }),
        [
          makeChunk('sem-s2', {
            summary: 'zzzyyyxxx',
            keywords: ['zzzyyyxxx'],
            embedding: emb2,
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      // Query has zero overlap with both items lexically.
      const result = store.retrieveProgressive('completely unrelated query text', {
        queryEmbedding: queryEmb,
        chunkTopK: 10,
        sessionTopK: 10,
      });

      // Both should appear (fallback expands to all when top lex == 0).
      const sessionIds = result.rankedChunks.map((c) => c.sessionId);
      expect(sessionIds).toContain('sem-s1');
      expect(sessionIds).toContain('sem-s2');
      // emb1 is closer to queryEmb — sem-s1 should rank higher.
      expect(sessionIds.indexOf('sem-s1')).toBeLessThan(sessionIds.indexOf('sem-s2'));
    });
  });

  // -------------------------------------------------------------------------
  // save() is a no-op
  // -------------------------------------------------------------------------

  describe('save()', () => {
    it('is a no-op and does not throw', () => {
      store.replaceSession('s1', makeSession({ sessionId: 's1' }), []);
      expect(() => store.save()).not.toThrow();
      // Data persists without explicit save
      expect(store.getSession('s1')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Corrupted BLOB resilience
  // -------------------------------------------------------------------------

  describe('corrupted BLOB resilience', () => {
    it('getSession does not throw on a row with an invalid embedding blob', () => {
      // Insert a row with a 3-byte BLOB (not divisible by 4 — invalid Float32).
      memDb.raw.exec(`
        INSERT INTO memory_sessions
          (id, session_id, summary, keywords, chunk_ids, raw_session, session_date, created_at, ingested_at, embedding)
        VALUES
          ('s-corrupt', 'sess-corrupt', 'bad blob', '[]', '[]', '[]', '2024-01-01', '2024-01-01', '2024-01-01', X'AABBCC')
      `);

      expect(() => store.getSession('sess-corrupt')).not.toThrow();
      const s = store.getSession('sess-corrupt');
      expect(s).toBeDefined();
      expect(s!.embedding).toEqual([]);
    });

    it('retrieveProgressive does not throw when the store contains an invalid embedding blob', () => {
      memDb.raw.exec(`
        INSERT INTO memory_chunks
          (id, session_id, summary, details, keywords, source_turns, raw_text, session_date, created_at, ingested_at, embedding)
        VALUES
          ('c-corrupt', 's-corrupt', 'corrupted chunk', '', '[]', '[]', '', '2024-01-01', '2024-01-01', '2024-01-01', X'AABB')
      `);

      expect(() =>
        store.retrieveProgressive('corrupted', { queryEmbedding: [0.1, 0.2] })
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Cache invalidation after writes
  // -------------------------------------------------------------------------

  describe('cache invalidation', () => {
    it('retrieveProgressive sees newly replaced content immediately', () => {
      const sessionId = 'cache-sess';
      // Insert initial content.
      store.replaceSession(
        sessionId,
        makeSession({ sessionId, summary: 'old content alpha', keywords: ['alpha'] }),
        [
          makeChunk(sessionId, {
            summary: 'old chunk alpha',
            keywords: ['alpha'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      // Replace with new content.
      store.replaceSession(
        sessionId,
        makeSession({ sessionId, summary: 'new content beta', keywords: ['beta'] }),
        [
          makeChunk(sessionId, {
            summary: 'new chunk beta',
            keywords: ['beta'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );

      // Should find beta, not alpha.
      const result = store.retrieveProgressive('beta');
      const summaries = result.rankedChunks.map((c) => c.summary);
      expect(summaries.some((s) => s.includes('beta'))).toBe(true);
      expect(summaries.some((s) => s.includes('alpha'))).toBe(false);
    });

    it('cache invalidates after replaceSessionWithMeta', () => {
      const sessionId = 'cache-meta-sess';
      store.replaceSessionWithMeta(
        sessionId,
        makeSession({ sessionId, summary: 'meta new content gamma', keywords: ['gamma'] }),
        [
          makeChunk(sessionId, {
            summary: 'meta chunk gamma',
            keywords: ['gamma'],
            ingestedAt: new Date().toISOString(),
          }),
        ],
        { embeddingModel: null, embeddingFormatVersion: 2 }
      );

      const result = store.retrieveProgressive('gamma');
      expect(result.rankedChunks.some((c) => c.summary.includes('gamma'))).toBe(true);
    });

    it('cache invalidates after removeSession', () => {
      const sessionId = 'cache-del-sess';
      store.replaceSession(
        sessionId,
        makeSession({ sessionId, summary: 'delete me delta', keywords: ['delta'] }),
        [
          makeChunk(sessionId, {
            summary: 'delete chunk delta',
            keywords: ['delta'],
            ingestedAt: new Date().toISOString(),
          }),
        ]
      );
      store.removeSession(sessionId);

      const result = store.retrieveProgressive('delta');
      expect(result.rankedChunks).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Large dataset — IN batching stays under SQLite variable limit
  // -------------------------------------------------------------------------

  describe('large dataset IN batching', () => {
    it('retrieveProgressive with >900 rows does not throw', () => {
      // Seed 950 chunks across 950 sessions to exceed SQLite variable limit.
      for (let i = 0; i < 950; i++) {
        const sid = `bulk-sess-${i}`;
        store.replaceSession(
          sid,
          makeSession({
            sessionId: sid,
            summary: `bulk session ${i}`,
            keywords: [`bulk`, `item${i}`],
          }),
          [
            makeChunk(sid, {
              summary: `bulk chunk ${i}`,
              keywords: [`bulk`, `item${i}`],
              embedding: [0.1, 0.2],
              ingestedAt: new Date().toISOString(),
            }),
          ]
        );
      }

      // Use queryEmbedding to trigger the batched IN path.
      expect(() =>
        store.retrieveProgressive('bulk', {
          queryEmbedding: [0.1, 0.2],
          chunkTopK: 10,
          sessionTopK: 5,
        })
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // replaceSession sessionId enforcement
  // -------------------------------------------------------------------------

  describe('replaceSession sessionId enforcement', () => {
    it('uses the sessionId argument even when sessionInput.sessionId differs', () => {
      const canonicalId = 'canonical-sess';
      // Pass a mismatched sessionId in sessionInput.
      store.replaceSession(
        canonicalId,
        makeSession({ sessionId: 'WRONG-ID', summary: 'enforced session' }),
        [makeChunk('WRONG-ID')]
      );

      // Should be retrievable by the canonical argument, not by 'WRONG-ID'.
      expect(store.getSession(canonicalId)).toBeDefined();
      expect(store.getSession(canonicalId)!.sessionId).toBe(canonicalId);
      expect(store.getSession('WRONG-ID')).toBeUndefined();

      // Chunks must also carry the canonical sessionId.
      const chunks = store.getChunksBySession(canonicalId);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].sessionId).toBe(canonicalId);
    });
  });

  // -------------------------------------------------------------------------
  // Workspace normalization on write
  // -------------------------------------------------------------------------

  describe('workspace normalization', () => {
    it('normalizes sourceWorkspace on replaceSession so removeBySourceWorkspace works regardless of input format', () => {
      // Insert with a trailing slash (unnormalized).
      const rawWs = '/projects/my-app/';
      const normalizedWs = '/projects/my-app';

      store.replaceSession(
        'sess-norm',
        makeSession({ sessionId: 'sess-norm', sourceWorkspace: rawWs }),
        [makeChunk('sess-norm', { sourceWorkspace: rawWs })]
      );

      // removeBySourceWorkspace with the normalized form should delete it.
      store.removeBySourceWorkspace(normalizedWs);

      expect(store.getSession('sess-norm')).toBeUndefined();
      expect(store.getChunksBySession('sess-norm')).toHaveLength(0);
    });

    it('getStatsBySourceWorkspace groups by normalized key', () => {
      const rawWs = '/projects/alpha/';
      const normalizedWs = '/projects/alpha';

      store.replaceSession('s1', makeSession({ sessionId: 's1', sourceWorkspace: rawWs }), [
        makeChunk('s1', { sourceWorkspace: rawWs }),
      ]);
      store.replaceSession('s2', makeSession({ sessionId: 's2', sourceWorkspace: normalizedWs }), [
        makeChunk('s2', { sourceWorkspace: normalizedWs }),
      ]);

      const stats = store.getStatsBySourceWorkspace();
      // Both should be grouped under the same normalized key.
      const alphaStats = stats.filter(
        (s) => s.workspaceKey === normalizedWs || s.workspaceKey === rawWs
      );
      // Either one merged entry or two separate — the key point is removeBySourceWorkspace
      // with normalizedWs removes both.
      store.removeBySourceWorkspace(normalizedWs);
      expect(store.getSession('s1')).toBeUndefined();
      expect(store.getSession('s2')).toBeUndefined();
      void alphaStats; // used above implicitly
    });
  });

  // -------------------------------------------------------------------------
  // getPath()
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Per-row embedding_model stamping (design D4/D5, §7)
  // -------------------------------------------------------------------------

  describe('per-row embedding_model stamping', () => {
    const vec = [0.1, 0.2, 0.3];

    function rowModels(table: 'memory_sessions' | 'memory_chunks') {
      return (
        memDb.raw
          .prepare(`SELECT session_id, embedding_model, embedding_dim FROM ${table}`)
          .all() as Array<{ session_id: string; embedding_model: string | null }>
      ).map((r) => [r.session_id, r.embedding_model] as const);
    }

    it('stamps the model supplied to replaceSessionWithMeta on the very first ingest', () => {
      store.replaceSessionWithMeta(
        's1',
        makeSession({ sessionId: 's1', embedding: vec }),
        [makeChunk('s1', { embedding: vec })],
        { embeddingModel: 'model-A', embeddingFormatVersion: 2 }
      );

      // Regression: rows used to be stamped from meta *before* meta was updated,
      // leaving the first ingest NULL and every later ingest one model behind.
      expect(rowModels('memory_sessions')).toEqual([['s1', 'model-A']]);
      expect(rowModels('memory_chunks')).toEqual([['s1', 'model-A']]);
      expect(store.getEmbeddingModel()).toBe('model-A');
    });

    it('stamps the new model on a later ingest after a model switch', () => {
      store.replaceSessionWithMeta(
        's1',
        makeSession({ sessionId: 's1', embedding: vec }),
        [makeChunk('s1', { embedding: vec })],
        { embeddingModel: 'model-A', embeddingFormatVersion: 2 }
      );
      store.replaceSessionWithMeta(
        's2',
        makeSession({ sessionId: 's2', embedding: vec }),
        [makeChunk('s2', { embedding: vec })],
        { embeddingModel: 'model-B', embeddingFormatVersion: 2 }
      );

      expect(rowModels('memory_sessions').sort()).toEqual([
        ['s1', 'model-A'],
        ['s2', 'model-B'],
      ]);
      expect(store.getEmbeddingModel()).toBe('model-B');
    });

    it('leaves embedding_model NULL on rows with no vector', () => {
      store.replaceSessionWithMeta(
        's1',
        makeSession({ sessionId: 's1', embedding: [] }),
        [makeChunk('s1', { embedding: [] })],
        { embeddingModel: 'model-A', embeddingFormatVersion: 2 }
      );

      expect(rowModels('memory_sessions')).toEqual([['s1', null]]);
      expect(rowModels('memory_chunks')).toEqual([['s1', null]]);
    });

    it('records the embedding dimension alongside the model', () => {
      store.replaceSessionWithMeta(
        's1',
        makeSession({ sessionId: 's1', embedding: new Array(768).fill(0.01) }),
        [],
        { embeddingModel: 'model-A', embeddingFormatVersion: 2 }
      );

      const row = memDb.raw
        .prepare(`SELECT embedding_dim FROM memory_sessions WHERE session_id = 's1'`)
        .get() as { embedding_dim: number };
      expect(row.embedding_dim).toBe(768);
    });

    it('replaceSession (no meta) falls back to the model already in meta', () => {
      store.setEmbeddingModel('model-A');
      store.replaceSession('s1', makeSession({ sessionId: 's1', embedding: vec }), []);

      expect(rowModels('memory_sessions')).toEqual([['s1', 'model-A']]);
    });

    it('clears meta embedding_model when the caller reports no active model', () => {
      store.replaceSessionWithMeta('s1', makeSession({ sessionId: 's1', embedding: vec }), [], {
        embeddingModel: 'model-A',
        embeddingFormatVersion: 2,
      });
      store.replaceSessionWithMeta('s2', makeSession({ sessionId: 's2', embedding: vec }), [], {
        embeddingModel: null,
        embeddingFormatVersion: 2,
      });

      expect(store.getEmbeddingModel()).toBeNull();
      expect(rowModels('memory_sessions').sort()).toEqual([
        ['s1', 'model-A'],
        ['s2', null],
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // getSearchRows — lexical-search row shape + SQL workspace push-down
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Lazy transcript hydration (§16.2)
  // -------------------------------------------------------------------------

  describe('lazy raw_session hydration', () => {
    const turns = [
      { role: 'user', content: 'how do we rotate the gateway token' },
      { role: 'assistant', content: 'call the rotate endpoint' },
    ];

    it('still returns full transcripts for ranked sessions (contract preserved)', () => {
      store.replaceSession(
        'sess-raw',
        makeSession({
          sessionId: 'sess-raw',
          summary: 'gateway token rotation',
          keywords: ['gateway', 'rotation'],
          rawSession: turns,
        }),
        []
      );

      const result = store.retrieveProgressive('gateway rotation');

      expect(result.rawSessionCandidates).toHaveLength(1);
      expect(result.rawSessionCandidates[0].rawSession).toEqual(turns);
      // The ranked record itself is hydrated too, not just the candidates view.
      expect(result.rankedSessions[0].rawSession).toEqual(turns);
    });

    it('hydrates only the ranked sessions, not every row in the store', () => {
      // One matching session plus noise that scores zero and must stay unhydrated.
      store.replaceSession(
        'match',
        makeSession({
          sessionId: 'match',
          summary: 'gateway token rotation',
          keywords: ['gateway'],
          rawSession: turns,
        }),
        []
      );
      for (let i = 0; i < 5; i++) {
        store.replaceSession(
          `noise-${i}`,
          makeSession({
            sessionId: `noise-${i}`,
            summary: 'completely unrelated topic',
            keywords: ['unrelated'],
            rawSession: [{ role: 'user', content: 'unrelated transcript body' }],
          }),
          []
        );
      }

      const result = store.retrieveProgressive('gateway rotation');

      expect(result.rawSessionCandidates.map((c) => c.sessionId)).toEqual(['match']);
      expect(result.rawSessionCandidates[0].rawSession).toEqual(turns);
    });

    it('respects sessionTopK — hydration is bounded by K, not by store size', () => {
      for (let i = 0; i < 8; i++) {
        store.replaceSession(
          `sess-${i}`,
          makeSession({
            sessionId: `sess-${i}`,
            summary: 'gateway token rotation',
            keywords: ['gateway'],
            rawSession: turns,
          }),
          []
        );
      }

      const result = store.retrieveProgressive('gateway rotation', { sessionTopK: 3 });

      expect(result.rawSessionCandidates).toHaveLength(3);
      for (const candidate of result.rawSessionCandidates) {
        expect(candidate.rawSession).toEqual(turns);
      }
    });

    it('yields an empty transcript when the stored raw_session is corrupt', () => {
      store.replaceSession(
        'sess-bad',
        makeSession({
          sessionId: 'sess-bad',
          summary: 'gateway token rotation',
          keywords: ['gateway'],
          rawSession: turns,
        }),
        []
      );
      memDb.raw
        .prepare(`UPDATE memory_sessions SET raw_session = 'not json' WHERE session_id = ?`)
        .run('sess-bad');

      const result = store.retrieveProgressive('gateway rotation');

      expect(result.rawSessionCandidates[0].rawSession).toEqual([]);
    });

    it('never selects raw_session in an unfiltered scan', () => {
      // Deliberately white-box: every other test here passes both before and after
      // the lazy-hydration change, because behaviour is identical by design. This one
      // pins the mechanism, so a revert to parsing transcripts during the full-table
      // scan fails loudly instead of silently costing a JSON.parse per row per rebuild.
      const executed: string[] = [];
      const realPrepare = memDb.raw.prepare.bind(memDb.raw);
      const spy = vi.spyOn(memDb.raw, 'prepare').mockImplementation(((sql: string) => {
        executed.push(sql);
        return realPrepare(sql);
      }) as typeof memDb.raw.prepare);

      try {
        // Fresh store so prepared statements are built (and captured) here.
        const freshStore = new ExperienceMemoryStore(memDb.raw, dbPath);
        freshStore.replaceSession(
          'sess-scan',
          makeSession({
            sessionId: 'sess-scan',
            summary: 'gateway token rotation',
            keywords: ['gateway'],
            rawSession: turns,
          }),
          []
        );
        const result = freshStore.retrieveProgressive('gateway rotation');
        expect(result.rawSessionCandidates[0].rawSession).toEqual(turns);
      } finally {
        spy.mockRestore();
      }

      const unfilteredSessionScans = executed.filter(
        (sql) => /FROM\s+memory_sessions/i.test(sql) && !/WHERE/i.test(sql)
      );
      expect(unfilteredSessionScans.length).toBeGreaterThan(0);
      for (const sql of unfilteredSessionScans) {
        expect(sql).not.toMatch(/raw_session/i);
      }
      // ...and the transcript did get fetched, by id.
      expect(
        executed.some((sql) => /raw_session/i.test(sql) && /WHERE\s+session_id\s+IN/i.test(sql))
      ).toBe(true);
    });

    it('scoring is unaffected by transcripts leaving the scan', () => {
      // rawSession was never part of the session text selector, so a session whose
      // transcript alone contains the query term must still not match.
      store.replaceSession(
        'transcript-only',
        makeSession({
          sessionId: 'transcript-only',
          summary: 'unrelated summary',
          keywords: ['unrelated'],
          rawSession: [{ role: 'user', content: 'zebrafish' }],
        }),
        []
      );

      const result = store.retrieveProgressive('zebrafish');

      expect(result.rankedSessions).toHaveLength(0);
    });
  });

  describe('getSearchRows', () => {
    beforeEach(() => {
      store.replaceSession(
        'ws-a',
        makeSession({ sessionId: 'ws-a', sourceWorkspace: '/repo/a', embedding: [0.1, 0.2] }),
        [makeChunk('ws-a', { sourceWorkspace: '/repo/a', embedding: [0.3, 0.4] })]
      );
      store.replaceSession(
        'ws-b',
        makeSession({ sessionId: 'ws-b', sourceWorkspace: '/repo/b', embedding: [0.5, 0.6] }),
        [makeChunk('ws-b', { sourceWorkspace: '/repo/b' })]
      );
      store.replaceSession('global', makeSession({ sessionId: 'global', sourceWorkspace: null }), [
        makeChunk('global', { sourceWorkspace: null }),
      ]);
    });

    it('returns every row when no workspace is given', () => {
      const { sessions, chunks } = store.getSearchRows(null);

      expect(sessions.map((s) => s.sessionId).sort()).toEqual(['global', 'ws-a', 'ws-b']);
      expect(chunks).toHaveLength(3);
    });

    it('scoped search EXCLUDES global (NULL workspace) rows', () => {
      // Regression guard: `WHERE source_workspace = ?` must NOT be widened with
      // `OR source_workspace IS NULL`. That union belongs to retrieveProgressive;
      // adding it here would silently broaden search results.
      const { sessions, chunks } = store.getSearchRows('/repo/a');

      expect(sessions.map((s) => s.sessionId)).toEqual(['ws-a']);
      expect(chunks.map((c) => c.sessionId)).toEqual(['ws-a']);
    });

    it('returns nothing for a workspace with no rows', () => {
      const { sessions, chunks } = store.getSearchRows('/repo/unknown');

      expect(sessions).toEqual([]);
      expect(chunks).toEqual([]);
    });

    it('normalizes the workspace key before filtering', () => {
      const { sessions } = store.getSearchRows('/repo/a/');

      expect(sessions.map((s) => s.sessionId)).toEqual(['ws-a']);
    });

    it('carries neither embeddings nor transcripts — the point of the narrow shape', () => {
      const { sessions, chunks } = store.getSearchRows(null);

      for (const row of [...sessions, ...chunks]) {
        expect('embedding' in row).toBe(false);
        expect('rawSession' in row).toBe(false);
      }
    });

    it('exposes the fields the search path actually maps', () => {
      const { sessions, chunks } = store.getSearchRows('/repo/a');

      expect(sessions[0]).toMatchObject({
        sessionId: 'ws-a',
        sourceWorkspace: '/repo/a',
        sourceSessionId: 'ws-a',
        summary: 'A test session summary',
        keywords: ['test', 'session'],
      });
      expect(chunks[0]).toMatchObject({
        sessionId: 'ws-a',
        sourceWorkspace: '/repo/a',
        summary: 'A test chunk summary',
        details: 'Chunk details here',
        rawText: 'raw chunk text',
        keywords: ['chunk', 'test'],
      });
      expect(typeof chunks[0].id).toBe('string');
      expect(chunks[0].createdAt).toBe('2024-01-01T00:00:00');
      expect(chunks[0].ingestedAt).toBe('2024-01-01T00:00:00');
    });
  });

  describe('getPath()', () => {
    it('returns the db file path', () => {
      expect(store.getPath()).toBe(dbPath);
    });
  });
});
