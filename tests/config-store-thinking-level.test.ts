import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store-thinking.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
        ...mocks.seed,
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

describe('ConfigStore thinkingLevel migration and normalization', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('fresh install defaults to enableThinking false, thinkingLevel off', () => {
    const store = new ConfigStore();
    const config = store.getAll();
    expect(config.enableThinking).toBe(false);
    expect(config.thinkingLevel).toBe('off');
    expect(config.configSets[0].enableThinking).toBe(false);
    expect(config.configSets[0].thinkingLevel).toBe('off');
  });

  it('migrates legacy enableThinking:true to thinkingLevel:medium', () => {
    mocks.seed = { enableThinking: true };
    const store = new ConfigStore();
    const config = store.getAll();
    expect(config.enableThinking).toBe(true);
    expect(config.thinkingLevel).toBe('medium');
    expect(config.configSets[0].enableThinking).toBe(true);
    expect(config.configSets[0].thinkingLevel).toBe('medium');
  });

  it('migrates legacy enableThinking:false to thinkingLevel:off', () => {
    mocks.seed = { enableThinking: false };
    const store = new ConfigStore();
    const config = store.getAll();
    expect(config.enableThinking).toBe(false);
    expect(config.thinkingLevel).toBe('off');
  });

  it('new thinkingLevel field wins over legacy enableThinking boolean', () => {
    mocks.seed = { enableThinking: true, thinkingLevel: 'high' };
    const store = new ConfigStore();
    const config = store.getAll();
    expect(config.thinkingLevel).toBe('high');
    expect(config.enableThinking).toBe(true);
  });

  it('enableThinking:true overrides thinkingLevel:off (legacy migration)', () => {
    // When thinkingLevel is 'off' but enableThinking is explicitly true,
    // that's legacy/default bleedthrough — the boolean intent wins.
    mocks.seed = { enableThinking: true, thinkingLevel: 'off' };
    const store = new ConfigStore();
    const config = store.getAll();
    expect(config.thinkingLevel).toBe('medium');
    expect(config.enableThinking).toBe(true);
  });

  it('thinkingLevel:off with enableThinking:false stays off', () => {
    // User explicitly disabled thinking — both fields agree, should stay off.
    mocks.seed = { enableThinking: false, thinkingLevel: 'off' };
    const store = new ConfigStore();
    const config = store.getAll();
    expect(config.thinkingLevel).toBe('off');
    expect(config.enableThinking).toBe(false);
  });

  it('invalid thinkingLevel string falls back to enableThinking migration', () => {
    mocks.seed = { enableThinking: true, thinkingLevel: 'not-valid' };
    const store = new ConfigStore();
    const config = store.getAll();
    // invalid level → falls back to enableThinking:true → 'medium'
    expect(config.thinkingLevel).toBe('medium');
    expect(config.enableThinking).toBe(true);
  });

  it('config set inherits thinkingLevel from legacy when no configSets', () => {
    mocks.seed = { enableThinking: true };
    const store = new ConfigStore();
    const set = store.getAll().configSets[0];
    expect(set.thinkingLevel).toBe('medium');
    expect(set.enableThinking).toBe(true);
  });

  it('update via thinkingLevel sets enableThinking derived correctly', () => {
    const store = new ConfigStore();
    store.update({ thinkingLevel: 'high' });
    const config = store.getAll();
    expect(config.thinkingLevel).toBe('high');
    expect(config.enableThinking).toBe(true);
  });

  it('update via thinkingLevel:off sets enableThinking false', () => {
    mocks.seed = { enableThinking: true, thinkingLevel: 'medium' };
    const store = new ConfigStore();
    store.update({ thinkingLevel: 'off' });
    const config = store.getAll();
    expect(config.thinkingLevel).toBe('off');
    expect(config.enableThinking).toBe(false);
  });

  it('update via legacy enableThinking:true derives thinkingLevel:medium', () => {
    const store = new ConfigStore();
    store.update({ enableThinking: true });
    const config = store.getAll();
    expect(config.thinkingLevel).toBe('medium');
    expect(config.enableThinking).toBe(true);
  });

  it('thinkingLevel is always a valid string, never undefined, after normalization', () => {
    // Seed with missing thinkingLevel and missing enableThinking
    mocks.seed = { provider: 'anthropic' };
    const store = new ConfigStore();
    const config = store.getAll();
    expect(typeof config.thinkingLevel).toBe('string');
    expect(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).toContain(
      config.thinkingLevel
    );
    for (const set of config.configSets) {
      expect(typeof set.thinkingLevel).toBe('string');
      expect(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).toContain(
        set.thinkingLevel
      );
    }
  });

  it('config set with missing thinking fields gets off defaults', () => {
    // Seed with a configSets array where enableThinking and thinkingLevel are absent
    mocks.seed = {
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: {},
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      activeConfigSetId: 'default',
    };
    const store = new ConfigStore();
    const set = store.getAll().configSets[0];
    expect(set.thinkingLevel).toBe('off');
    expect(set.enableThinking).toBe(false);
  });

  it('invalid thinkingLevel in configSet falls back to enableThinking migration', () => {
    mocks.seed = {
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: {},
          enableThinking: true,
          thinkingLevel: 'not-a-valid-level',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      activeConfigSetId: 'default',
    };
    const store = new ConfigStore();
    const set = store.getAll().configSets[0];
    // invalid thinkingLevel ignored; falls back to enableThinking:true => 'medium'
    expect(set.thinkingLevel).toBe('medium');
    expect(set.enableThinking).toBe(true);
  });

  it('invalid thinkingLevel with no enableThinking falls back to fallback default', () => {
    mocks.seed = {
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: {},
          thinkingLevel: 'future-unknown-level',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      activeConfigSetId: 'default',
    };
    const store = new ConfigStore();
    const set = store.getAll().configSets[0];
    // invalid level + no enableThinking => falls back to 'off' default
    expect(set.thinkingLevel).toBe('off');
    expect(set.enableThinking).toBe(false);
  });
});
