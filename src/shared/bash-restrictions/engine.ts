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
 *
 * The command text is read in exactly one place — `scanBashCommand` in
 * `./scan` — so the syntax guard, the splitter and the write-target check
 * cannot disagree about what a command says.
 */
import { scanBashCommand } from './scan';

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

/** Why the command lists produced `ask`. Shown to the user in the prompt. */
export type BashAskReason =
  /** The command uses shell syntax the scanner cannot read safely. */
  | { kind: 'unsupported-syntax'; detail: string }
  /** A sub-command contains a denied pattern. */
  | { kind: 'denied'; pattern: string; subCommand: string }
  /** A sub-command matches no trusted pattern. */
  | { kind: 'not-trusted'; subCommand: string }
  /** Nothing is left to run after splitting (e.g. `   ;   `). */
  | { kind: 'empty' };

/** A decision together with the reason for an `ask`. */
export interface BashDecisionDetail {
  decision: BashDecision;
  reason?: BashAskReason;
}

// ---------------------------------------------------------------------------
// Helpers (exported so callers can unit-test them directly and so Phase 2's
// store wrapper can delegate without duplicating code)
// ---------------------------------------------------------------------------

/**
 * Split a shell command into its sub-commands: on the unquoted operators `&&`,
 * `||`, `;`, `|`, and on unquoted line breaks.
 *
 * Quoted substrings (single or double) are preserved intact so operators
 * inside quotes do not split the command. Backslash-escaped characters outside
 * of quotes are consumed verbatim so that escaped operators (e.g.
 * `echo foo\;bar`) are not treated as splits. A here-document body stays
 * attached to the sub-command that opened it, and comment lines are dropped.
 *
 * Thin wrapper over the scanner; see `./scan`.
 */
export function splitBashSubCommands(command: string): string[] {
  return scanBashCommand(command).subCommands.map((sub) => sub.text);
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
 * True when the command uses shell syntax the scanner cannot read safely. The
 * engine fails closed on these — `decideBashPermission` returns `'ask'`.
 *
 *   - backticks and `$(...)` command substitution — a trusted outer command
 *     could still execute an untrusted inner payload. Bash expands these
 *     inside double quotes too; only single quotes are fully inert.
 *     `$((expr))` arithmetic expansion is allowed, provided it really closes
 *     with `))` — `$((cmd) | other)` is a command substitution.
 *   - process substitution `<(...)` / `>(...)`.
 *   - subshell grouping `(...)` in a command-start position. `((...))`
 *     arithmetic evaluation is allowed, with the same `))` condition.
 *   - the single `&` background operator (distinct from `&&`, and from the
 *     redirection forms `N>&M`, `N<&M`, `&>`, `&>>`, which only move file
 *     descriptors).
 *   - a carriage return.
 *   - unclosed quotes.
 *   - a here-document with no terminating line, with a delimiter that cannot be
 *     read, or — when its delimiter is unquoted — with a command substitution
 *     in its body; more than one here-document on a line.
 *   - a comment that begins inside a line of a multi-line command, and a line
 *     break inside `${ }`.
 *
 * Line breaks themselves are NOT unsupported: an unquoted line break separates
 * commands exactly like `;`.
 *
 * Thin wrapper over the scanner; see `./scan`.
 */
export function containsUnsupportedShellSyntax(command: string): boolean {
  return scanBashCommand(command).unsupported !== null;
}

// ---------------------------------------------------------------------------
// Core decision function
// ---------------------------------------------------------------------------

/**
 * Decide a bash command using the trust/deny lists, and say why.
 *
 * Policy model: **if either list is non-empty, the bash lists are
 * authoritative.** That is, once the user has opted in to list-based bash
 * control, every command is either explicitly trusted (`allow`), explicitly
 * denied (`ask`), or implicitly requires approval (`ask`).
 *
 *   - `'ask'`   — any sub-command matches a denylist pattern; OR the
 *                 command uses shell syntax we can't safely read; OR the
 *                 command isn't covered by the trust list (implicit ask).
 *                 `reason` says which.
 *   - `'allow'` — every sub-command matches a trusted prefix AND none
 *                 matched the denylist.
 *   - `null`    — both lists are empty (user hasn't opted in) or the
 *                 command string is empty. Callers fall through to their
 *                 own default rule in those cases.
 *
 * Denylist patterns are matched against the whole text of a sub-command,
 * including the body of any here-document it opens.
 */
export function explainBashPermission(
  command: string,
  lists: BashCommandLists
): BashDecisionDetail {
  if (!command) return { decision: null };

  // Defensively trim and filter empty/whitespace-only patterns. An empty
  // trusted pattern compiles to /^/i (matches everything) and an empty deny
  // pattern matches at index 0 (denies everything). Callers sanitize their
  // own inputs, but this engine is the shared source of truth and may receive
  // unsanitized lists across IPC boundaries.
  const trustedPatterns = lists.trusted.map((s) => s.trim()).filter(Boolean);
  const deniedPatterns = lists.denied.map((s) => s.trim()).filter(Boolean);
  if (trustedPatterns.length === 0 && deniedPatterns.length === 0) return { decision: null };

  const scan = scanBashCommand(command);

  // Fail closed on shell syntax the scanner cannot read safely.
  if (scan.unsupported !== null) {
    return { decision: 'ask', reason: { kind: 'unsupported-syntax', detail: scan.unsupported } };
  }

  const subs = scan.subCommands.map((sub) => sub.text);
  // An otherwise-empty command after splitting (e.g. `   ;   `) still
  // triggers authoritative mode — require manual approval.
  if (subs.length === 0) return { decision: 'ask', reason: { kind: 'empty' } };

  // Precompile patterns once to avoid repeated RegExp construction per
  // sub-command (avoids O(n×m) regex allocation with larger lists).
  const deniedRes = deniedPatterns.map(_buildDenylistRe);
  const trustedRes = trustedPatterns.map(_buildTrustedPrefixRe);

  let firstUntrusted: string | null = null;
  for (const sub of subs) {
    const deniedIndex = deniedRes.findIndex((re) => _testDenylistRe(re, sub));
    if (deniedIndex !== -1) {
      return {
        decision: 'ask',
        reason: { kind: 'denied', pattern: deniedPatterns[deniedIndex], subCommand: sub },
      };
    }
    if (firstUntrusted === null && !trustedRes.some((re) => re.test(sub))) {
      firstUntrusted = sub;
    }
  }
  if (firstUntrusted !== null) {
    return { decision: 'ask', reason: { kind: 'not-trusted', subCommand: firstUntrusted } };
  }
  return { decision: 'allow' };
}

/**
 * Decide a bash command using the trust/deny lists.
 *
 * Same decision as `explainBashPermission`, without the reason. Kept as the
 * stable entry point for callers that only need `'allow' | 'ask' | null`.
 */
export function decideBashPermission(command: string, lists: BashCommandLists): BashDecision {
  return explainBashPermission(command, lists).decision;
}
