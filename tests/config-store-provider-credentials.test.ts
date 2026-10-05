/**
 * Phase 1 of docs/design/provider-credentials-and-model-sets.md.
 *
 * `providerCredentials` and `customEndpoints` are *derived* from the config
 * sets' per-set `profiles` on every read. They are deliberately NOT yet
 * authoritative — the runtime projection (`apiKey` / `baseUrl` /
 * `customProtocol`) is still produced from `profiles`, so that `profiles` and
 * `providerCredentials` are never both live (design §9.4). These tests pin the
 * derivation rules from §5.1 and the Phase 1 boundary itself; Phase 2 will
 * invert the direction and these expectations move with it.
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

describe('ConfigStore providerCredentials derivation (Phase 1)', () => {
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

    expect(config.configSets[0].profiles.anthropic?.baseUrl).toBe('https://api.anthropic.com/');
    expect(config.providerCredentials.anthropic).toBeUndefined();
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

  it('ignores a persisted credential map entirely — config sets are the only input', () => {
    // Phase 1 has no write path into providerCredentials, so anything on disk is
    // the output of an earlier derivation. Feeding it back in would let a stale
    // value outvote the profile it came from, breaking key rotation. The map is
    // therefore recomputed from scratch; Phase 2 adds writes and authority.
    mocks.seed = {
      providerCredentials: {
        gemini: { apiKey: 'stale-cached-gemini' },
        anthropic: { apiKey: 'stale-cached-anthropic' },
      },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'sk-ant-real', baseUrl: '', model: 'claude-opus-5' } },
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-ant-real');
    // No profile configures gemini, so no credential — the cache does not revive it.
    expect(config.providerCredentials.gemini).toBeUndefined();
  });

  it('lets a live profile win over a stale persisted slot for the same provider', () => {
    // The precedence that matters: a persisted cache entry must never outvote
    // the profile it was derived from, or key rotation silently no-ops.
    mocks.seed = {
      providerCredentials: { anthropic: { apiKey: 'STALE-CACHED' } },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'FRESH-FROM-PROFILE', baseUrl: '', model: 'm' } },
        },
      ],
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().providerCredentials.anthropic?.apiKey).toBe(
      'FRESH-FROM-PROFILE'
    );
  });

  it('drops a persisted slot once its profile is emptied', () => {
    // The profile still *describes* the slot, it is just no longer configured —
    // so the cached credential must not resurrect it.
    mocks.seed = {
      providerCredentials: { anthropic: { apiKey: 'STALE-CACHED' } },
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

    expect(new ConfigStore().getAll().providerCredentials.anthropic).toBeUndefined();
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

describe('ConfigStore customEndpoints derivation (Phase 1)', () => {
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

  it('takes the apiKey from the live profile, not the persisted copy', () => {
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-7',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'STALE-CACHED',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway, // profile key is 'gw-key'
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().customEndpoints[0].apiKey).toBe('gw-key');
  });

  it('prunes a persisted endpoint that no profile describes any more', () => {
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-1',
          name: 'retired-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://retired:9000',
          apiKey: 'old',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway,
      activeConfigSetId: 'default',
    };

    const endpoints = new ConfigStore().getAll().customEndpoints;

    expect(endpoints.map((e) => e.baseUrl)).toEqual(['http://127.0.0.1:9000']);
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
    // `native:*`, so an invalid key like `custom:bogus` is stripped during set
    // normalization and never reaches the endpoint derivation. The guard inside
    // `deriveCustomEndpoints` is defence-in-depth for a future caller that passes
    // un-normalized sets; this test pins the invariant that makes it unreachable
    // today, so a change to `cloneProfiles` fails here rather than silently
    // emitting an endpoint with a guessed protocol.
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

    expect(Object.keys(config.configSets[0].profiles)).not.toContain('custom:bogus');
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

  it('re-stamps updatedAt when the credential actually changes', () => {
    mocks.seed = {
      customEndpoints: [
        {
          id: 'custom-endpoint-1',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'OLD-KEY',
          defaultModel: 'claude-opus-5',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: sharedGateway, // profile key is 'gw-key'
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

describe('Phase 1 boundary — the projection is unchanged', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('still projects runtime credentials from profiles, not from the derived map', () => {
    // The whole point of Phase 1: every runtime consumer (agent-runner,
    // diagnostics, memory, scheduler) keeps reading the flat projection, so the
    // derived map must not yet influence it.
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
