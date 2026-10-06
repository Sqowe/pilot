/**
 * Phase 1 of docs/design/provider-credentials-and-model-sets.md.
 *
 * These tests cover the *derivation* half of the feature: how
 * `providerCredentials` and `customEndpoints` are populated, deduplicated,
 * pruned and canonicalized (design §5.1).
 *
 * Updated for **Phase 2a**, which inverted the precedence. In Phase 1 nothing
 * wrote these fields, so a persisted copy could only be a stale cache and was
 * ignored outright. Phase 2a routes `update()` and the endpoint CRUD here, so
 * the persisted map is authoritative and legacy per-set `profiles` act only as a
 * migration source for slots it does not already hold. Rotation stays correct
 * because the write targets the map itself — see the persist→edit round-trips.
 *
 * Resolution (how a set turns into a running credential) lives in
 * `config-store-credential-resolution.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
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

  return {
    default: MockStore,
  };
});

import { ConfigStore } from '../src/main/config/config-store';

/** Minimal persisted config-set literal; normalization fills the rest. */
function seedSets(sets: Array<Record<string, unknown>>, activeConfigSetId = 'default'): void {
  mocks.seed = { configSets: sets, activeConfigSetId };
}

describe('ConfigStore providerCredentials derivation', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('derives one global slot from a set that has an API key', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: {
          anthropic: {
            apiKey: 'sk-ant-real',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-opus-5',
          },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-ant-real');
    // The model stays on the set — it is not part of the credential (design §3.1).
    expect(config.providerCredentials.anthropic).not.toHaveProperty('model');
  });

  it('keeps the keyless Ollama slot when only its base URL was customised', () => {
    // Decision #4: ollama is a legitimately keyless slot, so keying derivation
    // on apiKey alone would silently drop a user's custom Ollama URL.
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'ollama',
        customProtocol: 'openai',
        activeProfileKey: 'ollama',
        profiles: {
          ollama: { apiKey: '', baseUrl: 'http://192.168.1.50:11434/v1', model: 'qwen3.5' },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.ollama?.baseUrl).toBe('http://192.168.1.50:11434/v1');
    expect(config.providerCredentials.ollama?.apiKey).toBe('');
  });

  it('does not invent a credential when the default URL differs only by a trailing slash', () => {
    // `normalizeProfile` stores the base URL verbatim (no URL canonicalization),
    // so a raw string comparison against the slot default would read this as a
    // customization and mint a keyless credential the user never configured.
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: {
          // defaultProfiles' anthropic URL, plus a trailing slash.
          anthropic: { apiKey: '', baseUrl: 'https://api.anthropic.com/', model: 'm' },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.anthropic).toBeUndefined();
    // And the set still runs against the default endpoint.
    expect(config.baseUrl).toBe('https://api.anthropic.com');
  });

  it('does not invent a credential when the default URL differs only by host case', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'openai',
        customProtocol: 'openai',
        activeProfileKey: 'openai',
        profiles: {
          openai: { apiKey: '', baseUrl: 'https://API.OpenAI.com/v1', model: 'gpt-5.4' },
        },
      },
    ]);

    expect(new ConfigStore().getAll().providerCredentials.openai).toBeUndefined();
  });

  it('does not invent a slot for a provider left at its untouched defaults', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'openrouter',
        customProtocol: 'anthropic',
        activeProfileKey: 'openrouter',
        profiles: {
          // Default base URL, no key — carries no user intent.
          openrouter: { apiKey: '', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.openrouter).toBeUndefined();
  });

  it('round-trips a native:<id> slot (the bug the native catalog work had to fix)', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'zai',
        customProtocol: 'anthropic',
        activeProfileKey: 'native:zai',
        profiles: {
          'native:zai': { apiKey: 'zai-secret', baseUrl: '', model: 'glm-5' },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials['native:zai']?.apiKey).toBe('zai-secret');
  });

  it('excludes custom:* slots — those become customEndpoints instead', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': {
            apiKey: 'gw-key',
            baseUrl: 'http://127.0.0.1:9000',
            model: 'claude-opus-5',
          },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials['custom:anthropic']).toBeUndefined();
    expect(config.customEndpoints).toHaveLength(1);
  });

  describe('first non-empty wins (§5.1 rule 2 — the accepted lossy case)', () => {
    const twoSets = [
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: {
          anthropic: { apiKey: 'key-from-default', baseUrl: '', model: 'claude-opus-5' },
        },
      },
      {
        id: 'set-2',
        name: 'Work',
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: { anthropic: { apiKey: 'key-from-work', baseUrl: '', model: 'claude-opus-5' } },
      },
    ];

    it('prefers the active set regardless of array position', () => {
      seedSets(twoSets, 'set-2');
      expect(new ConfigStore().getAll().providerCredentials.anthropic?.apiKey).toBe(
        'key-from-work'
      );
    });

    it('falls back to a later set when the active set has no key', () => {
      // The active set's slot is empty, so the rule under test is actually
      // exercised: derivation must skip it and take the next populated set.
      seedSets(
        [
          {
            ...twoSets[0],
            profiles: { anthropic: { apiKey: '', baseUrl: '', model: 'claude-opus-5' } },
          },
          twoSets[1],
        ],
        'default'
      );
      expect(new ConfigStore().getAll().providerCredentials.anthropic?.apiKey).toBe(
        'key-from-work'
      );
    });

    it('takes the first populated set by array order when the active set is empty', () => {
      seedSets(
        [
          {
            ...twoSets[0],
            profiles: { anthropic: { apiKey: '', baseUrl: '', model: 'claude-opus-5' } },
          },
          {
            ...twoSets[1],
            id: 'set-2',
            profiles: { anthropic: { apiKey: 'key-b', baseUrl: '', model: 'm' } },
          },
          {
            ...twoSets[1],
            id: 'set-3',
            name: 'Third',
            profiles: { anthropic: { apiKey: 'key-c', baseUrl: '', model: 'm' } },
          },
        ],
        'default'
      );
      expect(new ConfigStore().getAll().providerCredentials.anthropic?.apiKey).toBe('key-b');
    });
  });

  it('never borrows a key from a different provider', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: {
          anthropic: { apiKey: 'sk-ant-real', baseUrl: '', model: 'claude-opus-5' },
          openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-ant-real');
    expect(config.providerCredentials.openai).toBeUndefined();
  });

  it('is idempotent — deriving from already-derived output adds nothing', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: { anthropic: { apiKey: 'sk-ant-real', baseUrl: '', model: 'claude-opus-5' } },
      },
    ]);

    const store = new ConfigStore();
    const first = store.getAll();
    mocks.seed = { ...mocks.seed, providerCredentials: first.providerCredentials };
    const second = new ConfigStore().getAll();

    expect(second.providerCredentials).toEqual(first.providerCredentials);
  });

  it('keeps a persisted credential that no config set describes (Phase 2a: authoritative)', () => {
    // Phase 1 ignored the persisted map entirely: nothing wrote it, so anything
    // on disk could only be a stale cache. Phase 2a routes `update({ apiKey })`
    // here, so a persisted slot is the user's real credential and must survive a
    // read even with no matching profile. Rotation is still correct because the
    // write updates this map directly — see the round-trip tests below.
    mocks.seed = {
      providerCredentials: {
        gemini: { apiKey: 'written-directly' },
        anthropic: { apiKey: 'also-written' },
      },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: {
            anthropic: { apiKey: 'legacy-profile', baseUrl: '', model: 'claude-opus-5' },
          },
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.gemini?.apiKey).toBe('written-directly');
    // Persisted wins over the legacy profile for the same slot — the profile is
    // only a migration source for slots the map does not already hold.
    expect(config.providerCredentials.anthropic?.apiKey).toBe('also-written');
  });

  it('migrates from a legacy profile only when the persisted map has no such slot', () => {
    mocks.seed = {
      providerCredentials: { gemini: { apiKey: 'gem' } },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'from-legacy', baseUrl: '', model: 'm' } },
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.anthropic?.apiKey).toBe('from-legacy');
    expect(config.providerCredentials.gemini?.apiKey).toBe('gem');
  });

  it('lets the persisted map win over a legacy profile for the same provider', () => {
    // Phase 2a: the persisted map is authoritative. Rotation stays correct
    // because `update()` writes this map, not the profile — proven by the
    // persist→edit round-trip tests further down.
    mocks.seed = {
      providerCredentials: { anthropic: { apiKey: 'AUTHORITATIVE' } },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'LEGACY-PROFILE', baseUrl: '', model: 'm' } },
        },
      ],
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().providerCredentials.anthropic?.apiKey).toBe('AUTHORITATIVE');
  });

  it('keeps a persisted slot even when the legacy profile is empty', () => {
    // The Phase 1 rule was the opposite (an emptied profile cleared the slot).
    // Clearing a credential is now an explicit write of an empty value through
    // update(), not a side effect of the legacy mirror going blank.
    mocks.seed = {
      providerCredentials: { anthropic: { apiKey: 'STILL-SET' } },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: '', baseUrl: '', model: 'm' } },
        },
      ],
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().providerCredentials.anthropic?.apiKey).toBe('STILL-SET');
  });

  it('reflects a rotated key through a persist → edit round-trip', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: { anthropic: { apiKey: 'OLD-KEY', baseUrl: '', model: 'claude-opus-5' } },
      },
    ]);

    const store = new ConfigStore();
    store.update({ theme: 'dark' }); // persists the derived cache
    store.update({ apiKey: 'NEW-KEY' }); // rotate via the normal write path
    const config = store.getAll();

    expect(config.apiKey).toBe('NEW-KEY');
    expect(config.providerCredentials.anthropic?.apiKey).toBe('NEW-KEY');
  });

  it('reflects a changed base URL through a persist → edit round-trip', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'ollama',
        customProtocol: 'openai',
        activeProfileKey: 'ollama',
        profiles: { ollama: { apiKey: '', baseUrl: 'http://10.0.0.1:11434/v1', model: 'q' } },
      },
    ]);

    const store = new ConfigStore();
    store.update({ theme: 'dark' });
    store.update({ baseUrl: 'http://10.0.0.2:11434/v1' });

    expect(store.getAll().providerCredentials.ollama?.baseUrl).toBe('http://10.0.0.2:11434/v1');
  });

  it('ignores prototype-polluting keys in a hand-edited config set', () => {
    mocks.seed = {
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: JSON.parse(
            '{"__proto__":{"apiKey":"evil"},"anthropic":{"apiKey":"ok","baseUrl":"","model":"m"}}'
          ),
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.anthropic?.apiKey).toBe('ok');
    expect(({} as Record<string, unknown>).apiKey).toBeUndefined();
  });
});

