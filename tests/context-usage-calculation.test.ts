/**
 * Tests for the context usage calculation logic.
 * Imports the production function directly to prevent test/implementation drift.
 */
import { describe, it, expect } from 'vitest';
import { computeContextUsage } from '../src/renderer/utils/context-usage';

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
