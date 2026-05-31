import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isSameDay,
  formatChatDaySeparator,
  formatChatTime,
  formatChatTooltip,
  formatSessionDateRange,
} from '../src/renderer/utils/i18n-format';

// Mock i18n module
vi.mock('../src/renderer/i18n/config', () => ({
  default: {
    resolvedLanguage: 'en',
    language: 'en',
    t: (key: string) => {
      const translations: Record<string, string> = {
        'sidebar.today': 'Today',
        'sidebar.yesterday': 'Yesterday',
      };
      return translations[key] ?? key;
    },
  },
}));

describe('isSameDay', () => {
  it('returns true for timestamps on the same calendar day', () => {
    const morning = new Date(2026, 4, 12, 8, 0, 0).getTime(); // May 12, 8:00
    const evening = new Date(2026, 4, 12, 23, 59, 59).getTime(); // May 12, 23:59
    expect(isSameDay(morning, evening)).toBe(true);
  });

  it('returns false for timestamps on different calendar days', () => {
    const day1 = new Date(2026, 4, 12, 23, 59, 59).getTime(); // May 12, 23:59
    const day2 = new Date(2026, 4, 13, 0, 0, 0).getTime(); // May 13, 00:00
    expect(isSameDay(day1, day2)).toBe(false);
  });

  it('returns false for same day in different months', () => {
    const may12 = new Date(2026, 4, 12).getTime();
    const june12 = new Date(2026, 5, 12).getTime();
    expect(isSameDay(may12, june12)).toBe(false);
  });

  it('returns false for same day/month in different years', () => {
    const y2025 = new Date(2025, 4, 12).getTime();
    const y2026 = new Date(2026, 4, 12).getTime();
    expect(isSameDay(y2025, y2026)).toBe(false);
  });

  it('handles identical timestamps', () => {
    const ts = Date.now();
    expect(isSameDay(ts, ts)).toBe(true);
  });
});

describe('formatChatDaySeparator', () => {
  beforeEach(() => {
    // Fix "now" to May 31, 2026 14:00 local time for deterministic tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 31, 14, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Today" for timestamps from today', () => {
    const todayMorning = new Date(2026, 4, 31, 9, 30, 0).getTime();
    expect(formatChatDaySeparator(todayMorning)).toBe('Today');
  });

  it('returns "Yesterday" for timestamps from yesterday', () => {
    const yesterday = new Date(2026, 4, 30, 15, 0, 0).getTime();
    expect(formatChatDaySeparator(yesterday)).toBe('Yesterday');
  });

  it('returns weekday + date for timestamps within the last 7 days', () => {
    // May 26 is a Tuesday (4 days before May 31)
    const fourDaysAgo = new Date(2026, 4, 26, 10, 0, 0).getTime();
    const result = formatChatDaySeparator(fourDaysAgo);
    // Should contain the weekday name and the date
    expect(result).toContain('Tuesday');
    expect(result).toContain('26');
  });

  it('returns month + day for timestamps in the same year but older than a week', () => {
    const twoMonthsAgo = new Date(2026, 2, 15, 10, 0, 0).getTime(); // March 15
    const result = formatChatDaySeparator(twoMonthsAgo);
    expect(result).toContain('Mar');
    expect(result).toContain('15');
    // Should NOT contain the year
    expect(result).not.toContain('2026');
  });

  it('returns full date with year for timestamps from a different year', () => {
    const lastYear = new Date(2025, 11, 25, 10, 0, 0).getTime(); // Dec 25, 2025
    const result = formatChatDaySeparator(lastYear);
    expect(result).toContain('Dec');
    expect(result).toContain('25');
    expect(result).toContain('2025');
  });

  it('handles midnight boundary correctly (start of today)', () => {
    const midnightToday = new Date(2026, 4, 31, 0, 0, 0).getTime();
    expect(formatChatDaySeparator(midnightToday)).toBe('Today');
  });

  it('handles end of yesterday correctly (23:59:59)', () => {
    const endOfYesterday = new Date(2026, 4, 30, 23, 59, 59).getTime();
    expect(formatChatDaySeparator(endOfYesterday)).toBe('Yesterday');
  });

  it('does NOT label future timestamps as "Today"', () => {
    // Tomorrow
    const tomorrow = new Date(2026, 5, 1, 10, 0, 0).getTime(); // June 1
    const result = formatChatDaySeparator(tomorrow);
    expect(result).not.toBe('Today');
    expect(result).not.toBe('Yesterday');
  });

  it('does NOT label next week timestamps as "Today" or "Yesterday"', () => {
    const nextWeek = new Date(2026, 5, 7, 10, 0, 0).getTime(); // June 7
    const result = formatChatDaySeparator(nextWeek);
    expect(result).not.toBe('Today');
    expect(result).not.toBe('Yesterday');
  });

  it('handles exact boundary: tomorrow 00:00:00 is not "Today"', () => {
    const tomorrowMidnight = new Date(2026, 5, 1, 0, 0, 0).getTime(); // June 1, 00:00
    const result = formatChatDaySeparator(tomorrowMidnight);
    expect(result).not.toBe('Today');
  });

  it('handles exact boundary: yesterday 00:00:00 is "Yesterday"', () => {
    const yesterdayMidnight = new Date(2026, 4, 30, 0, 0, 0).getTime();
    expect(formatChatDaySeparator(yesterdayMidnight)).toBe('Yesterday');
  });

  it('handles exact boundary: day before yesterday 23:59:59 is NOT "Yesterday"', () => {
    const dayBeforeYesterdayEnd = new Date(2026, 4, 29, 23, 59, 59).getTime();
    const result = formatChatDaySeparator(dayBeforeYesterdayEnd);
    expect(result).not.toBe('Today');
    expect(result).not.toBe('Yesterday');
    // May 29, 2026 is a Friday — should be within the "this week" range (weekday + date)
    expect(result).toContain('Friday');
  });
});

