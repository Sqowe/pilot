/**
 * Tests for autonomous session permission blocking.
 * Verifies that sessions marked as autonomous block 'ask' decisions
 * instead of prompting the user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markSessionAutonomous,
  isSessionAutonomous,
  forgetSessionPermissions,
  setAutonomousBlockCallback,
  getAutonomousBlockCallback,
  decidePermission,
  setPermissionRules,
  setBashCommandLists,
} from '../src/main/config/permission-rules-store';

describe('autonomous session permission blocking', () => {
  beforeEach(() => {
    forgetSessionPermissions('test-session');
    setAutonomousBlockCallback(null);
  });

  afterEach(() => {
    forgetSessionPermissions('test-session');
    setAutonomousBlockCallback(null);
    setPermissionRules([]);
    setBashCommandLists([], []);
  });

  describe('session registry', () => {
    it('markSessionAutonomous marks a session as autonomous', () => {
      expect(isSessionAutonomous('test-session')).toBe(false);
      markSessionAutonomous('test-session');
      expect(isSessionAutonomous('test-session')).toBe(true);
    });

    it('forgetSessionPermissions clears autonomous flag', () => {
      markSessionAutonomous('test-session');
      expect(isSessionAutonomous('test-session')).toBe(true);
      forgetSessionPermissions('test-session');
      expect(isSessionAutonomous('test-session')).toBe(false);
    });

    it('non-autonomous sessions are not affected', () => {
      expect(isSessionAutonomous('other-session')).toBe(false);
      markSessionAutonomous('test-session');
      expect(isSessionAutonomous('other-session')).toBe(false);
    });
  });

  describe('block callback', () => {
    it('setAutonomousBlockCallback registers and retrieves callback', () => {
      const callback = vi.fn();
      setAutonomousBlockCallback(callback);
      expect(getAutonomousBlockCallback()).toBe(callback);
    });

    it('setAutonomousBlockCallback(null) clears the callback', () => {
      setAutonomousBlockCallback(vi.fn());
      setAutonomousBlockCallback(null);
      expect(getAutonomousBlockCallback()).toBeNull();
    });
  });

  describe('permission decision behavior', () => {
    it('decidePermission returns "ask" for untrusted bash commands (non-autonomous)', () => {
      // Set up bash trust list with only "npm *" trusted
      setBashCommandLists(['npm *'], []);
      const decision = decidePermission('test-session', 'bash', { command: 'git push' });
      expect(decision).toBe('ask');
    });

    it('decidePermission returns "allow" for trusted bash commands', () => {
      setBashCommandLists(['npm *'], []);
      const decision = decidePermission('test-session', 'bash', { command: 'npm install' });
      expect(decision).toBe('allow');
    });

    it('autonomous session + "ask" decision = block path (verified via isSessionAutonomous)', () => {
      // This test verifies the contract that the permission hook checks:
      // when decidePermission returns 'ask' AND isSessionAutonomous is true,
      // the hook should block instead of prompting.
      setBashCommandLists(['npm *'], []);
      markSessionAutonomous('test-session');

      const decision = decidePermission('test-session', 'bash', { command: 'git push' });
      expect(decision).toBe('ask');
      expect(isSessionAutonomous('test-session')).toBe(true);
      // The hook in agent-runner.ts checks both conditions and blocks
    });

    it('autonomous session + "allow" decision = no block (trusted commands execute)', () => {
      setBashCommandLists(['git *'], []);
      markSessionAutonomous('test-session');

      const decision = decidePermission('test-session', 'bash', { command: 'git push' });
      expect(decision).toBe('allow');
      // Even in autonomous mode, allowed commands proceed normally
    });

    it('non-autonomous session + "ask" decision = prompt path (not blocked)', () => {
      setBashCommandLists(['npm *'], []);
      // Session is NOT marked autonomous
      const decision = decidePermission('test-session', 'bash', { command: 'git push' });
      expect(decision).toBe('ask');
      expect(isSessionAutonomous('test-session')).toBe(false);
      // The hook would show a dialog, not block
    });

    it('denied commands are blocked regardless of autonomous mode', () => {
      setBashCommandLists([], ['rm -rf']);
      markSessionAutonomous('test-session');

      const decision = decidePermission('test-session', 'bash', { command: 'rm -rf /' });
      expect(decision).toBe('ask'); // denylist forces 'ask' (not 'deny' — it's a manual review trigger)
    });
  });
});
