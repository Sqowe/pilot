/**
 * Pins `resolveToolPath` to pi's own `resolveToCwd`.
 *
 * pi's `write` and `edit` tools resolve their `path` argument with
 * `resolveToCwd(path, cwd)` (dist/core/tools/path-utils.js). The package does
 * not export it, so `src/shared/path-permissions/resolve.ts` mirrors it. If the
 * mirror drifts, the write-zone check would approve one path while the tool
 * writes another — so this test loads pi's real function from the installed
 * package and compares the two on the same inputs.
 *
 * If this fails after a pi upgrade, update the mirror — do not relax the test.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveToolPath } from '../src/shared/path-permissions';

type ResolveToCwd = (filePath: string, cwd: string) => string;

function findPiPackageDir(): string {
  // The package exposes no CJS entry and no `package.json` export, so walk up
  // from this file to the nearest node_modules that contains it.
  let dir = import.meta.dirname;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pi-coding-agent is not installed');
    dir = parent;
  }
}

describe('resolveToolPath mirrors pi resolveToCwd', () => {
  let resolveToCwd: ResolveToCwd;

  beforeAll(async () => {
    const file = path.join(findPiPackageDir(), 'dist', 'core', 'tools', 'path-utils.js');
    const mod = (await import(pathToFileURL(file).href)) as { resolveToCwd: ResolveToCwd };
    resolveToCwd = mod.resolveToCwd;
  });

  const cwd = path.join(os.tmpdir(), 'parity-project');
  const inputs = [
    'a.txt',
    './a.txt',
    'sub/dir/a.txt',
    '../outside/a.txt',
    '../../a.txt',
    '/etc/hosts',
    '/etc/../etc/hosts',
    '~',
    '~/.zshrc',
    '~/a/../b.txt',
    '~other/x',
    '@a.txt',
    '@~/x',
    '@@a.txt',
    'my\u00A0file.txt',
    'thin\u202Fspace.txt',
    'file:///etc/hosts',
    ' leading-space.txt',
    'trailing-space.txt ',
    '.',
    '',
    '/c/Users/me/a.txt',
    'C:\\Users\\me\\a.txt',
  ];

  it.each(inputs)('agrees with pi for %j', (input) => {
    expect(resolveToolPath(input, cwd)).toBe(resolveToCwd(input, cwd));
  });

  it('agrees with pi when the working directory itself starts with `~`', () => {
    expect(resolveToolPath('a.txt', '~/proj')).toBe(resolveToCwd('a.txt', '~/proj'));
  });
});
