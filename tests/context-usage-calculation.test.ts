/**
 * Tests for the context usage calculation logic.
 * Imports the production function directly to prevent test/implementation drift.
 */
import { describe, it, expect } from 'vitest';
import { computeContextUsage, findLastTokenUsage } from '../src/renderer/utils/context-usage';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeContextUsage', () => {
  it('returns null when contextWindow is 0', () => {
    const result = computeContextUsage({
      contextWindow: 0,
      toolSchemaTokens: 1000,
      maxOutputTokens: 4096,
      currentInputTokens: 5000,
      lastMessageInputTokens: 0,
    });
    expect(result).toBeNull();
  });

  it('returns null when both currentInputTokens and lastMessageInputTokens are 0 and no tools', () => {
    const result = computeContextUsage({
      contextWindow: 128000,
      toolSchemaTokens: 0,
      maxOutputTokens: 0,
      currentInputTokens: 0,
      lastMessageInputTokens: 0,
    });
    expect(result).toBeNull();
  });

  it('shows usage even when conversation is 0 but tools are present', () => {
    const result = computeContextUsage({
      contextWindow: 128000,
      toolSchemaTokens: 40000,
      maxOutputTokens: 16384,
      currentInputTokens: 0,
      lastMessageInputTokens: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.percentage).toBeGreaterThan(0);
  });

  it('prefers currentInputTokens over lastMessageInputTokens', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 150000,
      lastMessageInputTokens: 6800,
    });
    expect(result!.conversation).toBe(150000);
  });

  it('falls back to lastMessageInputTokens when currentInputTokens is 0', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 0,
      lastMessageInputTokens: 6800,
    });
    expect(result!.conversation).toBe(6800);
  });

  it('computes effective usage as sum of all three components', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 150000,
      lastMessageInputTokens: 0,
    });
    expect(result!.effectiveUsed).toBe(150000 + 40000 + 32000);
  });

  it('caps percentage at 100%', () => {
    const result = computeContextUsage({
      contextWindow: 100000,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 80000,
      lastMessageInputTokens: 0,
    });
    expect(result!.percentage).toBe(100);
  });

  it('segment percentages sum to at most 100%', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 150000,
      lastMessageInputTokens: 0,
    });
    const sum = result!.convPercentage + result!.toolPercentage + result!.outputPercentage;
    expect(sum).toBeLessThanOrEqual(100);
  });

  it('segment percentages are non-negative', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 150000,
      lastMessageInputTokens: 0,
    });
    expect(result!.convPercentage).toBeGreaterThanOrEqual(0);
    expect(result!.toolPercentage).toBeGreaterThanOrEqual(0);
    expect(result!.outputPercentage).toBeGreaterThanOrEqual(0);
  });
});

describe('warning/critical thresholds', () => {
  it('normal state: total percentage ≤ 50%', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 20000,
      lastMessageInputTokens: 0,
    });
    expect(result!.percentage).toBeLessThanOrEqual(50);
  });

  it('warning state: total percentage > 50%', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 80000,
      lastMessageInputTokens: 0,
    });
    expect(result!.percentage).toBeGreaterThan(50);
    expect(result!.percentage).toBeLessThanOrEqual(75);
  });

  it('critical state: total percentage > 75%', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 150000,
      lastMessageInputTokens: 0,
    });
    expect(result!.percentage).toBeGreaterThan(75);
  });
});

describe('stale value prevention', () => {
  it('when currentInputTokens updates, it overrides stale lastMessageInputTokens', () => {
    const stale = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 0,
      lastMessageInputTokens: 6800,
    });
    const live = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 150000,
      lastMessageInputTokens: 6800,
    });
    expect(live!.conversation).toBe(150000);
    expect(live!.percentage).toBeGreaterThan(stale!.percentage);
  });

  it('resetting currentInputTokens to 0 falls back to lastMessageInputTokens', () => {
    const result = computeContextUsage({
      contextWindow: 262144,
      toolSchemaTokens: 40000,
      maxOutputTokens: 32000,
      currentInputTokens: 0,
      lastMessageInputTokens: 6800,
    });
    expect(result!.conversation).toBe(6800);
  });
});

describe('edge cases', () => {
  it('handles very small context window (8K model)', () => {
    const result = computeContextUsage({
      contextWindow: 8192,
      toolSchemaTokens: 2000,
      maxOutputTokens: 2048,
      currentInputTokens: 3000,
      lastMessageInputTokens: 0,
    });
    expect(result!.percentage).toBeGreaterThan(75);
  });

  it('handles zero tool schema tokens', () => {
    const result = computeContextUsage({
      contextWindow: 128000,
      toolSchemaTokens: 0,
      maxOutputTokens: 16384,
      currentInputTokens: 50000,
      lastMessageInputTokens: 0,
    });
    expect(result!.toolPercentage).toBe(0);
    expect(result!.toolSchemaTokens).toBe(0);
  });

  it('handles zero maxOutputTokens', () => {
    const result = computeContextUsage({
      contextWindow: 128000,
      toolSchemaTokens: 40000,
      maxOutputTokens: 0,
      currentInputTokens: 50000,
      lastMessageInputTokens: 0,
    });
    expect(result!.outputPercentage).toBe(0);
    expect(result!.maxOutputTokens).toBe(0);
  });
});

describe('findLastTokenUsage', () => {
  it('returns undefined for an empty message array', () => {
    expect(findLastTokenUsage([])).toBeUndefined();
  });

  it('returns undefined when no messages have tokenUsage', () => {
    expect(findLastTokenUsage([{ tokenUsage: undefined }, {}])).toBeUndefined();
  });

  it('returns the tokenUsage from the only message that has it', () => {
    const usage = { input: 100, output: 50 };
    expect(findLastTokenUsage([{ tokenUsage: usage }])).toBe(usage);
  });

  it('returns the last tokenUsage when multiple messages have it', () => {
    const first = { input: 100, output: 50 };
    const last = { input: 200, output: 80 };
    expect(
      findLastTokenUsage([{ tokenUsage: first }, { tokenUsage: undefined }, { tokenUsage: last }])
    ).toBe(last);
  });

  it('does not skip tokenUsage with input === 0 (presence check, not truthy)', () => {
    // A truthy check on input would incorrectly skip this entry and fall through
    // to an earlier message. The fix uses typeof tu.input === 'number' instead.
    const zeroInput = { input: 0, output: 0, cacheRead: 500 };
    const earlier = { input: 5000, output: 200 };
    expect(findLastTokenUsage([{ tokenUsage: earlier }, { tokenUsage: zeroInput }])).toBe(
      zeroInput
    );
  });

  it('scans backwards past trailing messages without tokenUsage', () => {
    const usage = { input: 100, output: 50 };
    const result = findLastTokenUsage([{ tokenUsage: usage }, { tokenUsage: undefined }]);
    expect(result).toBe(usage);
  });

  it('skips non-assistant messages when role is present', () => {
    const userUsage = { input: 200, output: 0 };
    const assistantUsage = { input: 500, output: 100 };
    const result = findLastTokenUsage([
      { role: 'assistant', tokenUsage: assistantUsage },
      { role: 'user', tokenUsage: userUsage },
    ]);
    // user message comes last but should be skipped; assistant should be returned
    expect(result).toBe(assistantUsage);
  });

  it('returns tokenUsage from messages without a role field (role-agnostic fallback)', () => {
    // When role is absent, the message is not skipped — backwards compat.
    const usage = { input: 100, output: 50 };
    expect(findLastTokenUsage([{ tokenUsage: usage }])).toBe(usage);
  });
});
