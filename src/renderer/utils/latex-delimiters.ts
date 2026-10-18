/**
 * Prepare model text for remark-math. Run it last, right before the text is
 * rendered: it must see exactly the markdown that remark-math will parse.
 *
 * - Escape every single `$` that cannot delimit math under Pandoc's
 *   `tex_math_dollars` rule. remark-math pairs any two single dollars, like
 *   code spans, so "$4.99 … Plus $4.99" became one garbled formula.
 * - Convert LaTeX-standard delimiters to dollar-sign delimiters.
 *   remark-math only recognises $…$ / $$…$$, but many models emit \(…\) / \[…\].
 *
 * Code (fenced and inline) and URLs are preserved to avoid false conversions.
 */
export function normalizeLatexDelimiters(text: string): string {
  if (!text) return text;

  const preserved: string[] = [];
  // Use a long multi-char sentinel (NUL + SOH + tag + index + NUL) that is
  // highly unlikely to occur naturally in any model output.
  const OPEN = '\x00\x01LTX[';
  const CLOSE = ']\x01\x00';

  const protect = (m: string): string => {
    preserved.push(m);
    return `${OPEN}${preserved.length - 1}${CLOSE}`;
  };

  // 1. Protect fenced code blocks (``` or ~~~), including one still open while streaming
  let out = text.replace(FENCED_CODE, protect);

  // 2. Protect inline code (` … `, `` … ``)
  out = out.replace(INLINE_CODE, protect);

  // 3. Protect bare URLs and <autolinks>: markdown does not undo a backslash escape there
  out = out.replace(URL_LIKE, protect);

  // 4. Escape dollars that are not math delimiters. Before step 5, so that
  //    \( x \) with inner spaces still becomes math.
  out = escapeNonMathDollars(out);

  // 5. \(…\) → $…$  (inline math)
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_, c) => `$${c}$`);

  // 6. \[…\] → $$…$$ (display math, may span lines)
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_, c) => `$$${c}$$`);

  // 7. Restore protected blocks
  // eslint-disable-next-line no-control-regex
  out = out.replace(/\x00\x01LTX\[(\d+)\]\x01\x00/g, (_, i) => preserved[+i]);

  return out;
}

const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm;
// A backtick run, then the same run again, not crossing a blank line.
const INLINE_CODE = /(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])+?)(?<!`)\1(?!`)/g;
const URL_LIKE = /<[A-Za-z][\w+.-]{1,31}:[^\s<>]*>|\b(?:https?:\/\/|www\.)[^\s<>()]*/g;

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/**
 * Pandoc's rule: the opening `$` has a non-space right after it; the next
 * unescaped `$` closes it only if it has a non-space right before it and no
 * digit right after it — so "$20 and $30" is not math. Every single `$` that
 * is not part of such a pair becomes `\$`. Unlike Pandoc, a pair never spans
 * a line break: list items, table rows and headings are separate blocks.
 * Runs of two or more dollars ($$…$$) are left to remark-math.
 */
function escapeNonMathDollars(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c !== '$') {
      out += c;
      i++;
      continue;
    }

    let runEnd = i;
    while (s[runEnd] === '$') runEnd++;
    if (runEnd - i > 1) {
      const closing = s.indexOf(s.slice(i, runEnd), runEnd);
      const next = closing === -1 ? runEnd : closing + (runEnd - i);
      out += s.slice(i, next);
      i = next;
      continue;
    }

    const close = findClosingDollar(s, i);
    if (close === -1) {
      out += '\\$';
      i++;
    } else {
      out += s.slice(i, close + 1);
      i = close + 1;
    }
  }
  return out;
}

function findClosingDollar(s: string, open: number): number {
  if (isSpace(s[open + 1])) return -1;
  for (let j = open + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '$') {
      return s[j + 1] !== '$' && !isSpace(s[j - 1]) && !isDigit(s[j + 1]) ? j : -1;
    }
  }
  return -1;
}
