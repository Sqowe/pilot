/**
 * @module main/claude/mid-loop-overflow-guard
 *
 * Pure functions for the mid-loop overflow guard that runs inside _onPayload.
 * Extracted for testability — the agent-runner uses these internally.
 *
 * The mid-loop guard intercepts every API request the SDK makes (including
 * during the tool loop) and trims the messages array if the estimated total
 * would overflow the context window. Unlike the pre-request guard (which runs
 * once before piSession.prompt()), this catches overflow that accumulates
 * during multi-turn tool loops.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PayloadEstimateInput {
  /** The messages array from the payload (LLM-format messages). */
  messages: unknown[];
  /** The tools array from the payload (tool definitions). */
  tools?: unknown[];
  /** Model's context window in tokens. */
  contextWindow: number;
  /** Model's max output tokens (reserved for the response). */
  maxOutput: number;
  /** Safety margin in tokens. */
  safetyMargin: number;
}

export interface PayloadEstimateResult {
  estimatedTotal: number;
  contextWindow: number;
  overflow: number;
  wouldOverflow: boolean;
  breakdown: {
    messageTokens: number;
    toolTokens: number;
    maxOutput: number;
    safetyMargin: number;
  };
}

export interface Turn {
  /** Index of the first message in this turn (within the droppable range). */
  startIdx: number;
  /** Index of the last message in this turn. */
  endIdx: number;
  /** Estimated chars for all messages in this turn. */
  chars: number;
}

export interface TrimResult {
  /** The trimmed messages array. */
  trimmedMessages: unknown[];
  /** Number of turns dropped. */
  turnsDropped: number;
  /** Number of individual messages dropped. */
  messagesDropped: number;
  /** Estimated chars freed. */
  charsFreed: number;
  /** Estimated message tokens after trimming (caller adds tools + output for full total). */
  estimatedTotalAfterTrim: number;
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

function estimateChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 200;
  }
}

/**
 * Estimate the total token cost of a payload.
 *
 * Performance: short-circuits for small payloads (< 5 messages with no tools)
 * to avoid unnecessary JSON.stringify overhead in the common case.
 */
export function estimatePayloadSize(input: PayloadEstimateInput): PayloadEstimateResult {
  const toolCount = input.tools?.length ?? 0;

  // Short-circuit: for very small payloads, skip estimation — they can't overflow
  // unless the context window is tiny. Check message count + tool count heuristic.
  // A message averages ~500 chars ≈ 125 tokens. 5 messages + no tools ≈ 625 tokens.
  // Only short-circuit if this is clearly under budget.
  if (input.messages.length <= 3 && toolCount === 0 && input.contextWindow > 8000) {
    return {
      estimatedTotal: 0,
      contextWindow: input.contextWindow,
      overflow: -input.contextWindow,
      wouldOverflow: false,
      breakdown: {
        messageTokens: 0,
        toolTokens: 0,
        maxOutput: input.maxOutput,
        safetyMargin: input.safetyMargin,
      },
    };
  }

  let totalMessageChars = 0;
  for (const msg of input.messages) {
    totalMessageChars += estimateChars(msg);
  }
  const messageTokens = Math.ceil(totalMessageChars / 4);

  let toolTokens = 0;
  if (input.tools && Array.isArray(input.tools)) {
    for (const tool of input.tools) {
      toolTokens += Math.ceil(estimateChars(tool) / 4);
    }
  }

  const estimatedTotal = messageTokens + toolTokens + input.maxOutput + input.safetyMargin;
  const overflow = estimatedTotal - input.contextWindow;

  return {
    estimatedTotal,
    contextWindow: input.contextWindow,
    overflow,
    wouldOverflow: overflow > 0,
    breakdown: {
      messageTokens,
      toolTokens,
      maxOutput: input.maxOutput,
      safetyMargin: input.safetyMargin,
    },
  };
}

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------

/**
 * Check if a message contains tool_use content blocks (Anthropic-style).
 * Anthropic assistant messages have content: [{ type: 'tool_use', ... }]
 */
function hasToolUseBlocks(msg: Record<string, unknown>): boolean {
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      ((block as Record<string, unknown>).type === 'tool_use' ||
        (block as Record<string, unknown>).type === 'toolCall')
  );
}

/**
 * Check if a message contains tool_result content blocks (Anthropic-style).
 * Anthropic user messages can have content: [{ type: 'tool_result', ... }]
 */
