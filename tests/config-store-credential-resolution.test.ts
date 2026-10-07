/**
 * Phase 2a of docs/design/archive/provider-credentials-and-model-sets.md — the §8.1
 * assertions.
 *
 * `providerCredentials` / `customEndpoints` are now **authoritative**:
 * `resolveCredentials` builds the runtime projection from them (§4), and
 * `update({ apiKey, baseUrl })` writes there instead of into a config set (§4.1).
 * `profiles` survives on the type only as the legacy mirror the renderer still
 * reads and writes until Phase 2b.
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
      this.store = { ...this.store, ...key };
    }

    delete(key: string): void {
      delete this.store[key];
    }

    clear(): void {
      this.store = {};
    }
  }

  return { default: MockStore };
});

import { ConfigStore } from '../src/main/config/config-store';

describe('projection precedence (§4)', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('resolves a catalog set from the global credential map', () => {
    mocks.seed = {
      providerCredentials: { anthropic: { apiKey: 'sk-ant-global' } },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          model: 'claude-opus-5',
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.apiKey).toBe('sk-ant-global');
    expect(config.model).toBe('claude-opus-5');
    expect(config.customProtocol).toBe('anthropic');
    // Builtin providers keep their preset endpoint when the credential has no override.
    expect(config.baseUrl).toBe('https://api.anthropic.com');
  });

  it('resolves a custom set from the endpoint its endpointId names', () => {
    mocks.seed = {
      customEndpoints: [
        {
          id: 'ce-1',
          name: 'kiro-gateway',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'gw-key',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'custom',
          endpointId: 'ce-1',
          model: 'claude-opus-5',
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.apiKey).toBe('gw-key');
    expect(config.baseUrl).toBe('http://127.0.0.1:9000');
    // The endpoint supplies the routing protocol, not the set.
    expect(config.customProtocol).toBe('anthropic');
  });

  it('takes the protocol from the endpoint, overriding a stale value on the set', () => {
    mocks.seed = {
      customEndpoints: [
        {
          id: 'ce-1',
          name: 'relay',
          protocol: 'openai',
          baseUrl: 'http://relay:9000',
          apiKey: 'k',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'custom',
          endpointId: 'ce-1',
          customProtocol: 'anthropic', // stale legacy mirror
          model: 'm',
        },
      ],
      activeConfigSetId: 'default',
    };

    expect(new ConfigStore().getAll().customProtocol).toBe('openai');
  });

  it('yields an empty key for a provider with no credential — never borrows one', () => {
    mocks.seed = {
      providerCredentials: { anthropic: { apiKey: 'sk-ant-global' } },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'openai',
          model: 'gpt-5.4',
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.provider).toBe('openai');
    expect(config.apiKey).toBe('');
  });

  it('yields an empty key for a custom set whose endpointId dangles', () => {
    mocks.seed = {
      providerCredentials: { anthropic: { apiKey: 'sk-ant-global' } },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'custom',
          endpointId: 'ce-missing',
          model: 'm',
        },
      ],
      activeConfigSetId: 'default',
    };

    // Must not fall through to the anthropic slot just because the protocol matches.
    expect(new ConfigStore().getAll().apiKey).toBe('');
  });

  it('shares one credential across two sets on the same provider', () => {
    // The complaint that motivated the design (§1.1): a second set no longer
    // needs the key pasted again.
    mocks.seed = {
      providerCredentials: { anthropic: { apiKey: 'sk-shared' } },
      configSets: [
        { id: 'default', name: 'Default', isSystem: true, provider: 'anthropic', model: 'a' },
        { id: 'set-2', name: 'Work', provider: 'anthropic', model: 'b' },
      ],
      activeConfigSetId: 'set-2',
    };

    const store = new ConfigStore();
    expect(store.getAll().apiKey).toBe('sk-shared');
    expect(store.getAll().model).toBe('b');

    store.switchSet({ id: 'default' });
    expect(store.getAll().apiKey).toBe('sk-shared');
    expect(store.getAll().model).toBe('a');
  });
});

describe('credential writes leave the config set (§4.1)', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('routes apiKey to the global slot, not the active set', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-written', model: 'claude-opus-5' });

    const config = store.getAll();

    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-written');
    expect(config.apiKey).toBe('sk-written');
    // Model selection stays on the set.
    const activeSet = config.configSets.find((s) => s.id === config.activeConfigSetId);
    expect(activeSet?.model).toBe('claude-opus-5');
  });

  it('makes a new set immediately usable — the original complaint (§1.2)', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-written', model: 'claude-opus-5' });
    store.createSet({ name: 'Second', mode: 'blank' });

    // Pre-split this was '' and the user had to paste the key again.
    expect(store.getAll().apiKey).toBe('sk-written');
  });

  it('keeps per-provider keys isolated when switching provider', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant' });
    store.update({ provider: 'openai', apiKey: 'sk-oai' });

    const config = store.getAll();

    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-ant');
    expect(config.providerCredentials.openai?.apiKey).toBe('sk-oai');
    expect(config.apiKey).toBe('sk-oai');
  });

  it('mints an endpoint when a custom provider is given a base URL', () => {
    const store = new ConfigStore();
    store.update({
      provider: 'custom',
      customProtocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
      apiKey: 'gw-key',
      model: 'claude-opus-5',
    });

    const config = store.getAll();

    expect(config.customEndpoints).toHaveLength(1);
    expect(config.customEndpoints[0].baseUrl).toBe('http://127.0.0.1:9000');
    expect(config.customEndpoints[0].apiKey).toBe('gw-key');
    const activeSet = config.configSets.find((s) => s.id === config.activeConfigSetId);
    expect(activeSet?.endpointId).toBe(config.customEndpoints[0].id);
    expect(config.apiKey).toBe('gw-key');
  });

  it('reuses the endpoint on a repeated save of the same gateway', () => {
    const store = new ConfigStore();
    const payload = {
      provider: 'custom' as const,
      customProtocol: 'anthropic' as const,
      baseUrl: 'http://127.0.0.1:9000',
      apiKey: 'gw-key',
    };
    store.update(payload);
    const firstId = store.getAll().customEndpoints[0].id;
    store.update({ ...payload, apiKey: 'gw-key-rotated' });

    const config = store.getAll();

    expect(config.customEndpoints).toHaveLength(1);
    expect(config.customEndpoints[0].id).toBe(firstId);
    expect(config.customEndpoints[0].apiKey).toBe('gw-key-rotated');
  });

  it('clears a key and no other set resurrects it', () => {
    // Empty and missing must be different states. An empty *present* slot means
    // "cleared on purpose"; if it read as missing, the legacy-profile migration
    // would revive the old key from any set whose `profiles` still carried it.
    mocks.seed = {
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'OLD', baseUrl: '', model: 'm' } },
        },
        {
          id: 'set-2',
          name: 'Work',
          provider: 'anthropic',
          customProtocol: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'OLD', baseUrl: '', model: 'm' } },
        },
      ],
      activeConfigSetId: 'default',
    };

    const store = new ConfigStore();
    store.update({ apiKey: '' });
    expect(store.getAll().apiKey).toBe('');

    // Survives a further normalize cycle...
    store.update({ theme: 'dark' });
    expect(store.getAll().apiKey).toBe('');

    // ...a switch to the set whose legacy profile still holds the old key...
    store.switchSet({ id: 'set-2' });
    expect(store.getAll().apiKey).toBe('');

    // ...and a full reload from what was persisted.
    mocks.seed = { ...store.getAll() } as unknown as Record<string, unknown>;
    expect(new ConfigStore().getAll().apiKey).toBe('');
  });

  it('clears a native provider key without another set resurrecting it', () => {
    // Native slots have no default baseUrl, so a cleared credential is *entirely*
    // empty. If an empty persisted slot read as "never configured", the
    // legacy-profile migration would revive the old key from the second set.
    mocks.seed = {
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'zai',
          activeProfileKey: 'native:zai',
          profiles: { 'native:zai': { apiKey: 'OLD-ZAI', baseUrl: '', model: 'glm-5' } },
        },
        {
          id: 'set-2',
          name: 'Work',
          provider: 'zai',
          activeProfileKey: 'native:zai',
          profiles: { 'native:zai': { apiKey: 'OLD-ZAI', baseUrl: '', model: 'glm-5' } },
        },
      ],
      activeConfigSetId: 'default',
    };

    const store = new ConfigStore();
    store.update({ apiKey: '' });
    expect(store.getAll().apiKey).toBe('');

    // Survives a reload from what was persisted.
    mocks.seed = { ...store.getAll() } as unknown as Record<string, unknown>;
    expect(new ConfigStore().getAll().apiKey).toBe('');
  });

  it('persists a cleared slot as present-but-empty, not absent', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant' });
    store.update({ apiKey: '' });

    const credentials = store.getAll().providerCredentials;
    expect('anthropic' in credentials).toBe(true);
    expect(credentials.anthropic?.apiKey).toBe('');
  });

  it('drops endpointId when a set switches to a catalog provider', () => {
    // endpointId is meaningful only for custom sets. A stale pin would make the
    // set look like a referrer to deleteCustomEndpoint's in-use check.
    const store = new ConfigStore();
    store.update({
      provider: 'custom',
      customProtocol: 'anthropic',
      baseUrl: 'http://gw:9000',
      apiKey: 'k',
    });
    const endpointId = store.getAll().customEndpoints[0].id;

    store.update({ provider: 'anthropic', apiKey: 'sk-ant' });

    const config = store.getAll();
    const activeSet = config.configSets.find((s) => s.id === config.activeConfigSetId);
    expect(activeSet?.provider).toBe('anthropic');
    expect(activeSet?.endpointId).toBeUndefined();
    // …and the now-unreferenced endpoint is deletable.
    expect(() => store.deleteCustomEndpoint({ id: endpointId })).not.toThrow();
  });

  it('does not let a stale inactive profile slot revert a rotated key', () => {
    // The renderer's `profiles` map is a snapshot. If every non-empty slot were
    // forwarded into the global store, saving set A would overwrite a key rotated
    // on set B with the value the UI happened to load. This is the exact rotation
    // reversal Phase 2a exists to prevent, so it is guarded on both sides:
    // writes are scoped to the active slot, and the projection re-mirrors every
    // slot from the authoritative store.
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'ANT-V1', model: 'claude-opus-5' });
    store.update({ provider: 'openai', apiKey: 'OAI-V1', model: 'gpt-5.4' });

    // A UI snapshot taken while openai is active, holding the old anthropic key.
    const staleProfiles = store.getAll().profiles;

    // Rotate anthropic (authoritative write) while openai is still the active one.
    store.update({ provider: 'anthropic', apiKey: 'ANT-V2' });
    expect(store.getAll().providerCredentials.anthropic?.apiKey).toBe('ANT-V2');

    // Now the stale UI saves its full profile map.
    store.update({ provider: 'openai', profiles: staleProfiles });

    expect(store.getAll().providerCredentials.anthropic?.apiKey).toBe('ANT-V2');
    expect(store.getAll().providerCredentials.openai?.apiKey).toBe('OAI-V1');
  });

  it('lets the stored credential outrank a stale legacy profile, active slot or not', () => {
    // A config written by the Phase 1–2b builds: it already has the global map,
    // and its per-set profiles are older than it. Migration must keep the map's
    // value for every slot, not only the one the set points at — otherwise a key
    // rotated while a different provider was active would be reverted.
    mocks.seed = {
      providerCredentials: {
        anthropic: { apiKey: 'ANT-NEW' },
        openai: { apiKey: 'OAI-NEW' },
      },
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'openai',
          customProtocol: 'openai',
          activeProfileKey: 'openai',
          model: 'gpt-5.4',
          profiles: {
            anthropic: { apiKey: 'ANT-STALE', baseUrl: '', model: 'm' },
            openai: { apiKey: 'OAI-STALE', baseUrl: '', model: 'gpt-5.4' },
          },
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials.openai?.apiKey).toBe('OAI-NEW'); // active slot
    expect(config.providerCredentials.anthropic?.apiKey).toBe('ANT-NEW'); // inactive slot
    expect(config.apiKey).toBe('OAI-NEW');
  });

  it('does not let a stale custom:* slot revert an endpoint key', () => {
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'gw',
      protocol: 'anthropic',
      baseUrl: 'http://gw:9000',
      apiKey: 'GW-V1',
    });
    const endpointId = created.customEndpoints[0].id;
    store.update({ provider: 'custom', customProtocol: 'anthropic', baseUrl: 'http://gw:9000' });

    const staleProfiles = store.getAll().profiles;

    // Rotate the endpoint key through the CRUD API.
    store.updateCustomEndpoint({ id: endpointId, apiKey: 'GW-V2' });
    expect(store.getAll().customEndpoints[0].apiKey).toBe('GW-V2');

    // A save carrying the pre-rotation mirror must not undo it.
    store.update({ provider: 'anthropic', profiles: staleProfiles });

    expect(store.getAll().customEndpoints[0].apiKey).toBe('GW-V2');
  });

  it('sets and then clears per-set contextWindow / maxTokens', () => {
    // Three-state field: absent / set / cleared. `...targetSet` copies the old
    // value and the conditional spreads only add, so a clear needs an explicit
    // delete or a limit can never be removed once set.
    const store = new ConfigStore();
    store.update({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-opus-5',
      contextWindow: 200000,
      maxTokens: 8192,
    });

    const activeId = store.getAll().activeConfigSetId;
    const withLimits = store.getAll().configSets.find((s) => s.id === activeId);
    expect(withLimits?.contextWindow).toBe(200000);
    expect(withLimits?.maxTokens).toBe(8192);
    expect(store.getAll().contextWindow).toBe(200000);

    store.update({ contextWindow: 0, maxTokens: 0 });

    const cleared = store.getAll().configSets.find((s) => s.id === activeId);
    expect(cleared?.contextWindow).toBeUndefined();
    expect(cleared?.maxTokens).toBeUndefined();
    expect(store.getAll().contextWindow).toBeUndefined();
  });

  it('rotates a key through the global slot', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'OLD' });
    store.update({ apiKey: 'NEW' });

    expect(store.getAll().apiKey).toBe('NEW');
    expect(store.getAll().providerCredentials.anthropic?.apiKey).toBe('NEW');
  });
});

describe('gateway URL edits', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  const legacyCustomSet = {
    id: 'default',
    name: 'Default',
    isSystem: true,
    provider: 'custom',
    customProtocol: 'anthropic',
    activeProfileKey: 'custom:anthropic',
    profiles: {
      'custom:anthropic': { apiKey: 'k', baseUrl: 'http://old-gw:9000', model: 'm' },
    },
  };

  it('re-points a set through its endpoint, leaving no stale twin', () => {
    // The endpoint is the one place a gateway URL lives, so editing it moves the
    // set and cannot leave the old address behind as a second entry.
    mocks.seed = { configSets: [legacyCustomSet], activeConfigSetId: 'default' };
    const store = new ConfigStore();
    expect(store.getAll().baseUrl).toBe('http://old-gw:9000');

    store.update({ baseUrl: 'http://new-gw:9000' });
    const config = store.getAll();

    expect(config.baseUrl).toBe('http://new-gw:9000');
    expect(config.customEndpoints.map((e) => e.baseUrl)).toEqual(['http://new-gw:9000']);
    expect(config.configSets[0].endpointId).toBe(config.customEndpoints[0].id);
  });

  it('does not accumulate endpoints across repeated URL edits', () => {
    mocks.seed = { configSets: [legacyCustomSet], activeConfigSetId: 'default' };
    const store = new ConfigStore();

    for (const url of ['http://gw-a:9000', 'http://gw-b:9000', 'http://gw-c:9000']) {
      store.update({ baseUrl: url });
    }

    const config = store.getAll();
    expect(config.customEndpoints.map((e) => e.baseUrl)).toEqual(['http://gw-c:9000']);
    expect(config.baseUrl).toBe('http://gw-c:9000');
  });

  it('ignores a pre-split profiles map on an incoming config set', () => {
    // `update({ configSets })` takes the current shape only. The migration reads
    // the persisted file once; it never runs over a caller's payload, so a
    // legacy `profiles` map supplied here can neither move the set nor mint an
    // endpoint at the address it names.
    mocks.seed = { configSets: [legacyCustomSet], activeConfigSetId: 'default' };
    const store = new ConfigStore();

    store.update({
      configSets: store.getAll().configSets.map((set) => ({
        ...set,
        profiles: {
          'custom:anthropic': { apiKey: 'other', baseUrl: 'http://elsewhere:9000', model: 'm' },
        },
      })),
    } as never);

    const config = store.getAll();
    expect(config.baseUrl).toBe('http://old-gw:9000');
    expect(config.apiKey).toBe('k');
    expect(config.customEndpoints.map((e) => e.baseUrl)).toEqual(['http://old-gw:9000']);
    expect(config.configSets[0]).not.toHaveProperty('profiles');
  });

  it('keeps a CRUD-created endpoint across a config-set save', () => {
    // A user-created endpoint is referenced by no set, so anything that pruned
    // "unreferenced" entries would delete it and its API key on the next save.
    const store = new ConfigStore();
    store.createCustomEndpoint({
      name: 'standalone',
      protocol: 'openai',
      baseUrl: 'http://standalone:9000',
      apiKey: 'own',
    });

    store.update({ configSets: store.getAll().configSets });

    const endpoints = store.getAll().customEndpoints;
    expect(endpoints.map((e) => e.baseUrl)).toEqual(['http://standalone:9000']);
    expect(endpoints[0].apiKey).toBe('own');
  });

  it('keeps a CRUD-created endpoint while another gateway URL is rewritten', () => {
    mocks.seed = { configSets: [legacyCustomSet], activeConfigSetId: 'default' };
    const store = new ConfigStore();
    store.createCustomEndpoint({
      name: 'standalone',
      protocol: 'openai',
      baseUrl: 'http://standalone:9000',
      apiKey: 'own',
    });

    store.update({ baseUrl: 'http://new-gw:9000' });

    const endpoints = store.getAll().customEndpoints;
    expect(endpoints.map((e) => e.baseUrl).sort()).toEqual([
      'http://new-gw:9000',
      'http://standalone:9000',
    ]);
    expect(endpoints.find((e) => e.baseUrl === 'http://standalone:9000')?.apiKey).toBe('own');
  });

  it('keeps a CRUD-created endpoint across an unrelated credential write', () => {
    const store = new ConfigStore();
    store.createCustomEndpoint({
      name: 'standalone',
      protocol: 'openai',
      baseUrl: 'http://standalone:9000',
      apiKey: 'own',
    });
    store.update({ provider: 'anthropic', apiKey: 'sk-ant' });

    expect(store.getAll().customEndpoints.map((e) => e.baseUrl)).toEqual([
      'http://standalone:9000',
    ]);
  });

  it('retargets instead of duplicating when a write collides with another endpoint', () => {
    // writeCredential must apply the same protocol+URL uniqueness rule as
    // updateCustomEndpoint, or key-based lookups become last-write-wins.
    const store = new ConfigStore();
    store.createCustomEndpoint({ name: 'A', protocol: 'anthropic', baseUrl: 'http://gw:9000' });
    const second = store.createCustomEndpoint({
      name: 'B',
      protocol: 'openai',
      baseUrl: 'http://gw:9000',
    });
    const bId = second.customEndpoints.find((e) => e.protocol === 'openai')?.id;

    // Pin the set to A, then write a credential whose protocol matches B.
    store.update({ provider: 'custom', customProtocol: 'anthropic', baseUrl: 'http://gw:9000' });
    store.update({
      provider: 'custom',
      customProtocol: 'openai',
      baseUrl: 'http://gw:9000',
      apiKey: 'kx',
    });

    const config = store.getAll();
    expect(config.customEndpoints).toHaveLength(2);
    const keys = config.customEndpoints.map((e) => `${e.protocol}|${e.baseUrl}`).sort();
    expect(keys).toEqual(['anthropic|http://gw:9000', 'openai|http://gw:9000']);
    expect(config.configSets.find((s) => s.id === config.activeConfigSetId)?.endpointId).toBe(bId);
    expect(config.apiKey).toBe('kx');
  });
});

describe('Phase 2b — the write path no longer carries profiles', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  /**
   * The exact payload `handleSave` sends after Phase 2b: top-level provider /
   * credential / model fields, and **no** `profiles` or `activeProfileKey`.
   */
  function handleSavePayload(fields: Record<string, unknown>) {
    return {
      activeConfigSetId: 'default',
      enableThinking: false,
      thinkingLevel: 'off' as const,
      ...fields,
    };
  }

  it('persists a catalog credential from the slimmed payload', () => {
    const store = new ConfigStore();
    store.update(
      handleSavePayload({
        provider: 'anthropic',
        apiKey: 'sk-ant',
        baseUrl: 'https://api.anthropic.com',
        customProtocol: 'anthropic',
        model: 'claude-opus-5',
      }) as never
    );

    const config = store.getAll();
    expect(config.apiKey).toBe('sk-ant');
    expect(config.model).toBe('claude-opus-5');
    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-ant');
  });

  it('mints and pins a custom endpoint from the slimmed payload', () => {
    const store = new ConfigStore();
    store.update(
      handleSavePayload({
        provider: 'custom',
        customProtocol: 'anthropic',
        apiKey: 'gw-key',
        baseUrl: 'http://127.0.0.1:9000',
        model: 'claude-opus-5',
      }) as never
    );

    const config = store.getAll();
    expect(config.customEndpoints).toHaveLength(1);
    expect(config.apiKey).toBe('gw-key');
    expect(config.configSets[0].endpointId).toBe(config.customEndpoints[0].id);
  });

  it('rotates a shared key across sets without a profiles payload', () => {
    const store = new ConfigStore();
    const payload = {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      customProtocol: 'anthropic',
      model: 'claude-opus-5',
    };
    store.update(handleSavePayload({ ...payload, apiKey: 'ANT-V1' }) as never);
    store.createSet({ name: 'Second', mode: 'blank' });
    expect(store.getAll().apiKey).toBe('ANT-V1');

    store.update(handleSavePayload({ ...payload, apiKey: 'ANT-V2' }) as never);
    store.switchSet({ id: 'default' });

    expect(store.getAll().apiKey).toBe('ANT-V2');
  });

  it('keeps every saved credential in the store the renderer hydrates from', () => {
    // The form reads `providerCredentials` directly, so a key saved while one
    // provider was active must still be there after the set moves to another.
    const store = new ConfigStore();
    store.update(
      handleSavePayload({
        provider: 'anthropic',
        apiKey: 'ANT',
        customProtocol: 'anthropic',
        model: 'm',
      }) as never
    );
    store.update(
      handleSavePayload({
        provider: 'openai',
        apiKey: 'OAI',
        customProtocol: 'openai',
        model: 'gpt-5.4',
      }) as never
    );

    const config = store.getAll();
    expect(config.providerCredentials.anthropic?.apiKey).toBe('ANT');
    expect(config.providerCredentials.openai?.apiKey).toBe('OAI');
  });

  it('renders a profiles payload wholly inert (§9.4)', () => {
    // Nothing sends this any more and the type no longer has it, but the
    // invariant has to hold against a caller that supplies it anyway. It must
    // reach neither the credential nor the projection, and must not be stored.
    const store = new ConfigStore();
    store.update(
      handleSavePayload({
        provider: 'anthropic',
        apiKey: 'AUTHORITATIVE',
        customProtocol: 'anthropic',
        model: 'm',
      }) as never
    );

    store.update({
      profiles: {
        anthropic: { apiKey: 'FROM-PROFILES', baseUrl: '', model: 'm' },
      },
    } as never);

    const config = store.getAll();
    expect(config.providerCredentials.anthropic?.apiKey).toBe('AUTHORITATIVE');
    expect(config.apiKey).toBe('AUTHORITATIVE');
    expect(config).not.toHaveProperty('profiles');
    expect(config.configSets[0]).not.toHaveProperty('profiles');
    expect(JSON.stringify(config)).not.toContain('FROM-PROFILES');
  });

  it('does not invent a credential slot from a profiles payload', () => {
    // A slot the store never knew about must stay unknown — the payload cannot
    // introduce one, only fail to change existing ones.
    const store = new ConfigStore();
    store.update(
      handleSavePayload({
        provider: 'anthropic',
        apiKey: 'REAL',
        customProtocol: 'anthropic',
        model: 'm',
      }) as never
    );

    store.update({
      profiles: { 'native:zai': { apiKey: 'INVENTED', baseUrl: '', model: 'glm-5' } },
    } as never);

    expect(store.getAll().providerCredentials['native:zai']).toBeUndefined();
    expect(JSON.stringify(store.getAll())).not.toContain('INVENTED');
  });

  it('treats a profiles-only payload as a no-op, without churning updatedAt', () => {
    // `profiles` is not in the `mutatesActiveSet` trigger: rewriting the set for a
    // payload that cannot change anything only moved its timestamp.
    const store = new ConfigStore();
    store.update(
      handleSavePayload({
        provider: 'anthropic',
        apiKey: 'k',
        customProtocol: 'anthropic',
        model: 'm',
      }) as never
    );
    const before = store.getAll().configSets[0].updatedAt;

    store.update({
      profiles: { anthropic: { apiKey: 'k', baseUrl: '', model: 'm' } },
    } as never);

    expect(store.getAll().configSets[0].updatedAt).toBe(before);
  });
});

