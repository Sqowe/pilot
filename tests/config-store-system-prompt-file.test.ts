import { describe, expect, it, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import { DEFAULT_SYSTEM_PROMPT_PRIORITY } from '../src/shared/system-prompt-file-choices';

// vi.hoisted runs before vi.mock factories, making the value available in both
// the factory and the test body without TDZ issues.
// Use process.env instead of require('os')/require('path') to stay
// ESLint-clean (no-var-requires) while computing the path before imports.
const { MOCK_STORE_PATH, seed } = vi.hoisted(() => {
  const tmpdir = process.env.TMPDIR ?? process.env.TEMP ?? '/tmp';
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    MOCK_STORE_PATH: `${tmpdir}/mock-config-store-spf-${process.pid}-${rand}.json`,
    // Mutable holder for the DECRYPTED persisted config a test wants the store
    // to start from. This models electron-store: the on-disk file is encrypted,
    // and the store exposes the decrypted values in memory. Tests seed values
    // here — never by relying on the mock parsing the on-disk file — so this
    // faithfully guards that production reads the decrypted store, not the file.
    seed: { value: null as Record<string, unknown> | null },
  };
});

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = MOCK_STORE_PATH;

    constructor(options: { defaults?: Record<string, unknown> }) {
      // defaults overlaid with the seeded persisted (decrypted) values.
      this.store = { ...(options?.defaults || {}), ...(seed.value || {}) };
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

    clear(): void {
      this.store = {};
    }
  }

  return { default: MockStore };
});

import { ConfigStore } from '../src/main/config/config-store';

// Clean up the mock store file + seed after each test so the next starts fresh.
afterEach(() => {
  seed.value = null;
  try {
    fs.rmSync(MOCK_STORE_PATH, { force: true });
  } catch {
    // Best-effort cleanup — don't fail the test on Windows EPERM/EBUSY.
  }
});

describe('ConfigStore systemPromptFile (legacy field, kept for migration read)', () => {
  it('defaults to empty string (legacy field preserved for migration window)', () => {
    const store = new ConfigStore();
    expect(store.get('systemPromptFile')).toBe('');
  });

  it('persists a whitelisted legacy choice through update()', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: 'CLAUDE.md' });
    expect(store.get('systemPromptFile')).toBe('CLAUDE.md');
    store.update({ systemPromptFile: '.cowork/instructions.md' });
    expect(store.get('systemPromptFile')).toBe('.cowork/instructions.md');
  });

  it('normalizes unknown legacy values back to empty string', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: 'README.md' as unknown as '' });
    expect(store.get('systemPromptFile')).toBe('');
  });

  it('normalizes non-string legacy values back to empty string', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: 42 as unknown as '' });
    expect(store.get('systemPromptFile')).toBe('');
  });

  it('round-trips legacy field through getAll()', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: 'AGENTS.md' });
    expect(store.getAll().systemPromptFile).toBe('AGENTS.md');
  });
});

describe('ConfigStore systemPromptFileEnabled / systemPromptFilePriority (new fields)', () => {
  it('defaults: enabled=true, priority=DEFAULT_SYSTEM_PROMPT_PRIORITY', () => {
    const store = new ConfigStore();
    expect(store.get('systemPromptFileEnabled')).toBe(true);
    expect(store.get('systemPromptFilePriority')).toEqual([...DEFAULT_SYSTEM_PROMPT_PRIORITY]);
  });

  it('persists enabled toggle through update()', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFileEnabled: false });
    expect(store.get('systemPromptFileEnabled')).toBe(false);
    store.update({ systemPromptFileEnabled: true });
    expect(store.get('systemPromptFileEnabled')).toBe(true);
  });

  it('persists a reordered priority list through update()', () => {
    const store = new ConfigStore();
    const reordered = [
      'AGENTS.md',
      'CLAUDE.md',
      '.cowork/instructions.md',
      'memory.md',
      'instructions.md',
    ] as const;
    store.update({ systemPromptFilePriority: [...reordered] });
    expect(store.get('systemPromptFilePriority')).toEqual([...reordered]);
  });

  it('normalizes an invalid priority list (unknown entry dropped, missing backfilled)', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFilePriority: ['CLAUDE.md', 'UNKNOWN.md'] as unknown as [] });
    const result = store.get('systemPromptFilePriority');
    expect(result).not.toContain('UNKNOWN.md');
    expect(result).toHaveLength(DEFAULT_SYSTEM_PROMPT_PRIORITY.length);
    expect(result[0]).toBe('CLAUDE.md');
  });

  it('round-trips both new fields through getAll()', () => {
    const store = new ConfigStore();
    store.update({
      systemPromptFileEnabled: false,
      systemPromptFilePriority: [
        'memory.md',
        'CLAUDE.md',
        'AGENTS.md',
        '.cowork/instructions.md',
        'instructions.md',
      ],
    });
    const all = store.getAll();
    expect(all.systemPromptFileEnabled).toBe(false);
    expect(all.systemPromptFilePriority[0]).toBe('memory.md');
  });

  it('get() and getAll() return the same values for new fields (no DIRECT_READ_KEYS divergence)', () => {
    const store = new ConfigStore();
    store.update({
      systemPromptFileEnabled: false,
      systemPromptFilePriority: [
        'AGENTS.md',
        'CLAUDE.md',
        '.cowork/instructions.md',
        'memory.md',
        'instructions.md',
      ],
    });
    expect(store.get('systemPromptFileEnabled')).toBe(store.getAll().systemPromptFileEnabled);
    expect(store.get('systemPromptFilePriority')).toEqual(store.getAll().systemPromptFilePriority);
  });
});

