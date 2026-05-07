import { describe, expect, it } from 'vitest';
import {
  computeRandomFiringTime,
  computeNextWindowStart,
  getWindowBoundsForDate,
  isWithinWindow,
  wasWindowMissed,
  TIME_WINDOW_RANGES,
} from '../src/main/schedule/time-window';

describe('time-window — getWindowBoundsForDate', () => {
  it('returns correct bounds for morning window', () => {
    const date = new Date(2026, 4, 7); // May 7, 2026
    const { startMs, endMs } = getWindowBoundsForDate('morning', date);

    const start = new Date(startMs);
    const end = new Date(endMs);
    expect(start.getHours()).toBe(9);
    expect(start.getMinutes()).toBe(0);
    expect(end.getHours()).toBe(11);
    expect(end.getMinutes()).toBe(0);
  });

  it('returns correct bounds for night window', () => {
    const date = new Date(2026, 4, 7);
    const { startMs, endMs } = getWindowBoundsForDate('night', date);

    const start = new Date(startMs);
    const end = new Date(endMs);
    expect(start.getHours()).toBe(21);
    expect(end.getHours()).toBe(23);
  });
});

describe('time-window — isWithinWindow', () => {
  it('returns true when time is within the window', () => {
    // 10:30 AM is within morning (09:00–11:00)
    const date = new Date(2026, 4, 7, 10, 30, 0, 0);
    expect(isWithinWindow('morning', date.getTime())).toBe(true);
  });

  it('returns false when time is before the window', () => {
    const date = new Date(2026, 4, 7, 8, 30, 0, 0);
    expect(isWithinWindow('morning', date.getTime())).toBe(false);
  });

  it('returns false when time is after the window', () => {
    const date = new Date(2026, 4, 7, 11, 30, 0, 0);
    expect(isWithinWindow('morning', date.getTime())).toBe(false);
  });

  it('returns true at exact window start', () => {
    const date = new Date(2026, 4, 7, 9, 0, 0, 0);
    expect(isWithinWindow('morning', date.getTime())).toBe(true);
  });

  it('returns false at exact window end', () => {
    const date = new Date(2026, 4, 7, 11, 0, 0, 0);
    expect(isWithinWindow('morning', date.getTime())).toBe(false);
  });
});

describe('time-window — computeRandomFiringTime', () => {
  it('returns a time within the remaining window when currently inside', () => {
    // 10:00 AM — 1 hour remaining in morning window (09:00–11:00)
    const now = new Date(2026, 4, 7, 10, 0, 0, 0).getTime();
    const endOfWindow = new Date(2026, 4, 7, 11, 0, 0, 0).getTime();

    const firingTime = computeRandomFiringTime('morning', now, () => 0.5);

    expect(firingTime).not.toBeNull();
    expect(firingTime!).toBeGreaterThanOrEqual(now);
    expect(firingTime!).toBeLessThan(endOfWindow);
  });

  it('uses full window when before window start', () => {
    // 08:00 AM — before morning window
    const now = new Date(2026, 4, 7, 8, 0, 0, 0).getTime();
    const windowStart = new Date(2026, 4, 7, 9, 0, 0, 0).getTime();
    const windowEnd = new Date(2026, 4, 7, 11, 0, 0, 0).getTime();

    const firingTime = computeRandomFiringTime('morning', now, () => 0);

    expect(firingTime).not.toBeNull();
    expect(firingTime!).toBe(windowStart); // random=0 → start of window
  });

  it('returns null when window has passed', () => {
    // 12:00 PM — after morning window
    const now = new Date(2026, 4, 7, 12, 0, 0, 0).getTime();

    const firingTime = computeRandomFiringTime('morning', now);
    expect(firingTime).toBeNull();
  });

  it('respects the random function for deterministic testing', () => {
    const now = new Date(2026, 4, 7, 9, 0, 0, 0).getTime();
    const windowEnd = new Date(2026, 4, 7, 11, 0, 0, 0).getTime();
    const windowDuration = windowEnd - now; // 2 hours

    // random=0 → fires at window start
    expect(computeRandomFiringTime('morning', now, () => 0)).toBe(now);

    // random=0.5 → fires at midpoint
    const midpoint = now + Math.floor(windowDuration * 0.5);
    expect(computeRandomFiringTime('morning', now, () => 0.5)).toBe(midpoint);
  });

  it('handles mid-window entry (app opens at 10:30)', () => {
    const now = new Date(2026, 4, 7, 10, 30, 0, 0).getTime();
    const windowEnd = new Date(2026, 4, 7, 11, 0, 0, 0).getTime();
    const remaining = windowEnd - now; // 30 minutes

    // random=0 → fires immediately
    expect(computeRandomFiringTime('morning', now, () => 0)).toBe(now);

    // random=1 (just under) → fires near end
    const nearEnd = now + Math.floor(remaining * 0.99);
    expect(computeRandomFiringTime('morning', now, () => 0.99)).toBe(nearEnd);
  });
});

