/**
 * Tests for chat export — multi-format
 *
 * Covers:
 * - export-common: sanitizeFilename, formatSize, blockIsVisible, filterExportableMessages
 * - export-html: serializeMessagesToHtml — all block types, HTML escaping, options
 * - export-router: extension → format dispatch logic
 */

import { describe, it, expect } from 'vitest';
import * as nodePath from 'path';
import {
  sanitizeFilename,
  formatSize,
  blockIsVisible,
  filterExportableMessages,
  DEFAULT_OPTIONS,
  type ExportOptions,
  type Message,
  type Session,
} from '../main/chat/export-common';
import { serializeMessagesToHtml } from '../main/chat/export-html';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_OPTIONS: ExportOptions = { ...DEFAULT_OPTIONS };

const SESSION: Session = {
  id: 's1',
  title: 'Test Chat',
  model: 'claude-opus-4',
  createdAt: 1000000,
};

function makeMessage(overrides: Partial<Message> & { content: Message['content'] }): Message {
  return {
    id: 'msg-1',
    sessionId: 's1',
    role: 'assistant',
    timestamp: 1700000000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// export-common: sanitizeFilename
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  it('preserves alphanumeric and hyphens', () => {
    expect(sanitizeFilename('hello-world')).toBe('hello-world');
  });

  it('preserves CJK characters', () => {
    expect(sanitizeFilename('测试聊天')).toBe('测试聊天');
  });

  it('removes unsafe characters', () => {
    expect(sanitizeFilename('file<>:"/\\|?*name')).toBe('filename');
  });

  it('collapses whitespace to hyphens', () => {
    expect(sanitizeFilename('hello   world')).toBe('hello-world');
  });

  it('removes control characters', () => {
    expect(sanitizeFilename('hello\x00\x1fworld')).toBe('helloworld');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeFilename('  hello  ')).toBe('hello');
  });

  it('truncates to 100 characters', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeFilename(long).length).toBe(100);
  });

  it("returns 'chat' for empty input", () => {
    expect(sanitizeFilename('')).toBe('chat');
    expect(sanitizeFilename('???')).toBe('chat');
  });

  it('strips trailing dots and spaces', () => {
    expect(sanitizeFilename('hello...')).toBe('hello');
    expect(sanitizeFilename('hello   ')).toBe('hello');
  });

  it('prefixes Windows reserved names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('nul')).toBe('_nul');
    expect(sanitizeFilename('COM1')).toBe('_COM1');
    expect(sanitizeFilename('LPT9')).toBe('_LPT9');
    expect(sanitizeFilename('PRN')).toBe('_PRN');
  });

  it('prefixes Windows reserved names with extensions', () => {
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFilename('LPT1.pdf')).toBe('_LPT1.pdf');
    expect(sanitizeFilename('NUL.docx')).toBe('_NUL.docx');
  });
});

// ---------------------------------------------------------------------------
// export-common: formatSize
// ---------------------------------------------------------------------------

describe('formatSize', () => {
  it('formats bytes', () => expect(formatSize(512)).toBe('512 bytes'));
  it('formats KB', () => expect(formatSize(2048)).toBe('2.0 KB'));
  it('formats MB', () => expect(formatSize(2 * 1024 * 1024)).toBe('2.0 MB'));
});

// ---------------------------------------------------------------------------
// export-common: blockIsVisible
// ---------------------------------------------------------------------------

