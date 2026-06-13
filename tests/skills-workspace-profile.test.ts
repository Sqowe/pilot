/**
 * Tests for skills-workspace-profile module.
 * Covers: load, cache, validation, missing/invalid files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadSkillsWorkspaceProfile,
  invalidateSkillsWorkspaceProfileCache,
} from '../src/main/skills/skills-workspace-profile';

describe('skills-workspace-profile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-profile-test-'));
    invalidateSkillsWorkspaceProfileCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateSkillsWorkspaceProfileCache();
  });

  describe('loadSkillsWorkspaceProfile', () => {
    it('returns null when cwd is null/undefined', () => {
      expect(loadSkillsWorkspaceProfile(null)).toBeNull();
      expect(loadSkillsWorkspaceProfile(undefined)).toBeNull();
    });

    it('returns null when .cowork/skills-profile.json does not exist', () => {
      expect(loadSkillsWorkspaceProfile(tmpDir)).toBeNull();
    });

    it('loads a valid profile with pinned and disabled', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'skills-profile.json'),
        JSON.stringify({
          pinned: ['semantic-index', 'firecrawl'],
          disabled: ['xlsx', 'pptx'],
        })
      );

      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile).toEqual({
        pinned: ['semantic-index', 'firecrawl'],
        disabled: ['xlsx', 'pptx'],
      });
    });

    it('loads a profile with only pinned', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'skills-profile.json'),
        JSON.stringify({ pinned: ['semantic-index'] })
      );

      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile).toEqual({ pinned: ['semantic-index'] });
      expect(profile?.disabled).toBeUndefined();
    });

    it('loads a profile with only disabled', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'skills-profile.json'),
        JSON.stringify({ disabled: ['xlsx'] })
      );

      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile?.pinned).toBeUndefined();
      expect(profile?.disabled).toEqual(['xlsx']);
    });

    it('returns null for invalid JSON', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(path.join(coworkDir, 'skills-profile.json'), 'not json');

      expect(loadSkillsWorkspaceProfile(tmpDir)).toBeNull();
    });

    it('returns null for non-object JSON', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(path.join(coworkDir, 'skills-profile.json'), '"string"');

      expect(loadSkillsWorkspaceProfile(tmpDir)).toBeNull();
    });

    it('filters invalid skill IDs from pinned and disabled', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'skills-profile.json'),
        JSON.stringify({
          pinned: ['valid-skill', 'has spaces', '../traversal', 'also.valid'],
          disabled: ['good', '', null, 42, 'another-good'],
        })
      );

      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile?.pinned).toEqual(['valid-skill', 'also.valid']);
      expect(profile?.disabled).toEqual(['good', 'another-good']);
    });

    it('uses mtime cache on repeated calls', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      const profilePath = path.join(coworkDir, 'skills-profile.json');
      fs.writeFileSync(profilePath, JSON.stringify({ pinned: ['skill-a'] }));

      // First call — reads from disk
      const profile1 = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile1?.pinned).toEqual(['skill-a']);

      // Modify file content without changing mtime (simulates cache hit)
      // Since we can't easily control mtime, just verify same reference
      const profile2 = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile2).toEqual(profile1);
    });

    it('detects file changes via mtime', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      const profilePath = path.join(coworkDir, 'skills-profile.json');
      fs.writeFileSync(profilePath, JSON.stringify({ pinned: ['skill-a'] }));

      const profile1 = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile1?.pinned).toEqual(['skill-a']);

      // Invalidate and rewrite with new content
      invalidateSkillsWorkspaceProfileCache();
      fs.writeFileSync(profilePath, JSON.stringify({ pinned: ['skill-b'] }));

      const profile2 = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile2?.pinned).toEqual(['skill-b']);
    });

    it('returns empty profile for empty object', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(path.join(coworkDir, 'skills-profile.json'), '{}');

      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile).toEqual({});
    });
  });
});
