import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseInstance } from '../src/main/db/database';

// --- Mocks (must be before SessionManager import) ---

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-stop-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults || {}) };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = { ...this.store, ...key };
    }
  }

  return { default: MockStore };
});

vi.mock('../src/main/claude/agent-runner', () => ({
  ClaudeAgentRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

import { SessionManager } from '../src/main/session/session-manager';

function createMockDb() {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(() => ({
        id: 's1',
        title: 'Test',
        created_at: Date.now(),
        updated_at: Date.now(),
        status: 'idle',
        cwd: '/tmp',
      })),
      getAll: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    messages: {
      create: vi.fn(),
      getBySessionId: vi.fn(() => []),
      delete: vi.fn(),
      deleteBySessionId: vi.fn(),
    },
    traceSteps: {
      create: vi.fn(),
      update: vi.fn(),
      getBySessionId: vi.fn(() => []),
      deleteBySessionId: vi.fn(),
    },
  } as unknown as DatabaseInstance;
}

const session = (id = 's1') => ({
  id,
  title: 'Test',
  created_at: Date.now(),
  updated_at: Date.now(),
  status: 'idle' as const,
  cwd: '/tmp',
});

type Enqueue = { enqueuePrompt: (s: unknown, p: string) => void };
type LoadSession = { loadSession: (id: string) => unknown };
type ProcessPrompt = { processPrompt: () => Promise<void> };

describe('stopSession releases work that would otherwise stay alive', () => {
  let db: DatabaseInstance;
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createMockDb();
    sendToRenderer = vi.fn();
  });

  it('denies permission requests still waiting for an answer', async () => {
    const manager = new SessionManager(db, sendToRenderer);

    const pending = manager.requestPermission('s1', 'tool-use-1', 'bash', { command: 'ls' });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    manager.stopSession('s1');

    await expect(pending).resolves.toEqual({ result: 'deny', suggestion: undefined });
    expect(sendToRenderer).toHaveBeenCalledWith({
      type: 'permission.dismiss',
      payload: { toolUseId: 'tool-use-1' },
    });
  });

  it('leaves permission requests of other sessions untouched', async () => {
    const manager = new SessionManager(db, sendToRenderer);

    const other = manager.requestPermission('s2', 'tool-use-2', 'bash', { command: 'ls' });
    let settled = false;
    void other.then(() => {
      settled = true;
    });

    manager.stopSession('s1');
    await new Promise((r) => setTimeout(r, 0));

    expect(settled).toBe(false);
    expect(sendToRenderer).not.toHaveBeenCalledWith({
      type: 'permission.dismiss',
      payload: { toolUseId: 'tool-use-2' },
    });
  });

  it('lets the next prompt start a fresh run instead of queueing behind the stopped one', async () => {
    const manager = new SessionManager(db, sendToRenderer);

    // Never resolves — mirrors a run whose pi loop is still settling after Stop.
    const processPrompt = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
    (manager as unknown as ProcessPrompt).processPrompt = processPrompt;
    (manager as unknown as LoadSession).loadSession = (id: string) => session(id);

    (manager as unknown as Enqueue).enqueuePrompt(session(), 'first');
    await new Promise((r) => setTimeout(r, 0));
    expect(processPrompt).toHaveBeenCalledTimes(1);

    manager.stopSession('s1');

    (manager as unknown as Enqueue).enqueuePrompt(session(), 'second');
    await new Promise((r) => setTimeout(r, 0));
    expect(processPrompt).toHaveBeenCalledTimes(2);
  });

  it('does not report idle on behalf of a newer run when a stopped run finally settles', async () => {
    const manager = new SessionManager(db, sendToRenderer);

    const statuses: string[] = [];
    sendToRenderer.mockImplementation((msg: { type: string; payload: { status?: string } }) => {
      if (msg.type === 'session.status' && msg.payload.status) {
        statuses.push(msg.payload.status);
      }
    });

    let settleFirst!: () => void;
    const first = new Promise<void>((r) => {
      settleFirst = r;
    });
    let callCount = 0;
    (manager as unknown as ProcessPrompt).processPrompt = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? first : new Promise<void>(() => {});
    });
    (manager as unknown as LoadSession).loadSession = (id: string) => session(id);

    (manager as unknown as Enqueue).enqueuePrompt(session(), 'first');
    await new Promise((r) => setTimeout(r, 0));

    manager.stopSession('s1');
    (manager as unknown as Enqueue).enqueuePrompt(session(), 'second');
    await new Promise((r) => setTimeout(r, 0));

    // running (first) → idle (stop) → running (second)
    expect(statuses).toEqual(['running', 'idle', 'running']);

    // The stopped run settles late; it must not touch the newer run's state.
    settleFirst();
    await new Promise((r) => setTimeout(r, 10));

    expect(statuses).toEqual(['running', 'idle', 'running']);
  });
});

describe('ClaudeAgentRunner.cancel stops the pi agent, not just our event stream', () => {
  const agentRunnerContent = readFileSync(
    join(__dirname, '../src/main/claude/agent-runner.ts'),
    'utf-8'
  );
  const cancelIdx = agentRunnerContent.indexOf('cancel(sessionId: string): void {');
  const cancelEndIdx = agentRunnerContent.indexOf('private sendTraceStep(', cancelIdx);
  const cancelMethod = agentRunnerContent.slice(cancelIdx, cancelEndIdx);

  it('finds the cancel method', () => {
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(cancelEndIdx).toBeGreaterThan(cancelIdx);
  });

  // Our own AbortController is never handed to pi, so aborting it only silences
  // the event subscription. Only these calls reach pi's own agent loop.
  it.each([
    ['abort', 'cached.session.abort()'],
    ['abortCompaction', 'cached.session.abortCompaction()'],
    ['abortBranchSummary', 'cached.session.abortBranchSummary()'],
    ['abortBash', 'cached.session.abortBash()'],
  ])('calls pi session %s', (_name, snippet) => {
    expect(cancelMethod).toContain(snippet);
  });

  it('drops the active controller only while it is still the current one', () => {
    expect(agentRunnerContent).toContain(
      'if (this.activeControllers.get(session.id) === controller) {'
    );
  });
});
