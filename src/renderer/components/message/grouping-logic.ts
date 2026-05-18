// Pure utility functions for turn grouping and process/answer splitting.
// Extracted so both the component and tests share one source of truth.
import type { Message, ContentBlock } from '../../types';

/** Minimum thinking blocks to trigger collapse when no tool calls are present */
export const THINKING_THRESHOLD = 3;

/** A turn is a user message followed by N assistant messages */
export interface Turn {
  /** The user message that started this turn (may be absent for the first assistant messages) */
  userMessage?: Message;
  /** All assistant messages in this turn */
  assistantMessages: Message[];
}

/**
 * Groups a flat message list into turns.
 * A new turn starts at each user message.
 */
export function groupMessagesIntoTurns(messages: Message[]): Turn[] {
  const result: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (currentTurn) {
        result.push(currentTurn);
      }
      currentTurn = { userMessage: msg, assistantMessages: [] };
    } else {
      if (!currentTurn) {
        currentTurn = { assistantMessages: [] };
      }
      currentTurn.assistantMessages.push(msg);
    }
  }
  if (currentTurn) {
    result.push(currentTurn);
  }
  return result;
}

/**
 * Checks whether a turn's assistant messages should be collapsed.
 * Conditions (Option D):
 *   - Any tool_use block across all messages, OR
 *   - ≥ THINKING_THRESHOLD thinking blocks across all messages
 */
export function shouldCollapseTurn(assistantMessages: Message[]): boolean {
  let thinkingCount = 0;
  for (const msg of assistantMessages) {
    const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];
    for (const block of blocks) {
      if (block.type === 'tool_use') return true;
      if (block.type === 'thinking') thinkingCount++;
    }
  }
  return thinkingCount >= THINKING_THRESHOLD;
}

/**
 * Finds the "final answer" messages — the trailing contiguous run of assistant
 * messages whose content ends with text/image/file_attachment.
 * Returns the index where the final answer starts.
 *
 * IMPORTANT: Only considers trailing messages. If the last message does NOT end
 * with answer content, returns assistantMessages.length (no split — the turn
 * has no clear final answer).
 */
export function findFinalAnswerIndex(assistantMessages: Message[]): number {
  if (assistantMessages.length === 0) return 0;

  // First check: does the last message end with answer content?
  const lastMsg = assistantMessages[assistantMessages.length - 1];
  const lastBlocks = Array.isArray(lastMsg.content) ? (lastMsg.content as ContentBlock[]) : [];
  if (lastBlocks.length === 0) return assistantMessages.length;

  const lastBlock = lastBlocks[lastBlocks.length - 1];
  if (
    lastBlock.type !== 'text' &&
    lastBlock.type !== 'image' &&
    lastBlock.type !== 'file_attachment'
  ) {
    // Last message doesn't end with answer content — no split
    return assistantMessages.length;
  }

  // Walk backward from the end to find the first message in the trailing
  // contiguous run of answer-ending messages
  let answerStart = assistantMessages.length - 1;
  for (let i = assistantMessages.length - 2; i >= 0; i--) {
    const msg = assistantMessages[i];
    const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];
    if (blocks.length === 0) break;

    const endBlock = blocks[blocks.length - 1];
    const isAnswerEnding =
      endBlock.type === 'text' || endBlock.type === 'image' || endBlock.type === 'file_attachment';

    // Also exclude messages that are purely tool_result/tool_use
    const hasOnlyToolBlocks = blocks.every(
      (b) => b.type === 'tool_result' || b.type === 'tool_use'
    );

    if (isAnswerEnding && !hasOnlyToolBlocks) {
      answerStart = i;
    } else {
      break;
    }
  }

  return answerStart;
}

/**
 * Intra-message splitting: finds the boundary within a single message's blocks
 * where the "final answer" starts. The final answer is the trailing contiguous
 * run of text/image/file_attachment blocks not followed by tool_use/thinking.
 * Returns the index of the first "answer" block, or blocks.length if no split possible.
 */
export function findIntraMessageAnswerBoundary(blocks: ContentBlock[]): number {
  let boundaryIndex = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const blockType = blocks[i].type;
    if (blockType === 'text' || blockType === 'image' || blockType === 'file_attachment') {
      boundaryIndex = i;
    } else {
      break;
    }
  }
  return boundaryIndex;
}

/** Result of splitting a turn into process and answer messages */
export interface TurnSplitResult {
  processMessages: Message[];
  answerMessages: Message[];
}

/**
 * Splits a turn's assistant messages into process (collapsible) and answer (visible).
 * Handles both multi-message and single-message turns, including the case where
 * the final answer message itself contains leading process blocks.
 */
export function splitTurnMessages(assistantMessages: Message[]): TurnSplitResult {
  if (assistantMessages.length === 0) {
    return { processMessages: [], answerMessages: [] };
  }

  if (assistantMessages.length === 1) {
    // Single message turn — intra-message splitting
    const msg = assistantMessages[0];
    const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];
    const boundary = findIntraMessageAnswerBoundary(blocks);

    if (boundary > 0 && boundary < blocks.length) {
      const processBlocks = blocks.slice(0, boundary);
      const answerBlocks = blocks.slice(boundary);
      const processMsg: Message = { ...msg, id: `${msg.id}-process`, content: processBlocks };
      const answerMsg: Message = { ...msg, id: `${msg.id}-answer`, content: answerBlocks };
      return { processMessages: [processMsg], answerMessages: [answerMsg] };
    }
    // No clear boundary — show flat
    return { processMessages: [], answerMessages: assistantMessages };
  }

  // Multi-message turn — split at message level
  const answerIndex = findFinalAnswerIndex(assistantMessages);
  if (answerIndex >= assistantMessages.length) {
    // No clear final answer (last message doesn't end with answer content) — show flat
    return { processMessages: [], answerMessages: assistantMessages };
  }

  const processMessages: Message[] = assistantMessages.slice(0, answerIndex);
  const rawAnswerMessages = assistantMessages.slice(answerIndex);

  // Apply intra-message splitting to each answer message. Extract leading process
  // blocks into processMessages (hidden in the accordion) while keeping only
  // trailing answer blocks in answerMessages (always visible).
  // This is safe for chronological order because:
  //   - processMessages are rendered inside a collapsed accordion (hidden)
  //   - answerMessages maintain their original relative order
  const answerMessages: Message[] = [];
  for (const msg of rawAnswerMessages) {
    const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];
    const boundary = findIntraMessageAnswerBoundary(blocks);

    if (boundary > 0 && boundary < blocks.length) {
      const leadingProcessBlocks = blocks.slice(0, boundary);
      const trailingAnswerBlocks = blocks.slice(boundary);
      processMessages.push({
        ...msg,
        id: `${msg.id}-process`,
        content: leadingProcessBlocks,
      });
      answerMessages.push({
        ...msg,
        id: `${msg.id}-answer`,
        content: trailingAnswerBlocks,
      });
    } else {
      answerMessages.push(msg);
    }
  }

  // If no process blocks were extracted at all, return flat (no accordion needed)
  if (processMessages.length === 0) {
    return { processMessages: [], answerMessages: assistantMessages };
  }

  return { processMessages, answerMessages };
}
