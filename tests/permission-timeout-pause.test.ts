/**
 * Tests for the permission-dialog / activity-timeout interaction.
 *
 * The P0 fix ensures that the 5-minute activity timeout does NOT fire while
 * the agent is waiting for the user to respond to a permission dialog.
 * Without this fix, the "No timeout (wait forever)" permission setting is
 * contradicted by the activity timeout aborting the agent.
 *
 * These tests validate:
 * 1. The existing activity timer is cancelled when permission wait starts
 * 2. The timeout does not fire while waiting for permission beyond 5 minutes
 * 3. The timeout resumes after permission resolution
 * 4. Overlapping permission requests in one session are handled correctly
 * 5. Lifecycle cleanup is unconditional (clearSdkSession, cancel)
 * 6. Stale completions from cancelled runs do not corrupt new run state
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const agentRunnerPath = path.resolve(process.cwd(), 'src/main/claude/agent-runner.ts');
const agentRunnerContent = readFileSync(agentRunnerPath, 'utf8');

describe('Permission dialog pauses activity timeout', () => {
  describe('source-level invariants', () => {
    it('uses a structured state with runId and count for permission wait tracking', () => {
      expect(agentRunnerContent).toContain(
        'private permissionWaitState: Map<string, { runId: string; count: number }> = new Map()'
      );
      expect(agentRunnerContent).not.toContain('private permissionWaitingSessions: Set<string>');
      expect(agentRunnerContent).not.toContain(
        'private permissionWaitingCount: Map<string, number>'
      );
    });

    it('tracks current runId per session for stale completion detection', () => {
      expect(agentRunnerContent).toContain('private currentRunId: Map<string, string> = new Map()');
    });

    it('stores activity timeout handles on the class for direct cancellation', () => {
      expect(agentRunnerContent).toContain(
        'private activityTimeoutHandles: Map<string, ReturnType<typeof setTimeout>> = new Map()'
      );
    });

    it('cancels the existing timer immediately when entering permission wait', () => {
      expect(agentRunnerContent).toContain(
        'const existingHandle = this.activityTimeoutHandles.get(sessionId)'
      );
      expect(agentRunnerContent).toContain('clearTimeout(existingHandle)');
    });

    it('captures runId before try block for use in finally', () => {
      const captureIdx = agentRunnerContent.indexOf(
        "const capturedRunId = this.currentRunId.get(sessionId) ?? ''"
      );
      const tryIdx = agentRunnerContent.indexOf('// Pause the activity timeout while waiting');
      expect(captureIdx).toBeGreaterThan(-1);
      expect(tryIdx).toBeGreaterThan(-1);
      expect(captureIdx).toBeLessThan(tryIdx);
    });

    it('compares runId in finally to detect stale completions', () => {
      expect(agentRunnerContent).toContain('if (state && state.runId === capturedRunId)');
    });

    it('sets currentRunId at the start of each run', () => {
      expect(agentRunnerContent).toContain('this.currentRunId.set(session.id, thinkingStepId)');
    });

    it('cleans up all state on cancel including currentRunId', () => {
      const cancelIdx = agentRunnerContent.indexOf('cancel(sessionId: string): void {');
      // Bound by the next method rather than a fixed length, so growing cancel()
      // does not push the assertions below out of the window.
      const cancelEndIdx = agentRunnerContent.indexOf('private sendTraceStep(', cancelIdx);
      expect(cancelIdx).toBeGreaterThan(-1);
      expect(cancelEndIdx).toBeGreaterThan(cancelIdx);
      const cancelMethod = agentRunnerContent.slice(cancelIdx, cancelEndIdx);
      expect(cancelMethod).toContain('this.permissionWaitState.delete(sessionId)');
      expect(cancelMethod).toContain('this.currentRunId.delete(sessionId)');
      expect(cancelMethod).toContain('this.restartActivityTimeout.delete(sessionId)');
    });

    it('cleans up permission/timeout state unconditionally in clearSdkSession', () => {
      const clearIdx = agentRunnerContent.indexOf('clearSdkSession(sessionId: string): void {');
      const clearMethod = agentRunnerContent.slice(clearIdx, clearIdx + 900);
      const logIdx = clearMethod.indexOf("log('[ClaudeAgentRunner] Disposed pi session for:'");
      const permIdx = clearMethod.indexOf('this.permissionWaitState.delete(sessionId)', logIdx);
      expect(permIdx).toBeGreaterThan(logIdx);
    });
  });

  describe('behavioral logic with fake timers and run-token scoping', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Harness that mirrors the exact logic from ClaudeAgentRunner:
     * - resetActivityTimeout (with permissionWaitState check)
     * - permission enter/exit with runId scoping
     * - cancel/clearSession lifecycle
     */
    function createTimeoutHarness() {
      const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
      const permissionWaitState = new Map<string, { runId: string; count: number }>();
      const activityTimeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
      const currentRunId = new Map<string, string>();
      const restartCb = new Map<string, () => void>();
      let activityTimeoutId: ReturnType<typeof setTimeout> | undefined;
      let aborted = false;
      const sessionId = 'test-session';

      const resetActivityTimeout = () => {
        if (activityTimeoutId) clearTimeout(activityTimeoutId);
        activityTimeoutHandles.delete(sessionId);
        const waitState = permissionWaitState.get(sessionId);
        if (waitState && waitState.count > 0) return;
        activityTimeoutId = setTimeout(() => {
          aborted = true;
        }, PROMPT_TIMEOUT_MS);
        activityTimeoutHandles.set(sessionId, activityTimeoutId);
      };

      const startRun = (runId: string) => {
        currentRunId.set(sessionId, runId);
        restartCb.set(sessionId, resetActivityTimeout);
        aborted = false;
      };

      const enterPermissionWait = (): string => {
        const capturedRunId = currentRunId.get(sessionId) || '';
        const existing = permissionWaitState.get(sessionId);
        if (existing && existing.runId === capturedRunId) {
          existing.count += 1;
        } else {
          permissionWaitState.set(sessionId, { runId: capturedRunId, count: 1 });
        }
        const existingHandle = activityTimeoutHandles.get(sessionId);
        if (existingHandle) {
          clearTimeout(existingHandle);
          activityTimeoutHandles.delete(sessionId);
        }
        return capturedRunId;
      };

      const exitPermissionWait = (capturedRunId: string) => {
        const state = permissionWaitState.get(sessionId);
        if (state && state.runId === capturedRunId) {
          if (state.count <= 1) {
            permissionWaitState.delete(sessionId);
            // Immediately restart the activity timeout
            const restart = restartCb.get(sessionId);
            if (restart) restart();
          } else {
            state.count -= 1;
          }
        }
      };

      const cancel = () => {
        aborted = true;
        permissionWaitState.delete(sessionId);
        currentRunId.delete(sessionId);
        restartCb.delete(sessionId);
        const handle = activityTimeoutHandles.get(sessionId);
        if (handle) {
          clearTimeout(handle);
          activityTimeoutHandles.delete(sessionId);
        }
      };

      const clearSession = () => {
        permissionWaitState.delete(sessionId);
        currentRunId.delete(sessionId);
        restartCb.delete(sessionId);
        const handle = activityTimeoutHandles.get(sessionId);
        if (handle) {
          clearTimeout(handle);
          activityTimeoutHandles.delete(sessionId);
        }
      };

      return {
        sessionId,
        get aborted() {
          return aborted;
        },
        get hasActiveTimer() {
          return activityTimeoutHandles.has(sessionId);
        },
        get permissionCount() {
          return permissionWaitState.get(sessionId)?.count ?? 0;
        },
        startRun,
        resetActivityTimeout,
        enterPermissionWait,
        exitPermissionWait,
        cancel,
        clearSession,
      };
    }

    it('existing timer is cancelled when permission wait starts', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      h.resetActivityTimeout();
      expect(h.hasActiveTimer).toBe(true);
      h.enterPermissionWait();
      expect(h.hasActiveTimer).toBe(false);
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(h.aborted).toBe(false);
    });

    it('timeout does not fire while waiting for permission beyond 5 minutes', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      h.resetActivityTimeout();
      const token = h.enterPermissionWait();
      vi.advanceTimersByTime(20 * 60 * 1000);
      expect(h.aborted).toBe(false);
      h.exitPermissionWait(token);
      h.resetActivityTimeout();
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(h.aborted).toBe(true);
    });

    it('timeout resumes correctly after permission resolution', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      const token = h.enterPermissionWait();
      h.resetActivityTimeout();
      expect(h.hasActiveTimer).toBe(false);
      h.exitPermissionWait(token);
      h.resetActivityTimeout();
      expect(h.hasActiveTimer).toBe(true);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(h.aborted).toBe(true);
    });

    it('handles overlapping permission requests correctly', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      h.resetActivityTimeout();
      const t1 = h.enterPermissionWait();
      const t2 = h.enterPermissionWait();
      expect(h.permissionCount).toBe(2);
      h.exitPermissionWait(t1);
      expect(h.permissionCount).toBe(1);
      h.resetActivityTimeout();
      expect(h.hasActiveTimer).toBe(false);
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(h.aborted).toBe(false);
      h.exitPermissionWait(t2);
      expect(h.permissionCount).toBe(0);
      h.resetActivityTimeout();
      expect(h.hasActiveTimer).toBe(true);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(h.aborted).toBe(true);
    });

    it('cancel() cleans up all state', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      h.resetActivityTimeout();
      h.enterPermissionWait();
      h.enterPermissionWait();
      h.cancel();
      expect(h.aborted).toBe(true);
      expect(h.permissionCount).toBe(0);
      expect(h.hasActiveTimer).toBe(false);
    });

    it('clearSession() cleans up state unconditionally', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      h.resetActivityTimeout();
      h.enterPermissionWait();
      h.clearSession();
      expect(h.permissionCount).toBe(0);
      expect(h.hasActiveTimer).toBe(false);
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(h.aborted).toBe(false);
    });

    it('resetActivityTimeout during permission wait does not schedule timer', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      h.enterPermissionWait();
      h.resetActivityTimeout();
      h.resetActivityTimeout();
      h.resetActivityTimeout();
      expect(h.hasActiveTimer).toBe(false);
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(h.aborted).toBe(false);
    });

    it('REGRESSION: stale permission completion from cancelled run does not corrupt new run', () => {
      const h = createTimeoutHarness();

      // Run 1 starts, permission dialog opens
      h.startRun('run-1');
      h.resetActivityTimeout();
      const staleToken = h.enterPermissionWait();
      expect(h.permissionCount).toBe(1);

      // User cancels run 1
      h.cancel();
      expect(h.permissionCount).toBe(0);

      // Run 2 starts on the same session
      h.startRun('run-2');
      h.resetActivityTimeout();
      const run2Token = h.enterPermissionWait();
      expect(h.permissionCount).toBe(1);

      // Stale finally from run 1 fires (old permission promise resolved late)
      h.exitPermissionWait(staleToken);

      // CRITICAL: Run 2's permission state must NOT be corrupted
      expect(h.permissionCount).toBe(1);

      // Timer should still be paused
      h.resetActivityTimeout();
      expect(h.hasActiveTimer).toBe(false);

      // Advance 10 minutes - should NOT abort
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(h.aborted).toBe(false);

      // Run 2's permission resolves normally
      h.exitPermissionWait(run2Token);
      expect(h.permissionCount).toBe(0);

      // Timer can now schedule and fires after 5 min
      h.resetActivityTimeout();
      expect(h.hasActiveTimer).toBe(true);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(h.aborted).toBe(true);
    });

    it('REGRESSION: stale completion with no active run is a no-op', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      const token = h.enterPermissionWait();
      h.cancel();
      // Stale finally fires after cancel, no new run
      h.exitPermissionWait(token);
      expect(h.permissionCount).toBe(0);
      expect(h.hasActiveTimer).toBe(false);
    });

    it('activity timeout restarts immediately when permission wait exits (no SDK event needed)', () => {
      const h = createTimeoutHarness();
      h.startRun('run-1');
      h.resetActivityTimeout();
      const token = h.enterPermissionWait();

      // Timer is paused
      expect(h.hasActiveTimer).toBe(false);

      // Permission resolves — timer should restart IMMEDIATELY
      h.exitPermissionWait(token);
      expect(h.hasActiveTimer).toBe(true);

      // And fires after 5 minutes without needing any SDK event
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(h.aborted).toBe(true);
    });
  });
});
