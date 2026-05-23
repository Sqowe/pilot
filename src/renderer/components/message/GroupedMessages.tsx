// GroupedMessages — groups consecutive assistant messages into collapsible "turns".
// A "turn" starts after a user message and includes all assistant messages until
// the next user message. If the turn meets collapse conditions (has tool calls OR
// ≥3 thinking blocks across all messages), the intermediate messages are wrapped
// in a ProcessAccordion and only the final answer message is shown directly.
import { useMemo, memo, useCallback } from 'react';
import type { Message } from '../../types';
import { MessageCard } from '../MessageCard';
import { ProcessAccordion } from './ProcessAccordion';
import { groupMessagesIntoTurns, shouldCollapseTurn, splitTurnMessages } from './grouping-logic';

interface GroupedMessagesProps {
  messages: Message[];
  hasActiveTurn: boolean;
  memoryEnabled?: boolean;
  lastRetrievalTimestamp?: number;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (messageId: string) => void;
  isExportable?: (msg: Message) => boolean;
}

export const GroupedMessages = memo(function GroupedMessages({
  messages,
  hasActiveTurn,
  memoryEnabled,
  lastRetrievalTimestamp,
  selectable,
  selectedIds,
  onToggleSelect,
  isExportable,
}: GroupedMessagesProps) {
  // Helper: determine if a message is exportable (uses passed-in helper or default)
  const isMessageExportable = (msg: Message): boolean =>
    isExportable ? isExportable(msg) : !msg.id.startsWith('partial-') && msg.role !== 'system';

  // Group messages into turns
  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);

  const renderMessage = useCallback(
    (msg: Message, isStreaming: boolean) => (
      <MessageCard
        message={msg}
        isStreaming={isStreaming}
        selectable={selectable && isMessageExportable(msg)}
        selected={selectedIds?.has(msg.id)}
        onToggleSelect={onToggleSelect}
      />
    ),
    [selectable, selectedIds, onToggleSelect]
  );

  return (
    <>
      {turns.map((turn, turnIndex) => {
        const isLastTurn = turnIndex === turns.length - 1;
        const turnIsStreaming = isLastTurn && hasActiveTurn;
        const assistantMsgs = turn.assistantMessages;

        // Always check collapse conditions (even during streaming) so the
        // accordion structure is stable. During streaming it renders expanded;
        // on completion it collapses — no abrupt remount.
        const shouldCollapse = shouldCollapseTurn(assistantMsgs);
        const { processMessages, answerMessages } = shouldCollapse
          ? splitTurnMessages(assistantMsgs)
          : { processMessages: [] as Message[], answerMessages: assistantMsgs };

        return (
          <div
            key={turn.userMessage?.id ?? turn.assistantMessages[0]?.id ?? `turn-${turnIndex}`}
            className="space-y-5"
          >
            {/* User message */}
            {turn.userMessage && (
              <div key={turn.userMessage.id}>
                <MessageCard
                  message={turn.userMessage}
                  selectable={selectable && isMessageExportable(turn.userMessage)}
                  selected={selectedIds?.has(turn.userMessage.id)}
                  onToggleSelect={onToggleSelect}
                />
              </div>
            )}

            {/* Process accordion (collapsed intermediate messages) */}
            {processMessages.length > 0 && (
              <ProcessAccordion
                messages={processMessages}
                isStreaming={turnIsStreaming}
                renderMessage={renderMessage}
              />
            )}

            {/* Final answer messages (or all messages if no collapse) */}
            {answerMessages.map((msg, msgIndex) => {
              const isStreaming = typeof msg.id === 'string' && msg.id.startsWith('partial-');
              // Show memory indicator only on the first assistant answer of the last turn,
              // and only when retrieval actually happened (timestamp is after the turn's user message)
              const isFirstAssistantInAnswers =
                msg.role === 'assistant' &&
                answerMessages.findIndex((m) => m.role === 'assistant') === msgIndex;
              const retrievalIsForThisTurn =
                !!turn.userMessage &&
                !!lastRetrievalTimestamp &&
                lastRetrievalTimestamp >= turn.userMessage.timestamp;
              const showMemoryBadge =
                memoryEnabled && isLastTurn && isFirstAssistantInAnswers && retrievalIsForThisTurn;
              return (
                <div key={msg.id}>
                  <MessageCard
                    message={msg}
                    isStreaming={isStreaming}
                    memoryContributed={showMemoryBadge}
                    selectable={selectable && isMessageExportable(msg)}
                    selected={selectedIds?.has(msg.id)}
                    onToggleSelect={onToggleSelect}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
});
