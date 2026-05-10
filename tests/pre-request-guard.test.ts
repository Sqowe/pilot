import { describe, it, expect } from 'vitest';
import {
  estimatePreRequestSize,
  determineGuardAction,
  truncatePrompt,
  computeTruncationLimit,
  GuardAbortError,
  type PreRequestEstimateInput,
  type PreRequestEstimateResult,
} from '../src/main/claude/pre-request-guard';

// ---------------------------------------------------------------------------
// estimatePreRequestSize
// ---------------------------------------------------------------------------
describe('estimatePreRequestSize', () => {
  const baseInput: PreRequestEstimateInput = {
    existingMessages: [],
    newPromptText: '',
    contextWindow: 128000,
    modelMaxOutput: 16384,
    builtInTools: [],
    customTools: [],
    safetyMargin: 4000,
  };

  it('returns no overflow for empty session with small prompt', () => {
    const result = estimatePreRequestSize({
      ...baseInput,
      newPromptText: 'Hello',
    });
    expect(result.wouldOverflow).toBe(false);
    expect(result.overflow).toBeLessThan(0);
  });

  it('accounts for existing messages', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(40000) }, // ~10K tokens
      { role: 'assistant', content: 'b'.repeat(40000) }, // ~10K tokens
    ];
    const result = estimatePreRequestSize({
      ...baseInput,
      existingMessages: messages,
    });
    expect(result.breakdown.existingMessagesTokens).toBeGreaterThanOrEqual(20000);
  });

  it('accounts for new prompt text', () => {
    const result = estimatePreRequestSize({
      ...baseInput,
      newPromptText: 'x'.repeat(80000), // ~20K tokens
    });
    expect(result.breakdown.newPromptTokens).toBe(20000);
  });

  it('accounts for tool schemas', () => {
    const tools = [
      {
        name: 'tool1',
        description: 'A tool that does things',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
      },
      {
        name: 'tool2',
        description: 'Another tool',
        parameters: { type: 'object', properties: { b: { type: 'number' } } },
      },
    ];
    const result = estimatePreRequestSize({
      ...baseInput,
      builtInTools: tools,
    });
    expect(result.breakdown.toolSchemaTokens).toBeGreaterThan(0);
  });

  it('detects overflow when total exceeds context window', () => {
    const result = estimatePreRequestSize({
      ...baseInput,
      contextWindow: 50000,
      existingMessages: [
        { role: 'user', content: 'a'.repeat(100000) }, // ~25K tokens
        { role: 'assistant', content: 'b'.repeat(100000) }, // ~25K tokens
      ],
      newPromptText: 'c'.repeat(40000), // ~10K tokens
      // Total: ~25K + 25K + 10K + 16384 + 4000 = ~80K > 50K
    });
    expect(result.wouldOverflow).toBe(true);
    expect(result.overflow).toBeGreaterThan(0);
  });

  it('uses default values for undefined/null inputs', () => {
    const result = estimatePreRequestSize({
      existingMessages: [],
      newPromptText: 'test',
      contextWindow: undefined as unknown as number, // nullish → uses 128000 fallback
      modelMaxOutput: undefined as unknown as number, // nullish → uses 16384 fallback
      builtInTools: [],
      customTools: [],
    });
    // Both undefined values trigger the ?? fallback
    expect(result.contextWindow).toBe(128000);
    expect(result.breakdown.modelMaxOutput).toBe(16384);
    expect(result.breakdown.imageTokens).toBe(0);
  });

  it('respects explicit zero for modelMaxOutput (no output reservation)', () => {
    // modelMaxOutput=0 is valid (e.g., streaming with no output cap)
    const result = estimatePreRequestSize({
      ...baseInput,
      modelMaxOutput: 0,
      newPromptText: 'test',
    });
    expect(result.breakdown.modelMaxOutput).toBe(0);
  });

  it('throws on non-positive contextWindow', () => {
    expect(() =>
      estimatePreRequestSize({
        ...baseInput,
        contextWindow: 0,
        newPromptText: 'test',
      })
    ).toThrow('Invalid contextWindow');

    expect(() =>
      estimatePreRequestSize({
        ...baseInput,
        contextWindow: -1000,
        newPromptText: 'test',
      })
    ).toThrow('Invalid contextWindow');
  });

  it('throws on negative modelMaxOutput', () => {
    expect(() =>
      estimatePreRequestSize({
        ...baseInput,
        modelMaxOutput: -1,
        newPromptText: 'test',
      })
    ).toThrow('Invalid modelMaxOutput');
  });

  it('handles array content blocks in messages', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'text', text: 'More text here' },
        ],
      },
    ];
    const result = estimatePreRequestSize({
      ...baseInput,
      existingMessages: messages,
    });
    expect(result.breakdown.existingMessagesTokens).toBeGreaterThan(0);
  });

  it('handles image blocks conservatively', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      },
    ];
    const result = estimatePreRequestSize({
      ...baseInput,
      existingMessages: messages,
    });
    // Image should contribute ~2600 tokens (DEFAULT_IMAGE_TOKENS * 4 chars / 4)
    expect(result.breakdown.existingMessagesTokens).toBe(2600);
  });

  it('handles single object content (non-array block)', () => {
    // Some SDK formats pass content as a single object, not wrapped in array
    const messages = [
      {
        role: 'assistant',
        content: { type: 'text', text: 'Hello world response' },
      },
    ];
    const result = estimatePreRequestSize({
      ...baseInput,
      existingMessages: messages,
    });
    // 'Hello world response' = 20 chars → ceil(20/4) = 5 tokens
    expect(result.breakdown.existingMessagesTokens).toBe(5);
  });

  it('handles object content with unknown structure via stringify', () => {
    const messages = [
      {
        role: 'user',
        content: { customField: 'some data', nested: { value: 123 } },
      },
    ];
    const result = estimatePreRequestSize({
      ...baseInput,
      existingMessages: messages,
    });
    // Should not be 0 — the object should be stringified as fallback
    expect(result.breakdown.existingMessagesTokens).toBeGreaterThan(0);
  });

  it('handles null/undefined content gracefully', () => {
    const messages = [
      { role: 'user', content: null },
      { role: 'assistant', content: undefined },
      { role: 'user' }, // no content field at all
    ];
    const result = estimatePreRequestSize({
      ...baseInput,
      existingMessages: messages,
    });
    expect(result.breakdown.existingMessagesTokens).toBe(0);
  });

  it('uses precomputedToolSchemaTokens when provided', () => {
    const tools = [
      {
        name: 'tool1',
        description: 'A tool',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
      },
    ];
    const withoutPrecomputed = estimatePreRequestSize({
      ...baseInput,
      builtInTools: tools,
    });
    const withPrecomputed = estimatePreRequestSize({
      ...baseInput,
      builtInTools: tools,
      precomputedToolSchemaTokens: 999,
    });
    // Without precomputed: uses actual estimation
    expect(withoutPrecomputed.breakdown.toolSchemaTokens).toBeGreaterThan(0);
    expect(withoutPrecomputed.breakdown.toolSchemaTokens).not.toBe(999);
    // With precomputed: uses the provided value
    expect(withPrecomputed.breakdown.toolSchemaTokens).toBe(999);
  });

  it('accounts for current-turn images via imageCount', () => {
    const result = estimatePreRequestSize({
      ...baseInput,
      newPromptText: 'Describe this image',
      imageCount: 3,
    });
    // 3 images × 2600 tokens = 7800 tokens
    expect(result.breakdown.imageTokens).toBe(7800);
    // Total should include image tokens
    const expectedTotal =
      result.breakdown.existingMessagesTokens +
      result.breakdown.newPromptTokens +
      result.breakdown.imageTokens +
      result.breakdown.toolSchemaTokens +
      result.breakdown.modelMaxOutput +
      result.breakdown.safetyMargin;
    expect(result.estimatedTotal).toBe(expectedTotal);
  });

  it('images can push request over context window', () => {
    const result = estimatePreRequestSize({
      ...baseInput,
      contextWindow: 30000,
      newPromptText: 'x'.repeat(20000), // ~5K tokens
      imageCount: 10, // 10 × 2600 = 26K tokens
      // Total: 5K + 26K + 0 + 16384 + 4000 = ~51K > 30K
    });
    expect(result.wouldOverflow).toBe(true);
    expect(result.breakdown.imageTokens).toBe(26000);
  });
});

