/**
 * Which messages of a turn show their "Response time" line, through the real
 * GroupedMessages and MessageCard.
 *
 * The line used to sit under every assistant message, so a turn with several
 * steps showed a time after each one. Now only the last message of a finished
 * turn shows it.
 *
 * The turn is drawn once on the server, with `selectable` on: that keeps the
 * process accordion open on the first render, so the steps inside it are drawn
 * too. Effects do not run and nothing can be clicked.
 *
 * Texts come out in English here, so the line is found by its text.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '../src/renderer/types';
import { GroupedMessages } from '../src/renderer/components/message/GroupedMessages';

const TIME_LINE = /<span>Response time: [^<]+<\/span>/g;

function msg(
  id: string,
  role: 'user' | 'assistant',
  content: ContentBlock[],
  executionTimeMs?: number
): Message {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    timestamp: 1_700_000_000_000,
    ...(executionTimeMs !== undefined ? { executionTimeMs } : {}),
  };
}

const user = msg('u1', 'user', [{ type: 'text', text: 'find it' }]);

/** One tool step: the call and its result in one message. */
const step = (id: string, ms: number) =>
  msg(
    id,
    'assistant',
    [
      { type: 'tool_use', id: `t-${id}`, name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: `t-${id}`, content: 'ok' },
    ],
    ms
  );

const answer = (id: string, ms: number) =>
  msg(id, 'assistant', [{ type: 'text', text: 'Here is the answer.' }], ms);

function render(messages: Message[], hasActiveTurn = false): string {
  return renderToStaticMarkup(
    createElement(GroupedMessages, {
      messages,
      hasActiveTurn,
      selectable: true,
      selectedIds: new Set<string>(),
      onToggleSelect: () => {},
    })
  );
}

const countTimeLines = (html: string): number => html.match(TIME_LINE)?.length ?? 0;

describe('GroupedMessages response time line', () => {
  it('shows one line for a turn with steps and a final answer, not one per step', () => {
    const html = render([user, step('a1', 4500), step('a2', 4200), answer('a3', 1400)]);
    expect(countTimeLines(html)).toBe(1);
  });

  it('shows it under the final answer', () => {
    const html = render([user, step('a1', 4500), answer('a2', 1400)]);
    expect(html.indexOf('Here is the answer.')).toBeGreaterThan(-1);
    expect(html.search(TIME_LINE)).toBeGreaterThan(html.indexOf('Here is the answer.'));
    expect(html).toContain('1.4s');
    expect(html).not.toContain('4.5s');
  });

  it('shows one line for a turn that has no clear final answer, under its last message', () => {
    // The last message ends with a tool call, so nothing is split off: all messages are shown.
    const html = render([user, step('a1', 4500), step('a2', 2200)]);
    expect(countTimeLines(html)).toBe(1);
    expect(html).toContain('2.2s');
    expect(html).not.toContain('4.5s');
  });

  it('shows one line, not two, when one message is split into process and answer', () => {
    const both = msg(
      'a1',
      'assistant',
      [
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        { type: 'tool_result', toolUseId: 't1', content: 'ok' },
        { type: 'text', text: 'Here is the answer.' },
      ],
      3300
    );
    expect(countTimeLines(render([user, both]))).toBe(1);
  });

  it('shows one line for a plain one-message answer', () => {
    expect(countTimeLines(render([user, answer('a1', 900)]))).toBe(1);
  });

  it('shows no line while the turn is still running', () => {
    expect(countTimeLines(render([user, step('a1', 4500), step('a2', 2200)], true))).toBe(0);
  });

  it('shows one line per finished turn, none for the one that is running', () => {
    const second = msg('u2', 'user', [{ type: 'text', text: 'again' }]);
    const messages = [user, step('a1', 4500), answer('a2', 1400), second, step('a3', 2200)];
    expect(countTimeLines(render(messages, true))).toBe(1);
    expect(countTimeLines(render(messages, false))).toBe(2);
  });

  it('shows nothing for a message that has no stored time', () => {
    const noTime = msg('a1', 'assistant', [{ type: 'text', text: 'Old answer.' }]);
    expect(countTimeLines(render([user, noTime]))).toBe(0);
  });
});
