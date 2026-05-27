/**
 * MemorySourcesBadge — shows a compact indicator when the model used workspace
 * chat search tools, with an expandable list of referenced past conversations.
 *
 * Positioned at the top of assistant messages (before response content) to
 * frame the response as grounded in prior context.
 */
import { useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, ChevronDown, ChevronRight, MessageSquareText } from 'lucide-react';
import type { MemorySource } from '../../types';

export type { MemorySource };

interface MemorySourcesBadgeProps {
  /** Whether passive core memory was injected */
  coreMemoryActive?: boolean;
  /** Sources found via active search_workspace_chats tool calls */
  sources: MemorySource[];
}

export const MemorySourcesBadge = memo(function MemorySourcesBadge({
  coreMemoryActive,
  sources,
}: MemorySourcesBadgeProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Nothing to show if no memory involvement at all
  if (!coreMemoryActive && sources.length === 0) {
    return null;
  }

  // Simple indicator when only core memory was used (no active search)
  if (sources.length === 0 && coreMemoryActive) {
    return (
      <div className="flex items-center gap-1 text-[10px] text-purple-400/80 mb-0.5">
        <Brain className="w-3 h-3" />
        <span>{t('messageCard.memoryContributed')}</span>
      </div>
    );
  }

  // Rich indicator with expandable sources
  return (
    <div className="mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] text-purple-400/80 hover:text-purple-400 transition-colors group"
      >
        <Brain className="w-3 h-3" />
        <span>{t('messageCard.memorySearched', { count: sources.length })}</span>
        {expanded ? (
          <ChevronDown className="w-2.5 h-2.5 opacity-60" />
        ) : (
          <ChevronRight className="w-2.5 h-2.5 opacity-60 group-hover:opacity-100" />
        )}
      </button>

      {expanded && (
        <div className="mt-1 ml-4 space-y-0.5 animate-fade-in">
          {sources.map((source, index) => (
            <div
              key={`${source.title}-${index}`}
              className="flex items-start gap-1.5 text-[10px] text-text-muted"
            >
              <MessageSquareText className="w-3 h-3 flex-shrink-0 mt-0.5 text-purple-400/50" />
              <div className="min-w-0">
                <span className="text-text-secondary font-medium">{source.title}</span>
                {source.summary && <span className="text-text-muted ml-1">— {source.summary}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
