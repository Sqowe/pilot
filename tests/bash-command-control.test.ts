import { afterEach, describe, expect, it } from 'vitest';
import {
  decideBashPermission,
  decidePermission,
  forgetSessionPermissions,
  getBashCommandLists,
  rememberAlwaysAllow,
  setBashCommandLists,
  setPermissionRules,
  splitBashSubCommands,
} from '../src/main/config/permission-rules-store';

/**
 * Tests for the bash trust/deny layer in `permission-rules-store`.
 *
 * Since Phase 2 the store's `decideBashPermission(command)` is a 1-arg
 * wrapper that injects the module-level lists into the shared engine
 * (`src/shared/bash-restrictions/engine.ts`). These tests exercise that
 * wrapper boundary and codify the required semantics:
 *
 *   - empty command       → null  (short-circuit, no list check)
 *   - both lists empty    → null  (not opted-in; fall through to generic rules)
 *   - unsupported syntax  → 'ask' (fail-closed when lists are non-empty)
 *   - denylist precedence → 'ask' (beats trust list unconditionally)
 *   - fully trusted       → 'allow'
 *
 * The module keeps its state in module-level variables, so we reset both the
 * bash lists and the generic rules after every test to keep cases independent.
 */

afterEach(() => {
  setBashCommandLists([], []);
  // Restore defaults so `decidePermission` tests that expect 'ask' for bash
  // aren't poisoned by a prior test that changed the rules.
  setPermissionRules([]);
  // Clear any session-scoped "always allow" memory left over from tests that
  // exercise `rememberAlwaysAllow` — the store is a module-level singleton.
  forgetSessionPermissions('s1');
  forgetSessionPermissions('s2');
});

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
});

describe('decideBashPermission — empty configuration', () => {
  it('returns null when both lists are empty, so the default rule decides', () => {
    expect(decideBashPermission('npm install')).toBeNull();
  });

  it('returns null for an empty command regardless of lists', () => {
    setBashCommandLists(['npm *'], ['rm -rf']);
    expect(decideBashPermission('')).toBeNull();
  });

  it('returns null for unsupported shell syntax when lists are empty (falls through to generic rules)', () => {
    // With no lists configured the wrapper short-circuits before the engine,
    // so unsupported syntax does NOT force 'ask' — the generic rule decides.
    expect(decideBashPermission('echo $(rm -rf /)')).toBeNull();
  });

  it('returns ask for unsupported shell syntax when lists are non-empty (fail-closed)', () => {
    // Opt-in activates authoritative mode; the engine fails closed on
    // unsupported syntax regardless of what is trusted.
    setBashCommandLists(['echo *'], []);
    expect(decideBashPermission('echo $(rm -rf /)')).toBe('ask');
  });
});

describe('decideBashPermission — authoritative mode edge cases (non-empty lists)', () => {
  // These cases confirm the wrapper never falls through to null when authoritative
  // mode is active, even for inputs that are effectively empty after parsing.

  it('returns ask for whitespace-only command in authoritative mode', () => {
    setBashCommandLists(['npm *'], []);
    expect(decideBashPermission('   ')).toBe('ask');
  });

  it('returns ask for a bare semicolon in authoritative mode', () => {
    setBashCommandLists(['npm *'], []);
    expect(decideBashPermission(';')).toBe('ask');
  });

  it('returns ask for repeated separators in authoritative mode', () => {
    setBashCommandLists(['npm *'], []);
    expect(decideBashPermission(' ; ; ')).toBe('ask');
  });

  it('returns ask for operator-only input in authoritative mode', () => {
    setBashCommandLists(['npm *'], []);
    expect(decideBashPermission('&&')).toBe('ask');
  });

  it('returns allow for trailing operator when the prefix is trusted (trailing && is stripped by the splitter)', () => {
    // 'npm install &&' splits to ['npm install'] — matched by 'npm *' → allow.
    // The trailing empty segment is dropped by splitBashSubCommands.
    setBashCommandLists(['npm *'], []);
    expect(decideBashPermission('npm install &&')).toBe('allow');
  });
});