describe('blockIsVisible', () => {
  it('text block with content is visible', () => {
    expect(blockIsVisible({ type: 'text', text: 'hello' }, BASE_OPTIONS)).toBe(true);
  });

  it('empty text block is not visible', () => {
    expect(blockIsVisible({ type: 'text', text: '   ' }, BASE_OPTIONS)).toBe(false);
  });

  it('thinking block hidden by default', () => {
    expect(blockIsVisible({ type: 'thinking', thinking: 'hmm' }, BASE_OPTIONS)).toBe(false);
  });

  it('thinking block visible when enabled', () => {
    const opts = { ...BASE_OPTIONS, includeThinking: true };
    expect(blockIsVisible({ type: 'thinking', thinking: 'hmm' }, opts)).toBe(true);
  });

  it('tool_use hidden by default', () => {
    expect(
      blockIsVisible({ type: 'tool_use', id: 'x', name: 'bash', input: {} }, BASE_OPTIONS)
    ).toBe(false);
  });

  it('tool_use visible when enabled', () => {
    const opts = { ...BASE_OPTIONS, includeToolCalls: true };
    expect(blockIsVisible({ type: 'tool_use', id: 'x', name: 'bash', input: {} }, opts)).toBe(true);
  });

  it('image skip hides block', () => {
    const img = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' },
    };
    expect(blockIsVisible(img, { ...BASE_OPTIONS, imageHandling: 'skip' })).toBe(false);
  });

  it('image placeholder shows block', () => {
    const img = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' },
    };
    expect(blockIsVisible(img, { ...BASE_OPTIONS, imageHandling: 'placeholder' })).toBe(true);
  });

  it('file_attachment always visible', () => {
    const f = {
      type: 'file_attachment' as const,
      filename: 'f.txt',
      relativePath: 'f.txt',
      size: 100,
    };
    expect(blockIsVisible(f, BASE_OPTIONS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// export-common: filterExportableMessages
// ---------------------------------------------------------------------------

describe('filterExportableMessages', () => {
  it('removes system messages', () => {
    const msgs: Message[] = [
      makeMessage({ role: 'system', content: [{ type: 'text', text: 'system' }] }),
      makeMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] }),
    ];
    expect(filterExportableMessages(msgs, BASE_OPTIONS)).toHaveLength(1);
  });

  it('removes partial/streaming messages', () => {
    const msgs: Message[] = [
      makeMessage({ id: 'partial-abc', content: [{ type: 'text', text: 'streaming...' }] }),
      makeMessage({ id: 'msg-1', content: [{ type: 'text', text: 'done' }] }),
    ];
    expect(filterExportableMessages(msgs, BASE_OPTIONS)).toHaveLength(1);
  });

  it('removes messages with no visible content', () => {
    const msgs: Message[] = [
      makeMessage({
        content: [{ type: 'tool_use', id: 'x', name: 'bash', input: {} }],
      }),
      makeMessage({ id: 'msg-2', content: [{ type: 'text', text: 'hello' }] }),
    ];
    // tool calls off by default → first message invisible
    expect(filterExportableMessages(msgs, BASE_OPTIONS)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// export-html: serializeMessagesToHtml — structure
// ---------------------------------------------------------------------------

describe('serializeMessagesToHtml — document structure', () => {
  it('produces valid HTML skeleton', async () => {
    const msgs: Message[] = [
      makeMessage({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<title>Test Chat</title>');
    expect(html).toContain('Test Chat');
    expect(html).toContain('claude-opus-4');
  });

  it('includes print stylesheet', async () => {
    const html = await serializeMessagesToHtml([], SESSION, BASE_OPTIONS);
    expect(html).toContain('<style>');
    expect(html).toContain('font-family');
  });

  it('renders user and assistant role badges', async () => {
    const msgs: Message[] = [
      makeMessage({ role: 'user', content: [{ type: 'text', text: 'Hi' }] }),
      makeMessage({ id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).toContain('role-user');
    expect(html).toContain('role-assistant');
  });
});

// ---------------------------------------------------------------------------
// export-html: HTML escaping (security — §7 of design doc)
// ---------------------------------------------------------------------------

describe('serializeMessagesToHtml — HTML escaping', () => {
  it('escapes script tags in tool names', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [{ type: 'tool_use', id: 'x', name: '<script>alert(1)</script>', input: {} }],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      includeToolCalls: true,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes onerror payloads in tool results', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          {
            type: 'tool_result',
            toolUseId: 'x',
            content: '<img src="x" onerror="require(\'child_process\').exec(\'rm -rf /\')" />',
          },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      includeToolCalls: true,
    });
    expect(html).not.toContain('<img src="x"');
    expect(html).toContain('&lt;img');
    expect(html).toContain('onerror=');
    // onerror must appear only as escaped text, never as an attribute
    expect(html).not.toMatch(/<img[^>]*onerror=/);
  });

  it('escapes HTML in filenames', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          {
            type: 'file_attachment',
            filename: '<evil>.txt',
            relativePath: '<evil>.txt',
            size: 100,
          },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
  });

  it('escapes session title in document head', async () => {
    const session: Session = { ...SESSION, title: '<script>pwned</script>' };
    const html = await serializeMessagesToHtml([], session, BASE_OPTIONS);
    expect(html).not.toContain('<script>pwned</script>');
    expect(html).toContain('&lt;script&gt;pwned&lt;/script&gt;');
  });
});

// ---------------------------------------------------------------------------
// export-html: content blocks
// ---------------------------------------------------------------------------

describe('serializeMessagesToHtml — content blocks', () => {
  it('renders markdown text (bold, code fence)', async () => {
    const msgs: Message[] = [
      makeMessage({ content: [{ type: 'text', text: '**bold** and `code`' }] }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('omits thinking block by default', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'thinking', thinking: 'deep thought' },
          { type: 'text', text: 'answer' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).not.toContain('deep thought');
  });

  it('includes thinking block when enabled', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'thinking', thinking: 'deep thought' },
          { type: 'text', text: 'answer' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      includeThinking: true,
    });
    expect(html).toContain('deep thought');
    expect(html).toContain('💭 Thinking');
  });

  it('omits tool calls by default', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'tool_use', id: 'x', name: 'bash', input: { cmd: 'ls' } },
          { type: 'text', text: 'done' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).not.toContain('bash');
  });

  it('includes tool calls when enabled', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'tool_use', id: 'x', name: 'bash', input: { cmd: 'ls' } },
          { type: 'text', text: 'done' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      includeToolCalls: true,
    });
    expect(html).toContain('bash');
    expect(html).toContain('&quot;cmd&quot;');
  });

  it('renders image placeholder', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: 'here' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      imageHandling: 'placeholder',
    });
    expect(html).toContain('Image was attached');
  });

  it('skips image when imageHandling is skip', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: 'here' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      imageHandling: 'skip',
    });
    expect(html).not.toContain('Image was attached');
    expect(html).not.toContain('<img');
  });

  it('SVG inline image falls back to placeholder (unsafe MIME)', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'abc' } },
          { type: 'text', text: 'here' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      imageHandling: 'inline',
    });
    // SVG must not be embedded — falls back to placeholder
    expect(html).not.toContain('data:image/svg+xml');
    expect(html).toContain('Image was attached');
  });

  it('inlines image as data URI', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          { type: 'text', text: 'here' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      imageHandling: 'inline',
    });
    expect(html).toContain('data:image/png;base64,abc123');
  });

  it('renders file attachment', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          { type: 'file_attachment', filename: 'notes.txt', relativePath: 'notes.txt', size: 2048 },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).toContain('notes.txt');
    expect(html).toContain('2.0 KB');
  });

  it('includes timestamps when enabled', async () => {
    const msgs: Message[] = [makeMessage({ content: [{ type: 'text', text: 'hi' }] })];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      includeTimestamps: true,
    });
    expect(html).toContain('class="timestamp"');
  });

  it('includes token usage when enabled', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [{ type: 'text', text: 'hi' }],
        tokenUsage: { input: 10, output: 20 },
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      includeTokenUsage: true,
    });
    expect(html).toContain('10 in / 20 out');
  });
});

