import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store-system-prompt-file.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
      };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = {
        ...this.store,
        ...key,
      };
    }

    clear(): void {
      this.store = {};
    }
  }

  return { default: MockStore };
});

import { ConfigStore } from '../src/main/config/config-store';

describe('ConfigStore systemPromptFile', () => {
  it('defaults to empty string (preserves current behavior)', () => {
    const store = new ConfigStore();
    expect(store.get('systemPromptFile')).toBe('');
  });

  it('persists a whitelisted choice through update()', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: 'CLAUDE.md' });
    expect(store.get('systemPromptFile')).toBe('CLAUDE.md');
    store.update({ systemPromptFile: '.cowork/instructions.md' });
    expect(store.get('systemPromptFile')).toBe('.cowork/instructions.md');
  });

  it('normalizes unknown values back to empty string', () => {
    const store = new ConfigStore();
    // Cast through unknown to bypass the compile-time union for this negative test.
    store.update({ systemPromptFile: 'README.md' as unknown as '' });
    expect(store.get('systemPromptFile')).toBe('');
  });

  it('normalizes non-string values back to empty string', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: 42 as unknown as '' });
    expect(store.get('systemPromptFile')).toBe('');
  });

  it('round-trips through getAll()', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: 'AGENTS.md' });
    expect(store.getAll().systemPromptFile).toBe('AGENTS.md');
  });
});
