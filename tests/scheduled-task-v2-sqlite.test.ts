/**
 * True SQLite integration tests for scheduler v2.
 *
 * These tests use better-sqlite3 directly against an in-memory database
 * to verify real SQL behavior: schema migration (ensureColumn/ALTER TABLE),
 * ON CONFLICT DO UPDATE upsert semantics, FK cascade on delete,
 * run history CRUD, deterministic ordering, and prune query correctness.
 *
 * better-sqlite3 is an N-API module with a prebuilt binary per platform, so
 * these tests load the same binary the app does — no rebuild beforehand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

// --- Schema setup (mirrors src/main/db/database.ts initializeSchema) ---

function initializeTestSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      next_run_at INTEGER,
      schedule_config TEXT,
      repeat_every INTEGER,
      repeat_unit TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      last_run_session_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Simulate ensureColumn migrations for v2 fields
  const ensureColumn = (table: string, column: string, definition: string) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((r) => r.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  };

  ensureColumn('scheduled_tasks', 'config_set_id', "config_set_id TEXT NOT NULL DEFAULT 'default'");
  ensureColumn('scheduled_tasks', 'execution_mode', "execution_mode TEXT NOT NULL DEFAULT 'ask'");
  ensureColumn('scheduled_tasks', 'time_window', 'time_window TEXT');
  ensureColumn('scheduled_tasks', 'max_duration_ms', 'max_duration_ms INTEGER');
  ensureColumn('scheduled_tasks', 'max_tokens', 'max_tokens INTEGER');
  ensureColumn('scheduled_tasks', 'sandbox_mode', "sandbox_mode TEXT NOT NULL DEFAULT 'inherit'");

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT,
      tokens_used INTEGER,
      blocked_commands TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON scheduled_task_runs(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_started_at ON scheduled_task_runs(started_at)`);
}

// --- Prepared statements (mirrors production database.ts) ---

function prepareStatements(db: Database.Database) {
  const insertTask = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, title, prompt, cwd, run_at, next_run_at, schedule_config, repeat_every, repeat_unit, enabled, last_run_at, last_run_session_id, last_error, created_at, updated_at,
      config_set_id, execution_mode, time_window, max_duration_ms, max_tokens, sandbox_mode
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      prompt = excluded.prompt,
      cwd = excluded.cwd,
      run_at = excluded.run_at,
      next_run_at = excluded.next_run_at,
      schedule_config = excluded.schedule_config,
      repeat_every = excluded.repeat_every,
      repeat_unit = excluded.repeat_unit,
      enabled = excluded.enabled,
      last_run_at = excluded.last_run_at,
      last_run_session_id = excluded.last_run_session_id,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at,
      config_set_id = excluded.config_set_id,
      execution_mode = excluded.execution_mode,
      time_window = excluded.time_window,
      max_duration_ms = excluded.max_duration_ms,
      max_tokens = excluded.max_tokens,
      sandbox_mode = excluded.sandbox_mode
  `);

  const getTask = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`);
  const deleteTask = db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`);

  const insertRun = db.prepare(`
    INSERT INTO scheduled_task_runs (id, task_id, session_id, status, started_at, completed_at, error, tokens_used, blocked_commands, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getRunsByTaskId = db.prepare(`
    SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC, created_at DESC, id DESC LIMIT ?
  `);

  const getLatestRun = db.prepare(`
    SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC, created_at DESC, id DESC LIMIT 1
  `);

  const pruneRuns = db.prepare(`
    DELETE FROM scheduled_task_runs
    WHERE task_id = ? AND id NOT IN (
      SELECT id FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC, created_at DESC, id DESC LIMIT ?
    )
  `);

  return { insertTask, getTask, deleteTask, insertRun, getRunsByTaskId, getLatestRun, pruneRuns };
}

// --- Tests ---

describe('Scheduler v2 — true SQLite integration', () => {
  let db: Database.Database;
  let stmts: ReturnType<typeof prepareStatements>;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeTestSchema(db);
    stmts = prepareStatements(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('schema migration (ensureColumn)', () => {
    it('v2 columns have correct defaults for legacy rows', () => {
      // Insert a row using only v1 columns (simulating pre-migration data)
      db.prepare(
        `
        INSERT INTO scheduled_tasks (id, title, prompt, cwd, run_at, next_run_at, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run('legacy-1', 'Legacy', 'do stuff', '/ws', 1000, 1000, 1, 1000, 1000);

      const row = stmts.getTask.get('legacy-1') as Record<string, unknown>;
      expect(row.config_set_id).toBe('default');
      expect(row.execution_mode).toBe('ask');
      expect(row.time_window).toBeNull();
      expect(row.max_duration_ms).toBeNull();
      expect(row.max_tokens).toBeNull();
      expect(row.sandbox_mode).toBe('inherit');
    });

    it('ensureColumn is idempotent (running twice does not error)', () => {
      // Running the schema init again should not throw
      expect(() => initializeTestSchema(db)).not.toThrow();
    });
  });

  describe('upsert (ON CONFLICT DO UPDATE)', () => {
    it('updates existing row without deleting it (preserves row identity)', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'Original',
        'prompt',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      // Add a child run
      stmts.insertRun.run(
        'run-1',
        'task-1',
        null,
        'success',
        now,
        now + 1000,
        null,
        500,
        null,
        now
      );

      // Upsert the same task with updated title
      stmts.insertTask.run(
        'task-1',
        'Updated',
        'prompt',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now + 1,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      // Task should be updated
      const task = stmts.getTask.get('task-1') as Record<string, unknown>;
      expect(task.title).toBe('Updated');

      // Run should still exist (NOT cascade-deleted)
      const runs = stmts.getRunsByTaskId.all('task-1', 10) as Array<Record<string, unknown>>;
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('run-1');
    });

    it('preserves created_at on upsert (not in DO UPDATE SET)', () => {
      const originalCreatedAt = 1000;
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        originalCreatedAt,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      // Upsert with different created_at
      stmts.insertTask.run(
        'task-1',
        'T2',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        9999,
        now + 1,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      const task = stmts.getTask.get('task-1') as Record<string, unknown>;
      expect(task.created_at).toBe(originalCreatedAt); // preserved
      expect(task.title).toBe('T2'); // updated
    });
  });

  describe('FK cascade on delete', () => {
    it('deleting a task cascades to delete all its runs', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );
      stmts.insertRun.run(
        'run-1',
        'task-1',
        null,
        'success',
        now,
        now + 1000,
        null,
        null,
        null,
        now
      );
      stmts.insertRun.run(
        'run-2',
        'task-1',
        null,
        'failed',
        now + 2000,
        now + 3000,
        'err',
        null,
        null,
        now
      );

      // Verify runs exist
      expect(stmts.getRunsByTaskId.all('task-1', 10)).toHaveLength(2);

      // Delete parent
      stmts.deleteTask.run('task-1');

      // Runs should be gone
      expect(stmts.getRunsByTaskId.all('task-1', 10)).toHaveLength(0);
    });

    it('deleting one task does not affect runs of another task', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T1',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );
      stmts.insertTask.run(
        'task-2',
        'T2',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );
      stmts.insertRun.run(
        'run-1',
        'task-1',
        null,
        'success',
        now,
        now + 1000,
        null,
        null,
        null,
        now
      );
      stmts.insertRun.run(
        'run-2',
        'task-2',
        null,
        'success',
        now,
        now + 1000,
        null,
        null,
        null,
        now
      );

      stmts.deleteTask.run('task-1');

      expect(stmts.getRunsByTaskId.all('task-1', 10)).toHaveLength(0);
      expect(stmts.getRunsByTaskId.all('task-2', 10)).toHaveLength(1);
    });
  });

  describe('run history CRUD', () => {
    it('inserts and retrieves runs ordered by started_at DESC', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      stmts.insertRun.run('run-old', 'task-1', null, 'success', 1000, 2000, null, null, null, 1000);
      stmts.insertRun.run('run-new', 'task-1', 's2', 'failed', 5000, 6000, 'err', 1000, null, 5000);

      const runs = stmts.getRunsByTaskId.all('task-1', 10) as Array<Record<string, unknown>>;
      expect(runs).toHaveLength(2);
      expect(runs[0].id).toBe('run-new'); // most recent first
      expect(runs[1].id).toBe('run-old');
    });

    it('getLatestRun returns the most recent run', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      stmts.insertRun.run('run-1', 'task-1', null, 'success', 1000, 2000, null, null, null, 1000);
      stmts.insertRun.run('run-2', 'task-1', null, 'success', 9000, 10000, null, null, null, 9000);

      const latest = stmts.getLatestRun.get('task-1') as Record<string, unknown>;
      expect(latest.id).toBe('run-2');
    });

    it('stores and retrieves blocked_commands as JSON text', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      const cmds = JSON.stringify(['git push', 'rm -rf /']);
      stmts.insertRun.run('run-1', 'task-1', null, 'blocked', 1000, 1500, null, null, cmds, 1000);

      const run = stmts.getLatestRun.get('task-1') as Record<string, unknown>;
      expect(JSON.parse(run.blocked_commands as string)).toEqual(['git push', 'rm -rf /']);
    });

    it('respects LIMIT in getRunsByTaskId', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      for (let i = 0; i < 5; i++) {
        stmts.insertRun.run(
          `run-${i}`,
          'task-1',
          null,
          'success',
          i * 1000,
          i * 1000 + 500,
          null,
          null,
          null,
          i * 1000
        );
      }

      const limited = stmts.getRunsByTaskId.all('task-1', 3) as Array<Record<string, unknown>>;
      expect(limited).toHaveLength(3);
    });
  });

  describe('deterministic ordering', () => {
    it('uses secondary keys (created_at, id) when started_at is identical', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      // All runs have the same started_at but different created_at and id
      stmts.insertRun.run('aaa', 'task-1', null, 'success', 1000, 2000, null, null, null, 100);
      stmts.insertRun.run('bbb', 'task-1', null, 'success', 1000, 2000, null, null, null, 200);
      stmts.insertRun.run('ccc', 'task-1', null, 'success', 1000, 2000, null, null, null, 300);

      const runs = stmts.getRunsByTaskId.all('task-1', 10) as Array<Record<string, unknown>>;
      // Should be ordered by created_at DESC, then id DESC
      expect(runs[0].id).toBe('ccc'); // created_at=300
      expect(runs[1].id).toBe('bbb'); // created_at=200
      expect(runs[2].id).toBe('aaa'); // created_at=100
    });
  });

  describe('pruning', () => {
    it('keeps only the N most recent runs', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      for (let i = 1; i <= 5; i++) {
        stmts.insertRun.run(
          `run-${i}`,
          'task-1',
          null,
          'success',
          i * 1000,
          i * 1000 + 500,
          null,
          null,
          null,
          i * 1000
        );
      }

      stmts.pruneRuns.run('task-1', 'task-1', 2);

      const remaining = stmts.getRunsByTaskId.all('task-1', 10) as Array<Record<string, unknown>>;
      expect(remaining).toHaveLength(2);
      expect(remaining[0].id).toBe('run-5');
      expect(remaining[1].id).toBe('run-4');
    });

    it('prune with keepCount=0 deletes all runs', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );
      stmts.insertRun.run('run-1', 'task-1', null, 'success', 1000, 2000, null, null, null, 1000);

      stmts.pruneRuns.run('task-1', 'task-1', 0);

      expect(stmts.getRunsByTaskId.all('task-1', 10)).toHaveLength(0);
    });

    it('prune does not affect other tasks', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-1',
        'T1',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );
      stmts.insertTask.run(
        'task-2',
        'T2',
        'p',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'default',
        'ask',
        null,
        null,
        null,
        'inherit'
      );

      for (let i = 1; i <= 3; i++) {
        stmts.insertRun.run(
          `t1-run-${i}`,
          'task-1',
          null,
          'success',
          i * 1000,
          i * 1000 + 500,
          null,
          null,
          null,
          i * 1000
        );
        stmts.insertRun.run(
          `t2-run-${i}`,
          'task-2',
          null,
          'success',
          i * 1000,
          i * 1000 + 500,
          null,
          null,
          null,
          i * 1000
        );
      }

      stmts.pruneRuns.run('task-1', 'task-1', 1);

      expect(stmts.getRunsByTaskId.all('task-1', 10)).toHaveLength(1);
      expect(stmts.getRunsByTaskId.all('task-2', 10)).toHaveLength(3); // untouched
    });
  });

  describe('v2 field storage', () => {
    it('stores and retrieves all v2 fields correctly', () => {
      const now = Date.now();
      stmts.insertTask.run(
        'task-v2',
        'V2 Task',
        'auto review',
        '/ws',
        now,
        now,
        null,
        null,
        null,
        1,
        null,
        null,
        null,
        now,
        now,
        'fast-model',
        'auto',
        'morning',
        300000,
        50000,
        'require'
      );

      const row = stmts.getTask.get('task-v2') as Record<string, unknown>;
      expect(row.config_set_id).toBe('fast-model');
      expect(row.execution_mode).toBe('auto');
      expect(row.time_window).toBe('morning');
      expect(row.max_duration_ms).toBe(300000);
      expect(row.max_tokens).toBe(50000);
      expect(row.sandbox_mode).toBe('require');
    });
  });
});
