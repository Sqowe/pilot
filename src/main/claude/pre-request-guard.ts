/**
 * @module main/claude/pre-request-guard
 *
 * Pre-request overflow guard: estimates total request size BEFORE sending to
 * the provider and determines whether compaction or prompt truncation is needed.
 *
 * Background: pi-coding-agent's built-in compaction only triggers AFTER a
 * successful response (using reported usage) or AFTER a 400 overflow error
 * (reactive recovery). This leaves a gap: if a single turn's content (large
 * tool result, long user prompt, cold-start history injection) pushes the
 * context past the limit in one jump, the API call fails before compaction
 * can fire.
 *
 * This module closes that gap by estimating the request size proactively and
 * forcing compaction or truncation before the request is sent.
 */

import { estimateToolSchemaTokens, type ToolLike } from './compaction-budget';

// ---------------------------------------------------------------------------
// Custom error for guard abort — used for structured error detection instead
// of brittle message-substring matching.
// ---------------------------------------------------------------------------

/**
 * Thrown when the pre-request guard determines the request cannot fit within
 * the context window after all mitigation attempts. Callers should check
 * `instanceof GuardAbortError` rather than matching error message text.
 */
export class GuardAbortError extends Error {
  readonly code = 'GUARD_ABORT_CONTEXT_EXHAUSTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'GuardAbortError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreRequestEstimateInput {
  /** All messages currently in the agent's state (conversation history). */
  existingMessages: ReadonlyArray<{ role?: string; content?: unknown }>;
  /** The new prompt text about to be sent. */
  newPromptText: string;
  /** Model's context window in tokens. */
  contextWindow: number;
  /** Model's max output tokens (reserved for the response). */
  modelMaxOutput: number;
  /** Built-in tool definitions. */
  builtInTools: ReadonlyArray<ToolLike>;
  /** MCP custom tool definitions. */
  customTools: ReadonlyArray<ToolLike>;
  /** Safety margin (same as compaction-budget uses). */
  safetyMargin?: number;
  /** Number of images being sent with the current prompt turn. */
  imageCount?: number;
  /**
   * Token cost per image. Defaults to DEFAULT_IMAGE_TOKENS (2600).
   * Override for provider-specific estimates when image metadata is available.
   */
  imageTokensPerImage?: number;
  /**
   * Pre-computed tool schema token count. When provided, skips the expensive
   * tool schema estimation (which involves JSON.stringify on every tool's
   * parameters). Use this when calling estimatePreRequestSize multiple times
   * with the same tool set (e.g., during guard re-estimation passes).
   */
  precomputedToolSchemaTokens?: number;
}

export interface PreRequestEstimateResult {
  /** Estimated total tokens the request would consume (input + tools + output). */
  estimatedTotal: number;
  /** The provider's hard context window limit. */
  contextWindow: number;
  /** How many tokens over the limit (negative means within budget). */
  overflow: number;
  /** Whether the request would overflow the context window. */
  wouldOverflow: boolean;
  /** Breakdown for diagnostics. */
  breakdown: {
    existingMessagesTokens: number;
    newPromptTokens: number;
    imageTokens: number;
    toolSchemaTokens: number;
    modelMaxOutput: number;
    safetyMargin: number;
  };
}

export type GuardAction =
  | { type: 'proceed' }
  | { type: 'compact'; reason: string }
  | { type: 'truncate'; maxPromptChars: number; reason: string }
  | { type: 'abort'; reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SAFETY_MARGIN = 4000;
const DEFAULT_MODEL_MAX_OUTPUT = 16384;

/**
 * Conservative token estimate per image. Anthropic charges ~1600 tokens for a
 * standard 1024×1024 image, but larger/higher-res images can cost 2000–4000+.
 * OpenAI's vision models charge ~765 tokens for low-res and up to ~2900 for
 * high-res tiles. We use 2600 as a safe upper-bound default that prevents
 * underestimation for most real-world images without being excessively
 * pessimistic. This can be overridden via `imageTokensPerImage` in the input.
 */
export const DEFAULT_IMAGE_TOKENS = 2600;

/**
 * Minimum token volume in existing messages for compaction to be worthwhile.
 * Compaction summarizes history — if history is too small, the summarization
 * overhead exceeds the savings. We use a token-based threshold rather than
 * a pure message count to handle sessions with few but very large messages.
 */
const MIN_HISTORY_TOKENS_FOR_COMPACTION = 8000;

/**
 * Minimum message count as a secondary guard — even with enough tokens,
 * compaction needs at least a few messages to produce a meaningful summary.
 */
const MIN_MESSAGES_FOR_COMPACTION = 2;

/**
 * After compaction, we expect at least this fraction of the context to be freed.
 * If compaction wouldn't free enough, we fall through to truncation.
 */
const COMPACTION_EXPECTED_SAVINGS_RATIO = 0.4;

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a message using chars/4 heuristic.
 * Mirrors pi-coding-agent's own estimateTokens but works on the raw
 * message shape available from piSession.messages.
 *
 * Handles all observed content shapes:
 *   - string (plain text content)
 *   - array of blocks (standard multi-block format)
 *   - single object (some SDK/message formats use a single block without array wrapper)
 *   - null/undefined (empty message)
 */
function estimateMessageTokens(message: { role?: string; content?: unknown }): number {
  let chars = 0;

  const content = message.content;
  if (content == null) {
    return 0;
  } else if (typeof content === 'string') {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      chars += estimateContentBlockChars(block);
    }
  } else if (typeof content === 'object') {
    // Single object block (not wrapped in array) — handle the same way as
    // an array element. This covers SDK formats that pass content as a single
    // block object rather than an array.
    chars = estimateContentBlockChars(content);
  } else {
    // Unknown primitive type — conservative fallback
    chars = String(content).length;
  }

  return Math.ceil(chars / 4);
}

/**
 * Estimate character count for a single content block.
 * Extracted to handle both array elements and standalone object content.
 */
function estimateContentBlockChars(block: unknown): number {
  if (typeof block === 'string') {
    return block.length;
  }
  if (!block || typeof block !== 'object') {
    return 100; // conservative fallback for unexpected primitives
  }

  const b = block as Record<string, unknown>;

  if (b.type === 'text' && typeof b.text === 'string') {
    return (b.text as string).length;
  }
  if (b.type === 'thinking' && typeof b.thinking === 'string') {
    return (b.thinking as string).length;
  }
  if (b.type === 'toolCall') {
    let c = typeof b.name === 'string' ? b.name.length : 0;
    try {
      c += JSON.stringify(b.arguments ?? {}).length;
    } catch {
      // skip unserializable
    }
    return c;
  }
  if (b.type === 'image') {
    return DEFAULT_IMAGE_TOKENS * 4; // chars equivalent for the default token estimate
  }

  // Unknown block type — try to estimate via known text-bearing fields first,
  // then fall back to JSON.stringify for conservative estimation.
  if (typeof b.text === 'string') {
    return (b.text as string).length;
  }
  if (typeof b.thinking === 'string') {
    return (b.thinking as string).length;
  }
  if (typeof b.content === 'string') {
    return (b.content as string).length;
  }
  if (typeof b.summary === 'string') {
    return (b.summary as string).length;
  }

  // Final fallback: stringify the entire block
  try {
    return JSON.stringify(b).length;
  } catch {
    return 200; // conservative fallback for unserializable objects
  }
}

/**
 * Estimate the total request size before sending to the provider.
 *
 * Image token estimate defaults to DEFAULT_IMAGE_TOKENS (2600) — a safe
 * upper-bound covering most real-world images across providers. Override
 * via `imageTokensPerImage` when provider-specific metadata is available.
 */
export function estimatePreRequestSize(input: PreRequestEstimateInput): PreRequestEstimateResult {
  const contextWindow = input.contextWindow ?? 128000;
  const modelMaxOutput = input.modelMaxOutput ?? DEFAULT_MODEL_MAX_OUTPUT;
  const safetyMargin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN;

  // Validate: non-positive values indicate misconfiguration
  if (contextWindow <= 0) {
    throw new Error(
      `[pre-request-guard] Invalid contextWindow: ${input.contextWindow}. Must be a positive number.`
    );
  }
  if (modelMaxOutput < 0) {
    throw new Error(
      `[pre-request-guard] Invalid modelMaxOutput: ${input.modelMaxOutput}. Must be non-negative.`
    );
  }

  // Estimate existing conversation tokens
  let existingMessagesTokens = 0;
  for (const msg of input.existingMessages) {
    existingMessagesTokens += estimateMessageTokens(msg);
  }

  // Estimate new prompt tokens
  const newPromptTokens = Math.ceil(input.newPromptText.length / 4);

  // Estimate image tokens for the current turn
  const tokensPerImage = input.imageTokensPerImage ?? DEFAULT_IMAGE_TOKENS;
  const imageTokens = (input.imageCount ?? 0) * tokensPerImage;

  // Estimate tool schema tokens (use precomputed value when available to avoid
  // repeated JSON.stringify on every tool's parameters during re-estimation passes)
  const toolSchemaTokens =
    input.precomputedToolSchemaTokens ??
    estimateToolSchemaTokens(input.builtInTools, input.customTools);

  // Total estimated request size
  const estimatedTotal =
    existingMessagesTokens +
    newPromptTokens +
    imageTokens +
    toolSchemaTokens +
    modelMaxOutput +
    safetyMargin;

  const overflow = estimatedTotal - contextWindow;

  return {
    estimatedTotal,
    contextWindow,
    overflow,
    wouldOverflow: overflow > 0,
    breakdown: {
      existingMessagesTokens,
      newPromptTokens,
      imageTokens,
      toolSchemaTokens,
      modelMaxOutput,
      safetyMargin,
    },
  };
}

// ---------------------------------------------------------------------------
// Guard decision
// ---------------------------------------------------------------------------

/**
 * Determine what action to take based on the pre-request size estimate.
 *
 * Decision tree:
 *   1. If within budget → proceed
 *   2. If over budget AND enough messages to compact AND compaction can
 *      recover enough → compact
 *   3. If over budget AND compaction won't help → truncate the prompt
 *
 * Invariant: the chosen action, when executed correctly, MUST bring the
 * estimated total within the context window. The caller should re-estimate
 * after executing the action and assert non-overflow before proceeding.
 */
export function determineGuardAction(
  estimate: PreRequestEstimateResult,
  messageCount: number
): GuardAction {
  if (!estimate.wouldOverflow) {
    return { type: 'proceed' };
  }

  // Check if compaction would help. Eligibility is based on BOTH:
  //   1. Token volume: history must have enough tokens to make summarization
  //      worthwhile (handles sessions with few but very large messages)
  //   2. Message count: need at least a couple messages for a meaningful summary
  //   3. Expected savings must exceed the overflow
  const historyTokens = estimate.breakdown.existingMessagesTokens;
  const expectedSavings = Math.floor(historyTokens * COMPACTION_EXPECTED_SAVINGS_RATIO);
  const compactionEligible =
    messageCount >= MIN_MESSAGES_FOR_COMPACTION &&
    historyTokens >= MIN_HISTORY_TOKENS_FOR_COMPACTION &&
    expectedSavings > estimate.overflow;

  if (compactionEligible) {
    return {
      type: 'compact',
      reason:
        `Pre-request overflow detected: estimated ${estimate.estimatedTotal} tokens ` +
        `exceeds ${estimate.contextWindow} window by ${estimate.overflow}. ` +
        `Forcing compaction (${messageCount} messages, ${historyTokens} history tokens, ` +
        `~${expectedSavings} tokens recoverable).`,
    };
  }

  // Compaction won't help enough — truncate the prompt to fit.
  // Use ACTUAL current history tokens (no compaction assumption since we're
  // not running compaction in this path).
  const maxPromptChars = computeTruncationLimit(estimate, historyTokens);

  if (maxPromptChars <= 0) {
    return {
      type: 'abort',
      reason:
        `Pre-request overflow detected: estimated ${estimate.estimatedTotal} tokens ` +
        `exceeds ${estimate.contextWindow} window by ${estimate.overflow}. ` +
        `No prompt budget remains after fixed costs (tools: ${estimate.breakdown.toolSchemaTokens}, ` +
        `output: ${estimate.breakdown.modelMaxOutput}, safety: ${estimate.breakdown.safetyMargin}, ` +
        `history: ${historyTokens}). Disable unused MCP servers or lower maxTokens.`,
    };
  }

  return {
    type: 'truncate',
    maxPromptChars,
    reason:
      `Pre-request overflow detected: estimated ${estimate.estimatedTotal} tokens ` +
      `exceeds ${estimate.contextWindow} window by ${estimate.overflow}. ` +
      `Compaction insufficient (${messageCount} messages, ~${expectedSavings} tokens recoverable ` +
      `vs ${estimate.overflow} overflow). Truncating prompt to ${maxPromptChars} chars.`,
  };
}

/**
 * Compute the maximum prompt character length that would fit within the
 * context window given fixed costs and retained history.
 *
 * Returns 0 when the window is entirely consumed by fixed costs + history
 * (the session is effectively unusable without removing tools or history).
 */
export function computeTruncationLimit(
  estimate: PreRequestEstimateResult,
  effectiveHistoryTokens: number
): number {
  const fixedCost =
    estimate.breakdown.toolSchemaTokens +
    estimate.breakdown.imageTokens +
    estimate.breakdown.modelMaxOutput +
    estimate.breakdown.safetyMargin;

  const availableForPromptTokens = estimate.contextWindow - fixedCost - effectiveHistoryTokens;

  // No unconditional minimum — if the budget is zero or negative, the session
  // cannot fit any prompt. Returning 0 signals the caller to fail fast with a
  // clear error rather than silently sending an oversized request.
  if (availableForPromptTokens <= 0) {
    return 0;
  }

  return availableForPromptTokens * 4;
}

/**
 * Truncate a prompt string to fit within the given character limit.
 *
 * Uses a head+tail strategy: preserves the END of the prompt (where the
 * user's latest request typically resides) and truncates the MIDDLE (older
 * contextual prefix like conversation history injection). This ensures the
 * model always sees the actual user intent.
 *
 * Layout: [head prefix (small)] + [truncation notice] + [tail with user request]
 *
 * If maxChars is 0 or negative, returns an empty string. The caller is
 * responsible for detecting this case and aborting the request (see the
 * `abort` guard action type).
 */
export function truncatePrompt(prompt: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }

  if (prompt.length <= maxChars) {
    return prompt;
  }

  const truncationNotice = '\n\n[... middle content truncated to fit context window ...]\n\n';
  const availableChars = maxChars - truncationNotice.length;

  if (availableChars <= 0) {
    // Not enough room for both head and tail — just keep the tail (user request)
    return prompt.substring(prompt.length - maxChars);
  }

  // Allocate: 20% to head (contextual prefix), 80% to tail (user's latest request)
  const tailBudget = Math.floor(availableChars * 0.8);
  const headBudget = availableChars - tailBudget;

  const head = prompt.substring(0, headBudget);
  const tail = prompt.substring(prompt.length - tailBudget);

  return head + truncationNotice + tail;
}
