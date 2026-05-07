import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScheduledTaskManager,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskRunStore,
  type ScheduledTaskStore,
} from '../src/main/schedule/scheduled-task-manager';

/**
 * Tests for config set deletion → scheduled task invalidation flow.
 *
 * Covers:
 * 1. Enabled matching tasks are timer-cleared and disabled
 * 2. Disabled matching tasks are still marked invalid (lastError set)
 * 3. Non-matching tasks remain unchanged
 * 4. onConfigInvalid callback fires exactly once per affected task
 * 5. Run history is recorded only for enabled tasks
 */

describe('ScheduledTaskManager.handleConfigSetDeleted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T10:00:00.000Z'));
  });

  it('disables enabled tasks referencing the deleted config set', () => {
    const now = Date.now();
    const store = createStore([
      createTask({
        id: 'task-a',
        configSetId: 'doomed-config',
        enabled: true,
        runAt: now + 60_000,
        nextRunAt: now + 60_000,
      }),
    ]);
    const onConfigInvalid = vi.fn();
    const runs: ScheduledTaskRun[] = [];
    const runStore = createRunStore(runs);

    const manager = new ScheduledTaskManager({
      store,
      executeTask: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      onConfigInvalid,
      runStore,
      now: () => Date.now(),
    });
    manager.start();

    manager.handleConfigSetDeleted('doomed-config');

    const task = store.get('task-a');
    expect(task?.enabled).toBe(false);
    expect(task?.nextRunAt).toBeNull();
    expect(task?.lastError).toContain('doomed-config');
    expect(task?.lastError).toContain('no longer exists');
  });

  it('marks disabled tasks as invalid (prevents re-enable with dangling ref)', () => {
    const now = Date.now();
    const store = createStore([
      createTask({
        id: 'task-disabled',
        configSetId: 'doomed-config',
        enabled: false,
        nextRunAt: now + 30_000,
      }),
    ]);
    const onConfigInvalid = vi.fn();

    const manager = new ScheduledTaskManager({
      store,
      executeTask: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      onConfigInvalid,
      now: () => Date.now(),
    });
    manager.start();

    manager.handleConfigSetDeleted('doomed-config');

    const task = store.get('task-disabled');
    expect(task?.enabled).toBe(false);
    expect(task?.nextRunAt).toBeNull();
    expect(task?.lastError).toContain('doomed-config');
    expect(onConfigInvalid).toHaveBeenCalledWith('task-disabled', 'doomed-config');
  });

  it('does not affect tasks referencing other config sets', () => {
    const now = Date.now();
    const store = createStore([
      createTask({
        id: 'task-safe',
        configSetId: 'other-config',
        enabled: true,
        runAt: now + 60_000,
        nextRunAt: now + 60_000,
      }),
      createTask({
        id: 'task-doomed',
        configSetId: 'doomed-config',
        enabled: true,
        runAt: now + 60_000,
        nextRunAt: now + 60_000,
      }),
    ]);
    const onConfigInvalid = vi.fn();

    const manager = new ScheduledTaskManager({
      store,
      executeTask: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      onConfigInvalid,
      now: () => Date.now(),
    });
    manager.start();

    manager.handleConfigSetDeleted('doomed-config');

    const safeTask = store.get('task-safe');
    expect(safeTask?.enabled).toBe(true);
    expect(safeTask?.lastError).toBeNull();

    const doomedTask = store.get('task-doomed');
    expect(doomedTask?.enabled).toBe(false);
    expect(doomedTask?.lastError).toContain('doomed-config');
  });

  it('emits onConfigInvalid exactly once per affected task', () => {
    const now = Date.now();
    const store = createStore([
      createTask({
        id: 'task-1',
        configSetId: 'doomed',
        enabled: true,
        runAt: now + 1000,
        nextRunAt: now + 1000,
      }),
      createTask({ id: 'task-2', configSetId: 'doomed', enabled: false, nextRunAt: null }),
      createTask({
        id: 'task-3',
        configSetId: 'safe',
        enabled: true,
        runAt: now + 1000,
        nextRunAt: now + 1000,
      }),
    ]);
    const onConfigInvalid = vi.fn();

    const manager = new ScheduledTaskManager({
      store,
      executeTask: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      onConfigInvalid,
      now: () => Date.now(),
    });
    manager.start();

    manager.handleConfigSetDeleted('doomed');

    expect(onConfigInvalid).toHaveBeenCalledTimes(2);
    expect(onConfigInvalid).toHaveBeenCalledWith('task-1', 'doomed');
    expect(onConfigInvalid).toHaveBeenCalledWith('task-2', 'doomed');
    expect(onConfigInvalid).not.toHaveBeenCalledWith('task-3', expect.anything());
  });

  it('records a blocked run only for enabled tasks', () => {
    const now = Date.now();
    const store = createStore([
      createTask({
        id: 'task-enabled',
        configSetId: 'doomed',
        enabled: true,
        runAt: now + 1000,
        nextRunAt: now + 1000,
      }),
      createTask({ id: 'task-disabled', configSetId: 'doomed', enabled: false, nextRunAt: null }),
    ]);
    const runs: ScheduledTaskRun[] = [];
    const runStore = createRunStore(runs);

    const manager = new ScheduledTaskManager({
      store,
      executeTask: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      runStore,
      now: () => Date.now(),
    });
    manager.start();

    manager.handleConfigSetDeleted('doomed');

    // Only the enabled task should have a run history entry
    expect(runs).toHaveLength(1);
    expect(runs[0].taskId).toBe('task-enabled');
    expect(runs[0].status).toBe('blocked');
  });

  it('clears scheduled timers for enabled tasks', async () => {
    const now = Date.now();
    const store = createStore([
      createTask({
        id: 'task-timed',
        configSetId: 'doomed',
        enabled: true,
        runAt: now + 5000,
        nextRunAt: now + 5000,
      }),
    ]);
    const executeTask = vi.fn().mockResolvedValue({ sessionId: 's1' });

    const manager = new ScheduledTaskManager({
      store,
      executeTask,
      isConfigSetValid: () => true,
      now: () => Date.now(),
    });
    manager.start();

    // Delete the config set before the timer fires
    manager.handleConfigSetDeleted('doomed');

    // Advance past the original timer — task should NOT execute
    await vi.advanceTimersByTimeAsync(10_000);

    expect(executeTask).not.toHaveBeenCalled();
  });

  it('is a no-op when no tasks reference the deleted config set', () => {
    const now = Date.now();
    const store = createStore([
      createTask({
        id: 'task-1',
        configSetId: 'safe',
        enabled: true,
        runAt: now + 1000,
        nextRunAt: now + 1000,
      }),
    ]);
    const onConfigInvalid = vi.fn();

    const manager = new ScheduledTaskManager({
      store,
      executeTask: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      onConfigInvalid,
      now: () => Date.now(),
    });
    manager.start();

    manager.handleConfigSetDeleted('nonexistent-config');

    expect(onConfigInvalid).not.toHaveBeenCalled();
    const task = store.get('task-1');
    expect(task?.enabled).toBe(true);
    expect(task?.lastError).toBeNull();
  });

  it('skips callback and history when store.update returns null (task removed mid-operation)', () => {
    const now = Date.now();
    const store = createStore([
      createTask({
        id: 'task-ghost',
        configSetId: 'doomed',
        enabled: true,
        runAt: now + 1000,
        nextRunAt: now + 1000,
      }),
    ]);
    const onConfigInvalid = vi.fn();
    const runs: ScheduledTaskRun[] = [];
    const runStore = createRunStore(runs);

    // Override update to return null (simulating task removed between list and update)
    const originalUpdate = store.update;
    store.update = (id, updates) => {
      if (id === 'task-ghost') return null;
      return originalUpdate(id, updates);
    };

    const manager = new ScheduledTaskManager({
      store,
      executeTask: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      onConfigInvalid,
      runStore,
      now: () => Date.now(),
    });
    manager.start();

    manager.handleConfigSetDeleted('doomed');

    // Neither callback nor run history should fire for the ghost task
    expect(onConfigInvalid).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });
});

