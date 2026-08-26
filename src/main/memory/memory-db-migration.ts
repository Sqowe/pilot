/**
 * One-time JSON → SQLite migration for experience memory.
 *
 * Idempotent: guarded by memory_meta.schema_version. If memory.db already has
 * the current schema version, this is a no-op. If experience_memory.json is
 * absent (embeddings never enabled), we just create the empty schema.
 *
 * On success the JSON is renamed to experience_memory.json.bak — not deleted —
 * so it serves as a rollback artefact for one release cycle.
 *
 * Crash safety: the INSERT happens inside a single SQLite transaction. WAL mode
 * means a crash mid-transaction rolls back cleanly. The .bak rename only happens
 * after the transaction commits, so the original JSON is never lost.
 *
 * See docs/design/memory-storage-sqlite-migration.md §9.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { log, logError, logWarn } from '../utils/logger';
import { MEMORY_DB_SCHEMA_VERSION, getMemoryMeta, setMemoryMeta } from './memory-db';
import { embeddingToBlob, loadJsonFile } from './memory-utils';
import { normalizeWorkspaceKey } from './memory-utils';

interface LegacyEmbedFile {
  sessions: Array<Record<string, unknown>>;
  chunks: Array<Record<string, unknown>>;
  embeddingFormatVersion?: number;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Run the backfill migration against an already-open memory.db handle.
 *
 * @param db          Open better-sqlite3 handle for memory.db.
 * @param jsonPath    Absolute path to experience_memory.json (may not exist).
 * @param embeddingModel  The active embedding model string (may be null/empty).
 */
export function runExperienceMemoryMigration(
  db: Database.Database,
  jsonPath: string,
  embeddingModel: string | null
): void {
  // Guard: already migrated at the current schema version?
  const storedVersion = getMemoryMeta(db, 'schema_version');
  const migratedFrom = getMemoryMeta(db, 'migrated_from');

  if (storedVersion === String(MEMORY_DB_SCHEMA_VERSION) && migratedFrom !== null) {
    // Already migrated — nothing to do.
    return;
  }

  // If we have no JSON to migrate, just stamp the meta and return.
  if (!fs.existsSync(jsonPath)) {
    setMemoryMeta(db, 'schema_version', String(MEMORY_DB_SCHEMA_VERSION));
    setMemoryMeta(db, 'migrated_from', 'none');
    setMemoryMeta(db, 'migrated_at', new Date().toISOString());
    log('[MemoryMigration] No JSON file to migrate — schema stamped as empty.');
    return;
  }

  log('[MemoryMigration] Starting JSON → SQLite migration from:', jsonPath);

  const raw = loadJsonFile<LegacyEmbedFile>(jsonPath, { sessions: [], chunks: [] });
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const chunks = Array.isArray(raw.chunks) ? raw.chunks : [];
  const embeddingFormatVersion =
    typeof raw.embeddingFormatVersion === 'number' ? raw.embeddingFormatVersion : 1;

  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO memory_sessions (
      id, session_id, source_workspace, source_workspace_label,
      source_session_id, source_session_title, source_session_date,
      summary, keywords, chunk_ids, raw_session,
      session_date, created_at, ingested_at,
      embedding, embedding_model, embedding_dim
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `);

  const insertChunk = db.prepare(`
    INSERT OR REPLACE INTO memory_chunks (
      id, session_id, source_workspace, source_workspace_label,
      source_session_id, source_session_title, source_session_date,
      summary, details, keywords, source_turns, raw_text,
      session_date, created_at, ingested_at,
      embedding, embedding_model, embedding_dim
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `);

  // Everything in a single transaction — crash-safe.
  const migrate = db.transaction(() => {
    let sessionCount = 0;
    let chunkCount = 0;

    for (const item of sessions) {
      if (typeof item.id !== 'string' || typeof item.session_id !== 'string') continue;
      const embedding = toNumberArray(item.embedding);
      const embBlob = embedding.length ? embeddingToBlob(embedding) : null;
      const embDim = embedding.length || null;
      const embModel = embedding.length ? (embeddingModel ?? null) : null;

      const result = insertSession.run(
        item.id,
        item.session_id,
        normalizeWorkspaceKey(str(item.source_workspace)),
        str(item.source_workspace_label),
        str(item.source_session_id) ?? item.session_id,
        str(item.source_session_title),
        str(item.source_session_date),
        typeof item.summary === 'string' ? item.summary : '',
        JSON.stringify(toStringArray(item.keywords)),
        JSON.stringify(toStringArray(item.chunk_ids)),
        Array.isArray(item.raw_session) ? JSON.stringify(item.raw_session) : null,
        str(item.session_date),
        str(item.created_at),
        str(item.ingested_at),
        embBlob,
        embModel,
        embDim
      );
      sessionCount += result.changes;
    }

    for (const item of chunks) {
      if (typeof item.id !== 'string' || typeof item.session_id !== 'string') continue;
      const embedding = toNumberArray(item.embedding);
      const embBlob = embedding.length ? embeddingToBlob(embedding) : null;
      const embDim = embedding.length || null;
      const embModel = embedding.length ? (embeddingModel ?? null) : null;

      const result = insertChunk.run(
        item.id,
        item.session_id,
        normalizeWorkspaceKey(str(item.source_workspace)),
        str(item.source_workspace_label),
        str(item.source_session_id) ?? item.session_id,
        str(item.source_session_title),
        str(item.source_session_date),
        typeof item.summary === 'string' ? item.summary : '',
        typeof item.details === 'string'
          ? item.details
          : typeof item.summary === 'string'
            ? item.summary
            : '',
        JSON.stringify(toStringArray(item.keywords)),
        JSON.stringify(
          Array.isArray(item.source_turns)
            ? item.source_turns.filter((t): t is number => typeof t === 'number')
            : []
        ),
        typeof item.raw_text === 'string' ? item.raw_text : '',
        str(item.session_date),
        str(item.created_at),
        str(item.ingested_at),
        embBlob,
        embModel,
        embDim
      );
      chunkCount += result.changes;
    }

    // Stamp meta — only written inside the transaction so a crash before commit
    // leaves schema_version un-stamped and the migration will retry next launch.
    setMemoryMeta(db, 'schema_version', String(MEMORY_DB_SCHEMA_VERSION));
    setMemoryMeta(db, 'migrated_from', path.basename(jsonPath));
    setMemoryMeta(db, 'migrated_at', new Date().toISOString());
    setMemoryMeta(db, 'embedding_format_version', String(embeddingFormatVersion));
    if (embeddingModel) {
      setMemoryMeta(db, 'embedding_model', embeddingModel);
    }

    log(`[MemoryMigration] Inserted ${sessionCount} sessions, ${chunkCount} chunks into memory.db`);
  });

  try {
    migrate();
  } catch (error) {
    logError('[MemoryMigration] Transaction failed — JSON file left intact:', error);
    throw error;
  }

  // Rename JSON to .bak only after the transaction commits successfully.
  // If a .bak already exists, use a timestamped name to preserve it.
  const bakPath = `${jsonPath}.bak`;
  try {
    const targetBakPath = fs.existsSync(bakPath)
      ? `${jsonPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`
      : bakPath;
    fs.renameSync(jsonPath, targetBakPath);
    log('[MemoryMigration] Renamed', path.basename(jsonPath), '→', path.basename(targetBakPath));
  } catch (renameError) {
    // Non-fatal: the data is safely in SQLite. Log and continue.
    logWarn('[MemoryMigration] Could not rename JSON to .bak:', renameError);
  }
}
