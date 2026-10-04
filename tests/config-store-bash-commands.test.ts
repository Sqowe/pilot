import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BASH_RESTRICTIONS_SETTINGS } from '../src/shared/bash-restrictions';

/**
 * ConfigStore persistence tests for the bash trust list and denylist.
 *
 * The settings UI writes these fields through Zustand → `settings.update`
 * IPC → `configStore.update(...)`. These tests pin down the round-trip,
 * sanitization, partial-update semantics, and default behaviour that the
 * main-process startup hook relies on.
 */

vi.mock('electron-store', () => {
  // Module-level backing state keyed by store path. Each `new MockStore()`
  // reads and writes through the same underlying map, which is what lets
  // us simulate "close app, reopen it" by constructing a fresh instance
  // and checking the previously-persisted values survive.
  const backing = new Map<string, Record<string, unknown>>();
  const reset = () => backing.clear();

  class MockStore<T extends Record<string, unknown>> {
    public path = '/tmp/mock-config-store-bash-commands.json';

    // Attached to the constructor so the test file can reach it through
    // a plain default-import. Named exports on the vi.mock factory return
    // are not reliably accessible through `import Store from '...'`.
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
      const merged = { ...this.data, ...key };
      backing.set(this.path, merged);
    }

    clear(): void {
      backing.set(this.path, {});
    }
  }

  return { default: MockStore };
});

import { ConfigStore } from '../src/main/config/config-store';
import ElectronStore from 'electron-store';

// Reset helper is attached as a static on the mocked default export so we
// can reach it through a plain default-import.
const resetMockBacking = (ElectronStore as unknown as { __resetMockBacking?: () => void })
  .__resetMockBacking;

beforeEach(() => {
  resetMockBacking?.();
});

describe('ConfigStore bash trust list and denylist', () => {
  it('defaults both lists to empty arrays', () => {
    const store = new ConfigStore();
    expect(store.get('bashTrustedCommands')).toEqual([]);
    expect(store.get('bashDenylist')).toEqual([]);
  });

  it('persists a trust list and denylist through update()', () => {
    const store = new ConfigStore();
    store.update({ bashTrustedCommands: ['npm *', 'git *'] });
    store.update({ bashDenylist: ['rm -rf', 'sudo'] });
    expect(store.get('bashTrustedCommands')).toEqual(['npm *', 'git *']);
    expect(store.get('bashDenylist')).toEqual(['rm -rf', 'sudo']);
  });

  it('round-trips both lists through getAll()', () => {
    const store = new ConfigStore();
    store.update({
      bashTrustedCommands: ['ls *'],
      bashDenylist: ['--force'],
    });
    const all = store.getAll();
    expect(all.bashTrustedCommands).toEqual(['ls *']);
    expect(all.bashDenylist).toEqual(['--force']);
  });

  it('strips non-string entries and trims whitespace on write', () => {
    const store = new ConfigStore();
    // Cast through unknown to exercise the sanitizer with a deliberately
    // garbled input — simulates a malformed IPC payload.
    store.update({
      bashTrustedCommands: ['  npm *  ', 42, null, '', 'git *'] as unknown as string[],
      bashDenylist: ['rm -rf', undefined, { not: 'a string' }] as unknown as string[],
    });
    expect(store.get('bashTrustedCommands')).toEqual(['npm *', 'git *']);
    expect(store.get('bashDenylist')).toEqual(['rm -rf']);
  });

  it('coerces non-array values back to empty lists', () => {
    const store = new ConfigStore();
    store.update({
      bashTrustedCommands: 'not-an-array' as unknown as string[],
      bashDenylist: { also: 'not-an-array' } as unknown as string[],
    });
    expect(store.get('bashTrustedCommands')).toEqual([]);
    expect(store.get('bashDenylist')).toEqual([]);
  });

  it('leaves the other list untouched on a partial update', () => {
    const store = new ConfigStore();
    store.update({
      bashTrustedCommands: ['npm *'],
      bashDenylist: ['rm -rf'],
    });
    // Only update trusted; denylist must survive.
    store.update({ bashTrustedCommands: ['npm *', 'git *'] });
    expect(store.get('bashTrustedCommands')).toEqual(['npm *', 'git *']);
    expect(store.get('bashDenylist')).toEqual(['rm -rf']);

    // And vice versa.
    store.update({ bashDenylist: ['rm -rf', 'sudo'] });
    expect(store.get('bashTrustedCommands')).toEqual(['npm *', 'git *']);
    expect(store.get('bashDenylist')).toEqual(['rm -rf', 'sudo']);
  });

  it('clears a list when an empty array is explicitly passed', () => {
    const store = new ConfigStore();
    store.update({
      bashTrustedCommands: ['npm *'],
      bashDenylist: ['rm -rf'],
    });
    store.update({ bashTrustedCommands: [] });
    expect(store.get('bashTrustedCommands')).toEqual([]);
    expect(store.get('bashDenylist')).toEqual(['rm -rf']);
  });

  it('genuinely persists across ConfigStore instances (true restart simulation)', () => {
    // First "session": user configures their lists.
    const first = new ConfigStore();
    first.update({
      bashTrustedCommands: ['npm *', 'git *'],
      bashDenylist: ['rm -rf'],
    });

    // Second "session": a brand-new ConfigStore instance reading the same
    // backing store (module-level map keyed by path — see the mock above).
    // The previously-persisted values MUST be visible to the new instance,
    // otherwise the main-process startup hydration cannot see them on app
    // restart and the startup race window is not actually closed.
    const second = new ConfigStore();
    expect(second.get('bashTrustedCommands')).toEqual(['npm *', 'git *']);
    expect(second.get('bashDenylist')).toEqual(['rm -rf']);
  });
});