/**
 * Tests for the IPC-level deletion gate logic (before/after comparison).
 * These validate the pattern used in config.deleteSet handler without
 * requiring the full Electron IPC stack.
 */
describe('config.deleteSet — deletion gate logic', () => {
  /**
   * Simulates the deletion gate logic from src/main/index.ts:
   * Only call handleConfigSetDeleted when the set existed before AND is absent after.
   */
  function shouldInvalidateTasks(
    previousConfigSets: Array<{ id: string }>,
    updatedConfigSets: Array<{ id: string }>,
    deletedId: string
  ): boolean {
    const existedBefore = previousConfigSets.some((set) => set.id === deletedId);
    const existsAfter = updatedConfigSets.some((set) => set.id === deletedId);
    return existedBefore && !existsAfter;
  }

  it('returns true when config set existed and was removed', () => {
    const before = [{ id: 'set-a' }, { id: 'set-b' }];
    const after = [{ id: 'set-a' }];
    expect(shouldInvalidateTasks(before, after, 'set-b')).toBe(true);
  });

  it('returns false when config set never existed (non-existent ID)', () => {
    const before = [{ id: 'set-a' }, { id: 'set-b' }];
    const after = [{ id: 'set-a' }, { id: 'set-b' }];
    expect(shouldInvalidateTasks(before, after, 'set-nonexistent')).toBe(false);
  });

  it('returns false when config set is protected and not removed (no-op delete)', () => {
    const before = [{ id: 'system-default' }, { id: 'set-a' }];
    const after = [{ id: 'system-default' }, { id: 'set-a' }]; // deleteSet was no-op
    expect(shouldInvalidateTasks(before, after, 'system-default')).toBe(false);
  });

  it('returns false when config set did not exist before but appears after (edge case)', () => {
    const before = [{ id: 'set-a' }];
    const after = [{ id: 'set-a' }, { id: 'set-new' }]; // hypothetical race
    expect(shouldInvalidateTasks(before, after, 'set-new')).toBe(false);
  });
});

