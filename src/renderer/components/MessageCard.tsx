// MessageCard — top-level chat message renderer.
// Delegates block rendering to ContentBlockView and its sub-components.
import { useState, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Clock, XCircle } from 'lucide-react';
import type { Message, ContentBlock, ToolUseContent, ToolResultContent } from '../types';
import { ContentBlockView } from './message/ContentBlockView';
import { ProcessAccordion } from './message/ProcessAccordion';

interface MessageCardProps {
  message: Message;
  isStreaming?: boolean;
}

export const MessageCard = memo(function MessageCard({ message, isStreaming }: MessageCardProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isQueued = message.localStatus === 'queued';
  const isCancelled = message.localStatus === 'cancelled';
  const rawContent = message.content as unknown;
  const contentBlocks = Array.isArray(rawContent)
    ? (rawContent as ContentBlock[])
    : [{ type: 'text', text: String(rawContent ?? '') } as ContentBlock];
  const [copied, setCopied] = useState(false);

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

  // Extract text content for copying
  const getTextContent = () =>
    contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');

  const handleCopy = async () => {
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

  return (
    <div className="animate-fade-in">
      {isUser ? (
        // User message - compact styling with smaller padding and radius
        <div className="flex items-start gap-2 justify-end group">
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
      ) : (
        // Assistant message — no bubble, direct content (Claude style)
        <AssistantMessageBody
          contentBlocks={contentBlocks}
          mergedResultIds={mergedResultIds}
          isStreaming={isStreaming}
          message={message}
        />
      )}
    </div>
  );
});

// --- Process/Answer splitting logic ---

const THINKING_THRESHOLD = 3; // Collapse if ≥3 thinking blocks (even without tools)

interface AssistantMessageBodyProps {
  contentBlocks: ContentBlock[];
  mergedResultIds: Set<string>;
  isStreaming?: boolean;
  message: Message;
}

/**
 * Determines whether to show a ProcessAccordion and splits blocks accordingly.
 * Collapse conditions (Option D):
 *   - Any tool_use block is present, OR
 *   - ≥ THINKING_THRESHOLD thinking blocks
 *
 * "Final answer" = the trailing contiguous text blocks not followed by tool_use/thinking.
 */
function AssistantMessageBody({
  contentBlocks,
  mergedResultIds,
  isStreaming,
  message,
}: AssistantMessageBodyProps) {
  const { processBlocks, answerBlocks, shouldCollapse } = useMemo(() => {
    // Filter out merged tool_results first (same logic as before)
    const visibleBlocks = contentBlocks.filter((block) => {
      if (
        block.type === 'tool_result' &&
        mergedResultIds.has((block as ToolResultContent).toolUseId)
      ) {
        return false;
      }
      return true;
    });

    // Check collapse conditions
    const hasToolUse = visibleBlocks.some((b) => b.type === 'tool_use');
    const thinkingCount = visibleBlocks.filter((b) => b.type === 'thinking').length;
    const shouldCollapseResult = hasToolUse || thinkingCount >= THINKING_THRESHOLD;

    if (!shouldCollapseResult) {
      return { processBlocks: [], answerBlocks: visibleBlocks, shouldCollapse: false };
    }

    // Find the boundary: the "final answer" is the trailing run of text/image blocks
    // not followed by any tool_use, tool_result, or thinking block.
    let boundaryIndex = visibleBlocks.length;
    for (let i = visibleBlocks.length - 1; i >= 0; i--) {
      const blockType = visibleBlocks[i].type;
      if (blockType === 'text' || blockType === 'image' || blockType === 'file_attachment') {
        boundaryIndex = i;
      } else {
        // Hit a non-text block — everything from here up is process
        break;
      }
    }

    // Edge case: if there's no trailing text (message ends with tool_use/tool_result),
    // don't split — show everything flat (no final answer to highlight)
    if (boundaryIndex >= visibleBlocks.length) {
      return { processBlocks: [], answerBlocks: visibleBlocks, shouldCollapse: false };
    }

    return {
      processBlocks: visibleBlocks.slice(0, boundaryIndex),
      answerBlocks: visibleBlocks.slice(boundaryIndex),
      shouldCollapse: true,
    };
  }, [contentBlocks, mergedResultIds]);

  if (!shouldCollapse) {
    // No accordion — render flat like before
    return (
      <div className="space-y-1.5">
        {answerBlocks.map((block, index) => (
          <ContentBlockView
            key={'id' in block ? (block as { id: string }).id : `block-${block.type}-${index}`}
            block={block}
            isUser={false}
            isStreaming={isStreaming}
            allBlocks={contentBlocks}
            message={message}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {/* Collapsible process section */}
      <ProcessAccordion
        blocks={processBlocks}
        isStreaming={isStreaming}
        allBlocks={contentBlocks}
        message={message}
      />
      {/* Final answer — always visible */}
      {answerBlocks.map((block, index) => (
        <ContentBlockView
          key={'id' in block ? (block as { id: string }).id : `answer-${block.type}-${index}`}
          block={block}
          isUser={false}
          isStreaming={isStreaming}
          allBlocks={contentBlocks}
          message={message}
        />
      ))}
    </div>
  );
}
