/**
 * @module renderer/utils/context-usage
 *
 * Pure computation for context usage display. Used by ContextPanel and tests.
 */

export interface ContextUsageInput {
  contextWindow: number;
  toolSchemaTokens: number;
  maxOutputTokens: number;
  currentInputTokens: number;
  /** Fallback: last message's tokenUsage.input (used when currentInputTokens is 0) */
  lastMessageInputTokens: number;
}

export interface ContextUsageResult {
  /** Conversation tokens (the "active" growing part) */
  conversation: number;
  /** Tool schema tokens (fixed cost) */
  toolSchemaTokens: number;
  /** Output reservation tokens (fixed cost) */
  maxOutputTokens: number;
  /** Sum of all three components */
  effectiveUsed: number;
  /** Context window size */
  total: number;
  /** Overall percentage (capped at 100) */
  percentage: number;
  /** Conversation segment percentage for stacked bar */
  convPercentage: number;
  /** Tool schema segment percentage for stacked bar */
  toolPercentage: number;
  /** Output reservation segment percentage for stacked bar */
  outputPercentage: number;
}

/**
 * Compute context usage for display in the ContextPanel.
 *
 * Returns null when there's no meaningful data to display (no context window,
 * or no conversation/tool tokens at all).
 */
export function computeContextUsage(input: ContextUsageInput): ContextUsageResult | null {
  const {
    contextWindow,
    toolSchemaTokens,
    maxOutputTokens,
    currentInputTokens,
    lastMessageInputTokens,
  } = input;

  if (!contextWindow) return null;

  // Prefer live currentInputTokens (updated by _onPayload during tool loop)
  // Fall back to last message's tokenUsage.input for initial display
  let conversationTokens = currentInputTokens;
  if (conversationTokens === 0) {
    conversationTokens = lastMessageInputTokens;
  }

  if (conversationTokens === 0 && toolSchemaTokens === 0) return null;

  // Effective usage = conversation tokens + tool schemas + output reservation
  const effectiveUsed = conversationTokens + toolSchemaTokens + maxOutputTokens;
  const percentage = Math.min((effectiveUsed / contextWindow) * 100, 100);

  // Individual segment percentages for the stacked bar
  const convPercentage = Math.min((conversationTokens / contextWindow) * 100, 100);
  const toolPercentage = Math.min((toolSchemaTokens / contextWindow) * 100, 100 - convPercentage);
  const outputPercentage = Math.min(
    (maxOutputTokens / contextWindow) * 100,
    100 - convPercentage - toolPercentage
  );

  return {
    conversation: conversationTokens,
    toolSchemaTokens,
    maxOutputTokens,
    effectiveUsed,
    total: contextWindow,
    percentage,
    convPercentage,
    toolPercentage,
    outputPercentage,
  };
}
