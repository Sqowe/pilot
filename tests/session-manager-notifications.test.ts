import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseInstance } from '../src/main/db/database';

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
    public path = '/tmp/mock-notifications-config-store.json';

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

// Mock native-notifications to track calls
const mockNotifyPermissionRequest = vi.fn();
const mockNotifyAgentComplete = vi.fn();
vi.mock('../src/main/utils/native-notifications', () => ({
  notifyPermissionRequest: (...args: unknown[]) => mockNotifyPermissionRequest(...args),
  notifyAgentComplete: (...args: unknown[]) => mockNotifyAgentComplete(...args),
}));

import { SessionManager } from '../src/main/session/session-manager';

function makeDb(): DatabaseInstance {
  const sessions = new Map<string, Record<string, unknown>>();
  return {
    sessions: {
      get: (id: string) =>
        (sessions.get(id) as ReturnType<DatabaseInstance['sessions']['get']>) || null,
      create: (session: Record<string, unknown>) => {
        sessions.set(session.id as string, session);
        return session;
      },
      update: (id: string, updates: Record<string, unknown>) => {
        const existing = sessions.get(id);
        if (existing) sessions.set(id, { ...existing, ...updates });
      },
      list: () => Array.from(sessions.values()),
      delete: () => {},
      batchDelete: () => {},
    },
    messages: {
      getBySession: () => [],
      create: vi.fn(),
      delete: vi.fn(),
      deleteBySession: vi.fn(),
      batchDeleteBySessions: vi.fn(),
    },
    traceSteps: {
      getBySession: () => [],
      upsert: vi.fn(),
      update: vi.fn(),
      deleteBySession: vi.fn(),
      batchDeleteBySessions: vi.fn(),
    },
  } as unknown as DatabaseInstance;
}

describe('SessionManager notification triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires notifyAgentComplete only on running → idle transition', () => {
    const db = makeDb();
    const sendToRenderer = vi.fn();
    const manager = new SessionManager(db, sendToRenderer);

    // Create a session that is currently running
    db.sessions.create({
      id: 's1',
      title: 'Test Session',
      status: 'running',
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    // Trigger running → idle
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).updateSessionStatus('s1', 'idle');

    expect(mockNotifyAgentComplete).toHaveBeenCalledWith('Test Session');
  });

  it('does NOT fire notifyAgentComplete when status is already idle (idle → idle)', () => {
    const db = makeDb();
    const sendToRenderer = vi.fn();
    const manager = new SessionManager(db, sendToRenderer);

    db.sessions.create({
      id: 's2',
      title: 'Idle Session',
      status: 'idle',
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).updateSessionStatus('s2', 'idle');

    expect(mockNotifyAgentComplete).not.toHaveBeenCalled();
  });

  it('does NOT fire notifyAgentComplete when transitioning to running', () => {
    const db = makeDb();
    const sendToRenderer = vi.fn();
    const manager = new SessionManager(db, sendToRenderer);

    db.sessions.create({
      id: 's3',
      title: 'Starting Session',
      status: 'idle',
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).updateSessionStatus('s3', 'running');

    expect(mockNotifyAgentComplete).not.toHaveBeenCalled();
  });

  it('fires notifyPermissionRequest when requesting permission', async () => {
    const db = makeDb();
    const sendToRenderer = vi.fn();
    const manager = new SessionManager(db, sendToRenderer);

    // Start the permission request (don't await — it waits for response)
    const permissionPromise = manager.requestPermission('s1', 'tool-1', 'bash', {
      command: 'ls',
    });

    expect(mockNotifyPermissionRequest).toHaveBeenCalledWith('bash');

    // Resolve the permission to avoid hanging promise
    manager.handlePermissionResponse('tool-1', 'allow');
    await permissionPromise;
  });
});