describe('migration — derive, never invent (§5)', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  /** A pre-split config: credentials inside each set's profiles, no top-level model. */
  const legacyConfig = {
    configSets: [
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: {
          anthropic: {
            apiKey: 'sk-ant-legacy',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-opus-5',
          },
        },
        enableThinking: false,
        thinkingLevel: 'off',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'set-2',
        name: 'Gateway',
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        profiles: {
          'custom:anthropic': {
            apiKey: 'gw-legacy',
            baseUrl: 'http://127.0.0.1:9000',
            model: 'claude-opus-5',
          },
        },
        enableThinking: false,
        thinkingLevel: 'off',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    activeConfigSetId: 'default',
  };

  it('migrates a legacy config to the same effective projection', () => {
    mocks.seed = { ...legacyConfig };
    const config = new ConfigStore().getAll();

    expect(config.apiKey).toBe('sk-ant-legacy');
    expect(config.model).toBe('claude-opus-5');
    expect(config.providerCredentials.anthropic?.apiKey).toBe('sk-ant-legacy');
  });

  it('links a legacy custom set to the endpoint derived from its own profile', () => {
    mocks.seed = { ...legacyConfig, activeConfigSetId: 'set-2' };
    const config = new ConfigStore().getAll();

    const gatewaySet = config.configSets.find((s) => s.id === 'set-2');
    expect(gatewaySet?.endpointId).toBeTruthy();
    expect(config.customEndpoints).toHaveLength(1);
    expect(gatewaySet?.endpointId).toBe(config.customEndpoints[0].id);
    // And it resolves end-to-end through the new seam.
    expect(config.apiKey).toBe('gw-legacy');
    expect(config.baseUrl).toBe('http://127.0.0.1:9000');
  });

  it('hoists model out of the active profile for sets predating the split', () => {
    mocks.seed = { ...legacyConfig };
    const config = new ConfigStore().getAll();

    expect(config.configSets.find((s) => s.id === 'default')?.model).toBe('claude-opus-5');
  });

  it('preserves every set id and the active id — no SQLite data migration', () => {
    mocks.seed = { ...legacyConfig };
    const config = new ConfigStore().getAll();

    expect(config.configSets.map((s) => s.id)).toEqual(['default', 'set-2']);
    expect(config.activeConfigSetId).toBe('default');
    expect(config.configSets.find((s) => s.id === 'default')?.isSystem).toBe(true);
  });

  it('is idempotent — a second normalize mints no second endpoint', () => {
    mocks.seed = { ...legacyConfig };
    const first = new ConfigStore().getAll();
    mocks.seed = { ...first } as unknown as Record<string, unknown>;
    const second = new ConfigStore().getAll();

    expect(second.customEndpoints).toHaveLength(first.customEndpoints.length);
    expect(second.customEndpoints.map((e) => e.id)).toEqual(first.customEndpoints.map((e) => e.id));
    expect(second.providerCredentials).toEqual(first.providerCredentials);
  });

  it('resolves the lossy case deterministically, active set first', () => {
    mocks.seed = {
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'key-default', baseUrl: '', model: 'm' } },
        },
        {
          id: 'set-2',
          name: 'Work',
          provider: 'anthropic',
          activeProfileKey: 'anthropic',
          profiles: { anthropic: { apiKey: 'key-work', baseUrl: '', model: 'm' } },
        },
      ],
      activeConfigSetId: 'set-2',
    };

    // Documented as lossy (decision #2): one key wins, and which one is stable.
    expect(new ConfigStore().getAll().providerCredentials.anthropic?.apiKey).toBe('key-work');
  });

  it('round-trips a native:<id> credential', () => {
    mocks.seed = {
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'zai',
          activeProfileKey: 'native:zai',
          profiles: { 'native:zai': { apiKey: 'zai-secret', baseUrl: '', model: 'glm-5' } },
        },
      ],
      activeConfigSetId: 'default',
    };

    const config = new ConfigStore().getAll();

    expect(config.providerCredentials['native:zai']?.apiKey).toBe('zai-secret');
    expect(config.apiKey).toBe('zai-secret');
  });

  it('keeps the keyless Ollama slot and its discovered base URL', () => {
    const store = new ConfigStore();
    store.update({ provider: 'ollama', baseUrl: 'http://192.168.1.50:11434/v1', model: 'qwen3.5' });

    const config = store.getAll();

    expect(config.providerCredentials.ollama?.baseUrl).toBe('http://192.168.1.50:11434/v1');
    expect(config.baseUrl).toBe('http://192.168.1.50:11434/v1');
    expect(config.apiKey).toBe('');
  });
});