// ---------------------------------------------------------------------------
// determineGuardAction
// ---------------------------------------------------------------------------
describe('determineGuardAction', () => {
  it('returns proceed when no overflow', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 100000,
      contextWindow: 128000,
      overflow: -28000,
      wouldOverflow: false,
      breakdown: {
        existingMessagesTokens: 50000,
        newPromptTokens: 10000,
        imageTokens: 0,
        toolSchemaTokens: 20000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    const action = determineGuardAction(estimate, 20);
    expect(action.type).toBe('proceed');
  });

  it('returns compact when overflow is addressable by compaction', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 140000,
      contextWindow: 128000,
      overflow: 12000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 80000, // 40% = 32K savings, > 12K overflow
        newPromptTokens: 20000,
        imageTokens: 0,
        toolSchemaTokens: 20000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    const action = determineGuardAction(estimate, 20);
    expect(action.type).toBe('compact');
  });

  it('returns truncate when too few messages for compaction', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 140000,
      contextWindow: 128000,
      overflow: 12000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 80000,
        newPromptTokens: 20000,
        imageTokens: 0,
        toolSchemaTokens: 20000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    // Only 1 message — below MIN_MESSAGES_FOR_COMPACTION (2)
    const action = determineGuardAction(estimate, 1);
    expect(action.type).toBe('truncate');
  });

  it('returns compact for few messages with large token volume', () => {
    // Verifies token-based eligibility: 2 messages but 80K tokens is enough
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 140000,
      contextWindow: 128000,
      overflow: 12000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 80000, // 40% = 32K savings > 12K overflow
        newPromptTokens: 20000,
        imageTokens: 0,
        toolSchemaTokens: 20000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    // 2 messages with 80K tokens — eligible for compaction
    const action = determineGuardAction(estimate, 2);
    expect(action.type).toBe('compact');
  });

  it('returns truncate when history tokens below compaction threshold', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 140000,
      contextWindow: 128000,
      overflow: 12000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 5000, // below MIN_HISTORY_TOKENS_FOR_COMPACTION (8000)
        newPromptTokens: 95000,
        imageTokens: 0,
        toolSchemaTokens: 20000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    // Even with 20 messages, history tokens too low for compaction to help
    const action = determineGuardAction(estimate, 20);
    expect(action.type).toBe('truncate');
  });

  it('returns truncate when compaction savings insufficient', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 200000,
      contextWindow: 128000,
      overflow: 72000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 30000, // 40% = 12K savings, < 72K overflow
        newPromptTokens: 100000,
        imageTokens: 0,
        toolSchemaTokens: 30000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    const action = determineGuardAction(estimate, 20);
    expect(action.type).toBe('truncate');
    if (action.type === 'truncate') {
      expect(action.maxPromptChars).toBeGreaterThan(0);
    }
  });

  it('truncate uses actual history tokens (not compaction assumption)', () => {
    // This test verifies fix for review issue #1: truncate path must use
    // actual current history, not assume compaction reduced it to 20K.
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 200000,
      contextWindow: 128000,
      overflow: 72000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 60000, // large history but compaction won't help enough
        newPromptTokens: 80000,
        imageTokens: 0,
        toolSchemaTokens: 30000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    // 40% of 60K = 24K savings < 72K overflow → truncate
    const action = determineGuardAction(estimate, 20);
    expect(action.type).toBe('truncate');
    if (action.type === 'truncate') {
      // Available = 128000 - 30000 - 16384 - 4000 - 60000 = 17616 tokens = 70464 chars
      // NOT 128000 - 30000 - 16384 - 4000 - 20000 = 57616 tokens (wrong: assumes compaction)
      const expectedAvailable = 128000 - 30000 - 16384 - 4000 - 60000;
      expect(action.maxPromptChars).toBe(expectedAvailable * 4);
    }
  });

  it('returns abort when fixed costs exceed window (zero prompt budget)', () => {
    // When truncation limit would be 0, the guard returns abort instead
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 200000,
      contextWindow: 50000, // very small window
      overflow: 150000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 10000,
        newPromptTokens: 100000,
        imageTokens: 0,
        toolSchemaTokens: 40000, // tools alone nearly fill the window
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    const action = determineGuardAction(estimate, 2);
    // Available = 50000 - 40000 - 16384 - 4000 - 10000 = -20384 → abort
    expect(action.type).toBe('abort');
    if (action.type === 'abort') {
      expect(action.reason).toContain('No prompt budget remains');
    }
  });

  it('truncate action provides reasonable maxPromptChars for normal overflow', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 150000,
      contextWindow: 128000,
      overflow: 22000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 10000, // too small for compaction to help
        newPromptTokens: 80000,
        imageTokens: 0,
        toolSchemaTokens: 30000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    const action = determineGuardAction(estimate, 2);
    expect(action.type).toBe('truncate');
    if (action.type === 'truncate') {
      // maxPromptChars should be positive and less than original prompt size
      expect(action.maxPromptChars).toBeGreaterThan(0);
      expect(action.maxPromptChars).toBeLessThan(80000 * 4); // less than original
    }
  });

  it('post-truncation estimate fits within context window', () => {
    // Invariant test: after truncation, the resulting prompt should fit
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 150000,
      contextWindow: 128000,
      overflow: 22000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 10000,
        newPromptTokens: 80000,
        imageTokens: 0,
        toolSchemaTokens: 30000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    const action = determineGuardAction(estimate, 2);
    expect(action.type).toBe('truncate');
    if (action.type === 'truncate') {
      // Verify: truncated prompt tokens + fixed costs + history <= contextWindow
      const truncatedPromptTokens = Math.ceil(action.maxPromptChars / 4);
      const postTruncTotal =
        estimate.breakdown.existingMessagesTokens +
        truncatedPromptTokens +
        estimate.breakdown.imageTokens +
        estimate.breakdown.toolSchemaTokens +
        estimate.breakdown.modelMaxOutput +
        estimate.breakdown.safetyMargin;
      expect(postTruncTotal).toBeLessThanOrEqual(estimate.contextWindow);
    }
  });
});

