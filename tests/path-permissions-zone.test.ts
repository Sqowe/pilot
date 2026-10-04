/**
 * Unit tests for the trusted-directories write zone
 * (src/shared/path-permissions/zone.ts and tool-decision.ts), against real
 * temporary directories and symbolic links.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildWriteZone,
  classifyAbsolutePath,
  decideWriteToolZone,
  describeRejectedDirectory,
  describeWriteZoneReason,
} from '../src/shared/path-permissions';

let base: string; // container for everything below
let home: string; // fake home directory
let project: string; // fake project, inside the fake home
let scratch: string; // a directory outside both, standing in for /tmp
let elsewhere: string; // another outside directory

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-zone-')));
  home = path.join(base, 'home', 'me');
  project = path.join(home, 'src', 'proj');
  scratch = path.join(base, 'scratch');
  elsewhere = path.join(base, 'elsewhere');
  for (const dir of [project, scratch, elsewhere, path.join(project, 'cache')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(project, '.pi'));
  fs.writeFileSync(path.join(project, '.pi', 'bash-restrictions.json'), '{}');
  fs.writeFileSync(path.join(elsewhere, 'target.txt'), 'x');
  // A link inside the project that leads outside it.
  fs.symlinkSync(elsewhere, path.join(project, 'link-out'));
  // A link inside the project that leads to the protected settings file.
  fs.symlinkSync(
    path.join(project, '.pi', 'bash-restrictions.json'),
    path.join(project, 'settings-alias.json')
  );
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const zoneFor = (
  entries: string[],
  extra: Partial<Parameters<typeof buildWriteZone>[0]> = {}
): ReturnType<typeof buildWriteZone> =>
  buildWriteZone({ entries, cwd: project, homeDir: home, ...extra });

describe('buildWriteZone — enabling', () => {
  it('is off when no directory is listed', () => {
    const zone = zoneFor([]);
    expect(zone.enabled).toBe(false);
    expect(zone.roots).toEqual([]);
  });

  it('ignores blank entries when deciding whether the list is empty', () => {
    expect(zoneFor(['', '   ']).enabled).toBe(false);
  });

  it('resolves `./` against the working directory', () => {
    const zone = zoneFor(['./']);
    expect(zone.enabled).toBe(true);
    expect(zone.roots).toEqual([project]);
    expect(zone.rejected).toEqual([]);
  });

  it('accepts absolute entries and entries under `~`', () => {
    const zone = zoneFor([scratch, '~/src/proj/cache']);
    expect(zone.roots).toEqual([scratch, path.join(project, 'cache')]);
  });

  it('lists a directory once even when it is written two ways', () => {
    expect(zoneFor(['./', project, '.']).roots).toEqual([project]);
  });
});

describe('buildWriteZone — entries that are not accepted', () => {
  it('rejects the home directory itself', () => {
    const zone = zoneFor(['~']);
    expect(zone.roots).toEqual([]);
    expect(zone.rejected).toEqual([{ entry: '~', reason: 'too-broad' }]);
  });

  it('rejects a directory that contains the home directory', () => {
    const zone = zoneFor([path.join(base, 'home')]);
    expect(zone.rejected[0]?.reason).toBe('too-broad');
  });

  it('rejects the file-system root', () => {
    const zone = zoneFor([path.parse(base).root]);
    expect(zone.rejected[0]?.reason).toBe('too-broad');
  });

  it('rejects `./` when the session runs in the home directory', () => {
    const zone = zoneFor(['./'], { cwd: home });
    expect(zone.roots).toEqual([]);
    expect(zone.rejected).toEqual([{ entry: './', reason: 'too-broad' }]);
  });

  it('stays enabled when every entry was rejected — nothing is inside', () => {
    const zone = zoneFor(['~']);
    expect(zone.enabled).toBe(true);
    expect(classifyAbsolutePath(path.join(project, 'a.txt'), zone).zone).toBe('outside');
  });

  it('rejects a relative entry when the working directory is unknown', () => {
    const zone = zoneFor(['./'], { cwd: undefined });
    expect(zone.enabled).toBe(true);
    expect(zone.rejected).toEqual([{ entry: './', reason: 'needs-working-directory' }]);
  });

  it('describes each rejection in words', () => {
    expect(describeRejectedDirectory({ entry: '~', reason: 'too-broad' })).toContain('home');
    expect(describeRejectedDirectory({ entry: '/tmp', reason: 'outside-project' })).toContain(
      'outside the project'
    );
  });
});

describe('buildWriteZone — project entries', () => {
  it('accepts a project entry inside the project', () => {
    const zone = zoneFor([], { projectEntries: ['./cache'] });
    expect(zone.roots).toEqual([path.join(project, 'cache')]);
  });

  it('rejects a project entry outside the project', () => {
    const zone = zoneFor([], { projectEntries: [scratch] });
    expect(zone.roots).toEqual([]);
    expect(zone.rejected).toEqual([{ entry: scratch, reason: 'outside-project' }]);
    expect(zone.enabled).toBe(true);
  });

  it('rejects a project entry that climbs out with `..`', () => {
    const zone = zoneFor([], { projectEntries: ['../other'] });
    expect(zone.rejected[0]?.reason).toBe('outside-project');
  });

  it('rejects a project entry that is a link leading outside the project', () => {
    const zone = zoneFor([], { projectEntries: ['./link-out'] });
    expect(zone.roots).toEqual([]);
    expect(zone.rejected[0]?.reason).toBe('outside-project');
  });

  it('lets the global list name an outside directory the project list may not', () => {
    const zone = zoneFor([scratch], { projectEntries: [scratch, './'] });
    expect(zone.roots).toEqual([scratch, project]);
    expect(zone.rejected).toEqual([{ entry: scratch, reason: 'outside-project' }]);
  });
});

describe('classifyAbsolutePath', () => {
  it('classifies paths inside and outside the zone', () => {
    const zone = zoneFor(['./', scratch]);
    expect(classifyAbsolutePath(path.join(project, 'src', 'a.ts'), zone).zone).toBe('inside');
    expect(classifyAbsolutePath(project, zone).zone).toBe('inside');
    expect(classifyAbsolutePath(path.join(scratch, 'new', 'b.txt'), zone).zone).toBe('inside');
    expect(classifyAbsolutePath(path.join(elsewhere, 'target.txt'), zone).zone).toBe('outside');
    expect(classifyAbsolutePath(path.join(home, '.zshrc'), zone).zone).toBe('outside');
  });

  it('does not confuse a neighbour with a similar name', () => {
    const zone = zoneFor(['./']);
    expect(classifyAbsolutePath(`${project}-2/a.txt`, zone).zone).toBe('outside');
  });

  it('treats a write through a link that leads outside as outside', () => {
    const zone = zoneFor(['./']);
    const result = classifyAbsolutePath(path.join(project, 'link-out', 'target.txt'), zone);
    expect(result.zone).toBe('outside');
    expect(result.realPath).toBe(path.join(elsewhere, 'target.txt'));
  });

  it('reports the gate settings file as protected, also through a link', () => {
    const settings = path.join(project, '.pi', 'bash-restrictions.json');
    const zone = zoneFor(['./'], { protectedFiles: [settings] });
    expect(classifyAbsolutePath(settings, zone).zone).toBe('protected');
    expect(classifyAbsolutePath(path.join(project, 'settings-alias.json'), zone).zone).toBe(
      'protected'
    );
    expect(classifyAbsolutePath(path.join(project, '.pi', 'other.json'), zone).zone).toBe('inside');
  });

  it('protects a settings file that does not exist yet', () => {
    const future = path.join(project, 'cache', 'bash-restrictions.json');
    const zone = zoneFor(['./'], { protectedFiles: [future] });
    expect(classifyAbsolutePath(future, zone).zone).toBe('protected');
  });
});

describe('decideWriteToolZone', () => {
  const ctxFor = (entries: string[], extra: Record<string, unknown> = {}) => ({
    zone: zoneFor(entries, extra),
    cwd: project as string | undefined,
    homeDir: home,
  });

  it('has no opinion when the zone is off', () => {
    expect(decideWriteToolZone('write', { path: '/etc/hosts' }, ctxFor([]))).toBeNull();
  });

  it('has no opinion about tools it does not cover', () => {
    expect(decideWriteToolZone('read', { path: '/etc/hosts' }, ctxFor(['./']))).toBeNull();
    expect(decideWriteToolZone('bash', { command: 'ls' }, ctxFor(['./']))).toBeNull();
  });

  it('allows write and edit inside the zone, by relative or full path', () => {
    const ctx = ctxFor(['./']);
    expect(decideWriteToolZone('write', { path: 'src/a.ts' }, ctx)).toEqual({ decision: 'allow' });
    expect(decideWriteToolZone('edit', { path: path.join(project, 'src', 'a.ts') }, ctx)).toEqual({
      decision: 'allow',
    });
    expect(decideWriteToolZone('Write', { path: 'src/a.ts' }, ctx)).toEqual({ decision: 'allow' });
  });

  it('asks for a path outside the zone and names it', () => {
    const result = decideWriteToolZone('write', { path: '~/.zshrc' }, ctxFor(['./']));
    expect(result).toEqual({
      decision: 'ask',
      reason: { kind: 'write-outside', path: path.join(home, '.zshrc') },
    });
  });

  it('asks for a path that climbs out with `..`', () => {
    const result = decideWriteToolZone('write', { path: '../other/a.txt' }, ctxFor(['./']));
    expect(result?.decision).toBe('ask');
  });

  it('asks for a write through a link that leads outside', () => {
    const result = decideWriteToolZone('edit', { path: 'link-out/target.txt' }, ctxFor(['./']));
    expect(result?.reason).toEqual({
      kind: 'write-outside',
      path: path.join(elsewhere, 'target.txt'),
    });
  });

  it('asks for the gate settings file even inside the zone', () => {
    const settings = path.join(project, '.pi', 'bash-restrictions.json');
    const ctx = ctxFor(['./'], { protectedFiles: [settings] });
    expect(
      decideWriteToolZone('write', { path: '.pi/bash-restrictions.json' }, ctx)?.reason
    ).toEqual({ kind: 'write-protected', path: settings });
    expect(decideWriteToolZone('edit', { path: 'settings-alias.json' }, ctx)?.decision).toBe('ask');
  });

  it('asks when the path is missing or the working directory is unknown', () => {
    expect(decideWriteToolZone('write', {}, ctxFor(['./']))?.decision).toBe('ask');
    expect(decideWriteToolZone('write', null, ctxFor(['./']))?.decision).toBe('ask');
    const noCwd = { ...ctxFor([scratch]), cwd: undefined };
    expect(decideWriteToolZone('write', { path: path.join(scratch, 'a') }, noCwd)?.decision).toBe(
      'ask'
    );
  });

  it('asks for everything when every listed directory was rejected', () => {
    const result = decideWriteToolZone('write', { path: 'src/a.ts' }, ctxFor(['~']));
    expect(result?.decision).toBe('ask');
  });

  it('describes reasons in words', () => {
    expect(describeWriteZoneReason({ kind: 'write-outside', path: '/etc/hosts' })).toBe(
      'writes outside the trusted directories: /etc/hosts'
    );
    expect(describeWriteZoneReason({ kind: 'write-protected', path: '/p/x.json' })).toContain(
      'permission settings file'
    );
    expect(describeWriteZoneReason({ kind: 'write-undetermined', detail: '$OUT/f' })).toContain(
      '$OUT/f'
    );
  });
});