describe('custom endpoint CRUD (§3.2)', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('creates, updates and deletes an endpoint', () => {
    const store = new ConfigStore();
    let config = store.createCustomEndpoint({
      name: 'kiro',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
      apiKey: 'k',
    });
    expect(config.customEndpoints).toHaveLength(1);
    const id = config.customEndpoints[0].id;

    config = store.updateCustomEndpoint({ id, name: 'kiro-gateway', apiKey: 'k2' });
    expect(config.customEndpoints[0].name).toBe('kiro-gateway');
    expect(config.customEndpoints[0].apiKey).toBe('k2');

    config = store.deleteCustomEndpoint({ id });
    expect(config.customEndpoints).toEqual([]);
  });

  it('refuses to delete an endpoint a config set references', () => {
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'kiro',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
      apiKey: 'k',
    });
    const id = created.customEndpoints[0].id;
    store.update({
      provider: 'custom',
      customProtocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
    });

    // Enforced in the store, not only the UI, so IPC cannot strand a set.
    expect(() => store.deleteCustomEndpoint({ id })).toThrow(/in use by config set/i);
    expect(store.getAll().customEndpoints).toHaveLength(1);
  });

  it('keeps a set pinned when CRUD changes the endpoint URL', () => {
    // The endpoint is authoritative on read. An earlier revision let the set's
    // stale `custom:*` mirror override a live pin, so the next read derived a twin
    // at the old URL and silently retargeted the set back to it.
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'gw',
      protocol: 'anthropic',
      baseUrl: 'http://old:9000',
      apiKey: 'k',
    });
    const endpointId = created.customEndpoints[0].id;
    store.update({ provider: 'custom', customProtocol: 'anthropic', baseUrl: 'http://old:9000' });

    store.updateCustomEndpoint({ id: endpointId, baseUrl: 'http://new:9000' });

    const config = store.getAll();
    expect(config.customEndpoints.map((e) => e.baseUrl)).toEqual(['http://new:9000']);
    expect(config.configSets[0].endpointId).toBe(endpointId);
    expect(config.baseUrl).toBe('http://new:9000');
  });

  it('stays deleted when a leftover profile still mirrors the endpoint', () => {
    // Delete has to scrub the legacy mirrors too, or derivation resurrects the
    // endpoint (with a fresh id and the key off the profile) on the next read.
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'gw',
      protocol: 'anthropic',
      baseUrl: 'http://gw:9000',
      apiKey: 'k',
    });
    const endpointId = created.customEndpoints[0].id;
    store.update({ provider: 'custom', customProtocol: 'anthropic', baseUrl: 'http://gw:9000' });
    store.update({ provider: 'anthropic', apiKey: 'sk-ant' }); // unpin by switching away

    store.deleteCustomEndpoint({ id: endpointId });

    expect(store.getAll().customEndpoints).toEqual([]);
    // …and it stays gone across a reload.
    mocks.seed = { ...store.getAll() } as unknown as Record<string, unknown>;
    expect(new ConfigStore().getAll().customEndpoints).toEqual([]);
  });

  it('does not reset an endpoint protocol when only a key is written', () => {
    // `update({ apiKey })` carries the set's legacy `customProtocol`, which can
    // have diverged from the endpoint. Writing it implicitly would reset the
    // protocol as a side effect of rotating a key.
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'gw',
      protocol: 'openai',
      baseUrl: 'http://gw:9000',
      apiKey: 'k1',
    });
    const endpointId = created.customEndpoints[0].id;
    store.update({
      configSets: store.getAll().configSets.map((set) => ({
        ...set,
        provider: 'custom',
        customProtocol: 'anthropic', // diverged mirror
        endpointId,
      })),
    });

    store.update({ apiKey: 'k2' });

    const endpoint = store.getAll().customEndpoints.find((e) => e.id === endpointId);
    expect(endpoint?.protocol).toBe('openai');
    expect(endpoint?.apiKey).toBe('k2');
  });

  it('still applies an explicit protocol change', () => {
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'gw',
      protocol: 'anthropic',
      baseUrl: 'http://gw:9000',
      apiKey: 'k',
    });
    const endpointId = created.customEndpoints[0].id;
    store.update({ provider: 'custom', customProtocol: 'anthropic', baseUrl: 'http://gw:9000' });

    store.update({ provider: 'custom', customProtocol: 'openai' });

    expect(store.getAll().customEndpoints.find((e) => e.id === endpointId)?.protocol).toBe(
      'openai'
    );
    expect(store.getAll().customProtocol).toBe('openai');
  });

  it('clears an endpoint key through CRUD and keeps it cleared across a reload', () => {
    // Endpoint keys need the same empty-vs-missing rule as catalog slots: a
    // cleared key must not be refilled from any set's leftover `custom:*` mirror.
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'gw',
      protocol: 'anthropic',
      baseUrl: 'http://gw:9000',
      apiKey: 'OLD',
    });
    const endpointId = created.customEndpoints[0].id;
    store.update({ provider: 'custom', customProtocol: 'anthropic', baseUrl: 'http://gw:9000' });

    store.updateCustomEndpoint({ id: endpointId, apiKey: '' });

    expect(store.getAll().customEndpoints[0].apiKey).toBe('');
    expect(store.getAll().apiKey).toBe('');

    mocks.seed = { ...store.getAll() } as unknown as Record<string, unknown>;
    const reloaded = new ConfigStore().getAll();
    expect(reloaded.customEndpoints[0].apiKey).toBe('');
    expect(reloaded.apiKey).toBe('');
  });

  it('clears a custom endpoint key through update({ apiKey }) and it stays cleared', () => {
    const store = new ConfigStore();
    store.update({
      provider: 'custom',
      customProtocol: 'anthropic',
      baseUrl: 'http://gw:9000',
      apiKey: 'OLD',
      model: 'm',
    });

    store.update({ apiKey: '' });

    expect(store.getAll().customEndpoints[0].apiKey).toBe('');
    mocks.seed = { ...store.getAll() } as unknown as Record<string, unknown>;
    expect(new ConfigStore().getAll().customEndpoints[0].apiKey).toBe('');
  });

  it('keeps a keyless local gateway usable after its key is cleared', () => {
    // A loopback anthropic gateway is usable without a key, so clearing one must
    // actually be possible rather than being silently undone.
    const store = new ConfigStore();
    store.update({
      provider: 'custom',
      customProtocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:8082',
      apiKey: 'leftover',
      model: 'm',
    });

    store.update({ apiKey: '' });

    expect(store.getAll().apiKey).toBe('');
    expect(store.hasUsableCredentialsForActiveSet()).toBe(true);
  });

  it('rejects a duplicate protocol + base URL', () => {
    const store = new ConfigStore();
    store.createCustomEndpoint({
      name: 'a',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
    });

    expect(() =>
      store.createCustomEndpoint({
        name: 'b',
        protocol: 'anthropic',
        baseUrl: 'http://127.0.0.1:9000/',
      })
    ).toThrow(/already exists/i);
  });

  it('allows the same base URL under a different protocol', () => {
    const store = new ConfigStore();
    store.createCustomEndpoint({ name: 'a', protocol: 'anthropic', baseUrl: 'http://gw:9000' });
    const config = store.createCustomEndpoint({
      name: 'b',
      protocol: 'openai',
      baseUrl: 'http://gw:9000',
    });

    expect(config.customEndpoints).toHaveLength(2);
  });

  it('requires a base URL', () => {
    const store = new ConfigStore();
    expect(() =>
      store.createCustomEndpoint({ name: 'a', protocol: 'anthropic', baseUrl: '   ' })
    ).toThrow(/base URL is required/i);
  });

  it('refuses to clear the address of an existing endpoint, and changes nothing', () => {
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'gw',
      protocol: 'anthropic',
      baseUrl: 'http://gw:9000',
      apiKey: 'k',
    });
    const id = created.customEndpoints[0].id;

    expect(() => store.updateCustomEndpoint({ id, baseUrl: '   ', apiKey: 'other' })).toThrow(
      /base URL is required/i
    );
    expect(store.getAll().customEndpoints[0]).toMatchObject({
      baseUrl: 'http://gw:9000',
      apiKey: 'k',
    });
  });

  it('enforces its own cap, distinguishable from the config-set cap', () => {
    const store = new ConfigStore();
    for (let i = 0; i < 20; i += 1) {
      store.createCustomEndpoint({
        name: `gw-${i}`,
        protocol: 'anthropic',
        baseUrl: `http://gw-${i}:9000`,
      });
    }

    expect(() =>
      store.createCustomEndpoint({
        name: 'over',
        protocol: 'anthropic',
        baseUrl: 'http://over:9000',
      })
    ).toThrow(/Custom endpoint limit reached: max 20/);
  });

  it('rejects an unknown endpoint id', () => {
    const store = new ConfigStore();
    expect(() => store.updateCustomEndpoint({ id: 'nope', name: 'x' })).toThrow(/not found/i);
    expect(() => store.deleteCustomEndpoint({ id: 'nope' })).toThrow(/not found/i);
  });

  it('stores defaultModel and can clear it', () => {
    const store = new ConfigStore();
    const created = store.createCustomEndpoint({
      name: 'gw',
      protocol: 'anthropic',
      baseUrl: 'http://gw:9000',
      defaultModel: 'claude-opus-5',
    });
    expect(created.customEndpoints[0].defaultModel).toBe('claude-opus-5');

    const cleared = store.updateCustomEndpoint({
      id: created.customEndpoints[0].id,
      defaultModel: '',
    });
    expect(cleared.customEndpoints[0].defaultModel).toBeUndefined();
  });
});
