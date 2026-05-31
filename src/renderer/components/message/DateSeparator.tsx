import { formatChatDaySeparator, formatChatTooltip } from '../../utils/i18n-format';

interface DateSeparatorProps {
  timestamp: number;
}

/**
 * A horizontal divider with a centered date label.
 * Inserted between message turns when the calendar day changes.
 */
export function DateSeparator({ timestamp }: DateSeparatorProps) {
  const label = formatChatDaySeparator(timestamp);
  const tooltip = formatChatTooltip(timestamp);

  return (
    <div className="flex items-center gap-3 py-3" role="separator" aria-label={label}>
      <div className="flex-1 h-px bg-border-subtle" />
      <time
        className="text-[11px] text-text-muted whitespace-nowrap select-none"
        dateTime={new Date(timestamp).toISOString()}
        title={tooltip}
      >
        {label}
      </time>
      <div className="flex-1 h-px bg-border-subtle" />
    </div>
  );
}
