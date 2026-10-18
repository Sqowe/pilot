import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Content split across MessageCard.tsx and the message/ sub-components directory
const messageCardPath = path.resolve(process.cwd(), 'src/renderer/components/MessageCard.tsx');
const messageMarkdownPath = path.resolve(
  process.cwd(),
  'src/renderer/components/MessageMarkdown.tsx'
);
const messageDir = path.resolve(process.cwd(), 'src/renderer/components/message');
const messageCardContent = [
  fs.readFileSync(messageCardPath, 'utf8'),
  ...fs.readdirSync(messageDir).map((f) => fs.readFileSync(path.join(messageDir, f), 'utf8')),
].join('\n');
const messageMarkdownContent = fs.readFileSync(messageMarkdownPath, 'utf8');

describe('MessageCard citation link normalization', () => {
  it('normalizes citation-style ~[title](url)~ to regular markdown links before render', () => {
    expect(messageCardContent).toContain('function normalizeCitationMarkdownLinks');
    expect(messageCardContent).toContain(
      "return markdown.replace(/~\\[(.+?)\\]\\(([^)\\s]+)\\)~/g, '[$1]($2)');"
    );
    // Math preparation runs last: it escapes stray `$` and must see the final markdown.
    expect(messageCardContent).toMatch(
      /normalizeLatexDelimiters\(\s*normalizeCitationMarkdownLinks\(normalizeLocalFileMarkdownLinks\(text\)\)\s*\)/
    );
  });

  it('disables remark-gfm single-tilde strikethrough parsing for safety', () => {
    expect(messageMarkdownContent).toContain('singleTilde: false');
    expect(messageMarkdownContent).toContain('REMARK_PLUGINS');
  });
});
