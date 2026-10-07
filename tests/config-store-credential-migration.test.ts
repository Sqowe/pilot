/**
 * Phase 3 of docs/design/archive/provider-credentials-and-model-sets.md — the store half.
 *
 * Phase 3 removes the pre-split fields (`profiles`, `activeProfileKey`, and a
 * set's `customProtocol`) from the config shape. That turns the migration from
 * "derive on every read" into a **one-time** step, and these tests pin what
 * makes it one-time and safe:
 *
 * - the migrated shape carries no pre-split field, in memory or on disk;
 * - the leftover top-level keys are deleted from the file, not merely ignored;
 * - a migrated config is never migrated again, across reads and restarts;
 * - the credentials a migration could not carry over are recorded (§9.3);
 * - a credential can be saved without touching a config set, and a set without
 *   touching a credential (§6.4).
 *
 * Derivation rules live in `config-store-provider-credentials.test.ts`;
 * resolution in `config-store-credential-resolution.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
  /** The most recently constructed store, so tests can inspect what is on "disk". */
  last: null as { store: Record<string, unknown> } | null,
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
        ...mocks.seed,
      };
      mocks.last = this;
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    // Like conf: assigns the keys it is given and never removes one.
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

    delete(key: string): void {
      delete this.store[key];
    }

    clear(): void {
      this.store = {};
    }
  }

  return {
    default: MockStore,
  };
});

import { ConfigStore } from '../src/main/config/config-store';

/** What the store has persisted — the mock's backing object. */
function persisted(): Record<string, unknown> {
  return mocks.last!.store;
}

/** Start a second store over what the first one persisted: an app restart. */
function restart(): ConfigStore {
  mocks.seed = JSON.parse(JSON.stringify(persisted()));
  return new ConfigStore();
}

/** A config exactly as app 1.0.8 wrote it: profiles on the sets and mirrored on top. */
function release108Config(): Record<string, unknown> {
  const workProfiles = {
    anthropic: {
      apiKey: 'sk-ant-work',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-5',
    },
    openai: { apiKey: 'sk-oai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
  };
  return {
    provider: 'anthropic',
    customProtocol: 'anthropic',
    apiKey: 'sk-ant-work',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    activeProfileKey: 'anthropic',
    profiles: workProfiles,
    activeConfigSetId: 'set-2',
    configSchemaVersion: 2,
    configSets: [
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'openai',
        activeProfileKey: 'custom:openai',
        enableThinking: false,
        thinkingLevel: 'off',
        updatedAt: '2026-09-01T00:00:00.000Z',
        profiles: {
          'custom:openai': {
            apiKey: 'gw-key',
            baseUrl: 'http://127.0.0.1:9000/v1',
            model: 'local-model',
            contextWindow: 64000,
            maxTokens: 4096,
          },
        },
      },
      {
        id: 'set-2',
        name: 'Work',
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        enableThinking: true,
        thinkingLevel: 'high',
        updatedAt: '2026-09-02T00:00:00.000Z',
        profiles: workProfiles,
      },
    ],
  };
}

const PRE_SPLIT_FIELDS = ['profiles', 'activeProfileKey'];

