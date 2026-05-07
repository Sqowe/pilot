/**
 * @module shared/schedule/types
 *
 * Shared scheduler v2 type definitions used by both main process and renderer.
 * Single source of truth for scheduler enums and policy types.
 */

// --- Time windows ---
export const TIME_WINDOWS = ['morning', 'afternoon', 'evening', 'night'] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

// --- Execution mode ---
export const EXECUTION_MODES = ['ask', 'auto'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

// --- Catch-up policy ---
export const CATCH_UP_POLICIES = ['skip', 'run-once', 'run-all', 'ask'] as const;
export type CatchUpPolicy = (typeof CATCH_UP_POLICIES)[number];

// --- Conflict policy ---
export const CONFLICT_POLICIES = ['queue', 'skip-if-busy'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

// --- Sandbox mode ---
export const SANDBOX_MODES = ['inherit', 'require', 'skip'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

// --- Run status ---
export const RUN_STATUSES = ['success', 'failed', 'timeout', 'blocked', 'skipped'] as const;
export type ScheduledTaskRunStatus = (typeof RUN_STATUSES)[number];

// --- Runtime validators (derived from constants) ---

export function isValidTimeWindow(value: unknown): value is TimeWindow {
  return TIME_WINDOWS.includes(value as TimeWindow);
}

export function isValidExecutionMode(value: unknown): value is ExecutionMode {
  return EXECUTION_MODES.includes(value as ExecutionMode);
}

export function isValidCatchUpPolicy(value: unknown): value is CatchUpPolicy {
  return CATCH_UP_POLICIES.includes(value as CatchUpPolicy);
}

export function isValidConflictPolicy(value: unknown): value is ConflictPolicy {
  return CONFLICT_POLICIES.includes(value as ConflictPolicy);
}

export function isValidSandboxMode(value: unknown): value is SandboxMode {
  return SANDBOX_MODES.includes(value as SandboxMode);
}

export function isValidRunStatus(value: unknown): value is ScheduledTaskRunStatus {
  return RUN_STATUSES.includes(value as ScheduledTaskRunStatus);
}
