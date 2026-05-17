/**
 * Tests for initial MCP disabled servers flow:
 * WelcomeView → startSession IPC → main process → SessionManager state.
 *
 * Validates payload correctness and structural contracts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const mainIndexPath = path.resolve('src/main/index.ts');
const mainSource = fs.readFileSync(mainIndexPath, 'utf8');

const useIPCPath = path.resolve('src/renderer/hooks/useIPC.ts');
const useIPCSource = fs.readFileSync(useIPCPath, 'utf8');

const typesPath = path.resolve('src/renderer/types/index.ts');
const typesSource = fs.readFileSync(typesPath, 'utf8');

const welcomeViewPath = path.resolve('src/renderer/components/WelcomeView.tsx');
const welcomeViewSource = fs.readFileSync(welcomeViewPath, 'utf8');

describe('Initial MCP disabled servers flow', () => {
  describe('ClientEvent type', () => {
    it('includes initialDisabledMcpServers as optional field on session.start payload', () => {
      expect(typesSource).toContain('initialDisabledMcpServers?: string[]');
    });
  });

  describe('useIPC.startSession', () => {
    it('accepts initialDisabledMcpServers parameter', () => {
      expect(useIPCSource).toContain('initialDisabledMcpServers?: string[]');
    });

    it('passes initialDisabledMcpServers in the IPC payload', () => {
      expect(useIPCSource).toContain('initialDisabledMcpServers');
      // Verify it's in the invoke payload object
      const invokeSection = useIPCSource.slice(
        useIPCSource.indexOf("type: 'session.start'"),
        useIPCSource.indexOf("type: 'session.start'") + 300
      );
      expect(invokeSection).toContain('initialDisabledMcpServers');
    });
  });

  describe('main process session.start handler', () => {
    it('passes initialDisabledMcpServers directly to sm.startSession', () => {
      // The handler now passes it as a parameter, not post-creation mutation
      const caseBlock = mainSource.slice(
        mainSource.indexOf("case 'session.start':"),
        mainSource.indexOf("case 'session.continue':")
      );
      expect(caseBlock).toContain('event.payload.initialDisabledMcpServers');
      // Should be passed as argument to startSession, not via toggleSessionMcpServer
      expect(caseBlock).not.toContain('toggleSessionMcpServer');
    });
  });

  describe('SessionManager.startSession', () => {
    const smSource = fs.readFileSync(path.resolve('src/main/session/session-manager.ts'), 'utf8');

    it('accepts initialDisabledMcpServers parameter', () => {
      expect(smSource).toContain('initialDisabledMcpServers?: string[]');
    });

    it('applies disabled state BEFORE enqueueing the prompt', () => {
      // Find the startSession method body
      const startIdx = smSource.indexOf('async startSession(');
      const endIdx = smSource.indexOf('// Create a new session object', startIdx);
      const methodBody = smSource.slice(startIdx, endIdx);

      const disabledSetPos = methodBody.indexOf('sessionDisabledMcpServers.set(');
      const enqueuePos = methodBody.indexOf('enqueuePrompt(');
      expect(disabledSetPos).toBeGreaterThan(0);
      expect(enqueuePos).toBeGreaterThan(disabledSetPos);
    });

    it('validates serverId length and type before adding to set', () => {
      const startIdx = smSource.indexOf('async startSession(');
      const endIdx = smSource.indexOf('// Create a new session object', startIdx);
      const methodBody = smSource.slice(startIdx, endIdx);

      expect(methodBody).toContain("typeof serverId === 'string'");
      expect(methodBody).toContain('serverId.length <= 256');
    });

    it('invalidates MCP cache after applying initial disabled state', () => {
      const startIdx = smSource.indexOf('async startSession(');
      const endIdx = smSource.indexOf('// Create a new session object', startIdx);
      const methodBody = smSource.slice(startIdx, endIdx);

      expect(methodBody).toContain('invalidateMcpServersCache()');
    });
  });

  describe('WelcomeView', () => {
    it('passes mcpDisabledIds to startSession when non-empty', () => {
      expect(welcomeViewSource).toContain('mcpDisabledIds.size > 0');
      expect(welcomeViewSource).toContain('Array.from(mcpDisabledIds)');
    });

    it('passes undefined when no servers are disabled', () => {
      // When mcpDisabledIds.size === 0, should pass undefined (not empty array)
      expect(welcomeViewSource).toContain(
        'mcpDisabledIds.size > 0 ? Array.from(mcpDisabledIds) : undefined'
      );
    });

    it('does not include quick action tags anymore', () => {
      expect(welcomeViewSource).not.toContain('quickTags');
      expect(welcomeViewSource).not.toContain('handleTagClick');
      expect(welcomeViewSource).not.toContain('selectedTag');
    });

    it('includes MCP server picker UI', () => {
      expect(welcomeViewSource).toContain('mcpServers');
      expect(welcomeViewSource).toContain('mcpDisabledIds');
      expect(welcomeViewSource).toContain('mcpExpanded');
      expect(welcomeViewSource).toContain('mcpAllOn');
      expect(welcomeViewSource).toContain('mcpAllOff');
    });
  });
});