describe('migrating a config written before the split', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  it('carries a 1.0.8 config over with the same effective runtime', () => {
    mocks.seed = release108Config();
    const store = new ConfigStore();
    const config = store.getAll();

    // The active set runs exactly as before.
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('sk-ant-work');
    expect(config.baseUrl).toBe('https://api.anthropic.com');
    expect(config.model).toBe('claude-opus-5');
    expect(config.thinkingLevel).toBe('high');

    // And so does the other one, once selected.
    const custom = store.switchSet({ id: 'default' });
    expect(custom.provider).toBe('custom');
    expect(custom.customProtocol).toBe('openai');
    expect(custom.apiKey).toBe('gw-key');
    expect(custom.baseUrl).toBe('http://127.0.0.1:9000/v1');
    expect(custom.model).toBe('local-model');
    expect(custom.contextWindow).toBe(64000);
    expect(custom.maxTokens).toBe(4096);
  });

  it('keeps every set id, name, order and timestamp (design §5.1 rule 5)', () => {
    // `sessions.config_set_id` and `scheduled_tasks.config_set_id` point at these
    // ids from SQLite, which this migration does not touch.
    mocks.seed = release108Config();
    const config = new ConfigStore().getAll();

    expect(config.activeConfigSetId).toBe('set-2');
    expect(config.configSets.map((set) => [set.id, set.name, set.updatedAt])).toEqual([
      ['default', 'Default', '2026-09-01T00:00:00.000Z'],
      ['set-2', 'Work', '2026-09-02T00:00:00.000Z'],
    ]);
  });

  it('produces sets that select a provider and a model and hold no credential', () => {
    mocks.seed = release108Config();
    const config = new ConfigStore().getAll();

    for (const set of config.configSets) {
      for (const field of [...PRE_SPLIT_FIELDS, 'customProtocol']) {
        expect(set, `set ${set.id}`).not.toHaveProperty(field);
      }
    }
    expect(JSON.stringify(config.configSets)).not.toMatch(/sk-ant-work|sk-oai|gw-key/);
    expect(config).not.toHaveProperty('profiles');
    expect(config).not.toHaveProperty('activeProfileKey');

    // The credentials moved to exactly one place each.
    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-ant-work');
    expect(config.providerCredentials.openai?.apiKey).toBe('sk-oai');
    expect(config.customEndpoints).toHaveLength(1);
    expect(config.customEndpoints[0]).toMatchObject({
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:9000/v1',
      apiKey: 'gw-key',
    });
    expect(config.configSets[0].endpointId).toBe(config.customEndpoints[0].id);
    expect(config.endpointId).toBeUndefined(); // the active set is not custom
  });

  it('deletes the pre-split keys from the file, not just from the result', () => {
    // conf's `set(object)` assigns the keys it is given and removes none, so
    // without an explicit delete the top-level `profiles` map would stay in the
    // file for good: a frozen copy of every API key that outlives a rotation or
    // a clear.
    mocks.seed = release108Config();
    new ConfigStore();

    for (const field of PRE_SPLIT_FIELDS) {
      expect(persisted(), `top-level ${field}`).not.toHaveProperty(field);
    }
    for (const set of persisted().configSets as Array<Record<string, unknown>>) {
      for (const field of [...PRE_SPLIT_FIELDS, 'customProtocol']) {
        expect(set, `set ${String(set.id)}`).not.toHaveProperty(field);
      }
    }
  });

  it('leaves no copy of a key behind after it is rotated', () => {
    mocks.seed = release108Config();
    const store = new ConfigStore();

    store.update({ apiKey: 'sk-ant-rotated' });

    const onDisk = JSON.stringify(persisted());
    expect(onDisk).toContain('sk-ant-rotated');
    expect(onDisk).not.toContain('sk-ant-work');
  });

  it('is stable across a restart', () => {
    mocks.seed = release108Config();
    const first = new ConfigStore().getAll();

    expect(restart().getAll()).toEqual(first);
  });
});