// ---------------------------------------------------------------------------
// computeTruncationLimit
// ---------------------------------------------------------------------------
describe('computeTruncationLimit', () => {
  it('returns 0 when fixed costs exceed context window', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 200000,
      contextWindow: 50000,
      overflow: 150000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 10000,
        newPromptTokens: 100000,
        imageTokens: 0,
        toolSchemaTokens: 40000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    // Available = 50000 - 40000 - 16384 - 4000 - 10000 = -20384
    expect(computeTruncationLimit(estimate, 10000)).toBe(0);
  });

  it('returns positive value when budget is available', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 150000,
      contextWindow: 128000,
      overflow: 22000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 10000,
        newPromptTokens: 80000,
        imageTokens: 0,
        toolSchemaTokens: 30000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    // Available = 128000 - 30000 - 16384 - 4000 - 10000 = 67616 tokens
    const limit = computeTruncationLimit(estimate, 10000);
    expect(limit).toBe(67616 * 4);
  });

  it('uses provided effectiveHistoryTokens (not breakdown value)', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 150000,
      contextWindow: 128000,
      overflow: 22000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 80000, // this is NOT used
        newPromptTokens: 20000,
        imageTokens: 0,
        toolSchemaTokens: 30000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    // With effectiveHistory=20000: Available = 128000 - 30000 - 0 - 16384 - 4000 - 20000 = 57616
    expect(computeTruncationLimit(estimate, 20000)).toBe(57616 * 4);
    // With effectiveHistory=80000: Available = 128000 - 30000 - 0 - 16384 - 4000 - 80000 = -2384 → 0
    expect(computeTruncationLimit(estimate, 80000)).toBe(0);
  });

  it('includes image tokens in fixed cost calculation', () => {
    const estimate: PreRequestEstimateResult = {
      estimatedTotal: 160000,
      contextWindow: 128000,
      overflow: 32000,
      wouldOverflow: true,
      breakdown: {
        existingMessagesTokens: 10000,
        newPromptTokens: 80000,
        imageTokens: 6000, // 5 images
        toolSchemaTokens: 30000,
        modelMaxOutput: 16384,
        safetyMargin: 4000,
      },
    };
    // Available = 128000 - 30000 - 6000 - 16384 - 4000 - 10000 = 61616 tokens
    const limit = computeTruncationLimit(estimate, 10000);
    expect(limit).toBe(61616 * 4);
  });
});

