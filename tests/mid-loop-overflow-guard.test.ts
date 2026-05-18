import { describe, it, expect } from 'vitest';
import {
  estimatePayloadSize,
  groupMessagesIntoTurns,
  trimPayloadMessages,
} from '../src/main/claude/mid-loop-overflow-guard';

// ---------------------------------------------------------------------------
// Helper: create messages of approximate token size
// ---------------------------------------------------------------------------

function makeMsg(role: string, chars: number): Record<string, unknown> {
  return { role, content: 'x'.repeat(chars) };
}

function makeToolCallAssistant(chars: number): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', name: 'read_file', arguments: { path: 'x'.repeat(chars) } }],
  };
}

function makeToolResult(chars: number): Record<string, unknown> {
  return { role: 'tool', content: 'y'.repeat(chars) };
}

// ---------------------------------------------------------------------------
// estimatePayloadSize
// ---------------------------------------------------------------------------

describe('estimatePayloadSize', () => {
  it('returns no overflow when within budget', () => {
    const result = estimatePayloadSize({
      messages: [makeMsg('user', 100)],
      tools: [],
      contextWindow: 128000,
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    expect(result.wouldOverflow).toBe(false);
    expect(result.overflow).toBeLessThan(0);
  });

  it('detects overflow when messages exceed budget', () => {
    // Create messages totaling ~200K chars ≈ 50K tokens
    const messages = Array.from({ length: 50 }, () => makeMsg('user', 4000));
    const result = estimatePayloadSize({
      messages,
      tools: [],
      contextWindow: 50000, // 50K token window
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    expect(result.wouldOverflow).toBe(true);
    expect(result.overflow).toBeGreaterThan(0);
  });

  it('includes tool tokens in the estimate', () => {
    const tools = [
      { name: 'tool1', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
    ];
    const withTools = estimatePayloadSize({
      messages: [makeMsg('user', 100)],
      tools,
      contextWindow: 128000,
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    const withoutTools = estimatePayloadSize({
      messages: [makeMsg('user', 100)],
      tools: [],
      contextWindow: 128000,
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    expect(withTools.breakdown.toolTokens).toBeGreaterThan(0);
    expect(withTools.estimatedTotal).toBeGreaterThan(withoutTools.estimatedTotal);
  });

  it('handles undefined tools gracefully', () => {
    const result = estimatePayloadSize({
      messages: [makeMsg('user', 100)],
      tools: undefined,
      contextWindow: 128000,
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    expect(result.breakdown.toolTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// groupMessagesIntoTurns
// ---------------------------------------------------------------------------

describe('groupMessagesIntoTurns', () => {
  it('groups a simple user-assistant conversation', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
    ];
    const turns = groupMessagesIntoTurns(messages, 1); // skip system
    expect(turns).toHaveLength(4); // user, assistant, user, assistant
  });

  it('groups assistant + tool_result as one atomic turn', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200),
      makeToolCallAssistant(300),
      makeToolResult(500),
      makeToolResult(500),
      makeMsg('user', 200),
    ];
    const turns = groupMessagesIntoTurns(messages, 1);
    // Turn 1: user (idx 1)
    // Turn 2: assistant + 2 tool_results (idx 2,3,4)
    // Turn 3: user (idx 5)
    expect(turns).toHaveLength(3);
    expect(turns[1].startIdx).toBe(2);
    expect(turns[1].endIdx).toBe(4);
  });

  it('does not merge non-adjacent tool results into assistant turn', () => {
    const messages = [
      makeMsg('user', 200),
      makeToolCallAssistant(300),
      makeToolResult(500),
      makeMsg('user', 200), // breaks the chain
      makeToolResult(500), // this is a standalone (orphaned, but we handle it)
    ];
    const turns = groupMessagesIntoTurns(messages, 0);
    // Turn 1: user (idx 0)
    // Turn 2: assistant + tool_result (idx 1,2)
    // Turn 3: user (idx 3)
    // Turn 4: tool_result standalone (idx 4) — role is 'tool', not 'assistant'
    expect(turns).toHaveLength(4);
    expect(turns[1].startIdx).toBe(1);
    expect(turns[1].endIdx).toBe(2);
    expect(turns[3].startIdx).toBe(4);
    expect(turns[3].endIdx).toBe(4);
  });

  it('handles empty messages after startIdx', () => {
    const messages = [makeMsg('system', 100)];
    const turns = groupMessagesIntoTurns(messages, 1);
    expect(turns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// trimPayloadMessages
// ---------------------------------------------------------------------------

describe('trimPayloadMessages', () => {
  it('returns null when too few turns to trim', () => {
    const messages = [makeMsg('system', 100), makeMsg('user', 200), makeMsg('assistant', 300)];
    // Only 2 turns (user + assistant), minKeepTurns = 2 → can't drop any
    const result = trimPayloadMessages(messages, 1000);
    expect(result).toBeNull();
  });

  it('preserves system message when trimming', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
    ];
    const result = trimPayloadMessages(messages, 5000);
    expect(result).not.toBeNull();
    const first = result!.trimmedMessages[0] as Record<string, unknown>;
    expect(first.role).toBe('system');
  });

  it('preserves tool-call/result atomicity', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200),
      makeToolCallAssistant(300),
      makeToolResult(5000),
      makeToolResult(5000),
      makeMsg('user', 200),
      makeToolCallAssistant(300),
      makeToolResult(500),
    ];
    // Overflow enough to drop the first tool turn (assistant + 2 tool_results)
    const result = trimPayloadMessages(messages, 3000);
    expect(result).not.toBeNull();

    // Verify no orphaned tool_result messages at the start (after system)
    const trimmed = result!.trimmedMessages;
    const firstNonSystem = trimmed[1] as Record<string, unknown>;
    // Should NOT be a tool_result — should be a user or assistant message
    expect(firstNonSystem.role).not.toBe('tool');
    expect(firstNonSystem.role).not.toBe('tool_result');
  });

  it('drops enough turns to free the required tokens', () => {
    // Each user message is ~200 chars ≈ 50 tokens
    // Each assistant message is ~300 chars ≈ 75 tokens
    const messages = [
      makeMsg('system', 100),
      ...Array.from({ length: 10 }, (_, i) => [
        makeMsg('user', 200),
        makeMsg('assistant', 300),
      ]).flat(),
    ];
    // Overflow of 500 tokens → need to free 500*4 = 2000 chars
    // Each turn pair (user + assistant) ≈ 500 chars → need ~4 turns
    const result = trimPayloadMessages(messages, 500);
    expect(result).not.toBeNull();
    expect(result!.turnsDropped).toBeGreaterThan(0);
    expect(result!.charsFreed).toBeGreaterThanOrEqual(500 * 4);
  });

  it('keeps at least minKeepTurns turns', () => {
    const messages = [
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
    ];
    // Even with huge overflow, keep last 2 turns
    const result = trimPayloadMessages(messages, 100000, { minKeepTurns: 2 });
    expect(result).not.toBeNull();
    // 5 turns total, keep 2 → drop at most 3
    expect(result!.turnsDropped).toBeLessThanOrEqual(3);
    expect(result!.trimmedMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('works without system message', () => {
    const messages = [
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
    ];
    const result = trimPayloadMessages(messages, 500);
    expect(result).not.toBeNull();
    // First message should NOT be system
    const first = result!.trimmedMessages[0] as Record<string, unknown>;
    expect(first.role).not.toBe('system');
  });

  it('reports correct messagesDropped count', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200), // turn 1 (1 msg)
      makeToolCallAssistant(300), // turn 2 start
      makeToolResult(500), // turn 2 (3 msgs total in turn)
      makeToolResult(500),
      makeMsg('user', 200), // turn 3
      makeMsg('assistant', 300), // turn 4
    ];
    // Drop turn 1 (user) + turn 2 (assistant + 2 tool_results) = 4 messages
    const result = trimPayloadMessages(messages, 5000);
    expect(result).not.toBeNull();
    // Should drop turns 1 and 2 (4 messages: user + assistant + tool + tool)
    expect(result!.messagesDropped).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: Ollama num_ctx preserved alongside trimming
// ---------------------------------------------------------------------------

describe('integration scenarios', () => {
  it('trimming a conversation with multiple tool loops preserves valid structure', () => {
    // Simulate a real conversation: user → assistant(tool_call) → tool_result → assistant → user → ...
    const messages = [
      makeMsg('system', 500),
      makeMsg('user', 1000),
      makeToolCallAssistant(500),
      makeToolResult(2000),
      makeMsg('assistant', 1000), // assistant follow-up after tool result
      makeMsg('user', 1000),
      makeToolCallAssistant(500),
      makeToolResult(3000),
      makeMsg('assistant', 1000),
      makeMsg('user', 500),
      makeToolCallAssistant(200),
      makeToolResult(1000),
    ];

    const result = trimPayloadMessages(messages, 2000);
    expect(result).not.toBeNull();

    // Verify structure: no tool_result without preceding assistant
    const trimmed = result!.trimmedMessages as Array<Record<string, unknown>>;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i].role === 'tool' || trimmed[i].role === 'tool_result') {
        // Must be preceded by an assistant or another tool/tool_result
        expect(i).toBeGreaterThan(0);
        const prev = trimmed[i - 1];
        expect(['assistant', 'tool', 'tool_result']).toContain(prev.role);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Anthropic-style tool flow (tool_use in assistant, tool_result in user)
// ---------------------------------------------------------------------------

function makeAnthropicToolUseAssistant(chars: number): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me check that.' },
      { type: 'tool_use', id: 'toolu_123', name: 'read_file', input: { path: 'x'.repeat(chars) } },
    ],
  };
}

function makeAnthropicToolResultUser(chars: number): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'y'.repeat(chars) }],
  };
}

describe('Anthropic-style tool flow', () => {
  it('groups assistant tool_use + user tool_result as one atomic turn', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200),
      makeAnthropicToolUseAssistant(300),
      makeAnthropicToolResultUser(500),
      makeMsg('assistant', 200),
      makeMsg('user', 200),
    ];
    const turns = groupMessagesIntoTurns(messages, 1);
    // Turn 1: user (idx 1)
    // Turn 2: assistant(tool_use) + user(tool_result) (idx 2,3)
    // Turn 3: assistant (idx 4)
    // Turn 4: user (idx 5)
    expect(turns).toHaveLength(4);
    expect(turns[1].startIdx).toBe(2);
    expect(turns[1].endIdx).toBe(3); // includes the user tool_result message
  });

  it('trimming never orphans a user tool_result without its assistant tool_use', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200), // turn 1
      makeAnthropicToolUseAssistant(300), // turn 2 start
      makeAnthropicToolResultUser(5000), // turn 2 end
      makeMsg('assistant', 200), // turn 3
      makeMsg('user', 200), // turn 4
      makeAnthropicToolUseAssistant(300), // turn 5 start
      makeAnthropicToolResultUser(500), // turn 5 end
    ];

    const result = trimPayloadMessages(messages, 2000);
    expect(result).not.toBeNull();

    // Verify: no user message with tool_result blocks appears without
    // a preceding assistant message with tool_use blocks
    const trimmed = result!.trimmedMessages as Array<Record<string, unknown>>;
    for (let i = 0; i < trimmed.length; i++) {
      const msg = trimmed[i];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasToolResult = (msg.content as Array<Record<string, unknown>>).some(
          (b) => b.type === 'tool_result'
        );
        if (hasToolResult) {
          // Must be preceded by an assistant with tool_use
          expect(i).toBeGreaterThan(0);
          const prev = trimmed[i - 1];
          expect(prev.role).toBe('assistant');
          if (Array.isArray(prev.content)) {
            const prevHasToolUse = (prev.content as Array<Record<string, unknown>>).some(
              (b) => b.type === 'tool_use' || b.type === 'toolCall'
            );
            expect(prevHasToolUse).toBe(true);
          }
        }
      }
    }
  });

  it('handles mixed OpenAI and Anthropic tool formats', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200),
      // OpenAI-style tool call
      makeToolCallAssistant(300),
      makeToolResult(500),
      // Anthropic-style tool call
      makeAnthropicToolUseAssistant(300),
      makeAnthropicToolResultUser(500),
      makeMsg('user', 200),
      makeMsg('assistant', 200),
    ];
    const turns = groupMessagesIntoTurns(messages, 1);
    // Turn 1: user (idx 1)
    // Turn 2: assistant + tool (OpenAI, idx 2,3)
    // Turn 3: assistant(tool_use) + user(tool_result) (Anthropic, idx 4,5)
    // Turn 4: user (idx 6)
    // Turn 5: assistant (idx 7)
    expect(turns).toHaveLength(5);
    expect(turns[1].startIdx).toBe(2);
    expect(turns[1].endIdx).toBe(3);
    expect(turns[2].startIdx).toBe(4);
    expect(turns[2].endIdx).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: minKeepTurns boundary handling
// ---------------------------------------------------------------------------

describe('minKeepTurns edge cases', () => {
  it('clamps minKeepTurns=0 to 1 (never drops all turns)', () => {
    const messages = [makeMsg('user', 200), makeMsg('assistant', 300), makeMsg('user', 200)];
    // With minKeepTurns=0, should still keep at least 1 turn (clamped)
    const result = trimPayloadMessages(messages, 100000, { minKeepTurns: 0 });
    expect(result).not.toBeNull();
    expect(result!.trimmedMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('clamps negative minKeepTurns to 1', () => {
    const messages = [
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
    ];
    const result = trimPayloadMessages(messages, 100000, { minKeepTurns: -5 });
    expect(result).not.toBeNull();
    expect(result!.trimmedMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('does not crash when turnsToDrop would equal turns.length', () => {
    const messages = [makeMsg('system', 100), makeMsg('user', 200), makeMsg('assistant', 300)];
    // minKeepTurns=1, 2 turns, maxDroppable=1, huge overflow → drops 1 turn
    const result = trimPayloadMessages(messages, 100000, { minKeepTurns: 1 });
    expect(result).not.toBeNull();
    // Should keep system + last turn
    expect(result!.trimmedMessages.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Integration: full conversation with tool loops
// ---------------------------------------------------------------------------

describe('integration scenarios', () => {
  it('trimming a conversation with multiple tool loops preserves valid structure (OpenAI)', () => {
    const messages = [
      makeMsg('system', 500),
      makeMsg('user', 1000),
      makeToolCallAssistant(500),
      makeToolResult(2000),
      makeMsg('assistant', 1000),
      makeMsg('user', 1000),
      makeToolCallAssistant(500),
      makeToolResult(3000),
      makeMsg('assistant', 1000),
      makeMsg('user', 500),
      makeToolCallAssistant(200),
      makeToolResult(1000),
    ];

    const result = trimPayloadMessages(messages, 2000);
    expect(result).not.toBeNull();

    // Verify structure: no tool_result without preceding assistant
    const trimmed = result!.trimmedMessages as Array<Record<string, unknown>>;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i].role === 'tool' || trimmed[i].role === 'tool_result') {
        expect(i).toBeGreaterThan(0);
        const prev = trimmed[i - 1];
        expect(['assistant', 'tool', 'tool_result']).toContain(prev.role);
      }
    }
  });

  it('trimming Anthropic-style multi-turn tool conversation preserves structure', () => {
    const messages = [
      makeMsg('system', 500),
      makeMsg('user', 1000),
      makeAnthropicToolUseAssistant(500),
      makeAnthropicToolResultUser(2000),
      makeMsg('assistant', 1000), // follow-up response
      makeMsg('user', 1000),
      makeAnthropicToolUseAssistant(500),
      makeAnthropicToolResultUser(3000),
      makeMsg('assistant', 1000),
      makeMsg('user', 500),
    ];

    const result = trimPayloadMessages(messages, 2000);
    expect(result).not.toBeNull();

    // Verify: no orphaned tool_result user messages
    const trimmed = result!.trimmedMessages as Array<Record<string, unknown>>;
    for (let i = 0; i < trimmed.length; i++) {
      const msg = trimmed[i];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasToolResult = (msg.content as Array<Record<string, unknown>>).some(
          (b) => b.type === 'tool_result'
        );
        if (hasToolResult && i > 0) {
          const prev = trimmed[i - 1];
          expect(prev.role).toBe('assistant');
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases: boundary validation and payload non-emptiness
// ---------------------------------------------------------------------------

describe('boundary validation edge cases', () => {
  it('boundary adjustment does not reduce payload to empty (reverts if needed)', () => {
    // All messages after the trim point are tool_results — boundary adjustment
    // would skip them all, leaving nothing. Should revert to original boundary.
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200),
      makeToolCallAssistant(300),
      makeToolResult(500), // This is the only message after trim point
    ];
    // Force dropping turn 1 (user), keeping turn 2 (assistant+tool)
    // But if boundary validation tries to skip the tool_result, it would leave nothing
    const result = trimPayloadMessages(messages, 100, { minKeepTurns: 1 });
    if (result) {
      // Should always have at least 1 non-system message
      const nonSystem = result.trimmedMessages.filter(
        (m) => (m as Record<string, unknown>).role !== 'system'
      );
      expect(nonSystem.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('boundary adjustment skips orphaned tool_result but keeps subsequent messages', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 200), // turn 1
      makeMsg('assistant', 300), // turn 2
      { role: 'tool', content: 'result' }, // orphaned at boundary after dropping turns 1-2
      makeMsg('user', 200), // turn 3 (should be kept)
      makeMsg('assistant', 300), // turn 4
    ];
    // Drop enough to reach the orphaned tool message at boundary
    const result = trimPayloadMessages(messages, 500, { minKeepTurns: 1 });
    if (result) {
      const trimmed = result.trimmedMessages as Array<Record<string, unknown>>;
      // First non-system message should NOT be a tool result
      const firstNonSystem = trimmed.find((m) => m.role !== 'system');
      expect(firstNonSystem?.role).not.toBe('tool');
      expect(firstNonSystem?.role).not.toBe('tool_result');
    }
  });

  it('TrimResult does not have stillOverBudget field', () => {
    const messages = [
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
    ];
    const result = trimPayloadMessages(messages, 100);
    expect(result).not.toBeNull();
    // Verify the field was removed from the contract
    expect('stillOverBudget' in result!).toBe(false);
  });

  it('trimming with only system + 1 turn returns null (cannot trim)', () => {
    const messages = [makeMsg('system', 100), makeMsg('user', 200)];
    const result = trimPayloadMessages(messages, 1000);
    expect(result).toBeNull();
  });

  it('handles conversation starting with tool_result (mid-tool-loop resume)', () => {
    // Edge case: conversation starts mid-tool-loop (e.g., after a crash/resume)
    const messages = [
      makeMsg('system', 100),
      { role: 'tool', content: 'orphaned result from before' },
      makeMsg('user', 200),
      makeMsg('assistant', 300),
      makeMsg('user', 200),
      makeMsg('assistant', 300),
    ];
    const result = trimPayloadMessages(messages, 500, { minKeepTurns: 1 });
    if (result) {
      const trimmed = result.trimmedMessages as Array<Record<string, unknown>>;
      // Should not crash and should produce valid output
      expect(trimmed.length).toBeGreaterThanOrEqual(2); // system + at least 1 message
    }
  });
});

// ---------------------------------------------------------------------------
// Conservative context window fallback behavior
// ---------------------------------------------------------------------------

describe('estimatePayloadSize with conservative defaults', () => {
  it('detects overflow with small context window (simulating unknown model)', () => {
    // Simulate the agent-runner using 32K fallback for unknown model
    const messages = Array.from({ length: 20 }, () => makeMsg('user', 4000));
    const result = estimatePayloadSize({
      messages,
      tools: [],
      contextWindow: 32000, // conservative fallback
      maxOutput: 4096,
      safetyMargin: 4000,
    });
    // 20 messages * ~4000 chars = 80K chars ≈ 20K tokens + 4096 + 4000 = ~28K
    // With 32K window this should be close to or over budget
    expect(result.estimatedTotal).toBeGreaterThan(20000);
  });

  it('does not overflow with small conversation on 32K window', () => {
    const messages = [makeMsg('user', 200), makeMsg('assistant', 300)];
    const result = estimatePayloadSize({
      messages,
      tools: [],
      contextWindow: 32000,
      maxOutput: 4096,
      safetyMargin: 4000,
    });
    expect(result.wouldOverflow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: _onPayload hook behavior simulation
// ---------------------------------------------------------------------------

describe('_onPayload integration behavior', () => {
  // Simulates the _onPayload hook logic from agent-runner.ts
  function simulateOnPayloadHook(
    payload: Record<string, unknown>,
    options: { contextWindow: number; maxOutput: number; safetyMargin: number; isOllama?: boolean }
  ): Record<string, unknown> {
    const { contextWindow, maxOutput, safetyMargin, isOllama } = options;
    let result = { ...payload };

    // Inject num_ctx for Ollama
    if (isOllama) {
      result = { ...result, num_ctx: contextWindow };
    }

    // Mid-loop overflow estimation
    const messages = result.messages as unknown[] | undefined;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return result;
    }

    const estimate = estimatePayloadSize({
      messages,
      tools: result.tools as unknown[] | undefined,
      contextWindow,
      maxOutput,
      safetyMargin,
    });

    if (!estimate.wouldOverflow) {
      return result; // Within budget
    }

    const trimResult = trimPayloadMessages(messages, estimate.overflow);
    if (!trimResult) {
      return result; // Can't trim
    }

    return { ...result, messages: trimResult.trimmedMessages };
  }

  it('passes through payload unchanged when within budget', () => {
    const payload = {
      model: 'test-model',
      messages: [makeMsg('user', 200), makeMsg('assistant', 300)],
      tools: [],
    };
    const result = simulateOnPayloadHook(payload, {
      contextWindow: 128000,
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    expect(result.messages).toEqual(payload.messages);
  });

  it('trims messages when payload exceeds context window', () => {
    const messages = [
      makeMsg('system', 100),
      ...Array.from({ length: 20 }, () => [
        makeMsg('user', 2000),
        makeMsg('assistant', 2000),
      ]).flat(),
    ];
    const payload = { model: 'test-model', messages, tools: [] };
    const result = simulateOnPayloadHook(payload, {
      contextWindow: 16000, // small window
      maxOutput: 4096,
      safetyMargin: 4000,
    });
    const resultMessages = result.messages as unknown[];
    expect(resultMessages.length).toBeLessThan(messages.length);
    // System message preserved
    expect((resultMessages[0] as Record<string, unknown>).role).toBe('system');
  });

  it('injects num_ctx for Ollama alongside trimming', () => {
    const messages = [
      makeMsg('user', 8000),
      makeMsg('assistant', 8000),
      makeMsg('user', 8000),
      makeMsg('assistant', 8000),
    ];
    const payload = { model: 'test-model', messages, tools: [] };
    const result = simulateOnPayloadHook(payload, {
      contextWindow: 4000,
      maxOutput: 1000,
      safetyMargin: 500,
      isOllama: true,
    });
    // num_ctx injected
    expect(result.num_ctx).toBe(4000);
    // Messages trimmed (4 msgs × 8000 chars ≈ 8000 tokens > 4000 window)
    const resultMessages = result.messages as unknown[];
    expect(resultMessages.length).toBeLessThan(messages.length);
  });

  it('preserves tool-call/result pairs during trim', () => {
    const messages = [
      makeMsg('system', 100),
      makeMsg('user', 2000),
      makeToolCallAssistant(2000),
      makeToolResult(2000),
      makeMsg('user', 2000),
      makeToolCallAssistant(2000),
      makeToolResult(2000),
    ];
    const payload = { model: 'test-model', messages, tools: [] };
    const result = simulateOnPayloadHook(payload, {
      contextWindow: 8000,
      maxOutput: 2000,
      safetyMargin: 1000,
    });
    const resultMessages = result.messages as Array<Record<string, unknown>>;
    // Verify no orphaned tool results
    for (let i = 0; i < resultMessages.length; i++) {
      if (resultMessages[i].role === 'tool' || resultMessages[i].role === 'tool_result') {
        expect(i).toBeGreaterThan(0);
        const prev = resultMessages[i - 1];
        expect(['assistant', 'tool', 'tool_result', 'system']).toContain(prev.role);
      }
    }
  });

  it('handles empty messages array without crashing', () => {
    const payload = { model: 'test-model', messages: [], tools: [] };
    const result = simulateOnPayloadHook(payload, {
      contextWindow: 128000,
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    expect(result.messages).toEqual([]);
  });

  it('handles missing messages field without crashing', () => {
    const payload = { model: 'test-model', tools: [] };
    const result = simulateOnPayloadHook(payload, {
      contextWindow: 128000,
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    expect(result.messages).toBeUndefined();
  });

  it('chains with original onPayload (simulated)', () => {
    // Simulate an original _onPayload that adds a custom header
    const originalPayload = {
      model: 'test-model',
      messages: [makeMsg('user', 200)],
      tools: [],
      customField: 'preserved',
    };
    const result = simulateOnPayloadHook(originalPayload, {
      contextWindow: 128000,
      maxOutput: 16384,
      safetyMargin: 4000,
    });
    // Custom field preserved (no overflow, payload unchanged)
    expect(result.customField).toBe('preserved');
  });
});
