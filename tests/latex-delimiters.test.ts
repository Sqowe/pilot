import { describe, expect, it } from 'vitest';
import { normalizeLatexDelimiters } from '../src/renderer/utils/latex-delimiters';

describe('normalizeLatexDelimiters', () => {
  // --- inline math ---
  it('converts \\(...\\) to $...$', () => {
    expect(normalizeLatexDelimiters('The value \\(x + y\\) is positive.')).toBe(
      'The value $x + y$ is positive.'
    );
  });

  it('handles multiple inline math on one line', () => {
    expect(normalizeLatexDelimiters('\\(a\\) and \\(b\\)')).toBe('$a$ and $b$');
  });

  // --- display math ---
  it('converts \\[...\\] to $$...$$', () => {
    expect(normalizeLatexDelimiters('Formula:\n\\[E = mc^2\\]')).toBe('Formula:\n$$E = mc^2$$');
  });

  it('handles multiline display math', () => {
    const input = '\\[\n  \\sum_{i=1}^{n} x_i\n\\]';
    const expected = '$$\n  \\sum_{i=1}^{n} x_i\n$$';
    expect(normalizeLatexDelimiters(input)).toBe(expected);
  });

  // --- code block protection ---
  it('does not convert delimiters inside fenced code blocks', () => {
    const input = '```\n\\(x\\)\n```';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('does not convert delimiters inside inline code', () => {
    const input = 'Use `\\(x\\)` for inline math.';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('converts outside code but preserves inside', () => {
    const input = '\\(a\\) and `\\(b\\)` and \\(c\\)';
    expect(normalizeLatexDelimiters(input)).toBe('$a$ and `\\(b\\)` and $c$');
  });

  // --- mixed content ---
  it('handles both inline and display math together', () => {
    const input = 'Inline \\(x\\) and display:\n\\[y = x^2\\]';
    const expected = 'Inline $x$ and display:\n$$y = x^2$$';
    expect(normalizeLatexDelimiters(input)).toBe(expected);
  });

  // --- edge cases ---
  it('returns empty string for empty input', () => {
    expect(normalizeLatexDelimiters('')).toBe('');
  });

  it('passes through text with no delimiters unchanged', () => {
    const input = 'Hello world, no math here.';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('leaves existing $...$ delimiters untouched', () => {
    const input = 'Already $x + y$ correct.';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('leaves existing $$...$$ delimiters untouched', () => {
    const input = '$$E = mc^2$$';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('protects code blocks with language specifier', () => {
    const input = '```python\nresult = \\(x\\)\n```';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('keeps \\(...\\) with inner spaces as math', () => {
    expect(normalizeLatexDelimiters('Sum \\( x + y \\) here')).toBe('Sum $ x + y $ here');
  });
});

// Pandoc's tex_math_dollars rule: the opening $ has a non-space right after it,
// the closing $ a non-space right before it and no digit right after it.
describe('normalizeLatexDelimiters — dollars that are not math', () => {
  it('escapes prices that remark-math would pair into one formula', () => {
    expect(
      normalizeLatexDelimiters('$4.99 за месяц (Mullvad €5, Proton Mail Plus $4.99, VPN $3–13).')
    ).toBe('\\$4.99 за месяц (Mullvad €5, Proton Mail Plus \\$4.99, VPN \\$3–13).');
    expect(normalizeLatexDelimiters('$0.06/юзер/мес и **сборы**: ~6–10% с транзакции $4.99.')).toBe(
      '\\$0.06/юзер/мес и **сборы**: ~6–10% с транзакции \\$4.99.'
    );
  });

  it('escapes price ranges: a closing $ may not be followed by a digit', () => {
    expect(normalizeLatexDelimiters('From $5-$10 or $5/$10.')).toBe(
      'From \\$5-\\$10 or \\$5/\\$10.'
    );
  });

  it('escapes a dollar written after the number', () => {
    expect(normalizeLatexDelimiters('От 5$ до 10$ в месяц.')).toBe('От 5\\$ до 10\\$ в месяц.');
  });

  it('escapes a price but keeps the formula next to it', () => {
    expect(normalizeLatexDelimiters('Costs $5 if $x > 2$.')).toBe('Costs \\$5 if $x > 2$.');
  });

  it('leaves real inline math untouched', () => {
    const input = 'Formula $E = mc^2$ and $a_i \\le 5$, also $\\$5 + x$.';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('does not treat $ x $ with inner spaces as math', () => {
    expect(normalizeLatexDelimiters('Spaced $ x $ here')).toBe('Spaced \\$ x \\$ here');
  });

  it('never pairs dollars across a line break', () => {
    expect(normalizeLatexDelimiters('- $5 a month\n- 10$ a year')).toBe(
      '- \\$5 a month\n- 10\\$ a year'
    );
  });

  it('pairs a prefix and a suffix dollar, as Pandoc does', () => {
    const input = 'Было $5, стало 10$.';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('leaves $$...$$ math and its contents untouched', () => {
    const input = 'Inline $$x^2$$ and\n\n$$\n\\text{cost} = 5$ \n$$';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('leaves dollars that are already escaped', () => {
    const input = 'Already \\$5 and \\$10.';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('escapes a price while the reply is still streaming', () => {
    expect(normalizeLatexDelimiters('Подписка стоит $4.99 и')).toBe('Подписка стоит \\$4.99 и');
  });

  it('does not touch dollars in code', () => {
    const input = [
      'Run `echo $HOME $PATH` or ``a ` $b``:',
      '```bash\nexport A=$HOME\necho "$A costs $5"\n```',
      '~~~\n$x and $y\n~~~',
      '```sh\necho $STILL_STREAMING',
    ].join('\n\n');
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('does not touch dollars in bare URLs and autolinks', () => {
    const input = 'See https://example.com/?a=$5&b=$6 or <https://example.com/$x> for $y';
    expect(normalizeLatexDelimiters(input)).toBe(
      'See https://example.com/?a=$5&b=$6 or <https://example.com/$x> for \\$y'
    );
  });
});
