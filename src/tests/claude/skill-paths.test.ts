import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assembleSkillPaths } from '../../main/claude/skill-paths';

/**
 * The runtime skills dir is mostly symlinks — to bundled built-ins and to
 * `~/.claude/skills` — so the fixture builds it the same way.
 */
let root: string;
let runtime: string;
let builtin: string;
let plugin: string;

function writeSkill(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-paths-'));
  runtime = join(root, 'runtime');
  builtin = join(root, 'builtin');
  plugin = join(root, 'plugin');
  const userSkills = join(root, 'user-skills');

  writeSkill(join(builtin, 'docx'));
  writeSkill(join(builtin, 'pdf'));
  writeSkill(join(userSkills, 'firecrawl'));
  writeSkill(join(plugin, 'pricing'));
  mkdirSync(runtime, { recursive: true });
  // 'junction' makes the links work on Windows without privileges; POSIX ignores it.
  symlinkSync(join(builtin, 'pdf'), join(runtime, 'pdf'), 'junction');
  symlinkSync(join(userSkills, 'firecrawl'), join(runtime, 'firecrawl'), 'junction');
  writeSkill(join(runtime, 'copied-skill'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const none = { sessionDisabled: [], globallyDisabled: [] };

describe('assembleSkillPaths', () => {
  it('lists the runtime dir first, then the other folders, each once and by skill', () => {
    const paths = assembleSkillPaths({
      runtimeDir: runtime,
      // The configured global dir defaults to the runtime dir itself.
      basePaths: [builtin, runtime],
      pluginPaths: [plugin],
      ...none,
    });
    expect(paths).toEqual([
      join(runtime, 'copied-skill'),
      join(runtime, 'firecrawl'),
      join(runtime, 'pdf'),
      join(builtin, 'docx'),
      join(builtin, 'pdf'),
      join(plugin, 'pricing'),
    ]);
  });

  it('leaves out folders that do not exist', () => {
    const paths = assembleSkillPaths({
      runtimeDir: join(root, 'missing-runtime'),
      basePaths: [null, undefined, join(root, 'missing'), builtin],
      pluginPaths: [],
      ...none,
    });
    expect(paths).toEqual([join(builtin, 'docx'), join(builtin, 'pdf')]);
  });

  it('keeps symlinked skills', () => {
    // Regression: Dirent reports symlinks as links, and the expansion used to skip every
    // one of them — dropping all linked skills of the runtime dir.
    const paths = assembleSkillPaths({
      runtimeDir: runtime,
      basePaths: [],
      pluginPaths: [],
      ...none,
    });
    expect(paths).toEqual([
      join(runtime, 'copied-skill'),
      join(runtime, 'firecrawl'),
      join(runtime, 'pdf'),
    ]);
  });

  it('drops a skill disabled in the settings from the runtime dir and the raw built-in folder', () => {
    // The raw built-in folder still holds a globally disabled built-in, and the runtime dir
    // can hold it again (SkillsManager re-links on listing) — neither may pass it on.
    const paths = assembleSkillPaths({
      runtimeDir: runtime,
      basePaths: [builtin],
      pluginPaths: [],
      sessionDisabled: [],
      globallyDisabled: ['pdf'],
    });
    expect(paths).toEqual([
      join(runtime, 'copied-skill'),
      join(runtime, 'firecrawl'),
      join(builtin, 'docx'),
    ]);
  });

  it('drops a session-disabled skill from every folder, prefixed ID or bare name', () => {
    const paths = assembleSkillPaths({
      runtimeDir: runtime,
      basePaths: [builtin],
      pluginPaths: [plugin],
      sessionDisabled: ['builtin-pdf', 'pricing'],
      globallyDisabled: [],
    });
    expect(paths).toEqual([
      join(runtime, 'copied-skill'),
      join(runtime, 'firecrawl'),
      join(builtin, 'docx'),
    ]);
  });

  it('filters a folder that is itself a single skill by its own name', () => {
    const single = join(builtin, 'pdf');
    expect(
      assembleSkillPaths({
        runtimeDir: runtime,
        basePaths: [single],
        pluginPaths: [],
        sessionDisabled: [],
        globallyDisabled: ['pdf'],
      })
    ).not.toContain(single);
  });

  it('takes what pi takes from a folder: no dot entries or node_modules, top-level .md files', () => {
    const misc = join(root, 'misc');
    writeSkill(join(misc, 'skill-a'));
    writeSkill(join(misc, '.hidden'));
    writeSkill(join(misc, 'node_modules', 'dep'));
    writeFileSync(join(misc, 'notes.md'), '---\nname: notes\ndescription: notes\n---\n');
    writeFileSync(join(misc, 'README.txt'), 'not a skill');
    expect(
      assembleSkillPaths({ runtimeDir: misc, basePaths: [], pluginPaths: [], ...none })
    ).toEqual([join(misc, 'notes.md'), join(misc, 'skill-a')]);
  });

  it('changes when a skill leaves a folder, so a cached session is rebuilt', () => {
    // The runner compares JSON of this list to decide whether a cached pi session still
    // has the right skills; a list of bare folders stayed the same when a link was removed.
    const folder = join(root, 'changing');
    mkdirSync(folder, { recursive: true });
    symlinkSync(join(builtin, 'docx'), join(folder, 'docx'), 'junction');
    const input = { runtimeDir: folder, basePaths: [], pluginPaths: [], ...none };
    const before = JSON.stringify(assembleSkillPaths(input));
    unlinkSync(join(folder, 'docx'));
    expect(JSON.stringify(assembleSkillPaths(input))).not.toBe(before);
  });
});
