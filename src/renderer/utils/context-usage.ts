/**
 * @module renderer/utils/context-usage
 *
 * Pure computation for context usage display. Used by ContextPanel and tests.
 */
import type { TokenUsage } from '../../shared/token-usage';

/**
 * Find the tokenUsage from the latest message that has one.
 *
 * Accepts messages with an optional `role` field; when role information is
 * available, only messages with role 'assistant' are considered so that
 * system or user messages with tokenUsage cannot pollute the CH% chip or
 * the context-usage fallback.
 *
 * Uses a presence check (typeof number) rather than a truthy check so that
 * input=0 is not incorrectly skipped.
 */
export function findLastTokenUsage(
  messages: ReadonlyArray<{ tokenUsage?: TokenUsage; role?: string }>
): TokenUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // Skip non-assistant messages when role information is present
    if (msg.role !== undefined && msg.role !== 'assistant') continue;
    const tu = msg.tokenUsage;
    if (tu && typeof tu.input === 'number') return tu;
  }
  return undefined;
}

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
 * Compute the prompt-cache hit rate as a percentage (0–100), rounded to the
 * nearest integer.
 *
 * **Provider semantics assumed:** `input` is the total input token count
 * (cached + non-cached combined), and `cacheRead` is a subset of `input`.
 * This matches Anthropic's usage reporting. Providers that define `input` as
 * non-cached tokens only (i.e., `total = input + cacheRead`) will produce
 * a misleading result — add a provider-specific normalization step before
 * calling this function if that is the case.
 *
 * Formula: cacheRead / (cacheRead + nonCachedInput) * 100
 * where nonCachedInput = max(0, input - cacheRead).
 *
 * Returns null when there is no meaningful cache data (both fields zero/absent).
 * Returns 0 when input is positive but cacheRead is zero (cache miss).
 */
export function computeCacheHitRate({
  cacheRead,
  input,
}: {
  cacheRead: number;
  input: number;
}): number | null {
  if (cacheRead === 0 && input === 0) return null;
  const nonCachedInput = Math.max(0, input - cacheRead);
  const denominator = cacheRead + nonCachedInput;
  if (denominator === 0) return null;
  return Math.round((cacheRead / denominator) * 100);
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