// ---------------------------------------------------------------------------
// truncatePrompt
// ---------------------------------------------------------------------------
describe('truncatePrompt', () => {
  it('returns prompt unchanged if within limit', () => {
    const prompt = 'Hello world';
    expect(truncatePrompt(prompt, 1000)).toBe(prompt);
  });

  it('truncates long prompts and adds notice', () => {
    const prompt = 'a'.repeat(10000);
    const result = truncatePrompt(prompt, 5000);
    expect(result.length).toBeLessThanOrEqual(5000);
    expect(result).toContain('[... middle content truncated to fit context window ...]');
  });

  it('preserves tail of prompt (user request)', () => {
    // The tail (latest user request) should always be preserved
    const prompt = 'x'.repeat(10000) + 'USER_REQUEST_HERE';
    const result = truncatePrompt(prompt, 5000);
    expect(result).toContain('USER_REQUEST_HERE');
  });

  it('preserves head of prompt (contextual prefix)', () => {
    // The head (beginning context) should also be partially preserved
    const prompt = 'HEAD_CONTEXT ' + 'x'.repeat(10000) + ' TAIL_REQUEST';
    const result = truncatePrompt(prompt, 5000);
    expect(result).toContain('HEAD_CONTEXT');
    expect(result).toContain('TAIL_REQUEST');
  });

  it('uses head+tail strategy with ~80% tail budget', () => {
    const head = 'H'.repeat(2000);
    const middle = 'M'.repeat(10000);
    const tail = 'T'.repeat(2000);
    const prompt = head + middle + tail;
    const result = truncatePrompt(prompt, 5000);
    // Tail should be fully preserved (2000 chars fits in 80% of available)
    expect(result.endsWith(tail)).toBe(true);
    // Head should be partially preserved
    expect(result.startsWith('H')).toBe(true);
  });

  it('handles very small maxChars gracefully', () => {
    const prompt = 'Hello world this is a test';
    const result = truncatePrompt(prompt, 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('handles exact boundary', () => {
    const prompt = 'Hello';
    expect(truncatePrompt(prompt, 5)).toBe('Hello');
    expect(truncatePrompt(prompt, 4).length).toBeLessThanOrEqual(4);
  });

  it('returns empty string when maxChars is 0', () => {
    const prompt = 'Hello world';
    const result = truncatePrompt(prompt, 0);
    expect(result).toBe('');
  });

  it('returns empty string when maxChars is negative', () => {
    const prompt = 'Hello world';
    const result = truncatePrompt(prompt, -100);
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// GuardAbortError
// ---------------------------------------------------------------------------
describe('GuardAbortError', () => {
  it('is instanceof Error', () => {
    const err = new GuardAbortError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('has stable error code', () => {
    const err = new GuardAbortError('test message');
    expect(err.code).toBe('GUARD_ABORT_CONTEXT_EXHAUSTED');
    expect(err.name).toBe('GuardAbortError');
    expect(err.message).toBe('test message');
  });

  it('can be caught by instanceof check', () => {
    const err = new GuardAbortError('overflow');
    expect(err instanceof GuardAbortError).toBe(true);
    // Regular errors should not match
    const regularErr = new Error('overflow');
    expect(regularErr instanceof GuardAbortError).toBe(false);
  });
});
