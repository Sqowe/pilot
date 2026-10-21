import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  RETIRED_BUILTIN_SKILLS,
  removeRetiredBuiltinSkills,
} from '../../main/skills/retired-builtin-skills';

let root: string;
let runtime: string;
let userSkills: string;

function writeSkill(dir: string, ...markers: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
  for (const marker of markers) writeFileSync(join(dir, marker), 'x');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retired-skills-'));
  runtime = join(root, 'runtime');
  userSkills = join(root, 'user-skills');
  mkdirSync(runtime, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('removeRetiredBuiltinSkills', () => {
  it('lists cowork-memory, and no retired name is shipped again', () => {
    expect(RETIRED_BUILTIN_SKILLS).toContain('cowork-memory');
    // A retired name back in the bundle would be linked and removed again on every start.
    const bundled = resolve(__dirname, '../../../resources/skills');
    for (const name of RETIRED_BUILTIN_SKILLS) {
      expect(existsSync(join(bundled, name))).toBe(false);
    }
  });

  it('removes a link left pointing at the bundled folder that is gone', () => {
    // 'junction' makes the link work on Windows without privileges; POSIX ignores it.
    symlinkSync(join(root, 'gone', 'retired'), join(runtime, 'retired'), 'junction');
    expect(removeRetiredBuiltinSkills(runtime, [userSkills], ['retired'])).toEqual([
      join(runtime, 'retired'),
    ]);
  });

  it('removes a live link into an older app build still on disk', () => {
    // The installed app seen from a development build, or the previous version's folder a
    // Windows update keeps: the bundled copy still exists there.
    const oldBuild = join(root, 'Old.app', 'Contents', 'Resources', 'skills');
    writeSkill(join(oldBuild, 'retired'));
    symlinkSync(join(oldBuild, 'retired'), join(runtime, 'retired'), 'junction');
    expect(removeRetiredBuiltinSkills(runtime, [userSkills], ['retired'])).toEqual([
      join(runtime, 'retired'),
    ]);
    expect(existsSync(join(oldBuild, 'retired', 'SKILL.md'))).toBe(true);
  });

  it('removes a copy the app made of the built-in', () => {
    writeSkill(join(runtime, 'retired'), '.builtin-hash');
    expect(removeRetiredBuiltinSkills(runtime, [userSkills], ['retired'])).toEqual([
      join(runtime, 'retired'),
    ]);
    expect(existsSync(join(runtime, 'retired'))).toBe(false);
  });

  it("keeps a live link into the user's skills — their own skill of the same name", () => {
    writeSkill(join(userSkills, 'retired'));
    symlinkSync(join(userSkills, 'retired'), join(runtime, 'retired'), 'junction');
    expect(removeRetiredBuiltinSkills(runtime, [userSkills], ['retired'])).toEqual([]);
    expect(existsSync(join(runtime, 'retired', 'SKILL.md'))).toBe(true);
  });

  it('keeps a copy the user protected from updates', () => {
    writeSkill(join(runtime, 'retired'), '.builtin-hash', '.user-modified');
    expect(removeRetiredBuiltinSkills(runtime, [userSkills], ['retired'])).toEqual([]);
    expect(existsSync(join(runtime, 'retired', 'SKILL.md'))).toBe(true);
  });

  it('keeps a directory the app did not make', () => {
    writeSkill(join(runtime, 'retired'));
    expect(removeRetiredBuiltinSkills(runtime, [userSkills], ['retired'])).toEqual([]);
    expect(existsSync(join(runtime, 'retired', 'SKILL.md'))).toBe(true);
  });

  it('touches only the retired names, and nothing when they are absent', () => {
    writeSkill(join(runtime, 'docx'), '.builtin-hash');
    expect(removeRetiredBuiltinSkills(runtime, [userSkills], ['retired'])).toEqual([]);
    expect(existsSync(join(runtime, 'docx', 'SKILL.md'))).toBe(true);
  });
});
