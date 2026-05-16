// ProcessAccordion — collapsible wrapper for intermediate assistant messages.
// Groups multiple assistant messages (thinking, tool calls, intermediate narration)
// into a single expandable section, showing only a summary pill when collapsed.
// Animates expand/collapse transitions smoothly using measured height.
import { useState, useEffect, useRef, memo, useMemo, useCallback, type ReactNode } from 'react';
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

const ANIMATION_DURATION_MS = 250;

export const ProcessAccordion = memo(function ProcessAccordion({
  messages,
  isStreaming,
  renderMessage,
}: ProcessAccordionProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(Boolean(isStreaming));
  // Controls whether content is mounted in the DOM
  const [mounted, setMounted] = useState(Boolean(isStreaming));
  // Tracks the animated max-height value (null = no inline style)
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  // Track the previous isStreaming value to detect the streaming→complete transition
  const prevIsStreaming = useRef(isStreaming);

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (prevIsStreaming.current && !isStreaming) {
      setExpanded(false);
    }
    prevIsStreaming.current = isStreaming;
  }, [isStreaming]);

  // Mount/unmount lifecycle tied to expanded state
  useEffect(() => {
    if (expanded) {
      // Mount content immediately when expanding
      setMounted(true);
    } else if (mounted) {
      // Unmount after collapse animation completes
      const timer = setTimeout(() => setMounted(false), ANIMATION_DURATION_MS);
      return () => clearTimeout(timer);
    }
  }, [expanded, mounted]);

  // Measure and update height dynamically using ResizeObserver.
  // This handles content growing/shrinking during streaming without
  // depending on message count changes.
  useEffect(() => {
    if (!mounted || !expanded || !contentRef.current) {
      if (!expanded) setContentHeight(0);
      return;
    }

    const el = contentRef.current;
    // Set initial height
    setContentHeight(el.scrollHeight);

    // Watch for content size changes (streaming token updates, lazy loads, etc.)
    const observer = new ResizeObserver(() => {
      if (contentRef.current) {
        setContentHeight(contentRef.current.scrollHeight);
      }
    });
    observer.observe(el);

    return () => observer.disconnect();
  }, [mounted, expanded]);

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

  const summaryParts: string[] = [];
  if (summary.thinkingCount > 0) {
    summaryParts.push(t('messageCard.processThinking', { count: summary.thinkingCount }));
  }
  if (summary.toolCount > 0) {
    summaryParts.push(t('messageCard.processTools', { count: summary.toolCount }));
  }
  const summaryText = summaryParts.join(' · ');

  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  if (messages.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border-subtle bg-background/40 overflow-hidden">
      {/* Header pill — always visible */}
      <button
        onClick={toggle}
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
        <span className="ml-auto flex-shrink-0">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
          )}
        </span>
      </button>

      {/* Animated content area — only mounted when needed */}
      {mounted && (
        <div
          className="overflow-hidden transition-[max-height,opacity] duration-[250ms] ease-in-out"
          style={{
            maxHeight: contentHeight != null ? `${contentHeight}px` : undefined,
            opacity: expanded ? 1 : 0,
          }}
        >
          <div ref={contentRef} className="border-t border-border/50 px-3 py-2 space-y-3">
            {messages.map((msg) => {
              const msgIsStreaming = typeof msg.id === 'string' && msg.id.startsWith('partial-');
              return <div key={msg.id}>{renderMessage(msg, msgIsStreaming)}</div>;
            })}
          </div>
        </div>
      )}
    </div>
  );
});
