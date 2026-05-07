import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance, ScheduledTaskRow, ScheduledTaskRunRow } from '../db/database';
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskRun,
  ScheduledTaskRunStore,
  ScheduledTaskStore,
  ScheduledTaskUpdateInput,
} from './scheduled-task-manager';
import {
  isValidExecutionMode,
  isValidTimeWindow,
  isValidSandboxMode,
  isValidRunStatus,
} from '../../shared/schedule/types';

// --- Normalization helpers ---

/** Normalize a positive integer field. Returns null for invalid/non-positive values. */
function normalizePositiveInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  if (floored <= 0) return null;
  return floored;
}

/** Clamp maxDurationMs to a reasonable range: 1000ms – 24h (86_400_000ms). */
function normalizeMaxDurationMs(value: number | null | undefined): number | null {
  const normalized = normalizePositiveInt(value);
  if (normalized === null) return null;
  if (normalized < 1000) return 1000; // minimum 1 second
  if (normalized > 86_400_000) return 86_400_000; // maximum 24 hours
  return normalized;
}

/** Clamp maxTokens to a reasonable range: 1 – 10_000_000. */
function normalizeMaxTokens(value: number | null | undefined): number | null {
  const normalized = normalizePositiveInt(value);
  if (normalized === null) return null;
  if (normalized > 10_000_000) return 10_000_000;
  return normalized;
}

export function createScheduledTaskStore(db: DatabaseInstance): ScheduledTaskStore {
  return {
    list: () => db.scheduledTasks.getAll().map(mapRowToTask),
    get: (id: string) => {
      const row = db.scheduledTasks.get(id);
      return row ? mapRowToTask(row) : null;
    },
    create: (input: ScheduledTaskCreateInput) => {
      const now = Date.now();
      const row: ScheduledTaskRow = {
        id: uuidv4(),
        title: input.title ?? '',
        prompt: input.prompt,
        cwd: input.cwd,
        run_at: input.runAt,
        next_run_at: input.nextRunAt ?? input.runAt,
        schedule_config: input.scheduleConfig ? JSON.stringify(input.scheduleConfig) : null,
        repeat_every: input.repeatEvery ?? null,
        repeat_unit: input.repeatUnit ?? null,
        enabled: input.enabled === false ? 0 : 1,
        last_run_at: null,
        last_run_session_id: null,
        last_error: null,
        created_at: now,
        updated_at: now,
        // v2 fields
        config_set_id: input.configSetId ?? 'default',
        execution_mode: input.executionMode ?? 'ask',
        time_window: input.timeWindow ?? null,
        max_duration_ms: normalizeMaxDurationMs(input.maxDurationMs),
        max_tokens: normalizeMaxTokens(input.maxTokens),
        sandbox_mode: input.sandboxMode ?? 'inherit',
      };
      db.scheduledTasks.create(row);
      return mapRowToTask(row);
    },
    update: (id: string, updates: ScheduledTaskUpdateInput) => {
      const mapped = mapTaskUpdatesToRow(updates);
      db.scheduledTasks.update(id, mapped);
      const row = db.scheduledTasks.get(id);
      return row ? mapRowToTask(row) : null;
    },
    delete: (id: string) => {
      const existing = db.scheduledTasks.get(id);
      if (!existing) return false;
      db.scheduledTasks.delete(id);
      return true;
    },
  };
}

function mapRowToTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    cwd: row.cwd,
    runAt: row.run_at,
    nextRunAt: row.next_run_at,
    scheduleConfig: parseScheduleConfig(row.schedule_config),
    repeatEvery: row.repeat_every,
    repeatUnit: row.repeat_unit as ScheduledTask['repeatUnit'],
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastRunSessionId: row.last_run_session_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // v2 fields — validated against known values, fallback to safe defaults
    configSetId: row.config_set_id || 'default',
    executionMode: isValidExecutionMode(row.execution_mode) ? row.execution_mode : 'ask',
    timeWindow: isValidTimeWindow(row.time_window) ? row.time_window : null,
    maxDurationMs: normalizeMaxDurationMs(row.max_duration_ms),
    maxTokens: normalizeMaxTokens(row.max_tokens),
    sandboxMode: isValidSandboxMode(row.sandbox_mode) ? row.sandbox_mode : 'inherit',
  };
}

