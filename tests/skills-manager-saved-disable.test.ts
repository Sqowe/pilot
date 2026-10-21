import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Power button on a skill card goes through SkillsManager.setSkillEnabled. It must save
 * the skill into the list the runner filters by (skillConflictConfig.disabledSkills, passed
 * in as two functions), and every listing must read `enabled` back from that list — before,
 * the button changed an in-memory flag the agent never saw and a restart reset.
 */
let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => testRoot,
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => {
      if (name === 'userData') return path.join(testRoot, 'userData');
      if (name === 'home') return path.join(testRoot, 'home');
      return testRoot;
    },
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { SkillsManager, skillFolderNameOf } from '../src/main/skills/skills-manager';
import type { DatabaseInstance } from '../src/main/db/database';

function createDbMock(): DatabaseInstance {
  // SkillsManager only prepares statements (saving and deleting skill rows).
  const statement = { run: vi.fn() };
  return { prepare: vi.fn(() => statement) } as unknown as DatabaseInstance;
}

function writeSkill(rootPath: string, name: string): void {
  fs.mkdirSync(path.join(rootPath, name), { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
    'utf8'
  );
}

/** A stand-in for skillConflictConfig.disabledSkills, wired the way index.ts wires it. */
function managerWith(saved: Set<string>): SkillsManager {
  return new SkillsManager(createDbMock(), {
    getConfiguredGlobalSkillsPath: () => '',
    isSkillDisabled: (name) => saved.has(name),
    setSkillDisabled: (name, disabled) => {
      if (disabled) saved.add(name);
      else saved.delete(name);
    },
  });
}

async function enabledById(manager: SkillsManager): Promise<Record<string, boolean>> {
  const skills = await manager.listSkills();
  return Object.fromEntries(skills.map((skill) => [skill.id, skill.enabled]));
}

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-skills-saved-disable-'));
  // The built-in folder lookup is cached for the whole module, so it is set up once.
  writeSkill(path.join(testRoot, 'resources', 'skills'), 'pdf');
  writeSkill(path.join(testRoot, 'userData', 'claude', 'skills'), 'firecrawl');
  fs.writeFileSync(
    path.join(testRoot, 'userData', 'claude', 'skills', 'legacy-server.json'),
    JSON.stringify({ name: 'legacy-server', type: 'mcp', mcp: { command: 'true' } })
  );
  fs.mkdirSync(path.join(testRoot, 'home'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('the Power button on a skill card', () => {
  it('saves a built-in and a custom skill by folder name, and enables them again', async () => {
    const saved = new Set<string>();
    const manager = managerWith(saved);
    await manager.listSkills();

    manager.setSkillEnabled('builtin-pdf', false);
    manager.setSkillEnabled('global-firecrawl', false);
    expect([...saved].sort()).toEqual(['firecrawl', 'pdf']);
    expect(await enabledById(manager)).toMatchObject({
      'builtin-pdf': false,
      'global-firecrawl': false,
    });

    manager.setSkillEnabled('builtin-pdf', true);
    expect([...saved]).toEqual(['firecrawl']);
    expect((await enabledById(manager))['builtin-pdf']).toBe(true);
  });

  it('stays off after a restart', async () => {
    const saved = new Set<string>();
    const before = managerWith(saved);
    await before.listSkills();
    before.setSkillEnabled('builtin-pdf', false);

    // A new manager over the same saved list stands in for the next app start.
    const after = managerWith(saved);
    expect((await enabledById(after))['builtin-pdf']).toBe(false);
    expect(after.getAllSkills().find((skill) => skill.id === 'builtin-pdf')?.enabled).toBe(false);
  });

  it('shows a skill disabled through Conflict Resolution as off too', async () => {
    const manager = managerWith(new Set(['firecrawl']));
    expect(await enabledById(manager)).toMatchObject({
      'builtin-pdf': true,
      'global-firecrawl': false,
    });
  });

  it('changes nothing when the list cannot be saved', async () => {
    const manager = new SkillsManager(createDbMock(), {
      getConfiguredGlobalSkillsPath: () => '',
      isSkillDisabled: () => false,
      setSkillDisabled: () => {
        throw new Error('Too many disabled skills (max 200)');
      },
    });
    await manager.listSkills();
    expect(() => manager.setSkillEnabled('builtin-pdf', false)).toThrow('Too many');
    expect((await enabledById(manager))['builtin-pdf']).toBe(true);
  });

  it('leaves a legacy MCP skill out of the saved list', async () => {
    const saved = new Set<string>();
    const manager = managerWith(saved);
    await manager.listSkills();

    manager.setSkillEnabled('global-legacy-server', false);
    expect(saved.size).toBe(0);
    expect((await enabledById(manager))['global-legacy-server']).toBe(false);
  });
});

describe('skillFolderNameOf', () => {
  it('drops the source prefix once', () => {
    expect(skillFolderNameOf('builtin-pdf')).toBe('pdf');
    expect(skillFolderNameOf('global-global-search')).toBe('global-search');
    expect(skillFolderNameOf('project-notes')).toBe('notes');
    expect(skillFolderNameOf('plain')).toBe('plain');
  });
});