describe('decideBashPermission — trust list (prefix match with * wildcard)', () => {
  it('auto-allows an exact prefix match', () => {
    setBashCommandLists(['npm install'], undefined);
    expect(decideBashPermission('npm install')).toBe('allow');
  });

  it('auto-allows when `*` expands to extra arguments', () => {
    setBashCommandLists(['npm *'], undefined);
    expect(decideBashPermission('npm install --save-dev vitest')).toBe('allow');
  });

  it('returns ask when no trusted pattern matches (authoritative mode)', () => {
    setBashCommandLists(['git *'], undefined);
    expect(decideBashPermission('docker build .')).toBe('ask');
  });

  it('matches case-insensitively to stay consistent with the rest of the rule engine', () => {
    setBashCommandLists(['NPM *'], undefined);
    expect(decideBashPermission('npm install')).toBe('allow');
  });

  it('auto-allows a compound command only when every sub-command is trusted', () => {
    setBashCommandLists(['npm *', 'git *'], undefined);
    expect(decideBashPermission('npm install && git status')).toBe('allow');
  });

  it('returns ask for a compound where only some sub-commands are trusted', () => {
    setBashCommandLists(['npm *'], undefined);
    expect(decideBashPermission('npm install && rm -rf node_modules')).toBe('ask');
  });
});

describe('decideBashPermission — denylist (substring match)', () => {
  it('forces ask when a denied substring appears anywhere in the command', () => {
    setBashCommandLists(undefined, ['rm -rf']);
    expect(decideBashPermission('rm -rf /tmp/cache')).toBe('ask');
  });

  it('forces ask even when the denied substring is embedded in arguments', () => {
    setBashCommandLists(undefined, ['--force']);
    expect(decideBashPermission('git push --force-with-lease origin main')).toBe('ask');
  });

  it('matches case-insensitively', () => {
    setBashCommandLists(undefined, ['SUDO']);
    expect(decideBashPermission('sudo npm install')).toBe('ask');
  });

  it('denylist in one sub-command taints the whole decision', () => {
    setBashCommandLists(['npm *'], ['rm -rf']);
    expect(decideBashPermission('npm install && rm -rf node_modules')).toBe('ask');
  });
});

describe('decideBashPermission — denylist beats trust', () => {
  it('denies a command that matches both trust and deny', () => {
    setBashCommandLists(['git *'], ['--force']);
    expect(decideBashPermission('git push --force')).toBe('ask');
  });

  it('denies even when the trust pattern is `*` (universal trust)', () => {
    setBashCommandLists(['*'], ['rm -rf']);
    expect(decideBashPermission('rm -rf /')).toBe('ask');
  });
});