function mapTaskUpdatesToRow(updates: ScheduledTaskUpdateInput): Partial<ScheduledTaskRow> {
  const mapped: Partial<ScheduledTaskRow> = {};
  if (updates.title !== undefined) mapped.title = updates.title;
  if (updates.prompt !== undefined) mapped.prompt = updates.prompt;
  if (updates.cwd !== undefined) mapped.cwd = updates.cwd;
  if (updates.runAt !== undefined) mapped.run_at = updates.runAt;
  if (updates.nextRunAt !== undefined) mapped.next_run_at = updates.nextRunAt;
  if (updates.scheduleConfig !== undefined) {
    mapped.schedule_config = updates.scheduleConfig ? JSON.stringify(updates.scheduleConfig) : null;
  }
  if (updates.repeatEvery !== undefined) mapped.repeat_every = updates.repeatEvery;
  if (updates.repeatUnit !== undefined) mapped.repeat_unit = updates.repeatUnit;
  if (updates.enabled !== undefined) mapped.enabled = updates.enabled ? 1 : 0;
  if (updates.lastRunAt !== undefined) mapped.last_run_at = updates.lastRunAt;
  if (updates.lastRunSessionId !== undefined) mapped.last_run_session_id = updates.lastRunSessionId;
  if (updates.lastError !== undefined) mapped.last_error = updates.lastError;
  // v2 fields
  if (updates.configSetId !== undefined) mapped.config_set_id = updates.configSetId;
  if (updates.executionMode !== undefined) mapped.execution_mode = updates.executionMode;
  if (updates.timeWindow !== undefined) mapped.time_window = updates.timeWindow;
  if (updates.maxDurationMs !== undefined)
    mapped.max_duration_ms = normalizeMaxDurationMs(updates.maxDurationMs);
  if (updates.maxTokens !== undefined) mapped.max_tokens = normalizeMaxTokens(updates.maxTokens);
  if (updates.sandboxMode !== undefined) mapped.sandbox_mode = updates.sandboxMode;
  return mapped;
}

function parseScheduleConfig(value: string | null): ScheduledTask['scheduleConfig'] {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as ScheduledTask['scheduleConfig'];
  } catch {
    return null;
  }
}

// --- Run history store ---

function mapRunRowToRun(row: ScheduledTaskRunRow): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: isValidRunStatus(row.status) ? row.status : 'failed',
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    tokensUsed: row.tokens_used,
    blockedCommands: parseBlockedCommands(row.blocked_commands),
  };
}

function parseBlockedCommands(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    // Validate every element is a string
    if (!parsed.every((v: unknown) => typeof v === 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

export function createScheduledTaskRunStore(db: DatabaseInstance): ScheduledTaskRunStore {
  return {
    create: (run: ScheduledTaskRun) => {
      const row: ScheduledTaskRunRow = {
        id: run.id,
        task_id: run.taskId,
        session_id: run.sessionId,
        status: run.status,
        started_at: run.startedAt,
        completed_at: run.completedAt,
        error: run.error,
        tokens_used: run.tokensUsed,
        blocked_commands: run.blockedCommands ? JSON.stringify(run.blockedCommands) : null,
        created_at: Date.now(),
      };
      db.scheduledTaskRuns.create(row);
    },

    getByTaskId: (taskId: string, limit = 10): ScheduledTaskRun[] => {
      return db.scheduledTaskRuns.getByTaskId(taskId, limit).map(mapRunRowToRun);
    },

    getLatestByTaskId: (taskId: string): ScheduledTaskRun | null => {
      const row = db.scheduledTaskRuns.getLatestByTaskId(taskId);
      return row ? mapRunRowToRun(row) : null;
    },

    deleteByTaskId: (taskId: string) => {
      db.scheduledTaskRuns.deleteByTaskId(taskId);
    },

    pruneByTaskId: (taskId: string, keepCount: number) => {
      db.scheduledTaskRuns.pruneByTaskId(taskId, keepCount);
    },
  };
}
