/**
 * Tests for the pure MCP profile derivation utility.
 */
import { describe, it, expect } from 'vitest';
import { deriveDisabledServerIds } from '../src/renderer/utils/mcp-profile-derive';
import type { McpServerEntry, McpProfileInput } from '../src/renderer/utils/mcp-profile-derive';

const servers: McpServerEntry[] = [
  { id: 'id-1', name: 'Firecrawl' },
  { id: 'id-2', name: 'Context7' },
  { id: 'id-3', name: 'Russian Law' },
  { id: 'id-4', name: 'EU Law' },
];

describe('deriveDisabledServerIds', () => {
  describe('null/empty profile', () => {
    it('returns empty set for null profile', () => {
      const result = deriveDisabledServerIds(null, servers);
      expect(result.size).toBe(0);
    });

    it('returns empty set for empty profile', () => {
      const result = deriveDisabledServerIds({}, servers);
      expect(result.size).toBe(0);
    });

    it('returns empty set for profile with empty arrays', () => {
      const result = deriveDisabledServerIds({ disabled: [], enabled: [] }, servers);
      expect(result.size).toBe(0);
    });
  });

  describe('blocklist mode (disabled)', () => {
    it('maps disabled IDs directly', () => {
      const profile: McpProfileInput = { disabled: ['id-1', 'id-3'] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result).toEqual(new Set(['id-1', 'id-3']));
    });

    it('resolves server names to IDs', () => {
      const profile: McpProfileInput = { disabled: ['Firecrawl', 'EU Law'] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result).toEqual(new Set(['id-1', 'id-4']));
    });

    it('keeps raw entries for unknown servers', () => {
      const profile: McpProfileInput = { disabled: ['id-1', 'unknown-server'] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result).toEqual(new Set(['id-1', 'unknown-server']));
    });

    it('handles mixed id and name entries', () => {
      const profile: McpProfileInput = { disabled: ['id-2', 'Russian Law'] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result).toEqual(new Set(['id-2', 'id-3']));
    });

    it('disabled takes precedence over enabled when both exist', () => {
      const profile: McpProfileInput = { disabled: ['id-1'], enabled: ['id-2'] };
      const result = deriveDisabledServerIds(profile, servers);
      // Should use disabled mode, not enabled
      expect(result).toEqual(new Set(['id-1']));
    });

    it('explicit empty disabled array takes precedence over enabled (nothing disabled)', () => {
      const profile: McpProfileInput = { disabled: [], enabled: ['id-1', 'id-2'] };
      const result = deriveDisabledServerIds(profile, servers);
      // disabled key is present (even empty) — blocklist mode wins, nothing disabled
      expect(result).toEqual(new Set());
    });
  });

  describe('allowlist mode (enabled only)', () => {
    it('derives disabled from servers not in enabled list', () => {
      const profile: McpProfileInput = { enabled: ['id-1', 'id-2'] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result).toEqual(new Set(['id-3', 'id-4']));
    });

    it('resolves enabled names to exclude from disabled', () => {
      const profile: McpProfileInput = { enabled: ['Firecrawl', 'Context7'] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result).toEqual(new Set(['id-3', 'id-4']));
    });

    it('returns empty set when all servers are enabled', () => {
      const profile: McpProfileInput = { enabled: ['id-1', 'id-2', 'id-3', 'id-4'] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result.size).toBe(0);
    });

    it('disables all when enabled list has no matches', () => {
      const profile: McpProfileInput = { enabled: ['nonexistent'] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result).toEqual(new Set(['id-1', 'id-2', 'id-3', 'id-4']));
    });

    it('returns null when server list is empty (pending signal)', () => {
      const profile: McpProfileInput = { enabled: ['id-1'] };
      const result = deriveDisabledServerIds(profile, []);
      expect(result).toBeNull();
    });

    it('empty enabled array disables all known servers', () => {
      const profile: McpProfileInput = { enabled: [] };
      const result = deriveDisabledServerIds(profile, servers);
      expect(result).toEqual(new Set(['id-1', 'id-2', 'id-3', 'id-4']));
    });

    it('empty enabled array with no servers returns empty set (nothing to disable)', () => {
      const profile: McpProfileInput = { enabled: [] };
      const result = deriveDisabledServerIds(profile, []);
      expect(result).toEqual(new Set());
    });
  });

  describe('workspace switching (state reset)', () => {
    it('null profile after workspace change returns empty set', () => {
      // Simulates: user switches workspace, profile cleared to null
      const result = deriveDisabledServerIds(null, servers);
      expect(result.size).toBe(0);
    });

    it('new profile after workspace change applies correctly', () => {
      // Simulates: new workspace loaded with different profile
      const oldProfile: McpProfileInput = { disabled: ['id-1'] };
      const newProfile: McpProfileInput = { disabled: ['id-3', 'id-4'] };

      const oldResult = deriveDisabledServerIds(oldProfile, servers);
      expect(oldResult).toEqual(new Set(['id-1']));

      const newResult = deriveDisabledServerIds(newProfile, servers);
      expect(newResult).toEqual(new Set(['id-3', 'id-4']));
    });
  });
});