describe('ConfigStore migration: legacy systemPromptFile → new fields', () => {
  /**
   * Helper: simulate a "pre-existing" install. `raw` is the DECRYPTED persisted
   * config as electron-store would hold it in memory — it is seeded into the
   * store, NOT parsed from the on-disk file. We also create the on-disk file so
   * ensureNormalized()'s fresh-vs-existing check (fs.existsSync) sees an
   * existing install. The file *contents* are intentionally irrelevant:
   * production reads the decrypted store, never the encrypted file.
   */
  function storeWithPersistedRaw(raw: Record<string, unknown>) {
    seed.value = raw;
    fs.writeFileSync(MOCK_STORE_PATH, JSON.stringify(raw));
    return new ConfigStore();
  }

  it('reads the decrypted store, never JSON-parses the encrypted config file (regression)', () => {
    // Production regression guard: the on-disk file is AES-encrypted bytes (not
    // JSON), while the decrypted in-memory store holds the real values. A legacy
    // systemPromptFile of "CLAUDE.md" must still migrate to enabled=true. This
    // only works if ensureNormalized reads this.store.get(...) — the previous
    // implementation JSON-parsed the file, which throws on encrypted data and
    // silently disabled the feature on every launch.
    seed.value = { systemPromptFile: 'CLAUDE.md' };
    fs.writeFileSync(MOCK_STORE_PATH, 'not-valid-json:\x00\x89encrypted-bytes');
    const store = new ConfigStore();
    expect(store.getAll().systemPromptFileEnabled).toBe(true);
    expect(store.getAll().systemPromptFilePriority[0]).toBe('CLAUDE.md');
  });

  it('fresh install (no legacy key) → enabled=true, default priority order', () => {
    // No file on disk (afterEach cleans up) → ensureNormalized stamps
    // configSchemaVersion=1 → D4 defaults (enabled=true).
    const store = new ConfigStore();
    expect(store.getAll().systemPromptFileEnabled).toBe(true);
    expect(store.getAll().systemPromptFilePriority).toEqual([...DEFAULT_SYSTEM_PROMPT_PRIORITY]);
    // get() must agree with getAll() — new fields are not in DIRECT_READ_KEYS
    expect(store.get('systemPromptFileEnabled')).toBe(true);
    expect(store.get('systemPromptFilePriority')).toEqual([...DEFAULT_SYSTEM_PROMPT_PRIORITY]);
  });

  it('existing install (schemaVersion=0, no legacy key) → enabled=false, preserves legacy default', () => {
    // File exists on disk (storeWithPersistedRaw creates it) but has no systemPromptFile
    // key and no configSchemaVersion → treated as pre-migration existing install.
    const store = storeWithPersistedRaw({});
    expect(store.getAll().systemPromptFileEnabled).toBe(false);
    expect(store.getAll().systemPromptFilePriority).toEqual([...DEFAULT_SYSTEM_PROMPT_PRIORITY]);
    expect(store.get('systemPromptFileEnabled')).toBe(false);
  });

  it('legacy="" explicitly persisted (user had None) → enabled=false, default priority order', () => {
    const store = storeWithPersistedRaw({ systemPromptFile: '' });
    expect(store.getAll().systemPromptFileEnabled).toBe(false);
    expect(store.getAll().systemPromptFilePriority).toEqual([...DEFAULT_SYSTEM_PROMPT_PRIORITY]);
    expect(store.get('systemPromptFileEnabled')).toBe(false);
  });

  it('existing install with configSchemaVersion=1 and no systemPromptFile → enabled=true (D4)', () => {
    // Config file exists on disk with version=1 already written (post-migration).
    const store = storeWithPersistedRaw({ configSchemaVersion: 1 });
    expect(store.getAll().systemPromptFileEnabled).toBe(true);
    expect(store.get('systemPromptFileEnabled')).toBe(true);
  });

  it('legacy="CLAUDE.md" → enabled=true, CLAUDE.md hoisted to position 0', () => {
    const store = storeWithPersistedRaw({ systemPromptFile: 'CLAUDE.md' });
    expect(store.getAll().systemPromptFileEnabled).toBe(true);
    expect(store.getAll().systemPromptFilePriority[0]).toBe('CLAUDE.md');
    expect(store.getAll().systemPromptFilePriority).toHaveLength(
      DEFAULT_SYSTEM_PROMPT_PRIORITY.length
    );
  });

  it('legacy="AGENTS.md" → enabled=true, AGENTS.md hoisted to position 0', () => {
    const store = storeWithPersistedRaw({ systemPromptFile: 'AGENTS.md' });
    expect(store.getAll().systemPromptFileEnabled).toBe(true);
    expect(store.getAll().systemPromptFilePriority[0]).toBe('AGENTS.md');
  });

  it('new keys present → passthrough, legacy field ignored for new fields', () => {
    const store = storeWithPersistedRaw({
      configSchemaVersion: 1,
      systemPromptFile: 'AGENTS.md',
      systemPromptFileEnabled: false,
      systemPromptFilePriority: [
        'memory.md',
        'CLAUDE.md',
        'AGENTS.md',
        '.cowork/instructions.md',
        'instructions.md',
      ],
    });
    expect(store.getAll().systemPromptFileEnabled).toBe(false);
    expect(store.getAll().systemPromptFilePriority[0]).toBe('memory.md');
  });

  it('only systemPromptFileEnabled present → treats as hasNew=true, normalises priority', () => {
    const store = storeWithPersistedRaw({ systemPromptFileEnabled: false });
    expect(store.getAll().systemPromptFileEnabled).toBe(false);
    // No priority array given → normaliseSystemPromptPriority([undefined]) → full default
    expect(store.getAll().systemPromptFilePriority).toEqual([...DEFAULT_SYSTEM_PROMPT_PRIORITY]);
  });
});

