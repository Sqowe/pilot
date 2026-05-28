/**
 * Tests for EUR-Lex HTML-to-text extraction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../clients/eurlex.js';

describe('htmlToText', () => {
  it('strips HTML tags', () => {
    const html = '<p>Hello <strong>world</strong></p>';
    const text = htmlToText(html);
    assert.ok(text.includes('Hello world'));
  });

  it('converts block elements to newlines', () => {
    const html = '<p>First paragraph</p><p>Second paragraph</p>';
    const text = htmlToText(html);
    assert.ok(text.includes('First paragraph'));
    assert.ok(text.includes('Second paragraph'));
    // Should have a newline between them
    const lines = text.split('\n').filter((l) => l.trim());
    assert.ok(lines.length >= 2);
  });

  it('removes script and style blocks', () => {
    const html =
      '<p>Content</p><script>alert("xss")</script><style>.x{color:red}</style><p>More</p>';
    const text = htmlToText(html);
    assert.ok(text.includes('Content'));
    assert.ok(text.includes('More'));
    assert.ok(!text.includes('alert'));
    assert.ok(!text.includes('color'));
  });

  it('decodes HTML entities', () => {
    const html = '<p>A &amp; B &lt; C &gt; D &quot;E&quot; F&#39;s</p>';
    const text = htmlToText(html);
    assert.ok(text.includes('A & B < C > D "E" F\'s'));
  });

  it('normalizes whitespace', () => {
    const html = '<p>  Too   many    spaces  </p>';
    const text = htmlToText(html);
    assert.ok(!text.includes('  '));
  });

  it('handles empty input', () => {
    assert.equal(htmlToText(''), '');
  });

  it('handles a realistic EUR-Lex snippet', () => {
    const html = `
      <div id="TexteOnly">
        <p class="title">REGULATION (EU) 2024/1689</p>
        <p>Article 1</p>
        <p>Subject matter</p>
        <p>1. The purpose of this Regulation is to improve the functioning of the internal market.</p>
      </div>
    `;
    const text = htmlToText(html);
    assert.ok(text.includes('REGULATION (EU) 2024/1689'));
    assert.ok(text.includes('Article 1'));
    assert.ok(text.includes('internal market'));
  });
});
