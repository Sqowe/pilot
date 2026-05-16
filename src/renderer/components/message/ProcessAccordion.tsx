// ProcessAccordion — collapsible wrapper for intermediate reasoning steps.
// Groups thinking blocks, tool calls, and intermediate text into a single
// expandable section, showing only a summary pill when collapsed.
import { useState, useEffect, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Zap } from 'lucide-react';
import type { ContentBlock, Message } from '../../types';
import { ContentBlockView } from './ContentBlockView';

interface ProcessAccordionProps {
  /** The "process" content blocks (thinking, tool_use, tool_result, intermediate text) */
  blocks: ContentBlock[];
  /** Whether the parent message is still streaming */
  isStreaming?: boolean;
  /** All blocks in the message (passed through to ContentBlockView) */
  allBlocks: ContentBlock[];
  /** The parent message */
  message?: Message;
}

export const ProcessAccordion = memo(function ProcessAccordion({
  blocks,
  isStreaming,
  allBlocks,
  message,
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
    for (const block of blocks) {
      if (block.type === 'thinking') thinkingCount++;
      if (block.type === 'tool_use') toolCount++;
    }
    return { thinkingCount, toolCount };
  }, [blocks]);

  // Build the summary label parts
  const summaryParts: string[] = [];
  if (summary.thinkingCount > 0) {
    summaryParts.push(t('messageCard.processThinking', { count: summary.thinkingCount }));
  }
  if (summary.toolCount > 0) {
    summaryParts.push(t('messageCard.processTools', { count: summary.toolCount }));
  }
  const summaryText = summaryParts.join(' · ');

  if (blocks.length === 0) return null;

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

      {/* Expanded content — renders each block via existing ContentBlockView */}
      {expanded && (
        <div className="border-t border-border/50 px-3 py-2 space-y-1.5 animate-fade-in">
          {blocks.map((block, index) => (
            <ContentBlockView
              key={
                'id' in block
                  ? (block as { id: string }).id
                  : `process-block-${block.type}-${index}`
              }
              block={block}
              isUser={false}
              isStreaming={isStreaming}
              allBlocks={allBlocks}
              message={message}
            />
          ))}
        </div>
      )}
    </div>
  );
});
