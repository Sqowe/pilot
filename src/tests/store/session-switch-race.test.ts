/**
 * Tests for session switching race condition protection.
 *
 * Verifies that rapid session switching (A → B) with delayed async loads
 * correctly resolves to the latest user intent (B), not the first-to-resolve (A).
 *
 * This mirrors the full logic in Sidebar.tsx handleSessionClick which uses a
 * switchRequestRef counter to guard against stale async results, including:
 * - Two-stage async loading (messages + trace steps)
 * - Staleness checks after each await
 * - Cancellation by re-clicking the currently active session
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../renderer/store';
import type { Message, TraceStep, MountedPath } from '../../renderer/types';

// Reset store before each test
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

const makeSession = (id: string) => ({
  id,
  title: `Session ${id}`,
  status: 'idle' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  cwd: '/tmp',
  mountedPaths: [] as MountedPath[],
  allowedTools: [] as string[],
  memoryEnabled: false,
});

const makeMessages = (sessionId: string, count: number): Message[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `msg-${sessionId}-${i}`,
    sessionId,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `Message ${i} in ${sessionId}` }],
    timestamp: Date.now() + i,
  }));

const makeTraceSteps = (sessionId: string, count: number): TraceStep[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `step-${sessionId}-${i}`,
    sessionId,
    type: 'tool_use' as const,
    toolName: `tool-${i}`,
    status: 'completed' as const,
    timestamp: Date.now() + i,
  }));

/**
 * Simulates the full handleSessionClick logic from Sidebar.tsx.
 * Mirrors the two-stage async flow (messages + trace steps) with
 * staleness guards after each await, plus cancellation on re-click.
 */
function createSessionSwitcher() {
  let switchRequestCounter = 0;
  let currentActiveSessionId: string | null = null;

  return {
    getRequestCounter: () => switchRequestCounter,
    getActiveSessionId: () => currentActiveSessionId,

    /**
     * Simulates re-clicking the currently active session to cancel a pending switch.
     */
    cancelPendingSwitch() {
      switchRequestCounter++;
    },

    /**
     * Simulates clicking a session in the sidebar.
     * Mirrors the full Sidebar.tsx handleSessionClick with two-stage loading.
     */
    async switchTo(
      sessionId: string,
      opts: {
        messageLoadDelay: number;
        traceLoadDelay: number;
        messages: Message[];
        traceSteps: TraceStep[];
      }
    ) {
      // Early return if clicking the already-active session (cancels pending)
      if (currentActiveSessionId === sessionId) {
        switchRequestCounter++;
        return;
      }

      // Guard against rapid clicks: only the latest selection wins
      const requestId = ++switchRequestCounter;

      // Stage 1: Load messages
      const existingMessages = useAppStore.getState().sessionStates[sessionId]?.messages;
      if (!existingMessages || existingMessages.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.messageLoadDelay));

        if (switchRequestCounter !== requestId) return; // Stale after message load

        if (opts.messages.length > 0) {
          useAppStore.getState().setMessages(sessionId, opts.messages);
        }
      }

      if (switchRequestCounter !== requestId) return; // Stale between stages

      // Stage 2: Load trace steps
      const existingSteps = useAppStore.getState().sessionStates[sessionId]?.traceSteps;
      if (!existingSteps || existingSteps.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.traceLoadDelay));

        if (switchRequestCounter !== requestId) return; // Stale after trace load

        if (opts.traceSteps.length > 0) {
          useAppStore.getState().setTraceSteps(sessionId, opts.traceSteps);
        }
      }

      if (switchRequestCounter !== requestId) return; // Final staleness check

      // Activate session AFTER both stages complete
      useAppStore.getState().setActiveSession(sessionId);
      currentActiveSessionId = sessionId;
    },
  };
}