describe('a migrated config is never migrated again', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  /**
   * A pre-config-sets config: the real data is in the flat fields, and the one
   * set present is the untouched default. This is the shape the migration
   * rebuilds the default set *from the flat fields* for — which is exactly what
   * must never happen to a current config.
   */
  const flatOnly = {
    provider: 'openai',
    customProtocol: 'openai',
    apiKey: 'sk-flat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
    activeProfileKey: 'openai',
    profiles: {
      openai: { apiKey: 'sk-flat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
    },
  };

  it('keeps a model change on a single-set install across a restart', () => {
    // The hazard behind the explicit delete. If the frozen top-level `profiles`
    // stayed in the file, the next start would see a pre-split key, re-run the
    // migration, find that the lone default set disagrees with those frozen
    // fields, and rebuild the set from them — undoing the change.
    mocks.seed = flatOnly;
    const store = new ConfigStore();

    store.update({ model: 'gpt-5.4-mini', contextWindow: 128000 });
    store.renameSet({ id: 'default', name: 'Main' });

    const afterRestart = restart().getAll();
    expect(afterRestart.model).toBe('gpt-5.4-mini');
    expect(afterRestart.contextWindow).toBe(128000);
    expect(afterRestart.configSets[0].name).toBe('Main');
    expect(afterRestart.apiKey).toBe('sk-flat');
  });

  it('keeps a key rotation on a single-set install across a restart', () => {
    mocks.seed = flatOnly;
    const store = new ConfigStore();

    store.update({ apiKey: 'sk-rotated', model: 'gpt-5.4-mini' });

    const afterRestart = restart().getAll();
    expect(afterRestart.apiKey).toBe('sk-rotated');
    expect(afterRestart.model).toBe('gpt-5.4-mini');
  });

  it('does not run the migration for a current config, on read or on restart', () => {
    mocks.seed = release108Config();
    const store = new ConfigStore();
    const spy = vi.spyOn(
      store as unknown as { migrateLegacyCredentialShape: () => unknown },
      'migrateLegacyCredentialShape'
    );

    store.getAll();
    store.update({ model: 'claude-sonnet-5' });
    store.createSet({ name: 'Third', mode: 'blank' });
    store.switchSet({ id: 'default' });
    expect(spy).not.toHaveBeenCalled();

    const restarted = restart();
    const restartedSpy = vi.spyOn(
      restarted as unknown as { migrateLegacyCredentialShape: () => unknown },
      'migrateLegacyCredentialShape'
    );
    restarted.getAll();
    expect(restartedSpy).not.toHaveBeenCalled();
  });

  it('does not run the migration for a fresh install', () => {
    const store = new ConfigStore();
    const spy = vi.spyOn(
      store as unknown as { migrateLegacyCredentialShape: () => unknown },
      'migrateLegacyCredentialShape'
    );

    store.getAll();
    store.update({ provider: 'ollama', model: 'qwen3.5' });
    store.update({ thinkingLevel: 'high' });
    store.getAll();

    expect(spy).not.toHaveBeenCalled();
    expect(store.getAll().provider).toBe('ollama');
    expect(store.getAll().thinkingLevel).toBe('high');
  });

  it('still migrates a flat-only config that never had profiles at all', () => {
    // Older than `profiles`: nothing but flat fields. There is no pre-split key
    // to detect it by, only the fact that the flat fields hold a credential the
    // credential store does not.
    mocks.seed = {
      provider: 'anthropic',
      apiKey: 'sk-ancient',
      model: 'claude-opus-5',
      enableThinking: true,
    };
    const config = new ConfigStore().getAll();

    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('sk-ancient');
    expect(config.model).toBe('claude-opus-5');
    expect(config.thinkingLevel).toBe('medium');
    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-ancient');
    expect(restart().getAll()).toEqual(config);
  });

  it('still migrates a flat-only config that differs from the defaults only by its key', () => {
    // The default provider on its default model: nothing but the key says this
    // is a real config and not the placeholder the store fills in. Missing it
    // would drop the key on the first start after upgrading.
    mocks.seed = { apiKey: 'sk-or-only-the-key' };
    const config = new ConfigStore().getAll();

    expect(config.provider).toBe('openrouter');
    expect(config.apiKey).toBe('sk-or-only-the-key');
    expect(config.providerCredentials.openrouter?.apiKey).toBe('sk-or-only-the-key');
    expect(restart().getAll()).toEqual(config);
  });

  it('still migrates a keyless flat-only config', () => {
    // Ollama needs no key, so "the flat fields hold a credential" cannot be the
    // only signal: the provider the flat fields name is one the lone default set
    // does not have.
    mocks.seed = { provider: 'ollama', baseUrl: 'http://192.168.1.50:11434/v1', model: 'qwen3.5' };
    const config = new ConfigStore().getAll();

    expect(config.provider).toBe('ollama');
    expect(config.baseUrl).toBe('http://192.168.1.50:11434/v1');
    expect(config.model).toBe('qwen3.5');
    expect(config.providerCredentials.ollama?.baseUrl).toBe('http://192.168.1.50:11434/v1');
    expect(restart().getAll()).toEqual(config);
  });
});