describe('ConfigStore customEndpoints derivation', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  /** Two sets pointing at the same gateway, plus one at a different gateway. */
  const sharedGateway = [
    {
      id: 'default',
      name: 'Default',
      isSystem: true,
      provider: 'custom',
      customProtocol: 'anthropic',
      activeProfileKey: 'custom:anthropic',
      profiles: {
        'custom:anthropic': {
          apiKey: 'gw-key',
          baseUrl: 'http://127.0.0.1:9000',
          model: 'claude-opus-5',
        },
      },
    },
    {
      id: 'set-2',
      name: 'Work',
      provider: 'custom',
      customProtocol: 'anthropic',
      activeProfileKey: 'custom:anthropic',
      profiles: {
        'custom:anthropic': {
          apiKey: 'gw-key',
          // Same endpoint, trailing slash — must not mint a second entry.
          baseUrl: 'http://127.0.0.1:9000/',
          model: 'claude-opus-5',
        },
      },
    },
  ];

  it('derives one entry per distinct base URL, ignoring trailing-slash noise', () => {
    seedSets(sharedGateway);

    const endpoints = new ConfigStore().getAll().customEndpoints;

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].baseUrl).toBe('http://127.0.0.1:9000');
    expect(endpoints[0].apiKey).toBe('gw-key');
    expect(endpoints[0].protocol).toBe('anthropic');
  });

  it('separates endpoints that share a base URL but differ in protocol', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': { apiKey: 'k1', baseUrl: 'http://127.0.0.1:9000', model: 'm1' },
          'custom:openai': { apiKey: 'k2', baseUrl: 'http://127.0.0.1:9000', model: 'm2' },
        },
      },
    ]);

    const endpoints = new ConfigStore().getAll().customEndpoints;

    expect(endpoints).toHaveLength(2);
    expect(endpoints.map((e) => e.protocol).sort()).toEqual(['anthropic', 'openai']);
  });

  it('names a migrated endpoint after its host (§5.1 rule 3)', () => {
    seedSets(sharedGateway);
    expect(new ConfigStore().getAll().customEndpoints[0].name).toBe('127.0.0.1:9000');
  });

  it('seeds defaultModel from the profile model (decision #10)', () => {
    seedSets(sharedGateway);
    expect(new ConfigStore().getAll().customEndpoints[0].defaultModel).toBe('claude-opus-5');
  });

  it('mints stable, non-colliding ids', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': { apiKey: 'k1', baseUrl: 'http://gw-a:9000', model: 'm1' },
          'custom:openai': { apiKey: 'k2', baseUrl: 'http://gw-b:9000', model: 'm2' },
        },
      },
    ]);

    const ids = new ConfigStore().getAll().customEndpoints.map((e) => e.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('custom-endpoint-'))).toBe(true);
  });

  it('preserves a persisted entry’s id and user-edited name on re-derivation', () => {
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-7',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'gw-key',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway,
      activeConfigSetId: 'default',
    };

    const endpoints = new ConfigStore().getAll().customEndpoints;

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe('custom-endpoint-7');
    expect(endpoints[0].name).toBe('kiro-gateway');
  });

  it('takes the apiKey from the persisted endpoint, not the legacy profile', () => {
    // Phase 2a inverted this. The persisted endpoint is authoritative for the
    // key, so a rotation through `updateCustomEndpoint` is not reverted by the
    // set's `custom:*` mirror, which still holds the pre-rotation value.
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-7',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'ROTATED',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway, // legacy profile key is 'gw-key'
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().customEndpoints[0].apiKey).toBe('ROTATED');
  });

  it('falls back to the legacy profile key when the persisted entry has no apiKey property', () => {
    // Migration path: an endpoint persisted *without* an apiKey property picks one
    // up from the profile that describes it. Note the property is omitted, not
    // empty — `apiKey: ''` means "explicitly cleared" and is covered below.
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-7',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway,
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().customEndpoints[0].apiKey).toBe('gw-key');
  });

  it('keeps an explicitly cleared endpoint key empty, ignoring the legacy mirror', () => {
    // Empty and missing are different states for endpoints too, exactly as for
    // `providerCredentials`. `carried.apiKey || apiKey` would treat '' as missing
    // and revive the pre-clear value from the profile.
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-7',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway, // legacy mirror still holds 'gw-key'
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();
    expect(config.customEndpoints[0].apiKey).toBe('');
    expect(config.apiKey).toBe('');
  });

  it('keeps a persisted endpoint that no profile describes (Phase 2a: authoritative)', () => {
    // Phase 1 pruned this as an orphan, because every endpoint was derived from a
    // `custom:*` profile and anything else was stale cache. Phase 2a makes
    // `customEndpoints` authoritative: an entry created through the CRUD API has
    // no profile behind it by construction, so pruning it would delete the user's
    // own data. The orphan case that mattered — a *derived* endpoint whose source
    // profile changed — is still pruned; see the gateway-URL-edit test below.
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-1',
          name: 'standalone-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://standalone:9000',
          apiKey: 'own',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway,
      activeConfigSetId: 'default',
    };

    const endpoints = new ConfigStore().getAll().customEndpoints;

    expect(endpoints.map((e) => e.baseUrl).sort()).toEqual([
      'http://127.0.0.1:9000',
      'http://standalone:9000',
    ]);
  });

  it('does not leave an orphan when a gateway URL is edited after persisting', () => {
    // Without pruning, editing the URL mints a second entry and the old one
    // lingers — enough repetitions would fill the cap and evict real endpoints.
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': { apiKey: 'k', baseUrl: 'http://old-gw:9000', model: 'm' },
        },
      },
    ]);

    const store = new ConfigStore();
    store.update({ theme: 'dark' });
    store.update({ baseUrl: 'http://new-gw:9000' });
    const endpoints = store.getAll().customEndpoints;

    expect(endpoints.map((e) => e.baseUrl)).toEqual(['http://new-gw:9000']);
  });

  it('does not invent an endpoint from an untouched default custom slot', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'openrouter',
        customProtocol: 'anthropic',
        activeProfileKey: 'openrouter',
        profiles: {
          // defaultProfiles' value for custom:anthropic, never edited.
          'custom:anthropic': {
            apiKey: '',
            baseUrl: 'https://open.bigmodel.cn/api/anthropic',
            model: 'glm-5',
          },
        },
      },
    ]);

    expect(new ConfigStore().getAll().customEndpoints).toEqual([]);
  });

  it('deduplicates an unparseable base URL without dropping it', () => {
    // A malformed base URL is still the user's data: keep the entry, and still
    // treat two spellings of it as one endpoint.
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': { apiKey: 'k1', baseUrl: 'not a url/', model: 'm1' },
        },
      },
      {
        id: 'set-2',
        name: 'Work',
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': { apiKey: 'k1', baseUrl: 'NOT A URL', model: 'm1' },
        },
      },
    ]);

    const endpoints = new ConfigStore().getAll().customEndpoints;

    expect(endpoints).toHaveLength(1);
    // Stored in canonical form (lowercased, no trailing slash) so the value does
    // not depend on which set happened to be derived first.
    expect(endpoints[0].baseUrl).toBe('not a url');
  });

  it('stores a canonical base URL regardless of set order', () => {
    // Two sets spell the same gateway differently; the stored value must not
    // depend on which one wins the derivation race.
    seedSets(
      [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'custom',
          customProtocol: 'anthropic',
          activeProfileKey: 'custom:anthropic',
          profiles: {
            'custom:anthropic': { apiKey: 'k', baseUrl: 'http://GW.local:9000/', model: 'm' },
          },
        },
        {
          id: 'set-2',
          name: 'Work',
          provider: 'custom',
          customProtocol: 'anthropic',
          activeProfileKey: 'custom:anthropic',
          profiles: {
            'custom:anthropic': { apiKey: 'k', baseUrl: 'http://gw.local:9000', model: 'm' },
          },
        },
      ],
      'set-2'
    );

    const endpoints = new ConfigStore().getAll().customEndpoints;

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].baseUrl).toBe('http://gw.local:9000');
  });

  it('does not invent an endpoint when the default URL differs only by a trailing slash', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'openrouter',
        customProtocol: 'anthropic',
        activeProfileKey: 'openrouter',
        profiles: {
          // defaultProfiles' custom:anthropic URL, plus a trailing slash.
          'custom:anthropic': {
            apiKey: '',
            baseUrl: 'https://open.bigmodel.cn/api/anthropic/',
            model: 'glm-5',
          },
        },
      },
    ]);

    expect(new ConfigStore().getAll().customEndpoints).toEqual([]);
  });

  it('fills defaultModel from the winning set, which normalization always populates', () => {
    // `normalizeProfile` substitutes the slot's default model for an empty one,
    // so by the time derivation runs there is effectively always a model. The
    // backfill path for a genuinely missing one therefore only matters for
    // persisted entries, not for profile-derived ones.
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': { apiKey: 'k', baseUrl: 'http://gw:9000', model: '' },
        },
      },
      {
        id: 'set-2',
        name: 'Work',
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': { apiKey: 'k', baseUrl: 'http://gw:9000', model: 'claude-opus-5' },
        },
      },
    ]);

    const endpoints = new ConfigStore().getAll().customEndpoints;

    expect(endpoints).toHaveLength(1);
    // 'glm-5' is defaultProfiles['custom:anthropic'].model, substituted for ''.
    expect(endpoints[0].defaultModel).toBe('glm-5');
  });

  it('drops a hand-edited custom:* key with an invalid protocol before derivation', () => {
    // `cloneProfiles` only materializes the 8 valid builtin slots and preserves
    // `native:*`, so an invalid key like `custom:bogus` is stripped when the
    // legacy set is read and never reaches the endpoint derivation. The guard
    // inside `deriveCustomEndpoints` is defence-in-depth; this test pins the
    // outcome, so weakening either fails here rather than silently emitting an
    // endpoint with a guessed protocol.
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:bogus': { apiKey: 'k', baseUrl: 'http://bogus:9000', model: 'm' },
          'custom:anthropic': { apiKey: 'k2', baseUrl: 'http://real:9000', model: 'm' },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(JSON.stringify(config)).not.toContain('bogus');
    expect(config.customEndpoints.map((e) => e.baseUrl)).toEqual(['http://real:9000']);
    expect(
      config.customEndpoints.every((e) => ['anthropic', 'openai', 'gemini'].includes(e.protocol))
    ).toBe(true);
  });

  it('keeps updatedAt stable when nothing material changed', () => {
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-1',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'gw-key',
          defaultModel: 'claude-opus-5',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway,
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().customEndpoints[0].updatedAt).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('re-stamps updatedAt when something material actually changes', () => {
    // The persisted key now wins, so a differing profile key is no longer a
    // change. A differing model still is.
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-1',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'gw-key',
          defaultModel: 'some-older-model',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway, // profile model is 'claude-opus-5'
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().customEndpoints[0].updatedAt).not.toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('caps derived endpoints at MAX_CUSTOM_ENDPOINT_COUNT', () => {
    // 20 sets × 1 distinct custom base URL each = 21 candidates, capped to 20.
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: i === 0 ? 'default' : `set-${i + 1}`,
      name: i === 0 ? 'Default' : `Set ${i + 1}`,
      isSystem: i === 0,
      provider: 'custom',
      customProtocol: 'anthropic',
      activeProfileKey: 'custom:anthropic',
      profiles: {
        'custom:anthropic': { apiKey: `k${i}`, baseUrl: `http://gw-${i}:9000`, model: 'm' },
      },
    }));
    seedSets(many);

    expect(new ConfigStore().getAll().customEndpoints).toHaveLength(20);
  });
});

