/**
 * The trusted-directories write zone in the app's main-process permission
 * gate (`decidePermission` in permission-rules-store), against real temporary
 * directories. See docs/design/trusted-directories.md §4.2–4.3.
 *
 * The store keeps its state in module-level variables, so every test resets it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decidePermission,
  decidePermissionDetailed,
  forgetSessionPermissions,
  getTrustedDirectories,
  rememberAlwaysAllow,
  setBashCommandLists,
  setPermissionRules,
  setProtectedWriteFiles,
  setSessionCwd,
  setTrustedDirectories,
} from '../src/main/config/permission-rules-store';

const SESSION = 'zone-session';
const NO_CWD_SESSION = 'zone-session-without-workspace';

let base: string;
let workspace: string;
let scratch: string;
let elsewhere: string;
let appSettingsFile: string;

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'app-zone-')));
  workspace = path.join(base, 'workspace');
  scratch = path.join(base, 'scratch');
  elsewhere = path.join(base, 'elsewhere');
  for (const dir of [path.join(workspace, 'cfg'), scratch, elsewhere]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  appSettingsFile = path.join(workspace, 'cfg', 'config.json');
  fs.writeFileSync(appSettingsFile, '{}');
  fs.symlinkSync(elsewhere, path.join(workspace, 'link-out'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  setSessionCwd(SESSION, workspace);
});

afterEach(() => {
  setTrustedDirectories([]);
  setProtectedWriteFiles([]);
  setBashCommandLists([], []);
  setPermissionRules([]);
  forgetSessionPermissions(SESSION);
  forgetSessionPermissions(NO_CWD_SESSION);
});

const bash = (command: string, session = SESSION) =>
  decidePermissionDetailed(session, 'bash', { command });
const write = (target: string, session = SESSION) =>
  decidePermissionDetailed(session, 'write', { path: target, content: 'x' });

describe('setTrustedDirectories', () => {
  it('sanitizes what the renderer sends', () => {
    setTrustedDirectories([' ./ ', 5, null, '', './', '/tmp']);
    expect(getTrustedDirectories()).toEqual(['./', '/tmp']);
    setTrustedDirectories('not-an-array');
    expect(getTrustedDirectories()).toEqual([]);
  });
});

describe('zone off — today’s behaviour', () => {
  it('leaves write and edit to the generic rules', () => {
    expect(write(path.join(elsewhere, 'a.txt'))).toEqual({ action: 'ask' });
    expect(decidePermission(SESSION, 'edit', { path: 'a.txt' })).toBe('ask');
    rememberAlwaysAllow(SESSION, 'write');
    expect(write(path.join(elsewhere, 'a.txt'))).toEqual({ action: 'allow' });
  });

  it('leaves bash to the command lists', () => {
    setBashCommandLists(['*'], []);
    expect(bash(`echo x > ${elsewhere}/a.txt`)).toEqual({ action: 'allow' });
  });
});

describe('bash with the write zone', () => {
  beforeEach(() => {
    setTrustedDirectories(['./', scratch]);
  });

  it('allows a trusted command that writes inside the zone', () => {
    setBashCommandLists(['*'], []);
    expect(bash('echo x > out.txt')).toEqual({ action: 'allow' });
    expect(bash(`echo x > ${scratch}/a.txt`)).toEqual({ action: 'allow' });
  });

  it('asks about a trusted command that writes outside, with the reason', () => {
    setBashCommandLists(['*'], []);
    expect(bash(`echo x > ${elsewhere}/a.txt`)).toEqual({
      action: 'ask',
      reason: { kind: 'write-outside', path: path.join(elsewhere, 'a.txt') },
    });
  });

  it('keeps the command lists in charge of which commands run (D1)', () => {
    setBashCommandLists(['ls *'], ['rm']);
    expect(bash('curl https://example.com > out.txt')).toMatchObject({
      action: 'ask',
      reason: { kind: 'not-trusted' },
    });
    expect(bash('rm -rf out')).toMatchObject({ action: 'ask', reason: { kind: 'denied' } });
  });

  it('checks writes even when both command lists are empty (D9)', () => {
    expect(bash(`echo x > ${elsewhere}/a.txt`)).toMatchObject({
      action: 'ask',
      reason: { kind: 'write-outside' },
    });
    // Nothing visible lands outside → the generic bash rule decides, as today.
    expect(bash('echo x > out.txt')).toEqual({ action: 'ask' });
    setPermissionRules([{ tool: 'bash', action: 'allow' }]);
    expect(bash('echo x > out.txt')).toEqual({ action: 'allow' });
    expect(bash(`echo x > ${elsewhere}/a.txt`).action).toBe('ask');
  });

  it('is not overridden by the session "always allow" memory', () => {
    rememberAlwaysAllow(SESSION, 'bash');
    expect(bash('ls -la')).toEqual({ action: 'allow' });
    expect(bash(`echo x > ${elsewhere}/a.txt`).action).toBe('ask');
  });

  it('is not fooled by $\'…\' quoting, with trust-all lists and "always allow" both on', () => {
    setBashCommandLists(['*'], []);
    rememberAlwaysAllow(SESSION, 'bash');
    for (const command of [
      `echo x > $'${elsewhere}/a.txt'`,
      "echo x > $'../outside.txt'",
      `echo x > $"${elsewhere}/a.txt"`,
    ]) {
      expect(bash(command), command).toMatchObject({
        action: 'ask',
        reason: { kind: 'unsupported-syntax' },
      });
    }
    // The same forms ask with the write zone off too: the lists cannot read them either.
    setTrustedDirectories([]);
    expect(bash(`echo x > $'${elsewhere}/a.txt'`).action).toBe('ask');
  });

  it('asks about relative targets when the session has no workspace', () => {
    setBashCommandLists(['*'], []);
    expect(bash('echo x > out.txt', NO_CWD_SESSION)).toMatchObject({
      action: 'ask',
      reason: { kind: 'write-undetermined' },
    });
  });
});

describe('write and edit with the write zone', () => {
  beforeEach(() => {
    setTrustedDirectories(['./', scratch]);
  });

  it('allows a write inside the zone without asking', () => {
    expect(write('src/a.ts')).toEqual({ action: 'allow' });
    expect(write(path.join(workspace, 'b.ts'))).toEqual({ action: 'allow' });
    expect(decidePermission(SESSION, 'edit', { path: path.join(scratch, 'c.ts') })).toBe('allow');
    expect(decidePermission(SESSION, 'Write', { path: 'src/a.ts' })).toBe('allow');
  });

  it('asks about a write outside the zone, with the reason', () => {
    expect(write(path.join(elsewhere, 'a.txt'))).toEqual({
      action: 'ask',
      reason: { kind: 'write-outside', path: path.join(elsewhere, 'a.txt') },
    });
    expect(write('../a.txt').action).toBe('ask');
  });

  it('asks about a write through a link that leads outside', () => {
    expect(write('link-out/a.txt')).toEqual({
      action: 'ask',
      reason: { kind: 'write-outside', path: path.join(elsewhere, 'a.txt') },
    });
  });

  it('keeps asking about outside writes after "always allow" for the tool', () => {
    rememberAlwaysAllow(SESSION, 'write');
    expect(write(path.join(elsewhere, 'a.txt')).action).toBe('ask');
    expect(write('src/a.ts').action).toBe('allow');
  });

  it('lets a user deny rule stand, even inside the zone', () => {
    setPermissionRules([{ tool: 'write', action: 'deny' }]);
    expect(write('src/a.ts')).toEqual({ action: 'deny' });
    // …and an allow rule does not open the outside.
    setPermissionRules([{ tool: 'write', action: 'allow' }]);
    expect(write(path.join(elsewhere, 'a.txt')).action).toBe('ask');
  });

  it('asks about the app settings file even inside the zone', () => {
    setProtectedWriteFiles([appSettingsFile]);
    expect(write('cfg/config.json')).toEqual({
      action: 'ask',
      reason: { kind: 'write-protected', path: appSettingsFile },
    });
    expect(write('cfg/other.json')).toEqual({ action: 'allow' });
  });

  it('asks when the session has no workspace, or the call has no path', () => {
    expect(write(path.join(scratch, 'a.txt'), NO_CWD_SESSION).action).toBe('ask');
    expect(decidePermissionDetailed(SESSION, 'write', {}).action).toBe('ask');
  });

  it('asks about everything when every listed directory was rejected (D12)', () => {
    setTrustedDirectories(['/']);
    expect(write('src/a.ts')).toMatchObject({ action: 'ask', reason: { kind: 'write-outside' } });
  });

  it('does not touch tools it does not cover', () => {
    expect(decidePermission(SESSION, 'read', { path: path.join(elsewhere, 'a.txt') })).toBe(
      'allow'
    );
  });
});
