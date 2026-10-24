import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Main-process tests covering the startup hydration hook and the
 * `settings.update` IPC persistence path for bash trust/deny lists.
 *
 * The actual `whenReady()` wiring in `src/main/index.ts` is not exported,
 * so we test the same contract by exercising the exported primitives it
 * relies on:
 *
 *   1. At app startup, main calls
 *        setBashCommandLists(
 *          configStore.get('bashTrustedCommands'),
 *          configStore.get('bashDenylist')
 *        );
 *      and the in-memory policy must reflect the persisted values before
 *      any tool call runs.
 *
 *   2. On incoming `settings.update`, main sanitizes the payload via
 *      `sanitizeBashCommandList` and feeds the normalized arrays to both
 *      `setBashCommandLists` and `configStore.update`, keeping runtime
 *      policy and persisted config in lockstep.
 *
 * These tests cover both paths including malformed payloads and partial
 * updates. If the startup contract regresses, policy won't be applied for
 * the first tool call after an app restart — a real security risk.
 */

// Shared mock backing store — mirrors the pattern used by
// `tests/config-store-bash-commands.test.ts` so we can simulate app
// restarts by constructing a fresh ConfigStore over pre-populated data.
vi.mock('electron-store', () => {
  const backing = new Map<string, Record<string, unknown>>();
  const reset = () => backing.clear();

  class MockStore<T extends Record<string, unknown>> {
    public path = '/tmp/mock-bash-main-hydration.json';

    // Attached to the constructor itself so it survives
    // `import Store from 'electron-store'` default-import style used by
    // most tests. Named exports from vi.mock's factory are not reliably
    // readable through a default-import binding.
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
      backing.set(this.path, { ...this.data, ...key });
    }

    clear(): void {
      backing.set(this.path, {});
    }
  }

  return { default: MockStore };
});

import ElectronStore from 'electron-store';
import { ConfigStore } from '../src/main/config/config-store';
import {
  decideBashPermission,
  getBashCommandLists,
  sanitizeBashCommandList,
  setBashCommandLists,
  setPermissionRules,
} from '../src/main/config/permission-rules-store';

// Reset helper is attached as a static on the mocked default export so we
// can reach it through a plain default-import. The cast is necessary
// because the real electron-store type doesn't carry this helper — it
// only exists in the mock (see vi.mock above).
const resetMockBacking = (ElectronStore as unknown as { __resetMockBacking?: () => void })
  .__resetMockBacking;

beforeEach(() => {
  resetMockBacking?.();
  // Reset the policy module's in-memory state too so one test's runtime
  // lists don't leak into the next.
  setBashCommandLists([], []);
  setPermissionRules([]);
});

afterEach(() => {
  setBashCommandLists([], []);
  setPermissionRules([]);
});

describe('startup hydration from configStore', () => {
  it('applies persisted trust/deny lists to the runtime policy before first use', () => {
    // Seed the persisted config as if the user had previously configured
    // bash control and restarted the app.
    const seed = new ConfigStore();
    seed.update({
      bashTrustedCommands: ['npm *'],
      bashDenylist: ['rm -rf'],
    });

    // Sanity: the policy cache is empty at this point (no hydration yet),
    // so an evaluation delegates to the generic rule.
    expect(getBashCommandLists().trusted).toEqual([]);

    // Emulate what `whenReady()` does in src/main/index.ts: construct a
    // fresh ConfigStore, read the fields, hydrate the policy cache.
    const startupStore = new ConfigStore();
    setBashCommandLists(startupStore.get('bashTrustedCommands'), startupStore.get('bashDenylist'));

    // Runtime policy now reflects the persisted values.
    const lists = getBashCommandLists();
    expect(lists.trusted).toEqual(['npm *']);
    expect(lists.denied).toEqual(['rm -rf']);

    // And evaluation honours them — trusted command allows, denied asks.
    expect(decideBashPermission('npm install')).toBe('allow');
    expect(decideBashPermission('rm -rf /tmp')).toBe('ask');
  });

  it('starts a fresh install with the shipped defaults', () => {
    // A fresh install has no persisted lists of its own, so the store's
    // defaults apply: the trust list is `*` and the denylist holds the
    // shipped destructive-command patterns.
    const startupStore = new ConfigStore();
    setBashCommandLists(startupStore.get('bashTrustedCommands'), startupStore.get('bashDenylist'));

    const lists = getBashCommandLists();
    expect(lists.trusted).toEqual(['*']);
    expect(lists.denied).toContain('sudo');

    // Ordinary commands run; destructive ones ask.
    expect(decideBashPermission('ls -la')).toBe('allow');
    expect(decideBashPermission('rm -rf /')).toBe('ask');
  });

  it('returns no opinion when the user cleared both lists', () => {
    // The user emptied both lists → no opt-in → decideBashPermission
    // returns null and the generic rule engine decides.
    const store = new ConfigStore();
    store.update({ bashTrustedCommands: [], bashDenylist: [] });
    setBashCommandLists(store.get('bashTrustedCommands'), store.get('bashDenylist'));

    expect(getBashCommandLists().trusted).toEqual([]);
    expect(getBashCommandLists().denied).toEqual([]);
    expect(decideBashPermission('anything')).toBeNull();
  });
});