function hasToolResultBlocks(msg: Record<string, unknown>): boolean {
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'tool_result'
  );
}

/**
 * Group messages into atomic turns that preserve tool-call/result integrity.
 *
 * Handles two payload formats:
 *
 * 1. **OpenAI-style**: tool results are separate messages with role 'tool'
 *    - assistant (with tool_calls) → tool (result) → tool (result) → ...
 *
 * 2. **Anthropic-style**: tool results are embedded in a 'user' message
 *    - assistant (content: [{type:'tool_use',...}]) → user (content: [{type:'tool_result',...}])
 *
 * A "turn" groups:
 *   - An assistant message + all immediately following tool/tool_result role messages (OpenAI)
 *   - An assistant message with tool_use blocks + the following user message with tool_result blocks (Anthropic)
 *   - A standalone user message (no tool_result blocks)
 *   - Any other role message (standalone)
 *
 * This ensures we never orphan a tool_use without its tool_result or vice versa.
 */
export function groupMessagesIntoTurns(messages: unknown[], startIdx: number): Turn[] {
  const turns: Turn[] = [];
  let i = startIdx;

  while (i < messages.length) {
    const msg = messages[i] as Record<string, unknown>;
    const role = msg?.role as string | undefined;

    if (role === 'assistant') {
      // An assistant turn includes the assistant message plus all
      // immediately following tool-result messages (both formats)
      const turnStart = i;
      let turnChars = estimateChars(messages[i]);
      const assistantHasToolUse = hasToolUseBlocks(msg);
      i++;

      // Consume following messages that are tool results:
      // - OpenAI format: role === 'tool' or role === 'tool_result'
      // - Anthropic format: role === 'user' with tool_result content blocks
      while (i < messages.length) {
        const nextMsg = messages[i] as Record<string, unknown>;
        const nextRole = nextMsg?.role as string | undefined;

        if (nextRole === 'tool' || nextRole === 'tool_result') {
          // OpenAI-style tool result message
          turnChars += estimateChars(messages[i]);
          i++;
        } else if (assistantHasToolUse && nextRole === 'user' && hasToolResultBlocks(nextMsg)) {
          // Anthropic-style: user message containing tool_result blocks
          // belongs to this assistant's tool-use turn
          turnChars += estimateChars(messages[i]);
          i++;
          // After consuming the tool_result user message, stop — the next
          // message starts a new turn (could be another assistant response)
          break;
        } else {
          break;
        }
      }
      turns.push({ startIdx: turnStart, endIdx: i - 1, chars: turnChars });
    } else if (role === 'user' && hasToolResultBlocks(msg)) {
      // A user message with tool_result blocks that wasn't consumed by a
      // preceding assistant turn. This can happen if the assistant message
      // was already dropped or if the conversation starts mid-tool-loop.
      // Treat it as part of the NEXT turn to avoid orphaning it.
      // However, since we process forward, we treat it as standalone here
      // and rely on the trim boundary validation below.
      const turnChars = estimateChars(messages[i]);
      turns.push({ startIdx: i, endIdx: i, chars: turnChars });
      i++;
    } else {
      // Regular user message or other role — standalone turn
      const turnChars = estimateChars(messages[i]);
      turns.push({ startIdx: i, endIdx: i, chars: turnChars });
      i++;
    }
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Trimming
// ---------------------------------------------------------------------------

/**
 * Trim the oldest turns from a messages array to fit within the context window.
 *
 * Preserves:
 *   - The system message (if first message has role "system")
 *   - Tool-call/result atomicity (never splits a turn)
 *   - At least the last `minKeepTurns` turns
 *
 * Does NOT inject synthetic messages (avoids provider-specific schema issues).
 *
 * Returns null if no trimming is possible (too few turns).
 */
export function trimPayloadMessages(
  messages: unknown[],
  overflow: number,
  options?: { minKeepTurns?: number }
): TrimResult | null {
  // Clamp minKeepTurns to at least 1 to prevent out-of-bounds access
  const minKeepTurns = Math.max(1, options?.minKeepTurns ?? 2);

  // Check if first message is system (should not be dropped)
  const firstMsg = messages[0] as Record<string, unknown> | undefined;
  const firstIsSystem = firstMsg?.role === 'system';
  const startIdx = firstIsSystem ? 1 : 0;

  // Group into turns
  const turns = groupMessagesIntoTurns(messages, startIdx);

  // Keep at least minKeepTurns
  const maxDroppableTurns = Math.max(0, turns.length - minKeepTurns);

  if (maxDroppableTurns === 0) {
    return null; // Can't drop anything
  }

  // Drop turns from oldest until we've freed enough chars
  const charsToFree = overflow * 4; // overflow is in tokens, chars ≈ tokens * 4
  let freedChars = 0;
  let turnsToDrop = 0;

  for (let t = 0; t < maxDroppableTurns && freedChars < charsToFree; t++) {
    freedChars += turns[t].chars;
    turnsToDrop++;
  }

  if (turnsToDrop === 0) {
    return null;
  }

  // Guard: ensure turnsToDrop is within bounds before accessing turns array
  if (turnsToDrop >= turns.length) {
    // All turns would be dropped — keep at least the last one
    turnsToDrop = turns.length - 1;
  }

  // Calculate the message index where kept messages start
  const firstKeptMsgIdx = turns[turnsToDrop].startIdx;

  // ─── Trim boundary validation ──────────────────────────────────────
  // Verify the first kept message is not an orphaned tool_result.
  // If it is, we need to also drop it (extend the trim by one more turn).
  // However, we must not violate minKeepTurns — if boundary adjustment
  // would leave fewer than minKeepTurns, we revert to the original boundary.
  let validatedFirstKeptIdx = firstKeptMsgIdx;
  const firstKeptMsg = messages[validatedFirstKeptIdx] as Record<string, unknown> | undefined;
  if (firstKeptMsg) {
    const firstKeptRole = firstKeptMsg.role as string | undefined;
    // Check for orphaned tool_result (OpenAI-style)
    if (firstKeptRole === 'tool' || firstKeptRole === 'tool_result') {
      // Skip forward past all orphaned tool results
      let candidateIdx = validatedFirstKeptIdx;
      while (candidateIdx < messages.length) {
        const m = messages[candidateIdx] as Record<string, unknown>;
        const r = m?.role as string | undefined;
        if (r === 'tool' || r === 'tool_result') {
          candidateIdx++;
        } else {
          break;
        }
      }
      // Only apply if we still have enough messages remaining
      const remainingAfterAdjust = messages.length - candidateIdx + (firstIsSystem ? 1 : 0);
      if (remainingAfterAdjust >= 1) {
        validatedFirstKeptIdx = candidateIdx;
      }
      // Otherwise keep original boundary — better to have an orphan than empty payload
    }
    // Check for orphaned Anthropic-style tool_result in user message
    else if (firstKeptRole === 'user' && hasToolResultBlocks(firstKeptMsg)) {
      // Only skip if we still have messages after it
      if (validatedFirstKeptIdx + 1 < messages.length) {
        validatedFirstKeptIdx++;
      }
    }
  }

  // ─── Enforce minimum payload non-emptiness ─────────────────────────
  // After boundary adjustment, ensure we haven't trimmed to only system/empty
  // AND that we still satisfy minKeepTurns.
  const remainingNonSystem = messages.length - validatedFirstKeptIdx;
  if (remainingNonSystem < 1) {
    // Boundary adjustment went too far — revert to original
    validatedFirstKeptIdx = firstKeptMsgIdx;
  } else {
    // Re-validate minKeepTurns: count turns remaining after adjustment
    const remainingTurns = groupMessagesIntoTurns(messages, validatedFirstKeptIdx);
    if (remainingTurns.length < minKeepTurns && validatedFirstKeptIdx !== firstKeptMsgIdx) {
      // Boundary adjustment violated minKeepTurns — revert to original boundary
      validatedFirstKeptIdx = firstKeptMsgIdx;
    }
  }

  const actualMessagesDropped = validatedFirstKeptIdx - startIdx;

  // Build trimmed messages array
  const trimmedMessages = [
    ...(firstIsSystem ? [messages[0]] : []),
    ...messages.slice(validatedFirstKeptIdx),
  ];

  // Re-estimate after trimming
  let trimmedChars = 0;
  for (const msg of trimmedMessages) {
    trimmedChars += estimateChars(msg);
  }

  return {
    trimmedMessages,
    turnsDropped: turnsToDrop,
    messagesDropped: actualMessagesDropped,
    charsFreed: freedChars,
    estimatedTotalAfterTrim: Math.ceil(trimmedChars / 4), // message tokens only (caller adds tools + output)
  };
}
