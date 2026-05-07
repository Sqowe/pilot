/**
 * @module main/schedule/scheduled-task-manager
 *
 * Cron-like scheduled task system (488 lines).
 *
 * Responsibilities:
 * - Scheduled task CRUD with daily/weekly/interval repeat modes
 * - Timer-based execution engine with tick loop
 * - Task persistence via SQLite (ScheduledTask rows)
 * - Delegates execution to session-manager for AI-powered tasks
 *
 * Dependencies: session-manager, database
 */
import {
  buildScheduledTaskFallbackTitle,
  buildScheduledTaskTitle,
} from '../../shared/schedule/task-title';
import {
  type TimeWindow,
  type ExecutionMode,
  type CatchUpPolicy,
  type ConflictPolicy,
  type SandboxMode,
  type ScheduledTaskRunStatus,
} from '../../shared/schedule/types';
import { log, logError } from '../utils/logger';
import {
  computeRandomFiringTime,
  computeNextWindowStart,
  isWithinWindow,
  wasWindowMissed,
} from './time-window';

export type {
  TimeWindow,
  ExecutionMode,
  CatchUpPolicy,
  ConflictPolicy,
  SandboxMode,
  ScheduledTaskRunStatus,
};

export type ScheduleRepeatUnit = 'minute' | 'hour' | 'day';
export type ScheduledTaskWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Internal error used to signal budget exceeded via Promise.race. */
class BudgetExceededError extends Error {
  readonly budgetType: 'time' | 'tokens';
  constructor(budgetType: 'time' | 'tokens') {
    super(`Budget exceeded: ${budgetType}`);
    this.budgetType = budgetType;
    this.name = 'BudgetExceededError';
  }
}

export interface ScheduledTaskDailyScheduleConfig {
  kind: 'daily';
  times: string[];
}

export interface ScheduledTaskWeeklyScheduleConfig {
  kind: 'weekly';
  weekdays: ScheduledTaskWeekday[];
  times: string[];
}

export type ScheduledTaskScheduleConfig =
  | ScheduledTaskDailyScheduleConfig
  | ScheduledTaskWeeklyScheduleConfig;

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  runAt: number;
  nextRunAt: number | null;
  scheduleConfig: ScheduledTaskScheduleConfig | null;
  repeatEvery: number | null;
  repeatUnit: ScheduleRepeatUnit | null;
  enabled: boolean;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;

  // --- v2 fields ---
  configSetId: string;
  executionMode: ExecutionMode;
  timeWindow: TimeWindow | null;
  maxDurationMs: number | null;
  maxTokens: number | null;
  sandboxMode: SandboxMode;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: ScheduledTaskRunStatus;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  tokensUsed: number | null;
  blockedCommands: string[] | null;
}

export interface SchedulerSettings {
  catchUpPolicy: CatchUpPolicy;
  conflictPolicy: ConflictPolicy;
  runHistoryDepth: number;
}

export interface ScheduledTaskCreateInput {
  title?: string;
  prompt: string;
  cwd: string;
  runAt: number;
  nextRunAt?: number | null;
  scheduleConfig?: ScheduledTaskScheduleConfig | null;
  repeatEvery?: number | null;
  repeatUnit?: ScheduleRepeatUnit | null;
  enabled?: boolean;
  // v2 fields
  configSetId?: string;
  executionMode?: ExecutionMode;
  timeWindow?: TimeWindow | null;
  maxDurationMs?: number | null;
  maxTokens?: number | null;
  sandboxMode?: SandboxMode;
}

export interface ScheduledTaskUpdateInput {
  title?: string;
  prompt?: string;
  cwd?: string;
  runAt?: number;
  nextRunAt?: number | null;
  scheduleConfig?: ScheduledTaskScheduleConfig | null;
  repeatEvery?: number | null;
  repeatUnit?: ScheduleRepeatUnit | null;
  enabled?: boolean;
  lastRunAt?: number | null;
  lastRunSessionId?: string | null;
  lastError?: string | null;
  // v2 fields
  configSetId?: string;
  executionMode?: ExecutionMode;
  timeWindow?: TimeWindow | null;
  maxDurationMs?: number | null;
  maxTokens?: number | null;
  sandboxMode?: SandboxMode;
}

