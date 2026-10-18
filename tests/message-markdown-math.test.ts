/**
 * Math in rendered messages, through the real MessageMarkdown and the same
 * text preparation the message view uses.
 *
 * KaTeX writes each formula twice: hidden MathML for screen readers and the
 * visible HTML. Its classes hide the first. If the sanitizer runs after KaTeX
 * it strips those classes and the MathML tags but keeps their text, so a
 * formula shows three times, without spaces — and prices like "$4.99 … $4.99"
 * that remark-math pairs into a formula look like words stuck together.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize from 'rehype-sanitize';
import { describe, expect, it } from 'vitest';
import { MessageMarkdown, REHYPE_PLUGINS } from '../src/renderer/components/MessageMarkdown';
import { normalizeLatexDelimiters } from '../src/renderer/utils/latex-delimiters';

const render = (text: string): string =>
  renderToStaticMarkup(
    createElement(MessageMarkdown, { normalizedText: normalizeLatexDelimiters(text) })
  );

describe('MessageMarkdown math', () => {
  it('sanitizes the model text first, then renders math with KaTeX', () => {
    const order = REHYPE_PLUGINS.map((plugin) => plugin[0]);
    expect(order).toEqual([rehypeSanitize, rehypeKatex]);
  });

  it('keeps the markup KaTeX needs to show an inline formula once', () => {
    const html = render('Formula $E = mc^2$ works.');
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-mathml"');
    expect(html).toContain('<math');
    expect(html.match(/class="katex-html"/g)).toHaveLength(1);
  });

  it('renders display math', () => {
    const html = render('Result:\n\n$$\n\\int_0^1 x\\,dx\n$$');
    expect(html).toContain('class="katex-display"');
  });

  it('renders \\(...\\) as math', () => {
    expect(render('Sum \\( x + y \\) here')).toContain('class="katex"');
  });

  it('leaves prices as text, with markdown inside them still applied', () => {
    const html = render(
      '$0.06/юзер/мес и **платёжные сборы**: ~6–10% с транзакции $4.99. Plus $4.99, VPN $3–13.'
    );
    expect(html).not.toContain('katex');
    expect(html).toContain('<strong>платёжные сборы</strong>');
    expect(html).toContain('$0.06/юзер/мес');
    expect(html).toContain('Plus $4.99, VPN $3–13.');
  });

  it('does not let a formula produce a link', () => {
    const html = render('Click $\\href{javascript:alert(1)}{here}$ now.');
    expect(html).not.toMatch(/<a\b/);
  });

  it('still strips unsafe links from the model text', () => {
    const html = render('[click](javascript:alert(1)) and $x$');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain('class="katex"');
  });
});
