import { describe, it, expect } from 'vitest';
import {
  enrichToolErrorWithThinking,
  selectThinkingSource,
} from '../../main/claude/tool-error-enrichment';

/**
 * Tests for the tool error enrichment logic that appends thinking context
 * when a tool call fails with empty arguments.
 *
 * These test the actual production functions exported from tool-error-enrichment.ts,
 * which are used by agent-runner.ts's tool_execution_end handler.
 */

describe('enrichToolErrorWithThinking()', () => {
  const EMPTY_ARGS_ERROR =
    'Validation failed for tool "write":\n  - path: must have required properties path, content\n\nReceived arguments:\n{}';

  it('appends thinking context when tool fails with empty args', () => {
    const thinking = 'I will write the document to /path/to/file.md with sanctions content';
    const result = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, true, thinking);

    expect(result).toContain(EMPTY_ARGS_ERROR);
    expect(result).toContain('--- Model thinking context');
    expect(result).toContain('sanctions content');
  });

  it('does NOT enrich when error is not about empty arguments', () => {
    const otherError = 'Permission denied: /etc/passwd';
    const thinking = 'Some thinking content';
    const result = enrichToolErrorWithThinking(otherError, true, thinking);

    expect(result).toBe(otherError);
    expect(result).not.toContain('--- Model thinking context');
  });

  it('does NOT enrich when isError is false', () => {
    const result = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, false, 'some thinking');
    expect(result).toBe(EMPTY_ARGS_ERROR);
  });

  it('does NOT enrich when thinking is empty', () => {
    const result = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, true, '');
    expect(result).toBe(EMPTY_ARGS_ERROR);
  });

  it('truncates thinking to 500 chars with ellipsis', () => {
    const longThinking = 'A'.repeat(600);
    const result = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, true, longThinking);

    expect(result).toContain('A'.repeat(500) + '…');
    expect(result).not.toContain('A'.repeat(501));
  });

  it('does NOT truncate thinking at exactly 500 chars', () => {
    const exactThinking = 'B'.repeat(500);
    const result = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, true, exactThinking);

    expect(result).toContain('B'.repeat(500));
    expect(result).not.toContain('…');
  });

  it('preserves original error text unchanged at the start', () => {
    const thinking = 'I want to write file.md';
    const result = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, true, thinking);

    expect(result.startsWith(EMPTY_ARGS_ERROR)).toBe(true);
  });

  it('handles whitespace variations in "Received arguments" (CRLF, extra spaces)', () => {
    const crlfError =
      'Validation failed for tool "write":\n  - path: must have required properties\n\nReceived arguments:\r\n{ }';
    const result = enrichToolErrorWithThinking(crlfError, true, 'thinking content');

    expect(result).toContain('--- Model thinking context');
  });

  it('handles "Received arguments: {}" on same line', () => {
    const compactError = 'Validation failed\nReceived arguments:  {}';
    const result = enrichToolErrorWithThinking(compactError, true, 'thinking content');

    expect(result).toContain('--- Model thinking context');
  });
});

describe('selectThinkingSource()', () => {
  it('prefers accumulated deltas when longer (full stream)', () => {
    const deltas = 'Full thinking content from streaming deltas - very detailed';
    const content = 'Summarized thinking';
    expect(selectThinkingSource(deltas, content)).toBe(deltas);
  });

  it('prefers effectiveContent when longer (e.g., deltas were partial)', () => {
    const deltas = 'Short';
    const content = 'Longer thinking from effectiveContent blocks';
    expect(selectThinkingSource(deltas, content)).toBe(content);
  });

  it('returns empty string when both sources are empty (no stale leak)', () => {
    expect(selectThinkingSource('', '')).toBe('');
  });

  it('prefers deltas when both are equal length', () => {
    const text = 'Same length text here';
    expect(selectThinkingSource(text, text)).toBe(text);
  });
});

describe('Integration: per-turn isolation (no stale thinking leaks)', () => {
  it('simulates correct behavior across multiple turns', () => {
    // Simulate the agent-runner lifecycle using the production functions
    let lastAssistantThinking = '';
    let lastAssistantThinkingDeltas = '';

    // --- Turn 1: model thinks and tool succeeds ---
    lastAssistantThinkingDeltas += 'Turn 1: I will search for information';
    // message_end
    const turn1Content = 'Turn 1: I will search for information';
    lastAssistantThinking = selectThinkingSource(lastAssistantThinkingDeltas, turn1Content);
    lastAssistantThinkingDeltas = '';

    expect(lastAssistantThinking).toBe('Turn 1: I will search for information');

    // tool_execution_end (success) — enrichment not triggered
    const successOutput = 'Search completed successfully';
    const enriched1 = enrichToolErrorWithThinking(successOutput, false, lastAssistantThinking);
    expect(enriched1).toBe(successOutput);

    // --- Turn 2: model thinks and tool fails with empty args ---
    lastAssistantThinkingDeltas += 'Turn 2: I will write EU_Sanctions_Russia.md';
    // message_end
    const turn2Content = 'Turn 2: I will write EU_Sanctions_Russia.md';
    lastAssistantThinking = selectThinkingSource(lastAssistantThinkingDeltas, turn2Content);
    lastAssistantThinkingDeltas = '';

    expect(lastAssistantThinking).toBe('Turn 2: I will write EU_Sanctions_Russia.md');

    // tool_execution_end (error with empty args)
    const EMPTY_ARGS_ERROR =
      'Validation failed for tool "write":\n  - path: must have required properties path, content\n\nReceived arguments:\n{}';
    const enriched2 = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, true, lastAssistantThinking);
    expect(enriched2).toContain('EU_Sanctions_Russia.md');
    expect(enriched2).not.toContain('Turn 1');

    // --- Turn 3: no thinking, tool fails ---
    // message_end with no thinking (simulates shouldEmitMessage=false path)
    lastAssistantThinking = selectThinkingSource('', '');
    lastAssistantThinkingDeltas = '';

    expect(lastAssistantThinking).toBe('');

    // tool_execution_end (error) — no thinking to show, no stale leak
    const enriched3 = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, true, lastAssistantThinking);
    expect(enriched3).toBe(EMPTY_ARGS_ERROR);
  });

  it('suppressed message (shouldEmitMessage=false) still resets thinking', () => {
    let lastAssistantThinking = '';
    let lastAssistantThinkingDeltas = '';

    // Turn 1: has thinking
    lastAssistantThinkingDeltas = 'I will do something important';
    lastAssistantThinking = selectThinkingSource(lastAssistantThinkingDeltas, '');
    lastAssistantThinkingDeltas = '';
    expect(lastAssistantThinking).toBe('I will do something important');

    // Turn 2: message suppressed (no thinking deltas, no content)
    // This simulates the message_end path where shouldEmitMessage=false
    // The reset MUST still happen
    lastAssistantThinking = selectThinkingSource('', '');
    lastAssistantThinkingDeltas = '';

    // Turn 2's tool error should NOT see Turn 1's thinking
    expect(lastAssistantThinking).toBe('');

    const EMPTY_ARGS_ERROR = 'Received arguments:\n{}';
    const enriched = enrichToolErrorWithThinking(EMPTY_ARGS_ERROR, true, lastAssistantThinking);
    expect(enriched).toBe(EMPTY_ARGS_ERROR); // not enriched
  });
});
