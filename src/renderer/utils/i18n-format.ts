import i18n from '../i18n/config';

function getAppLocale(language = i18n.resolvedLanguage || i18n.language): string {
  if (language.startsWith('zh')) {
    return 'zh-CN';
  }
  return 'en-US';
}

export function formatAppDateTime(value: number | string | Date): string {
  return new Intl.DateTimeFormat(getAppLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatAppDate(
  value: number | string | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(
    getAppLocale(),
    options || {
      month: 'short',
      day: 'numeric',
    }
  ).format(new Date(value));
}

export function joinAppList(values: string[]): string {
  return values.join(getAppLocale().startsWith('zh') ? '、' : ', ');
}

// ─── Chat Timestamp Utilities ────────────────────────────────────────────────

/**
 * Get the start-of-day timestamp for a given date (midnight, local time).
 */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Check if two timestamps fall on the same calendar day (local time).
 */
export function isSameDay(ts1: number, ts2: number): boolean {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

/**
 * Format a timestamp for use as a day separator label.
 * Progressive detail:
 *   Today → Yesterday → Weekday + date (this week) → Month Day → Month Day, Year
 */
export function formatChatDaySeparator(timestamp: number): string {
  const locale = getAppLocale();
  const now = new Date();
  const date = new Date(timestamp);

  // Use calendar-date arithmetic (DST-safe) instead of fixed ms offsets
  const todayStart = startOfDay(now);
  const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();

  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();

  const weekAgoStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();

  const ts = date.getTime();

  if (ts >= todayStart && ts < tomorrowStart) {
    return i18n.t('sidebar.today');
  }
  if (ts >= yesterdayStart && ts < todayStart) {
    return i18n.t('sidebar.yesterday');
  }
  if (ts >= weekAgoStart && ts < yesterdayStart) {
    // Weekday + short date: "Wednesday, May 28" / "星期三，5月28日"
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    // Same year — no need to show year: "May 12" / "5月12日"
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  }
  // Different year — show full date: "May 12, 2024" / "2024年5月12日"
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * Format a timestamp as time-only for per-message display.
 * e.g., "2:34 PM" (en-US) or "下午2:34" (zh-CN)
 */
export function formatChatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(getAppLocale(), {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

/**
 * Format a full timestamp for tooltip/hover display.
 * e.g., "Monday, May 12, 2026, 2:34:12 PM" (en-US)
 */
export function formatChatTooltip(timestamp: number): string {
  return new Intl.DateTimeFormat(getAppLocale(), {
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(new Date(timestamp));
}

/**
 * Format a date range for session header metadata.
 * Single day: "May 12, 2026" — Multi-day: "May 12 – May 28, 2026"
 */
export function formatSessionDateRange(startTs: number, endTs: number): string {
  const locale = getAppLocale();
  if (isSameDay(startTs, endTs)) {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(startTs));
  }
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };
  const fmt = new Intl.DateTimeFormat(locale, options);
  // Use formatRange if available (modern browsers / Electron)
  if (typeof fmt.formatRange === 'function') {
    return fmt.formatRange(new Date(startTs), new Date(endTs));
  }
  // Fallback for older environments
  const start = fmt.format(new Date(startTs));
  const end = fmt.format(new Date(endTs));
  return `${start} – ${end}`;
}
