/**
 * Tests for the embedding-format-version stamp on the experience memory store
 * (used to detect stale local indexes and offer a rebuild).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExperienceMemoryStore } from '../../main/memory/experience-memory-store';
import { EMBEDDING_FORMAT_VERSION } from '../../shared/local-embedding-types';

describe('ExperienceMemoryStore embedding format version', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-store-'));
    filePath = path.join(dir, 'experience.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to version 1 for a missing file and has no embeddings', () => {
    const store = new ExperienceMemoryStore(filePath);
    expect(store.getEmbeddingFormatVersion()).toBe(1);
    expect(store.hasEmbeddings()).toBe(false);
  });

  it('treats a file without the stamp as version 1 (pre-stamp index)', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessions: [],
        chunks: [{ id: 'c1', session_id: 's1', embedding: [0.1, 0.2, 0.3] }],
      })
    );
    const store = new ExperienceMemoryStore(filePath);
    expect(store.getEmbeddingFormatVersion()).toBe(1);
    expect(store.hasEmbeddings()).toBe(true);
  });

  it('reads an explicit stamp', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ sessions: [], chunks: [], embeddingFormatVersion: 2 })
    );
    const store = new ExperienceMemoryStore(filePath);
    expect(store.getEmbeddingFormatVersion()).toBe(2);
  });

  it('hasEmbeddings is false when chunks carry empty vectors', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ sessions: [], chunks: [{ id: 'c1', session_id: 's1', embedding: [] }] })
    );
    const store = new ExperienceMemoryStore(filePath);
    expect(store.hasEmbeddings()).toBe(false);
  });

  it('save() stamps the current EMBEDDING_FORMAT_VERSION', () => {
    // Load an old file, then re-save — the persisted stamp advances to current.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessions: [],
        chunks: [{ id: 'c1', session_id: 's1', embedding: [0.1] }],
        embeddingFormatVersion: 1,
      })
    );
    const store = new ExperienceMemoryStore(filePath);
    // Loaded value still reflects what was on disk.
    expect(store.getEmbeddingFormatVersion()).toBe(1);

    store.save();
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(persisted.embeddingFormatVersion).toBe(EMBEDDING_FORMAT_VERSION);

    // A fresh load now reports the current version (stale flag would clear).
    expect(new ExperienceMemoryStore(filePath).getEmbeddingFormatVersion()).toBe(
      EMBEDDING_FORMAT_VERSION
    );
  });
});
