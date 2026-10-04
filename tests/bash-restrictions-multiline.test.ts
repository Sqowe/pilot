/**
 * Multi-line commands, here-documents and comments in the bash restriction
 * engine (docs/design/trusted-directories.md §5), plus the adversarial inputs
 * the scanner must never read as safe.
 *
 * The property under test: text the shell executes is never classified as
 * inert. Whenever the scanner cannot be sure, the decision is `ask`.
 */
import { describe, expect, it } from 'vitest';
import {
  containsUnsupportedShellSyntax,
  decideBashPermission,
  explainBashPermission,
  splitBashSubCommands,
} from '../src/shared/bash-restrictions/engine';
import { scanBashCommand } from '../src/shared/bash-restrictions/scan';

const STAR = { trusted: ['*'], denied: [] as string[] };
const decide = (cmd: string, trusted: string[] = ['*'], denied: string[] = []) =>
  decideBashPermission(cmd, { trusted, denied });
const lines = (...parts: string[]) => parts.join('\n');

// ---------------------------------------------------------------------------
// R1 — line break as separator
// ---------------------------------------------------------------------------

describe('line break as a command separator', () => {
  it('splits on a line break exactly like `;`', () => {
    expect(splitBashSubCommands('cd /tmp\nls -la')).toEqual(['cd /tmp', 'ls -la']);
    expect(splitBashSubCommands('cd /tmp ; ls -la')).toEqual(['cd /tmp', 'ls -la']);
  });

  it('allows a multi-line command when every line is trusted', () => {
    expect(decide('cd /tmp\nls -la', ['cd *', 'ls *'])).toBe('allow');
  });

  it('asks when one line is not trusted', () => {
    expect(decide('ls -la\ncurl https://example.com', ['ls *'])).toBe('ask');
  });

  it('applies the denylist to every line', () => {
    expect(decide('ls -la\nrm -rf x', ['*'], ['rm'])).toBe('ask');
  });

  it('does not split on a line break inside quotes', () => {
    expect(splitBashSubCommands("python3 -c 'a\nb'")).toEqual(["python3 -c 'a\nb'"]);
    expect(splitBashSubCommands('echo "a\nb"')).toEqual(['echo "a\nb"']);
  });

  it('does not split on a backslash-continued line', () => {
    expect(splitBashSubCommands('ls \\\n  -la')).toEqual(['ls \\\n  -la']);
    expect(decide('ls \\\n  -la', ['ls *'])).toBe('allow');
  });

  it('ignores blank lines', () => {
    expect(splitBashSubCommands('\n\nls\n\n\npwd\n')).toEqual(['ls', 'pwd']);
  });

  it('still asks on a carriage return, alone or before a line break', () => {
    expect(decide('ls\rpwd')).toBe('ask');
    expect(decide('ls\r\npwd')).toBe('ask');
  });

  it('asks on a line break inside ${ }', () => {
    expect(decide('echo ${x:-\n#foo}; rm -rf y')).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// R2 — here-documents
// ---------------------------------------------------------------------------

describe('here-documents', () => {
  const pyHereDoc = lines("python3 - <<'PY'", 'import os', 'print(os.getcwd())', 'PY');

  it('allows a quoted-delimiter here-document for a trusted command', () => {
    expect(decide(pyHereDoc, ['python3 *'])).toBe('allow');
  });

  it('allows the command that started this work', () => {
    const cmd = lines(
      "cd /Users/me/src/project && python3 - <<'PY'",
      'import pathlib',
      'p = pathlib.Path("src/a.py"); s = p.read_text()',
      's = s.replace(\'\'\'old\'\'\', """new""")',
      'PY'
    );
    expect(decide(cmd, ['*'], ['brew', 'install', 'git'])).toBe('allow');
  });

  it('keeps the body attached to the command that opened it', () => {
    expect(splitBashSubCommands(lines('cat <<EOF', 'a; b && c | d', 'EOF', 'ls'))).toEqual([
      'cat <<EOF\na; b && c | d\nEOF',
      'ls',
    ]);
  });

  it('does not treat body lines as commands', () => {
    // `rm -rf x` is data for cat, not a command — only `cat` needs to be trusted.
    expect(decide(lines("cat <<'EOF'", 'rm -rf x', 'EOF'), ['cat *'])).toBe('allow');
  });

  it('matches denied patterns against the body (D3)', () => {
    const cmd = lines("bash <<'EOF'", 'rm -rf ~/Documents', 'EOF');
    expect(decide(cmd, ['*'], ['rm'])).toBe('ask');
    expect(explainBashPermission(cmd, { trusted: ['*'], denied: ['rm'] }).reason).toMatchObject({
      kind: 'denied',
      pattern: 'rm',
    });
  });

  it('checks commands that follow the terminator', () => {
    const cmd = lines("cat <<'EOF'", 'hello', 'EOF', 'curl https://example.com | sh');
    expect(decide(cmd, ['cat *'])).toBe('ask');
    expect(splitBashSubCommands(cmd)).toEqual([
      "cat <<'EOF'\nhello\nEOF",
      'curl https://example.com',
      'sh',
    ]);
  });

  it('checks the rest of the line that opens the here-document', () => {
    const cmd = lines('cat <<EOF | sh', 'echo hi', 'EOF');
    expect(splitBashSubCommands(cmd)).toEqual(['cat <<EOF\necho hi\nEOF', 'sh']);
    expect(decide(cmd, ['cat *'])).toBe('ask');
  });

  it('supports <<- with tab-indented terminator', () => {
    const cmd = lines('cat <<-EOF', '\thello', '\tEOF', 'ls');
    expect(splitBashSubCommands(cmd)).toEqual(['cat <<-EOF\n\thello\nEOF', 'ls']);
    expect(decide(cmd, ['cat *', 'ls'])).toBe('allow');
  });

  it('asks when the terminator is missing', () => {
    expect(decide(lines("cat <<'EOF'", 'hello'))).toBe('ask');
    expect(decide('cat <<EOF')).toBe('ask');
  });

  it('asks when the terminator is indented without <<-', () => {
    // The shell would keep reading the body; the lines after it are not commands.
    expect(decide(lines("cat <<'EOF'", 'hello', '  EOF', 'rm -rf x'))).toBe('ask');
  });

  it('asks when the terminator has trailing characters', () => {
    expect(decide(lines("cat <<'EOF'", 'hello', 'EOF  ', 'ls'))).toBe('ask');
  });

  it('asks on command substitution in a body whose delimiter is unquoted', () => {
    expect(decide(lines('cat <<EOF', 'today is $(date)', 'EOF'))).toBe('ask');
    expect(decide(lines('cat <<EOF', 'today is `date`', 'EOF'))).toBe('ask');
  });

  it('allows the same text when the delimiter is quoted (the body is literal)', () => {
    expect(decide(lines("cat <<'EOF'", 'today is $(date)', 'EOF'))).toBe('allow');
    expect(decide(lines('cat <<"EOF"', 'today is `date`', 'EOF'))).toBe('allow');
    expect(decide(lines('cat <<\\EOF', 'today is $(date)', 'EOF'))).toBe('allow');
  });

  it('allows plain variables and arithmetic in an unquoted-delimiter body', () => {
    expect(decide(lines('cat <<EOF', 'home is $HOME, sum is $((1 + 2))', 'EOF'))).toBe('allow');
  });

  it('asks on more than one here-document on a line', () => {
    expect(decide(lines('cat <<A <<B', 'x', 'A', 'y', 'B'))).toBe('ask');
  });

  it('asks on a delimiter it cannot read', () => {
    expect(decide(lines('cat <<', 'x'))).toBe('ask');
    expect(decide(lines("cat <<'END OF FILE'", 'x', 'END OF FILE'))).toBe('ask');
  });

  it('leaves the one-line here-string alone', () => {
    expect(decide('grep foo <<< "some text"', ['grep *'])).toBe('allow');
  });

  it('does not mistake a shift inside arithmetic for a here-document', () => {
    expect(decide('echo $(( 1 << 4 ))', ['echo *'])).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// R3 — comments
// ---------------------------------------------------------------------------

describe('comments', () => {
  it('drops full-line comments in a multi-line command', () => {
    const cmd = lines('# build first', 'npm run build', '  # then test', 'npm test');
    expect(splitBashSubCommands(cmd)).toEqual(['npm run build', 'npm test']);
    expect(decide(cmd, ['npm *'])).toBe('allow');
  });

  it('does not match denied words in a dropped comment line', () => {
    expect(decide(lines('# do not rm anything', 'ls -la'), ['ls *'], ['rm'])).toBe('allow');
  });

  it('keeps the historic treatment of `#` in a one-line command', () => {
    expect(splitBashSubCommands('ls -la # list files')).toEqual(['ls -la # list files']);
    expect(decide('ls -la # list files', ['ls *'])).toBe('allow');
    expect(splitBashSubCommands('# just a note')).toEqual(['# just a note']);
  });

  it('allows a trailing comment on the last line', () => {
    expect(decide(lines('ls -la', 'pwd # where am I'), ['ls *', 'pwd*'])).toBe('allow');
  });

  it('asks on a comment that begins inside a line and is followed by more lines', () => {
    expect(decide(lines('ls -la # list', 'pwd'))).toBe('ask');
    expect(decide(lines('ls;# note', 'pwd'))).toBe('ask');
  });

  it('does not treat `#` inside a word as a comment', () => {
    const cmd = lines('echo a#b', 'echo $#', 'echo ${#x}', 'echo $((16#ff))');
    expect(containsUnsupportedShellSyntax(cmd)).toBe(false);
    expect(decide(cmd, ['echo *'])).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Arithmetic that is really a command substitution or subshell
// ---------------------------------------------------------------------------

describe('arithmetic must close with ))', () => {
  it('allows well-formed arithmetic', () => {
    expect(decide('echo $(( (1 + 2) * 3 ))', ['echo *'])).toBe('allow');
    expect(decide('(( i++ ))', ['*'])).toBe('allow');
    expect(decide('echo "$((1+2))"', ['echo *'])).toBe('allow');
  });

  it('asks when $(( does not close with )) — it is a command substitution', () => {
    expect(decide('echo $((rm -rf x) | cat)')).toBe('ask');
    expect(decide('echo "$((rm -rf x) | cat)"')).toBe('ask');
    expect(decide('echo $(( 1 + 2')).toBe('ask');
  });

  it('asks when (( at command start does not close with )) — it is a subshell', () => {
    expect(decide('((rm -rf x); ls)')).toBe('ask');
  });

  it('still catches a command substitution nested in arithmetic', () => {
    expect(decide('echo $(( $(rm -rf x) + 1 ))')).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// One-line inputs the previous reader refused — the rewrite must refuse them too
// ---------------------------------------------------------------------------

describe('no loosening for one-line commands', () => {
  // Found by comparing the rewritten reader against the previous one on ~150k
  // generated commands: these are syntax errors in bash, and stay `ask` here.
  it.each([
    'echo hi >>(cat)',
    'echo hi <<<(cat)',
    'echo hi &>(cat)',
    'echo hi &>>(cat)',
    'echo hi <>(cat)',
    'echo $(( 1 >(2) ))',
    'cmd >&&& other',
    'cmd <&&& other',
    'cmd >&& other',
  ])('asks on %j', (command) => {
    expect(containsUnsupportedShellSyntax(command)).toBe(true);
    expect(decide(command)).toBe('ask');
  });

  it('asks when a background & hides behind a redirection target', () => {
    // `>1&` redirects to a file named 1 and backgrounds the command.
    expect(decide('echo x >1&')).toBe('ask');
    expect(decide('echo x > out.txt &')).toBe('ask');
  });

  it('keeps the descriptor forms it always accepted', () => {
    for (const command of [
      'cmd 2>&1',
      'cmd >&2',
      'cmd 2>&-',
      'cmd 10>&11',
      'cmd &> f',
      'cmd &>> f',
    ]) {
      expect(containsUnsupportedShellSyntax(command), command).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// $'…' and $"…" — the shell rewrites these strings before using them
// ---------------------------------------------------------------------------

describe('ANSI-C and locale quoting ($\'…\', $"…")', () => {
  // `$'/etc/hosts'` IS `/etc/hosts` to the shell. Reading it as `$` followed by a
  // quoted string would invent the path `$/etc/hosts`, so the scanner refuses.
  it.each([
    "echo x > $'/etc/hosts'",
    "echo x > $'../outside.txt'",
    'echo x > $"/etc/hosts"',
    "echo x > $'.'/etc/hosts",
    "echo $'a\\nb'",
    "$'ls' -la",
  ])('asks on %j', (command) => {
    expect(containsUnsupportedShellSyntax(command)).toBe(true);
    expect(decide(command)).toBe('ask');
    expect(explainBashPermission(command, STAR).reason).toEqual({
      kind: 'unsupported-syntax',
      detail: '$\'…\' or $"…" quoting',
    });
  });

  it("never reads a $'…' redirection target as a literal path", () => {
    for (const command of ["echo x > $'/etc/hosts'", 'echo x > $"/etc/hosts"']) {
      const target = scanBashCommand(command).subCommands[0].redirects[0].target;
      expect(
        target?.segments.some((s) => s.kind === 'dynamic'),
        command
      ).toBe(true);
    }
  });

  it("does not let an escaped quote inside $'…' shift the quote boundaries", () => {
    // To the shell `$'\''` is one quote character; `rm -rf x` below is a real command.
    const command = "echo $'\\'' ; rm -rf x ; echo $'\\''";
    expect(splitBashSubCommands(command)).toContain('rm -rf x');
    expect(decide(command, ['*'], ['rm'])).toBe('ask');
    expect(decide(command)).toBe('ask');
  });

  it('leaves `$` before a quote alone inside double quotes, where it is not special', () => {
    expect(containsUnsupportedShellSyntax(`echo "cost: $'5'"`)).toBe(false);
    expect(containsUnsupportedShellSyntax('echo "total$"')).toBe(false);
    expect(decide(`echo "cost: $'5'"`, ['echo *'])).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Adversarial inputs — each must end in `ask`
// ---------------------------------------------------------------------------

describe('adversarial inputs', () => {
  it('a quote inside a comment cannot hide the next line', () => {
    const cmd = lines("# don't worry", "echo x >> ~/.zshrc   # it's fine");
    // The comment line is dropped; the second line is read as a command with a redirect.
    const scan = scanBashCommand(cmd);
    expect(scan.subCommands).toHaveLength(1);
    expect(scan.subCommands[0].redirects.map((r) => r.operator)).toEqual(['>>']);
  });

  it('a quote inside a trailing comment cannot hide the next line', () => {
    const cmd = lines("ls # don't", "echo x >> ~/.zshrc # it's");
    expect(decide(cmd)).toBe('ask');
  });

  it('a comment after a closing parenthesis is still a comment', () => {
    const cmd = lines("(( 1 ))# don't", "echo x >> ~/.zshrc # it's");
    expect(decide(cmd)).toBe('ask');
  });

  it('a backslash-continued line does not start a comment line', () => {
    // The shell joins the lines into `echo foo# ; rm -rf x` and runs `rm`.
    const cmd = lines('echo foo\\', '# ; rm -rf x');
    expect(splitBashSubCommands(cmd)).toContain('rm -rf x');
    expect(decide(cmd, ['echo *'])).toBe('ask');
    expect(decide(cmd, ['*'], ['rm'])).toBe('ask');
  });

  it('a comment reached through a continued line cannot hide what follows', () => {
    // The shell joins lines 1-2 into `echo foo # don't`, a comment; line 3 runs.
    const cmd = lines('echo foo \\', "# don't", "echo x >> ~/.zshrc # it's");
    expect(decide(cmd)).toBe('ask');
  });

  it('a line break inside ${ } cannot turn code into a comment', () => {
    expect(decide(lines('echo ${x:-', '#foo}; rm -rf y'))).toBe('ask');
  });

  it('commands after an unterminated here-document are not waved through', () => {
    expect(decide(lines("cat <<'EOF'", 'x', 'rm -rf y'), ['cat *'])).toBe('ask');
  });

  it('a body cannot smuggle a command substitution past an unquoted delimiter', () => {
    expect(decide(lines('cat <<EOF', '$(rm -rf y)', 'EOF'), ['cat *'])).toBe('ask');
  });

  it('never returns null once a list is configured', () => {
    for (const cmd of [
      lines('ls', 'pwd'),
      lines("cat <<'EOF'", 'x', 'EOF'),
      lines('# c', 'ls'),
      '\n',
      lines('#a', '#b'),
    ]) {
      expect(decideBashPermission(cmd, STAR)).not.toBeNull();
    }
  });

  it('asks when nothing is left after dropping comment lines', () => {
    expect(decide(lines('# only', '# comments'))).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

describe('explainBashPermission', () => {
  it('names the unsupported syntax', () => {
    expect(explainBashPermission('echo $(date)', STAR)).toEqual({
      decision: 'ask',
      reason: { kind: 'unsupported-syntax', detail: 'command substitution' },
    });
  });

  it('names the sub-command that is not trusted', () => {
    expect(explainBashPermission('ls | jq .', { trusted: ['ls'], denied: [] })).toEqual({
      decision: 'ask',
      reason: { kind: 'not-trusted', subCommand: 'jq .' },
    });
  });

  it('names the denied pattern', () => {
    expect(explainBashPermission('ls && sudo ls', { trusted: ['*'], denied: ['sudo'] })).toEqual({
      decision: 'ask',
      reason: { kind: 'denied', pattern: 'sudo', subCommand: 'sudo ls' },
    });
  });

  it('gives no reason for allow or for an inactive gate', () => {
    expect(explainBashPermission('ls', STAR)).toEqual({ decision: 'allow' });
    expect(explainBashPermission('ls', { trusted: [], denied: [] })).toEqual({ decision: null });
  });
});

// ---------------------------------------------------------------------------
// Scanner structure
// ---------------------------------------------------------------------------

describe('scanBashCommand structure', () => {
  it('records how sub-commands are joined', () => {
    const scan = scanBashCommand('a && b || c ; d | e\nf');
    expect(scan.subCommands.map((s) => s.joinedBy)).toEqual([
      'start',
      '&&',
      '||',
      ';',
      '|',
      'newline',
    ]);
  });

  it('separates command words from redirection targets', () => {
    const [sub] = scanBashCommand('echo hi > out.txt 2>&1 < in.txt').subCommands;
    expect(sub.words.map((w) => w.segments)).toEqual([
      [{ kind: 'literal', text: 'echo' }],
      [{ kind: 'literal', text: 'hi' }],
    ]);
    expect(sub.redirects.map((r) => [r.kind, r.operator])).toEqual([
      ['out', '>'],
      ['dup', '>&'],
      ['in', '<'],
    ]);
  });

  it('treats `>&word` as a file when the word is not a descriptor', () => {
    const kinds = (cmd: string) => scanBashCommand(cmd).subCommands[0].redirects.map((r) => r.kind);
    expect(kinds('cmd >&2')).toEqual(['dup']);
    expect(kinds('cmd 2>&-')).toEqual(['dup']);
    expect(kinds('cmd >& /etc/x')).toEqual(['out']);
    expect(kinds('cmd 2>& /etc/x')).toEqual(['out']);
  });

  it('removes quotes and resolves escapes in words', () => {
    const [sub] = scanBashCommand(`echo 'a b' "c d" e\\ f`).subCommands;
    expect(sub.words.slice(1).map((w) => w.segments)).toEqual([
      [{ kind: 'literal', text: 'a b' }],
      [{ kind: 'literal', text: 'c d' }],
      [{ kind: 'literal', text: 'e f' }],
    ]);
  });

  it('marks variables, the home tilde and unknowable words', () => {
    const [sub] = scanBashCommand('x ~/a $HOME/b "${PWD}/c" $OUT/d *.txt ~bob/e').subCommands;
    expect(sub.words.slice(1).map((w) => w.segments.map((s) => s.kind))).toEqual([
      ['tilde', 'literal'],
      ['variable', 'literal'],
      ['variable', 'literal'],
      ['variable', 'literal'],
      ['dynamic', 'literal'],
      ['dynamic', 'literal'],
    ]);
  });

  it('records a redirection whose target is missing', () => {
    const [sub] = scanBashCommand('echo x >').subCommands;
    expect(sub.redirects).toEqual([{ kind: 'out', operator: '>', target: null }]);
  });
});
