/**
 * Tests for skill-conflict-detector module.
 * Covers: source discovery, conflict detection, policy resolution, sync actions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverAllSkillSources,
  detectConflicts,
  resolveConflict,
  computeSyncActions,
  getNewConflicts,
} from '../src/main/skills/skill-conflict-detector';
import type { SkillSourceEntry } from '../src/main/skills/skill-conflict-detector';
import { createDefaultSkillConflictConfig } from '../src/shared/skill-conflict-types';
import type { SkillConflictConfig } from '../src/shared/skill-conflict-types';

// --- Test Helpers ---

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-conflict-test-'));
}

function createSkillDir(baseDir: string, skillName: string): string {
  const skillPath = path.join(baseDir, skillName);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), `# ${skillName}\nTest skill`);
  return skillPath;
}

describe('skill-conflict-detector', () => {
  let tmpDir: string;
  let builtinDir: string;
  let userDir: string;
  let configuredDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    builtinDir = path.join(tmpDir, 'builtin');
    userDir = path.join(tmpDir, 'user');
    configuredDir = path.join(tmpDir, 'configured');
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(builtinDir);
    fs.mkdirSync(userDir);
    fs.mkdirSync(configuredDir);
    fs.mkdirSync(projectDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- discoverAllSkillSources ---

  describe('discoverAllSkillSources', () => {
    it('discovers skills from all four sources', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'my-skill');
      createSkillDir(configuredDir, 'team-skill');
      createSkillDir(projectDir, 'project-local');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir, configuredDir, projectDir);

      expect(sourceMap.size).toBe(4);
      expect(sourceMap.get('pdf')).toHaveLength(1);
      expect(sourceMap.get('pdf')![0].source).toBe('builtin');
      expect(sourceMap.get('my-skill')![0].source).toBe('user');
      expect(sourceMap.get('team-skill')![0].source).toBe('configured');
      expect(sourceMap.get('project-local')![0].source).toBe('project');
    });

    it('detects same name in multiple sources', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'pdf');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      expect(sourceMap.get('pdf')).toHaveLength(2);
      const sources = sourceMap.get('pdf')!.map((s) => s.source);
      expect(sources).toContain('builtin');
      expect(sources).toContain('user');
    });

    it('ignores directories without SKILL.md', () => {
      fs.mkdirSync(path.join(builtinDir, 'no-skill-md'));

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      expect(sourceMap.size).toBe(0);
    });

    it('ignores non-directory entries', () => {
      fs.writeFileSync(path.join(builtinDir, 'not-a-dir'), 'file');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      expect(sourceMap.size).toBe(0);
    });

    it('handles non-existent directories gracefully', () => {
      const sourceMap = discoverAllSkillSources('/nonexistent', '/also-nonexistent');
      expect(sourceMap.size).toBe(0);
    });

    it('skips configured dir when it equals user dir', () => {
      createSkillDir(userDir, 'my-skill');
      const sourceMap = discoverAllSkillSources(builtinDir, userDir, userDir);
      expect(sourceMap.get('my-skill')).toHaveLength(1);
    });

    it('ignores invalid skill IDs', () => {
      createSkillDir(builtinDir, 'valid-skill');
      // These should be filtered: spaces, path separators
      fs.mkdirSync(path.join(builtinDir, 'has spaces'));
      fs.writeFileSync(path.join(builtinDir, 'has spaces', 'SKILL.md'), '# bad');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      expect(sourceMap.size).toBe(1);
      expect(sourceMap.has('valid-skill')).toBe(true);
    });
  });

  // --- detectConflicts ---

  describe('detectConflicts', () => {
    it('returns empty array when no conflicts exist', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'my-custom');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config = createDefaultSkillConflictConfig();
      const conflicts = detectConflicts(sourceMap, config);

      expect(conflicts).toHaveLength(0);
    });

    it('detects a conflict when same name in multiple sources', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'pdf');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config = createDefaultSkillConflictConfig();
      const conflicts = detectConflicts(sourceMap, config);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].skillName).toBe('pdf');
      expect(conflicts[0].sources).toHaveLength(2);
    });

    it('sets acknowledged flag based on config', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'pdf');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        acknowledgedConflicts: ['pdf'],
      };
      const conflicts = detectConflicts(sourceMap, config);

      expect(conflicts[0].acknowledged).toBe(true);
    });

    it('excludes disabled skills from conflicts', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'pdf');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        disabledSkills: ['pdf'],
      };
      const conflicts = detectConflicts(sourceMap, config);

      expect(conflicts).toHaveLength(0);
    });
  });

  // --- resolveConflict ---

  describe('resolveConflict', () => {
    const builtinEntry: SkillSourceEntry = { source: 'builtin', path: '/app/skills/pdf' };
    const userEntry: SkillSourceEntry = { source: 'user', path: '/home/.claude/skills/pdf' };
    const configuredEntry: SkillSourceEntry = { source: 'configured', path: '/team/skills/pdf' };
    const projectEntry: SkillSourceEntry = { source: 'project', path: '/project/.skills/pdf' };

    it('custom-wins: highest priority wins (project > configured > user > builtin)', () => {
      const config = createDefaultSkillConflictConfig(); // custom-wins
      const allSources = [builtinEntry, userEntry, configuredEntry, projectEntry];

      const result = resolveConflict('pdf', allSources, config);
      expect(result.winner.source).toBe('project');
      expect(result.hasConflict).toBe(true);
      expect(result.policy).toBe('custom-wins');
    });

    it('custom-wins: user beats builtin', () => {
      const config = createDefaultSkillConflictConfig();
      const result = resolveConflict('pdf', [builtinEntry, userEntry], config);
      expect(result.winner.source).toBe('user');
    });

    it('builtin-wins: builtin always wins', () => {
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        conflictPolicy: 'builtin-wins',
      };
      const result = resolveConflict('pdf', [builtinEntry, userEntry, configuredEntry], config);
      expect(result.winner.source).toBe('builtin');
    });

    it('builtin-wins: falls back to highest priority when no builtin present', () => {
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        conflictPolicy: 'builtin-wins',
      };
      const result = resolveConflict('pdf', [userEntry, configuredEntry], config);
      expect(result.winner.source).toBe('configured');
    });

    it('ask + unacknowledged: defaults to builtin', () => {
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        conflictPolicy: 'ask',
      };
      const result = resolveConflict('pdf', [builtinEntry, userEntry], config);
      expect(result.winner.source).toBe('builtin');
      expect(result.policy).toBe('ask');
    });

    it('ask + unacknowledged + no builtin: uses priority (configured > user)', () => {
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        conflictPolicy: 'ask',
      };
      const result = resolveConflict('pdf', [userEntry, configuredEntry], config);
      expect(result.winner.source).toBe('configured');
      expect(result.policy).toBe('ask');
    });

    it('ask + acknowledged: uses highest priority (custom-wins fallback)', () => {
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        conflictPolicy: 'ask',
        acknowledgedConflicts: ['pdf'],
      };
      const result = resolveConflict('pdf', [builtinEntry, userEntry], config);
      expect(result.winner.source).toBe('user');
    });

    it('per-skill override takes precedence over policy', () => {
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        conflictPolicy: 'custom-wins',
        sourceOverrides: { pdf: 'builtin' },
      };
      const result = resolveConflict('pdf', [builtinEntry, userEntry], config);
      expect(result.winner.source).toBe('builtin');
      expect(result.policy).toBe('override');
    });

    it('override to non-existent source falls through to policy', () => {
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        conflictPolicy: 'custom-wins',
        sourceOverrides: { pdf: 'project' }, // project source doesn't exist in these entries
      };
      const result = resolveConflict('pdf', [builtinEntry, userEntry], config);
      expect(result.winner.source).toBe('user'); // custom-wins fallback
    });

    it('single source always wins (no conflict)', () => {
      const config = createDefaultSkillConflictConfig();
      const result = resolveConflict('pdf', [userEntry], config);
      expect(result.winner.source).toBe('user');
      expect(result.hasConflict).toBe(false);
    });
  });

  // --- computeSyncActions ---

  describe('computeSyncActions', () => {
    it('skips disabled skills', () => {
      createSkillDir(userDir, 'my-skill');
      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        disabledSkills: ['my-skill'],
      };

      const actions = computeSyncActions(sourceMap, config, builtinDir);
      const mySkillAction = actions.find((a) => a.skillName === 'my-skill');
      expect(mySkillAction).toBeDefined();
      expect(mySkillAction!.action).toBe('skip');
    });

    it('generates symlink action for non-conflicting user skill', () => {
      createSkillDir(userDir, 'my-custom');
      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config = createDefaultSkillConflictConfig();

      const actions = computeSyncActions(sourceMap, config, builtinDir);
      const action = actions.find((a) => a.skillName === 'my-custom');
      expect(action).toBeDefined();
      expect(action!.action).toBe('symlink');
    });

    it('generates remove-and-symlink for custom-wins conflict', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'pdf');
      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config = createDefaultSkillConflictConfig(); // custom-wins

      // Simulate built-in existing as a real directory in runtime
      const runtimeDir = path.join(tmpDir, 'runtime');
      fs.mkdirSync(runtimeDir);
      const runtimePdf = path.join(runtimeDir, 'pdf');
      fs.mkdirSync(runtimePdf);
      fs.writeFileSync(path.join(runtimePdf, 'SKILL.md'), '# pdf');

      const actions = computeSyncActions(sourceMap, config, runtimeDir);
      const pdfAction = actions.find((a) => a.skillName === 'pdf');
      expect(pdfAction).toBeDefined();
      expect(pdfAction!.action).toBe('remove-builtin-and-symlink');
      expect(pdfAction!.sourcePath).toContain('user');
    });
  });

  // --- getNewConflicts ---

  describe('getNewConflicts', () => {
    it('returns only unacknowledged conflicts', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'pdf');
      createSkillDir(builtinDir, 'xlsx');
      createSkillDir(userDir, 'xlsx');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        acknowledgedConflicts: ['pdf'],
      };

      const newConflicts = getNewConflicts(sourceMap, config);
      expect(newConflicts).toHaveLength(1);
      expect(newConflicts[0].skillName).toBe('xlsx');
    });

    it('returns empty array when all conflicts are acknowledged', () => {
      createSkillDir(builtinDir, 'pdf');
      createSkillDir(userDir, 'pdf');

      const sourceMap = discoverAllSkillSources(builtinDir, userDir);
      const config: SkillConflictConfig = {
        ...createDefaultSkillConflictConfig(),
        acknowledgedConflicts: ['pdf'],
      };

      const newConflicts = getNewConflicts(sourceMap, config);
      expect(newConflicts).toHaveLength(0);
    });
  });
});
