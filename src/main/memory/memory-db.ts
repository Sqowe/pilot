/**
 * memory.db — SQLite backing store for experience memory.
 *
 * Opens (or creates) memory.db under storageRoot with WAL mode, creates the
 * schema on first use, and exposes a thin typed handle. Kept separate from
 * cowork.db so memory stays under the configurable, relocatable storageRoot.
 *
 * Decision D1–D5: see docs/design/memory-storage-sqlite-migration.md §4–§5.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log, logError } from '../utils/logger';

export const MEMORY_DB_SCHEMA_VERSION = 1;

export interface MemoryDb {
  raw: Database.Database;
  close(): void;
}

/** Validate a SQL identifier to prevent injection in DDL statements. */
function validateIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}

const ALLOWED_COLUMN_TYPES = [
  'TEXT NOT NULL DEFAULT',
  'INTEGER DEFAULT',
  'INTEGER NOT NULL DEFAULT',
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
] as const;

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  validateIdentifier(table);
  validateIdentifier(column);

  const prefix = column + ' ';
  if (!definition.startsWith(prefix)) {
    throw new Error(`Column definition must start with column name: ${definition}`);
  }
  const typeSuffix = definition.slice(prefix.length).trim().toUpperCase();
  const matched = ALLOWED_COLUMN_TYPES.find(
    (t) => typeSuffix === t || typeSuffix.startsWith(t + ' ')
  );
  if (!matched) {
    throw new Error(`Unsupported column type in definition: ${typeSuffix}`);
  }
  const originalSuffix = definition.slice(prefix.length).trim();
  const safeDefinition = `${column} ${originalSuffix}`;

  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${safeDefinition}`);
}

function initSchema(db: Database.Database): void {
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_sessions (
        id                     TEXT PRIMARY KEY,
        session_id             TEXT NOT NULL,
        source_workspace       TEXT,
        source_workspace_label TEXT,
        source_session_id      TEXT,
        source_session_title   TEXT,
        source_session_date    TEXT,
        summary                TEXT NOT NULL DEFAULT '',
        keywords               TEXT NOT NULL DEFAULT '[]',
        chunk_ids              TEXT NOT NULL DEFAULT '[]',
        raw_session            TEXT,
        session_date           TEXT,
        created_at             TEXT,
        ingested_at            TEXT,
        embedding              BLOB,
        embedding_model        TEXT,
        embedding_dim          INTEGER
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id                     TEXT PRIMARY KEY,
        session_id             TEXT NOT NULL,
        source_workspace       TEXT,
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
      )
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_sessions_session_id
        ON memory_sessions(session_id)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mem_chunks_workspace
        ON memory_chunks(source_workspace)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mem_chunks_session
        ON memory_chunks(session_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mem_sessions_workspace
        ON memory_sessions(source_workspace)
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // Guard against future additive columns.
    ensureColumn(db, 'memory_sessions', 'embedding_model', 'embedding_model TEXT');
    ensureColumn(db, 'memory_sessions', 'embedding_dim', 'embedding_dim INTEGER');
    ensureColumn(db, 'memory_chunks', 'embedding_model', 'embedding_model TEXT');
    ensureColumn(db, 'memory_chunks', 'embedding_dim', 'embedding_dim INTEGER');

    // Stamp schema version if not already present.
    const existing = db
      .prepare(`SELECT value FROM memory_meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    if (!existing) {
      db.prepare(`INSERT INTO memory_meta (key, value) VALUES ('schema_version', ?)`).run(
        String(MEMORY_DB_SCHEMA_VERSION)
      );
    }

    log('[MemoryDb] Schema initialised');
  } catch (error) {
    logError('[MemoryDb] Schema initialisation failed:', error);
    throw error;
  }
}

/**
 * Open (or create) memory.db under `storageRoot`.
 * The caller is responsible for calling `close()` when done.
 */
export function openMemoryDb(storageRoot: string): MemoryDb {
  fs.mkdirSync(storageRoot, { recursive: true });
  const dbPath = path.join(storageRoot, 'memory.db');
  log('[MemoryDb] Opening database at:', dbPath);

  const raw = new Database(dbPath);
  initSchema(raw);

  return {
    raw,
    close() {
      try {
        raw.close();
      } catch {
        // ignore close errors during shutdown
      }
    },
  };
}

/** Read a single meta value, or null if absent. */
export function getMemoryMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM memory_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Write a meta key/value pair. */
export function setMemoryMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)`).run(key, value);
}
