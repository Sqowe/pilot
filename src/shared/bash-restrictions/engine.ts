/**
 * @module shared/bash-restrictions/engine
 *
 * Pure, stateless decision engine for the bash trust/denylist restriction
 * system. This module has no side-effects and no module-level mutable state —
 * all inputs are explicit parameters.
 *
 * Both the Electron main process (via permission-rules-store.ts) and the pi
 * CLI extension (via pi-extensions/bash-restrictions/extension.ts) import
 * from here so the decision logic has a single source of truth.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The three possible outcomes of a bash permission check. */
export type BashDecision = 'allow' | 'ask' | null;

/**
 * The lists injected into the engine. Both consumers (app store and pi
 * extension config loader) pass this shape after sanitizing their own inputs.
 */
export interface BashCommandLists {
  trusted: string[];
  denied: string[];
}

// ---------------------------------------------------------------------------
// Helpers (exported so callers can unit-test them directly and so Phase 2's
// store wrapper can delegate without duplicating code)
// ---------------------------------------------------------------------------

/**
 * Split a shell command on unquoted operators `&&`, `||`, `;`, `|`.
 * Quoted substrings (single or double) are preserved intact so operators
 * inside quotes do not split the command.
 * Backslash-escaped characters outside of quotes are consumed verbatim so
 * that escaped operators (e.g. `echo foo\;bar`) are not treated as splits.
 */