describe('decideBashPermission — unsupported shell syntax (fail-closed)', () => {
  it('asks when a command after a line break is not trusted (never null — must not reach generic allow)', () => {
    // A line break separates commands like `;`; `rm -rf /` matches no trusted pattern.
    setBashCommandLists(['npm *'], undefined);
    expect(decideBashPermission('npm install\nrm -rf /')).toBe('ask');
  });

  it('returns ask on single `&` background operator', () => {
    setBashCommandLists(['npm *'], undefined);
    expect(decideBashPermission('npm install & rm -rf /')).toBe('ask');
  });

  it('returns ask on `$(...)` command substitution', () => {
    setBashCommandLists(['echo *'], undefined);
    expect(decideBashPermission('echo $(rm -rf /)')).toBe('ask');
  });

  it('returns ask on backtick command substitution', () => {
    setBashCommandLists(['echo *'], undefined);
    expect(decideBashPermission('echo `rm -rf /`')).toBe('ask');
  });

  it('returns ask on unclosed quotes', () => {
    setBashCommandLists(['npm *'], undefined);
    expect(decideBashPermission('npm install "oops')).toBe('ask');
  });

  it('still forces ask from the denylist even when the command uses unsupported syntax', () => {
    setBashCommandLists(['npm *'], ['rm -rf']);
    expect(decideBashPermission('npm install\nrm -rf /')).toBe('ask');
  });

  // --- Regression tests for bash expansions that execute code inside quotes --

  it('returns ask on $(...) inside double quotes (bash still expands it)', () => {
    setBashCommandLists(['echo *'], undefined);
    expect(decideBashPermission('echo "$(rm -rf /)"')).toBe('ask');
  });

  it('returns ask on backticks inside double quotes', () => {
    setBashCommandLists(['echo *'], undefined);
    expect(decideBashPermission('echo "`rm -rf /`"')).toBe('ask');
  });

  it('denylist still catches dangerous substrings inside double-quoted substitution', () => {
    setBashCommandLists(['echo *'], ['rm -rf']);
    expect(decideBashPermission('echo "$(rm -rf /)"')).toBe('ask');
  });

  it('treats $(...) inside single quotes as literal and does not fail closed', () => {
    // Single quotes are fully inert in bash, so `echo '$(rm -rf /)'` just
    // prints the literal string. A trusted `echo *` may auto-allow this.
    setBashCommandLists(['echo *'], undefined);
    expect(decideBashPermission("echo '$(rm -rf /)'")).toBe('allow');
  });

  it('returns ask on input process substitution `<(...)`', () => {
    setBashCommandLists(['cat *'], undefined);
    expect(decideBashPermission('cat <(rm -rf /)')).toBe('ask');
  });

  it('returns ask on output process substitution `>(...)`', () => {
    setBashCommandLists(['tee *'], undefined);
    expect(decideBashPermission('tee >(rm -rf /)')).toBe('ask');
  });

  it('denylist still catches process substitution bypass attempts', () => {
    setBashCommandLists(['cat *'], ['rm -rf']);
    expect(decideBashPermission('cat <(rm -rf /)')).toBe('ask');
  });

  it('allows `<` and `>` used as redirections, not process substitution', () => {
    // Plain redirection has no `(` after the operator — safe to trust-evaluate.
    setBashCommandLists(['tee *'], undefined);
    expect(decideBashPermission('tee > /tmp/out')).toBe('allow');
  });

  it('returns null when both lists are empty even for unsupported syntax', () => {
    // Opt-in gate: users who have not configured either list should not see
    // new prompting for commands that previously went through the default
    // rule path unchanged.
    expect(decideBashPermission('echo $(date)')).toBeNull();
  });
});

describe('decideBashPermission — regex-safe pattern escaping', () => {
  // Regression tests for the fixed escape bug where regex metacharacters
  // inside trust patterns could produce invalid regex or incorrect matches.

  it('treats `.` in a pattern as a literal dot, not "any character"', () => {
    setBashCommandLists(['./configure'], undefined);
    // With broken escaping, `./configure` would match `a/configure` too; it must not.
    // In authoritative mode, a non-match is an implicit `ask`.
    expect(decideBashPermission('a/configure')).toBe('ask');
    expect(decideBashPermission('./configure --prefix=/opt')).toBe('allow');
  });

  it('treats `(` and `)` in a pattern literally without throwing', () => {
    setBashCommandLists(['echo (hi)'], undefined);
    expect(() => decideBashPermission('echo (hi)')).not.toThrow();
    expect(decideBashPermission('echo (hi)')).toBe('allow');
  });

  it('treats `[`, `]`, `+`, `?` in a pattern literally without throwing', () => {
    setBashCommandLists(['tool[x] +?'], undefined);
    expect(() => decideBashPermission('tool[x] +?')).not.toThrow();
    expect(decideBashPermission('tool[x] +?')).toBe('allow');
  });

  it('treats `$` and `{` / `}` literally without throwing', () => {
    setBashCommandLists(['printf ${A}'], undefined);
    expect(() => decideBashPermission('printf ${A}')).not.toThrow();
    // Exact literal match — different args are not trusted → ask.
    expect(decideBashPermission('printf ${B}')).toBe('ask');
  });

  it('preserves `*` as wildcard despite literal escapes elsewhere', () => {
    setBashCommandLists(['./build *'], undefined);
    expect(decideBashPermission('./build --release')).toBe('allow');
    expect(decideBashPermission('xbuild --release')).toBe('ask');
  });
});

