/**
 * Tests for the embedding-format-version stamp on the experience memory store
 * (used to detect stale local indexes and offer a rebuild).
 *
 * The store now reads/writes version from memory_meta in memory.db.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExperienceMemoryStore } from '../../main/memory/experience-memory-store';
import { openMemoryDb, type MemoryDb } from '../../main/memory/memory-db';
import { setMemoryMeta } from '../../main/memory/memory-db';
import { EMBEDDING_FORMAT_VERSION } from '../../shared/local-embedding-types';

describe('ExperienceMemoryStore embedding format version', () => {
  let dir: string;
  let memDb: MemoryDb;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-store-fmt-'));
    dbPath = path.join(dir, 'memory.db');
    memDb = openMemoryDb(dir);
  });

  afterEach(() => {
    memDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to version 1 for a fresh db (no meta stamp) and has no embeddings', () => {
    const store = new ExperienceMemoryStore(memDb.raw, dbPath);
    expect(store.getEmbeddingFormatVersion()).toBe(1);
    expect(store.hasEmbeddings()).toBe(false);
  });

  it('treats a db without a stamp as version 1 (pre-migration install)', () => {
    // Seed a chunk with an embedding directly, leave no format-version meta.
    memDb.raw.exec(`
      INSERT INTO memory_chunks (id, session_id, summary, details, keywords, source_turns, raw_text, embedding)
      VALUES ('c1', 's1', '', '', '[]', '[]', '', X'0000803F')
    `);
    const store = new ExperienceMemoryStore(memDb.raw, dbPath);
    expect(store.getEmbeddingFormatVersion()).toBe(1);
    expect(store.hasEmbeddings()).toBe(true);
  });

  it('reads an explicit stamp from memory_meta', () => {
    setMemoryMeta(memDb.raw, 'embedding_format_version', '2');
    const store = new ExperienceMemoryStore(memDb.raw, dbPath);
    expect(store.getEmbeddingFormatVersion()).toBe(2);
  });

  it('hasEmbeddings is false when chunks carry null/empty embedding blobs', () => {
    memDb.raw.exec(`
      INSERT INTO memory_chunks (id, session_id, summary, details, keywords, source_turns, raw_text, embedding)
      VALUES ('c1', 's1', '', '', '[]', '[]', '', NULL)
    `);
    const store = new ExperienceMemoryStore(memDb.raw, dbPath);
    expect(store.hasEmbeddings()).toBe(false);
  });

  it('setEmbeddingFormatVersion() stamps the meta and getEmbeddingFormatVersion() reads it back', () => {
    const store = new ExperienceMemoryStore(memDb.raw, dbPath);
    expect(store.getEmbeddingFormatVersion()).toBe(1);

    store.setEmbeddingFormatVersion(EMBEDDING_FORMAT_VERSION);
    expect(store.getEmbeddingFormatVersion()).toBe(EMBEDDING_FORMAT_VERSION);

    // A fresh store instance over the same db also sees the updated version.
    const store2 = new ExperienceMemoryStore(memDb.raw, dbPath);
    expect(store2.getEmbeddingFormatVersion()).toBe(EMBEDDING_FORMAT_VERSION);
  });
});
