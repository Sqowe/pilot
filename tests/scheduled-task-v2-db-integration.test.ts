/**
 * Integration tests for scheduler v2 store layer.
 *
 * Tests the real store implementation (createScheduledTaskStore, createScheduledTaskRunStore)
 * against a mock DatabaseInstance that simulates SQLite behavior including:
 * - v2 column defaults for legacy rows
 * - Upsert semantics (ON CONFLICT DO UPDATE preserves row identity)
 * - Run history CRUD and pruning
 * - FK cascade on task delete
 * - Enum validation in row-to-domain mapping
 *
 * Note: Direct better-sqlite3 tests cannot run in Vitest because the native
 * module is compiled against Electron's ABI (NODE_MODULE_VERSION 133), not the
 * system Node.js. These tests exercise the same code paths via a faithful mock.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createScheduledTaskStore,
  createScheduledTaskRunStore,
} from '../src/main/schedule/scheduled-task-store';
import type {
  DatabaseInstance,
  ScheduledTaskRow,
  ScheduledTaskRunRow,
} from '../src/main/db/database';

// --- Faithful in-memory mock of DatabaseInstance (scheduled task portion) ---

function createMockDatabaseInstance(): Pick<
  DatabaseInstance,
  'scheduledTasks' | 'scheduledTaskRuns'
> {
  const taskRows = new Map<string, ScheduledTaskRow>();
  const runRows = new Map<string, ScheduledTaskRunRow>();

  return {
    scheduledTasks: {
      create: (task: ScheduledTaskRow) => {
        // Simulate ON CONFLICT DO UPDATE: if row exists, update in place (preserve created_at)
        const existing = taskRows.get(task.id);
        if (existing) {
          taskRows.set(task.id, {
            ...task,
            created_at: existing.created_at, // ON CONFLICT doesn't update created_at
          });
        } else {
          taskRows.set(task.id, task);
        }
      },
      update: (id: string, updates: Partial<ScheduledTaskRow>) => {
        const existing = taskRows.get(id);
        if (!existing) return;
        const updated = { ...existing };
        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            (updated as Record<string, unknown>)[key] = value;
          }
        }
        updated.updated_at = Date.now();
        taskRows.set(id, updated);
      },
      get: (id: string) => taskRows.get(id),
      getAll: () => Array.from(taskRows.values()),
      delete: (id: string) => {
        taskRows.delete(id);
        // Simulate ON DELETE CASCADE
        for (const [runId, run] of runRows.entries()) {
          if (run.task_id === id) runRows.delete(runId);
        }
      },
    },
    scheduledTaskRuns: {
      create: (run: ScheduledTaskRunRow) => {
        runRows.set(run.id, run);
      },
      getByTaskId: (taskId: string, limit = 10) => {
        const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
        return Array.from(runRows.values())
          .filter((r) => r.task_id === taskId)
          .sort((a, b) => b.started_at - a.started_at)
          .slice(0, clampedLimit);
      },
      getLatestByTaskId: (taskId: string) => {
        const sorted = Array.from(runRows.values())
          .filter((r) => r.task_id === taskId)
          .sort((a, b) => b.started_at - a.started_at);
        return sorted[0];
      },
      deleteByTaskId: (taskId: string) => {
        for (const [id, run] of runRows.entries()) {
          if (run.task_id === taskId) runRows.delete(id);
        }
      },
      pruneByTaskId: (taskId: string, keepCount: number) => {
        const safeKeepCount = Math.max(0, Math.floor(keepCount));
        const taskRuns = Array.from(runRows.values())
          .filter((r) => r.task_id === taskId)
          .sort((a, b) => b.started_at - a.started_at);
        const toDelete = taskRuns.slice(safeKeepCount);
        for (const run of toDelete) {
          runRows.delete(run.id);
        }
      },
    },
  };
}

describe('createScheduledTaskStore — v2 field mapping and validation', () => {
  let mockDb: Pick<DatabaseInstance, 'scheduledTasks' | 'scheduledTaskRuns'>;
  let store: ReturnType<typeof createScheduledTaskStore>;

  beforeEach(() => {
    mockDb = createMockDatabaseInstance();
    store = createScheduledTaskStore(mockDb as DatabaseInstance);
  });

  it('creates task with v2 defaults when not specified', () => {
    const task = store.create({
      prompt: 'daily review',
      cwd: '/workspace',
      runAt: Date.now() + 60_000,
    });

    expect(task.configSetId).toBe('default');
    expect(task.executionMode).toBe('ask');
    expect(task.timeWindow).toBeNull();
    expect(task.maxDurationMs).toBeNull();
    expect(task.maxTokens).toBeNull();
    expect(task.sandboxMode).toBe('inherit');
  });

  it('creates task with explicit v2 values', () => {
    const task = store.create({
      prompt: 'auto review',
      cwd: '/workspace',
      runAt: Date.now() + 60_000,
      configSetId: 'fast-model',
      executionMode: 'auto',
      timeWindow: 'morning',
      maxDurationMs: 300_000,
      maxTokens: 50_000,
      sandboxMode: 'require',
    });

    expect(task.configSetId).toBe('fast-model');
    expect(task.executionMode).toBe('auto');
    expect(task.timeWindow).toBe('morning');
    expect(task.maxDurationMs).toBe(300_000);
    expect(task.maxTokens).toBe(50_000);
    expect(task.sandboxMode).toBe('require');
  });

  it('updates v2 fields independently', () => {
    const task = store.create({
      prompt: 'test',
      cwd: '/ws',
      runAt: Date.now() + 60_000,
    });

    const updated = store.update(task.id, {
      configSetId: 'new-config',
      executionMode: 'auto',
    });

    expect(updated!.configSetId).toBe('new-config');
    expect(updated!.executionMode).toBe('auto');
    expect(updated!.prompt).toBe('test'); // unchanged
  });

  it('validates executionMode — falls back to ask for invalid values', () => {
    const task = store.create({
      prompt: 'test',
      cwd: '/ws',
      runAt: Date.now() + 60_000,
    });

    // Simulate corrupted DB value by directly setting the row
    mockDb.scheduledTasks.update(task.id, {
      execution_mode: 'INVALID',
    } as Partial<ScheduledTaskRow>);

    const retrieved = store.get(task.id);
    expect(retrieved!.executionMode).toBe('ask'); // fallback
  });

  it('validates timeWindow — falls back to null for invalid values', () => {
    const task = store.create({
      prompt: 'test',
      cwd: '/ws',
      runAt: Date.now() + 60_000,
      timeWindow: 'morning',
    });

    mockDb.scheduledTasks.update(task.id, { time_window: 'midnight' } as Partial<ScheduledTaskRow>);

    const retrieved = store.get(task.id);
    expect(retrieved!.timeWindow).toBeNull(); // fallback
  });

  it('validates sandboxMode — falls back to inherit for invalid values', () => {
    const task = store.create({
      prompt: 'test',
      cwd: '/ws',
      runAt: Date.now() + 60_000,
    });

    mockDb.scheduledTasks.update(task.id, { sandbox_mode: 'BROKEN' } as Partial<ScheduledTaskRow>);

    const retrieved = store.get(task.id);
    expect(retrieved!.sandboxMode).toBe('inherit'); // fallback
  });

  it('handles legacy rows with empty/missing config_set_id', () => {
    const task = store.create({
      prompt: 'test',
      cwd: '/ws',
      runAt: Date.now() + 60_000,
    });

    // Simulate legacy row with empty string
    mockDb.scheduledTasks.update(task.id, { config_set_id: '' } as Partial<ScheduledTaskRow>);

    const retrieved = store.get(task.id);
    expect(retrieved!.configSetId).toBe('default'); // fallback for empty
  });

  describe('numeric field normalization', () => {
    it('normalizes maxDurationMs: null for non-positive/NaN/Infinity', () => {
      const t1 = store.create({
        prompt: 'a',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxDurationMs: -5000,
      });
      const t2 = store.create({
        prompt: 'b',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxDurationMs: NaN,
      });
      const t3 = store.create({
        prompt: 'c',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxDurationMs: Infinity,
      });
      expect(t1.maxDurationMs).toBeNull();
      expect(t2.maxDurationMs).toBeNull();
      expect(t3.maxDurationMs).toBeNull();
    });

    it('normalizes maxDurationMs: clamps to [1000, 86400000]', () => {
      const tooLow = store.create({
        prompt: 'a',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxDurationMs: 500,
      });
      const tooHigh = store.create({
        prompt: 'b',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxDurationMs: 100_000_000,
      });
      const valid = store.create({
        prompt: 'c',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxDurationMs: 60_000,
      });
      expect(tooLow.maxDurationMs).toBe(1000);
      expect(tooHigh.maxDurationMs).toBe(86_400_000);
      expect(valid.maxDurationMs).toBe(60_000);
    });

    it('normalizes maxDurationMs: floors to integer', () => {
      const task = store.create({
        prompt: 'a',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxDurationMs: 5000.7,
      });
      expect(task.maxDurationMs).toBe(5000);
    });

    it('normalizes maxTokens: null for non-positive/NaN', () => {
      const t1 = store.create({
        prompt: 'a',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxTokens: 0,
      });
      const t2 = store.create({
        prompt: 'b',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxTokens: NaN,
      });
      expect(t1.maxTokens).toBeNull();
      expect(t2.maxTokens).toBeNull();
    });

    it('normalizes maxTokens: clamps above 10M', () => {
      const task = store.create({
        prompt: 'a',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxTokens: 999_999_999,
      });
      expect(task.maxTokens).toBe(10_000_000);
    });

    it('normalizes numeric fields on update', () => {
      const task = store.create({
        prompt: 'a',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
        maxDurationMs: 60_000,
      });
      const updated = store.update(task.id, { maxDurationMs: -1, maxTokens: NaN });
      expect(updated!.maxDurationMs).toBeNull();
      expect(updated!.maxTokens).toBeNull();
    });
  });

  describe('upsert preserves run history (no cascade delete)', () => {
    it('upserting a task does not delete associated runs', () => {
      const task = store.create({
        prompt: 'test',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
      });

      // Add a run
      mockDb.scheduledTaskRuns.create({
        id: 'run-1',
        task_id: task.id,
        session_id: 'session-1',
        status: 'success',
        started_at: 1000,
        completed_at: 2000,
        error: null,
        tokens_used: 500,
        blocked_commands: null,
        created_at: 1000,
      });

      // Upsert the task (simulates what happens with ON CONFLICT DO UPDATE)
      mockDb.scheduledTasks.create({
        ...mockDb.scheduledTasks.get(task.id)!,
        title: 'Updated',
        updated_at: Date.now(),
      });

      // Runs should still exist
      const runs = mockDb.scheduledTaskRuns.getByTaskId(task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('run-1');
    });
  });

  describe('delete cascades to runs', () => {
    it('deleting a task removes all its runs', () => {
      const task = store.create({
        prompt: 'test',
        cwd: '/ws',
        runAt: Date.now() + 60_000,
      });

      mockDb.scheduledTaskRuns.create({
        id: 'run-1',
        task_id: task.id,
        session_id: null,
        status: 'success',
        started_at: 1000,
        completed_at: 2000,
        error: null,
        tokens_used: null,
        blocked_commands: null,
        created_at: 1000,
      });

      store.delete(task.id);

      const runs = mockDb.scheduledTaskRuns.getByTaskId(task.id);
      expect(runs).toHaveLength(0);
    });
  });
});

describe('createScheduledTaskRunStore — CRUD, pruning, and validation', () => {
  let mockDb: Pick<DatabaseInstance, 'scheduledTasks' | 'scheduledTaskRuns'>;
  let runStore: ReturnType<typeof createScheduledTaskRunStore>;

  beforeEach(() => {
    mockDb = createMockDatabaseInstance();
    runStore = createScheduledTaskRunStore(mockDb as DatabaseInstance);

    // Create a parent task for FK integrity
    mockDb.scheduledTasks.create({
      id: 'task-1',
      title: 'Test',
      prompt: 'test',
      cwd: '/ws',
      run_at: 1000,
      next_run_at: 1000,
      schedule_config: null,
      repeat_every: null,
      repeat_unit: null,
      enabled: 1,
      last_run_at: null,
      last_run_session_id: null,
      last_error: null,
      created_at: 1000,
      updated_at: 1000,
      config_set_id: 'default',
      execution_mode: 'ask',
      time_window: null,
      max_duration_ms: null,
      max_tokens: null,
      sandbox_mode: 'inherit',
    });
  });

  it('creates and retrieves runs', () => {
    runStore.create({
      id: 'run-1',
      taskId: 'task-1',
      sessionId: 'session-abc',
      status: 'success',
      startedAt: 1000,
      completedAt: 2000,
      error: null,
      tokensUsed: 500,
      blockedCommands: null,
    });

    const runs = runStore.getByTaskId('task-1');
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe('run-1');
    expect(runs[0].taskId).toBe('task-1');
    expect(runs[0].status).toBe('success');
    expect(runs[0].tokensUsed).toBe(500);
  });

  it('getLatestByTaskId returns most recent', () => {
    runStore.create({
      id: 'old',
      taskId: 'task-1',
      sessionId: null,
      status: 'failed',
      startedAt: 1000,
      completedAt: 1500,
      error: 'err',
      tokensUsed: null,
      blockedCommands: null,
    });
    runStore.create({
      id: 'new',
      taskId: 'task-1',
      sessionId: 's2',
      status: 'success',
      startedAt: 5000,
      completedAt: 6000,
      error: null,
      tokensUsed: 1000,
      blockedCommands: null,
    });

    const latest = runStore.getLatestByTaskId('task-1');
    expect(latest!.id).toBe('new');
  });

  it('getLatestByTaskId returns null for unknown task', () => {
    expect(runStore.getLatestByTaskId('nonexistent')).toBeNull();
  });

  it('stores and retrieves blockedCommands as string array', () => {
    runStore.create({
      id: 'run-blocked',
      taskId: 'task-1',
      sessionId: null,
      status: 'blocked',
      startedAt: 1000,
      completedAt: 1500,
      error: null,
      tokensUsed: null,
      blockedCommands: ['git push', 'rm -rf /'],
    });

    const runs = runStore.getByTaskId('task-1');
    expect(runs[0].blockedCommands).toEqual(['git push', 'rm -rf /']);
  });

  it('handles malformed blocked_commands JSON gracefully', () => {
    // Directly insert a run with malformed blocked_commands
    mockDb.scheduledTaskRuns.create({
      id: 'run-bad',
      task_id: 'task-1',
      session_id: null,
      status: 'blocked',
      started_at: 1000,
      completed_at: 1500,
      error: null,
      tokens_used: null,
      blocked_commands: 'not valid json {{{',
      created_at: 1000,
    });

    const runs = runStore.getByTaskId('task-1');
    expect(runs[0].blockedCommands).toBeNull(); // graceful fallback
  });

  it('rejects non-string array elements in blocked_commands', () => {
    mockDb.scheduledTaskRuns.create({
      id: 'run-mixed',
      task_id: 'task-1',
      session_id: null,
      status: 'blocked',
      started_at: 1000,
      completed_at: 1500,
      error: null,
      tokens_used: null,
      blocked_commands: '[1, true, "git push"]',
      created_at: 1000,
    });

    const runs = runStore.getByTaskId('task-1');
    expect(runs[0].blockedCommands).toBeNull(); // rejected: not all strings
  });

  it('validates run status — falls back to failed for invalid values', () => {
    mockDb.scheduledTaskRuns.create({
      id: 'run-invalid-status',
      task_id: 'task-1',
      session_id: null,
      status: 'INVALID_STATUS',
      started_at: 1000,
      completed_at: 1500,
      error: null,
      tokens_used: null,
      blocked_commands: null,
      created_at: 1000,
    });

    const runs = runStore.getByTaskId('task-1');
    expect(runs[0].status).toBe('failed'); // fallback
  });

  it('pruneByTaskId keeps only N most recent runs', () => {
    for (let i = 1; i <= 5; i++) {
      runStore.create({
        id: `run-${i}`,
        taskId: 'task-1',
        sessionId: null,
        status: 'success',
        startedAt: i * 1000,
        completedAt: i * 1000 + 500,
        error: null,
        tokensUsed: null,
        blockedCommands: null,
      });
    }

    runStore.pruneByTaskId('task-1', 2);

    const remaining = runStore.getByTaskId('task-1');
    expect(remaining).toHaveLength(2);
    expect(remaining[0].id).toBe('run-5');
    expect(remaining[1].id).toBe('run-4');
  });

  it('pruneByTaskId with keepCount=0 deletes all', () => {
    runStore.create({
      id: 'r1',
      taskId: 'task-1',
      sessionId: null,
      status: 'success',
      startedAt: 1000,
      completedAt: 2000,
      error: null,
      tokensUsed: null,
      blockedCommands: null,
    });

    runStore.pruneByTaskId('task-1', 0);
    expect(runStore.getByTaskId('task-1')).toHaveLength(0);
  });

  it('deleteByTaskId removes all runs for a task', () => {
    runStore.create({
      id: 'r1',
      taskId: 'task-1',
      sessionId: null,
      status: 'success',
      startedAt: 1000,
      completedAt: 2000,
      error: null,
      tokensUsed: null,
      blockedCommands: null,
    });
    runStore.create({
      id: 'r2',
      taskId: 'task-1',
      sessionId: null,
      status: 'failed',
      startedAt: 3000,
      completedAt: 4000,
      error: 'err',
      tokensUsed: null,
      blockedCommands: null,
    });

    runStore.deleteByTaskId('task-1');
    expect(runStore.getByTaskId('task-1')).toHaveLength(0);
  });
});
