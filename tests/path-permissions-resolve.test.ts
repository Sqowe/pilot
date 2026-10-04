/**
 * Unit tests for the fs-aware path resolver behind the trusted-directories
 * write zone (src/shared/path-permissions/resolve.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeWindowsShellPath,
  realpathExistingPortion,
  resolveShellPath,
  resolveToolPath,
} from '../src/shared/path-permissions';

const posix = { platform: 'linux' as NodeJS.Platform, homeDir: '/home/me' };
const win = { platform: 'win32' as NodeJS.Platform, homeDir: 'C:\\Users\\me' };

describe('normalizeWindowsShellPath', () => {
  it('converts Git Bash, WSL and Cygwin drive paths', () => {
    expect(normalizeWindowsShellPath('/c/Users/me/a.txt')).toBe('C:\\Users\\me\\a.txt');
    expect(normalizeWindowsShellPath('/mnt/d/work')).toBe('D:\\work');
    expect(normalizeWindowsShellPath('/cygdrive/c')).toBe('C:\\');
  });

  it('leaves other paths untouched', () => {
    expect(normalizeWindowsShellPath('/usr/bin')).toBe('/usr/bin');
    expect(normalizeWindowsShellPath('//server/share')).toBe('//server/share');
    expect(normalizeWindowsShellPath('C:\\Users\\me')).toBe('C:\\Users\\me');
    expect(normalizeWindowsShellPath('relative/x')).toBe('relative/x');
  });
});

describe('resolveToolPath (posix)', () => {
  it('resolves a relative path against the working directory', () => {
    expect(resolveToolPath('docs/a.md', '/work/proj', posix)).toBe('/work/proj/docs/a.md');
  });

  it('keeps an absolute path and removes `..`', () => {
    expect(resolveToolPath('/work/proj/../other/a.md', '/work/proj', posix)).toBe(
      '/work/other/a.md'
    );
  });

  it('expands `~` and `~/`', () => {
    expect(resolveToolPath('~', '/work/proj', posix)).toBe('/home/me');
    expect(resolveToolPath('~/.zshrc', '/work/proj', posix)).toBe('/home/me/.zshrc');
  });

  it('does not expand `~user`', () => {
    expect(resolveToolPath('~other/x', '/work/proj', posix)).toBe('/work/proj/~other/x');
  });

  it('strips a leading `@` and normalizes unicode spaces, as pi does', () => {
    expect(resolveToolPath('@docs/a.md', '/work/proj', posix)).toBe('/work/proj/docs/a.md');
    expect(resolveToolPath('my\u00A0file.txt', '/work/proj', posix)).toBe('/work/proj/my file.txt');
  });

  it('accepts file:// URLs', () => {
    expect(resolveToolPath('file:///etc/hosts', '/work/proj', posix)).toBe('/etc/hosts');
  });

  it('returns null for a malformed file:// URL instead of throwing', () => {
    expect(resolveToolPath('file://%zz', '/work/proj', posix)).toBeNull();
  });
});

describe('resolveToolPath (win32)', () => {
  it('converts Git Bash drive paths before resolving', () => {
    expect(resolveToolPath('/c/proj/a.txt', 'C:\\proj', win)).toBe('C:\\proj\\a.txt');
  });

  it('resolves relative paths with either separator', () => {
    expect(resolveToolPath('sub\\a.txt', 'C:\\proj', win)).toBe('C:\\proj\\sub\\a.txt');
    expect(resolveToolPath('sub/a.txt', 'C:\\proj', win)).toBe('C:\\proj\\sub\\a.txt');
  });

  it('expands `~\\`', () => {
    expect(resolveToolPath('~\\notes.txt', 'C:\\proj', win)).toBe('C:\\Users\\me\\notes.txt');
  });
});

describe('resolveShellPath', () => {
  it('resolves relative and absolute words against the base directory', () => {
    expect(resolveShellPath('out.txt', '/work/proj', posix)).toBe('/work/proj/out.txt');
    expect(resolveShellPath('/etc/hosts', '/work/proj', posix)).toBe('/etc/hosts');
    expect(resolveShellPath('../x', '/work/proj', posix)).toBe('/work/x');
  });

  it('does not apply pi tool rewrites (`@` stays part of the name)', () => {
    expect(resolveShellPath('@x', '/work/proj', posix)).toBe('/work/proj/@x');
  });

  it('converts Git Bash drive paths on Windows', () => {
    expect(resolveShellPath('/c/tmp/out.txt', 'C:\\proj', win)).toBe('C:\\tmp\\out.txt');
  });
});

describe('realpathExistingPortion', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-resolve-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-outside-')));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'x');
    fs.symlinkSync(outside, path.join(root, 'link-out'));
    fs.symlinkSync(path.join(outside, 'not-there.txt'), path.join(root, 'dangling'));
    fs.symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
    fs.symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('returns the real path of an existing file', () => {
    expect(realpathExistingPortion(path.join(root, 'sub', 'file.txt'))).toBe(
      path.join(root, 'sub', 'file.txt')
    );
  });

  it('resolves a target that does not exist yet through its existing ancestor', () => {
    expect(realpathExistingPortion(path.join(root, 'sub', 'new', 'deep.txt'))).toBe(
      path.join(root, 'sub', 'new', 'deep.txt')
    );
  });

  it('follows a symbolic link in the middle of the path', () => {
    expect(realpathExistingPortion(path.join(root, 'link-out', 'new.txt'))).toBe(
      path.join(outside, 'new.txt')
    );
  });

  it('follows a link whose destination does not exist yet', () => {
    // Writing through `dangling` would create the file outside `root`.
    expect(realpathExistingPortion(path.join(root, 'dangling'))).toBe(
      path.join(outside, 'not-there.txt')
    );
  });

  it('returns null for a link loop', () => {
    expect(realpathExistingPortion(path.join(root, 'loop-a'))).toBeNull();
  });

  it('resolves the system temp directory to its real location', () => {
    // On macOS os.tmpdir() sits behind a link (/var → /private/var).
    const tmp = os.tmpdir();
    expect(realpathExistingPortion(tmp)).toBe(fs.realpathSync.native(tmp));
  });
});