describe('credentials the migration could not carry over (design §9.3)', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  function twoSetsWithDifferentKeys(): Record<string, unknown> {
    return {
      activeConfigSetId: 'default',
      configSets: [
        {
          id: 'default',
          name: 'Personal',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'sk-personal', baseUrl: '', model: 'm' } },
        },
        {
          id: 'set-2',
          name: 'Work',
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'sk-work', baseUrl: '', model: 'm' } },
        },
      ],
    };
  }

  it('records which set lost its key when two sets disagreed', () => {
    // Decision #2: one key slot per provider, so one of these two keys cannot
    // survive. The migration is silent by design; this record is what lets the
    // Providers screen say so.
    mocks.seed = twoSetsWithDifferentKeys();
    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-personal');
    expect(config.credentialConflicts).toEqual([{ target: 'anthropic', setIds: ['set-2'] }]);
  });

  it('records ids only, never a key', () => {
    mocks.seed = twoSetsWithDifferentKeys();
    const config = new ConfigStore().getAll();

    expect(JSON.stringify(config.credentialConflicts)).not.toMatch(/sk-/);
    // The dropped key is gone from the file altogether.
    expect(JSON.stringify(persisted())).not.toContain('sk-work');
  });

  it('records nothing when every set agrees', () => {
    const seed = twoSetsWithDifferentKeys();
    const sets = seed.configSets as Array<{ profiles: { anthropic: { apiKey: string } } }>;
    sets[1].profiles.anthropic.apiKey = 'sk-personal';
    mocks.seed = seed;

    expect(new ConfigStore().getAll().credentialConflicts).toEqual([]);
  });

  it('records a dropped key on a shared gateway against the endpoint', () => {
    const gateway = (id: string, name: string, apiKey: string) => ({
      id,
      name,
      isSystem: id === 'default',
      provider: 'custom',
      customProtocol: 'anthropic',
      activeProfileKey: 'custom:anthropic',
      profiles: { 'custom:anthropic': { apiKey, baseUrl: 'http://gw:9000', model: 'm' } },
    });
    mocks.seed = {
      activeConfigSetId: 'default',
      configSets: [gateway('default', 'A', 'key-a'), gateway('set-2', 'B', 'key-b')],
    };
    const config = new ConfigStore().getAll();

    expect(config.customEndpoints).toHaveLength(1);
    expect(config.customEndpoints[0].apiKey).toBe('key-a');
    expect(config.credentialConflicts).toEqual([
      { target: config.customEndpoints[0].id, setIds: ['set-2'] },
    ]);
  });

  it('survives a restart, then clears once the user saves that credential again', () => {
    mocks.seed = twoSetsWithDifferentKeys();
    new ConfigStore();
    const restarted = restart();
    expect(restarted.getAll().credentialConflicts).toHaveLength(1);

    // Saving the key is the user choosing it deliberately — the notice is done.
    restarted.setProviderCredential({ provider: 'anthropic', apiKey: 'sk-chosen' });
    expect(restarted.getAll().credentialConflicts).toEqual([]);
  });

  it('clears when the key is saved through the active set', () => {
    mocks.seed = twoSetsWithDifferentKeys();
    const store = new ConfigStore();

    store.update({ apiKey: 'sk-chosen' });

    expect(store.getAll().credentialConflicts).toEqual([]);
  });

  it('keeps the record when an unrelated credential is saved', () => {
    mocks.seed = twoSetsWithDifferentKeys();
    const store = new ConfigStore();

    store.setProviderCredential({ provider: 'openai', apiKey: 'sk-oai' });
    store.setProviderCredential({ provider: 'anthropic', baseUrl: 'https://proxy.example' });

    expect(store.getAll().credentialConflicts).toEqual([
      { target: 'anthropic', setIds: ['set-2'] },
    ]);
  });

  it('drops the record once the set that lost its key is deleted', () => {
    // Nothing is left for the notice to explain.
    mocks.seed = twoSetsWithDifferentKeys();
    const store = new ConfigStore();

    store.deleteSet({ id: 'set-2' });

    expect(store.getAll().credentialConflicts).toEqual([]);
  });

  it('rejects a malformed or dangling record on read', () => {
    mocks.seed = {
      credentialConflicts: [
        { target: 'anthropic', setIds: ['default', 'gone', 7] },
        { target: 'custom-endpoint-9', setIds: ['default'] }, // no such endpoint
        { target: 'custom:anthropic', setIds: ['default'] }, // not a catalog slot
        { target: '', setIds: ['default'] },
        'nonsense',
        null,
      ],
    };

    expect(new ConfigStore().getAll().credentialConflicts).toEqual([
      { target: 'anthropic', setIds: ['default'] },
    ]);
  });
});