// --- Test helpers ---

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = Date.now();
  return {
    id: 'task-1',
    title: '[定时任务] Test',
    prompt: 'do something',
    cwd: '/workspace',
    runAt: now + 60_000,
    nextRunAt: now + 60_000,
    scheduleConfig: null,
    repeatEvery: null,
    repeatUnit: null,
    enabled: true,
    lastRunAt: null,
    lastRunSessionId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    configSetId: 'default',
    executionMode: 'ask',
    timeWindow: null,
    maxDurationMs: null,
    maxTokens: null,
    sandboxMode: 'inherit',
    ...overrides,
  };
}

function createStore(initialTasks: ScheduledTask[] = []): ScheduledTaskStore {
  const tasks = new Map<string, ScheduledTask>(initialTasks.map((t) => [t.id, t]));

  return {
    list: () => Array.from(tasks.values()),
    get: (id) => tasks.get(id) ?? null,
    create: (input) => {
      const task = createTask({ ...input, id: `task-${Date.now()}` } as Partial<ScheduledTask>);
      tasks.set(task.id, task);
      return task;
    },
    update: (id, updates) => {
      const existing = tasks.get(id);
      if (!existing) return null;
      const updated = { ...existing };
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          (updated as Record<string, unknown>)[key] = value;
        }
      }
      updated.updatedAt = Date.now();
      tasks.set(id, updated);
      return updated;
    },
    delete: (id) => tasks.delete(id),
  };
}

function createRunStore(runs: ScheduledTaskRun[]): ScheduledTaskRunStore {
  return {
    create: (run) => {
      runs.push(run);
    },
    getByTaskId: (taskId, limit = 10) =>
      runs
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit),
    getLatestByTaskId: (taskId) => {
      const taskRuns = runs
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => b.startedAt - a.startedAt);
      return taskRuns[0] ?? null;
    },
    deleteByTaskId: (taskId) => {
      const indices = runs
        .map((r, i) => (r.taskId === taskId ? i : -1))
        .filter((i) => i >= 0)
        .reverse();
      for (const i of indices) runs.splice(i, 1);
    },
    pruneByTaskId: () => {
      /* no-op in tests */
    },
  };
}
