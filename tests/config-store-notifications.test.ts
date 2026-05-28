import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ConfigStore persistence tests for the notificationsEnabled setting.
 *
 * Validates that:
 * - Boolean values are persisted correctly
 * - Non-boolean values are normalized via toBoolean
 * - Default is true
 */

vi.mock('electron-store', () => {
  const backing = new Map<string, Record<string, unknown>>();
  const reset = () => backing.clear();

  class MockStore<T extends Record<string, unknown>> {
    public path = '/tmp/mock-config-store-notifications.json';
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

describe('ConfigStore notificationsEnabled', () => {
  let resetBacking: () => void;

  beforeEach(async () => {
    const mod = await import('electron-store');
    resetBacking = (mod as unknown as { __resetMockBacking: () => void }).__resetMockBacking;
    resetBacking();
  });

  it('defaults to true', () => {
    const cs = new ConfigStore();
    expect(cs.get('notificationsEnabled')).toBe(true);
  });

  it('persists a boolean true value via update', () => {
    const cs = new ConfigStore();
    cs.update({ notificationsEnabled: false });
    expect(cs.get('notificationsEnabled')).toBe(false);

    cs.update({ notificationsEnabled: true });
    expect(cs.get('notificationsEnabled')).toBe(true);
  });

  it('normalizes non-boolean values to the current value on update', () => {
    const cs = new ConfigStore();
    // Start with true (default)
    expect(cs.get('notificationsEnabled')).toBe(true);

    // Passing a non-boolean should fall back to current value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cs.update({ notificationsEnabled: 'yes' as any });
    expect(cs.get('notificationsEnabled')).toBe(true);

    // Set to false first
    cs.update({ notificationsEnabled: false });
    expect(cs.get('notificationsEnabled')).toBe(false);

    // Non-boolean should keep current (false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cs.update({ notificationsEnabled: 1 as any });
    expect(cs.get('notificationsEnabled')).toBe(false);
  });

  it('normalizes on load (normalizeConfig path)', () => {
    const cs = new ConfigStore();
    // The normalizeConfig path uses toBoolean which handles undefined/null
    const config = cs.getAll();
    expect(config.notificationsEnabled).toBe(true);
  });

  it('survives a round-trip (persist and reload)', () => {
    const cs = new ConfigStore();
    cs.update({ notificationsEnabled: false });

    // Simulate app restart by creating a new instance (same backing store)
    const cs2 = new ConfigStore();
    expect(cs2.get('notificationsEnabled')).toBe(false);
  });
});