describe('saving a credential without touching a config set (design §6.4)', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  it('writes the provider slot and leaves every set exactly as it was', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    const before = store.getAll();

    const after = store.setProviderCredential({ provider: 'openai', apiKey: 'sk-oai' });

    expect(after.providerCredentials.openai).toEqual({ apiKey: 'sk-oai' });
    // Not the provider, not the model, not even the timestamp.
    expect(after.configSets).toEqual(before.configSets);
    expect(after.provider).toBe('anthropic');
    expect(after.apiKey).toBe('sk-ant');
    expect(after.model).toBe('claude-opus-5');
  });

  it('reaches the running projection when the active set uses that provider', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-old', model: 'claude-opus-5' });

    const after = store.setProviderCredential({ provider: 'anthropic', apiKey: 'sk-new' });

    expect(after.apiKey).toBe('sk-new');
  });

  it('writes the new key to the stored projection that lightweight reads use', () => {
    // `get('apiKey')` reads the stored flat field directly, without normalizing,
    // so a credential write that left the stored projection behind would hand a
    // session the old key even though `getAll()` shows the new one.
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-old', model: 'claude-opus-5' });

    store.setProviderCredential({
      provider: 'anthropic',
      apiKey: 'sk-new',
      baseUrl: 'https://proxy.example',
    });

    expect(store.get('apiKey')).toBe('sk-new');
    expect(store.get('baseUrl')).toBe('https://proxy.example');
    expect(persisted().apiKey).toBe('sk-new');
    expect(persisted().baseUrl).toBe('https://proxy.example');
  });

  it('writes an endpoint change to the stored projection as well', () => {
    const store = new ConfigStore();
    store.update({
      provider: 'custom',
      customProtocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
      apiKey: 'gw-old',
      model: 'm',
    });
    const endpointId = store.getAll().customEndpoints[0].id;

    store.updateCustomEndpoint({
      id: endpointId,
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:4000/v1',
      apiKey: 'gw-new',
    });

    expect(store.get('apiKey')).toBe('gw-new');
    expect(store.get('baseUrl')).toBe('http://127.0.0.1:4000/v1');
    expect(store.get('customProtocol')).toBe('openai');
    expect(persisted().apiKey).toBe('gw-new');
  });

  it('configures a native provider no set is using yet', () => {
    const store = new ConfigStore();

    const after = store.setProviderCredential({ provider: 'zai', apiKey: 'zai-key' });

    expect(after.providerCredentials['native:zai']).toEqual({ apiKey: 'zai-key' });
    expect(after.provider).toBe('openrouter');
  });

  it('leaves a field that was not sent unchanged', () => {
    const store = new ConfigStore();
    store.setProviderCredential({
      provider: 'ollama',
      apiKey: '',
      baseUrl: 'http://192.168.1.50:11434/v1',
    });

    store.setProviderCredential({ provider: 'ollama', apiKey: 'token' });
    expect(store.getAll().providerCredentials.ollama).toEqual({
      apiKey: 'token',
      baseUrl: 'http://192.168.1.50:11434/v1',
    });

    // An empty base URL removes the override, so the default endpoint applies.
    store.setProviderCredential({ provider: 'ollama', baseUrl: '' });
    expect(store.getAll().providerCredentials.ollama).toEqual({ apiKey: 'token' });
  });

  it('stores an Ollama address in its /v1 form, whichever call writes it', () => {
    // The form shows the normalized address, so storing what was typed would
    // leave the stored value, the projection and the form disagreeing.
    const store = new ConfigStore();

    store.setProviderCredential({ provider: 'ollama', baseUrl: 'http://192.168.1.50:11434/api' });
    expect(store.getAll().providerCredentials.ollama?.baseUrl).toBe('http://192.168.1.50:11434/v1');

    store.update({ provider: 'ollama', baseUrl: 'http://10.0.0.7:11434', model: 'qwen3.5' });
    expect(store.getAll().providerCredentials.ollama?.baseUrl).toBe('http://10.0.0.7:11434/v1');
    expect(store.get('baseUrl')).toBe('http://10.0.0.7:11434/v1');

    // Other providers keep exactly what was sent.
    store.setProviderCredential({
      provider: 'zai',
      apiKey: 'k',
      baseUrl: 'https://proxy.example/api',
    });
    expect(store.getAll().providerCredentials['native:zai']?.baseUrl).toBe(
      'https://proxy.example/api'
    );
  });

  it('keeps a cleared key as an empty slot rather than removing it', () => {
    const store = new ConfigStore();
    store.setProviderCredential({ provider: 'anthropic', apiKey: 'sk-ant' });

    const after = store.setProviderCredential({ provider: 'anthropic', apiKey: '' });

    expect(after.providerCredentials.anthropic).toEqual({ apiKey: '' });
  });

  it('refuses a custom provider, whose credentials are endpoints', () => {
    const store = new ConfigStore();

    expect(() => store.setProviderCredential({ provider: 'custom', apiKey: 'k' })).toThrowError(
      'Custom endpoints are saved through the endpoint API'
    );
    expect(store.getAll().customEndpoints).toEqual([]);
  });

  it('refuses a missing or reserved provider id', () => {
    const store = new ConfigStore();

    for (const provider of ['', '   ', 'local', '__proto__', 'constructor']) {
      expect(
        () => store.setProviderCredential({ provider, apiKey: 'k' }),
        `provider ${JSON.stringify(provider)}`
      ).toThrowError('Provider is required');
    }
    expect(() =>
      store.setProviderCredential(undefined as unknown as { provider: string })
    ).toThrowError('Provider is required');
    expect(store.getAll().providerCredentials).toEqual({});
  });
});

