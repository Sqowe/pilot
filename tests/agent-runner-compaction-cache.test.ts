/**
 * Tests for token-usage-utils helpers introduced by the pi-sdk-0.80 T1 features:
 *
 * - formatTokenCount: compact human-readable token display used in the
 *   compaction_end trace step title ("~12.4k tokens").
 * - normalizeTokenUsage: widens the usage normalizer to thread
 *   cacheRead/cacheWrite through to the renderer for the CH% chip.
 */
import { describe, it, expect } from 'vitest';

import { formatTokenCount, normalizeTokenUsage } from '../src/main/claude/token-usage-utils';

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

describe('formatTokenCount', () => {
  it('returns raw number as string when below 1000', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats 1000 as "1k"', () => {
    expect(formatTokenCount(1000)).toBe('1k');
  });

  it('formats with one decimal place when fractional part is non-zero', () => {
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(12400)).toBe('12.4k');
  });

  it('suppresses trailing .0 decimal', () => {
    expect(formatTokenCount(5000)).toBe('5k');
    expect(formatTokenCount(100000)).toBe('100k');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
    expect(formatTokenCount(2_000_000)).toBe('2M');
  });

  it('rounds the fractional part correctly', () => {
    // 1234 / 1000 = 1.234 → toFixed(1) = "1.2"
    expect(formatTokenCount(1234)).toBe('1.2k');
    // 10000 / 1000 = 10.0 → stripped → "10k"
    expect(formatTokenCount(10000)).toBe('10k');
  });
});

// ---------------------------------------------------------------------------
// normalizeTokenUsage — cache fields
// ---------------------------------------------------------------------------

describe('normalizeTokenUsage — cache fields', () => {
  it('returns undefined for null/non-object input', () => {
    expect(normalizeTokenUsage(null)).toBeUndefined();
    expect(normalizeTokenUsage(42)).toBeUndefined();
    expect(normalizeTokenUsage('usage')).toBeUndefined();
  });

  it('returns undefined when input/output are not numbers', () => {
    expect(normalizeTokenUsage({ input: 'x', output: 2 })).toBeUndefined();
  });

  it('returns {input, output} without cache fields when they are absent', () => {
    const result = normalizeTokenUsage({ input: 100, output: 50 });
    expect(result).toEqual({ input: 100, output: 50 });
    expect(result).not.toHaveProperty('cacheRead');
    expect(result).not.toHaveProperty('cacheWrite');
  });

  it('includes cacheRead when present as a number', () => {
    const result = normalizeTokenUsage({ input: 1000, output: 200, cacheRead: 800 });
    expect(result?.cacheRead).toBe(800);
    expect(result?.cacheWrite).toBeUndefined();
  });

  it('includes cacheWrite when present as a number', () => {
    const result = normalizeTokenUsage({ input: 1000, output: 200, cacheWrite: 1000 });
    expect(result?.cacheWrite).toBe(1000);
    expect(result?.cacheRead).toBeUndefined();
  });

  it('includes both cacheRead and cacheWrite when both are present', () => {
    const result = normalizeTokenUsage({
      input: 1000,
      output: 200,
      cacheRead: 800,
      cacheWrite: 1000,
    });
    expect(result).toEqual({ input: 1000, output: 200, cacheRead: 800, cacheWrite: 1000 });
  });

  it('omits cacheRead when it is not a number (e.g. provider returned a string)', () => {
    const result = normalizeTokenUsage({ input: 100, output: 50, cacheRead: 'yes' });
    expect(result).not.toHaveProperty('cacheRead');
  });

  it('handles alternative input/output key shapes alongside cache fields', () => {
    const result = normalizeTokenUsage({
      input_tokens: 500,
      output_tokens: 100,
      cacheRead: 400,
      cacheWrite: 500,
    });
    expect(result?.input).toBe(500);
    expect(result?.output).toBe(100);
    expect(result?.cacheRead).toBe(400);
    expect(result?.cacheWrite).toBe(500);
  });

  it('gracefully handles 0 values for cache fields', () => {
    const result = normalizeTokenUsage({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
    expect(result?.cacheRead).toBe(0);
    expect(result?.cacheWrite).toBe(0);
  });

  it('normalizes snake_case cache_read / cache_write variants', () => {
    const result = normalizeTokenUsage({
      input: 100,
      output: 50,
      cache_read: 80,
      cache_write: 100,
    });
    expect(result?.cacheRead).toBe(80);
    expect(result?.cacheWrite).toBe(100);
  });

  it('normalizes cache_read_tokens / cache_write_tokens variants', () => {
    const result = normalizeTokenUsage({
      input: 100,
      output: 50,
      cache_read_tokens: 80,
      cache_write_tokens: 100,
    });
    expect(result?.cacheRead).toBe(80);
    expect(result?.cacheWrite).toBe(100);
  });

  it('normalizes prompt_cache_read_tokens / prompt_cache_write_tokens variants', () => {
    const result = normalizeTokenUsage({
      input: 100,
      output: 50,
      prompt_cache_read_tokens: 80,
      prompt_cache_write_tokens: 100,
    });
    expect(result?.cacheRead).toBe(80);
    expect(result?.cacheWrite).toBe(100);
  });

  it('prefers cacheRead over snake_case variants when both are present', () => {
    // camelCase takes precedence via ?? chain order
    const result = normalizeTokenUsage({
      input: 100,
      output: 50,
      cacheRead: 200,
      cache_read: 80,
    });
    expect(result?.cacheRead).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// compaction_end title formatting (indirect — via formatTokenCount)
// ---------------------------------------------------------------------------

describe('compaction_end title token suffix formatting', () => {
  // The handler builds: `Context compaction completed (~${formatTokenCount(n)} tokens)`
  // Test the suffix construction directly using the exported helper.

  it('produces the expected suffix for a typical post-compaction estimate', () => {
    const estimate = 12400;
    const suffix = ` (~${formatTokenCount(estimate)} tokens)`;
    expect(suffix).toBe(' (~12.4k tokens)');
  });

  it('produces no suffix when estimatedTokensAfter is absent (graceful omission)', () => {
    const estimatedTokensAfter: number | undefined = undefined;
    const tokenSuffix =
      typeof estimatedTokensAfter === 'number'
        ? ` (~${formatTokenCount(estimatedTokensAfter)} tokens)`
        : '';
    expect(tokenSuffix).toBe('');
  });

  it('handles sub-1k estimates correctly', () => {
    expect(` (~${formatTokenCount(850)} tokens)`).toBe(' (~850 tokens)');
  });
});

describe('formatTokenCount — edge cases', () => {
  it('avoids "1000k" boundary artifact near 1M', () => {
    // 999950 / 1000 = 999.95 → toFixed(1) = "1000.0" → should display as "1M" not "1000k"
    expect(formatTokenCount(999_950)).toBe('1M');
    expect(formatTokenCount(999_949)).toBe('999.9k');
  });

  it('returns "0" for NaN', () => {
    expect(formatTokenCount(NaN)).toBe('0');
  });

  it('returns "0" for Infinity', () => {
    expect(formatTokenCount(Infinity)).toBe('0');
  });

  it('returns "0" for negative numbers', () => {
    expect(formatTokenCount(-100)).toBe('0');
  });
});