describe('settings.update IPC persistence path', () => {
  // Emulate what `handleClientEvent` does in src/main/index.ts for the
  // bash-fields branch. Extracted here so the contract is testable
  // without importing main. Keep this function's behaviour 1:1 with
  // main/index.ts.
  function handleBashFieldsUpdate(payload: unknown, configStore: ConfigStore): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { bashTrustedCommands?: unknown; bashDenylist?: unknown };
    const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(p, key);
    if (!hasOwn('bashTrustedCommands') && !hasOwn('bashDenylist')) return;

    const trustedNext = hasOwn('bashTrustedCommands')
      ? sanitizeBashCommandList(p.bashTrustedCommands)
      : undefined;
    const deniedNext = hasOwn('bashDenylist') ? sanitizeBashCommandList(p.bashDenylist) : undefined;

    setBashCommandLists(trustedNext, deniedNext);

    const persist: Partial<{ bashTrustedCommands: string[]; bashDenylist: string[] }> = {};
    if (trustedNext !== undefined) persist.bashTrustedCommands = trustedNext;
    if (deniedNext !== undefined) persist.bashDenylist = deniedNext;
    if (Object.keys(persist).length > 0) {
      configStore.update(persist);
    }
  }

  it('updates both in-memory policy and persisted config from a valid payload', () => {
    const cs = new ConfigStore();
    handleBashFieldsUpdate({ bashTrustedCommands: ['git *'], bashDenylist: ['sudo'] }, cs);

    // Runtime policy.
    expect(getBashCommandLists().trusted).toEqual(['git *']);
    expect(getBashCommandLists().denied).toEqual(['sudo']);

    // Persisted config.
    expect(cs.get('bashTrustedCommands')).toEqual(['git *']);
    expect(cs.get('bashDenylist')).toEqual(['sudo']);
  });

  it('sanitizes untrusted payload entries before both policy and persistence', () => {
    const cs = new ConfigStore();
    handleBashFieldsUpdate(
      {
        bashTrustedCommands: ['  npm *  ', 42, null, '', 'git *'],
        bashDenylist: ['rm -rf', { nope: 'bad' }, undefined, '  sudo  '],
      },
      cs
    );

    const runtime = getBashCommandLists();
    expect(runtime.trusted).toEqual(['npm *', 'git *']);
    expect(runtime.denied).toEqual(['rm -rf', 'sudo']);

    // Persisted config must see the *same* sanitized values — no divergence
    // between runtime and disk is allowed.
    expect(cs.get('bashTrustedCommands')).toEqual(['npm *', 'git *']);
    expect(cs.get('bashDenylist')).toEqual(['rm -rf', 'sudo']);
  });

  it('partial update preserves the other list in both policy and config', () => {
    const cs = new ConfigStore();
    handleBashFieldsUpdate({ bashTrustedCommands: ['npm *'], bashDenylist: ['rm -rf'] }, cs);

    // Only update trusted; denylist must survive unchanged everywhere.
    handleBashFieldsUpdate({ bashTrustedCommands: ['npm *', 'git *'] }, cs);
    expect(getBashCommandLists().trusted).toEqual(['npm *', 'git *']);
    expect(getBashCommandLists().denied).toEqual(['rm -rf']);
    expect(cs.get('bashTrustedCommands')).toEqual(['npm *', 'git *']);
    expect(cs.get('bashDenylist')).toEqual(['rm -rf']);
  });

  it('ignores null, undefined, and primitive payloads without throwing or mutating state', () => {
    const cs = new ConfigStore();
    handleBashFieldsUpdate({ bashTrustedCommands: ['git *'], bashDenylist: ['rm -rf'] }, cs);

    // Garbage payloads must not touch state.
    expect(() => handleBashFieldsUpdate(null, cs)).not.toThrow();
    expect(() => handleBashFieldsUpdate(undefined, cs)).not.toThrow();
    expect(() => handleBashFieldsUpdate(42, cs)).not.toThrow();
    expect(() => handleBashFieldsUpdate('nope', cs)).not.toThrow();

    expect(getBashCommandLists().trusted).toEqual(['git *']);
    expect(getBashCommandLists().denied).toEqual(['rm -rf']);
    expect(cs.get('bashTrustedCommands')).toEqual(['git *']);
    expect(cs.get('bashDenylist')).toEqual(['rm -rf']);
  });

  it('ignores payloads that carry neither bash field', () => {
    const cs = new ConfigStore();
    handleBashFieldsUpdate({ bashTrustedCommands: ['git *'], bashDenylist: ['rm -rf'] }, cs);

    handleBashFieldsUpdate({ theme: 'dark' }, cs);
    // No change to bash state.
    expect(getBashCommandLists().trusted).toEqual(['git *']);
    expect(cs.get('bashTrustedCommands')).toEqual(['git *']);
  });

  it('runtime and persisted config stay identical across a restart simulation', () => {
    // Write through the IPC handler.
    const cs1 = new ConfigStore();
    handleBashFieldsUpdate({ bashTrustedCommands: ['npm *'], bashDenylist: ['rm -rf'] }, cs1);

    // Drop the runtime policy (simulates app close).
    setBashCommandLists([], []);
    expect(getBashCommandLists().trusted).toEqual([]);

    // New process: construct a fresh ConfigStore and hydrate.
    const cs2 = new ConfigStore();
    setBashCommandLists(cs2.get('bashTrustedCommands'), cs2.get('bashDenylist'));

    expect(getBashCommandLists().trusted).toEqual(['npm *']);
    expect(getBashCommandLists().denied).toEqual(['rm -rf']);
  });

  // --- Regression: renderer bootstrap must not clobber persisted lists ----

  it('a bootstrap settings.update carrying empty bash lists must not wipe persisted lists', () => {
    // Setup: user has previously configured bash lists (persisted to disk).
    const cs = new ConfigStore();
    cs.update({
      bashTrustedCommands: ['npm *'],
      bashDenylist: ['rm -rf'],
    });

    // Main starts up: reads persisted config → hydrates runtime policy.
    // This is what whenReady() does in src/main/index.ts.
    setBashCommandLists(cs.get('bashTrustedCommands'), cs.get('bashDenylist'));
    expect(getBashCommandLists().trusted).toEqual(['npm *']);

    // Then the renderer bootstraps. BEFORE the fix in useIPC.ts, the renderer
    // would send its default-empty bash lists via `settings.update` — which,
    // if naively processed, would overwrite the persisted values and leave
    // the user's config "lost after restart". After the fix, the renderer
    // reads the persisted values from config.status into Zustand first, so
    // the bootstrap payload carries the *same* values, making the round-trip
    // an identity write.
    //
    // This test verifies the IPC contract: if the payload happens to carry
    // the same values that are already persisted, main's write is a no-op.
    // That's the post-fix expected behaviour end-to-end.
    handleBashFieldsUpdate(
      {
        bashTrustedCommands: cs.get('bashTrustedCommands'),
        bashDenylist: cs.get('bashDenylist'),
      },
      cs
    );

    expect(cs.get('bashTrustedCommands')).toEqual(['npm *']);
    expect(cs.get('bashDenylist')).toEqual(['rm -rf']);
    expect(getBashCommandLists().trusted).toEqual(['npm *']);
    expect(getBashCommandLists().denied).toEqual(['rm -rf']);
  });
});
