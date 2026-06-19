/**
 * Tests for workspace orphan detection and cleanup.
 *
 * Covers:
 * - Detection logic (skills + MCP orphans)
 * - Dismissal persistence and re-trigger logic
 * - Cleanup execution (partial + full removal)
 * - Edge cases (empty profiles, no workspace configs, etc.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  detectWorkspaceOrphans,
  cleanupOrphans,
  initDismissals,
  recordDismissal,
  isDismissed,
  clearDismissal,
  getDismissals,
} from '../src/main/workspace/workspace-orphan-detector';
import { invalidateSkillsWorkspaceProfileCache } from '../src/main/skills/skills-workspace-profile';

describe('workspace-orphan-detector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-test-'));
    // Reset dismissal state
    initDismissals([]);
    // Invalidate cached profiles
    invalidateSkillsWorkspaceProfileCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkillsProfile(profile: { pinned?: string[]; disabled?: string[] }): void {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    fs.writeFileSync(path.join(coworkDir, 'skills-profile.json'), JSON.stringify(profile, null, 2));
  }

  function writeMcpProfile(profile: { disabled?: string[]; enabled?: string[] }): void {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    fs.writeFileSync(path.join(coworkDir, 'mcp-servers.json'), JSON.stringify(profile, null, 2));
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  describe('detectWorkspaceOrphans', () => {
    it('returns null when cwd is empty', () => {
      expect(detectWorkspaceOrphans('', new Set(), new Set())).toBeNull();
    });

    it('returns null when no .cowork config files exist', () => {
      const result = detectWorkspaceOrphans(tmpDir, new Set(['skill-a']), new Set(['server-a']));
      expect(result).toBeNull();
    });

    it('returns null when all skills in profile are installed', () => {
      writeSkillsProfile({ pinned: ['skill-a'], disabled: ['skill-b'] });
      const installed = new Set(['skill-a', 'skill-b', 'skill-c']);
      const result = detectWorkspaceOrphans(tmpDir, installed, new Set());
      expect(result).toBeNull();
    });

    it('returns null when all MCP servers in profile are configured', () => {
      writeMcpProfile({ disabled: ['server-a'], enabled: ['server-b'] });
      const configured = new Set(['server-a', 'server-b', 'server-c']);
      const result = detectWorkspaceOrphans(tmpDir, new Set(), configured);
      expect(result).toBeNull();
    });

    it('detects orphaned skills in pinned array', () => {
      writeSkillsProfile({ pinned: ['installed', 'orphan-1', 'orphan-2'] });
      const installed = new Set(['installed']);
      const result = detectWorkspaceOrphans(tmpDir, installed, new Set());

      expect(result).not.toBeNull();
      expect(result!.orphanedSkills.inPinned).toEqual(['orphan-1', 'orphan-2']);
      expect(result!.orphanedSkills.inDisabled).toEqual([]);
      expect(result!.totalOrphans).toBe(2);
    });

    it('detects orphaned skills in disabled array', () => {
      writeSkillsProfile({ disabled: ['installed', 'orphan-x'] });
      const installed = new Set(['installed']);
      const result = detectWorkspaceOrphans(tmpDir, installed, new Set());

      expect(result).not.toBeNull();
      expect(result!.orphanedSkills.inDisabled).toEqual(['orphan-x']);
      expect(result!.totalOrphans).toBe(1);
    });

    it('detects orphaned MCP servers in disabled array', () => {
      writeMcpProfile({ disabled: ['configured', 'old-server'] });
      const configured = new Set(['configured']);
      const result = detectWorkspaceOrphans(tmpDir, new Set(), configured);

      expect(result).not.toBeNull();
      expect(result!.orphanedMcpServers.inDisabled).toEqual(['old-server']);
      expect(result!.totalOrphans).toBe(1);
    });

    it('detects orphaned MCP servers in enabled array', () => {
      writeMcpProfile({ enabled: ['configured', 'gone-server'] });
      const configured = new Set(['configured']);
      const result = detectWorkspaceOrphans(tmpDir, new Set(), configured);

      expect(result).not.toBeNull();
      expect(result!.orphanedMcpServers.inEnabled).toEqual(['gone-server']);
      expect(result!.totalOrphans).toBe(1);
    });

    it('combines skill and MCP orphans into total count', () => {
      writeSkillsProfile({ pinned: ['orphan-a'], disabled: ['orphan-b'] });
      writeMcpProfile({ disabled: ['orphan-c'], enabled: ['orphan-d'] });

      const result = detectWorkspaceOrphans(tmpDir, new Set(), new Set());

      expect(result).not.toBeNull();
      expect(result!.totalOrphans).toBe(4);
      expect(result!.orphanedSkills.inPinned).toEqual(['orphan-a']);
      expect(result!.orphanedSkills.inDisabled).toEqual(['orphan-b']);
      expect(result!.orphanedMcpServers.inDisabled).toEqual(['orphan-c']);
      expect(result!.orphanedMcpServers.inEnabled).toEqual(['orphan-d']);
      expect(result!.cwd).toBe(tmpDir);
    });

    it('skips detection when workspace is dismissed', () => {
      writeSkillsProfile({ pinned: ['orphan'] });
      recordDismissal(tmpDir);

      const result = detectWorkspaceOrphans(tmpDir, new Set(), new Set());
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Dismissal logic
  // -------------------------------------------------------------------------

  describe('dismissal', () => {
    it('isDismissed returns false when no dismissal exists', () => {
      expect(isDismissed(tmpDir)).toBe(false);
    });

    it('isDismissed returns true after recordDismissal', () => {
      writeSkillsProfile({ pinned: ['a'] }); // file must exist for mtime tracking
      recordDismissal(tmpDir);
      expect(isDismissed(tmpDir)).toBe(true);
    });

    it('re-triggers when skills profile is modified after dismissal', () => {
      writeSkillsProfile({ pinned: ['a'] });
      recordDismissal(tmpDir);
      expect(isDismissed(tmpDir)).toBe(true);

      // Simulate file modification (bump mtime)
      const profilePath = path.join(tmpDir, '.cowork', 'skills-profile.json');
      const originalMtime = fs.statSync(profilePath).mtimeMs;
      // Force a different mtime by waiting + rewriting
      fs.writeFileSync(profilePath, JSON.stringify({ pinned: ['a', 'b'] }));
      // Manually set future mtime to ensure it differs
      const futureTime = originalMtime + 10000;
      fs.utimesSync(profilePath, futureTime / 1000, futureTime / 1000);

      expect(isDismissed(tmpDir)).toBe(false);
    });

    it('re-triggers when profile file is created after dismissal', () => {
      // Dismiss when no file exists
      recordDismissal(tmpDir);
      expect(isDismissed(tmpDir)).toBe(true);

      // Create the file
      writeSkillsProfile({ pinned: ['new-skill'] });
      expect(isDismissed(tmpDir)).toBe(false);
    });

    it('clearDismissal removes the dismissal', () => {
      writeSkillsProfile({ pinned: ['a'] });
      recordDismissal(tmpDir);
      expect(isDismissed(tmpDir)).toBe(true);

      clearDismissal(tmpDir);
      expect(isDismissed(tmpDir)).toBe(false);
    });

    it('getDismissals returns current state', () => {
      expect(getDismissals()).toEqual([]);
      recordDismissal(tmpDir);
      expect(getDismissals()).toHaveLength(1);
      expect(getDismissals()[0].cwd).toContain('orphan-test-');
    });

    it('initDismissals loads from stored array', () => {
      initDismissals([
        {
          cwd: '/fake/path',
          dismissedAt: Date.now(),
          skillsProfileMtimeMs: null,
          mcpProfileMtimeMs: null,
        },
      ]);
      expect(getDismissals()).toHaveLength(1);
      expect(getDismissals()[0].cwd).toBe('/fake/path');
    });

    it('initDismissals filters invalid entries', () => {
      initDismissals([
        { cwd: '', dismissedAt: 123, skillsProfileMtimeMs: null, mcpProfileMtimeMs: null },
        { cwd: '/valid', dismissedAt: 456, skillsProfileMtimeMs: null, mcpProfileMtimeMs: null },
        // @ts-expect-error — invalid entry for testing
        { cwd: 123, dismissedAt: 'bad' },
      ]);
      // Empty cwd is rejected, invalid types are rejected — only /valid survives
      expect(getDismissals()).toHaveLength(1);
      expect(getDismissals()[0].cwd).toBe('/valid');
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe('cleanupOrphans', () => {
    it('removes specific orphaned skills from profile', async () => {
      writeSkillsProfile({ pinned: ['keep', 'remove-me'], disabled: ['also-remove'] });
      const installed = new Set(['keep']);

      const result = await cleanupOrphans(
        tmpDir,
        ['remove-me', 'also-remove'],
        [],
        installed,
        new Set()
      );

      expect(result.success).toBe(true);
      expect(result.removed.skills).toBe(2);

      // Verify file was updated
      invalidateSkillsWorkspaceProfileCache();
      const { loadSkillsWorkspaceProfile } =
        await import('../src/main/skills/skills-workspace-profile');
      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile?.pinned).toEqual(['keep']);
      expect(profile?.disabled).toBeUndefined();
    });

    it('removes orphaned MCP servers from profile', async () => {
      writeMcpProfile({ disabled: ['keep-server', 'orphan-server'], enabled: ['another-orphan'] });
      const configured = new Set(['keep-server']);

      const result = await cleanupOrphans(
        tmpDir,
        [],
        ['orphan-server', 'another-orphan'],
        new Set(),
        configured
      );

      expect(result.success).toBe(true);
      expect(result.removed.mcp).toBe(2);
    });

    it('deletes profile file when cleanup results in empty arrays', async () => {
      writeSkillsProfile({ pinned: ['orphan-only'] });
      const installed = new Set<string>();

      await cleanupOrphans(tmpDir, ['orphan-only'], [], installed, new Set());

      const profilePath = path.join(tmpDir, '.cowork', 'skills-profile.json');
      expect(fs.existsSync(profilePath)).toBe(false);
    });

    it('clears dismissal after successful cleanup that removes entries', async () => {
      writeSkillsProfile({ pinned: ['orphan'] });
      recordDismissal(tmpDir);
      expect(isDismissed(tmpDir)).toBe(true);

      await cleanupOrphans(tmpDir, ['orphan'], [], new Set(), new Set());

      expect(isDismissed(tmpDir)).toBe(false);
    });

    it('does not clear dismissal when nothing was actually removed', async () => {
      writeSkillsProfile({ pinned: ['installed'] });
      recordDismissal(tmpDir);

      // Request removal of an installed skill — should be rejected
      const installed = new Set(['installed']);
      await cleanupOrphans(tmpDir, ['installed'], [], installed, new Set());

      // Dismissal should remain since nothing was cleaned
      expect(isDismissed(tmpDir)).toBe(true);
    });

    it('returns success with zero removed when empty arrays provided', async () => {
      writeSkillsProfile({ pinned: ['orphan'] });

      const result = await cleanupOrphans(tmpDir, [], [], new Set(), new Set());

      expect(result.success).toBe(true);
      expect(result.removed.skills).toBe(0);
      expect(result.removed.mcp).toBe(0);
    });

    // --- Safety tests ---

    it('refuses to remove installed (non-orphaned) skill IDs', async () => {
      writeSkillsProfile({ pinned: ['installed-skill'], disabled: ['also-installed'] });
      const installed = new Set(['installed-skill', 'also-installed']);

      const result = await cleanupOrphans(
        tmpDir,
        ['installed-skill', 'also-installed'],
        [],
        installed,
        new Set()
      );

      expect(result.success).toBe(true);
      expect(result.removed.skills).toBe(0);

      // Verify profile was NOT modified
      invalidateSkillsWorkspaceProfileCache();
      const { loadSkillsWorkspaceProfile } =
        await import('../src/main/skills/skills-workspace-profile');
      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile?.pinned).toEqual(['installed-skill']);
      expect(profile?.disabled).toEqual(['also-installed']);
    });

    it('refuses to remove configured (non-orphaned) MCP server names', async () => {
      writeMcpProfile({ disabled: ['configured-server'] });
      const configured = new Set(['configured-server']);

      const result = await cleanupOrphans(tmpDir, [], ['configured-server'], new Set(), configured);

      expect(result.success).toBe(true);
      expect(result.removed.mcp).toBe(0);
    });

    it('selecting only skills does not touch MCP profile', async () => {
      writeSkillsProfile({ pinned: ['orphan-skill'] });
      writeMcpProfile({ disabled: ['orphan-server'] });

      await cleanupOrphans(tmpDir, ['orphan-skill'], [], new Set(), new Set());

      // MCP profile should be untouched
      const mcpPath = path.join(tmpDir, '.cowork', 'mcp-servers.json');
      const mcpContent = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      expect(mcpContent.disabled).toEqual(['orphan-server']);
    });

    it('selecting only MCP servers does not touch skills profile', async () => {
      writeSkillsProfile({ pinned: ['orphan-skill'] });
      writeMcpProfile({ disabled: ['orphan-server'] });

      await cleanupOrphans(tmpDir, [], ['orphan-server'], new Set(), new Set());

      // Skills profile should be untouched
      invalidateSkillsWorkspaceProfileCache();
      const { loadSkillsWorkspaceProfile } =
        await import('../src/main/skills/skills-workspace-profile');
      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile?.pinned).toEqual(['orphan-skill']);
    });

    it('preserves unknown fields in skills-profile.json during cleanup', async () => {
      // Write a profile with extra metadata fields
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'skills-profile.json'),
        JSON.stringify(
          {
            pinned: ['keep', 'orphan'],
            disabled: [],
            version: 2,
            customMetadata: { author: 'test-user' },
          },
          null,
          2
        )
      );

      await cleanupOrphans(tmpDir, ['orphan'], [], new Set(['keep']), new Set());

      // Read back and verify unknown fields are preserved
      const raw = JSON.parse(fs.readFileSync(path.join(coworkDir, 'skills-profile.json'), 'utf-8'));
      expect(raw.pinned).toEqual(['keep']);
      expect(raw.version).toBe(2);
      expect(raw.customMetadata).toEqual({ author: 'test-user' });
    });

    it('preserves unknown fields when cleanup empties pinned/disabled', async () => {
      // Profile has only one orphan in pinned, but also has metadata
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'skills-profile.json'),
        JSON.stringify(
          {
            pinned: ['orphan-only'],
            version: 3,
            teamConfig: true,
          },
          null,
          2
        )
      );

      await cleanupOrphans(tmpDir, ['orphan-only'], [], new Set(), new Set());

      // File should still exist with metadata preserved (not deleted)
      const profilePath = path.join(coworkDir, 'skills-profile.json');
      expect(fs.existsSync(profilePath)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      expect(raw.pinned).toBeUndefined();
      expect(raw.version).toBe(3);
      expect(raw.teamConfig).toBe(true);
    });

    it('only removes the orphaned subset from a mixed request', async () => {
      writeSkillsProfile({ pinned: ['installed', 'orphan-a', 'orphan-b'] });
      const installed = new Set(['installed']);

      const result = await cleanupOrphans(
        tmpDir,
        ['installed', 'orphan-a', 'orphan-b'],
        [],
        installed,
        new Set()
      );

      expect(result.removed.skills).toBe(2); // only orphan-a and orphan-b
      invalidateSkillsWorkspaceProfileCache();
      const { loadSkillsWorkspaceProfile } =
        await import('../src/main/skills/skills-workspace-profile');
      const profile = loadSkillsWorkspaceProfile(tmpDir);
      expect(profile?.pinned).toEqual(['installed']);
    });

    // --- Symlink security tests ---

    it('rejects cleanup when .cowork is a symlink (profile not loaded, no modification)', async () => {
      // Create a real .cowork dir elsewhere and symlink it
      const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-cowork-'));
      fs.writeFileSync(
        path.join(realDir, 'skills-profile.json'),
        JSON.stringify({ pinned: ['orphan'] })
      );
      const coworkLink = path.join(tmpDir, '.cowork');
      fs.symlinkSync(realDir, coworkLink);

      // loadSkillsWorkspaceProfile rejects symlinks → profile is null → nothing to clean
      const result = await cleanupOrphans(tmpDir, ['orphan'], [], new Set(), new Set());

      // No error thrown, but nothing was modified
      expect(result.success).toBe(true);
      expect(result.removed.skills).toBe(0);

      // Original file should be untouched (security: symlink was not followed for writes)
      const original = JSON.parse(
        fs.readFileSync(path.join(realDir, 'skills-profile.json'), 'utf-8')
      );
      expect(original.pinned).toEqual(['orphan']);
      fs.rmSync(realDir, { recursive: true, force: true });
    });

    it('rejects cleanup when skills-profile.json is a symlink (profile not loaded, no modification)', async () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });

      // Create a real file elsewhere and symlink it
      const realFile = path.join(os.tmpdir(), `real-profile-${Date.now()}.json`);
      fs.writeFileSync(realFile, JSON.stringify({ pinned: ['orphan'] }));
      fs.symlinkSync(realFile, path.join(coworkDir, 'skills-profile.json'));

      // loadSkillsWorkspaceProfile rejects symlinks → profile is null → nothing to clean
      const result = await cleanupOrphans(tmpDir, ['orphan'], [], new Set(), new Set());

      expect(result.success).toBe(true);
      expect(result.removed.skills).toBe(0);

      // Original file should be untouched
      const original = JSON.parse(fs.readFileSync(realFile, 'utf-8'));
      expect(original.pinned).toEqual(['orphan']);
      fs.unlinkSync(realFile);
    });
  });
});
