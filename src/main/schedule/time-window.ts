/**
 * @module main/schedule/time-window
 *
 * Time window resolution for anacron-style scheduling.
 *
 * Named time windows map to fixed local-time ranges. When a task fires,
 * a random offset within the remaining window is chosen. If the app opens
 * mid-window, the offset is computed from the remaining time only.
 */
import type { TimeWindow } from '../../shared/schedule/types';

export interface TimeWindowRange {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/** Fixed named windows with hardcoded ranges (local time). */
export const TIME_WINDOW_RANGES: Record<TimeWindow, TimeWindowRange> = {
  morning: { startHour: 9, startMinute: 0, endHour: 11, endMinute: 0 },
  afternoon: { startHour: 13, startMinute: 0, endHour: 15, endMinute: 0 },
  evening: { startHour: 17, startMinute: 0, endHour: 19, endMinute: 0 },
  night: { startHour: 21, startMinute: 0, endHour: 23, endMinute: 0 },
};

/**
 * Get the start and end timestamps for a time window on a given date.
 */
export function getWindowBoundsForDate(
  window: TimeWindow,
  date: Date
): { startMs: number; endMs: number } {
  const range = TIME_WINDOW_RANGES[window];
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  const startMs = new Date(year, month, day, range.startHour, range.startMinute, 0, 0).getTime();
  const endMs = new Date(year, month, day, range.endHour, range.endMinute, 0, 0).getTime();

  return { startMs, endMs };
}

/**
 * Check if a given timestamp falls within a time window on that day.
 */
export function isWithinWindow(window: TimeWindow, nowMs: number): boolean {
  const date = new Date(nowMs);
  const { startMs, endMs } = getWindowBoundsForDate(window, date);
  return nowMs >= startMs && nowMs < endMs;
}

/**
 * Compute a random firing timestamp within the remaining window time.
 *
 * If `nowMs` is before the window start, the full window is available.
 * If `nowMs` is within the window, only the remaining time is used.
 * If `nowMs` is after the window end, returns null (window missed).
 *
 * @param randomFn - Injectable random function for testing (default: Math.random)
 */
export function computeRandomFiringTime(
  window: TimeWindow,
  nowMs: number,
  randomFn: () => number = Math.random
): number | null {
  const date = new Date(nowMs);
  const { startMs, endMs } = getWindowBoundsForDate(window, date);

  if (nowMs >= endMs) {
    return null; // Window already passed today
  }

  const effectiveStart = Math.max(nowMs, startMs);
  const remainingMs = endMs - effectiveStart;

  if (remainingMs <= 0) {
    return null;
  }

  // Pick a random point within the remaining window
  const offset = Math.floor(randomFn() * remainingMs);
  return effectiveStart + offset;
}

/**
 * Determine if a task's time window was missed.
 * A window is "missed" if the task's nextRunAt is in the past AND
 * the current time is past the window's end for that day.
 */
export function wasWindowMissed(
  window: TimeWindow,
  scheduledForMs: number,
  nowMs: number
): boolean {
  if (scheduledForMs >= nowMs) return false; // Not overdue

  const scheduledDate = new Date(scheduledForMs);
  const { endMs } = getWindowBoundsForDate(window, scheduledDate);

  return nowMs >= endMs;
}

/**
 * Compute the next eligible time for a window-based task.
 *
 * Behavior:
 * - If before the window today: returns the window start time.
 * - If currently within the window: returns `nowMs` (eligible immediately).
 * - If after the window today: returns tomorrow's window start time.
 *
 * This is used to advance missed tasks to their next valid scheduling point.
 */
export function computeNextWindowStart(window: TimeWindow, nowMs: number): number {
  const today = new Date(nowMs);
  const { startMs: todayStart, endMs: todayEnd } = getWindowBoundsForDate(window, today);

  // If we haven't reached the window yet today, use today's start
  if (nowMs < todayStart) {
    return todayStart;
  }

  // If we're within the window, it's still "current" — use now
  if (nowMs < todayEnd) {
    return nowMs;
  }

  // Window passed today — use tomorrow's start
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const { startMs: tomorrowStart } = getWindowBoundsForDate(window, tomorrow);
  return tomorrowStart;
}