export interface ScheduledTaskStore {
  list(): ScheduledTask[];
  get(id: string): ScheduledTask | null;
  create(input: ScheduledTaskCreateInput): ScheduledTask;
  update(id: string, updates: ScheduledTaskUpdateInput): ScheduledTask | null;
  delete(id: string): boolean;
}

export interface ScheduledTaskRunStore {
  create(run: ScheduledTaskRun): void;
  getByTaskId(taskId: string, limit?: number): ScheduledTaskRun[];
  getLatestByTaskId(taskId: string): ScheduledTaskRun | null;
  deleteByTaskId(taskId: string): void;
  pruneByTaskId(taskId: string, keepCount: number): void;
}

export interface ScheduledTaskRunResult {
  sessionId: string;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ScheduledTaskExecutionRecord {
  success: boolean;
  sessionId?: string;
  error?: string;
}

interface ScheduledTaskManagerOptions {
  store: ScheduledTaskStore;
  executeTask: (task: ScheduledTask) => Promise<ScheduledTaskRunResult>;
  onTaskError?: (taskId: string, error: string) => void;
  now?: () => number;
  // v2 options
  runStore?: ScheduledTaskRunStore;
  getSchedulerSettings?: () => SchedulerSettings;
  isConfigSetValid?: (configSetId: string) => boolean;
  isAgentBusy?: () => boolean;
  onCatchUp?: (tasks: MissedTask[]) => void;
  onTaskStarted?: (taskId: string, runId: string, sessionId: string) => void;
  onTaskCompleted?: (
    taskId: string,
    runId: string,
    status: ScheduledTaskRunStatus,
    tokensUsed: number | null
  ) => void;
  onConfigInvalid?: (taskId: string, configSetId: string) => void;
  onBudgetExceeded?: (taskId: string, runId: string, type: 'time' | 'tokens') => void;
  generateRunId?: () => string;
}

export interface MissedTask {
  taskId: string;
  title: string;
  timeWindow: TimeWindow | null;
  scheduledFor: number;
}

export class ScheduledTaskManager {
  private readonly store: ScheduledTaskStore;
  private readonly executeTask: (task: ScheduledTask) => Promise<ScheduledTaskRunResult>;
  private readonly onTaskError?: (taskId: string, error: string) => void;
  private readonly now: () => number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly executingTasks = new Set<string>();
  private running = false;

  // v2 dependencies
  private readonly runStore?: ScheduledTaskRunStore;
  private readonly getSchedulerSettings: () => SchedulerSettings;
  private readonly isConfigSetValid: (configSetId: string) => boolean;
  private readonly isAgentBusy: () => boolean;
  private readonly onCatchUp?: (tasks: MissedTask[]) => void;
  private readonly onTaskStarted?: (taskId: string, runId: string, sessionId: string) => void;
  private readonly onTaskCompleted?: (
    taskId: string,
    runId: string,
    status: ScheduledTaskRunStatus,
    tokensUsed: number | null
  ) => void;
  private readonly onConfigInvalid?: (taskId: string, configSetId: string) => void;
  private readonly onBudgetExceeded?: (
    taskId: string,
    runId: string,
    type: 'time' | 'tokens'
  ) => void;
  private readonly generateRunId: () => string;

