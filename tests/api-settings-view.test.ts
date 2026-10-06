/**
 * What the Providers and Model Sets tabs show
 * (`src/renderer/hooks/api-settings-view.ts`): the entries of the provider
 * chooser on a config set, the status of each credential, which config sets use
 * what, and the payloads the two dialogs send.
 *
 * The screens themselves are thin; the decisions are here, where they can be
 * tested without a browser.
 */
import { describe, expect, it } from 'vitest';
import type { ApiConfigSet, CustomEndpoint } from '../src/renderer/types';
import { BUILTIN_ENTRIES, type ProviderCatalogEntry } from '../src/shared/provider-catalog';
import { FALLBACK_PROVIDER_PRESETS } from '../src/renderer/hooks/api-config-shared';
import {
  buildCreateEndpointPayload,
  buildEndpointRows,
  buildProviderChoices,
  buildProviderCredentialPayload,
  buildProviderRowGroups,
  buildUpdateEndpointPayload,
  checkEndpointForm,
  createdEndpointId,
  endpointCredentialStatus,
  endpointFormValues,
  parseProviderChoice,
  persistedCredentialFor,
  providerChoiceId,
  providerCredentialStatus,
  providerNeedsKey,
  runtimeOf,
  storedProviderCredential,
  type EndpointFormValues,
} from '../src/renderer/hooks/api-settings-view';

const presets = FALLBACK_PROVIDER_PRESETS;

/** A native provider that needs no key, as the registry describes some. */
const keylessNative: ProviderCatalogEntry = {
  id: 'localai',
  name: 'LocalAI',
  kind: 'native',
  category: 'inference',
  piProvider: 'localai',
  routeProtocol: 'openai',
  formShape: {
    apiKey: false,
    baseUrl: true,
    protocol: false,
    contextWindow: false,
    modelDropdown: true,
    manualModelToggle: false,
  },
  modelOptions: [],
};
const zai: ProviderCatalogEntry = {
  id: 'zai',
  name: 'z.ai',
  kind: 'native',
  category: 'coding-plan',
  piProvider: 'zai',
  routeProtocol: 'openai',
  regionTag: 'CN',
  formShape: {
    apiKey: true,
    baseUrl: false,
    protocol: false,
    contextWindow: false,
    modelDropdown: true,
    manualModelToggle: false,
  },
  modelOptions: [],
};
const catalog: ProviderCatalogEntry[] = [...BUILTIN_ENTRIES, zai, keylessNative];

