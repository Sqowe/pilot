/**
 * Tests for MCP workspace profile loading and override precedence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadWorkspaceMcpProfile,
  applyWorkspaceOverrides,
  applySessionOverrides,
  invalidateWorkspaceProfileCache,
  saveWorkspaceMcpProfile,
} from '../src/main/mcp/mcp-workspace-profile';
import type { MCPServerConfig } from '../src/main/mcp/mcp-manager';

function makeMockServer(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: 'server-1',
    name: 'TestServer',
    type: 'stdio',
    command: 'echo',
    enabled: true,
    ...overrides,
  };
}

describe('mcp-workspace-profile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-profile-test-'));
    invalidateWorkspaceProfileCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateWorkspaceProfileCache();
  });

  describe('loadWorkspaceMcpProfile', () => {
    it('returns null when cwd is null/undefined', () => {
      expect(loadWorkspaceMcpProfile(null)).toBeNull();
      expect(loadWorkspaceMcpProfile(undefined)).toBeNull();
    });

    it('returns null when .cowork/mcp-servers.json does not exist', () => {
      expect(loadWorkspaceMcpProfile(tmpDir)).toBeNull();
    });

    it('loads a valid profile', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: ['server-a'], enabled: ['server-b'] })
      );

      const profile = loadWorkspaceMcpProfile(tmpDir);
      expect(profile).toEqual({ disabled: ['server-a'], enabled: ['server-b'] });
    });

    it('returns null for invalid JSON', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(path.join(coworkDir, 'mcp-servers.json'), 'not json');

      expect(loadWorkspaceMcpProfile(tmpDir)).toBeNull();
    });

    it('returns null for non-object JSON', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(path.join(coworkDir, 'mcp-servers.json'), '"just a string"');

      expect(loadWorkspaceMcpProfile(tmpDir)).toBeNull();
    });

    it('normalizes invalid disabled/enabled fields to empty arrays', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: 'not-an-array', enabled: 123 })
      );

      const profile = loadWorkspaceMcpProfile(tmpDir);
      expect(profile).toEqual({ disabled: [], enabled: [] });
    });

    it('uses mtime-based cache (does not re-read unchanged file)', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      const filePath = path.join(coworkDir, 'mcp-servers.json');
      fs.writeFileSync(filePath, JSON.stringify({ disabled: ['a'] }));

      const first = loadWorkspaceMcpProfile(tmpDir);
      const second = loadWorkspaceMcpProfile(tmpDir);
      // Same reference means cache hit
      expect(first).toBe(second);
    });

    it('invalidates cache when file changes', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      const filePath = path.join(coworkDir, 'mcp-servers.json');
      fs.writeFileSync(filePath, JSON.stringify({ disabled: ['a'] }));

      const first = loadWorkspaceMcpProfile(tmpDir);
      expect(first?.disabled).toEqual(['a']);

      // Modify file (need to ensure mtime changes)
      const stat = fs.statSync(filePath);
      const newMtime = new Date(stat.mtimeMs + 1000);
      fs.writeFileSync(filePath, JSON.stringify({ disabled: ['b'] }));
      fs.utimesSync(filePath, newMtime, newMtime);

      const second = loadWorkspaceMcpProfile(tmpDir);
      expect(second?.disabled).toEqual(['b']);
    });
  });

  describe('applyWorkspaceOverrides', () => {
    it('returns servers unchanged when no profile exists', () => {
      const servers = [makeMockServer({ id: 's1' }), makeMockServer({ id: 's2' })];
      const result = applyWorkspaceOverrides(servers, tmpDir);
      expect(result).toHaveLength(2);
    });

    it('removes servers listed in disabled', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: ['s1'] })
      );

      const servers = [
        makeMockServer({ id: 's1', name: 'Server1' }),
        makeMockServer({ id: 's2', name: 'Server2' }),
      ];
      const result = applyWorkspaceOverrides(servers, tmpDir);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s2');
    });

    it('enabled overrides disabled for the same server', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: ['s1'], enabled: ['s1'] })
      );

      const servers = [makeMockServer({ id: 's1' })];
      const result = applyWorkspaceOverrides(servers, tmpDir);
      expect(result).toHaveLength(1);
    });

    it('matches by server name as well as id', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: ['MyServer'] })
      );

      const servers = [makeMockServer({ id: 's1', name: 'MyServer' })];
      const result = applyWorkspaceOverrides(servers, tmpDir);
      expect(result).toHaveLength(0);
    });
  });

  describe('applySessionOverrides', () => {
    it('returns servers unchanged when no session overrides', () => {
      const servers = [makeMockServer({ id: 's1' }), makeMockServer({ id: 's2' })];
      expect(applySessionOverrides(servers, null)).toHaveLength(2);
      expect(applySessionOverrides(servers, undefined)).toHaveLength(2);
      expect(applySessionOverrides(servers, [])).toHaveLength(2);
    });

    it('removes servers listed in session disabled IDs', () => {
      const servers = [
        makeMockServer({ id: 's1' }),
        makeMockServer({ id: 's2' }),
        makeMockServer({ id: 's3' }),
      ];
      const result = applySessionOverrides(servers, ['s1', 's3']);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s2');
    });
  });

  describe('override precedence', () => {
    it('session override wins over workspace profile', () => {
      // Workspace says s1 is enabled, but session disables it
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ enabled: ['s1'] })
      );

      const servers = [makeMockServer({ id: 's1' }), makeMockServer({ id: 's2' })];
      let result = applyWorkspaceOverrides(servers, tmpDir);
      expect(result).toHaveLength(2); // workspace keeps both

      result = applySessionOverrides(result, ['s1']);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s2'); // session disabled s1
    });

    it('workspace disabled + session not overriding = server excluded', () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: ['s1'] })
      );

      const servers = [makeMockServer({ id: 's1' }), makeMockServer({ id: 's2' })];
      let result = applyWorkspaceOverrides(servers, tmpDir);
      expect(result).toHaveLength(1);

      // Session doesn't override anything
      result = applySessionOverrides(result, []);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s2');
    });
  });

  describe('saveWorkspaceMcpProfile', () => {
    it('creates .cowork directory and writes profile', async () => {
      const result = await saveWorkspaceMcpProfile(tmpDir, { disabled: ['s1', 's2'] });
      expect(result.success).toBe(true);

      const filePath = path.join(tmpDir, '.cowork', 'mcp-servers.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content).toEqual({ disabled: ['s1', 's2'] });
    });

    it('returns error for empty cwd', async () => {
      const result = await saveWorkspaceMcpProfile('', { disabled: ['s1'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('No working directory');
    });

    it('merges with existing profile — preserves enabled when only disabled is updated', async () => {
      // Pre-create a profile with enabled entries
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: ['old-disabled'], enabled: ['keep-this'] })
      );

      // Save only disabled — enabled should be preserved
      const result = await saveWorkspaceMcpProfile(tmpDir, { disabled: ['new-disabled'] });
      expect(result.success).toBe(true);

      const content = JSON.parse(
        fs.readFileSync(path.join(coworkDir, 'mcp-servers.json'), 'utf-8')
      );
      expect(content.disabled).toEqual(['new-disabled']);
      expect(content.enabled).toEqual(['keep-this']);
    });

    it('removes file when profile becomes empty (clearing overrides)', async () => {
      // Pre-create a profile
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      const filePath = path.join(coworkDir, 'mcp-servers.json');
      fs.writeFileSync(filePath, JSON.stringify({ disabled: ['s1'] }));

      // Save with empty disabled array — should remove the file
      const result = await saveWorkspaceMcpProfile(tmpDir, { disabled: [], enabled: [] });
      expect(result.success).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('invalidates cache after save so next load reads fresh data', async () => {
      // Load once to populate cache (returns null — no file)
      expect(loadWorkspaceMcpProfile(tmpDir)).toBeNull();

      // Save a profile
      await saveWorkspaceMcpProfile(tmpDir, { disabled: ['s1'] });

      // Load should now return the saved profile (cache was invalidated)
      const profile = loadWorkspaceMcpProfile(tmpDir);
      expect(profile).toEqual({ disabled: ['s1'] });
    });

    it('overwrites existing disabled when new disabled is provided', async () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: ['old-a', 'old-b'] })
      );

      await saveWorkspaceMcpProfile(tmpDir, { disabled: ['new-x'] });

      const content = JSON.parse(
        fs.readFileSync(path.join(coworkDir, 'mcp-servers.json'), 'utf-8')
      );
      expect(content.disabled).toEqual(['new-x']);
    });

    it('handles write permission errors gracefully', async () => {
      // chmod-based test only works reliably on POSIX systems (not Windows/CI)
      if (process.platform === 'win32') {
        return; // Skip on Windows — chmod semantics differ
      }

      // Create a read-only directory to trigger a write error
      const readOnlyDir = path.join(tmpDir, 'readonly');
      fs.mkdirSync(readOnlyDir);
      fs.mkdirSync(path.join(readOnlyDir, '.cowork'));
      fs.chmodSync(path.join(readOnlyDir, '.cowork'), 0o444);

      const result = await saveWorkspaceMcpProfile(readOnlyDir, { disabled: ['s1'] });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Restore permissions for cleanup
      fs.chmodSync(path.join(readOnlyDir, '.cowork'), 0o755);
    });

    it('does not leave temp files on successful save', async () => {
      await saveWorkspaceMcpProfile(tmpDir, { disabled: ['s1'] });

      const coworkDir = path.join(tmpDir, '.cowork');
      const files = fs.readdirSync(coworkDir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('handles concurrent saves without corruption', async () => {
      // Fire multiple saves concurrently
      const results = await Promise.all([
        saveWorkspaceMcpProfile(tmpDir, { disabled: ['a'] }),
        saveWorkspaceMcpProfile(tmpDir, { disabled: ['b'] }),
        saveWorkspaceMcpProfile(tmpDir, { disabled: ['c'] }),
      ]);

      // All should succeed
      for (const r of results) {
        expect(r.success).toBe(true);
      }

      // File should be valid JSON with one of the values (last writer wins)
      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.cowork', 'mcp-servers.json'), 'utf-8')
      );
      expect(content.disabled).toBeDefined();
      expect(content.disabled.length).toBe(1);
      expect(['a', 'b', 'c']).toContain(content.disabled[0]);

      // No leftover temp files
      const files = fs.readdirSync(path.join(tmpDir, '.cowork'));
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('concurrent mixed-field saves preserve both disabled and enabled', async () => {
      // With write serialization, sequential execution means both fields survive.
      const results = await Promise.all([
        saveWorkspaceMcpProfile(tmpDir, { disabled: ['d1', 'd2'] }),
        saveWorkspaceMcpProfile(tmpDir, { enabled: ['e1'] }),
      ]);

      for (const r of results) {
        expect(r.success).toBe(true);
      }

      // Both fields should be present — serialization ensures the second save
      // reads the result of the first before merging.
      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.cowork', 'mcp-servers.json'), 'utf-8')
      );
      expect(content.disabled).toEqual(['d1', 'd2']);
      expect(content.enabled).toEqual(['e1']);
    });

    it('validates and sanitizes malformed existing profile on disk', async () => {
      // Write a malformed profile with non-string-array fields
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(
        path.join(coworkDir, 'mcp-servers.json'),
        JSON.stringify({ disabled: 'not-an-array', enabled: [123, '', 'valid-id'] })
      );

      // Save new disabled — should sanitize existing enabled (drop invalid entries)
      const result = await saveWorkspaceMcpProfile(tmpDir, { disabled: ['new-d'] });
      expect(result.success).toBe(true);

      const content = JSON.parse(
        fs.readFileSync(path.join(coworkDir, 'mcp-servers.json'), 'utf-8')
      );
      expect(content.disabled).toEqual(['new-d']);
      // Only 'valid-id' survives validation from existing enabled
      expect(content.enabled).toEqual(['valid-id']);
    });

    it('fails save when existing file has non-ENOENT read error', async () => {
      // chmod-based test only works reliably on POSIX systems
      if (process.platform === 'win32') {
        return;
      }

      // Create a profile file that cannot be read (no read permission)
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      const filePath = path.join(coworkDir, 'mcp-servers.json');
      fs.writeFileSync(filePath, JSON.stringify({ enabled: ['important'] }));
      fs.chmodSync(filePath, 0o000); // No read permission

      // Save should fail — not silently overwrite
      const result = await saveWorkspaceMcpProfile(tmpDir, { disabled: ['new-d'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to read existing profile');

      // Restore permissions for cleanup
      fs.chmodSync(filePath, 0o644);

      // Verify original file is untouched
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.enabled).toEqual(['important']);
    });

    it('handles invalid JSON in existing file gracefully (starts fresh)', async () => {
      const coworkDir = path.join(tmpDir, '.cowork');
      fs.mkdirSync(coworkDir, { recursive: true });
      fs.writeFileSync(path.join(coworkDir, 'mcp-servers.json'), '{broken json!!!');

      // Should succeed — treats invalid JSON as empty and writes new profile
      const result = await saveWorkspaceMcpProfile(tmpDir, { disabled: ['d1'] });
      expect(result.success).toBe(true);

      const content = JSON.parse(
        fs.readFileSync(path.join(coworkDir, 'mcp-servers.json'), 'utf-8')
      );
      expect(content.disabled).toEqual(['d1']);
      expect(content.enabled).toBeUndefined();
    });

    it('normalizes incoming profile fields (trims, dedupes, drops invalid)', async () => {
      // Call saveWorkspaceMcpProfile directly with messy input
      const result = await saveWorkspaceMcpProfile(tmpDir, {
        disabled: ['  s1  ', 's2', 's1', '   ', 's3'],
        enabled: ['e1', 'e1', '  e2  '],
      });
      expect(result.success).toBe(true);

      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.cowork', 'mcp-servers.json'), 'utf-8')
      );
      // Trimmed, deduped, empty strings removed
      expect(content.disabled).toEqual(['s1', 's2', 's3']);
      expect(content.enabled).toEqual(['e1', 'e2']);
    });
  });
});
