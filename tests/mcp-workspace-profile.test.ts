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
});
