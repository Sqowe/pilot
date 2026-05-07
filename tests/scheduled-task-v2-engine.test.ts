import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScheduledTaskManager,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskRunStore,
  type ScheduledTaskStore,
  type SchedulerSettings,
  type MissedTask,
} from '../src/main/schedule/scheduled-task-manager';

/**
 * Tests for Phase 2 scheduler engine:
 * - Config set validation (auto-disable on invalid)
 * - Conflict policy (skip-if-busy)
 * - Catch-up detection and policy handling
 * - Run history recording
 * - Budget monitoring (duration timeout)
 */

describe('ScheduledTaskManager — v2 engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T10:00:00.000Z'));
  });

  describe('config set validation', () => {
    it('auto-disables task when config set is invalid', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({
          id: 'task-invalid-config',
          runAt: now + 1000,
          nextRunAt: now + 1000,
          configSetId: 'deleted-config',
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
      const onConfigInvalid = vi.fn();
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isConfigSetValid: (id) => id !== 'deleted-config',
        onConfigInvalid,
        runStore,
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(executeTask).not.toHaveBeenCalled();
      expect(onConfigInvalid).toHaveBeenCalledWith('task-invalid-config', 'deleted-config');

      const task = store.get('task-invalid-config');
      expect(task?.enabled).toBe(false);
      expect(task?.lastError).toContain('deleted-config');

      // Run should be recorded as 'blocked'
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('blocked');
    });

    it('executes normally when config set is valid', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({
          id: 'task-valid-config',
          runAt: now + 1000,
          nextRunAt: now + 1000,
          configSetId: 'my-config',
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(executeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('conflict policy', () => {
    it('skips task when agent is busy and policy is skip-if-busy', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({
          id: 'task-busy',
          runAt: now + 1000,
          nextRunAt: now + 1000,
          repeatEvery: 5,
          repeatUnit: 'minute',
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isAgentBusy: () => true,
        getSchedulerSettings: () => ({
          catchUpPolicy: 'ask',
          conflictPolicy: 'skip-if-busy',
          runHistoryDepth: 10,
        }),
        runStore,
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(executeTask).not.toHaveBeenCalled();
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('skipped');
    });

    it('proceeds when agent is busy and policy is queue', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({
          id: 'task-queue',
          runAt: now + 1000,
          nextRunAt: now + 1000,
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isAgentBusy: () => true,
        getSchedulerSettings: () => ({
          catchUpPolicy: 'ask',
          conflictPolicy: 'queue',
          runHistoryDepth: 10,
        }),
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(executeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('catch-up detection', () => {
    it('detects missed window tasks on start and emits onCatchUp for ask policy', () => {
      // Set time to 14:00 — morning window (09:00–11:00) is missed
      vi.setSystemTime(new Date('2026-05-07T14:00:00.000'));
      const now = Date.now();

      const store = createStore([
        createTask({
          id: 'missed-task',
          runAt: now - 3 * 60 * 60 * 1000, // 3 hours ago
          nextRunAt: now - 3 * 60 * 60 * 1000,
          timeWindow: 'morning',
          enabled: true,
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
      const onCatchUp = vi.fn();

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        onCatchUp,
        getSchedulerSettings: () => ({
          catchUpPolicy: 'ask',
          conflictPolicy: 'queue',
          runHistoryDepth: 10,
        }),
        now: () => Date.now(),
      });
      manager.start();

      expect(onCatchUp).toHaveBeenCalledTimes(1);
      const missedTasks: MissedTask[] = onCatchUp.mock.calls[0][0];
      expect(missedTasks).toHaveLength(1);
      expect(missedTasks[0].taskId).toBe('missed-task');
    });

    it('auto-skips missed tasks when policy is skip', () => {
      vi.setSystemTime(new Date('2026-05-07T14:00:00.000'));
      const now = Date.now();

      const store = createStore([
        createTask({
          id: 'missed-skip',
          runAt: now - 3 * 60 * 60 * 1000,
          nextRunAt: now - 3 * 60 * 60 * 1000,
          timeWindow: 'morning',
          enabled: true,
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        runStore,
        getSchedulerSettings: () => ({
          catchUpPolicy: 'skip',
          conflictPolicy: 'queue',
          runHistoryDepth: 10,
        }),
        now: () => Date.now(),
      });
      manager.start();

      // Task should be advanced, not executed
      expect(executeTask).not.toHaveBeenCalled();
      const task = store.get('missed-skip');
      // nextRunAt should be advanced to tomorrow's morning window start
      expect(task?.nextRunAt).toBeGreaterThan(now);
    });

    it('resolveCatchUp runs tasks marked as run', async () => {
      vi.setSystemTime(new Date('2026-05-07T14:00:00.000'));
      const now = Date.now();

      const store = createStore([
        createTask({
          id: 'catch-up-run',
          runAt: now - 3 * 60 * 60 * 1000,
          nextRunAt: now - 3 * 60 * 60 * 1000,
          timeWindow: 'morning',
          enabled: true,
          configSetId: 'default',
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
      const onCatchUp = vi.fn();

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        onCatchUp,
        isConfigSetValid: () => true,
        getSchedulerSettings: () => ({
          catchUpPolicy: 'ask',
          conflictPolicy: 'queue',
          runHistoryDepth: 10,
        }),
        now: () => Date.now(),
      });
      manager.start();

      // Resolve: run the missed task
      manager.resolveCatchUp([{ taskId: 'catch-up-run', action: 'run' }]);

      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(executeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('run history recording', () => {
    it('records successful run in run store', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({ id: 'task-record', runAt: now + 1000, nextRunAt: now + 1000 }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-abc' });
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        runStore,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(runs).toHaveLength(1);
      expect(runs[0].taskId).toBe('task-record');
      expect(runs[0].status).toBe('success');
      expect(runs[0].sessionId).toBe('session-abc');
    });

    it('records failed run in run store', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({ id: 'task-fail', runAt: now + 1000, nextRunAt: now + 1000 }),
      ]);
      const executeTask = vi.fn().mockRejectedValue(new Error('LLM timeout'));
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        runStore,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      await Promise.resolve();

      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('failed');
      expect(runs[0].error).toBe('LLM timeout');

      consoleSpy.mockRestore();
    });

    it('prunes run history after recording', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({ id: 'task-prune', runAt: now + 1000, nextRunAt: now + 1000 }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
      const pruned: Array<{ taskId: string; keepCount: number }> = [];
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);
      runStore.pruneByTaskId = (taskId, keepCount) => {
        pruned.push({ taskId, keepCount });
      };

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        runStore,
        isConfigSetValid: () => true,
        getSchedulerSettings: () => ({
          catchUpPolicy: 'ask',
          conflictPolicy: 'queue',
          runHistoryDepth: 5,
        }),
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(pruned).toHaveLength(1);
      expect(pruned[0]).toEqual({ taskId: 'task-prune', keepCount: 5 });
    });
  });
  describe('time-window with future nextRunAt', () => {
    it('does not fire today when nextRunAt is tomorrow', async () => {
      // Current time: 10:00 AM (within morning window 09:00–11:00)
      // But task's nextRunAt is tomorrow — should NOT fire today
      const now = Date.now();
      const tomorrow = now + 24 * 60 * 60 * 1000;

      const store = createStore([
        createTask({
          id: 'future-window-task',
          runAt: tomorrow,
          nextRunAt: tomorrow,
          timeWindow: 'morning',
          enabled: true,
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      // Advance through today's entire morning window — should NOT fire
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 2 hours

      expect(executeTask).not.toHaveBeenCalled();
    });

    it('fires when nextRunAt arrives and window is active', async () => {
      // Set time to 08:00 — before morning window
      vi.setSystemTime(new Date('2026-05-07T08:00:00.000'));
      const now = Date.now();

      // nextRunAt is in 30 minutes (08:30) — still before window
      const store = createStore([
        createTask({
          id: 'future-then-window',
          runAt: now + 30 * 60 * 1000,
          nextRunAt: now + 30 * 60 * 1000, // 08:30
          timeWindow: 'morning',
          enabled: true,
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      // Advance to 08:30 — nextRunAt timer fires, re-enters scheduleTask
      // which computes a random firing time within 09:00–11:00
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(executeTask).not.toHaveBeenCalled();

      // Advance through the entire morning window (3 hours from 08:00 = 11:00)
      // This guarantees we pass any random firing time within 09:00–11:00
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);

      expect(executeTask).toHaveBeenCalledTimes(1);
    });

    it('applies randomization when entering window from future nextRunAt', async () => {
      // Set time to 08:55 — 5 minutes before morning window
      vi.setSystemTime(new Date('2026-05-07T08:55:00.000'));
      const now = Date.now();

      const store = createStore([
        createTask({
          id: 'randomize-on-entry',
          runAt: now,
          nextRunAt: now, // already due
          timeWindow: 'morning',
          enabled: true,
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      // At 08:55, nextRunAt <= now, computeRandomFiringTime('morning', 08:55)
      // returns a time in 09:00–11:00 (since 08:55 is before window start)
      // So it should NOT fire immediately
      expect(executeTask).not.toHaveBeenCalled();

      // Advance 5 minutes to 09:00 — still might not fire (random offset)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // Advance through the full window to ensure it fires
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      expect(executeTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('one-time task + skip-if-busy', () => {
    it('disables one-time task when skipped due to busy agent', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({
          id: 'one-time-busy',
          runAt: now + 1000,
          nextRunAt: now + 1000,
          repeatEvery: null,
          repeatUnit: null,
          scheduleConfig: null,
        }),
      ]);
      const executeTask = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isAgentBusy: () => true,
        getSchedulerSettings: () => ({
          catchUpPolicy: 'ask',
          conflictPolicy: 'skip-if-busy',
          runHistoryDepth: 10,
        }),
        runStore,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(executeTask).not.toHaveBeenCalled();

      const task = store.get('one-time-busy');
      expect(task?.enabled).toBe(false);
      expect(task?.nextRunAt).toBeNull();
      expect(runs[0].status).toBe('skipped');
    });
  });

  describe('budget timeout enforcement', () => {
    it('aborts execution when maxDurationMs is exceeded (hung executeTask)', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({
          id: 'task-timeout',
          runAt: now + 1000,
          nextRunAt: now + 1000,
          maxDurationMs: 5000, // 5 second budget
        }),
      ]);

      // executeTask that never resolves (simulates a hung session)
      const executeTask = vi.fn().mockImplementation(
        () =>
          new Promise<never>(() => {
            /* never resolves */
          })
      );
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);
      const onBudgetExceeded = vi.fn();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        runStore,
        onBudgetExceeded,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      // Advance to trigger the task
      await vi.advanceTimersByTimeAsync(1000);

      // Advance past the budget timeout
      await vi.advanceTimersByTimeAsync(5000);
      // Flush microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(onBudgetExceeded).toHaveBeenCalledWith('task-timeout', expect.any(String), 'time');
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('timeout');
      expect(runs[0].error).toContain('Budget exceeded: time');

      consoleSpy.mockRestore();
    });

    it('does not timeout when execution completes within budget', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({
          id: 'task-fast',
          runAt: now + 1000,
          nextRunAt: now + 1000,
          maxDurationMs: 10_000, // 10 second budget
        }),
      ]);

      // executeTask resolves quickly
      const executeTask = vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) => setTimeout(() => resolve({ sessionId: 'fast-session' }), 2000))
        );
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);
      const onBudgetExceeded = vi.fn();

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        runStore,
        onBudgetExceeded,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      // Trigger the task
      await vi.advanceTimersByTimeAsync(1000);
      // Let it complete (2s execution)
      await vi.advanceTimersByTimeAsync(2000);

      expect(onBudgetExceeded).not.toHaveBeenCalled();
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('success');
    });

    it('late completion after timeout does not mutate task state', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({
          id: 'task-late',
          runAt: now + 1000,
          nextRunAt: now + 1000,
          maxDurationMs: 3000, // 3 second budget
        }),
      ]);

      // executeTask resolves AFTER the timeout (at 5s)
      let resolveExecution: ((v: { sessionId: string }) => void) | null = null;
      const executeTask = vi.fn().mockImplementation(
        () =>
          new Promise<{ sessionId: string }>((resolve) => {
            resolveExecution = resolve;
          })
      );
      const runs: ScheduledTaskRun[] = [];
      const runStore = createRunStore(runs);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        runStore,
        isConfigSetValid: () => true,
        now: () => Date.now(),
      });
      manager.start();

      // Trigger the task
      await vi.advanceTimersByTimeAsync(1000);

      // Advance past the budget timeout
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.resolve();
      await Promise.resolve();

      // Should be recorded as timeout
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('timeout');

      const taskAfterTimeout = store.get('task-late');
      expect(taskAfterTimeout?.lastError).toContain('Budget exceeded');

      // Now the late execution resolves
      resolveExecution?.({ sessionId: 'late-session' });
      await Promise.resolve();
      await Promise.resolve();

      // Task state should NOT be overwritten by the late completion
      const taskAfterLate = store.get('task-late');
      expect(taskAfterLate?.lastError).toContain('Budget exceeded');
      expect(taskAfterLate?.lastRunSessionId).toBeNull(); // not 'late-session'

      // No additional run recorded
      expect(runs).toHaveLength(1);

      consoleSpy.mockRestore();
    });
  });

  describe('lifecycle callback ordering', () => {
    it('calls onTaskStarted before execution and onTaskCompleted after', async () => {
      const now = Date.now();
      const store = createStore([
        createTask({ id: 'task-lifecycle', runAt: now + 1000, nextRunAt: now + 1000 }),
      ]);

      const callOrder: string[] = [];
      const executeTask = vi.fn().mockImplementation(async () => {
        callOrder.push('execute');
        return { sessionId: 'session-1' };
      });

      const manager = new ScheduledTaskManager({
        store,
        executeTask,
        isConfigSetValid: () => true,
        onTaskStarted: () => {
          callOrder.push('started');
        },
        onTaskCompleted: () => {
          callOrder.push('completed');
        },
        now: () => Date.now(),
      });
      manager.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(callOrder).toEqual(['started', 'execute', 'completed']);
    });
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
    pruneByTaskId: (_taskId, _keepCount) => {
      /* no-op in tests unless overridden */
    },
  };
}