export function splitBashSubCommands(command: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (quote) {
      buf += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        // Consume escaped next char verbatim inside double quotes.
        buf += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      i += 1;
      continue;
    }

    // Outside any quote: backslash escapes the next character verbatim so
    // operators like `;`, `|`, `&&`, `||` following a `\` are not splits.
    if (ch === '\\' && i + 1 < command.length) {
      buf += ch + command[i + 1];
      i += 2;
      continue;
    }

    // Two-char operators first so `&&` / `||` don't get eaten by the `|` branch.
    if (ch === '&' && command[i + 1] === '&') {
      parts.push(buf);
      buf = '';
      i += 2;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      parts.push(buf);
      buf = '';
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|') {
      parts.push(buf);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Internal regex builders (shared by the public helpers and the precompile
// step inside decideBashPermission to avoid constructing the same RegExp
// multiple times per decision call)
// ---------------------------------------------------------------------------

/** Build the right-boundary regex for a denylist pattern (no lookbehind). */
function _buildDenylistRe(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Right boundary not needed for flag patterns — `--force` intentionally
  // matches `--force-with-lease`. For word patterns, require a non-word char.
  const rightBoundary = pattern.startsWith('-') ? '' : '(?![A-Za-z0-9_])';
  // Use the `g` flag so exec() can iterate over multiple occurrences.
  return new RegExp(escaped + rightBoundary, 'gi');
}

/** Build the anchored prefix regex for a trusted pattern. */
function _buildTrustedPrefixRe(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped, 'i');
}

/**
 * Test `command` against a pre-built denylist regex.
 *
 * Implements the left word-boundary check without regex lookbehind — checks
 * the character before each match position manually — so the function is safe
 * on runtimes that pre-date ES2018 lookbehind support (older Node / Electron).
 */
function _testDenylistRe(re: RegExp, command: string): boolean {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const pos = match.index;
    // Left boundary: start-of-string is always a boundary; otherwise the
    // character immediately before the match must not be a word character.
    if (pos === 0 || !/[A-Za-z0-9_]/.test(command[pos - 1])) {
      return true;
    }
    // Guard against infinite loops on zero-length matches.
    if (match[0].length === 0) re.lastIndex++;
  }
  return false;
}

/**
 * Check whether `command` starts with `pattern`, where `*` is a wildcard for
 * any character sequence. Anchored at the start of the command; matching is
 * case-insensitive to stay consistent with the rest of the rule engine.
 */
export function matchesTrustedPrefix(pattern: string, command: string): boolean {
  if (!pattern.trim()) return false;
  return _buildTrustedPrefixRe(pattern).test(command);
}

/**
 * Match a denylist pattern against a sub-command using word-boundary
 * semantics. The pattern matches only when it appears as a distinct "word"
 * in the command — i.e. not surrounded by alphanumeric or underscore
 * characters on either side.
 *
 * This prevents false positives like `rm` matching inside `formats` or
 * `markdown`, while still catching `rm -rf`, `sudo rm`, `(rm ...)`,
 * `/usr/bin/rm`, etc.
 *
 * For patterns that start with `-` (like `--force`), the boundary is
 * checked only on the left side since flags naturally run into their values
 * without a word boundary on the right (e.g. `--force-with-lease` should
 * still match `--force`).
 *
 * The left boundary is implemented without regex lookbehind (manual index
 * check) to stay compatible with runtimes that pre-date ES2018 lookbehind.
 *
 * Case-insensitive to stay consistent with the rest of the rule engine.
 */
export function matchesDenylistPattern(pattern: string, command: string): boolean {
  if (!pattern.trim()) return false;
  return _testDenylistRe(_buildDenylistRe(pattern), command);
}

/**
 * Shell metacharacters the simple splitter below cannot safely parse. If any
 * of these appear in an *evaluating* context we fail closed — returning null
 * from `decideBashPermission` so the caller falls through to the default
 * rule (normally `ask`). Specifically:
 *   - newline separators (`\n`, `\r`) — chain commands without `;`
 *   - single `&` background operator (distinct from `&&` handled below,
 *     and from the file-descriptor redirection forms `N>&`, `N<&`, `&>`,
 *     `&>>`, which this check recognizes and allows — they don't spawn a
 *     subshell or chain a second command, they just duplicate FDs)
 *   - backticks and `$(...)` command substitution — a trusted outer command
 *     could still execute an untrusted inner payload. Bash expands these
 *     inside double quotes too, so we keep scanning for them while the
 *     scanner is in double-quote mode; only single quotes are fully inert.
 *     `$((expr))` arithmetic expansion is explicitly allowed (no subshell).
 *   - process substitution `<(...)` / `>(...)` — bash forks a subshell for
 *     the inner command; detect outside quotes (inside quotes they are
 *     literal).
 *   - subshell grouping `(...)` in a command-start position — a `(` that
 *     opens a subshell rather than appearing as a quoted argument. Detected
 *     when `(` is the first non-whitespace token after the start of the
 *     string or after an operator (`&&`, `||`, `;`, `|`).
 *     `((...))` arithmetic evaluation is explicitly allowed (no subshell).
 *   - unclosed quotes — parsing is ambiguous; refuse to decide
 *
 * This check runs before splitting so compound strings like
 * `npm install\nrm -rf /`, `echo $(rm -rf /)`, `echo "$(rm -rf /)"`, and
 * `cat <(rm -rf /)` can never be auto-allowed.
 */
export function containsUnsupportedShellSyntax(command: string): boolean {
  let quote: '"' | "'" | null = null;
  let i = 0;
  // True at the start of the string and immediately after any command
  // separator (`&&`, `||`, `;`, `|`) plus optional whitespace.  Used to
  // distinguish a subshell-opening `(` from a literal `(` in an argument.
  let atCommandStart = true;

  /**
   * True when the `&` at position `i` is part of a file-descriptor
   * redirection, not the background operator. Handles both leading and
   * trailing forms:
   *   - `&>` / `&>>` — "redirect both stdout and stderr to file" shorthand
   *   - `N>&...` / `N<&...` — duplicate/close FD (N optional)
   */
  const isRedirectionAmp = (pos: number): boolean => {
    if (command[pos + 1] === '>') return true;
    let p = pos - 1;
    if (command[p] === '>' || command[p] === '<') return true;
    while (p >= 0 && command[p] >= '0' && command[p] <= '9') p -= 1;
    return command[p] === '>' || command[p] === '<';
  };

  while (i < command.length) {
    const ch = command[i];

    // Single quotes are fully inert — only look for the matching `'`.
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }

    // Double quotes are NOT inert: bash still expands `$(` and backticks
    // inside them, so we keep the danger checks on while in this state.
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        i += 2;
        continue;
      }
      if (ch === '`') return true;
      // $((expr)) is arithmetic expansion (safe); only flag $(cmd) substitution.
      if (ch === '$' && command[i + 1] === '(' && command[i + 2] !== '(') return true;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    // Outside any quote.
    if (ch === '"' || ch === "'") {
      quote = ch;
      atCommandStart = false;
      i += 1;
      continue;
    }
    // Backslash outside quotes escapes the next character verbatim — skip
    // both chars without interpreting the escaped char as a metacharacter or
    // updating atCommandStart based on it (e.g. `\;` is not a separator).
    if (ch === '\\' && i + 1 < command.length) {
      atCommandStart = false;
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') return true;
    if (ch === '`') return true;
    // $((expr)) is arithmetic expansion (safe); only flag $(cmd) substitution.
    if (ch === '$' && command[i + 1] === '(' && command[i + 2] !== '(') return true;
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') return true;
    // `(` at a command-start position: subshell unless `((` arithmetic command.
    if (ch === '(' && atCommandStart) {
      if (command[i + 1] === '(') {
        // ((...)) arithmetic evaluation — not a subshell; skip past `(('.
        atCommandStart = false;
        i += 2;
        continue;
      }
      return true;
    }
    if (ch === '&' && command[i + 1] === '&') {
      atCommandStart = true;
      i += 2;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      atCommandStart = true;
      i += 2;
      continue;
    }
    if (ch === '&') {
      if (isRedirectionAmp(i)) {
        i += 1;
        continue;
      }
      return true;
    }
    // `;` and single `|` are command separators — what follows is a new command.
    if (ch === ';' || ch === '|') {
      atCommandStart = true;
      i += 1;
      continue;
    }
    // Whitespace preserves the command-start state (the window between an
    // operator and the next real token is still "command start").
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    // Any other character: we are now inside a command token.
    atCommandStart = false;
    i += 1;
  }
  // Unclosed quote — ambiguous parse, refuse to auto-decide.
  return quote !== null;
}

