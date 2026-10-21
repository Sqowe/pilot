import { describe, it, expect } from 'vitest';
import { readPiDurationMs } from '../src/main/claude/pi-durations';
import { formatDuration } from '../src/renderer/utils/format-duration';

describe('readPiDurationMs', () => {
  it('keeps a duration pi measured, rounded to whole milliseconds', () => {
    expect(readPiDurationMs(2345)).toBe(2345);
    expect(readPiDurationMs(12.6)).toBe(13);
    expect(readPiDurationMs(0)).toBe(0);
  });

  it('reports nothing when pi gave no usable duration', () => {
    // Absent on responses pi did not stream itself and on tools that never ran.
    expect(readPiDurationMs(undefined)).toBeUndefined();
    expect(readPiDurationMs(null)).toBeUndefined();
    expect(readPiDurationMs('2345')).toBeUndefined();
    expect(readPiDurationMs(-1)).toBeUndefined();
    expect(readPiDurationMs(Number.NaN)).toBeUndefined();
    expect(readPiDurationMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('shows milliseconds below a second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(999.4)).toBe('999ms');
  });

  it('shows seconds with one decimal below a minute', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(2345)).toBe('2.3s');
    expect(formatDuration(59_900)).toBe('59.9s');
  });

  it('shows minutes and whole seconds from a minute on', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(65_400)).toBe('1m 5s');
    // Never "1m 60s": seconds are cut, not rounded up into the next minute.
    expect(formatDuration(119_800)).toBe('1m 59s');
  });

  it('shows nothing odd for a value that is not a duration', () => {
    expect(formatDuration(-5)).toBe('0ms');
    expect(formatDuration(Number.NaN)).toBe('0ms');
  });
});
