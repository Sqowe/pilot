/**
 * Unit tests for the pure bash restriction engine.
 *
 * All tests exercise the 2-arg `decideBashPermission(command, lists)` form
 * directly — no module-level state, no IPC, no store. These cases are
 * ported from the store-level test suites (`bash-command-control.test.ts`,
 * `denylist-word-boundary.test.ts`) to the canonical pure API.
 */
import { describe, expect, it } from 'vitest';
import {
  containsUnsupportedShellSyntax,
  decideBashPermission,
  matchesDenylistPattern,
  matchesTrustedPrefix,
  splitBashSubCommands,
} from '../src/shared/bash-restrictions/engine';

// Convenience: call decideBashPermission with inline lists.
const decide = (cmd: string, trusted: string[], denied: string[]) =>
  decideBashPermission(cmd, { trusted, denied });

// ---------------------------------------------------------------------------
// splitBashSubCommands
// ---------------------------------------------------------------------------

describe('splitBashSubCommands', () => {
  it('returns the full command when no operators are present', () => {
    expect(splitBashSubCommands('npm install')).toEqual(['npm install']);
  });

  it('splits on && and trims whitespace', () => {
    expect(splitBashSubCommands('npm install && git status')).toEqual([
      'npm install',
      'git status',
    ]);
  });

  it('splits on all supported operators: && || ; |', () => {
    expect(splitBashSubCommands('a && b || c ; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not split on operators inside single quotes', () => {
    expect(splitBashSubCommands("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  it('does not split on operators inside double quotes', () => {
    expect(splitBashSubCommands('echo "a && b"')).toEqual(['echo "a && b"']);
  });

  it('handles escaped double-quote inside double quotes without breaking parsing', () => {
    expect(splitBashSubCommands('echo "a \\"b\\" && c"')).toEqual(['echo "a \\"b\\" && c"']);
  });

  it('drops empty segments produced by leading or trailing operators', () => {
    expect(splitBashSubCommands('; npm install ;')).toEqual(['npm install']);
  });

  it('returns an empty array for a blank command', () => {
    expect(splitBashSubCommands('   ')).toEqual([]);
  });

  it('does not split on a backslash-escaped semicolon outside quotes', () => {
    expect(splitBashSubCommands('echo foo\\;bar')).toEqual(['echo foo\\;bar']);
  });

  it('does not split on a backslash-escaped pipe outside quotes', () => {
    expect(splitBashSubCommands('echo foo\\|bar')).toEqual(['echo foo\\|bar']);
  });

  it('does not split on backslash-escaped && outside quotes', () => {
    // \& escapes the first & verbatim; the remaining lone & is not a split
    // operator (it's a background operator, caught by containsUnsupportedShellSyntax).
    expect(splitBashSubCommands('echo foo\\&&bar')).toEqual(['echo foo\\&&bar']);
  });
});

// ---------------------------------------------------------------------------
// matchesTrustedPrefix
// ---------------------------------------------------------------------------

describe('matchesTrustedPrefix', () => {
  it('matches when command starts with the exact pattern', () => {
    expect(matchesTrustedPrefix('npm install', 'npm install')).toBe(true);
  });

  it('matches when `*` expands to extra arguments', () => {
    expect(matchesTrustedPrefix('npm *', 'npm install --save-dev vitest')).toBe(true);
  });

  it('returns false when command does not match pattern prefix', () => {
    expect(matchesTrustedPrefix('git *', 'docker build .')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesTrustedPrefix('NPM *', 'npm install')).toBe(true);
  });

  it('treats `.` literally, not as regex any-char', () => {
    expect(matchesTrustedPrefix('./configure', 'a/configure')).toBe(false);
    expect(matchesTrustedPrefix('./configure', './configure --prefix=/opt')).toBe(true);
  });

  it('preserves `*` as wildcard despite literal escapes elsewhere', () => {
    expect(matchesTrustedPrefix('./build *', './build --release')).toBe(true);
    expect(matchesTrustedPrefix('./build *', 'xbuild --release')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchesDenylistPattern
// ---------------------------------------------------------------------------

describe('matchesDenylistPattern', () => {
  it('matches a standalone word', () => {
    expect(matchesDenylistPattern('rm', 'rm -rf /tmp')).toBe(true);
  });

  it('does NOT false-positive on "rm" inside "formats"', () => {
    expect(matchesDenylistPattern('rm', '--scrape-formats markdown')).toBe(false);
  });

  it('does NOT false-positive on "rm" inside "firmware"', () => {
    expect(matchesDenylistPattern('rm', 'cat firmware.bin')).toBe(false);
  });

  it('does NOT false-positive on "awk" inside "gawk" or "hawkish"', () => {
    expect(matchesDenylistPattern('awk', 'echo "hawkish behavior"')).toBe(false);
  });

  it('does NOT false-positive on "sudo" inside "pseudocode"', () => {
    expect(matchesDenylistPattern('sudo', 'echo "pseudocode example"')).toBe(false);
  });

  it('catches "rm" preceded by path separator', () => {
    expect(matchesDenylistPattern('rm', '/usr/bin/rm file.txt')).toBe(true);
  });

  it('catches "rm" preceded by open parenthesis', () => {
    expect(matchesDenylistPattern('rm', 'echo (rm -rf /)')).toBe(true);
  });

  it('catches "--force" flag in commands', () => {
    expect(matchesDenylistPattern('--force', 'git push --force')).toBe(true);
  });

  it('"--force" still matches "--force-with-lease" (flag prefix, right-boundary omitted)', () => {
    expect(matchesDenylistPattern('--force', 'git push --force-with-lease')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesDenylistPattern('RM', 'rm -rf /')).toBe(true);
  });

  it('does NOT false-positive on "rm" inside a camelCase identifier', () => {
    expect(matchesDenylistPattern('rm', 'echo "confirmDialog"')).toBe(false);
  });

  it('does NOT false-positive on "rm" inside word with underscore', () => {
    expect(matchesDenylistPattern('rm', 'echo "confirm_action"')).toBe(false);
  });

  it('never throws for any pattern / command combination (no lookbehind crash)', () => {
    const patterns = ['rm', '--force', 'sudo', 'awk', 'eval', '*'];
    const commands = ['rm -rf /', 'echo "test"', '', 'a'.repeat(500), '(subshell)'];
    for (const p of patterns) {
      for (const c of commands) {
        expect(() => matchesDenylistPattern(p, c)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// containsUnsupportedShellSyntax
// ---------------------------------------------------------------------------

describe('containsUnsupportedShellSyntax', () => {
  it('returns false for a plain command', () => {
    expect(containsUnsupportedShellSyntax('npm install')).toBe(false);
  });

  it('returns true on newline-separated commands', () => {
    expect(containsUnsupportedShellSyntax('npm install\nrm -rf /')).toBe(true);
  });

  it('returns true on carriage return', () => {
    expect(containsUnsupportedShellSyntax('npm install\rrm -rf /')).toBe(true);
  });

  it('returns true on single `&` background operator', () => {
    expect(containsUnsupportedShellSyntax('sleep 60 &')).toBe(true);
  });

  it('returns true on `$(...)` command substitution', () => {
    expect(containsUnsupportedShellSyntax('echo $(rm -rf /)')).toBe(true);
  });

  it('returns true on backtick command substitution', () => {
    expect(containsUnsupportedShellSyntax('echo `rm -rf /`')).toBe(true);
  });

  it('returns true on unclosed quotes', () => {
    expect(containsUnsupportedShellSyntax('npm install "oops')).toBe(true);
  });

  it('returns true on $(...) inside double quotes', () => {
    expect(containsUnsupportedShellSyntax('echo "$(rm -rf /)"')).toBe(true);
  });

  it('returns true on backticks inside double quotes', () => {
    expect(containsUnsupportedShellSyntax('echo "`rm -rf /`"')).toBe(true);
  });

  it('returns false for $(...) inside single quotes (fully inert)', () => {
    expect(containsUnsupportedShellSyntax("echo '$(rm -rf /)'")).toBe(false);
  });

  it('returns true on input process substitution `<(...)`', () => {
    expect(containsUnsupportedShellSyntax('cat <(rm -rf /)')).toBe(true);
  });

  it('returns true on output process substitution `>(...)`', () => {
    expect(containsUnsupportedShellSyntax('tee >(rm -rf /)')).toBe(true);
  });

  it('returns false for `<` and `>` used as plain redirections', () => {
    expect(containsUnsupportedShellSyntax('tee > /tmp/out')).toBe(false);
  });

  // --- FD-redirection forms ---

  it('allows `2>&1` stdout-to-stderr redirection', () => {
    expect(containsUnsupportedShellSyntax('firecrawl search "foo" 2>&1')).toBe(false);
  });

  it('allows `1>&2` stderr-to-stdout redirection', () => {
    expect(containsUnsupportedShellSyntax('echo boom 1>&2')).toBe(false);
  });

  it('allows `2>&-` to close stderr', () => {
    expect(containsUnsupportedShellSyntax('node script.js 2>&-')).toBe(false);
  });

  it('allows `&> file` combined redirection shorthand', () => {
    expect(containsUnsupportedShellSyntax('cmd args &> /tmp/out.log')).toBe(false);
  });

  it('allows `&>> file` append combined redirection shorthand', () => {
    expect(containsUnsupportedShellSyntax('cmd args &>> /tmp/out.log')).toBe(false);
  });

  it('allows `>&2` without a leading fd digit', () => {
    expect(containsUnsupportedShellSyntax('printf oops >&2')).toBe(false);
  });

  it('allows multi-digit fd redirections like `10>&11`', () => {
    expect(containsUnsupportedShellSyntax('exec 10>&11')).toBe(false);
  });

  it('still rejects a genuine lone `&` background operator', () => {
    expect(containsUnsupportedShellSyntax('sleep 60 &')).toBe(true);
  });

  it('still rejects `&` followed by a non-redirection char', () => {
    expect(containsUnsupportedShellSyntax('slow & echo done')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// containsUnsupportedShellSyntax — subshell grouping detection
// ---------------------------------------------------------------------------

describe('containsUnsupportedShellSyntax — subshell grouping', () => {
  it('returns true for a leading ( at start of command', () => {
    expect(containsUnsupportedShellSyntax('(rm -rf /)')).toBe(true);
  });

  it('returns true for ( after &&', () => {
    expect(containsUnsupportedShellSyntax('echo foo && (rm -rf /)')).toBe(true);
  });

  it('returns true for ( after ||', () => {
    expect(containsUnsupportedShellSyntax('false || (rm -rf /)')).toBe(true);
  });

  it('returns true for ( after ;', () => {
    expect(containsUnsupportedShellSyntax('echo foo; (rm -rf /)')).toBe(true);
  });

  it('returns true for ( after |', () => {
    expect(containsUnsupportedShellSyntax('echo foo | (cat)')).toBe(true);
  });

  it('returns true for ( with leading whitespace at start', () => {
    expect(containsUnsupportedShellSyntax('  (rm -rf /)')).toBe(true);
  });

  it('returns false for ( as an argument (not command-start position)', () => {
    // `echo (hi)` is a bash syntax error but not a subshell; ( is mid-token.
    expect(containsUnsupportedShellSyntax('echo (hi)')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// containsUnsupportedShellSyntax — backslash-escape outside quotes
// ---------------------------------------------------------------------------

describe('containsUnsupportedShellSyntax — backslash escapes outside quotes', () => {
  it('returns false for escaped $( — not command substitution', () => {
    expect(containsUnsupportedShellSyntax('echo \\$(date)')).toBe(false);
  });

  it('returns false for escaped backtick — not command substitution', () => {
    expect(containsUnsupportedShellSyntax('echo \\`date\\`')).toBe(false);
  });

  it('returns false for escaped semicolon — not a separator', () => {
    expect(containsUnsupportedShellSyntax('echo foo\\;bar')).toBe(false);
  });

  it('returns false for escaped ( at command start — not a subshell', () => {
    expect(containsUnsupportedShellSyntax('\\(not-a-subshell')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// containsUnsupportedShellSyntax — arithmetic expansion / evaluation
// ---------------------------------------------------------------------------

describe('containsUnsupportedShellSyntax — arithmetic expansion', () => {
  it('returns false for $((expr)) arithmetic expansion outside quotes', () => {
    expect(containsUnsupportedShellSyntax('echo $((1+2))')).toBe(false);
  });

  it('returns false for $((expr)) inside double quotes', () => {
    expect(containsUnsupportedShellSyntax('echo "result: $((x*2))"')).toBe(false);
  });

  it('returns true for $(cmd) command substitution (not arithmetic)', () => {
    expect(containsUnsupportedShellSyntax('echo $(date)')).toBe(true);
  });

  it('returns false for ((...)) arithmetic evaluation at command start', () => {
    expect(containsUnsupportedShellSyntax('((x++))')).toBe(false);
  });

  it('returns true for a true subshell (single parens) at command start', () => {
    expect(containsUnsupportedShellSyntax('(rm -rf /)')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decideBashPermission — empty / opt-in gate
// ---------------------------------------------------------------------------

describe('decideBashPermission — empty configuration', () => {
  it('returns null when both lists are empty (no opt-in)', () => {
    expect(decide('npm install', [], [])).toBeNull();
  });

  it('returns null for an empty command regardless of lists', () => {
    expect(decide('', ['npm *'], ['rm -rf'])).toBeNull();
  });

  it('returns null even for unsupported syntax when no lists are configured', () => {
    // Keeps pre-existing behaviour for users who have not opted in.
    expect(decide('echo $(date)', [], [])).toBeNull();
  });

  it('returns null when trusted list contains only empty/whitespace patterns', () => {
    expect(decide('npm install', ['', '   '], [])).toBeNull();
  });

  it('returns null when denied list contains only empty/whitespace patterns', () => {
    expect(decide('npm install', [], ['', '   '])).toBeNull();
  });

  it('trims and uses valid patterns when mixed with empty strings', () => {
    expect(decide('npm install', ['', '  npm *  '], [])).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// decideBashPermission — trust list (prefix match with * wildcard)
// ---------------------------------------------------------------------------

describe('decideBashPermission — trust list', () => {
  it('auto-allows an exact prefix match', () => {
    expect(decide('npm install', ['npm install'], [])).toBe('allow');
  });

  it('auto-allows when `*` expands to extra arguments', () => {
    expect(decide('npm install --save-dev vitest', ['npm *'], [])).toBe('allow');
  });

  it('returns ask when no trusted pattern matches (authoritative mode)', () => {
    expect(decide('docker build .', ['git *'], [])).toBe('ask');
  });

  it('matches trust list case-insensitively', () => {
    expect(decide('npm install', ['NPM *'], [])).toBe('allow');
  });

  it('auto-allows a compound command only when every sub-command is trusted', () => {
    expect(decide('npm install && git status', ['npm *', 'git *'], [])).toBe('allow');
  });

  it('returns ask for a compound where only some sub-commands are trusted', () => {
    expect(decide('npm install && rm -rf node_modules', ['npm *'], [])).toBe('ask');
  });

  it('an untrusted command returns ask even with a permissive trust list for other commands', () => {
    expect(decide('docker build .', ['npm *'], [])).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// decideBashPermission — denylist (word-boundary substring match)
// ---------------------------------------------------------------------------

describe('decideBashPermission — denylist', () => {
  it('forces ask when a denied word appears in the command', () => {
    expect(decide('rm -rf /tmp/cache', [], ['rm -rf'])).toBe('ask');
  });

  it('forces ask when a denied flag appears', () => {
    expect(decide('git push --force-with-lease origin main', [], ['--force'])).toBe('ask');
  });

  it('denylist is case-insensitive', () => {
    expect(decide('sudo npm install', [], ['SUDO'])).toBe('ask');
  });

  it('denylist in one sub-command taints the whole compound decision', () => {
    expect(decide('npm install && rm -rf node_modules', ['npm *'], ['rm -rf'])).toBe('ask');
  });

  it('does NOT false-positive on "rm" inside "formats" (full pipeline)', () => {
    const cmd =
      'firecrawl search "site:telex.hu Magyar Péter" --scrape --scrape-formats markdown -o .firecrawl/out.json --json 2>&1 | head -5';
    expect(decide(cmd, ['firecrawl *', 'head *'], ['rm', '--force', 'awk', 'sudo'])).toBe('allow');
  });

  it('does NOT false-positive on "awk" inside "hawkish"', () => {
    expect(decide('echo "hawkish behavior"', ['echo *'], ['awk'])).toBe('allow');
  });

  it('does NOT false-positive on "rm" inside "firmware"', () => {
    expect(decide('cat firmware.bin', ['cat *'], ['rm'])).toBe('allow');
  });

  it('does NOT false-positive on "sudo" inside "pseudocode"', () => {
    expect(decide('echo "pseudocode example"', ['echo *'], ['sudo'])).toBe('allow');
  });

  it('still catches "rm" as a command', () => {
    expect(decide('rm -rf /tmp', ['ls *'], ['rm'])).toBe('ask');
  });

  it('still catches "rm" after a pipe (sub-command level)', () => {
    expect(decide('ls /tmp | rm', ['ls *'], ['rm'])).toBe('ask');
  });

  it('still catches "rm" preceded by path separator', () => {
    expect(decide('/usr/bin/rm file.txt', ['*'], ['rm'])).toBe('ask');
  });

  it('catches "rm" preceded by open parenthesis', () => {
    expect(decide('echo (rm -rf /)', ['echo *'], ['rm'])).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// decideBashPermission — denylist beats trust
// ---------------------------------------------------------------------------

describe('decideBashPermission — denylist beats trust', () => {
  it('denies a command that matches both trust and deny', () => {
    expect(decide('git push --force', ['git *'], ['--force'])).toBe('ask');
  });

  it('denies even when the trust pattern is `*` (universal trust)', () => {
    expect(decide('rm -rf /', ['*'], ['rm -rf'])).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// decideBashPermission — unsupported shell syntax (fail-closed)
// ---------------------------------------------------------------------------

describe('decideBashPermission — unsupported shell syntax', () => {
  it('returns ask on newline-separated commands (never null)', () => {
    expect(decide('npm install\nrm -rf /', ['npm *'], [])).toBe('ask');
  });

  it('returns ask on single `&` background operator', () => {
    expect(decide('npm install & rm -rf /', ['npm *'], [])).toBe('ask');
  });

  it('returns ask on `$(...)` command substitution', () => {
    expect(decide('echo $(rm -rf /)', ['echo *'], [])).toBe('ask');
  });

  it('returns ask on backtick command substitution', () => {
    expect(decide('echo `rm -rf /`', ['echo *'], [])).toBe('ask');
  });

  it('returns ask on unclosed quotes', () => {
    expect(decide('npm install "oops', ['npm *'], [])).toBe('ask');
  });

  it('denylist still forces ask even when command uses unsupported syntax', () => {
    expect(decide('npm install\nrm -rf /', ['npm *'], ['rm -rf'])).toBe('ask');
  });

  it('returns ask on $(...) inside double quotes (bash still expands it)', () => {
    expect(decide('echo "$(rm -rf /)"', ['echo *'], [])).toBe('ask');
  });

  it('returns ask on backticks inside double quotes', () => {
    expect(decide('echo "`rm -rf /`"', ['echo *'], [])).toBe('ask');
  });

  it('treats $(...) inside single quotes as literal — allowed by trusted `echo *`', () => {
    // Single quotes are fully inert; `echo '$(rm -rf /)'` prints a literal string.
    expect(decide("echo '$(rm -rf /)'", ['echo *'], [])).toBe('allow');
  });

  it('returns ask on input process substitution `<(...)`', () => {
    expect(decide('cat <(rm -rf /)', ['cat *'], [])).toBe('ask');
  });

  it('returns ask on output process substitution `>(...)`', () => {
    expect(decide('tee >(rm -rf /)', ['tee *'], [])).toBe('ask');
  });

  it('allows `<` and `>` used as plain redirections (not process substitution)', () => {
    expect(decide('tee > /tmp/out', ['tee *'], [])).toBe('allow');
  });

  it('returns ask on subshell grouping at start of command', () => {
    expect(decide('(rm -rf /)', ['*'], [])).toBe('ask');
  });

  it('returns ask on subshell grouping after && even with universal trust', () => {
    expect(decide('echo foo && (rm -rf /)', ['*'], [])).toBe('ask');
  });

  it('returns ask on subshell grouping after ;', () => {
    expect(decide('echo foo; (rm -rf /)', ['echo *', '*'], [])).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// decideBashPermission — regex-safe pattern escaping
// ---------------------------------------------------------------------------

describe('decideBashPermission — regex-safe pattern escaping', () => {
  it('treats `.` in a pattern as a literal dot, not "any character"', () => {
    expect(decide('a/configure', ['./configure'], [])).toBe('ask');
    expect(decide('./configure --prefix=/opt', ['./configure'], [])).toBe('allow');
  });

  it('treats `(` and `)` in a pattern literally without throwing', () => {
    expect(() => decide('echo (hi)', ['echo (hi)'], [])).not.toThrow();
    expect(decide('echo (hi)', ['echo (hi)'], [])).toBe('allow');
  });

  it('treats `[`, `]`, `+`, `?` in a pattern literally without throwing', () => {
    expect(() => decide('tool[x] +?', ['tool[x] +?'], [])).not.toThrow();
    expect(decide('tool[x] +?', ['tool[x] +?'], [])).toBe('allow');
  });

  it('treats `$` and `{` / `}` literally without throwing', () => {
    expect(() => decide('printf ${A}', ['printf ${A}'], [])).not.toThrow();
    expect(decide('printf ${B}', ['printf ${A}'], [])).toBe('ask');
  });

  it('preserves `*` as wildcard despite literal escapes elsewhere', () => {
    expect(decide('./build --release', ['./build *'], [])).toBe('allow');
    expect(decide('xbuild --release', ['./build *'], [])).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// decideBashPermission — FD-redirection forms (authoritative mode)
// ---------------------------------------------------------------------------

describe('decideBashPermission — FD-redirection forms', () => {
  it('allows `2>&1` stdout-to-stderr redirection through the trust engine', () => {
    expect(decide('firecrawl search "foo" 2>&1', ['firecrawl *'], [])).toBe('allow');
  });

  it('allows `1>&2` stderr-to-stdout redirection', () => {
    expect(decide('echo boom 1>&2', ['echo *'], [])).toBe('allow');
  });

  it('allows `2>&-` to close stderr', () => {
    expect(decide('node script.js 2>&-', ['node *'], [])).toBe('allow');
  });

  it('allows `&> file` combined redirection shorthand', () => {
    expect(decide('cmd args &> /tmp/out.log', ['cmd *'], [])).toBe('allow');
  });

  it('allows `&>> file` append combined redirection shorthand', () => {
    expect(decide('cmd args &>> /tmp/out.log', ['cmd *'], [])).toBe('allow');
  });

  it('allows `>&2` without a leading fd digit', () => {
    expect(decide('printf oops >&2', ['printf *'], [])).toBe('allow');
  });

  it('allows multi-digit fd redirections like `10>&11`', () => {
    expect(decide('exec 10>&11', ['exec *'], [])).toBe('allow');
  });

  it('still rejects a genuine lone `&` background operator', () => {
    expect(decide('sleep 60 &', ['sleep *'], [])).toBe('ask');
  });

  it('still rejects command substitution that precedes `2>&1`', () => {
    expect(decide('echo $(rm -rf /) 2>&1', ['echo *'], [])).toBe('ask');
  });

  it('handles redirection inside a chained pipeline — each sub trusted → allow', () => {
    expect(decide('cat file.txt 2>&1 | head -100', ['cat *', 'head *'], [])).toBe('allow');
  });

  it('denylist still applies to commands that use `2>&1`', () => {
    expect(decide('firecrawl search "x" --force 2>&1', ['firecrawl *'], ['--force'])).toBe('ask');
  });
});