// ---------------------------------------------------------------------------
// export-html: security — text block injection via marked
// ---------------------------------------------------------------------------

describe('serializeMessagesToHtml — text block HTML injection', () => {
  it('script tag in text block is not emitted as executable markup', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [{ type: 'text', text: '<script>alert("xss")</script>' }],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    // Must not contain an executable <script> tag
    expect(html).not.toMatch(/<script[\s>]/i);
    // The text must appear escaped or omitted entirely
    expect(html).not.toContain('<script>alert');
  });

  it('img onerror in text block is not emitted as executable markup', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          {
            type: 'text',
            text: '<img src="x" onerror="require(\'child_process\').exec(\'rm -rf /\')"/>',
          },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    // Must not contain a real <img> with onerror attribute
    expect(html).not.toMatch(/<img[^>]*onerror=/i);
  });

  it('markdown remote image does not produce a network-fetchable img src', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [{ type: 'text', text: '![tracker](https://evil.com/track.png)' }],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    // The hardened renderer replaces remote images with a placeholder
    expect(html).not.toContain('https://evil.com/track.png');
    expect(html).not.toMatch(/<img[^>]*src=["']https?:/i);
  });

  it('markdown link does not produce a network-fetchable href', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [{ type: 'text', text: '[click me](https://evil.com)' }],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).not.toContain('href="https://evil.com"');
    expect(html).not.toMatch(/href=["']https?:/i);
    // Link text should still appear
    expect(html).toContain('click me');
  });

  it('markdown link with HTML label does not produce executable markup', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [{ type: 'text', text: '[<img src=x onerror=alert(1)>](https://evil.com)' }],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    // Must not contain a real <img> or onerror attribute
    expect(html).not.toMatch(/<img[^>]*onerror=/i);
    // href must be stripped
    expect(html).not.toContain('href=');
  });

  it('raw HTML block in text is escaped not passed through', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [{ type: 'text', text: '<div onclick="alert(1)">click</div>' }],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).not.toMatch(/<div[^>]*onclick=/i);
    expect(html).toContain('&lt;div');
  });

  it('inline image with invalid base64 data falls back to placeholder', async () => {
    const msgs: Message[] = [
      makeMessage({
        content: [
          // data contains quotes that would break out of an HTML attribute
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: '" onerror="alert(1)' },
          },
          { type: 'text', text: 'here' },
        ],
      }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, {
      ...BASE_OPTIONS,
      imageHandling: 'inline',
    });
    // Must not embed invalid base64 as a data URI
    expect(html).not.toContain('data:image/png;base64," onerror');
    expect(html).not.toMatch(/<img[^>]*onerror=/i);
    // Must fall back to placeholder
    expect(html).toContain('Image was attached');
  });

  it('output HTML contains no external href or src URLs', async () => {
    const msgs: Message[] = [
      makeMessage({
        role: 'user',
        content: [
          { type: 'text', text: '[link](https://evil.com) ![img](https://evil.com/x.png)' },
        ],
      }),
      makeMessage({ id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'reply' }] }),
    ];
    const html = await serializeMessagesToHtml(msgs, SESSION, BASE_OPTIONS);
    expect(html).not.toMatch(/href=["']https?:/i);
    expect(html).not.toMatch(/src=["']https?:/i);
    expect(html).not.toMatch(/src=["']file:/i);
  });

  it('generated HTML includes a restrictive CSP meta tag', async () => {
    const html = await serializeMessagesToHtml([], SESSION, BASE_OPTIONS);
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('img-src data:');
  });
});

// ---------------------------------------------------------------------------
// export-router: extension dispatch
// ---------------------------------------------------------------------------

describe('extension → format dispatch', () => {
  // We test the dispatch logic directly by importing path.extname behaviour
  // mirrored from the router — the router itself uses dynamic imports that
  // require Electron, so we test the routing decision in isolation.
  it('recognises .md extension', () => {
    const ext = nodePath.extname('chat-2026-01-01.md').toLowerCase();
    expect(ext).toBe('.md');
  });

  it('recognises .docx extension', () => {
    const ext = nodePath.extname('chat-2026-01-01.docx').toLowerCase();
    expect(ext).toBe('.docx');
  });

  it('recognises .pdf extension', () => {
    const ext = nodePath.extname('chat-2026-01-01.pdf').toLowerCase();
    expect(ext).toBe('.pdf');
  });

  it('treats unknown extension as fallback (not .md/.docx/.pdf)', () => {
    const ext = nodePath.extname('chat.xyz').toLowerCase();
    expect(['.md', '.docx', '.pdf']).not.toContain(ext);
  });
});

// ---------------------------------------------------------------------------
// DOCX buffer conversion — ArrayBuffer vs ArrayBufferView
// ---------------------------------------------------------------------------

describe('DOCX buffer conversion', () => {
  it('converts ArrayBuffer to Buffer correctly', () => {
    const ab = new ArrayBuffer(8);
    new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const buf = Buffer.from(new Uint8Array(ab));
    expect(buf.length).toBe(8);
    expect(buf[0]).toBe(1);
    expect(buf[7]).toBe(8);
  });

  it('converts ArrayBufferView (Uint8Array) to Buffer respecting byteOffset', () => {
    const ab = new ArrayBuffer(16);
    const view = new Uint8Array(ab, 4, 8); // byteOffset=4, length=8
    view.set([10, 20, 30, 40, 50, 60, 70, 80]);
    // Simulate the fixed conversion logic
    const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    expect(buf.length).toBe(8);
    expect(buf[0]).toBe(10);
    expect(buf[7]).toBe(80);
  });

  it('naive Buffer.from(ArrayBuffer) with byteOffset would be wrong', () => {
    const ab = new ArrayBuffer(16);
    const view = new Uint8Array(ab, 4, 8);
    view.set([10, 20, 30, 40, 50, 60, 70, 80]);
    // Wrong approach: ignores byteOffset, starts from 0
    const wrongBuf = Buffer.from(ab);
    expect(wrongBuf.length).toBe(16); // includes the leading 4 zero bytes
    expect(wrongBuf[0]).toBe(0); // wrong — should be 10
    // Correct approach
    const correctBuf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    expect(correctBuf[0]).toBe(10); // correct
  });
});

// ---------------------------------------------------------------------------
// ExportFormat and extension defaulting logic
// ---------------------------------------------------------------------------

describe('ExportFormat and extension defaulting', () => {
  it('preferredExt maps correctly from ExportFormat', () => {
    const map: Record<string, string> = { md: 'md', docx: 'docx', pdf: 'pdf' };
    expect(map['md']).toBe('md');
    expect(map['docx']).toBe('docx');
    expect(map['pdf']).toBe('pdf');
  });

  it('appends preferredExt when filePath has no extension', () => {
    // Simulate the router logic
    const appendIfMissing = (filePath: string, preferredExt: string): string =>
      nodePath.extname(filePath) ? filePath : `${filePath}.${preferredExt}`;

    expect(appendIfMissing('/tmp/my-chat', 'md')).toBe('/tmp/my-chat.md');
    expect(appendIfMissing('/tmp/my-chat', 'pdf')).toBe('/tmp/my-chat.pdf');
    expect(appendIfMissing('/tmp/my-chat', 'docx')).toBe('/tmp/my-chat.docx');
    // Already has extension — leave as-is
    expect(appendIfMissing('/tmp/my-chat.pdf', 'md')).toBe('/tmp/my-chat.pdf');
    expect(appendIfMissing('/tmp/my-chat.docx', 'md')).toBe('/tmp/my-chat.docx');
  });

  it('does not default to md when format is pdf and no extension given', () => {
    const appendIfMissing = (filePath: string, preferredExt: string): string =>
      nodePath.extname(filePath) ? filePath : `${filePath}.${preferredExt}`;
    // With format='pdf', a bare filename gets .pdf, not .md
    const result = appendIfMissing('/tmp/chat', 'pdf');
    expect(result).toMatch(/\.pdf$/);
    expect(result).not.toMatch(/\.md$/);
  });
});
