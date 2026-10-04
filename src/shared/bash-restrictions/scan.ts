/**
 * @module shared/bash-restrictions/scan
 *
 * The single reader of a bash command's text. Everything the restriction engine
 * needs to know about a command — whether it can be read safely, where its
 * sub-commands begin and end, which words and redirections each one has — comes
 * from one pass here, so the syntax guard, the splitter and the write-target
 * check can never disagree about what the command says.
 *
 * Pure: no side effects, no module-level state, no imports.
 *
 * THE PROPERTY TO HOLD: text the shell executes must never be classified as
 * inert. Inert regions are exactly single-quoted strings, the bodies of
 * here-documents with a quoted delimiter, and dropped comment lines. When the
 * scanner is unsure, it reports the command as unsupported and the engine asks.
 *
 * See docs/design/trusted-directories.md §5.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One piece of a shell word, in the order written. */
export type WordSegment =
  /** Characters whose value is known: quotes removed, escapes resolved. */
  | { kind: 'literal'; text: string }
  /** An unquoted `~` at the start of the word that stands for the home directory. */
  | { kind: 'tilde' }
  /** `$NAME` or `${NAME}`. */
  | { kind: 'variable'; name: string }
  /** Anything whose value cannot be known from the text (globs, other expansions). */
  | { kind: 'dynamic' };

export interface ScannedWord {
  segments: WordSegment[];
}

export type RedirectKind =
  /** Writes (or may write) a file: `>`, `>>`, `&>`, `&>>`, `<>`, `>&file`. */
  | 'out'
  /** Reads a file or duplicates an input descriptor: `<`, `<&`. */
  | 'in'
  /** Duplicates or closes a descriptor: `N>&M`, `N>&-`. Touches no file. */
  | 'dup'
  /** `<<` / `<<-`; the body is data. */
  | 'heredoc'
  /** `<<<`; the word is data. */
  | 'herestring';

export interface ScannedRedirect {
  kind: RedirectKind;
  operator: string;
  /** The word after the operator; null when it is missing. */
  target: ScannedWord | null;
}

export type SubCommandJoin = 'start' | '&&' | '||' | ';' | '|' | 'newline';

export interface ScannedSubCommand {
  /** The sub-command as written, trimmed, with its here-document bodies appended. */
  text: string;
  /** How it is joined to the sub-command before it. */
  joinedBy: SubCommandJoin;
  /** Command words in order; redirection targets are not included. */
  words: ScannedWord[];
  redirects: ScannedRedirect[];
}

