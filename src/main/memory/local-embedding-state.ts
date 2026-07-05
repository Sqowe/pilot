/**
 * @module main/memory/local-embedding-state
 *
 * Dependency-free runtime state + exponential-backoff bookkeeping for the local
 * embedding pipeline. Intentionally does NOT import @huggingface/transformers, so
 * IPC handlers can read the current status (getLocalModelRuntimeStatus) without
 * pulling the heavy ML dependency into the main-process startup path.
 *
 * The provider (local-embedding-provider.ts) writes state transitions here;
 * the IPC layer reads them. Single module instance in the main process → both
 * sides observe the same state.
 *
 * Backoff rationale: a failing download (offline/firewall/HF Hub down) must not
 * be re-attempted on every chunk during ingestion — that would be a retry storm
 * of full model downloads, each eating a network timeout. Instead, after a
 * failure we refuse new attempts for a growing window (60s → 2m → 4m … capped),
 * so embedding degrades to lexical-only instantly and cheaply until the window
 * elapses. A manual "Retry download" resets the backoff via resetBackoff().
 */
import type { LocalModelRuntimeStatus } from '../../shared/local-embedding-types';

/** First backoff window after a failure. */
const BACKOFF_BASE_MS = 60_000;
/** Backoff never grows past this (30 min). */
const BACKOFF_CAP_MS = 30 * 60_000;

let failureCount = 0;
let lastFailureAt = 0;
let lastError: string | null = null;
let pipelineReady = false;
let loading = false;

/** Backoff window for the Nth consecutive failure (60s, 2m, 4m … capped). */
export function backoffMs(count: number): number {
  if (count <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_CAP_MS);
}

/** Epoch ms at which the next automatic retry is permitted (0 when not in backoff). */
export function retryAllowedAt(): number {
  return failureCount > 0 ? lastFailureAt + backoffMs(failureCount) : 0;
}

/** True while we should refuse a fresh download attempt (still cooling down). */
export function isInBackoff(now: number = Date.now()): boolean {
  return failureCount > 0 && now < retryAllowedAt();
}

export function markLoading(): void {
  loading = true;
}

export function markReady(): void {
  pipelineReady = true;
  loading = false;
  failureCount = 0;
  lastFailureAt = 0;
  lastError = null;
}

export function markFailure(message: string): void {
  failureCount += 1;
  lastFailureAt = Date.now();
  lastError = message;
  pipelineReady = false;
  loading = false;
}

/** Clear only the backoff counters — used by a manual retry so the next attempt fires immediately. */
export function resetBackoff(): void {
  failureCount = 0;
  lastFailureAt = 0;
  lastError = null;
}

/** Full reset (also drops the 'ready' flag) — used when the model cache is deleted. */
export function resetRuntimeState(): void {
  failureCount = 0;
  lastFailureAt = 0;
  lastError = null;
  pipelineReady = false;
  loading = false;
}

export function getLocalModelRuntimeStatus(): LocalModelRuntimeStatus {
  if (pipelineReady) return { state: 'ready' };
  if (failureCount > 0) {
    return {
      state: 'error',
      error: lastError ?? undefined,
      failedAt: lastFailureAt,
      retryAfter: retryAllowedAt(),
    };
  }
  if (loading) return { state: 'loading' };
  return { state: 'idle' };
}

/**
 * Thrown by the provider when a download attempt is refused because we're still
 * inside a backoff window. Callers (embedLocal) use this to avoid re-emitting a
 * duplicate 'error' progress event for every blocked chunk.
 */
export class LocalModelBackoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalModelBackoffError';
  }
}