  constructor(options: ScheduledTaskManagerOptions) {
    this.store = options.store;
    this.executeTask = options.executeTask;
    this.onTaskError = options.onTaskError;
    this.now = options.now ?? (() => Date.now());

    // v2 options with safe defaults
    this.runStore = options.runStore;
    this.getSchedulerSettings =
      options.getSchedulerSettings ??
      (() => ({
        catchUpPolicy: 'ask' as CatchUpPolicy,
        conflictPolicy: 'queue' as ConflictPolicy,
        runHistoryDepth: 10,
      }));
    this.isConfigSetValid = options.isConfigSetValid ?? (() => true);
    this.isAgentBusy = options.isAgentBusy ?? (() => false);
    this.onCatchUp = options.onCatchUp;
    this.onTaskStarted = options.onTaskStarted;
    this.onTaskCompleted = options.onTaskCompleted;
    this.onConfigInvalid = options.onConfigInvalid;
    this.onBudgetExceeded = options.onBudgetExceeded;
    this.generateRunId =
      options.generateRunId ??
      (() => `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tasks = this.store.list();
    const missedTasks: MissedTask[] = [];

    for (const task of tasks) {
      if (!task.enabled) continue;

      // Check for missed windows (v2 catch-up detection)
      if (task.timeWindow && task.nextRunAt !== null && task.nextRunAt < this.now()) {
        if (wasWindowMissed(task.timeWindow, task.nextRunAt, this.now())) {
          missedTasks.push({
            taskId: task.id,
            title: task.title,
            timeWindow: task.timeWindow,
            scheduledFor: task.nextRunAt,
          });
          continue; // Don't schedule yet — wait for catch-up resolution
        }
      }

      this.scheduleTask(task);
    }

    // Handle missed tasks according to catch-up policy
    if (missedTasks.length > 0) {
      this.handleCatchUp(missedTasks);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  list(): ScheduledTask[] {
    return this.store.list().sort((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      const aNextRun = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      const bNextRun = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      if (aNextRun !== bNextRun) {
        return aNextRun - bNextRun;
      }
      return b.createdAt - a.createdAt;
    });
  }

  get(id: string): ScheduledTask | null {
    return this.store.get(id);
  }

  create(input: ScheduledTaskCreateInput): ScheduledTask {
    const normalizedPrompt = input.prompt.trim();
    const normalizedTitle = input.title
      ? buildScheduledTaskTitle(input.title)
      : buildScheduledTaskFallbackTitle(normalizedPrompt);
    const normalizedScheduleConfig = normalizeScheduleConfig(input.scheduleConfig);
    const normalizedRepeatEvery = normalizedScheduleConfig
      ? null
      : normalizeRepeatEvery(input.repeatEvery);
    const normalizedRepeatUnit =
      normalizedScheduleConfig || normalizedRepeatEvery === null
        ? null
        : normalizeRepeatUnit(input.repeatUnit);
    const created = this.store.create({
      ...input,
      title: normalizedTitle,
      prompt: normalizedPrompt,
      scheduleConfig: normalizedScheduleConfig,
      nextRunAt: input.nextRunAt ?? input.runAt,
      enabled: input.enabled ?? true,
      repeatEvery: normalizedRepeatEvery,
      repeatUnit: normalizedRepeatUnit,
    });
    this.scheduleTask(created);
    return created;
  }

  update(id: string, updates: ScheduledTaskUpdateInput): ScheduledTask | null {
    const current = this.store.get(id);
    if (!current) return null;
    const nextPrompt = updates.prompt === undefined ? current.prompt : updates.prompt.trim();
    const nextTitle =
      updates.title === undefined
        ? current.title
        : buildScheduledTaskTitle(updates.title || nextPrompt);
    const nextScheduleConfig =
      updates.scheduleConfig === undefined
        ? undefined
        : normalizeScheduleConfig(updates.scheduleConfig);
    const usesScheduleConfig =
      nextScheduleConfig !== undefined
        ? nextScheduleConfig !== null
        : current.scheduleConfig !== null;
    const nextRepeatEvery = usesScheduleConfig
      ? null
      : updates.repeatEvery === undefined
        ? undefined
        : normalizeRepeatEvery(updates.repeatEvery);
    let nextRepeatUnit = usesScheduleConfig
      ? null
      : updates.repeatUnit === undefined
        ? undefined
        : normalizeRepeatUnit(updates.repeatUnit);
    if (!usesScheduleConfig && nextRepeatEvery !== undefined && nextRepeatEvery === null) {
      nextRepeatUnit = null;
    }
    const updated = this.store.update(id, {
      ...updates,
      prompt: nextPrompt,
      title: nextTitle,
      scheduleConfig: nextScheduleConfig,
      repeatEvery: nextRepeatEvery,
      repeatUnit: nextRepeatUnit,
    });
    if (!updated) return null;
    this.scheduleTask(updated);
    return updated;
  }

  delete(id: string): boolean {
    this.clearTimer(id);
    return this.store.delete(id);
  }

  toggle(id: string, enabled: boolean): ScheduledTask | null {
    const current = this.store.get(id);
    if (!current) return null;
    if (enabled && !isRepeatingTask(current)) {
      const oneTimeRunAt = current.nextRunAt ?? current.runAt;
      if (oneTimeRunAt <= this.now()) {
        throw new Error('Cannot enable: one-time task is overdue. Edit the schedule first.');
      }
    }
    const nextRunAt = enabled ? this.computeToggleNextRunAt(current) : null;
    const updated = this.store.update(id, { enabled, nextRunAt });
    if (!updated) return null;
    this.scheduleTask(updated);
    return updated;
  }

  async runNow(id: string): Promise<ScheduledTask | null> {
    const task = this.store.get(id);
    if (!task) return null;
    if (this.executingTasks.has(id)) {
      throw new Error('Task is already executing');
    }
    this.executingTasks.add(id);
    const taskToExecute = this.prepareExecution(task);
    try {
      const execution = await this.executeAndRecord(taskToExecute);
      if (!execution.success) {
        throw new Error(execution.error ?? 'Scheduled task execution failed');
      }
    } finally {
      this.executingTasks.delete(id);
    }
    return this.store.get(id);
  }

  private scheduleTask(task: ScheduledTask): void {
    this.clearTimer(task.id);
    if (!this.running) return;
    if (!task.enabled) return;
    if (task.nextRunAt === null) return;

    // v2: Time window scheduling — compute random firing time within window
    // Only fire within today's window if nextRunAt is today or in the past.
    // If nextRunAt is in the future (e.g., tomorrow), wait until that date.
    if (task.timeWindow) {
      const nextRunAt = task.nextRunAt!;
      const nowMs = this.now();

      // If nextRunAt is in the future, wait until that date then re-enter
      // scheduling logic (which applies randomization within the window).
      if (nextRunAt > nowMs) {
        const delay = Math.max(0, nextRunAt - nowMs);
        const effectiveDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
        const timer = setTimeout(() => {
          // Re-enter scheduleTask to apply window randomization, not handleTrigger
          const current = this.store.get(task.id);
          if (current && current.enabled) {
            this.scheduleTask(current);
          }
        }, effectiveDelay);
        this.timers.set(task.id, timer);
        return;
      }

      // nextRunAt is now or in the past — try to fire within today's window
      const firingTime = computeRandomFiringTime(task.timeWindow, nowMs);
      if (firingTime === null) {
        // Window passed today — advance to next window occurrence
        const nextStart = computeNextWindowStart(task.timeWindow, nowMs);
        this.store.update(task.id, { nextRunAt: nextStart });
        const updated = this.store.get(task.id);
        if (updated && updated.enabled) {
          const delay = Math.max(0, nextStart - nowMs);
          const effectiveDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
          const timer = setTimeout(() => {
            this.handleTrigger(task.id);
          }, effectiveDelay);
          this.timers.set(task.id, timer);
        }
        return;
      }

      const delay = Math.max(0, firingTime - nowMs);
      const effectiveDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
      const timer = setTimeout(() => {
        this.handleTrigger(task.id);
      }, effectiveDelay);
      this.timers.set(task.id, timer);
      return;
    }

    // Original exact-time scheduling
    const delay = Math.max(0, task.nextRunAt - this.now());
    const effectiveDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
    if (effectiveDelay < delay) {
      log('[Scheduler] Delay clamped to max for task:', task.id);
    }
    const timer = setTimeout(() => {
      this.handleTrigger(task.id);
    }, effectiveDelay);
    this.timers.set(task.id, timer);
  }

  private handleTrigger(taskId: string): void {
    this.timers.delete(taskId);
    const task = this.store.get(taskId);
    if (!task || !task.enabled) return;
    if (task.nextRunAt === null) return;
    if (task.nextRunAt > this.now()) {
      this.scheduleTask(task);
      return;
    }

    // v2: Time window gate — if task has a window, check if we should execute now
    if (task.timeWindow) {
      if (!isWithinWindow(task.timeWindow, this.now())) {
        // Not within the window — re-schedule to fire within the next window
        this.scheduleTask(task);
        return;
      }
      // We're within the window — proceed to execute
    }

    // v2: Config set validation
    if (!this.isConfigSetValid(task.configSetId)) {
      log('[Scheduler] Config set invalid for task:', taskId, task.configSetId);
      this.store.update(taskId, {
        enabled: false,
        lastError: `Config set '${task.configSetId}' no longer exists`,
      });
      this.onConfigInvalid?.(taskId, task.configSetId);
      this.recordRun(task, 'blocked', null, `Config set '${task.configSetId}' no longer exists`);
      return;
    }

    // v2: Conflict policy
    const settings = this.getSchedulerSettings();
    if (this.isAgentBusy()) {
      if (settings.conflictPolicy === 'skip-if-busy') {
        log('[Scheduler] Agent busy, skipping task:', taskId);
        this.recordRun(task, 'skipped', null, 'Agent busy (skip-if-busy policy)');
        // Advance to next run for repeating tasks
        if (isRepeatingTask(task)) {
          const nextRunAt = computeNextRunAt(task, this.now());
          if (nextRunAt !== null) {
            this.store.update(taskId, { nextRunAt });
            const updated = this.store.get(taskId);
            if (updated) this.scheduleTask(updated);
          }
        } else {
          // One-time task: disable since it can't be rescheduled
          this.store.update(taskId, { enabled: false, nextRunAt: null });
        }
        return;
      }
      // 'queue' policy: proceed — the executeTask callback handles queuing
    }

    if (this.executingTasks.has(taskId)) {
      return;
    }
    this.executingTasks.add(taskId);
    const taskToExecute = this.prepareExecution(task);
    this.executeAndRecord(taskToExecute)
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        try {
          this.store.update(taskToExecute.id, {
            lastRunAt: this.now(),
            lastRunSessionId: null,
            lastError: errorMessage,
          });
        } catch (updateError) {
          logError(
            '[ScheduledTaskManager] Failed to update store after unhandled error:',
            updateError
          );
        }
        this.onTaskError?.(taskToExecute.id, errorMessage);
        logError(`[ScheduledTask] Unhandled error executing task ${taskToExecute.id}:`, err);
      })
      .finally(() => {
        this.executingTasks.delete(taskId);
      });
  }

  private prepareExecution(task: ScheduledTask): ScheduledTask {
    this.clearTimer(task.id);

    if (!task.enabled) {
      return task;
    }

    if (isRepeatingTask(task)) {
      const nextRunAt = computeNextRunAt(task, this.now());
      if (nextRunAt !== null) {
        const updated = this.store.update(task.id, {
          nextRunAt,
          enabled: true,
        });
        if (updated) {
          this.scheduleTask(updated);
          return updated;
        }
      }
    }

    return (
      this.store.update(task.id, {
        enabled: false,
        nextRunAt: null,
      }) ?? task
    );
  }

  private computeToggleNextRunAt(task: ScheduledTask): number {
    const now = this.now();
    if (isRepeatingTask(task)) {
      const nextRunAt = computeNextRunAt(task, now);
      if (nextRunAt !== null) {
        return nextRunAt;
      }
    }
    const base = task.nextRunAt ?? task.runAt ?? now;
    return Math.max(base, now);
  }

  private async executeAndRecord(task: ScheduledTask): Promise<ScheduledTaskExecutionRecord> {
    const runId = this.generateRunId();
    const startedAt = this.now();

    // v2: Emit onTaskStarted before execution begins
    this.onTaskStarted?.(task.id, runId, '');

    // v2: Budget timeout with cooperative cancellation.
    // After timeout, we mark the run as timed out but the underlying promise
    // continues to settle — we swallow its result to prevent late state mutations.
    let budgetTimer: NodeJS.Timeout | null = null;
    const executionPromise = this.executeTask(task);

    if (task.maxDurationMs) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        budgetTimer = setTimeout(() => {
          reject(new BudgetExceededError('time'));
        }, task.maxDurationMs!);
      });

      try {
        const result = await Promise.race([executionPromise, timeoutPromise]);
        // Execution completed before timeout — clear the timer
        if (budgetTimer) clearTimeout(budgetTimer);
        return this.handleExecutionSuccess(task, result, runId, startedAt);
      } catch (error) {
        if (budgetTimer) clearTimeout(budgetTimer);

        if (error instanceof BudgetExceededError) {
          // Record timeout immediately
          this.store.update(task.id, {
            lastRunAt: this.now(),
            lastRunSessionId: null,
            lastError: `Budget exceeded: ${error.budgetType}`,
          });
          this.recordRun(
            task,
            'timeout',
            null,
            `Budget exceeded: ${error.budgetType}`,
            runId,
            startedAt
          );
          this.onBudgetExceeded?.(task.id, runId, error.budgetType);
          this.onTaskCompleted?.(task.id, runId, 'timeout', null);

          // Swallow late completion/error from the underlying promise to prevent
          // overlapping state mutations. The execution lock is released by the
          // caller's .finally() block.
          executionPromise.then(
            () => {},
            () => {}
          );

          return { success: false, error: `Budget exceeded: ${error.budgetType}` };
        }

        // Normal execution failure
        return this.handleExecutionFailure(task, error, runId, startedAt);
      }
    }

    // No budget — simple execution
    try {
      const result = await executionPromise;
      return this.handleExecutionSuccess(task, result, runId, startedAt);
    } catch (error) {
      return this.handleExecutionFailure(task, error, runId, startedAt);
    }
  }

  private handleExecutionSuccess(
    task: ScheduledTask,
    result: ScheduledTaskRunResult,
    runId: string,
    startedAt: number
  ): ScheduledTaskExecutionRecord {
    try {
      this.store.update(task.id, {
        lastRunAt: this.now(),
        lastRunSessionId: result.sessionId,
        lastError: null,
      });
    } catch (error) {
      logError('[ScheduledTaskManager] Failed to update store:', error);
    }

    this.recordRun(task, 'success', result.sessionId, null, runId, startedAt);
    this.onTaskCompleted?.(task.id, runId, 'success', null);
    return { success: true, sessionId: result.sessionId };
  }

  private handleExecutionFailure(
    task: ScheduledTask,
    error: unknown,
    runId: string,
    startedAt: number
  ): ScheduledTaskExecutionRecord {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.store.update(task.id, {
        lastRunAt: this.now(),
        lastRunSessionId: null,
        lastError: message,
      });
    } catch (updateError) {
      logError('[ScheduledTaskManager] Failed to update store:', updateError);
    }

    this.recordRun(task, 'failed', null, message, runId, startedAt);
    this.onTaskCompleted?.(task.id, runId, 'failed', null);
    this.onTaskError?.(task.id, message);
    return { success: false, error: message };
  }

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  // --- v2: Catch-up handling ---

  private handleCatchUp(missedTasks: MissedTask[]): void {
    const settings = this.getSchedulerSettings();

    switch (settings.catchUpPolicy) {
      case 'skip':
        // Advance all missed tasks to next window
        for (const missed of missedTasks) {
          this.advanceMissedTask(missed.taskId);
        }
        break;

      case 'run-once':
        // Execute each missed task once immediately (bypass window gate)
        for (const missed of missedTasks) {
          const task = this.store.get(missed.taskId);
          if (task && task.enabled) {
            this.executeCatchUpTask(task);
          }
        }
        break;

      case 'run-all':
        // NOTE: True run-all (replaying each missed occurrence) is not yet implemented.
        // Currently behaves identically to 'run-once' — executes each missed task once.
        // Full occurrence replay requires tracking how many windows were missed and
        // sequentially executing that many times, bounded by a safety cap.
        // TODO: Implement bounded occurrence replay in a future iteration.
        for (const missed of missedTasks) {
          const task = this.store.get(missed.taskId);
          if (task && task.enabled) {
            this.executeCatchUpTask(task);
          }
        }
        break;

      case 'ask':
        // Emit event to renderer for user decision
        if (this.onCatchUp) {
          this.onCatchUp(missedTasks);
        } else {
          // Fallback: skip if no handler registered
          for (const missed of missedTasks) {
            this.advanceMissedTask(missed.taskId);
          }
        }
        break;
    }
  }

  /** Advance a missed task to its next valid window/schedule slot. */
  private advanceMissedTask(taskId: string): void {
    const task = this.store.get(taskId);
    if (!task || !task.enabled) return;

    let nextRunAt: number | null = null;

    if (task.timeWindow) {
      nextRunAt = computeNextWindowStart(task.timeWindow, this.now());
    } else if (isRepeatingTask(task)) {
      nextRunAt = computeNextRunAt(task, this.now());
    }

    if (nextRunAt !== null) {
      this.store.update(taskId, { nextRunAt });
      const updated = this.store.get(taskId);
      if (updated) this.scheduleTask(updated);
    } else {
      // One-time task that's overdue — disable it
      this.store.update(taskId, { enabled: false, nextRunAt: null });
    }

    this.recordRun(task, 'skipped', null, 'Missed window (catch-up: skip)');
  }

  /**
   * Resolve catch-up decisions from the user (renderer response).
   * Called when catchUpPolicy = 'ask' and user responds to the batch panel.
   */
  resolveCatchUp(decisions: Array<{ taskId: string; action: 'run' | 'skip' }>): void {
    for (const { taskId, action } of decisions) {
      if (action === 'run') {
        const task = this.store.get(taskId);
        if (task && task.enabled) {
          // Direct execution bypassing time window gate (user explicitly chose to run)
          this.executeCatchUpTask(task);
        }
      } else {
        this.advanceMissedTask(taskId);
      }
    }
  }

  /** Execute a catch-up task immediately, bypassing window/conflict checks. */
  private executeCatchUpTask(task: ScheduledTask): void {
    if (this.executingTasks.has(task.id)) return;

    // Validate config set even for catch-up
    if (!this.isConfigSetValid(task.configSetId)) {
      this.store.update(task.id, {
        enabled: false,
        lastError: `Config set '${task.configSetId}' no longer exists`,
      });
      this.onConfigInvalid?.(task.id, task.configSetId);
      this.recordRun(task, 'blocked', null, `Config set '${task.configSetId}' no longer exists`);
      return;
    }

    this.executingTasks.add(task.id);
    const taskToExecute = this.prepareExecution(task);
    this.executeAndRecord(taskToExecute)
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.onTaskError?.(taskToExecute.id, errorMessage);
        logError(`[ScheduledTask] Catch-up execution error for ${taskToExecute.id}:`, err);
      })
      .finally(() => {
        this.executingTasks.delete(task.id);
      });
  }

  // --- v2: Run history recording ---

  private recordRun(
    task: ScheduledTask,
    status: ScheduledTaskRunStatus,
    sessionId: string | null,
    error: string | null,
    runId?: string,
    startedAt?: number
  ): void {
    if (!this.runStore) return;

    const id = runId ?? this.generateRunId();
    const started = startedAt ?? this.now();
    const settings = this.getSchedulerSettings();

    try {
      this.runStore.create({
        id,
        taskId: task.id,
        sessionId,
        status,
        startedAt: started,
        completedAt: this.now(),
        error,
        tokensUsed: null,
        blockedCommands: null,
      });

      // Prune old runs
      this.runStore.pruneByTaskId(task.id, settings.runHistoryDepth);
    } catch (err) {
      logError('[Scheduler] Failed to record run:', err);
    }
  }
}

function normalizeRepeatEvery(value: number | null | undefined): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  if (normalized <= 0) return null;
  return normalized;
}

function normalizeRepeatUnit(
  value: ScheduleRepeatUnit | null | undefined
): ScheduleRepeatUnit | null {
  if (value === 'minute' || value === 'hour' || value === 'day') {
    return value;
  }
  return null;
}

function normalizeScheduleConfig(
  value: ScheduledTaskScheduleConfig | null | undefined
): ScheduledTaskScheduleConfig | null {
  if (!value) {
    return null;
  }
  if (value.kind === 'daily') {
    const times = normalizeScheduleTimes(value.times);
    if (times.length === 0) {
      return null;
    }
    return { kind: 'daily', times };
  }
  if (value.kind === 'weekly') {
    const times = normalizeScheduleTimes(value.times);
    const weekdays = normalizeWeekdays(value.weekdays);
    if (times.length === 0 || weekdays.length === 0) {
      return null;
    }
    return { kind: 'weekly', weekdays, times };
  }
  return null;
}

function isRepeatingTask(task: ScheduledTask): boolean {
  return task.scheduleConfig !== null || Boolean(task.repeatEvery && task.repeatUnit);
}

function computeNextRunAt(task: ScheduledTask, now: number): number | null {
  if (task.scheduleConfig) {
    return computeNextRunAtFromScheduleConfig(task.scheduleConfig, now);
  }
  const intervalMs = getIntervalMs(task.repeatEvery, task.repeatUnit);
  if (intervalMs === null) return null;
  const nextBase = task.nextRunAt ?? task.runAt;
  if (!Number.isFinite(nextBase)) return null;
  if (nextBase > now) return nextBase;
  const skippedIntervals = Math.floor((now - nextBase) / intervalMs) + 1;
  return nextBase + skippedIntervals * intervalMs;
}

function getIntervalMs(
  repeatEvery: number | null,
  repeatUnit: ScheduleRepeatUnit | null
): number | null {
  if (!repeatEvery || !repeatUnit) return null;
  if (repeatUnit === 'minute') return repeatEvery * 60 * 1000;
  if (repeatUnit === 'hour') return repeatEvery * 60 * 60 * 1000;
  return repeatEvery * 24 * 60 * 60 * 1000;
}

function normalizeScheduleTimes(times: string[]): string[] {
  if (!Array.isArray(times)) {
    return [];
  }
  const validTimes = Array.from(
    new Set(times.filter((time) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(time)))
  );
  return validTimes.sort((left, right) => compareTimeStrings(left, right));
}

function normalizeWeekdays(days: number[]): ScheduledTaskWeekday[] {
  if (!Array.isArray(days)) {
    return [];
  }
  const normalized = Array.from(
    new Set(
      days.filter(
        (day): day is ScheduledTaskWeekday => Number.isInteger(day) && day >= 0 && day <= 6
      )
    )
  );
  return normalized.sort((left, right) => left - right);
}

function compareTimeStrings(left: string, right: string): number {
  return toTimeMinutes(left) - toTimeMinutes(right);
}

function toTimeMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function computeNextRunAtFromScheduleConfig(
  scheduleConfig: ScheduledTaskScheduleConfig,
  now: number
): number | null {
  if (scheduleConfig.kind === 'daily') {
    return findNextScheduledSlot(now, scheduleConfig.times);
  }
  return findNextScheduledSlot(now, scheduleConfig.times, scheduleConfig.weekdays);
}

function findNextScheduledSlot(
  now: number,
  times: string[],
  weekdays?: ScheduledTaskWeekday[]
): number | null {
  const normalizedTimes = normalizeScheduleTimes(times);
  if (normalizedTimes.length === 0) {
    return null;
  }
  const allowedWeekdays = weekdays ? new Set(normalizeWeekdays(weekdays)) : null;
  const nowDate = new Date(now);

  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const candidateDate = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() + dayOffset,
      0,
      0,
      0,
      0
    );
    if (allowedWeekdays && !allowedWeekdays.has(candidateDate.getDay() as ScheduledTaskWeekday)) {
      continue;
    }
    for (const time of normalizedTimes) {
      const [hour, minute] = time.split(':').map(Number);
      const candidate = new Date(
        candidateDate.getFullYear(),
        candidateDate.getMonth(),
        candidateDate.getDate(),
        hour,
        minute,
        0,
        0
      ).getTime();
      if (candidate > now) {
        return candidate;
      }
    }
  }

  return null;
}
