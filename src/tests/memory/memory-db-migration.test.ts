/**
 * Tests for the JSON → SQLite migration (memory-db-migration.ts).
 *
 * Covers:
 * - JSON fixture → backfill → row counts, BLOB embeddings, workspace scoping, .bak creation
 * - Idempotent re-run is a no-op (migrated_from already set)
 * - Simulated mid-transaction crash: JSON left intact, no .bak created
 * - Absent JSON (embeddings never enabled) → empty schema stamped, no error
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openMemoryDb, getMemoryMeta, type MemoryDb } from '../../main/memory/memory-db';
import { runExperienceMemoryMigration } from '../../main/memory/memory-db-migration';
import { blobToEmbedding } from '../../main/memory/memory-utils';
import { MEMORY_DB_SCHEMA_VERSION } from '../../main/memory/memory-db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

function makeLegacyJson(opts: {
  sessions?: unknown[];
  chunks?: unknown[];
  embeddingFormatVersion?: number;
}): unknown {
  return {
    sessions: opts.sessions ?? [],
    chunks: opts.chunks ?? [],
    embeddingFormatVersion: opts.embeddingFormatVersion ?? 1,
  };
}

function makeLegacySession(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id,
    session_id: id,
    source_workspace: overrides.source_workspace ?? null,
    source_workspace_label: overrides.source_workspace_label ?? '',
    source_session_id: id,
    source_session_title: 'Test Session',
    source_session_date: '2024-01-01',
    summary: 'A legacy session summary',
    keywords: ['legacy', 'test'],
    chunk_ids: overrides.chunk_ids ?? [],
    raw_session: [{ role: 'user', content: 'hello' }],
    session_date: '2024-01-01',
    created_at: '2024-01-01T00:00:00',
    ingested_at: '2024-01-01T00:00:00',
    embedding: overrides.embedding ?? [],
    ...overrides,
  };
}

function makeLegacyChunk(
  id: string,
  sessionId: string,
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    id,
    session_id: sessionId,
    source_workspace: overrides.source_workspace ?? null,
    source_workspace_label: '',
    source_session_id: sessionId,
    source_session_title: 'Test Session',
    source_session_date: '2024-01-01',
    summary: 'A legacy chunk summary',
    details: 'Chunk details',
    keywords: ['legacy', 'chunk'],
    source_turns: [1, 2],
    raw_text: 'raw chunk text',
    session_date: '2024-01-01',
    created_at: '2024-01-01T00:00:00',
    ingested_at: '2024-01-01T00:00:00',
    embedding: overrides.embedding ?? [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runExperienceMemoryMigration', () => {
  let dir: string;
  let memDb: MemoryDb;
  let jsonPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-migration-'));
    jsonPath = path.join(dir, 'experience_memory.json');
    memDb = openMemoryDb(dir);
  });

  afterEach(() => {
    memDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // JSON → SQLite backfill
  // -------------------------------------------------------------------------

  it('migrates sessions and chunks from JSON to SQLite', () => {
    writeJson(
      jsonPath,
      makeLegacyJson({
        sessions: [
          makeLegacySession('s1', { chunk_ids: ['c1', 'c2'] }),
          makeLegacySession('s2', { chunk_ids: ['c3'] }),
        ],
        chunks: [
          makeLegacyChunk('c1', 's1'),
          makeLegacyChunk('c2', 's1'),
          makeLegacyChunk('c3', 's2'),
        ],
      })
    );

    runExperienceMemoryMigration(memDb.raw, jsonPath, null);

    const sessionCount = (
      memDb.raw.prepare('SELECT COUNT(*) as n FROM memory_sessions').get() as { n: number }
    ).n;
    const chunkCount = (
      memDb.raw.prepare('SELECT COUNT(*) as n FROM memory_chunks').get() as { n: number }
    ).n;

    expect(sessionCount).toBe(2);
    expect(chunkCount).toBe(3);
  });

  it('renames the JSON to .bak after a successful migration', () => {
    writeJson(jsonPath, makeLegacyJson({ sessions: [makeLegacySession('s1')], chunks: [] }));

    runExperienceMemoryMigration(memDb.raw, jsonPath, null);

    expect(fs.existsSync(jsonPath)).toBe(false);
    // A .bak file (possibly timestamped) must exist under the same dir.
    const bakFiles = fs.readdirSync(dir).filter((f) => f.includes('.bak'));
    expect(bakFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('creates a timestamped .bak when .bak already exists (does not overwrite)', () => {
    writeJson(jsonPath, makeLegacyJson({ sessions: [makeLegacySession('s1')], chunks: [] }));
    // Pre-create a .bak to simulate a prior run.
    const existingBak = `${jsonPath}.bak`;
    fs.writeFileSync(existingBak, '{"prior":true}');

    runExperienceMemoryMigration(memDb.raw, jsonPath, null);

    // Original .bak must still be present.
    expect(fs.existsSync(existingBak)).toBe(true);
    expect(fs.readFileSync(existingBak, 'utf8')).toContain('prior');
    // A second timestamped .bak must have been created.
    const bakFiles = fs.readdirSync(dir).filter((f) => f.includes('.bak.'));
    expect(bakFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('stores embeddings as Float32 BLOBs and decodes them correctly', () => {
    const embedding = [0.1, 0.5, 0.9, 0.3];
    writeJson(
      jsonPath,
      makeLegacyJson({
        sessions: [],
        chunks: [makeLegacyChunk('c1', 's1', { embedding })],
      })
    );

    runExperienceMemoryMigration(memDb.raw, jsonPath, 'test-model');

    const row = memDb.raw
      .prepare('SELECT embedding, embedding_model, embedding_dim FROM memory_chunks WHERE id = ?')
      .get('c1') as { embedding: Buffer; embedding_model: string; embedding_dim: number };

    expect(row.embedding).toBeInstanceOf(Buffer);
    expect(row.embedding_model).toBe('test-model');
    expect(row.embedding_dim).toBe(4);

    const decoded = blobToEmbedding(row.embedding);
    expect(decoded).toHaveLength(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      expect(decoded[i]).toBeCloseTo(embedding[i], 5);
    }
  });

  it('preserves source_workspace for workspace-scoped entries', () => {
    const ws = '/projects/my-app';
    writeJson(
      jsonPath,
      makeLegacyJson({
        sessions: [makeLegacySession('s1', { source_workspace: ws })],
        chunks: [makeLegacyChunk('c1', 's1', { source_workspace: ws })],
      })
    );

    runExperienceMemoryMigration(memDb.raw, jsonPath, null);

    const sessionRow = memDb.raw
      .prepare('SELECT source_workspace FROM memory_sessions WHERE session_id = ?')
      .get('s1') as { source_workspace: string };
    const chunkRow = memDb.raw
      .prepare('SELECT source_workspace FROM memory_chunks WHERE id = ?')
      .get('c1') as { source_workspace: string };

    expect(sessionRow.source_workspace).toBe(ws);
    expect(chunkRow.source_workspace).toBe(ws);
  });

  it('stamps schema_version, migrated_from and embedding_format_version in memory_meta', () => {
    writeJson(jsonPath, makeLegacyJson({ sessions: [], chunks: [], embeddingFormatVersion: 2 }));

    runExperienceMemoryMigration(memDb.raw, jsonPath, 'openai/text-embedding-3-small');

    expect(getMemoryMeta(memDb.raw, 'schema_version')).toBe(String(MEMORY_DB_SCHEMA_VERSION));
    expect(getMemoryMeta(memDb.raw, 'migrated_from')).toBe('experience_memory.json');
    expect(getMemoryMeta(memDb.raw, 'migrated_at')).toBeTruthy();
    expect(getMemoryMeta(memDb.raw, 'embedding_format_version')).toBe('2');
    expect(getMemoryMeta(memDb.raw, 'embedding_model')).toBe('openai/text-embedding-3-small');
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('is a no-op when already migrated (migrated_from already set)', () => {
    writeJson(jsonPath, makeLegacyJson({ sessions: [makeLegacySession('s1')], chunks: [] }));
    runExperienceMemoryMigration(memDb.raw, jsonPath, null);

    // First run: s1 migrated, json renamed to .bak
    expect(
      (memDb.raw.prepare('SELECT COUNT(*) as n FROM memory_sessions').get() as { n: number }).n
    ).toBe(1);

    // Re-create the JSON with a new session to verify it is NOT re-read.
    writeJson(
      path.join(dir, 'experience_memory.json'),
      makeLegacyJson({ sessions: [makeLegacySession('s2')], chunks: [] })
    );

    runExperienceMemoryMigration(memDb.raw, path.join(dir, 'experience_memory.json'), null);

    // Still only 1 row — second run was a no-op.
    expect(
      (memDb.raw.prepare('SELECT COUNT(*) as n FROM memory_sessions').get() as { n: number }).n
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Absent JSON
  // -------------------------------------------------------------------------

  it('handles absent JSON gracefully (embeddings never enabled)', () => {
    expect(fs.existsSync(jsonPath)).toBe(false);

    runExperienceMemoryMigration(memDb.raw, jsonPath, null);

    // Schema stamped as empty
    expect(getMemoryMeta(memDb.raw, 'schema_version')).toBe(String(MEMORY_DB_SCHEMA_VERSION));
    expect(getMemoryMeta(memDb.raw, 'migrated_from')).toBe('none');

    // No rows
    expect(
      (memDb.raw.prepare('SELECT COUNT(*) as n FROM memory_sessions').get() as { n: number }).n
    ).toBe(0);

    // No .bak created
    expect(fs.existsSync(`${jsonPath}.bak`)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Crash safety: JSON intact when migration fails
  // -------------------------------------------------------------------------

  it('leaves the JSON intact if migration throws before commit', () => {
    writeJson(jsonPath, makeLegacyJson({ sessions: [makeLegacySession('bad')], chunks: [] }));

    // Close the db and reopen a broken handle that will fail on insert.
    memDb.close();

    // Open a new db, then drop the table so the insert will fail.
    memDb = openMemoryDb(dir);
    memDb.raw.exec('DROP TABLE IF EXISTS memory_sessions');

    expect(() => {
      runExperienceMemoryMigration(memDb.raw, jsonPath, null);
    }).toThrow();

    // Original JSON must still exist — .bak must NOT have been created.
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(`${jsonPath}.bak`)).toBe(false);

    // schema_version must NOT have been stamped.
    const schemaVersion = memDb.raw
      .prepare(`SELECT value FROM memory_meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    // Either absent or the value written by openMemoryDb before the table was dropped.
    // The key point is migrated_from is absent (transaction rolled back).
    const migratedFrom = memDb.raw
      .prepare(`SELECT value FROM memory_meta WHERE key = 'migrated_from'`)
      .get() as { value: string } | undefined;
    expect(migratedFrom).toBeUndefined();
    // Suppress TS unused-var for schemaVersion — it is intentionally not asserted
    // because openMemoryDb stamps it before the table drop.
    void schemaVersion;
  });

  // -------------------------------------------------------------------------
  // exportExperienceJson embedding round-trip
  // -------------------------------------------------------------------------

  it('normalizes source_workspace during migration so removeBySourceWorkspace works', () => {
    const rawWs = '/projects/my-app/';
    const normalizedWs = '/projects/my-app';
    writeJson(
      jsonPath,
      makeLegacyJson({
        sessions: [makeLegacySession('s1', { source_workspace: rawWs })],
        chunks: [makeLegacyChunk('c1', 's1', { source_workspace: rawWs })],
      })
    );

    runExperienceMemoryMigration(memDb.raw, jsonPath, null);

    const sessionRow = memDb.raw
      .prepare('SELECT source_workspace FROM memory_sessions WHERE session_id = ?')
      .get('s1') as { source_workspace: string };
    const chunkRow = memDb.raw
      .prepare('SELECT source_workspace FROM memory_chunks WHERE id = ?')
      .get('c1') as { source_workspace: string };

    // After normalization, trailing slash should be gone.
    expect(sessionRow.source_workspace).toBe(normalizedWs);
    expect(chunkRow.source_workspace).toBe(normalizedWs);
  });

  it('uses INSERT OR REPLACE so duplicate session_id rows are overwritten, not silently dropped', () => {
    // Pre-seed a session in the DB with the same session_id.
    memDb.raw.exec(`
      INSERT INTO memory_sessions (id, session_id, summary, keywords, chunk_ids)
      VALUES ('old-id', 's1', 'old summary', '[]', '[]')
    `);

    writeJson(
      jsonPath,
      makeLegacyJson({
        sessions: [makeLegacySession('new-id-for-s1', { session_id: 's1' })],
        chunks: [],
      })
    );

    // Migration must not silently ignore the conflict — it should replace.
    // Since the existing row has session_id='s1' and UNIQUE constraint exists,
    // INSERT OR REPLACE will upsert.
    runExperienceMemoryMigration(memDb.raw, jsonPath, null);

    const count = (
      memDb.raw
        .prepare('SELECT COUNT(*) as n FROM memory_sessions WHERE session_id = ?')
        .get('s1') as { n: number }
    ).n;
    expect(count).toBe(1);
    // The new row's id should now be present.
    const row = memDb.raw
      .prepare('SELECT id FROM memory_sessions WHERE session_id = ?')
      .get('s1') as { id: string };
    expect(row.id).toBe('new-id-for-s1');
  });

  it('migrated embeddings are decoded correctly by a full SELECT * export', () => {
    const embedding = [0.1, 0.5, 0.9, 0.3];
    writeJson(
      jsonPath,
      makeLegacyJson({
        sessions: [],
        chunks: [makeLegacyChunk('c1', 's1', { embedding })],
      })
    );

    runExperienceMemoryMigration(memDb.raw, jsonPath, 'test-model');

    // Simulate what exportExperienceJson does: SELECT * and decode BLOB.
    const row = memDb.raw.prepare('SELECT embedding FROM memory_chunks WHERE id = ?').get('c1') as {
      embedding: Buffer;
    };

    const decoded = blobToEmbedding(row.embedding);
    expect(decoded).toHaveLength(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      expect(decoded[i]).toBeCloseTo(embedding[i], 5);
    }
  });
});
