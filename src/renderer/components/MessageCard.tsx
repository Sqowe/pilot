// MessageCard — top-level chat message renderer.
// Delegates block rendering to ContentBlockView and its sub-components.
import { useState, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Clock, XCircle } from 'lucide-react';
import type { Message, ContentBlock, ToolUseContent, ToolResultContent } from '../types';
import { ContentBlockView } from './message/ContentBlockView';
import { MemorySourcesBadge } from './message/MemorySourcesBadge';
import { extractMemorySources } from '../utils/memory-source-extractor';
import { formatChatTime, formatChatTooltip } from '../utils/i18n-format';
import { formatDuration } from '../utils/format-duration';

interface MessageCardProps {
  message: Message;
  isStreaming?: boolean;
  memoryContributed?: boolean;
  showTimestamp?: boolean;
  /** Show how long the model took, under the message. Off unless the caller asks for it. */
  showResponseTime?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (messageId: string) => void;
}

export const MessageCard = memo(function MessageCard({
  message,
  isStreaming,
  memoryContributed,
  showTimestamp,
  showResponseTime,
  selectable,
  selected,
  onToggleSelect,
}: MessageCardProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isQueued = message.localStatus === 'queued';
  const isCancelled = message.localStatus === 'cancelled';
  const rawContent = message.content as unknown;
  const contentBlocks = Array.isArray(rawContent)
    ? (rawContent as ContentBlock[])
    : [{ type: 'text', text: String(rawContent ?? '') } as ContentBlock];
  const [copied, setCopied] = useState(false);
  // How long the model took to produce this response (pi measures it; main stores it).
  const responseTimeMs =
    showResponseTime && !isUser && !isStreaming && message.executionTimeMs
      ? message.executionTimeMs
      : undefined;

  // Build a set of tool_result IDs that have a matching tool_use (for merging)
  const mergedResultIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of contentBlocks) {
      if (b.type === 'tool_use') {
        const tu = b as ToolUseContent;
        const result = contentBlocks.find(
          (r) => r.type === 'tool_result' && (r as ToolResultContent).toolUseId === tu.id
        );
        if (result) ids.add((result as ToolResultContent).toolUseId);
      }
    }
    return ids;
  }, [contentBlocks]);

  // Extract memory sources from workspace chat search tool calls
  const memorySources = useMemo(
    () => (memoryContributed ? extractMemorySources(contentBlocks) : []),
    [contentBlocks, memoryContributed]
  );

  // Extract text content for copying
  const getTextContent = () =>
    contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');

  const handleCopy = async (e?: React.MouseEvent) => {
    e?.stopPropagation(); // Prevent toggling selection in export mode
    const text = getTextContent();
    if (text) {
      try {
        await window.electronAPI.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard unavailable
      }
    }
  };

  const handleCardClick = (e: React.MouseEvent) => {
    if (!selectable || !onToggleSelect) return;
    // Don't toggle selection when clicking interactive child elements
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, [role="button"]')) return;
    onToggleSelect(message.id);
  };

  return (
    <div
      className={`animate-fade-in group ${selectable ? 'relative cursor-pointer' : ''} ${
        selectable && selected ? 'ring-1 ring-accent/40 rounded-xl bg-accent/5' : ''
      }`}
      onClick={handleCardClick}
    >
      {/* Selection checkbox */}
      {selectable && (
        <div className="absolute -left-7 top-2 z-10">
          <div
            className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
              selected
                ? 'bg-accent text-white'
                : 'border border-border-muted bg-background hover:border-accent/50'
            }`}
          >
            {selected && <Check className="w-3 h-3" />}
          </div>
        </div>
      )}
      {isUser ? (
        // User message - compact styling with smaller padding and radius
        <>
          <div className="flex items-start gap-2 justify-end">
            <div
              className={`message-user px-4 py-3 rounded-[1.65rem] max-w-[80%] min-w-0 break-words ${
                isQueued ? 'opacity-70 border-dashed' : ''
              } ${isCancelled ? 'opacity-60' : ''}`}
            >
              {isQueued && (
                <div className="mb-1 flex items-center gap-1 text-[11px] text-text-muted">
                  <Clock className="w-3 h-3" />
                  <span>{t('messageCard.queued')}</span>
                </div>
              )}
              {isCancelled && (
                <div className="mb-1 flex items-center gap-1 text-[11px] text-text-muted">
                  <XCircle className="w-3 h-3" />
                  <span>{t('messageCard.cancelled')}</span>
                </div>
              )}
              {contentBlocks.length === 0 ? (
                <span className="text-text-muted italic">{t('messageCard.emptyMessage')}</span>
              ) : (
                contentBlocks.map((block, index) => (
                  <ContentBlockView
                    key={
                      'id' in block ? (block as { id: string }).id : `block-${block.type}-${index}`
                    }
                    block={block}
                    isUser={isUser}
                    isStreaming={isStreaming}
                  />
                ))
              )}
            </div>
            <button
              onClick={handleCopy}
              className="mt-1 w-6 h-6 flex items-center justify-center rounded-md bg-surface-muted hover:bg-surface-active transition-all opacity-0 group-hover:opacity-100 flex-shrink-0"
              title={t('messageCard.copyMessage')}
            >
              {copied ? (
                <Check className="w-3 h-3 text-success" />
              ) : (
                <Copy className="w-3 h-3 text-text-muted" />
              )}
            </button>
          </div>
          {/* Per-message timestamp for user messages */}
          {showTimestamp && message.timestamp > 0 && (
            <div className="flex justify-end mt-1 mr-8 opacity-0 group-hover:opacity-100 transition-opacity">
              <time
                className="text-[11px] text-text-muted/70"
                dateTime={new Date(message.timestamp).toISOString()}
                title={formatChatTooltip(message.timestamp)}
              >
                {formatChatTime(message.timestamp)}
              </time>
            </div>
          )}
        </>
      ) : (
        // Assistant message — no bubble, direct content (Claude style)
        <div className="space-y-1.5">
          {memoryContributed && (
            <MemorySourcesBadge coreMemoryActive={true} sources={memorySources} />
          )}
          {contentBlocks.map((block, index) => {
            // Skip tool_result blocks that are merged into their tool_use card
            if (
              block.type === 'tool_result' &&
              mergedResultIds.has((block as ToolResultContent).toolUseId)
            ) {
              return null;
            }
            return (
              <ContentBlockView
                key={'id' in block ? (block as { id: string }).id : `block-${block.type}-${index}`}
                block={block}
                isUser={isUser}
                isStreaming={isStreaming}
                allBlocks={contentBlocks}
                message={message}
              />
            );
          })}
          {responseTimeMs !== undefined && (
            <div
              className="flex items-center gap-1 text-[11px] text-text-muted/70"
              title={t('messageCard.responseTimeHint')}
            >
              <Clock className="w-3 h-3" />
              <span>{t('messageCard.responseTime', { time: formatDuration(responseTimeMs) })}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
