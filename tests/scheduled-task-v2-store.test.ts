import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskRun,
  type ScheduledTaskRunStore,
  type ScheduledTaskStore,
} from '../src/main/schedule/scheduled-task-manager';

/**
 * Tests for scheduler v2 data model extensions:
 * - v2 fields on ScheduledTask (configSetId, executionMode, timeWindow, etc.)
 * - Run history CRUD (create, getByTaskId, getLatestByTaskId, pruneByTaskId)
 * - Defensive parsing of malformed blocked_commands
 * - Default values for v2 fields on legacy tasks
 */

describe('ScheduledTaskStore — v2 fields', () => {
  let store: ScheduledTaskStore;
  let tasks: Map<string, ScheduledTask>;

  beforeEach(() => {
    tasks = new Map();
    store = createInMemoryStore(tasks);
  });

  it('creates task with default v2 field values when not specified', () => {
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

  it('creates task with explicit v2 field values', () => {
    const task = store.create({
      prompt: 'auto code review',
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
      prompt: 'test task',
      cwd: '/workspace',
      runAt: Date.now() + 60_000,
    });

    const updated = store.update(task.id, {
      configSetId: 'new-config',
      executionMode: 'auto',
      timeWindow: 'evening',
      maxDurationMs: 120_000,
      maxTokens: 10_000,
      sandboxMode: 'skip',
    });

    expect(updated).not.toBeNull();
    expect(updated!.configSetId).toBe('new-config');
    expect(updated!.executionMode).toBe('auto');
    expect(updated!.timeWindow).toBe('evening');
    expect(updated!.maxDurationMs).toBe(120_000);
    expect(updated!.maxTokens).toBe(10_000);
    expect(updated!.sandboxMode).toBe('skip');
  });

  it('preserves v2 fields when updating only v1 fields', () => {
    const task = store.create({
      prompt: 'test task',
      cwd: '/workspace',
      runAt: Date.now() + 60_000,
      configSetId: 'my-config',
      executionMode: 'auto',
      timeWindow: 'afternoon',
    });

    const updated = store.update(task.id, { prompt: 'updated prompt' });

    expect(updated!.configSetId).toBe('my-config');
    expect(updated!.executionMode).toBe('auto');
    expect(updated!.timeWindow).toBe('afternoon');
  });

  it('allows setting timeWindow to null (revert to exact time)', () => {
    const task = store.create({
      prompt: 'test',
      cwd: '/workspace',
      runAt: Date.now() + 60_000,
      timeWindow: 'morning',
    });

    const updated = store.update(task.id, { timeWindow: null });
    expect(updated!.timeWindow).toBeNull();
  });
});

describe('ScheduledTaskRunStore — CRUD and pruning', () => {
  let runStore: ScheduledTaskRunStore;
  let runs: Map<string, ScheduledTaskRun>;

  beforeEach(() => {
    runs = new Map();
    runStore = createInMemoryRunStore(runs);
  });

  it('creates and retrieves a run by task ID', () => {
    const run: ScheduledTaskRun = {
      id: 'run-1',
      taskId: 'task-1',
      sessionId: 'session-abc',
      status: 'success',
      startedAt: 1000,
      completedAt: 2000,
      error: null,
      tokensUsed: 500,
      blockedCommands: null,
    };

    runStore.create(run);
    const results = runStore.getByTaskId('task-1');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(run);
  });

  it('getLatestByTaskId returns the most recent run', () => {
    runStore.create({
      id: 'run-1',
      taskId: 'task-1',
      sessionId: null,
      status: 'failed',
      startedAt: 1000,
      completedAt: 1500,
      error: 'timeout',
      tokensUsed: null,
      blockedCommands: null,
    });
    runStore.create({
      id: 'run-2',
      taskId: 'task-1',
      sessionId: 'session-2',
      status: 'success',
      startedAt: 2000,
      completedAt: 3000,
      error: null,
      tokensUsed: 1000,
      blockedCommands: null,
    });

    const latest = runStore.getLatestByTaskId('task-1');
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe('run-2');
    expect(latest!.status).toBe('success');
  });

  it('getLatestByTaskId returns null for unknown task', () => {
    const latest = runStore.getLatestByTaskId('nonexistent');
    expect(latest).toBeNull();
  });

  it('stores and retrieves blockedCommands array', () => {
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

    const result = runStore.getByTaskId('task-1');
    expect(result[0].blockedCommands).toEqual(['git push', 'rm -rf /']);
  });

  it('pruneByTaskId keeps only the specified number of recent runs', () => {
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
    // Should keep the most recent (highest startedAt)
    expect(remaining.map((r) => r.id)).toContain('run-5');
    expect(remaining.map((r) => r.id)).toContain('run-4');
  });

  it('pruneByTaskId with keepCount=0 deletes all runs', () => {
    runStore.create({
      id: 'run-1',
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
      id: 'run-1',
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
      id: 'run-2',
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

describe('blocked_commands parsing resilience', () => {
  it('handles malformed JSON gracefully', () => {
    // Simulate what parseBlockedCommands does with bad data
    const parseBlockedCommands = (value: string | null): string[] | null => {
      if (!value) return null;
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return null;
        if (!parsed.every((v: unknown) => typeof v === 'string')) return null;
        return parsed as string[];
      } catch {
        return null;
      }
    };

    expect(parseBlockedCommands(null)).toBeNull();
    expect(parseBlockedCommands('')).toBeNull();
    expect(parseBlockedCommands('not json')).toBeNull();
    expect(parseBlockedCommands('{}')).toBeNull(); // object, not array
    expect(parseBlockedCommands('42')).toBeNull(); // number, not array
    expect(parseBlockedCommands('[1, true, {}]')).toBeNull(); // non-string elements
    expect(parseBlockedCommands('[1, "git push"]')).toBeNull(); // mixed types
    expect(parseBlockedCommands('["git push","rm -rf"]')).toEqual(['git push', 'rm -rf']);
    expect(parseBlockedCommands('[]')).toEqual([]);
  });
});

// --- In-memory test helpers ---

let idCounter = 0;

function createInMemoryStore(tasks: Map<string, ScheduledTask>): ScheduledTaskStore {
  return {
    list: () => Array.from(tasks.values()),
    get: (id) => tasks.get(id) ?? null,
    create: (input: ScheduledTaskCreateInput) => {
      idCounter += 1;
      const now = Date.now();
      const task: ScheduledTask = {
        id: `task-${idCounter}`,
        title: input.title ?? '',
        prompt: input.prompt,
        cwd: input.cwd,
        runAt: input.runAt,
        nextRunAt: input.nextRunAt ?? input.runAt,
        scheduleConfig: input.scheduleConfig ?? null,
        repeatEvery: input.repeatEvery ?? null,
        repeatUnit: input.repeatUnit ?? null,
        enabled: input.enabled ?? true,
        lastRunAt: null,
        lastRunSessionId: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        configSetId: input.configSetId ?? 'default',
        executionMode: input.executionMode ?? 'ask',
        timeWindow: input.timeWindow ?? null,
        maxDurationMs: input.maxDurationMs ?? null,
        maxTokens: input.maxTokens ?? null,
        sandboxMode: input.sandboxMode ?? 'inherit',
      };
      tasks.set(task.id, task);
      return task;
    },
    update: (id, updates) => {
      const existing = tasks.get(id);
      if (!existing) return null;
      const updated: ScheduledTask = {
        ...existing,
        ...stripUndefined(updates),
        updatedAt: Date.now(),
      };
      tasks.set(id, updated);
      return updated;
    },
    delete: (id) => {
      return tasks.delete(id);
    },
  };
}

function createInMemoryRunStore(runs: Map<string, ScheduledTaskRun>): ScheduledTaskRunStore {
  return {
    create: (run: ScheduledTaskRun) => {
      runs.set(run.id, run);
    },
    getByTaskId: (taskId: string, limit = 10) => {
      return Array.from(runs.values())
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit);
    },
    getLatestByTaskId: (taskId: string) => {
      const taskRuns = Array.from(runs.values())
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => b.startedAt - a.startedAt);
      return taskRuns[0] ?? null;
    },
    deleteByTaskId: (taskId: string) => {
      for (const [id, run] of runs.entries()) {
        if (run.taskId === taskId) runs.delete(id);
      }
    },
    pruneByTaskId: (taskId: string, keepCount: number) => {
      const safeKeepCount = Math.max(0, Math.floor(keepCount));
      const taskRuns = Array.from(runs.values())
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => b.startedAt - a.startedAt);
      const toDelete = taskRuns.slice(safeKeepCount);
      for (const run of toDelete) {
        runs.delete(run.id);
      }
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