export interface ScanResult {
  /**
   * Why the command cannot be read safely, or null. A non-null value means the
   * engine must ask; `subCommands` is then a best-effort split only.
   */
  unsupported: string | null;
  subCommands: ScannedSubCommand[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_PARAMETER = /[0-9?$!#*@-]/;
const HEREDOC_DELIMITER = /^[A-Za-z0-9_.-]+$/;

/** Characters that end a word outside quotes. */
function isWordBreak(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === ';' ||
    ch === '&' ||
    ch === '|' ||
    ch === '<' ||
    ch === '>'
  );
}

/**
 * `text[open]` and `text[open + 1]` are `((`. Returns the index just past the
 * closing `))` when the construct is a well-formed arithmetic expression on one
 * line, or -1 when it is not.
 *
 * Bash only treats `$((…))` / `((…))` as arithmetic when it closes with `))`;
 * otherwise the same characters are a command substitution or subshell holding
 * another subshell — `$((cmd) | other)` runs `cmd`. Returning -1 makes the
 * caller refuse to read the command.
 */
function arithmeticEnd(text: string, open: number): number {
  let depth = 2;
  let j = open + 2;
  while (j < text.length) {
    const c = text[j];
    if (c === '\n') return -1;
    if (c === "'") {
      const close = text.indexOf("'", j + 1);
      if (close === -1) return -1;
      j = close + 1;
      continue;
    }
    if (c === '"') {
      let k = j + 1;
      while (k < text.length && text[k] !== '"') k += text[k] === '\\' ? 2 : 1;
      if (k >= text.length) return -1;
      j = k + 1;
      continue;
    }
    if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      if (depth === 2) return text[j + 1] === ')' ? j + 2 : -1;
      depth -= 1;
    }
    j += 1;
  }
  return -1;
}

interface DollarRead {
  /** Characters consumed, starting at the `$`. */
  length: number;
  segment: WordSegment;
  /** `$(` that is not arithmetic: a command substitution. */
  substitution?: boolean;
  /** Index of the first `(` of `$((`, for the arithmetic check. */
  arithmeticAt?: number;
  /** `${` that is not the simple `${NAME}` form. */
  opensBrace?: boolean;
  /**
   * `$'…'` (ANSI-C quoting) or `$"…"` (locale quoting). The shell rewrites the
   * string before using it — `$'/etc/hosts'` IS `/etc/hosts` — so reading it as
   * a `$` followed by a quoted string would invent a path the shell never uses.
   */
  dollarQuote?: boolean;
}

/**
 * Read the expansion that starts at `text[i] === '$'`.
 *
 * `inDoubleQuotes`: inside a double-quoted string `$'` and `$"` are not special
 * (a literal `$`, then an ordinary character or the closing quote).
 */
function readDollar(text: string, i: number, inDoubleQuotes: boolean): DollarRead {
  const next = text[i + 1];
  if (!inDoubleQuotes && (next === "'" || next === '"')) {
    return { length: 1, segment: { kind: 'dynamic' }, dollarQuote: true };
  }
  if (next === '(') {
    if (text[i + 2] === '(')
      return { length: 3, segment: { kind: 'dynamic' }, arithmeticAt: i + 1 };
    return { length: 2, segment: { kind: 'dynamic' }, substitution: true };
  }
  if (next === '{') {
    let j = i + 2;
    if (j < text.length && NAME_START.test(text[j])) {
      while (j < text.length && NAME_CHAR.test(text[j])) j += 1;
      if (text[j] === '}') {
        return { length: j + 1 - i, segment: { kind: 'variable', name: text.slice(i + 2, j) } };
      }
    }
    return { length: 2, segment: { kind: 'dynamic' }, opensBrace: true };
  }
  if (next !== undefined && NAME_START.test(next)) {
    let j = i + 1;
    while (j < text.length && NAME_CHAR.test(text[j])) j += 1;
    return { length: j - i, segment: { kind: 'variable', name: text.slice(i + 1, j) } };
  }
  if (next !== undefined && SPECIAL_PARAMETER.test(next)) {
    return { length: 2, segment: { kind: 'dynamic' } };
  }
  return { length: 1, segment: { kind: 'literal', text: '$' } };
}

/**
 * True when a here-document body with an unquoted delimiter contains something
 * the shell would execute while expanding it.
 */
function bodyRunsCommands(body: string): boolean {
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      i += 2;
      continue;
    }
    if (ch === '`') return true;
    if (ch === '$' && body[i + 1] === '(') {
      if (body[i + 2] !== '(') return true;
      if (arithmeticEnd(body, i + 1) === -1) return true;
    }
    i += 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

interface PendingHereDoc {
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
  owner: ScannedSubCommand;
}

/**
 * Read a bash command once and report its structure.
 *
 * Scanning never stops early: when something cannot be read safely the reason
 * is recorded in `unsupported` and the rest is still split on a best-effort
 * basis, so callers that only want the pieces (`splitBashSubCommands`) keep
 * working.
 */
export function scanBashCommand(command: string): ScanResult {
  const len = command.length;
  const subCommands: ScannedSubCommand[] = [];
  let unsupported: string | null = null;
  const flag = (reason: string): void => {
    if (unsupported === null) unsupported = reason;
  };

  let current: ScannedSubCommand = { text: '', joinedBy: 'start', words: [], redirects: [] };
  let buf = '';

  // The word being built outside or across quotes; null between words.
  let word: WordSegment[] | null = null;
  // True when the word so far contains a quote or an escape (so `"2">f` is not an fd prefix).
  let wordQuoted = false;
  // A redirection operator waiting for its target word.
  let pending: { kind: RedirectKind | 'out-or-dup'; operator: string } | null = null;

  let hereDocs: PendingHereDoc[] = [];
  // True at the start of the command and after a separator, until a token is seen.
  let atCommandStart = true;
  // True at the start of the command and right after a separator line break.
  let lineStart = true;
  let sawLineBreak = false;
  // Index just past the `))` of the arithmetic construct being read, or -1.
  let arithmeticUntil = -1;
  // Nesting of `${` … `}` outside quotes.
  let braceDepth = 0;

  const addLiteral = (text: string): void => {
    if (word === null) word = [];
    const last = word[word.length - 1];
    if (last && last.kind === 'literal') last.text += text;
    else word.push({ kind: 'literal', text });
  };
  const addSegment = (segment: WordSegment): void => {
    if (segment.kind === 'literal') {
      addLiteral(segment.text);
      return;
    }
    if (word === null) word = [];
    word.push(segment);
  };

  const endWord = (): void => {
    if (word === null) return;
    const finished: ScannedWord = { segments: word };
    word = null;
    wordQuoted = false;
    if (pending === null) {
      current.words.push(finished);
      return;
    }
    let kind: RedirectKind;
    if (pending.kind === 'out-or-dup') {
      const only = finished.segments.length === 1 ? finished.segments[0] : undefined;
      const isDescriptor = only?.kind === 'literal' && /^(?:\d+|-)$/.test(only.text);
      kind = isDescriptor ? 'dup' : 'out';
    } else {
      kind = pending.kind;
    }
    current.redirects.push({ kind, operator: pending.operator, target: finished });
    pending = null;
  };

  const finishSubCommand = (nextJoin: SubCommandJoin): void => {
    endWord();
    if (pending !== null) {
      // An operator with no word after it: the target cannot be determined.
      const kind: RedirectKind = pending.kind === 'out-or-dup' ? 'out' : pending.kind;
      current.redirects.push({ kind, operator: pending.operator, target: null });
      pending = null;
    }
    current.text = buf.trim();
    if (current.text.length > 0) subCommands.push(current);
    current = { text: '', joinedBy: nextJoin, words: [], redirects: [] };
    buf = '';
    atCommandStart = true;
  };

  /** A redirection operator begins: a bare number directly before it is its descriptor. */
  const beginRedirect = (kind: RedirectKind | 'out-or-dup', operator: string): void => {
    const only = word !== null && word.length === 1 ? word[0] : undefined;
    if (!wordQuoted && only?.kind === 'literal' && /^\d+$/.test(only.text)) {
      word = null;
    } else {
      endWord();
    }
    if (pending !== null) {
      const stale: RedirectKind = pending.kind === 'out-or-dup' ? 'out' : pending.kind;
      current.redirects.push({ kind: stale, operator: pending.operator, target: null });
    }
    pending = { kind, operator };
    buf += operator;
    atCommandStart = false;
  };

  /** Consume the here-document bodies that follow the line break at `from - 1`. */
  const readHereDocBodies = (from: number): number => {
    let pos = from;
    for (const doc of hereDocs) {
      const bodyStart = pos;
      let bodyEnd = -1;
      while (pos <= len) {
        const eol = command.indexOf('\n', pos);
        const lineEnd = eol === -1 ? len : eol;
        const line = command.slice(pos, lineEnd);
        const candidate = doc.stripTabs ? line.replace(/^\t+/, '') : line;
        if (candidate === doc.delimiter) {
          bodyEnd = pos;
          pos = eol === -1 ? len : eol + 1;
          break;
        }
        if (eol === -1) {
          pos = len;
          break;
        }
        pos = eol + 1;
      }
      if (bodyEnd === -1) {
        flag('a here-document has no terminating line');
        doc.owner.text += `\n${command.slice(bodyStart)}`;
        pos = len;
        continue;
      }
      const body = command.slice(bodyStart, bodyEnd);
      if (!doc.quoted && bodyRunsCommands(body)) {
        flag('command substitution inside a here-document');
      }
      doc.owner.text += `\n${body}${doc.delimiter}`;
    }
    hereDocs = [];
    return pos;
  };

  let i = 0;
  while (i < len) {
    const ch = command[i];

    // --- Comment lines ------------------------------------------------------
    if (lineStart) {
      lineStart = false;
      let j = i;
      while (j < len && (command[j] === ' ' || command[j] === '\t')) j += 1;
      if (command[j] === '#') {
        const eol = command.indexOf('\n', j);
        // A one-line command keeps its historic treatment: `#` is ordinary text.
        if (sawLineBreak || eol !== -1) {
          i = eol === -1 ? len : eol;
          continue;
        }
      }
    }

    // --- Quotes -------------------------------------------------------------
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? len : close + 1;
      if (close === -1) flag('an unclosed quote');
      buf += command.slice(i, end);
      addLiteral(command.slice(i + 1, close === -1 ? len : close));
      wordQuoted = true;
      atCommandStart = false;
      i = end;
      continue;
    }

    if (ch === '"') {
      buf += ch;
      if (word === null) word = [];
      wordQuoted = true;
      atCommandStart = false;
      i += 1;
      let closed = false;
      let quoteArithmeticUntil = -1;
      while (i < len) {
        const q = command[i];
        if (q === '\\' && i + 1 < len) {
          const escaped = command[i + 1];
          buf += q + escaped;
          // Inside double quotes a backslash only escapes $ ` " \ and the line break.
          if (escaped === '\n') {
            // line continuation: both characters disappear
          } else if (escaped === '$' || escaped === '`' || escaped === '"' || escaped === '\\') {
            addLiteral(escaped);
          } else {
            addLiteral(q + escaped);
          }
          i += 2;
          continue;
        }
        if (q === '"') {
          buf += q;
          i += 1;
          closed = true;
          break;
        }
        if (q === '`') {
          flag('command substitution');
          buf += q;
          addSegment({ kind: 'dynamic' });
          i += 1;
          continue;
        }
        if (q === '$') {
          const read = readDollar(command, i, true);
          if (read.substitution) flag('command substitution');
          if (read.arithmeticAt !== undefined) {
            const end = arithmeticEnd(command, read.arithmeticAt);
            if (end === -1) flag('command substitution');
            else quoteArithmeticUntil = Math.max(quoteArithmeticUntil, end);
          }
          buf += command.slice(i, i + read.length);
          addSegment(read.segment);
          i += read.length;
          continue;
        }
        buf += q;
        addLiteral(q);
        i += 1;
      }
      if (!closed) flag('an unclosed quote');
      else if (quoteArithmeticUntil > i) flag('command substitution');
      continue;
    }

    // --- Backslash outside quotes --------------------------------------------
    if (ch === '\\' && i + 1 < len) {
      const escaped = command[i + 1];
      buf += ch + escaped;
      if (escaped !== '\n') {
        // The escaped character is an ordinary part of the word.
        addLiteral(escaped);
        wordQuoted = true;
        atCommandStart = false;
      }
      // A backslash before a line break joins the lines; the word state is unchanged.
      i += 2;
      continue;
    }

    const inArithmetic = i < arithmeticUntil;

    // --- Line break -----------------------------------------------------------
    if (ch === '\n') {
      if (braceDepth > 0) flag('a line break inside ${ }');
      sawLineBreak = true;
      finishSubCommand('newline');
      i = hereDocs.length > 0 ? readHereDocBodies(i + 1) : i + 1;
      lineStart = true;
      continue;
    }
    if (ch === '\r') {
      flag('a carriage return');
      endWord();
      buf += ch;
      i += 1;
      continue;
    }

    // --- Command substitution ---------------------------------------------------
    if (ch === '`') {
      flag('command substitution');
      buf += ch;
      addSegment({ kind: 'dynamic' });
      atCommandStart = false;
      i += 1;
      continue;
    }

    if (ch === '$') {
      const read = readDollar(command, i, false);
      if (read.dollarQuote) {
        flag('$\'…\' or $"…" quoting');
        if (command[i + 1] === "'") {
          // Consume the whole `$'…'` here: inside it a backslash escapes the next
          // character, so `\'` does not end the string as it would in plain quotes.
          let j = i + 2;
          while (j < len && command[j] !== "'") j += command[j] === '\\' ? 2 : 1;
          const end = Math.min(j + 1, len);
          if (j >= len) flag('an unclosed quote');
          buf += command.slice(i, end);
          addSegment({ kind: 'dynamic' });
          wordQuoted = true;
          atCommandStart = false;
          i = end;
          continue;
        }
      }
      if (read.substitution) flag('command substitution');
      if (read.arithmeticAt !== undefined) {
        const end = arithmeticEnd(command, read.arithmeticAt);
        if (end === -1) flag('command substitution');
        else arithmeticUntil = Math.max(arithmeticUntil, end);
      }
      if (read.opensBrace) braceDepth += 1;
      buf += command.slice(i, i + read.length);
      addSegment(read.segment);
      atCommandStart = false;
      i += read.length;
      continue;
    }

    // --- Redirections -----------------------------------------------------------
    // A `<` or `>` directly followed by `(` is process substitution — or, after a
    // longer operator such as `>>(`, a syntax error. Either way: not readable.
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') {
      flag('process substitution');
      endWord();
      buf += ch;
      atCommandStart = false;
      i += 1;
      continue;
    }