function endpoint(overrides: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-endpoint-1',
    name: 'kiro-gateway',
    protocol: 'anthropic',
    baseUrl: 'http://127.0.0.1:9000',
    apiKey: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function set(overrides: Partial<ApiConfigSet>): ApiConfigSet {
  return {
    id: 'default',
    name: 'Default',
    isSystem: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    enableThinking: false,
    thinkingLevel: 'off',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const local = endpoint({});
const hosted = endpoint({
  id: 'custom-endpoint-2',
  name: 'hosted-gateway',
  protocol: 'openai',
  baseUrl: 'https://gateway.example.com/v1',
  apiKey: 'gw-key',
});

describe('the id of a chooser entry', () => {
  it('names a catalog provider by its id and a custom endpoint by its own', () => {
    expect(providerChoiceId('anthropic', '')).toBe('provider:anthropic');
    expect(providerChoiceId('custom', 'custom-endpoint-2')).toBe('endpoint:custom-endpoint-2');
    // An endpoint id means nothing on a catalog provider.
    expect(providerChoiceId('anthropic', 'custom-endpoint-2')).toBe('provider:anthropic');
  });

  it('reads back what it wrote', () => {
    expect(parseProviderChoice('provider:zai')).toEqual({ provider: 'zai', endpointId: '' });
    expect(parseProviderChoice('endpoint:custom-endpoint-2')).toEqual({
      provider: 'custom',
      endpointId: 'custom-endpoint-2',
    });
  });

  it('gives a custom set with no endpoint an id of its own', () => {
    expect(providerChoiceId('custom', '')).toBe('provider:custom');
    expect(parseProviderChoice('provider:custom')).toEqual({ provider: 'custom', endpointId: '' });
  });

  it('refuses anything else', () => {
    expect(parseProviderChoice('')).toBeNull();
    expect(parseProviderChoice('endpoint:')).toBeNull();
    expect(parseProviderChoice('custom-endpoint-2')).toBeNull();
    expect(parseProviderChoice('provider:')).toBeNull();
  });
});

describe('the status of a credential', () => {
  it('reads a provider with a key as configured, whether or not a set uses it', () => {
    expect(
      providerCredentialStatus('anthropic', catalog, { anthropic: { apiKey: 'sk' } }, [])
    ).toBe('configured');
  });

  it('reads a provider a set runs on, with no key, as missing its key', () => {
    expect(providerCredentialStatus('anthropic', catalog, {}, [set({})])).toBe('key-missing');
    expect(
      providerCredentialStatus('anthropic', catalog, { anthropic: { apiKey: '  ' } }, [set({})])
    ).toBe('key-missing');
  });

  it('reads a provider nothing uses, with no key, as not set', () => {
    expect(providerCredentialStatus('openai', catalog, {}, [set({})])).toBe('not-set');
  });

  it('never reports a missing key for a provider that needs none', () => {
    expect(providerNeedsKey('ollama', catalog)).toBe(false);
    expect(providerNeedsKey('localai', catalog)).toBe(false);
    expect(providerNeedsKey('zai', catalog)).toBe(true);
    expect(providerNeedsKey('anthropic', catalog)).toBe(true);

    expect(providerCredentialStatus('ollama', catalog, {}, [])).toBe('not-set');
    expect(providerCredentialStatus('ollama', catalog, {}, [set({ provider: 'ollama' })])).toBe(
      'configured'
    );
    expect(
      providerCredentialStatus(
        'ollama',
        catalog,
        { ollama: { apiKey: '', baseUrl: 'http://box:11434/v1' } },
        []
      )
    ).toBe('configured');
    expect(providerCredentialStatus('localai', catalog, {}, [set({ provider: 'localai' })])).toBe(
      'configured'
    );
  });

  it('lets a gateway on this machine run without a key, but not a remote one', () => {
    expect(endpointCredentialStatus(local)).toBe('configured');
    expect(endpointCredentialStatus(hosted)).toBe('configured');
    expect(endpointCredentialStatus({ ...hosted, apiKey: '' })).toBe('key-missing');
  });
});

describe('the credential a config set runs with', () => {
  const credentials = {
    providerCredentials: { anthropic: { apiKey: 'sk-ant' } },
    customEndpoints: [local, hosted],
  };

  it('is the provider slot for a catalog provider, on its usual address', () => {
    expect(persistedCredentialFor('anthropic', '', credentials, presets)).toEqual({
      apiKey: 'sk-ant',
      baseUrl: presets.anthropic.baseUrl,
      protocol: 'anthropic',
    });
  });

  it('is the endpoint itself for a custom set', () => {
    expect(persistedCredentialFor('custom', hosted.id, credentials, presets)).toEqual({
      apiKey: 'gw-key',
      baseUrl: 'https://gateway.example.com/v1',
      protocol: 'openai',
    });
    expect(runtimeOf('custom', hosted.id, credentials, presets)).toEqual({
      customProtocol: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
    });
  });

  it('is empty for a custom set that points at no endpoint, never a default address', () => {
    // The runtime resolves such a set to nothing. Showing the protocol's usual
    // address here would claim the set runs somewhere it does not.
    for (const endpointId of ['', 'custom-endpoint-9']) {
      expect(persistedCredentialFor('custom', endpointId, credentials, presets)).toEqual({
        apiKey: '',
        baseUrl: '',
        protocol: 'anthropic',
      });
    }
  });

  it('never reads another provider key for one that has none', () => {
    expect(persistedCredentialFor('openai', '', credentials, presets).apiKey).toBe('');
  });
});

describe('the entries of the provider chooser', () => {
  const credentials = {
    providerCredentials: { anthropic: { apiKey: 'sk-ant' } },
    customEndpoints: [local, hosted],
  };
  const choices = buildProviderChoices({ catalog, credentials, configSets: [set({})] });

  it('lists every custom endpoint by name, each as its own entry', () => {
    // Two gateways used to be one indistinguishable "Custom".
    expect(choices.filter((choice) => choice.kind === 'endpoint')).toEqual([
      {
        id: 'endpoint:custom-endpoint-1',
        kind: 'endpoint',
        label: 'kiro-gateway',
        group: 'endpoints',
        badge: 'anthropic',
        status: 'configured',
      },
      {
        id: 'endpoint:custom-endpoint-2',
        kind: 'endpoint',
        label: 'hosted-gateway',
        group: 'endpoints',
        badge: 'openai',
        status: 'configured',
      },
    ]);
  });

  it('puts the endpoints first, then the catalog in its usual grouping', () => {
    expect(choices.slice(0, 2).every((choice) => choice.group === 'endpoints')).toBe(true);
    const groups = [...new Set(choices.map((choice) => choice.group))];
    expect(groups).toEqual(['endpoints', 'featured', 'coding-plan', 'inference', 'local']);
  });

  it('leaves out the bare "Custom": a set cannot run on it without an endpoint', () => {
    expect(choices.some((choice) => choice.id === 'provider:custom')).toBe(false);
    expect(choices.some((choice) => choice.group === 'custom')).toBe(false);
  });

  it('carries each entry status and a provider region tag', () => {
    const byId = new Map(choices.map((choice) => [choice.id, choice]));
    expect(byId.get('provider:anthropic')?.status).toBe('configured');
    expect(byId.get('provider:openai')?.status).toBe('not-set');
    expect(byId.get('provider:zai')?.badge).toBe('CN');
  });

  it('adds an entry for a custom set that points at no endpoint, and only then', () => {
    const unpinned = buildProviderChoices({
      catalog,
      credentials,
      configSets: [],
      current: { provider: 'custom', endpointId: '' },
    });
    expect(unpinned[0]).toMatchObject({ id: 'provider:custom', kind: 'no-endpoint' });

    const dangling = buildProviderChoices({
      catalog,
      credentials,
      configSets: [],
      current: { provider: 'custom', endpointId: 'custom-endpoint-9' },
    });
    expect(dangling[0].kind).toBe('no-endpoint');

    for (const current of [
      { provider: 'custom', endpointId: local.id },
      { provider: 'anthropic', endpointId: '' },
    ]) {
      const pinned = buildProviderChoices({ catalog, credentials, configSets: [], current });
      expect(pinned.some((choice) => choice.kind === 'no-endpoint')).toBe(false);
    }
  });
});

describe('the rows of the Providers tab', () => {
  const configSets = [
    set({ id: 'a', name: 'Local', provider: 'custom', endpointId: local.id }),
    set({ id: 'b', name: 'Also local', provider: 'custom', endpointId: local.id }),
    set({ id: 'c', name: 'Work', provider: 'anthropic' }),
  ];

  it('says which config sets use each endpoint', () => {
    const rows = buildEndpointRows([local, hosted], configSets);

    expect(rows.map((row) => [row.endpoint.name, row.usedBy])).toEqual([
      ['kiro-gateway', ['Local', 'Also local']],
      ['hosted-gateway', []],
    ]);
  });

  it('groups the catalog providers and says which config sets use each', () => {
    const groups = buildProviderRowGroups(catalog, {}, configSets);

    expect(groups.map((group) => group.category)).toEqual([
      'featured',
      'coding-plan',
      'inference',
      'local',
    ]);
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.some((row) => row.entry.id === 'custom')).toBe(false);
    const anthropic = rows.find((row) => row.entry.id === 'anthropic');
    expect(anthropic?.usedBy).toEqual(['Work']);
    expect(anthropic?.status).toBe('key-missing');
  });

  it('finds the endpoint a create call added, to confirm the save on its row', () => {
    expect(createdEndpointId([local], [local, hosted])).toBe(hosted.id);
    expect(createdEndpointId([], [local])).toBe(local.id);
    // Nothing new: main reused an existing one, or the list did not change.
    expect(createdEndpointId([local, hosted], [local, hosted])).toBeNull();
  });

  it('does not count a catalog set as a user of an endpoint it once pointed at', () => {
    const rows = buildEndpointRows(
      [local],
      [set({ provider: 'anthropic', endpointId: local.id } as Partial<ApiConfigSet>)]
    );
    expect(rows[0].usedBy).toEqual([]);
  });
});

describe('the endpoint dialog', () => {
  const values = (overrides: Partial<EndpointFormValues>): EndpointFormValues => ({
    name: '',
    protocol: 'anthropic',
    baseUrl: '',
    apiKey: '',
    defaultModel: '',
    ...overrides,
  });

  it('opens a new endpoint with an empty address on the protocol asked for', () => {
    expect(endpointFormValues(null, 'openai')).toEqual(values({ protocol: 'openai' }));
  });

  it('opens an existing endpoint on its own values', () => {
    expect(endpointFormValues({ ...hosted, defaultModel: 'gpt-5.4' }, 'anthropic')).toEqual({
      name: 'hosted-gateway',
      protocol: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'gw-key',
      defaultModel: 'gpt-5.4',
    });
  });

  it('asks for an address', () => {
    expect(checkEndpointForm(values({ baseUrl: '   ' }), [], null)).toBe('missing_base_url');
  });

  it('refuses an address another endpoint already has on the same protocol', () => {
    const taken = values({ protocol: 'openai', baseUrl: 'https://GATEWAY.example.com/v1/' });

    expect(checkEndpointForm(taken, [local, hosted], null)).toBe('duplicate');
    expect(checkEndpointForm(taken, [local, hosted], local.id)).toBe('duplicate');
  });

  it('accepts an endpoint keeping its own address, and the same address on another protocol', () => {
    const own = values({ protocol: 'openai', baseUrl: 'https://gateway.example.com/v1' });
    expect(checkEndpointForm(own, [local, hosted], hosted.id)).toBeNull();

    const otherProtocol = values({ protocol: 'gemini', baseUrl: 'https://gateway.example.com/v1' });
    expect(checkEndpointForm(otherProtocol, [local, hosted], null)).toBeNull();
  });

  it('creates an endpoint with the address in canonical form and no empty fields', () => {
    expect(
      buildCreateEndpointPayload(
        values({ name: '  ', baseUrl: ' http://LocalHost:9000/ ', apiKey: ' key ' })
      )
    ).toEqual({ name: '', protocol: 'anthropic', baseUrl: 'http://localhost:9000', apiKey: 'key' });

    expect(
      buildCreateEndpointPayload(
        values({ name: 'gw', baseUrl: 'http://gw:1', defaultModel: ' claude-opus-5 ' })
      )
    ).toMatchObject({ name: 'gw', defaultModel: 'claude-opus-5' });
  });

  it('always sends the default model on an update, so clearing it takes effect', () => {
    expect(
      buildUpdateEndpointPayload(hosted.id, values({ name: 'renamed', baseUrl: 'https://gw/v1' }))
    ).toEqual({
      id: 'custom-endpoint-2',
      name: 'renamed',
      protocol: 'anthropic',
      baseUrl: 'https://gw/v1',
      apiKey: '',
      defaultModel: '',
    });
  });
});

describe('the provider dialog', () => {
  it('opens on the credential as it is stored, with no usual address standing in', () => {
    // Where a set would run, a provider without an address of its own reads as
    // its usual one. The dialog must not: Save writes its fields back, so the
    // usual address would be stored as if the user had typed it.
    const keyOnly = { ollama: { apiKey: '' }, anthropic: { apiKey: 'sk-ant' } };

    expect(
      persistedCredentialFor(
        'ollama',
        '',
        { providerCredentials: keyOnly, customEndpoints: [] },
        presets
      ).baseUrl
    ).toBe(presets.ollama.baseUrl);
    expect(storedProviderCredential('ollama', keyOnly)).toEqual({ apiKey: '', baseUrl: '' });
    expect(storedProviderCredential('anthropic', keyOnly)).toEqual({
      apiKey: 'sk-ant',
      baseUrl: '',
    });
    expect(storedProviderCredential('openai', keyOnly)).toEqual({ apiKey: '', baseUrl: '' });
  });

  it('opens on an address the user did give', () => {
    expect(
      storedProviderCredential('ollama', {
        ollama: { apiKey: '', baseUrl: ' http://box:11434/v1 ' },
      })
    ).toEqual({ apiKey: '', baseUrl: 'http://box:11434/v1' });
  });

  it('saves nothing as the address when the dialog is opened and saved untouched', () => {
    const opened = storedProviderCredential('ollama', {});

    expect(
      buildProviderCredentialPayload({ provider: 'ollama', ...opened, showsBaseUrl: true })
    ).toEqual({ provider: 'ollama', apiKey: '', baseUrl: '' });
  });

  it('sends no address for a provider that has no address field', () => {
    // Main then keeps what it has. Sending the preset would store the
    // provider's own default as an override.
    expect(
      buildProviderCredentialPayload({
        provider: 'anthropic',
        apiKey: ' sk-ant ',
        baseUrl: 'https://api.anthropic.com',
        showsBaseUrl: false,
      })
    ).toEqual({ provider: 'anthropic', apiKey: 'sk-ant' });
  });

  it('sends the address typed for one that has, and an empty one to remove an override', () => {
    expect(
      buildProviderCredentialPayload({
        provider: 'ollama',
        apiKey: '',
        baseUrl: ' http://box:11434 ',
        showsBaseUrl: true,
      })
    ).toEqual({ provider: 'ollama', apiKey: '', baseUrl: 'http://box:11434' });

    expect(
      buildProviderCredentialPayload({
        provider: 'ollama',
        apiKey: '',
        baseUrl: '',
        showsBaseUrl: true,
      })
    ).toEqual({ provider: 'ollama', apiKey: '', baseUrl: '' });
  });
});