describe('saving a config set without touching a credential (design §6.4)', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  it('changes the model and limits and leaves the credential store alone', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    const before = store.getAll();

    // The Model Sets payload: no apiKey, no baseUrl, no customProtocol.
    store.update({
      activeConfigSetId: 'default',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      contextWindow: 200000,
      maxTokens: 0,
      thinkingLevel: 'high',
      enableThinking: true,
    });
    const after = store.getAll();

    expect(after.model).toBe('claude-sonnet-5');
    expect(after.contextWindow).toBe(200000);
    expect(after.thinkingLevel).toBe('high');
    expect(after.providerCredentials).toEqual(before.providerCredentials);
    expect(after.customEndpoints).toEqual(before.customEndpoints);
    expect(after.apiKey).toBe('sk-ant');
  });

  it('moves a set to another provider without inventing a credential for it', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });

    store.update({ provider: 'openai', model: 'gpt-5.4' });
    const after = store.getAll();

    expect(after.provider).toBe('openai');
    // Unconfigured, and it says so — never the Anthropic key.
    expect(after.apiKey).toBe('');
    expect(after.providerCredentials).toEqual({ anthropic: { apiKey: 'sk-ant' } });
  });
});

describe('pointing a custom set at an endpoint', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  function storeWithTwoEndpoints() {
    const store = new ConfigStore();
    const first = store.createCustomEndpoint({
      name: 'kiro',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
      apiKey: 'kiro-key',
      defaultModel: 'claude-opus-5',
    }).customEndpoints[0];
    const second = store.createCustomEndpoint({
      name: 'litellm',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:4000/v1',
      apiKey: 'lite-key',
    }).customEndpoints[1];
    return { store, first, second };
  }

  it('points the active set at an endpoint by id, changing neither endpoint', () => {
    const { store, first, second } = storeWithTwoEndpoints();
    const endpointsBefore = store.getAll().customEndpoints;

    store.update({ provider: 'custom', endpointId: first.id, model: 'claude-opus-5' });
    let config = store.getAll();
    expect(config.endpointId).toBe(first.id);
    expect(config.customProtocol).toBe('anthropic');
    expect(config.baseUrl).toBe('http://127.0.0.1:9000');
    expect(config.apiKey).toBe('kiro-key');

    store.update({ endpointId: second.id });
    config = store.getAll();
    expect(config.endpointId).toBe(second.id);
    expect(config.customProtocol).toBe('openai');
    expect(config.baseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(config.apiKey).toBe('lite-key');

    expect(config.customEndpoints).toEqual(endpointsBefore);
  });

  it('refuses an endpoint id that does not exist, and stores nothing', () => {
    const { store, first } = storeWithTwoEndpoints();
    store.update({ provider: 'custom', endpointId: first.id });

    expect(() => store.update({ endpointId: 'custom-endpoint-99' })).toThrowError(
      'Custom endpoint not found'
    );
    expect(store.getAll().endpointId).toBe(first.id);
  });

  it('unpins the set with an empty id', () => {
    const { store, first } = storeWithTwoEndpoints();
    store.update({ provider: 'custom', endpointId: first.id });

    store.update({ endpointId: '' });
    const config = store.getAll();

    expect(config.endpointId).toBeUndefined();
    expect(config.configSets[0]).not.toHaveProperty('endpointId');
    expect(config.apiKey).toBe('');
    // Unpinning is not deleting.
    expect(config.customEndpoints).toHaveLength(2);
  });

  it('leaves no stale endpoint id or token limit in the stored projection', () => {
    // conf's `set(object)` never removes a key, so an optional field the active
    // set no longer has would otherwise stay in the file, describing a set that
    // has moved on.
    const { store, first } = storeWithTwoEndpoints();
    store.update({
      provider: 'custom',
      endpointId: first.id,
      model: 'm',
      contextWindow: 200000,
      maxTokens: 8192,
    });
    expect(persisted()).toMatchObject({
      endpointId: first.id,
      contextWindow: 200000,
      maxTokens: 8192,
    });

    store.update({ endpointId: '', contextWindow: 0 });
    expect(persisted()).not.toHaveProperty('endpointId');
    expect(persisted()).not.toHaveProperty('contextWindow');
    expect(persisted().maxTokens).toBe(8192);

    // The same when the change comes from switching to a set that has neither.
    store.update({ endpointId: first.id, contextWindow: 64000 });
    store.createSet({ name: 'Catalog', mode: 'blank' });
    store.update({ provider: 'anthropic', model: 'claude-opus-5' });
    for (const field of ['endpointId', 'contextWindow', 'maxTokens']) {
      expect(persisted(), field).not.toHaveProperty(field);
    }
    store.switchSet({ id: 'default' });
    expect(persisted()).toMatchObject({ endpointId: first.id, contextWindow: 64000 });
  });

  it('drops the pointer when the set moves to a catalog provider, for good', () => {
    // The form names no `endpointId` for a catalog provider. The pointer must
    // go anyway, or it would come back when the set returns to a custom
    // provider and would keep the endpoint from being deleted meanwhile.
    const { store, first } = storeWithTwoEndpoints();
    store.update({ provider: 'custom', endpointId: first.id });

    store.update({ provider: 'anthropic' });
    expect(store.getAll().configSets[0]).not.toHaveProperty('endpointId');
    expect(persisted()).not.toHaveProperty('endpointId');
    expect(() => store.deleteCustomEndpoint({ id: first.id })).not.toThrow();

    store.update({ provider: 'custom' });
    expect(store.getAll().configSets[0]).not.toHaveProperty('endpointId');
    expect(store.getAll().endpointId).toBeUndefined();
  });

  it('ignores an endpoint id on a catalog provider', () => {
    const { store, first } = storeWithTwoEndpoints();

    store.update({ provider: 'anthropic', endpointId: first.id });

    expect(store.getAll().configSets[0]).not.toHaveProperty('endpointId');
    expect(() => store.deleteCustomEndpoint({ id: first.id })).not.toThrow();

    // Ignored outright, so an id that names nothing is not an error either: a
    // catalog provider has no endpoint for it to be wrong about.
    expect(() =>
      store.update({ provider: 'anthropic', endpointId: 'custom-endpoint-99' })
    ).not.toThrow();
    expect(store.getAll().provider).toBe('anthropic');
  });

  it('sends a key typed for a pinned set to that endpoint only', () => {
    const { store, first, second } = storeWithTwoEndpoints();

    store.update({ provider: 'custom', endpointId: first.id, apiKey: 'kiro-rotated' });
    const endpoints = store.getAll().customEndpoints;

    expect(endpoints.find((e) => e.id === first.id)?.apiKey).toBe('kiro-rotated');
    expect(endpoints.find((e) => e.id === second.id)?.apiKey).toBe('lite-key');
  });

  it('starts a blank set on the same endpoint and its default model', () => {
    const { store, first } = storeWithTwoEndpoints();
    store.update({ provider: 'custom', endpointId: first.id, model: 'something-else' });

    const created = store.createSet({ name: 'Second', mode: 'blank' });
    const blank = created.configSets.find((set) => set.id !== 'default');

    expect(blank?.endpointId).toBe(first.id);
    expect(blank?.model).toBe('claude-opus-5');
    expect(created.apiKey).toBe('kiro-key');
  });
});

