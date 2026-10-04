/**
 * The trusted-directories check for bash commands
 * (src/shared/bash-restrictions/write-zone.ts), against real temporary
 * directories and symbolic links. See docs/design/trusted-directories.md §4.2, §6.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkBashWriteZone,
  decideBashWithZone,
  describeBashReason,
} from '../src/shared/bash-restrictions/write-zone';
import { buildWriteZone, type WriteZoneContext } from '../src/shared/path-permissions';

let base: string;
let home: string;
let project: string;
let scratch: string;
let elsewhere: string;
let settingsFile: string;
let ctx: WriteZoneContext;

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bash-zone-')));
  home = path.join(base, 'home', 'me');
  project = path.join(home, 'src', 'proj');
  scratch = path.join(base, 'scratch');
  elsewhere = path.join(base, 'elsewhere');
  for (const dir of [path.join(project, 'sub'), path.join(project, '.pi'), scratch, elsewhere]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  settingsFile = path.join(project, '.pi', 'bash-restrictions.json');
  fs.writeFileSync(settingsFile, '{}');
  fs.symlinkSync(elsewhere, path.join(project, 'link-out'));

  ctx = {
    zone: buildWriteZone({
      entries: ['./', scratch],
      cwd: project,
      homeDir: home,
      protectedFiles: [settingsFile],
    }),
    cwd: project,
    homeDir: home,
  };
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  // A CDPATH in the developer's own environment would change what `cd sub` means.
  vi.stubEnv('CDPATH', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const check = (command: string, override: Partial<WriteZoneContext> = {}) =>
  checkBashWriteZone(command, { ...ctx, ...override });
const outside = (p: string) => ({ kind: 'write-outside', path: p });

describe('checkBashWriteZone — off and nothing to check', () => {
  it('has no opinion when the zone is off', () => {
    const off = buildWriteZone({ entries: [], cwd: project, homeDir: home });
    expect(check('echo x > /etc/hosts', { zone: off })).toBeNull();
  });

  it('has nothing to object to when the command writes nowhere visibly', () => {
    expect(check('ls -la')).toBeNull();
    expect(check('python3 script.py')).toBeNull();
    expect(check('cat a.txt | grep foo')).toBeNull();
  });

  it('reports syntax it cannot read', () => {
    expect(check('echo $(date) > out.txt')).toEqual({
      kind: 'unsupported-syntax',
      detail: 'command substitution',
    });
  });
});

describe('checkBashWriteZone — output redirections', () => {
  it('allows targets inside the zone, by relative or full path', () => {
    expect(check('echo x > out.txt')).toBeNull();
    expect(check('echo x >> ./sub/out.txt')).toBeNull();
    expect(check(`echo x > ${project}/new/dir/out.txt`)).toBeNull();
    expect(check(`echo x > ${scratch}/a.txt`)).toBeNull();
    expect(check('echo x > "name with space.txt"')).toBeNull();
  });

  it('ignores descriptor forms and the null device', () => {
    expect(check('cmd 2>&1')).toBeNull();
    expect(check('cmd >&2')).toBeNull();
    expect(check('cmd 2>&-')).toBeNull();
    expect(check('cmd > /dev/null 2> /dev/null')).toBeNull();
    expect(check('cmd &> /dev/null')).toBeNull();
  });

  it('asks for a target outside the zone and names its real path', () => {
    expect(check('echo x >> ~/.zshrc')).toEqual(outside(path.join(home, '.zshrc')));
    expect(check(`echo x > ${elsewhere}/a.txt`)).toEqual(outside(path.join(elsewhere, 'a.txt')));
    expect(check('echo x > ../other.txt')).toEqual(outside(path.join(home, 'src', 'other.txt')));
  });

  it('covers every output form', () => {
    for (const command of [
      `cmd 2> ${elsewhere}/err.log`,
      `cmd &> ${elsewhere}/all.log`,
      `cmd &>> ${elsewhere}/all.log`,
      `cmd >& ${elsewhere}/all.log`,
      `cmd 2>& ${elsewhere}/all.log`,
      `cmd <> ${elsewhere}/rw`,
      `cmd>${elsewhere}/tight`,
    ]) {
      expect(check(command)?.kind, command).toBe('write-outside');
    }
  });

  it('does not check input redirections (reads are out of scope)', () => {
    expect(check(`cat < ${elsewhere}/in.txt`)).toBeNull();
    expect(check(`grep foo <<< "${elsewhere}/x"`)).toBeNull();
  });

  it('resolves $HOME and $PWD, and asks about other variables', () => {
    expect(check('echo x > $HOME/.zshrc')).toEqual(outside(path.join(home, '.zshrc')));
    expect(check('echo x > "${HOME}/src/proj/a.txt"')).toBeNull();
    expect(check('echo x > $PWD/a.txt')).toBeNull();
    expect(check('echo x > "$OUT/file"')).toEqual({
      kind: 'write-undetermined',
      detail: 'the target of >',
    });
  });

  it('asks when the target cannot be determined', () => {
    for (const command of [
      'echo x > *.txt',
      'echo x > ~bob/x',
      'echo x >',
      'echo x > a{1,2}.txt',
    ]) {
      expect(check(command)?.kind, command).toBe('write-undetermined');
    }
  });

  it('asks on $\'…\' and $"…" targets instead of inventing a path inside the zone', () => {
    // The shell expands these to the plain path; `$/etc/hosts` is not what it writes.
    for (const command of [
      "echo x > $'/etc/hosts'",
      `echo x > $'${elsewhere}/a.txt'`,
      "echo x > $'../outside.txt'",
      'echo x > $"/etc/hosts"',
      "echo x > $'.'/etc/hosts",
      "make | tee $'/etc/hosts'",
      "cd $'/etc' && echo x > hosts",
    ]) {
      expect(check(command), command).toEqual({
        kind: 'unsupported-syntax',
        detail: '$\'…\' or $"…" quoting',
      });
    }
  });

  it('follows a link that leads outside', () => {
    expect(check('echo x > link-out/a.txt')).toEqual(outside(path.join(elsewhere, 'a.txt')));
  });

  it('asks about the gate settings file even though it is inside the zone', () => {
    expect(check("echo '{}' > .pi/bash-restrictions.json")).toEqual({
      kind: 'write-protected',
      path: settingsFile,
    });
    expect(check('echo x > .pi/other.json')).toBeNull();
  });

  it('checks the redirect of a command that takes a here-document', () => {
    expect(check('cat > notes.txt <<EOF\nhello\nEOF')).toBeNull();
    expect(check('cat > ~/notes.txt <<EOF\nhello\nEOF')?.kind).toBe('write-outside');
  });

  it('does not read comparisons inside arithmetic as redirections', () => {
    expect(check('(( 2 > 1 ))')).toBeNull();
    expect(check('echo $(( 2 > 1 ))')).toBeNull();
  });

  it('does not treat a redirect inside quotes as a redirect', () => {
    expect(check(`echo "x > ${elsewhere}/a.txt"`)).toBeNull();
    expect(check(`echo 'x > ${elsewhere}/a.txt'`)).toBeNull();
  });
});

describe('checkBashWriteZone — tee', () => {
  it('allows tee into the zone', () => {
    expect(check('make | tee build.log')).toBeNull();
    expect(check('make | tee -a build.log extra.log')).toBeNull();
  });

  it('asks for a tee target outside the zone', () => {
    expect(check(`make | tee ${elsewhere}/build.log`)?.kind).toBe('write-outside');
    expect(check(`make | tee -a build.log ${elsewhere}/build.log`)?.kind).toBe('write-outside');
    expect(check(`make | sudo tee ${elsewhere}/build.log`)?.kind).toBe('write-outside');
    expect(check(`make | /usr/bin/tee ${elsewhere}/build.log`)?.kind).toBe('write-outside');
  });

  it('asks when a tee target cannot be determined', () => {
    expect(check('make | tee "$LOG"')).toEqual({
      kind: 'write-undetermined',
      detail: 'a tee target',
    });
  });
});

describe('checkBashWriteZone — directory changes', () => {
  it('resolves relative targets against a preceding `cd … &&`', () => {
    expect(check('cd sub && echo x > a.txt')).toBeNull();
    expect(check(`cd ${scratch} && echo x > a.txt`)).toBeNull();
    expect(check(`cd ${elsewhere} && echo x > hosts`)).toEqual(
      outside(path.join(elsewhere, 'hosts'))
    );
    expect(check('cd .. && echo x > a.txt')).toEqual(outside(path.join(home, 'src', 'a.txt')));
  });

  it('treats a bare `cd` as going home', () => {
    expect(check('cd && echo x > a.txt')).toEqual(outside(path.join(home, 'a.txt')));
  });

  it('follows a chain of directory changes', () => {
    expect(check('cd sub && cd .. && echo x > a.txt')).toBeNull();
    expect(check(`cd sub && cd ${elsewhere} && echo x > a.txt`)?.kind).toBe('write-outside');
  });

  it('does not assume a `cd` joined by `;` or a line break succeeded', () => {
    // If `cd sub` fails, `../a.txt` lands outside the project.
    expect(check('cd sub ; echo x > ../a.txt')?.kind).toBe('write-outside');
    expect(check('cd sub\necho x > ../a.txt')?.kind).toBe('write-outside');
    // With `&&` the write only happens when the `cd` worked.
    expect(check('cd sub && echo x > ../a.txt')).toBeNull();
    // Either way the write stays inside: fine.
    expect(check('cd sub ; echo x > a.txt')).toBeNull();
  });

  it('keeps absolute targets independent of any `cd`', () => {
    expect(check(`cd "$D" && echo x > ${scratch}/a.txt`)).toBeNull();
    expect(check(`cd "$D" && echo x > ${elsewhere}/a.txt`)?.kind).toBe('write-outside');
  });

  it('asks about relative targets after a directory change it cannot follow', () => {
    for (const command of [
      'cd "$D" && echo x > a.txt',
      'cd - && echo x > a.txt',
      `pushd ${elsewhere} && echo x > a.txt`,
      'popd; echo x > a.txt',
      'f() { cd /etc; }; f; echo x > hosts',
      'if true; then cd /etc; fi; echo x > hosts',
      'eval "cd /etc"; echo x > hosts',
      '$CMD /etc; echo x > hosts',
      'cd a b && echo x > c',
    ]) {
      expect(check(command)?.kind, command).toBe('write-undetermined');
    }
  });

  it('asks about ~ and $HOME once the command touches HOME itself', () => {
    expect(check(`HOME=${elsewhere}; echo x > ~/src/proj/a.txt`)?.kind).toBe('write-undetermined');
    expect(check(`export HOME=${elsewhere} && echo x > $HOME/src/proj/a.txt`)?.kind).toBe(
      'write-undetermined'
    );
    expect(check('PWD=/etc; echo x > $PWD/a.txt')?.kind).toBe('write-undetermined');
  });

  it('does not follow a relative `cd` when CDPATH is set in the environment', () => {
    vi.stubEnv('CDPATH', '/somewhere/else');
    expect(check('cd sub && echo x > a.txt')?.kind).toBe('write-undetermined');
    // `./sub` and absolute operands never go through CDPATH.
    expect(check('cd ./sub && echo x > a.txt')).toBeNull();
    expect(check(`cd ${scratch} && echo x > a.txt`)).toBeNull();
  });

  it('asks about Git Bash paths that cannot be mapped to a Windows path', () => {
    expect(check('echo x > /tmp/a.txt', { platform: 'win32' })?.kind).toBe('write-undetermined');
    expect(check('cd /tmp && echo x > a.txt', { platform: 'win32' })?.kind).toBe(
      'write-undetermined'
    );
  });

  it('asks about every relative target when the working directory is unknown', () => {
    expect(check('echo x > a.txt', { cwd: undefined })?.kind).toBe('write-undetermined');
    expect(check(`echo x > ${scratch}/a.txt`, { cwd: undefined })).toBeNull();
  });
});

describe('checkBashWriteZone — multi-line commands', () => {
  it('checks each line', () => {
    expect(check('echo a > a.txt\necho b > b.txt')).toBeNull();
    expect(check(`echo a > a.txt\necho b > ${elsewhere}/b.txt`)?.kind).toBe('write-outside');
  });

  it('sees the redirect on the line after a comment that contains a quote', () => {
    expect(check("# don't worry\necho x >> ~/.zshrc")).toEqual(outside(path.join(home, '.zshrc')));
    // With a second quote in a trailing comment the command is still not waved through.
    expect(check("# don't worry\necho x >> ~/.zshrc   # it's fine")).not.toBeNull();
  });
});

describe('decideBashWithZone', () => {
  const star = { trusted: ['*'], denied: ['rm'] };
  const none = { trusted: [], denied: [] };

  it('keeps an ask from the command lists, with their reason', () => {
    expect(decideBashWithZone('rm -rf x', star, ctx)).toMatchObject({
      decision: 'ask',
      reason: { kind: 'denied', pattern: 'rm' },
    });
  });

  it('never makes an untrusted command trusted because it stays inside the zone (D1)', () => {
    const result = decideBashWithZone(
      'curl https://example.com > out.txt',
      {
        trusted: ['ls *'],
        denied: [],
      },
      ctx
    );
    expect(result).toMatchObject({ decision: 'ask', reason: { kind: 'not-trusted' } });
  });

  it('turns an allowed command into ask when it visibly writes outside', () => {
    expect(decideBashWithZone('echo x >> ~/.zshrc', star, ctx)).toEqual({
      decision: 'ask',
      reason: outside(path.join(home, '.zshrc')),
    });
  });

  it('leaves an allowed command that stays inside the zone alone', () => {
    expect(decideBashWithZone('echo x > out.txt', star, ctx)).toEqual({ decision: 'allow' });
  });

  it('still checks writes when both command lists are empty (D9)', () => {
    expect(decideBashWithZone('echo x >> ~/.zshrc', none, ctx).decision).toBe('ask');
    expect(decideBashWithZone('echo x > out.txt', none, ctx)).toEqual({ decision: null });
    expect(decideBashWithZone('ls -la', none, ctx)).toEqual({ decision: null });
    // A command the scanner cannot read asks, even with both lists empty.
    expect(decideBashWithZone('echo $(date)', none, ctx)).toMatchObject({
      decision: 'ask',
      reason: { kind: 'unsupported-syntax' },
    });
  });

  it('behaves exactly like the command lists when the zone is off', () => {
    const off = { ...ctx, zone: buildWriteZone({ entries: [], cwd: project, homeDir: home }) };
    expect(decideBashWithZone('echo x >> ~/.zshrc', star, off)).toEqual({ decision: 'allow' });
    expect(decideBashWithZone('echo x >> ~/.zshrc', none, off)).toEqual({ decision: null });
    expect(decideBashWithZone('echo $(date)', none, off)).toEqual({ decision: null });
  });

  it('asks for every write when every listed directory was rejected (D12)', () => {
    const allRejected = {
      ...ctx,
      zone: buildWriteZone({ entries: ['~'], cwd: project, homeDir: home }),
    };
    expect(allRejected.zone.enabled).toBe(true);
    expect(decideBashWithZone('echo x > out.txt', star, allRejected).decision).toBe('ask');
    expect(decideBashWithZone('ls -la', star, allRejected).decision).toBe('allow');
  });
});

describe('module boundaries', () => {
  it('keeps the write-zone check out of the fs-free barrel', async () => {
    const barrel = await import('../src/shared/bash-restrictions');
    expect(Object.keys(barrel)).not.toContain('checkBashWriteZone');
    expect(Object.keys(barrel)).not.toContain('decideBashWithZone');
    expect(Object.keys(barrel)).toContain('decideBashPermission');
  });
});

describe('describeBashReason', () => {
  it('puts each reason in words', () => {
    expect(describeBashReason({ kind: 'unsupported-syntax', detail: 'a subshell' })).toBe(
      'the command uses a subshell, which cannot be checked'
    );
    expect(describeBashReason({ kind: 'denied', pattern: 'rm', subCommand: 'rm x' })).toBe(
      'matches the denied pattern "rm"'
    );
    expect(describeBashReason({ kind: 'not-trusted', subCommand: 'jq .' })).toBe(
      'not in the trusted list: jq .'
    );
    expect(describeBashReason({ kind: 'write-outside', path: '/etc/hosts' })).toBe(
      'writes outside the trusted directories: /etc/hosts'
    );
    expect(describeBashReason({ kind: 'empty' })).toBe('there is nothing to run');
  });

  it('shows only the first line of a long untrusted sub-command', () => {
    const text = describeBashReason({ kind: 'not-trusted', subCommand: `python3 - <<'PY'\nx\nPY` });
    expect(text).toBe("not in the trusted list: python3 - <<'PY'");
  });
});
