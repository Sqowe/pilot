const SCHEDULE_TITLE_PREFIX = '[定时任务]';
const EMPTY_SUMMARY_FALLBACK = '未命名任务';
const DEFAULT_SUMMARY_MAX_LENGTH = 48;

export function summarizeSchedulePrompt(
  prompt: string,
  maxLength: number = DEFAULT_SUMMARY_MAX_LENGTH
): string {
  const normalizedPrompt = prompt
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ');

  if (!normalizedPrompt) {
    return EMPTY_SUMMARY_FALLBACK;
  }

  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return normalizedPrompt;
  }

  if (normalizedPrompt.length <= maxLength) {
    return normalizedPrompt;
  }

  return `${normalizedPrompt.slice(0, Math.max(1, maxLength - 3))}...`;
}

export function buildScheduledTaskTitle(prompt: string): string {
  return `${SCHEDULE_TITLE_PREFIX} ${summarizeSchedulePrompt(prompt)}`;
}