describe('Session switch race condition', () => {
  describe('basic race protection', () => {
    it('rapid A→B switch: only B becomes active when A loads slower', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-a'));
      store.addSession(makeSession('session-b'));

      const switcher = createSessionSwitcher();

      const switchA = switcher.switchTo('session-a', {
        messageLoadDelay: 100,
        traceLoadDelay: 50,
        messages: makeMessages('session-a', 3),
        traceSteps: makeTraceSteps('session-a', 2),
      });
      const switchB = switcher.switchTo('session-b', {
        messageLoadDelay: 10,
        traceLoadDelay: 5,
        messages: makeMessages('session-b', 2),
        traceSteps: makeTraceSteps('session-b', 1),
      });

      await Promise.all([switchA, switchB]);

      const finalState = useAppStore.getState();
      expect(finalState.activeSessionId).toBe('session-b');
      expect(finalState.sessionStates['session-b'].messages).toHaveLength(2);
      expect(finalState.sessionStates['session-b'].traceSteps).toHaveLength(1);
      // Stale session A should not have data loaded
      expect(finalState.sessionStates['session-a'].messages).toHaveLength(0);
      expect(finalState.sessionStates['session-a'].traceSteps).toHaveLength(0);
    });

    it('rapid A→B→C switch: only C becomes active', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-a'));
      store.addSession(makeSession('session-b'));
      store.addSession(makeSession('session-c'));

      const switcher = createSessionSwitcher();

      const switchA = switcher.switchTo('session-a', {
        messageLoadDelay: 100,
        traceLoadDelay: 50,
        messages: makeMessages('session-a', 5),
        traceSteps: makeTraceSteps('session-a', 3),
      });
      const switchB = switcher.switchTo('session-b', {
        messageLoadDelay: 80,
        traceLoadDelay: 40,
        messages: makeMessages('session-b', 3),
        traceSteps: makeTraceSteps('session-b', 2),
      });
      const switchC = switcher.switchTo('session-c', {
        messageLoadDelay: 20,
        traceLoadDelay: 10,
        messages: makeMessages('session-c', 1),
        traceSteps: makeTraceSteps('session-c', 1),
      });

      await Promise.all([switchA, switchB, switchC]);

      const finalState = useAppStore.getState();
      expect(finalState.activeSessionId).toBe('session-c');
      expect(finalState.sessionStates['session-c'].messages).toHaveLength(1);
      expect(finalState.sessionStates['session-a'].messages).toHaveLength(0);
      expect(finalState.sessionStates['session-b'].messages).toHaveLength(0);
    });

    it('single click works normally without race issues', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-a'));

      const switcher = createSessionSwitcher();

      await switcher.switchTo('session-a', {
        messageLoadDelay: 10,
        traceLoadDelay: 5,
        messages: makeMessages('session-a', 4),
        traceSteps: makeTraceSteps('session-a', 2),
      });

      const finalState = useAppStore.getState();
      expect(finalState.activeSessionId).toBe('session-a');
      expect(finalState.sessionStates['session-a'].messages).toHaveLength(4);
      expect(finalState.sessionStates['session-a'].traceSteps).toHaveLength(2);
    });
  });

  describe('two-stage async guard', () => {
    it('aborts between message and trace load when a new switch starts', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-a'));
      store.addSession(makeSession('session-b'));

      const switcher = createSessionSwitcher();

      // A has fast message load but slow trace load
      const switchA = switcher.switchTo('session-a', {
        messageLoadDelay: 5,
        traceLoadDelay: 100, // Slow trace — B will interrupt during this wait
        messages: makeMessages('session-a', 3),
        traceSteps: makeTraceSteps('session-a', 2),
      });

      // Wait for A's message load to complete, then switch to B
      await new Promise((resolve) => setTimeout(resolve, 15));
      const switchB = switcher.switchTo('session-b', {
        messageLoadDelay: 5,
        traceLoadDelay: 5,
        messages: makeMessages('session-b', 2),
        traceSteps: makeTraceSteps('session-b', 1),
      });

      await Promise.all([switchA, switchB]);

      const finalState = useAppStore.getState();
      expect(finalState.activeSessionId).toBe('session-b');
      // A's messages were loaded (before B interrupted), but trace steps were not
      expect(finalState.sessionStates['session-a'].messages).toHaveLength(3);
      expect(finalState.sessionStates['session-a'].traceSteps).toHaveLength(0);
      // B is fully loaded
      expect(finalState.sessionStates['session-b'].messages).toHaveLength(2);
      expect(finalState.sessionStates['session-b'].traceSteps).toHaveLength(1);
    });

    it('aborts after trace load when a new switch starts during trace await', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-a'));
      store.addSession(makeSession('session-b'));

      const switcher = createSessionSwitcher();

      // A has fast message load, medium trace load
      const switchA = switcher.switchTo('session-a', {
        messageLoadDelay: 5,
        traceLoadDelay: 50,
        messages: makeMessages('session-a', 3),
        traceSteps: makeTraceSteps('session-a', 2),
      });

      // Wait for A's message + trace to be in-flight, then switch to B
      await new Promise((resolve) => setTimeout(resolve, 40));
      const switchB = switcher.switchTo('session-b', {
        messageLoadDelay: 5,
        traceLoadDelay: 5,
        messages: makeMessages('session-b', 1),
        traceSteps: makeTraceSteps('session-b', 1),
      });

      await Promise.all([switchA, switchB]);

      const finalState = useAppStore.getState();
      expect(finalState.activeSessionId).toBe('session-b');
    });
  });

  describe('cancellation by re-clicking active session', () => {
    it('re-clicking current session cancels a pending switch', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-o'));
      store.addSession(makeSession('session-a'));

      const switcher = createSessionSwitcher();

      // First, activate session O normally
      await switcher.switchTo('session-o', {
        messageLoadDelay: 5,
        traceLoadDelay: 5,
        messages: makeMessages('session-o', 2),
        traceSteps: makeTraceSteps('session-o', 1),
      });
      expect(useAppStore.getState().activeSessionId).toBe('session-o');

      // Now click session A (slow load)
      const switchA = switcher.switchTo('session-a', {
        messageLoadDelay: 100,
        traceLoadDelay: 50,
        messages: makeMessages('session-a', 3),
        traceSteps: makeTraceSteps('session-a', 2),
      });

      // User changes mind and re-clicks session O (the current active session)
      // This should cancel the pending switch to A
      await new Promise((resolve) => setTimeout(resolve, 20));
      await switcher.switchTo('session-o', {
        messageLoadDelay: 0,
        traceLoadDelay: 0,
        messages: [],
        traceSteps: [],
      });

      await switchA;

      const finalState = useAppStore.getState();
      // Should remain on session O — the switch to A was canceled
      expect(finalState.activeSessionId).toBe('session-o');
      // Session A should not have been loaded
      expect(finalState.sessionStates['session-a'].messages).toHaveLength(0);
    });

    it('cancelPendingSwitch invalidates in-flight request', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-a'));

      const switcher = createSessionSwitcher();

      // Start a slow switch
      const switchA = switcher.switchTo('session-a', {
        messageLoadDelay: 100,
        traceLoadDelay: 50,
        messages: makeMessages('session-a', 3),
        traceSteps: makeTraceSteps('session-a', 2),
      });

      // Cancel it mid-flight
      await new Promise((resolve) => setTimeout(resolve, 20));
      switcher.cancelPendingSwitch();

      await switchA;

      const finalState = useAppStore.getState();
      // No session should be active — the switch was canceled
      expect(finalState.activeSessionId).toBeNull();
      expect(finalState.sessionStates['session-a'].messages).toHaveLength(0);
    });
  });

  describe('recovery after stale/failed switches', () => {
    it('subsequent switch works after a stale one is discarded', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-a'));
      store.addSession(makeSession('session-b'));

      const switcher = createSessionSwitcher();

      // A is stale (B interrupts it)
      const switchA = switcher.switchTo('session-a', {
        messageLoadDelay: 50,
        traceLoadDelay: 30,
        messages: makeMessages('session-a', 3),
        traceSteps: makeTraceSteps('session-a', 2),
      });
      const switchB = switcher.switchTo('session-b', {
        messageLoadDelay: 5,
        traceLoadDelay: 5,
        messages: makeMessages('session-b', 2),
        traceSteps: makeTraceSteps('session-b', 1),
      });

      await Promise.all([switchA, switchB]);
      expect(useAppStore.getState().activeSessionId).toBe('session-b');

      // Now switch to A again — should work fine
      await switcher.switchTo('session-a', {
        messageLoadDelay: 5,
        traceLoadDelay: 5,
        messages: makeMessages('session-a', 3),
        traceSteps: makeTraceSteps('session-a', 2),
      });

      const finalState = useAppStore.getState();
      expect(finalState.activeSessionId).toBe('session-a');
      expect(finalState.sessionStates['session-a'].messages).toHaveLength(3);
      expect(finalState.sessionStates['session-a'].traceSteps).toHaveLength(2);
    });

    it('does not activate stale session when messages are already cached', async () => {
      const store = useAppStore.getState();
      store.addSession(makeSession('session-a'));
      store.addSession(makeSession('session-b'));

      // Pre-populate session A with cached messages and trace steps
      store.setMessages('session-a', makeMessages('session-a', 3));
      store.setTraceSteps('session-a', makeTraceSteps('session-a', 1));

      const switcher = createSessionSwitcher();

      // Click A (cached — no async load needed)
      const switchA = switcher.switchTo('session-a', {
        messageLoadDelay: 0,
        traceLoadDelay: 0,
        messages: [],
        traceSteps: [],
      });
      // Immediately click B
      const switchB = switcher.switchTo('session-b', {
        messageLoadDelay: 5,
        traceLoadDelay: 5,
        messages: makeMessages('session-b', 2),
        traceSteps: makeTraceSteps('session-b', 1),
      });

      await Promise.all([switchA, switchB]);

      const finalState = useAppStore.getState();
      expect(finalState.activeSessionId).toBe('session-b');
    });
  });
});