describe('ConfigStore update(): legacy systemPromptFile write syncs new fields', () => {
  it('update({systemPromptFile: "CLAUDE.md"}) → enabled=true, CLAUDE.md hoisted', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: 'CLAUDE.md' });
    expect(store.getAll().systemPromptFileEnabled).toBe(true);
    expect(store.getAll().systemPromptFilePriority[0]).toBe('CLAUDE.md');
  });

  it('update({systemPromptFile: ""}) → enabled=false, priority unchanged', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFile: '' });
    expect(store.getAll().systemPromptFileEnabled).toBe(false);
  });

  it('update with both legacy and new fields → new fields take precedence', () => {
    const store = new ConfigStore();
    store.update({
      systemPromptFile: 'CLAUDE.md',
      systemPromptFileEnabled: false,
      systemPromptFilePriority: [
        'memory.md',
        'CLAUDE.md',
        'AGENTS.md',
        '.cowork/instructions.md',
        'instructions.md',
      ],
    });
    // New fields win
    expect(store.getAll().systemPromptFileEnabled).toBe(false);
    expect(store.getAll().systemPromptFilePriority[0]).toBe('memory.md');
  });

  it('update({systemPromptFileEnabled: false}) alone does not change priority', () => {
    const store = new ConfigStore();
    store.update({ systemPromptFileEnabled: false });
    expect(store.getAll().systemPromptFileEnabled).toBe(false);
    expect(store.getAll().systemPromptFilePriority).toEqual([...DEFAULT_SYSTEM_PROMPT_PRIORITY]);
  });

  it('update({systemPromptFile: invalid value}) does NOT change enabled or priority', () => {
    const store = new ConfigStore();
    const before = store.getAll();
    // Cast through unknown to bypass compile-time union check — simulates a
    // bad value arriving via IPC or a legacy caller.
    store.update({ systemPromptFile: 'README.md' as unknown as '' });
    // Invalid value: enabled and priority must stay unchanged (not toggled)
    expect(store.getAll().systemPromptFileEnabled).toBe(before.systemPromptFileEnabled);
    // Priority must be unchanged (not hoisted to README.md)
    expect(store.getAll().systemPromptFilePriority).toEqual(before.systemPromptFilePriority);
    // Legacy field itself normalizes to ''
    expect(store.getAll().systemPromptFile).toBe('');
  });
});
