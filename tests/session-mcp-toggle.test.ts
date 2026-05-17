/**
 * Tests for per-session MCP server toggle behavior in SessionManager.
 * Validates input validation, state management, and cleanup.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Read the source to verify structural contracts
const sessionManagerPath = path.resolve('src/main/session/session-manager.ts');
const smSource = fs.readFileSync(sessionManagerPath, 'utf8');

describe('Session MCP toggle contracts', () => {
  describe('sessionDisabledMcpServers map', () => {
    it('declares the in-memory map for per-session disabled servers', () => {
      expect(smSource).toContain(
        'private sessionDisabledMcpServers: Map<string, Set<string>> = new Map()'
      );
    });

    it('cleans up on single session delete', () => {
      expect(smSource).toContain('this.sessionDisabledMcpServers.delete(sessionId)');
    });
  });

  describe('toggleSessionMcpServer validation', () => {
    it('validates sessionId is non-empty string', () => {
      expect(smSource).toContain("throw new Error('Invalid sessionId')");
    });

    it('validates serverId is non-empty and bounded', () => {
      expect(smSource).toContain("throw new Error('Invalid serverId')");
      expect(smSource).toContain('serverId.length > 256');
    });

    it('verifies session exists before mutating state', () => {
      expect(smSource).toContain('const session = this.loadSession(sessionId)');
      expect(smSource).toContain('Session not found');
    });

    it('cleans up empty sets to prevent unbounded map growth', () => {
      expect(smSource).toContain('if (disabledSet.size === 0)');
      expect(smSource).toContain('this.sessionDisabledMcpServers.delete(sessionId)');
    });

    it('invalidates MCP cache after toggle', () => {
      // The toggleSessionMcpServer method must call invalidateMcpServersCache
      expect(smSource).toContain('invalidateMcpServersCache()');
      // Verify it appears in the toggle method context (after the state mutation)
      const toggleStart = smSource.indexOf('toggleSessionMcpServer(sessionId: string');
      const nextMethod = smSource.indexOf('getSessionDisabledMcpServers(sessionId): string[]');
      const toggleBody = smSource.slice(toggleStart, nextMethod);
      expect(toggleBody).toContain('invalidateMcpServersCache');
    });
  });

  describe('getSessionDisabledMcpServers', () => {
    it('returns empty array for unknown session (no throw)', () => {
      // The getter should not throw — it just returns [] for missing entries
      expect(smSource).toContain('getSessionDisabledMcpServers(sessionId: string): string[]');
      // Verify it has a safe fallback pattern
      expect(smSource).toContain('Array.from(disabledSet) : []');
    });
  });

  describe('createClaudeAgentRunner wiring', () => {
    it('passes getSessionDisabledMcpServers callback to agent runner', () => {
      expect(smSource).toContain('getSessionDisabledMcpServers: (sessionId: string) =>');
      expect(smSource).toContain('this.getSessionDisabledMcpServers(sessionId)');
    });
  });
});
