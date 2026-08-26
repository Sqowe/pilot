import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ConfigStore persistence tests for the httpProxy setting.
 *
 * Validates that:
 * - Default is absent (undefined)
 * - Setting a URL persists it trimmed
 * - Updating with empty string removes the field (clearing semantics)
 * - Updating with undefined leaves the current value unchanged
 * - Round-trip through normalizeConfig preserves non-empty values and drops empty ones
 * - The field is never written as `undefined` (which conf/electron-store rejects)
 */

vi.mock('electron-store', () => {
  const backing = new Map<string, Record<string, unknown>>();
  const reset = () => backing.clear();

  class MockStore<T extends Record<string, unknown>> {
    public path = '/tmp/mock-config-store-http-proxy.json';
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
        if (value === undefined) {
          throw new TypeError(
            `Setting a value of type \`undefined\` for key \`${key}\` is not allowed as it's not supported by JSON`
          );
        }
        this.data[key] = value;
        return;
      }
      // object form — real conf MERGES (does not replace); reject undefined values
      for (const [k, v] of Object.entries(key)) {
        if (v === undefined) {
          throw new TypeError(
            `Setting a value of type \`undefined\` for key \`${k}\` is not allowed as it's not supported by JSON`
          );
        }
      }
      Object.assign(this.data, key);
    }

    delete(key: string): void {
      // Real conf.delete(key) removes the key from the store file
      delete this.data[key];
    }
  }

  return { default: MockStore, __resetMockBacking: reset };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0.0.0' },
}));

import { ConfigStore } from '../src/main/config/config-store';

describe('ConfigStore httpProxy', () => {
  let resetBacking: () => void;

  beforeEach(async () => {
    const mod = await import('electron-store');
    resetBacking = (mod as unknown as { __resetMockBacking: () => void }).__resetMockBacking;
    resetBacking();
  });

  it('defaults to undefined (field absent)', () => {
    const cs = new ConfigStore();
    expect(cs.get('httpProxy')).toBeUndefined();
  });

  it('persists a proxy URL via update', () => {
    const cs = new ConfigStore();
    cs.update({ httpProxy: 'http://proxy.example.com:8080' });
    expect(cs.get('httpProxy')).toBe('http://proxy.example.com:8080');
  });

  it('trims whitespace from the URL on update', () => {
    const cs = new ConfigStore();
    cs.update({ httpProxy: '  http://proxy.example.com:8080  ' });
    expect(cs.get('httpProxy')).toBe('http://proxy.example.com:8080');
  });

  it('clears the field when updated with an empty string', () => {
    const cs = new ConfigStore();
    cs.update({ httpProxy: 'http://proxy.example.com:8080' });
    expect(cs.get('httpProxy')).toBe('http://proxy.example.com:8080');

    // Clearing with empty string should remove the field entirely
    cs.update({ httpProxy: '' });
    expect(cs.get('httpProxy')).toBeUndefined();
  });

  it('clears the field when updated with a whitespace-only string', () => {
    const cs = new ConfigStore();
    cs.update({ httpProxy: 'http://proxy.example.com:8080' });
    cs.update({ httpProxy: '   ' });
    expect(cs.get('httpProxy')).toBeUndefined();
  });

  it('leaves the current value unchanged when updated with undefined', () => {
    const cs = new ConfigStore();
    cs.update({ httpProxy: 'http://proxy.example.com:8080' });
    // undefined means "no change" — the field should be preserved
    cs.update({ httpProxy: undefined });
    expect(cs.get('httpProxy')).toBe('http://proxy.example.com:8080');
  });

  it('never writes undefined to the store (no conf TypeError)', () => {
    // This test ensures the store.set() call never receives undefined for httpProxy,
    // which would throw in conf/electron-store.
    expect(() => {
      const cs = new ConfigStore();
      // Fresh store with no httpProxy — should not throw
      cs.getAll();
      // Update with empty string — should not throw
      cs.update({ httpProxy: '' });
      // Update with a value — should not throw
      cs.update({ httpProxy: 'http://proxy.example.com:8080' });
      // Clear again — should not throw
      cs.update({ httpProxy: '' });
    }).not.toThrow();
  });

  it('getAll() includes httpProxy after update', () => {
    const cs = new ConfigStore();
    cs.update({ httpProxy: 'http://proxy.example.com:8080' });
    expect(cs.getAll().httpProxy).toBe('http://proxy.example.com:8080');
  });

  it('getAll() excludes httpProxy after clearing', () => {
    const cs = new ConfigStore();
    cs.update({ httpProxy: 'http://proxy.example.com:8080' });
    cs.update({ httpProxy: '' });
    expect(cs.getAll().httpProxy).toBeUndefined();
  });

  it('normalizes on load — empty string from disk is dropped', () => {
    const cs = new ConfigStore();
    // Simulate a disk state with an empty httpProxy (e.g. from a manual edit)
    // by writing directly to the mock backing
    (cs as unknown as { store: { set: (k: string, v: unknown) => void } }).store.set(
      'httpProxy',
      ''
    );

    const cs2 = new ConfigStore();
    expect(cs2.get('httpProxy')).toBeUndefined();
  });
});