describe('permissionTimeoutSeconds normalization via ConfigStore', () => {
  // These tests pin down that ConfigStore.update() normalizes
  // permissionTimeoutSeconds through the shared normalizePermissionTimeout
  // (imported from src/shared/bash-restrictions/settings.ts), verifying
  // it is semantically identical to the local function it replaced.
  // The same cases are tested at the shared-module level in
  // tests/bash-restrictions-settings.test.ts.

  it('stores a valid in-range value unchanged', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: 300 });
    expect(cs.get('permissionTimeoutSeconds')).toBe(300);
  });

  it('stores 0 (infinite) unchanged', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: 0 });
    expect(cs.get('permissionTimeoutSeconds')).toBe(0);
  });

  it('clamps negative values to 0 (infinite)', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: -1 });
    expect(cs.get('permissionTimeoutSeconds')).toBe(0);
  });

  it('clamps values below 10 up to 10', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: 5 });
    expect(cs.get('permissionTimeoutSeconds')).toBe(10);
  });

  it('clamps values above 3600 down to 3600', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: 9999 });
    expect(cs.get('permissionTimeoutSeconds')).toBe(3600);
  });

  it('falls back to the shared default for NaN', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: NaN });
    expect(cs.get('permissionTimeoutSeconds')).toBe(
      DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds
    );
  });

  it('falls back to the shared default for Infinity', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: Infinity });
    expect(cs.get('permissionTimeoutSeconds')).toBe(
      DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds
    );
  });

  it('falls back to the shared default for non-number input', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: 'forever' as unknown as number });
    expect(cs.get('permissionTimeoutSeconds')).toBe(
      DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds
    );
  });

  it('floors decimal values', () => {
    const cs = new ConfigStore();
    cs.update({ permissionTimeoutSeconds: 10.9 });
    expect(cs.get('permissionTimeoutSeconds')).toBe(10);
  });
});

describe('ConfigStore trusted directories', () => {
  it('defaults to an empty list (write checks off)', () => {
    expect(new ConfigStore().get('trustedDirectories')).toEqual([]);
  });

  it('persists entries as written and survives a restart', () => {
    new ConfigStore().update({ trustedDirectories: ['./', '/tmp', '~/work'] });
    // A fresh instance over the same backing store simulates relaunching the app.
    expect(new ConfigStore().get('trustedDirectories')).toEqual(['./', '/tmp', '~/work']);
  });

  it('trims entries, drops non-strings and blanks, and removes duplicates', () => {
    const store = new ConfigStore();
    store.update({
      trustedDirectories: [' ./ ', '/tmp', 7, null, '', './', '/tmp'] as unknown as string[],
    });
    expect(store.get('trustedDirectories')).toEqual(['./', '/tmp']);
  });

  it('coerces a non-array value to an empty list', () => {
    const store = new ConfigStore();
    store.update({ trustedDirectories: ['./'] });
    store.update({ trustedDirectories: './' as unknown as string[] });
    expect(store.get('trustedDirectories')).toEqual([]);
  });

  it('is left untouched by an update of the command lists', () => {
    const store = new ConfigStore();
    store.update({ trustedDirectories: ['./'] });
    store.update({ bashTrustedCommands: ['npm *'], bashDenylist: ['rm'] });
    expect(store.get('trustedDirectories')).toEqual(['./']);
    expect(store.getAll().trustedDirectories).toEqual(['./']);
  });
});
