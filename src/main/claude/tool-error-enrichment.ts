/**
 * Tool Error Enrichment Utilities
 *
 * Pure functions for enriching tool error messages with thinking context
 * when a tool call fails with empty arguments (a known issue where the
 * model's output is truncated but thinking contains the intended action).
 *
 * Event ordering guarantee (from pi-agent-core/agent-loop.js):
 *   message_start → message_update (thinking_delta, toolcall_delta, ...) →
 *   message_end → tool_execution_start → tool_execution_end
 *
 * This means `lastAssistantThinking` is always finalized at `message_end`
 * BEFORE `tool_execution_end` fires. No race condition is possible.
 *
 * Privacy note: The enrichment appends the same thinking content that is
 * already streamed to the UI via `stream.thinking` events. It does not
 * expose additional model reasoning beyond what the user already sees.
 */

/** Pattern matching empty tool call arguments in validation error output. */
const EMPTY_ARGS_PATTERN = /Received arguments:\s*\{\s*\}/;

/**
 * Enrich a tool error message with thinking context when the tool call
 * failed due to empty arguments. This helps the user understand what
 * the model was trying to do despite the malformed tool call.
 *
 * @param outputText - The original tool error text
 * @param isError - Whether the tool execution was an error
 * @param lastAssistantThinking - The model's thinking from the same turn
 * @returns The enriched (or unchanged) error text
 */
export function enrichToolErrorWithThinking(
  outputText: string,
  isError: boolean,
  lastAssistantThinking: string
): string {
  if (!isError || !lastAssistantThinking || !EMPTY_ARGS_PATTERN.test(outputText)) {
    return outputText;
  }

  const thinkingSummary =
    lastAssistantThinking.length > 500
      ? lastAssistantThinking.slice(0, 500) + '…'
      : lastAssistantThinking;

  return (
    outputText +
    '\n\n--- Model thinking context (tool args were empty but thinking shows intent) ---\n' +
    thinkingSummary
  );
}

/**
 * Select the most complete thinking source between streaming deltas
 * (which capture the full unmodified thinking) and effectiveContent
 * (which may be summarized by adaptive thinking display mode).
 *
 * @param accumulatedDeltas - Thinking accumulated from thinking_delta stream events
 * @param thinkingFromContent - Thinking extracted from message_end effectiveContent
 * @returns The longer (more complete) source, or empty string if both are empty
 */
export function selectThinkingSource(
  accumulatedDeltas: string,
  thinkingFromContent: string
): string {
  return accumulatedDeltas.length >= thinkingFromContent.length
    ? accumulatedDeltas
    : thinkingFromContent;
}
