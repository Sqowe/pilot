import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ConfigStore persistence tests for skillConflictConfig and orphanDismissals.
 *
 * Regression guard: `ConfigStore.update()` builds the saved config from a
 * projected base (which carries the *old* value) and then overrides a fixed
 * list of fields. If a field is missing from that override list, updates to it
 * are silently dropped and every skill-conflict mutation in the UI no-ops,
 * making the Settings → Skills "Conflict Resolution" radios appear unchangeable.
 */

vi.mock('electron-store', () => {
  const backing = new Map<string, Record<string, unknown>>();
  const reset = () => backing.clear();

  class MockStore<T extends Record<string, unknown>> {
    public path = '/tmp/mock-config-store-skill-conflict.json';
    static __resetMockBacking = reset;

    constructor(options: { defaults?: Record<string, unknown> }) {
      if (!backing.has(this.path)) {
        backing.set(this.path, { ...(options?.defaults || {}) });
      }
    }

    private get data(): Record<string, unknown> {
      let d = backing.get(this.path);
      if (!d) {
        d = {};
        backing.set(this.path, d);
      }
      return d;
    }

    get store(): Record<string, unknown> {
      return this.data;
    }

    set store(value: Record<string, unknown>) {
      backing.set(this.path, value);
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.data[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.data[key] = value;
        return;
      }
      Object.assign(this.data, key);
    }
  }

  return { default: MockStore, __resetMockBacking: reset };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0.0.0' },
}));

import { ConfigStore } from '../src/main/config/config-store';

describe('ConfigStore skillConflictConfig', () => {
  let resetBacking: () => void;

  beforeEach(async () => {
    const mod = await import('electron-store');
    resetBacking = (mod as unknown as { __resetMockBacking: () => void }).__resetMockBacking;
    resetBacking();
  });

  it('defaults conflictPolicy to custom-wins', () => {
    const cs = new ConfigStore();
    expect(cs.get('skillConflictConfig').conflictPolicy).toBe('custom-wins');
  });

  it('persists conflictPolicy change via update (the radio-button bug)', () => {
    const cs = new ConfigStore();

    cs.update({
      skillConflictConfig: { ...cs.get('skillConflictConfig'), conflictPolicy: 'builtin-wins' },
    });
    expect(cs.get('skillConflictConfig').conflictPolicy).toBe('builtin-wins');

    cs.update({
      skillConflictConfig: { ...cs.get('skillConflictConfig'), conflictPolicy: 'ask' },
    });
    expect(cs.get('skillConflictConfig').conflictPolicy).toBe('ask');
  });

  it('persists disabledSkills and sourceOverrides', () => {
    const cs = new ConfigStore();
    const base = cs.get('skillConflictConfig');

    cs.update({
      skillConflictConfig: {
        ...base,
        conflictPolicy: 'builtin-wins',
        disabledSkills: ['pdf', 'web-search'],
        sourceOverrides: { pdf: 'builtin' },
      },
    });

    const after = cs.get('skillConflictConfig');
    expect(after.conflictPolicy).toBe('builtin-wins');
    expect(after.disabledSkills).toEqual(['pdf', 'web-search']);
    expect(after.sourceOverrides).toEqual({ pdf: 'builtin' });
  });

  it('survives a reload round-trip (new instance, same backing store)', () => {
    const cs = new ConfigStore();
    cs.update({
      skillConflictConfig: {
        ...cs.get('skillConflictConfig'),
        conflictPolicy: 'builtin-wins',
        disabledSkills: ['pdf'],
      },
    });

    // Simulate app restart
    const cs2 = new ConfigStore();
    const reloaded = cs2.get('skillConflictConfig');
    expect(reloaded.conflictPolicy).toBe('builtin-wins');
    expect(reloaded.disabledSkills).toEqual(['pdf']);
  });
});

describe('ConfigStore orphanDismissals', () => {
  let resetBacking: () => void;

  beforeEach(async () => {
    const mod = await import('electron-store');
    resetBacking = (mod as unknown as { __resetMockBacking: () => void }).__resetMockBacking;
    resetBacking();
  });

  it('persists orphanDismissals via update', () => {
    const cs = new ConfigStore();
    const dismissal = {
      cwd: '/home/user/project',
      dismissedAt: 1_750_000_000_000,
      skillsProfileMtimeMs: null,
      mcpProfileMtimeMs: null,
    };
    cs.update({ orphanDismissals: [dismissal] });
    expect(cs.get('orphanDismissals')).toEqual([dismissal]);
  });
});
