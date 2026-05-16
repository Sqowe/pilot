// ProcessAccordion — collapsible wrapper for intermediate assistant messages.
// Groups multiple assistant messages (thinking, tool calls, intermediate narration)
// into a single expandable section, showing only a summary pill when collapsed.
// Works at the message-group level: wraps multiple MessageCards, not individual blocks.
import { useState, useEffect, memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Zap } from 'lucide-react';
import type { Message, ContentBlock } from '../../types';

interface ProcessAccordionProps {
  /** The intermediate assistant messages to collapse */
  messages: Message[];
  /** Whether the turn is still active (streaming) */
  isStreaming?: boolean;
  /** Render function for each message (reuses MessageCard) */
  renderMessage: (message: Message, isStreaming: boolean) => ReactNode;
}

export const ProcessAccordion = memo(function ProcessAccordion({
  messages,
  isStreaming,
  renderMessage,
}: ProcessAccordionProps) {
  const { t } = useTranslation();
  // Expanded while streaming, collapsed once done
  const [expanded, setExpanded] = useState(Boolean(isStreaming));

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (!isStreaming) {
      setExpanded(false);
    }
  }, [isStreaming]);

  const summary = useMemo(() => {
    let thinkingCount = 0;
    let toolCount = 0;
    for (const msg of messages) {
      const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];
      for (const block of blocks) {
        if (block.type === 'thinking') thinkingCount++;
        if (block.type === 'tool_use') toolCount++;
      }
    }
    return { thinkingCount, toolCount };
  }, [messages]);

  // Build the summary label parts
  const summaryParts: string[] = [];
  if (summary.thinkingCount > 0) {
    summaryParts.push(t('messageCard.processThinking', { count: summary.thinkingCount }));
  }
  if (summary.toolCount > 0) {
    summaryParts.push(t('messageCard.processTools', { count: summary.toolCount }));
  }
  const summaryText = summaryParts.join(' · ');

  if (messages.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border-subtle bg-background/40 overflow-hidden">
      {/* Collapsed pill / header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover/50 transition-colors"
      >
        <Zap className="w-3.5 h-3.5 text-accent flex-shrink-0" />
        <span className="text-xs font-medium text-text-muted flex-shrink-0">
          {t('messageCard.process')}
        </span>
        {!expanded && summaryText && (
          <span className="text-[11px] text-text-muted/60 truncate flex-1 min-w-0">
            {summaryText}
          </span>
        )}
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0 ml-auto" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0 ml-auto" />
        )}
      </button>

      {/* Expanded content — renders each message via the provided render function */}
      {expanded && (
        <div className="border-t border-border/50 px-3 py-2 space-y-3 animate-fade-in">
          {messages.map((msg) => {
            const msgIsStreaming = typeof msg.id === 'string' && msg.id.startsWith('partial-');
            return <div key={msg.id}>{renderMessage(msg, msgIsStreaming)}</div>;
          })}
        </div>
      )}
    </div>
  );
});