describe('legacy projection mirror stays byte-compatible', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('projects a migrated legacy config to the same runtime values', () => {
    // Phase 2a: the projection is built by `resolveCredentials` from the global
    // map, not read out of `profiles`. For a pre-split config the two agree by
    // construction — the map was migrated from that very profile — which is what
    // makes the change invisible to every runtime consumer (agent-runner,
    // diagnostics, memory, scheduler).
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: {
          anthropic: {
            apiKey: 'sk-from-profile',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-opus-5',
          },
        },
      },
    ]);

    const config = new ConfigStore().getAll();

    expect(config.apiKey).toBe('sk-from-profile');
    expect(config.model).toBe('claude-opus-5');
    expect(config.provider).toBe('anthropic');
    // …and the derived map agrees, because it was derived from the same source.
    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-from-profile');
  });

  it('preserves every config-set id and the active id (no data migration)', () => {
    // sessions.config_set_id / scheduled_tasks.config_set_id reference these.
    seedSets(
      [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'k', baseUrl: '', model: 'claude-opus-5' } },
        },
        {
          id: 'set-2',
          name: 'Work',
          provider: 'openrouter',
          customProtocol: 'anthropic',
          activeProfileKey: 'openrouter',
          profiles: {
            openrouter: { apiKey: 'k2', baseUrl: '', model: 'anthropic/claude-sonnet-4-6' },
          },
        },
      ],
      'set-2'
    );

    const config = new ConfigStore().getAll();

    expect(config.configSets.map((s) => s.id)).toEqual(['default', 'set-2']);
    expect(config.activeConfigSetId).toBe('set-2');
  });

  it('survives an update() round-trip without losing derived data', () => {
    seedSets([
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': {
            apiKey: 'gw-key',
            baseUrl: 'http://127.0.0.1:9000',
            model: 'claude-opus-5',
          },
        },
      },
    ]);

    const store = new ConfigStore();
    store.update({ theme: 'dark' });
    const config = store.getAll();

    expect(config.theme).toBe('dark');
    expect(config.customEndpoints).toHaveLength(1);
    expect(config.customEndpoints[0].apiKey).toBe('gw-key');
    expect(config.apiKey).toBe('gw-key');
  });

  it('exposes empty collections on a fresh install', () => {
    const config = new ConfigStore().getAll();

    expect(config.providerCredentials).toEqual({});
    expect(config.customEndpoints).toEqual([]);
  });
});
