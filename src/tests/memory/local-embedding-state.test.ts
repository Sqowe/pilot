/**
 * Unit tests for the dependency-free local-embedding runtime state + backoff module.
 * Pure logic — no transformers.js, no filesystem, no DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalModelBackoffError,
  backoffMs,
  getLocalModelRuntimeStatus,
  isInBackoff,
  markFailure,
  markLoading,
  markReady,
  resetBackoff,
  resetRuntimeState,
  retryAllowedAt,
} from '../../main/memory/local-embedding-state';

describe('local-embedding-state', () => {
  beforeEach(() => {
    resetRuntimeState();
  });
  afterEach(() => {
    resetRuntimeState();
    vi.useRealTimers();
  });

  describe('backoffMs', () => {
    it('is 0 for no failures and grows exponentially, capped at 30m', () => {
      expect(backoffMs(0)).toBe(0);
      expect(backoffMs(1)).toBe(60_000); // 1m
      expect(backoffMs(2)).toBe(120_000); // 2m
      expect(backoffMs(3)).toBe(240_000); // 4m
      // Cap at 30 minutes regardless of how many failures pile up.
      expect(backoffMs(50)).toBe(30 * 60_000);
    });
  });

  describe('status transitions', () => {
    it('starts idle', () => {
      expect(getLocalModelRuntimeStatus()).toEqual({ state: 'idle' });
    });

    it('reports loading, then ready', () => {
      markLoading();
      expect(getLocalModelRuntimeStatus().state).toBe('loading');
      markReady();
      expect(getLocalModelRuntimeStatus()).toEqual({ state: 'ready' });
    });

    it('reports error with backoff metadata after a failure', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      markFailure('network down');
      const status = getLocalModelRuntimeStatus();
      expect(status.state).toBe('error');
      expect(status.error).toBe('network down');
      expect(status.failedAt).toBe(1_000_000);
      expect(status.retryAfter).toBe(1_000_000 + 60_000);
    });

    it('markReady clears a prior failure', () => {
      markFailure('boom');
      expect(getLocalModelRuntimeStatus().state).toBe('error');
      markReady();
      expect(getLocalModelRuntimeStatus()).toEqual({ state: 'ready' });
    });
  });

  describe('isInBackoff', () => {
    it('is false with no failures', () => {
      expect(isInBackoff()).toBe(false);
    });

    it('is true within the window and false after it elapses', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      markFailure('boom'); // failureCount=1 → 60s window
      expect(isInBackoff()).toBe(true);
      expect(retryAllowedAt()).toBe(60_000);
      // 59s later — still cooling down.
      expect(isInBackoff(59_000)).toBe(true);
      // 61s later — window elapsed.
      expect(isInBackoff(61_000)).toBe(false);
    });

    it('window grows with consecutive failures', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      markFailure('one'); // 60s
      markFailure('two'); // 120s
      expect(retryAllowedAt()).toBe(120_000);
    });
  });

  describe('resetBackoff', () => {
    it('clears the backoff window (manual retry) but is distinct from a full reset', () => {
      markFailure('boom');
      expect(isInBackoff()).toBe(true);
      resetBackoff();
      expect(isInBackoff()).toBe(false);
      expect(getLocalModelRuntimeStatus()).toEqual({ state: 'idle' });
    });
  });

  it('LocalModelBackoffError is a named Error', () => {
    const err = new LocalModelBackoffError('cooling down');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LocalModelBackoffError');
    expect(err.message).toBe('cooling down');
  });
});