describe('formatChatTime', () => {
  it('formats a timestamp as time-only', () => {
    const ts = new Date(2026, 4, 12, 14, 34, 0).getTime(); // 2:34 PM
    const result = formatChatTime(ts);
    // en-US should produce something like "2:34 PM"
    expect(result).toContain('2');
    expect(result).toContain('34');
  });

  it('formats morning time correctly', () => {
    const ts = new Date(2026, 4, 12, 9, 5, 0).getTime(); // 9:05 AM
    const result = formatChatTime(ts);
    expect(result).toContain('9');
    expect(result).toContain('05');
  });
});

describe('formatChatTooltip', () => {
  it('includes full date and time information', () => {
    const ts = new Date(2026, 4, 12, 14, 34, 12).getTime(); // Monday, May 12, 2026
    const result = formatChatTooltip(ts);
    // Should contain day of week, month, day, year, and time
    expect(result).toContain('2026');
    expect(result).toContain('12');
  });
});

describe('formatSessionDateRange', () => {
  it('returns single date for same-day range', () => {
    const morning = new Date(2026, 4, 12, 9, 0, 0).getTime();
    const evening = new Date(2026, 4, 12, 17, 0, 0).getTime();
    const result = formatSessionDateRange(morning, evening);
    // Should be a single date, not a range
    expect(result).toContain('May');
    expect(result).toContain('12');
    expect(result).toContain('2026');
    expect(result).not.toContain('–');
  });

  it('returns date range for multi-day conversations', () => {
    const start = new Date(2026, 4, 12, 9, 0, 0).getTime();
    const end = new Date(2026, 4, 28, 17, 0, 0).getTime();
    const result = formatSessionDateRange(start, end);
    // Should contain both dates
    expect(result).toContain('12');
    expect(result).toContain('28');
  });

  it('handles cross-year ranges', () => {
    const start = new Date(2025, 11, 28, 9, 0, 0).getTime(); // Dec 28, 2025
    const end = new Date(2026, 0, 3, 17, 0, 0).getTime(); // Jan 3, 2026
    const result = formatSessionDateRange(start, end);
    expect(result).toContain('2025');
    expect(result).toContain('2026');
  });
});
