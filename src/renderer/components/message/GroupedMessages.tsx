// GroupedMessages — groups consecutive assistant messages into collapsible "turns".
// A "turn" starts after a user message and includes all assistant messages until
// the next user message. If the turn meets collapse conditions (has tool calls OR
// ≥3 thinking blocks across all messages), the intermediate messages are wrapped
// in a ProcessAccordion and only the final answer message is shown directly.
import { useMemo, memo, useCallback } from 'react';
import type { Message } from '../../types';
import { MessageCard } from '../MessageCard';
import { ProcessAccordion } from './ProcessAccordion';
import { DateSeparator } from './DateSeparator';
import {
  groupMessagesIntoTurns,
  shouldCollapseTurn,
  splitTurnMessages,
  groupTurnsByDay,
} from './grouping-logic';

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

  /** Get the representative timestamp for a turn (user message or first assistant). */
  const getTurnTimestamp = useCallback(
    (turn: ReturnType<typeof groupMessagesIntoTurns>[number]): number => {
      const userTs = turn.userMessage?.timestamp;
      if (userTs && userTs > 0) return userTs;
      return turn.assistantMessages[0]?.timestamp ?? 0;
    },
    []
  );

  /** Group turns by calendar day for sticky separator support. */
  const dayGroups = useMemo(
    () => groupTurnsByDay(turns, getTurnTimestamp),
    [turns, getTurnTimestamp]
  );

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
      {dayGroups.map((dayGroup, dayIndex) => (
        <div key={`day-${dayGroup.dayTimestamp || dayIndex}`}>
          {/* Sticky day separator — persists while any turn in this day is visible */}
          {dayGroup.dayTimestamp > 0 && <DateSeparator timestamp={dayGroup.dayTimestamp} />}

          {/* All turns for this day */}
          <div className="space-y-5">
            {dayGroup.items.map(({ turn, index: globalTurnIndex }, turnInDayIndex) => {
              const isLastTurn = globalTurnIndex === turns.length - 1;
              const turnIsStreaming = isLastTurn && hasActiveTurn;
              const assistantMsgs = turn.assistantMessages;

              const shouldCollapse = shouldCollapseTurn(assistantMsgs);
              const { processMessages, answerMessages } = shouldCollapse
                ? splitTurnMessages(assistantMsgs)
                : { processMessages: [] as Message[], answerMessages: assistantMsgs };

              const turnKey =
                turn.userMessage?.id ??
                turn.assistantMessages[0]?.id ??
                `turn-${dayIndex}-${turnInDayIndex}`;

              return (
                <div key={turnKey} className="space-y-5">
                  {/* User message */}
                  {turn.userMessage && (
                    <div key={turn.userMessage.id}>
                      <MessageCard
                        message={turn.userMessage}
                        showTimestamp
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
                      forceExpanded={selectable}
                    />
                  )}

                  {/* Final answer messages (or all messages if no collapse) */}
                  {answerMessages.map((msg, msgIndex) => {
                    const isStreaming = typeof msg.id === 'string' && msg.id.startsWith('partial-');
                    const isFirstAssistantInAnswers =
                      msg.role === 'assistant' &&
                      answerMessages.findIndex((m) => m.role === 'assistant') === msgIndex;
                    const retrievalIsForThisTurn =
                      !!turn.userMessage &&
                      !!lastRetrievalTimestamp &&
                      lastRetrievalTimestamp >= turn.userMessage.timestamp;
                    const showMemoryBadge =
                      memoryEnabled &&
                      isLastTurn &&
                      isFirstAssistantInAnswers &&
                      retrievalIsForThisTurn;
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
          </div>
        </div>
      ))}
    </>
  );
});