describe('setBashCommandLists — sanitization and partial updates', () => {
  it('strips non-string entries and trims whitespace', () => {
    setBashCommandLists(['  npm *  ', 42, null, '', 'git *'], undefined);
    const { trusted } = getBashCommandLists();
    expect(trusted).toEqual(['npm *', 'git *']);
  });

  it('treats non-array inputs as empty lists', () => {
    setBashCommandLists('not-an-array' as unknown, { also: 'not-an-array' } as unknown);
    const { trusted, denied } = getBashCommandLists();
    expect(trusted).toEqual([]);
    expect(denied).toEqual([]);
  });

  it('leaves the other list unchanged when only one is provided (undefined semantics)', () => {
    setBashCommandLists(['npm *'], ['rm -rf']);
    setBashCommandLists(['git *'], undefined);
    const { trusted, denied } = getBashCommandLists();
    expect(trusted).toEqual(['git *']);
    expect(denied).toEqual(['rm -rf']);
  });

  it('clears a list when an empty array is explicitly passed', () => {
    setBashCommandLists(['npm *'], ['rm -rf']);
    setBashCommandLists([], undefined);
    const { trusted, denied } = getBashCommandLists();
    expect(trusted).toEqual([]);
    expect(denied).toEqual(['rm -rf']);
  });
});

