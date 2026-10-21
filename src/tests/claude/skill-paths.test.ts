import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('assembleSkillPaths', () => {
  it('puts the runtime dir first, then the other folders, each once', () => {
    const paths = assembleSkillPaths({
      runtimeDir: runtime,
      // The configured global dir defaults to the runtime dir itself.
      basePaths: [builtin, runtime],
      pluginPaths: [plugin],
      sessionDisabled: [],
    });
    expect(paths).toEqual([runtime, builtin, plugin]);
  });

  it('leaves out folders that do not exist', () => {
    const paths = assembleSkillPaths({
      runtimeDir: join(root, 'missing-runtime'),
      basePaths: [null, undefined, join(root, 'missing'), builtin],
      pluginPaths: [],
      sessionDisabled: [],
    });
    expect(paths).toEqual([builtin]);
  });

  it('keeps symlinked skills when a session disables another one', () => {
    // Regression: Dirent reports symlinks as links, and the expansion used to skip every
    // one of them — dropping all linked skills of the runtime dir.
    const paths = assembleSkillPaths({
      runtimeDir: runtime,
      basePaths: [],
      pluginPaths: [],
      sessionDisabled: ['something-else'],
    });
    expect(paths.sort()).toEqual(
      [join(runtime, 'copied-skill'), join(runtime, 'firecrawl'), join(runtime, 'pdf')].sort()
    );
  });

  it('drops a session-disabled skill from every folder, prefixed ID or bare name', () => {
    const paths = assembleSkillPaths({
      runtimeDir: runtime,
      basePaths: [builtin],
      pluginPaths: [plugin],
      sessionDisabled: ['builtin-pdf', 'pricing'],
    });
    expect(paths.sort()).toEqual(
      [join(runtime, 'copied-skill'), join(runtime, 'firecrawl')].sort()
    );
  });

  it('filters a folder that is itself a single skill by its own name', () => {
    const single = join(builtin, 'pdf');
    expect(
      assembleSkillPaths({
        runtimeDir: runtime,
        basePaths: [single],
        pluginPaths: [],
        sessionDisabled: ['pdf'],
      })
    ).not.toContain(single);
  });
});
