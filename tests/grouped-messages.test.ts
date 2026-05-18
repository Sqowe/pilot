import { describe, it, expect } from 'vitest';
import type { Message, ContentBlock } from '../src/renderer/types/index';
import {
  shouldCollapseTurn,
  findFinalAnswerIndex,
  findIntraMessageAnswerBoundary,
  splitTurnMessages,
  groupMessagesIntoTurns,
} from '../src/renderer/components/message/grouping-logic';

function makeMsg(
  id: string,
  content: ContentBlock[],
  role: 'user' | 'assistant' = 'assistant'
): Message {
  return {
    id,
    sessionId: 'test-session',
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('grouping-logic', () => {
  describe('shouldCollapseTurn', () => {
    it('collapses when any tool_use is present', () => {
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
        ]),
      ];
      expect(shouldCollapseTurn(msgs)).toBe(true);
    });

    it('collapses when ≥3 thinking blocks across messages', () => {
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'thought 1' },
          { type: 'text', text: 'a' },
        ]),
        makeMsg('2', [
          { type: 'thinking', thinking: 'thought 2' },
          { type: 'text', text: 'b' },
        ]),
        makeMsg('3', [
          { type: 'thinking', thinking: 'thought 3' },
          { type: 'text', text: 'c' },
        ]),
      ];
      expect(shouldCollapseTurn(msgs)).toBe(true);
    });

    it('does not collapse with 1 thinking and no tools', () => {
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'thought' },
          { type: 'text', text: 'answer' },
        ]),
      ];
      expect(shouldCollapseTurn(msgs)).toBe(false);
    });

    it('does not collapse with 2 thinking blocks and no tools', () => {
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'a' },
          { type: 'text', text: 'x' },
        ]),
        makeMsg('2', [
          { type: 'thinking', thinking: 'b' },
          { type: 'text', text: 'y' },
        ]),
      ];
      expect(shouldCollapseTurn(msgs)).toBe(false);
    });

    it('collapses single message with tool_use', () => {
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'let me search' },
          { type: 'tool_use', id: 't1', name: 'search', input: {} },
        ]),
      ];
      expect(shouldCollapseTurn(msgs)).toBe(true);
    });
  });

  describe('findFinalAnswerIndex', () => {
    it('returns index of last message ending with text', () => {
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }]),
        makeMsg('3', [
          { type: 'thinking', thinking: 'done' },
          { type: 'text', text: 'Final answer' },
        ]),
      ];
      expect(findFinalAnswerIndex(msgs)).toBe(2);
    });

    it('returns messages.length when last message ends with tool_use', () => {
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        ]),
      ];
      expect(findFinalAnswerIndex(msgs)).toBe(1);
    });

    it('detects file_attachment as final answer', () => {
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]),
        makeMsg('2', [
          { type: 'text', text: 'Here is the file' },
          {
            type: 'file_attachment',
            filename: 'report.pdf',
            relativePath: './report.pdf',
            size: 1024,
          },
        ]),
      ];
      expect(findFinalAnswerIndex(msgs)).toBe(1);
    });

    it('skips messages that only contain tool_result/tool_use', () => {
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'output' }]),
        makeMsg('3', [{ type: 'text', text: 'The answer is 42' }]),
      ];
      expect(findFinalAnswerIndex(msgs)).toBe(2);
    });

    it('returns no split when text message is followed by tool_use message', () => {
      // Regression: earlier text message should NOT be treated as final answer
      // when later messages end with non-answer content
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'step 1' },
          { type: 'text', text: 'Intermediate narration' },
        ]),
        makeMsg('2', [{ type: 'tool_use', id: 't1', name: 'search', input: {} }]),
        makeMsg('3', [{ type: 'tool_result', toolUseId: 't1', content: 'results' }]),
      ];
      // Last message ends with tool_result — no clear final answer
      expect(findFinalAnswerIndex(msgs)).toBe(3);
    });

    it('returns no split when text message is followed by tool_result as last message', () => {
      const msgs = [
        makeMsg('1', [{ type: 'text', text: 'Let me search' }]),
        makeMsg('2', [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]),
        makeMsg('3', [{ type: 'tool_result', toolUseId: 't1', content: 'done' }]),
      ];
      expect(findFinalAnswerIndex(msgs)).toBe(3);
    });

    it('finds trailing contiguous answer messages', () => {
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }]),
        makeMsg('3', [
          { type: 'thinking', thinking: 'summarizing' },
          { type: 'text', text: 'Part 1' },
        ]),
        makeMsg('4', [{ type: 'text', text: 'Part 2 continuation' }]),
      ];
      // Both msgs 3 and 4 end with text and form a contiguous trailing run
      expect(findFinalAnswerIndex(msgs)).toBe(2);
    });
  });

  describe('findIntraMessageAnswerBoundary', () => {
    it('splits at the trailing text blocks', () => {
      const blocks: ContentBlock[] = [
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        { type: 'tool_result', toolUseId: 't1', content: 'ok' },
        { type: 'text', text: 'Final answer here' },
      ];
      expect(findIntraMessageAnswerBoundary(blocks)).toBe(3);
    });

    it('returns blocks.length when message ends with tool_use', () => {
      const blocks: ContentBlock[] = [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      ];
      expect(findIntraMessageAnswerBoundary(blocks)).toBe(2);
    });

    it('handles multiple trailing text blocks', () => {
      const blocks: ContentBlock[] = [
        { type: 'thinking', thinking: 'step 1' },
        { type: 'tool_use', id: 't1', name: 'search', input: {} },
        { type: 'tool_result', toolUseId: 't1', content: 'found' },
        { type: 'thinking', thinking: 'step 2' },
        { type: 'text', text: 'paragraph 1' },
        { type: 'text', text: 'paragraph 2' },
      ];
      expect(findIntraMessageAnswerBoundary(blocks)).toBe(4);
    });

    it('treats file_attachment as answer content', () => {
      const blocks: ContentBlock[] = [
        { type: 'thinking', thinking: 'generating' },
        { type: 'tool_use', id: 't1', name: 'write', input: {} },
        { type: 'tool_result', toolUseId: 't1', content: 'written' },
        { type: 'text', text: 'Here is your file' },
        { type: 'file_attachment', filename: 'out.docx', relativePath: './out.docx', size: 2048 },
      ];
      expect(findIntraMessageAnswerBoundary(blocks)).toBe(3);
    });

    it('returns 0 when entire message is text (no process)', () => {
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Just a simple answer' }];
      expect(findIntraMessageAnswerBoundary(blocks)).toBe(0);
    });
  });

  describe('splitTurnMessages', () => {
    it('splits single message with tool_use + trailing text', () => {
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'let me check' },
          { type: 'tool_use', id: 't1', name: 'bash', input: {} },
          { type: 'tool_result', toolUseId: 't1', content: 'output' },
          { type: 'text', text: 'The answer is 42' },
        ]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      expect(processMessages).toHaveLength(1);
      expect(answerMessages).toHaveLength(1);
      // Process should have the thinking + tool blocks
      expect(processMessages[0].content).toHaveLength(3);
      // Answer should have just the text
      expect(answerMessages[0].content).toHaveLength(1);
      expect((answerMessages[0].content[0] as { type: string; text: string }).text).toBe(
        'The answer is 42'
      );
    });

    it('splits multi-message turn at message boundary', () => {
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'step 1' },
          { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        ]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }]),
        makeMsg('3', [{ type: 'text', text: 'Final answer' }]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      expect(processMessages).toHaveLength(2); // msgs 1 and 2
      expect(answerMessages).toHaveLength(1); // msg 3
      expect(answerMessages[0].id).toBe('3');
    });

    it('handles multi-message turn where final message has leading process blocks', () => {
      // This is the critical regression case from the review
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'search', input: {} }]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'results' }]),
        makeMsg('3', [
          { type: 'thinking', thinking: 'now I can answer' },
          { type: 'text', text: 'Here is the final answer' },
        ]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      // Process should include msgs 1, 2, AND the thinking from msg 3
      expect(processMessages).toHaveLength(3);
      expect(processMessages[2].content).toHaveLength(1);
      expect((processMessages[2].content[0] as { type: string }).type).toBe('thinking');
      // Answer should only have the trailing text from msg 3
      expect(answerMessages).toHaveLength(1);
      expect(answerMessages[0].content).toHaveLength(1);
      expect((answerMessages[0].content[0] as { type: string; text: string }).text).toBe(
        'Here is the final answer'
      );
    });

    it('returns flat when no clear final answer exists', () => {
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      expect(processMessages).toHaveLength(0);
      expect(answerMessages).toHaveLength(2);
    });

    it('returns flat for empty input', () => {
      const { processMessages, answerMessages } = splitTurnMessages([]);
      expect(processMessages).toHaveLength(0);
      expect(answerMessages).toHaveLength(0);
    });

    it('splits process blocks from all trailing answer messages', () => {
      // All answer messages get intra-split: leading process blocks go to accordion,
      // trailing answer blocks stay visible. Order within answerMessages is preserved.
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'search', input: {} }]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'results' }]),
        makeMsg('3', [
          { type: 'thinking', thinking: 'analyzing part 1' },
          { type: 'text', text: 'First part of the answer' },
        ]),
        makeMsg('4', [
          { type: 'thinking', thinking: 'analyzing part 2' },
          { type: 'text', text: 'Second part of the answer' },
        ]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      // Process should have: msgs 1, 2, thinking from msg 3, thinking from msg 4
      expect(processMessages).toHaveLength(4);
      // Answer should have only the text blocks from msgs 3 and 4
      expect(answerMessages).toHaveLength(2);
      expect(answerMessages[0].content).toHaveLength(1);
      expect((answerMessages[0].content[0] as { type: string; text: string }).text).toBe(
        'First part of the answer'
      );
      expect(answerMessages[1].content).toHaveLength(1);
      expect((answerMessages[1].content[0] as { type: string; text: string }).text).toBe(
        'Second part of the answer'
      );
    });

    it('leaves answer messages without leading process blocks unchanged', () => {
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }]),
        makeMsg('3', [{ type: 'text', text: 'Pure text answer' }]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      expect(processMessages).toHaveLength(2);
      expect(answerMessages).toHaveLength(1);
      // Answer message should be the original (no synthetic id)
      expect(answerMessages[0].id).toBe('3');
    });

    it('extracts process blocks from first answer message when answerIndex is 0', () => {
      // findFinalAnswerIndex returns 0 because all messages end with text.
      // All messages get intra-split.
      const msgs = [
        makeMsg('1', [
          { type: 'thinking', thinking: 'step 1' },
          { type: 'tool_use', id: 't1', name: 'search', input: {} },
          { type: 'tool_result', toolUseId: 't1', content: 'found' },
          { type: 'text', text: 'Intermediate narration' },
        ]),
        makeMsg('2', [
          { type: 'thinking', thinking: 'step 2' },
          { type: 'text', text: 'Final answer' },
        ]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      // Process should have the leading blocks from both messages
      expect(processMessages).toHaveLength(2);
      // Answer messages should only have trailing text
      expect(answerMessages).toHaveLength(2);
      expect(answerMessages[0].content).toHaveLength(1);
      expect((answerMessages[0].content[0] as { type: string; text: string }).text).toBe(
        'Intermediate narration'
      );
      expect(answerMessages[1].content).toHaveLength(1);
      expect((answerMessages[1].content[0] as { type: string; text: string }).text).toBe(
        'Final answer'
      );
    });

    it('returns flat when all messages are pure text (no process to extract)', () => {
      const msgs = [
        makeMsg('1', [{ type: 'text', text: 'Hello' }]),
        makeMsg('2', [{ type: 'text', text: 'World' }]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      // No process blocks to extract — should be flat
      expect(processMessages).toHaveLength(0);
      expect(answerMessages).toHaveLength(2);
      expect(answerMessages[0].id).toBe('1');
      expect(answerMessages[1].id).toBe('2');
    });

    it('preserves answer message order — visible content stays chronological', () => {
      // Even though process blocks are extracted from all answer messages,
      // the answerMessages array maintains original relative order.
      const msgs = [
        makeMsg('1', [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]),
        makeMsg('2', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }]),
        makeMsg('3', [{ type: 'text', text: 'First answer paragraph' }]),
        makeMsg('4', [
          { type: 'thinking', thinking: 'additional thought' },
          { type: 'text', text: 'Second paragraph' },
        ]),
      ];
      const { processMessages, answerMessages } = splitTurnMessages(msgs);
      // Process: msgs 1, 2, and thinking from msg 4
      expect(processMessages).toHaveLength(3);
      // Answer: msg 3 as-is, then text from msg 4
      expect(answerMessages).toHaveLength(2);
      expect((answerMessages[0].content[0] as { type: string; text: string }).text).toBe(
        'First answer paragraph'
      );
      expect((answerMessages[1].content[0] as { type: string; text: string }).text).toBe(
        'Second paragraph'
      );
    });
  });

  describe('groupMessagesIntoTurns', () => {
    it('groups user + assistant messages into turns', () => {
      const msgs = [
        makeMsg('u1', [{ type: 'text', text: 'hello' }], 'user'),
        makeMsg('a1', [{ type: 'text', text: 'hi' }]),
        makeMsg('a2', [{ type: 'text', text: 'how can I help?' }]),
        makeMsg('u2', [{ type: 'text', text: 'search for X' }], 'user'),
        makeMsg('a3', [{ type: 'tool_use', id: 't1', name: 'search', input: {} }]),
      ];
      const turns = groupMessagesIntoTurns(msgs);
      expect(turns).toHaveLength(2);
      expect(turns[0].userMessage?.id).toBe('u1');
      expect(turns[0].assistantMessages).toHaveLength(2);
      expect(turns[1].userMessage?.id).toBe('u2');
      expect(turns[1].assistantMessages).toHaveLength(1);
    });

    it('handles assistant messages before any user message', () => {
      const msgs = [
        makeMsg('a1', [{ type: 'text', text: 'Welcome!' }]),
        makeMsg('u1', [{ type: 'text', text: 'hi' }], 'user'),
        makeMsg('a2', [{ type: 'text', text: 'response' }]),
      ];
      const turns = groupMessagesIntoTurns(msgs);
      expect(turns).toHaveLength(2);
      expect(turns[0].userMessage).toBeUndefined();
      expect(turns[0].assistantMessages).toHaveLength(1);
      expect(turns[1].userMessage?.id).toBe('u1');
    });
  });
});