    if ((ch === '<' || ch === '>') && !inArithmetic) {
      const redirect = (kind: RedirectKind | 'out-or-dup', operator: string): void => {
        const last = operator[operator.length - 1];
        const after = command[i + operator.length];
        if ((last === '<' || last === '>') && after === '(') flag('process substitution');
        // `>&&` / `<&&`: the shell reads `>&` then a stray `&` — a syntax error.
        if (last === '&' && after === '&') flag('the background operator &');
        beginRedirect(kind, operator);
        i += operator.length;
      };

      if (ch === '>') {
        if (command[i + 1] === '>') redirect('out', '>>');
        else if (command[i + 1] === '&') redirect('out-or-dup', '>&');
        else redirect('out', '>');
        continue;
      }
      // ch === '<'
      if (command[i + 1] === '<' && command[i + 2] === '<') {
        redirect('herestring', '<<<');
        continue;
      }
      if (command[i + 1] === '<') {
        // Here-document: read the delimiter word now; the body follows the line.
        const stripTabs = command[i + 2] === '-';
        let j = i + (stripTabs ? 3 : 2);
        while (j < len && (command[j] === ' ' || command[j] === '\t')) j += 1;
        let delimiter = '';
        let quoted = false;
        let malformed = false;
        while (j < len && !isWordBreak(command[j]) && command[j] !== '(' && command[j] !== ')') {
          const d = command[j];
          if (d === "'" || d === '"') {
            const close = command.indexOf(d, j + 1);
            if (close === -1) {
              malformed = true;
              j = len;
              break;
            }
            delimiter += command.slice(j + 1, close);
            quoted = true;
            j = close + 1;
            continue;
          }
          if (d === '\\' && j + 1 < len) {
            delimiter += command[j + 1];
            quoted = true;
            j += 2;
            continue;
          }
          delimiter += d;
          j += 1;
        }
        const only = word !== null && word.length === 1 ? word[0] : undefined;
        if (!wordQuoted && only?.kind === 'literal' && /^\d+$/.test(only.text)) word = null;
        else endWord();
        buf += command.slice(i, j);
        atCommandStart = false;
        current.redirects.push({
          kind: 'heredoc',
          operator: stripTabs ? '<<-' : '<<',
          target: null,
        });
        if (malformed || !HEREDOC_DELIMITER.test(delimiter)) {
          flag('a here-document delimiter that cannot be read');
        } else {
          if (hereDocs.length > 0) flag('more than one here-document on a line');
          hereDocs.push({ delimiter, stripTabs, quoted, owner: current });
        }
        i = j;
        continue;
      }
      if (command[i + 1] === '>') redirect('out', '<>');
      else if (command[i + 1] === '&') redirect('in', '<&');
      else redirect('in', '<');
      continue;
    }

