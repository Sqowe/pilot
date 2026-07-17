/**
 * @module main/claude/token-usage-utils
 *
 * Pure token-usage helpers shared by agent-runner and tests.
 * Kept in a dedicated module so tests can import them without pulling in
 * the full agent-runner dependency tree.
 */
import type { TokenUsage } from '../../shared/token-usage';

/**
 * Format a token count as a compact human-readable string.
 * Examples: 850 → "850", 1000 → "1k", 12400 → "12.4k", 100000 → "100k", 1500000 → "1.5M"
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) {
    const formatted = (n / 1000).toFixed(1).replace(/\.0$/, '');
    // Guard against rounding artifacts: e.g. 999950 → toFixed(1) = "1000.0" → "1000k"
    // Detect this by checking if the numeric result has reached 1000 and upgrade to M.
    if (parseFloat(formatted) >= 1000) return '1M';
    return `${formatted}k`;
  }
  return String(n);
}

/**
 * Normalize a raw provider usage object into the app's TokenUsage shape.
 *
 * Handles the three key-naming variants seen across providers:
 *   input / input_tokens / inputTokens
 *   output / output_tokens / outputTokens
 *
 * Optionally threads cacheRead / cacheWrite when the provider reports them.
 * Fields are included only when actually present as numbers — absent fields
 * are omitted rather than defaulted to 0, so the renderer can distinguish
 * "provider reported 0" from "provider did not report".
 */
export function normalizeTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const raw = usage as {
    input?: unknown;
    output?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    // Prompt-cache field name variants across providers
    cacheRead?: unknown;
    cache_read?: unknown;
    cache_read_tokens?: unknown;
    cacheReadTokens?: unknown;
    prompt_cache_read_tokens?: unknown;
    cacheWrite?: unknown;
    cache_write?: unknown;
    cache_write_tokens?: unknown;
    cacheWriteTokens?: unknown;
    prompt_cache_write_tokens?: unknown;
  };

  const input = raw.input ?? raw.input_tokens ?? raw.inputTokens;
  const output = raw.output ?? raw.output_tokens ?? raw.outputTokens;

  if (typeof input !== 'number' || typeof output !== 'number') {
    return undefined;
  }

  const rawCacheRead =
    raw.cacheRead ??
    raw.cache_read ??
    raw.cache_read_tokens ??
    raw.cacheReadTokens ??
    raw.prompt_cache_read_tokens;
  const rawCacheWrite =
    raw.cacheWrite ??
    raw.cache_write ??
    raw.cache_write_tokens ??
    raw.cacheWriteTokens ??
    raw.prompt_cache_write_tokens;

  const result: TokenUsage = { input, output };
  if (typeof rawCacheRead === 'number') result.cacheRead = rawCacheRead;
  if (typeof rawCacheWrite === 'number') result.cacheWrite = rawCacheWrite;
  return result;
}