describe('legacy spellings are corrected where they are stored', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  /** A 1.0.8 config whose inactive set still holds OpenRouter's pre-`/v1` address. */
  function configWithOldOpenRouterAddress(): Record<string, unknown> {
    const config = release108Config();
    (config.configSets as Array<Record<string, unknown>>).push({
      id: 'set-3',
      name: 'Router',
      provider: 'openrouter',
      customProtocol: 'anthropic',
      activeProfileKey: 'openrouter',
      enableThinking: false,
      thinkingLevel: 'off',
      updatedAt: '2026-09-03T00:00:00.000Z',
      profiles: {
        openrouter: {
          apiKey: 'sk-or-old',
          baseUrl: 'https://openrouter.ai/api',
          model: 'anthropic/claude-sonnet-4-5',
        },
      },
    });
    return config;
  }

  it('moves an old OpenRouter address to /v1 in the credential store, not only in the projection', () => {
    // The form and the connection test read the credential store directly, so
    // correcting only the projected `baseUrl` would leave them on the old address.
    mocks.seed = configWithOldOpenRouterAddress();
    const store = new ConfigStore();

    expect(store.getAll().providerCredentials.openrouter?.baseUrl).toBe(
      'https://openrouter.ai/api/v1'
    );
    expect(
      (persisted().providerCredentials as Record<string, { baseUrl?: string }>).openrouter.baseUrl
    ).toBe('https://openrouter.ai/api/v1');
    expect(store.switchSet({ id: 'set-3' }).baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('corrects an old OpenRouter address in a store that was migrated earlier', () => {
    const store = new ConfigStore();
    store.setProviderCredential({
      provider: 'openrouter',
      apiKey: 'sk-or',
      baseUrl: 'https://openrouter.ai/api/',
    });

    expect(restart().getAll().providerCredentials.openrouter).toEqual({
      apiKey: 'sk-or',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });

  it('leaves any other OpenRouter address as it was typed', () => {
    const store = new ConfigStore();
    store.setProviderCredential({
      provider: 'openrouter',
      apiKey: 'sk-or',
      baseUrl: 'https://proxy.example/openrouter/api',
    });

    expect(store.getAll().providerCredentials.openrouter?.baseUrl).toBe(
      'https://proxy.example/openrouter/api'
    );
  });

  it('stores a dashed OpenRouter Claude id from an old set in the dotted form the registry uses', () => {
    mocks.seed = configWithOldOpenRouterAddress();
    const store = new ConfigStore();

    const router = store.getAll().configSets.find((set) => set.id === 'set-3');
    expect(router?.model).toBe('anthropic/claude-sonnet-4.5');
    expect(store.switchSet({ id: 'set-3' }).model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('starts a blank OpenRouter set on a model id the registry knows', () => {
    // A blank set is usable straight away, so its model reaches a chat without
    // ever passing through the form, which is the only other place the dashed
    // spelling is corrected.
    const store = new ConfigStore();
    store.update({ provider: 'openrouter', apiKey: 'sk-or' });

    const created = store.createSet({ name: 'Second', mode: 'blank' });
    const blank = created.configSets.find((set) => set.id !== 'default');

    expect(blank?.model).toBe('anthropic/claude-sonnet-4.6');
    expect(created.model).toBe('anthropic/claude-sonnet-4.6');
  });

  it('does not touch a dashed id on a provider other than OpenRouter', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-4-5' });

    expect(store.getAll().model).toBe('claude-sonnet-4-5');
  });
});

describe('pre-split keys that come back into the file', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  it('finishes a first start that was interrupted between its two writes', () => {
    // The migration persists in two steps: write the migrated config, then
    // delete the old top-level keys. A process killed in between leaves both in
    // the file. The next start has to end in the same place a clean one does.
    mocks.seed = release108Config();
    const clean = new ConfigStore().getAll();

    const original = release108Config();
    mocks.seed = {
      ...JSON.parse(JSON.stringify(persisted())),
      profiles: original.profiles,
      activeProfileKey: original.activeProfileKey,
    };
    const healed = new ConfigStore().getAll();

    for (const field of PRE_SPLIT_FIELDS) {
      expect(persisted(), `top-level ${field}`).not.toHaveProperty(field);
    }
    expect(healed.configSets).toEqual(clean.configSets);
    expect(healed.providerCredentials).toEqual(clean.providerCredentials);
    expect(healed.customEndpoints).toEqual(clean.customEndpoints);
    expect(healed.activeConfigSetId).toBe(clean.activeConfigSetId);
  });

  it('removes them on the next save, so the save is not rolled back', () => {
    // An older build pointed at the same file writes the top-level `profiles`
    // map back. The migration trusts that map over a lone default set, so while
    // it stays in the file every read rebuilds the set from it.
    mocks.seed = {
      provider: 'anthropic',
      apiKey: 'sk-ant',
      model: 'claude-opus-5',
      configSchemaVersion: 2,
    };
    const store = new ConfigStore();
    expect(store.getAll().model).toBe('claude-opus-5');

    Object.assign(persisted(), {
      activeProfileKey: 'anthropic',
      profiles: {
        anthropic: {
          apiKey: 'sk-ant',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-opus-5',
        },
      },
    });

    store.update({ model: 'claude-sonnet-5' });

    expect(store.getAll().model).toBe('claude-sonnet-5');
    for (const field of PRE_SPLIT_FIELDS) {
      expect(persisted(), `top-level ${field}`).not.toHaveProperty(field);
    }
    expect(restart().getAll().model).toBe('claude-sonnet-5');
  });
});