    // --- Separators ----------------------------------------------------------------
    if (ch === '&') {
      if (command[i + 1] === '&') {
        finishSubCommand('&&');
        i += 2;
        continue;
      }
      if (command[i + 1] === '>') {
        const operator = command[i + 2] === '>' ? '&>>' : '&>';
        if (command[i + operator.length] === '(') flag('process substitution');
        beginRedirect('out', operator);
        i += operator.length;
        continue;
      }
      flag('the background operator &');
      endWord();
      buf += ch;
      atCommandStart = false;
      i += 1;
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        finishSubCommand('||');
        i += 2;
        continue;
      }
      finishSubCommand('|');
      i += 1;
      continue;
    }
    if (ch === ';') {
      finishSubCommand(';');
      i += 1;
      continue;
    }

    // --- Whitespace --------------------------------------------------------------------
    if (ch === ' ' || ch === '\t') {
      endWord();
      buf += ch;
      i += 1;
      continue;
    }

    // --- Parentheses ---------------------------------------------------------------------
    // Parentheses end a word, as in the shell — which matters for telling a
    // comment `#` (start of a word) from a `#` inside a word.
    if (ch === '(' || ch === ')') {
      endWord();
      if (ch === '(' && atCommandStart && !inArithmetic) {
        if (command[i + 1] === '(') {
          // `((…))` arithmetic command — unless it does not close with `))`.
          const end = arithmeticEnd(command, i);
          if (end === -1) flag('a subshell');
          else arithmeticUntil = Math.max(arithmeticUntil, end);
          buf += '((';
          atCommandStart = false;
          i += 2;
          continue;
        }
        flag('a subshell');
      }
      buf += ch;
      atCommandStart = false;
      i += 1;
      continue;
    }

    // --- Comments inside a line --------------------------------------------------------------
    if (ch === '#' && word === null && command.indexOf('\n', i) !== -1) {
      // A comment that is followed by more lines. Its text is not executed, but a
      // quote character inside it must not be allowed to hide those lines.
      flag('a comment inside a multi-line command');
    }

    // --- Ordinary characters -----------------------------------------------------------------
    buf += ch;
    atCommandStart = false;
    if (ch === '}' && braceDepth > 0) braceDepth -= 1;

    if (ch === '~' && word === null) {
      const after = command[i + 1];
      if (after === '/' || isWordBreak(after)) addSegment({ kind: 'tilde' });
      else addSegment({ kind: 'dynamic' });
    } else if (ch === '*' || ch === '?' || ch === '[' || ch === '{') {
      addSegment({ kind: 'dynamic' });
    } else {
      addLiteral(ch);
    }
    i += 1;
  }

  finishSubCommand('start');
  if (hereDocs.length > 0) flag('a here-document has no terminating line');

  return { unsupported, subCommands };
}