// ---------------------------------------------------------------------------
// Core decision function
// ---------------------------------------------------------------------------

/**
 * Decide a bash command using the trust/deny lists.
 *
 * Policy model: **if either list is non-empty, the bash lists are
 * authoritative.** That is, once the user has opted in to list-based bash
 * control, every command is either explicitly trusted (`allow`), explicitly
 * denied (`ask`), or implicitly requires approval (`ask`).
 *
 *   - `'ask'`   — any sub-command matches a denylist substring; OR the
 *                 command uses shell syntax we can't safely parse; OR the
 *                 command isn't covered by the trust list (implicit ask).
 *   - `'allow'` — every sub-command matches a trusted prefix AND none
 *                 matched the denylist.
 *   - `null`    — both lists are empty (user hasn't opted in) or the
 *                 command string is empty. Callers fall through to their
 *                 own default rule in those cases.
 */
export function decideBashPermission(command: string, lists: BashCommandLists): BashDecision {
  if (!command) return null;

  // Defensively trim and filter empty/whitespace-only patterns. An empty
  // trusted pattern compiles to /^/i (matches everything) and an empty deny
  // pattern matches at index 0 (denies everything). Callers sanitize their
  // own inputs, but this engine is the shared source of truth and may receive
  // unsanitized lists across IPC boundaries.
  const trustedPatterns = lists.trusted.map((s) => s.trim()).filter(Boolean);
  const deniedPatterns = lists.denied.map((s) => s.trim()).filter(Boolean);
  if (trustedPatterns.length === 0 && deniedPatterns.length === 0) return null;

  // Fail closed on shell syntax the splitter cannot handle safely.
  if (containsUnsupportedShellSyntax(command)) {
    return 'ask';
  }

  const subs = splitBashSubCommands(command);
  // An otherwise-empty command after splitting (e.g. `   ;   `) still
  // triggers authoritative mode — require manual approval.
  if (subs.length === 0) return 'ask';

  // Precompile patterns once to avoid repeated RegExp construction per
  // sub-command (avoids O(n×m) regex allocation with larger lists).
  const deniedRes = deniedPatterns.map(_buildDenylistRe);
  const trustedRes = trustedPatterns.map(_buildTrustedPrefixRe);

  let allTrusted = true;
  for (const sub of subs) {
    if (deniedRes.some((re) => _testDenylistRe(re, sub))) {
      return 'ask';
    }
    if (!trustedRes.some((re) => re.test(sub))) {
      allTrusted = false;
    }
  }
  return allTrusted ? 'allow' : 'ask';
}