describe('decidePermission — bash integration with the generic rule engine', () => {
  it('returns allow for bash when the trust list matches', () => {
    setBashCommandLists(['npm *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'ask' }]);
    expect(decidePermission('s1', 'bash', { command: 'npm install' })).toBe('allow');
  });

  it('returns ask for bash when the denylist matches, overriding the default rule', () => {
    setBashCommandLists(undefined, ['rm -rf']);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    // Denylist still wins even if a misconfigured rule would otherwise allow bash.
    expect(decidePermission('s1', 'bash', { command: 'rm -rf /tmp' })).toBe('ask');
  });

  it('when a trust list is configured, untrusted commands ask regardless of the generic rule', () => {
    // Authoritative mode: once the user opts in, the trust list is the
    // complete policy for bash. The generic `bash: ask` rule is redundant
    // here but kept for clarity — the list alone would still return `ask`.
    setBashCommandLists(['git *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'ask' }]);
    expect(decidePermission('s1', 'bash', { command: 'docker build .' })).toBe('ask');
  });

  it('does not apply bash logic to non-bash tools', () => {
    setBashCommandLists(['rm -rf'], undefined);
    setPermissionRules([{ tool: 'read', action: 'allow' }]);
    // A `read` tool call with `command` in the input must not get auto-allowed
    // by bash trust — bash evaluation is gated on tool name.
    expect(decidePermission('s1', 'read', { command: 'rm -rf' })).toBe('allow');
  });

  it('ignores non-string `command` inputs and falls through to the default rule', () => {
    setBashCommandLists(['npm *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'ask' }]);
    expect(decidePermission('s1', 'bash', { command: 42 as unknown as string })).toBe('ask');
    expect(decidePermission('s1', 'bash', {})).toBe('ask');
  });

  // --- Hard fail-closed guarantees against a permissive generic rule -------

  it('returns ask for unsupported syntax even when generic bash rule is allow', () => {
    // Regression: null-return from decideBashPermission used to fall through
    // to `{ tool: 'bash', action: 'allow' }`, which would auto-execute
    // `echo $(rm -rf /)`. The fail-closed contract now guarantees ask.
    setBashCommandLists(['echo *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(decidePermission('s1', 'bash', { command: 'echo $(rm -rf /)' })).toBe('ask');
  });

  it('returns ask for backticks inside double quotes even when generic bash rule is allow', () => {
    setBashCommandLists(['echo *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(decidePermission('s1', 'bash', { command: 'echo "`rm -rf /`"' })).toBe('ask');
  });

  it('returns ask for newline-chained commands even when generic bash rule is allow', () => {
    setBashCommandLists(['npm *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(decidePermission('s1', 'bash', { command: 'npm install\nrm -rf /' })).toBe('ask');
  });

  it('returns ask for process substitution even when generic bash rule is allow', () => {
    setBashCommandLists(['cat *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(decidePermission('s1', 'bash', { command: 'cat <(rm -rf /)' })).toBe('ask');
  });

  it('preserves today behaviour when the user has not opted in to bash control', () => {
    // No trust/deny lists configured → decideBashPermission short-circuits
    // to null without parsing, so a `bash: allow` rule still auto-allows
    // commands with expansions. This keeps upgrade behaviour non-breaking.
    setBashCommandLists([], []);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(decidePermission('s1', 'bash', { command: 'echo $(date)' })).toBe('allow');
  });

  // --- Authoritative mode: list control beats generic bash rule ------------

  it('an untrusted command returns ask even when the generic bash rule is allow', () => {
    // Regression for the precedence bypass: without authoritative mode,
    // `docker build .` would fall through to `bash: allow` and auto-run.
    setBashCommandLists(['npm *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(decidePermission('s1', 'bash', { command: 'docker build .' })).toBe('ask');
  });

  it('a trusted command still allows even when the generic bash rule is ask', () => {
    // Authoritative mode is not stricter than the generic rule; it's
    // *independent*. A trusted command gets through even if the fallback
    // was `ask`.
    setBashCommandLists(['npm *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'ask' }]);
    expect(decidePermission('s1', 'bash', { command: 'npm install' })).toBe('allow');
  });

  it('configuring only the denylist still triggers authoritative mode', () => {
    // Either list being non-empty is enough to opt in — a user who only
    // configured denylist should not have untrusted commands leak through.
    setBashCommandLists([], ['rm -rf']);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    // Unlisted → authoritative mode says ask (no trust matched).
    expect(decidePermission('s1', 'bash', { command: 'docker build .' })).toBe('ask');
    // Denylist match → ask.
    expect(decidePermission('s1', 'bash', { command: 'rm -rf /' })).toBe('ask');
  });

  // --- Pre-hydration / startup race behaviour ------------------------------

  it('empty lists on startup delegate to generic rule (race-window documented)', () => {
    // Before the renderer bootstraps and pushes `settings.update`, the main
    // cache is empty. This test pins down that behaviour so future changes
    // are intentional. A production fix would move bash lists to
    // main-process persisted config, matching the reviewer's MEDIUM-1.
    setBashCommandLists([], []);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(decidePermission('s1', 'bash', { command: 'anything' })).toBe('allow');
  });

  it('post-hydration with configured lists blocks the same command', () => {
    // Same command, but this time the user's trust list has been hydrated.
    // Authoritative mode kicks in and the generic allow is ignored.
    setBashCommandLists(['git *'], undefined);
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(decidePermission('s1', 'bash', { command: 'anything' })).toBe('ask');
  });
});

describe('IPC boundary behaviour — hardening against malformed payloads', () => {
  // The settings.update handler in src/main/index.ts delegates validation to
  // the store functions below. These tests lock in the behaviour the handler
  // relies on: no store call throws on garbage input, and partial updates
  // compose correctly with existing state.

  it('setPermissionRules does not throw on null or primitive inputs', () => {
    expect(() => setPermissionRules(null as unknown)).not.toThrow();
    expect(() => setPermissionRules(undefined as unknown)).not.toThrow();
    expect(() => setPermissionRules(42 as unknown)).not.toThrow();
    expect(() => setPermissionRules('not-an-array' as unknown)).not.toThrow();
  });

  it('setBashCommandLists does not throw on null or primitive inputs', () => {
    expect(() => setBashCommandLists(null, null)).not.toThrow();
    expect(() => setBashCommandLists(42 as unknown, 'nope' as unknown)).not.toThrow();
    expect(() => setBashCommandLists({} as unknown, [] as unknown)).not.toThrow();
  });

  it('a partial bash update (trusted only) preserves the previously-set denylist', () => {
    // Simulate: first IPC message sets both lists, second sets only trusted.
    setBashCommandLists(['npm *'], ['rm -rf']);
    setBashCommandLists(['npm *', 'git *'], undefined);
    const { trusted, denied } = getBashCommandLists();
    expect(trusted).toEqual(['npm *', 'git *']);
    expect(denied).toEqual(['rm -rf']);
  });

  it('a partial bash update (denylist only) preserves the previously-set trusted list', () => {
    setBashCommandLists(['npm *'], ['rm -rf']);
    setBashCommandLists(undefined, ['rm -rf', 'sudo']);
    const { trusted, denied } = getBashCommandLists();
    expect(trusted).toEqual(['npm *']);
    expect(denied).toEqual(['rm -rf', 'sudo']);
  });

  it('combined updates to permissionRules and bash lists take effect together', () => {
    // Mimic a real IPC payload that carries both fields at once.
    setPermissionRules([{ tool: 'bash', action: 'ask' }]);
    setBashCommandLists(['git *'], ['--force']);

    // Trust path → allow
    expect(decidePermission('s1', 'bash', { command: 'git status' })).toBe('allow');
    // Denylist overrides trust → ask
    expect(decidePermission('s1', 'bash', { command: 'git push --force' })).toBe('ask');
    // Unmatched command falls through to the generic rule → ask
    expect(decidePermission('s1', 'bash', { command: 'docker build .' })).toBe('ask');
  });

  it('malformed rule entries are coerced to ask without throwing', () => {
    // This mirrors a payload where one rule has an unknown action.
    setPermissionRules([{ tool: 'bash', action: 'allow-everything' as unknown as 'allow' }]);
    // Falls back to 'ask' per the sanitize fallback — safer than the bogus value.
    expect(decidePermission('s1', 'bash', { command: 'anything' })).toBe('ask');
  });
});

describe('session always-allow vs bash trust/deny precedence', () => {
  // Regression tests for the ordering bug where a single "Allow always" click
  // on a bash call silently neutered the trust list and denylist for the rest
  // of the session. The list engine now runs *before* the session memory when
  // the tool is bash, so authoritative mode keeps working after the user has
  // approved a one-off bash command.

  it('denylist still blocks even after bash was marked "always allow" in the session', () => {
    setBashCommandLists(['git *'], ['--force']);
    // User clicked "Allow always" on an earlier bash call this session.
    rememberAlwaysAllow('s1', 'bash');

    // Denylist must still take effect — never silently auto-allow `--force`.
    expect(decidePermission('s1', 'bash', { command: 'git push --force' })).toBe('ask');
  });

  it('untrusted bash command asks even after "always allow" when authoritative mode is on', () => {
    // Only a trust list is configured; authoritative mode is active because
    // the trusted list is non-empty.
    setBashCommandLists(['npm *'], []);
    rememberAlwaysAllow('s1', 'bash');

    // Not covered by trust → implicit ask, not a blanket allow.
    expect(decidePermission('s1', 'bash', { command: 'rm -rf node_modules' })).toBe('ask');
  });

  it('trusted bash command still allows after "always allow" — no behaviour change on the happy path', () => {
    setBashCommandLists(['npm *'], []);
    rememberAlwaysAllow('s1', 'bash');
    expect(decidePermission('s1', 'bash', { command: 'npm install' })).toBe('allow');
  });

  it('session "always allow" still works for non-bash tools (scope unchanged)', () => {
    // The ordering change is bash-specific; other tools must keep their
    // existing behaviour where "Allow always" short-circuits the rules.
    setPermissionRules([{ tool: 'write', action: 'ask' }]);
    rememberAlwaysAllow('s1', 'write');
    expect(decidePermission('s1', 'write', { path: '/tmp/foo' })).toBe('allow');
  });

  it('session "always allow" still works for bash when no lists are configured', () => {
    // With authoritative mode off (both lists empty), decideBashPermission
    // returns null and the session memory is the next check — so the
    // pre-existing "Allow always" UX is preserved for users who have not
    // opted into list-based bash control.
    setBashCommandLists([], []);
    rememberAlwaysAllow('s1', 'bash');
    expect(decidePermission('s1', 'bash', { command: 'anything goes' })).toBe('allow');
  });

  it('"always allow" memory is scoped to the session that set it', () => {
    // Sanity check: approving in session s1 must not bleed into s2.
    rememberAlwaysAllow('s1', 'bash');
    // s2 has no memory and no lists configured → falls through to the
    // default bash rule, which is `ask` when no rules are set.
    expect(decidePermission('s2', 'bash', { command: 'anything' })).toBe('ask');
  });
});

describe('containsUnsupportedShellSyntax — file-descriptor redirection forms', () => {
  // Regression tests for the over-strict `&` check that rejected safe
  // redirection syntaxes like `2>&1` and `&> file`. These forms duplicate
  // or close file descriptors; they don't spawn a subshell or chain a
  // second command, so they must pass the syntax guard so the trust list
  // can evaluate them normally.

  afterEach(() => {
    setBashCommandLists([], []);
  });

  it('allows `2>&1` stdout-to-stderr redirection', () => {
    setBashCommandLists(['firecrawl *'], undefined);
    expect(decideBashPermission('firecrawl search "foo" 2>&1')).toBe('allow');
  });

  it('allows `1>&2` stderr-to-stdout redirection', () => {
    setBashCommandLists(['echo *'], undefined);
    expect(decideBashPermission('echo boom 1>&2')).toBe('allow');
  });

  it('allows `2>&-` to close stderr', () => {
    setBashCommandLists(['node *'], undefined);
    expect(decideBashPermission('node script.js 2>&-')).toBe('allow');
  });

  it('allows `&> file` combined redirection shorthand', () => {
    setBashCommandLists(['cmd *'], undefined);
    expect(decideBashPermission('cmd args &> /tmp/out.log')).toBe('allow');
  });

  it('allows `&>> file` append combined redirection shorthand', () => {
    setBashCommandLists(['cmd *'], undefined);
    expect(decideBashPermission('cmd args &>> /tmp/out.log')).toBe('allow');
  });

  it('allows `>&2` without a leading fd digit', () => {
    // `>&2` is equivalent to `1>&2`. Same safety properties.
    setBashCommandLists(['printf *'], undefined);
    expect(decideBashPermission('printf oops >&2')).toBe('allow');
  });

  it('allows multi-digit fd redirections like `10>&11`', () => {
    // Rare but legal. The scanner should tolerate any-length digit run
    // preceding the operator.
    setBashCommandLists(['exec *'], undefined);
    expect(decideBashPermission('exec 10>&11')).toBe('allow');
  });

  it('still rejects a genuine lone `&` background operator', () => {
    // This must still fail closed — a lone trailing `&` is bash's
    // background operator and detaches the command from our control.
    setBashCommandLists(['sleep *'], undefined);
    expect(decideBashPermission('sleep 60 &')).toBe('ask');
  });

  it('still rejects `&` followed by a non-redirection char (e.g. `cmd & echo`)', () => {
    setBashCommandLists(['echo *'], undefined);
    // `cmd & echo x` backgrounds `cmd` then runs `echo x` — two commands,
    // one backgrounded. Not safe to auto-evaluate.
    expect(decideBashPermission('slow & echo done')).toBe('ask');
  });

  it('still rejects command substitution that happens to precede `2>&1`', () => {
    // The redirection is fine; the `$(...)` is the real risk. Security
    // posture is preserved even when both are present.
    setBashCommandLists(['echo *'], undefined);
    expect(decideBashPermission('echo $(rm -rf /) 2>&1')).toBe('ask');
  });

  it('handles redirection inside a chained command', () => {
    // Pipeline splits on `|`; each sub is evaluated independently, and
    // `2>&1` must not poison the per-sub syntax check. Both subs trusted
    // → allow.
    setBashCommandLists(['cat *', 'head *'], undefined);
    expect(decideBashPermission('cat file.txt 2>&1 | head -100')).toBe('allow');
  });

  it('denylist still applies to commands that use `2>&1`', () => {
    setBashCommandLists(['firecrawl *'], ['--force']);
    // Denylist match wins regardless of redirection.
    expect(decideBashPermission('firecrawl search "x" --force 2>&1')).toBe('ask');
  });
});