describe('time-window — wasWindowMissed', () => {
  it('returns true when scheduled time is past and window has ended', () => {
    // Task was scheduled for 09:30 (morning window), now it's 14:00
    const scheduledFor = new Date(2026, 4, 7, 9, 30, 0, 0).getTime();
    const now = new Date(2026, 4, 7, 14, 0, 0, 0).getTime();

    expect(wasWindowMissed('morning', scheduledFor, now)).toBe(true);
  });

  it('returns false when still within the window', () => {
    // Task was scheduled for 09:30, now it's 10:00 (still in morning window)
    const scheduledFor = new Date(2026, 4, 7, 9, 30, 0, 0).getTime();
    const now = new Date(2026, 4, 7, 10, 0, 0, 0).getTime();

    expect(wasWindowMissed('morning', scheduledFor, now)).toBe(false);
  });

  it('returns false when task is not yet overdue', () => {
    const scheduledFor = new Date(2026, 4, 7, 10, 0, 0, 0).getTime();
    const now = new Date(2026, 4, 7, 9, 0, 0, 0).getTime();

    expect(wasWindowMissed('morning', scheduledFor, now)).toBe(false);
  });

  it('returns true for a task missed on a previous day', () => {
    // Scheduled for yesterday morning, now is today afternoon
    const scheduledFor = new Date(2026, 4, 6, 9, 30, 0, 0).getTime();
    const now = new Date(2026, 4, 7, 14, 0, 0, 0).getTime();

    expect(wasWindowMissed('morning', scheduledFor, now)).toBe(true);
  });

  it('returns true at exact window end (end-exclusive boundary)', () => {
    // Scheduled for 09:30, now is exactly 11:00 (window end)
    // Window is [09:00, 11:00) — at 11:00 the window has ended
    const scheduledFor = new Date(2026, 4, 7, 9, 30, 0, 0).getTime();
    const now = new Date(2026, 4, 7, 11, 0, 0, 0).getTime();

    expect(wasWindowMissed('morning', scheduledFor, now)).toBe(true);
  });
});

describe('time-window — computeNextWindowStart', () => {
  it('returns today start when before the window', () => {
    const now = new Date(2026, 4, 7, 8, 0, 0, 0).getTime();
    const expected = new Date(2026, 4, 7, 9, 0, 0, 0).getTime();

    expect(computeNextWindowStart('morning', now)).toBe(expected);
  });

  it('returns now when within the window', () => {
    const now = new Date(2026, 4, 7, 10, 0, 0, 0).getTime();

    expect(computeNextWindowStart('morning', now)).toBe(now);
  });

  it('returns tomorrow start when window has passed', () => {
    const now = new Date(2026, 4, 7, 12, 0, 0, 0).getTime();
    const expected = new Date(2026, 4, 8, 9, 0, 0, 0).getTime();

    expect(computeNextWindowStart('morning', now)).toBe(expected);
  });
});
