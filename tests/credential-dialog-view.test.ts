/**
 * What the two credential dialogs work out before they ask main for anything
 * (`src/renderer/hooks/credential-dialog-view.ts`): which ready-made setups an
 * endpoint can be filled from and what filling one in does, which model a
 * connection check tries, and how a search for a local Ollama is reported.
 *
 * No test can click a dialog, so these decisions are plain functions.
 */
import { describe, expect, it } from 'vitest';
import type { ApiConfigSet } from '../src/renderer/types';
import { COMMON_PROVIDER_SETUPS } from '../src/shared/api-provider-guidance';
import { BUILTIN_ENTRIES, type ProviderCatalogEntry } from '../src/shared/provider-catalog';
import { FALLBACK_PROVIDER_PRESETS } from '../src/renderer/hooks/api-config-shared';
import type { EndpointFormValues } from '../src/renderer/hooks/api-settings-view';
import {
  applySetupToEndpointForm,
  catalogEntryOfSetup,
  endpointCheckModel,
  endpointSetupIds,
  isEndpointSetup,
  ollamaSearchNote,
  providerCheckModel,
  providerDialogValues,
} from '../src/renderer/hooks/credential-dialog-view';

const presets = FALLBACK_PROVIDER_PRESETS;

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

const blank: EndpointFormValues = {
  name: '',
  protocol: 'anthropic',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
};

/** A native provider as the catalog built from the installed pi lists it. */
function nativeEntry(id: string, name: string): ProviderCatalogEntry {
  return {
    id,
    name,
    kind: 'native',
    category: 'coding-plan',
    piProvider: id,
    routeProtocol: 'anthropic',
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
}
const kimiCoding = nativeEntry('kimi-coding', 'Kimi (Moonshot)');
/** The catalog as it is once the installed pi has been read. */
const fullCatalog: ProviderCatalogEntry[] = [...BUILTIN_ENTRIES, kimiCoding];
/** The catalog before that, or on a pi that does not know the provider. */
const builtinOnly: ProviderCatalogEntry[] = [...BUILTIN_ENTRIES];

describe('the catalog provider a ready-made setup belongs to', () => {
  const setupOf = (id: string) => COMMON_PROVIDER_SETUPS.find((setup) => setup.id === id)!;

  it('is the provider whose own address the setup describes', () => {
    expect(catalogEntryOfSetup(setupOf('openrouter'), fullCatalog)?.id).toBe('openrouter');
    expect(catalogEntryOfSetup(setupOf('ollama'), fullCatalog)?.id).toBe('ollama');
    // Google's own address, and Kimi's coding address: the same service the
    // catalog lists, not merely the same company.
    expect(catalogEntryOfSetup(setupOf('gemini-custom'), fullCatalog)?.id).toBe('gemini');
    expect(catalogEntryOfSetup(setupOf('kimi-coding'), fullCatalog)?.name).toBe('Kimi (Moonshot)');
  });

  it('is none for a service that is only reachable as a custom endpoint', () => {
    for (const id of ['deepseek', 'glm-anthropic', 'minimax', 'generic-openai']) {
      expect(catalogEntryOfSetup(setupOf(id), fullCatalog), id).toBeNull();
    }
    expect(catalogEntryOfSetup(null, fullCatalog)).toBeNull();
    expect(catalogEntryOfSetup(undefined, fullCatalog)).toBeNull();
  });

  it('is none while the catalog does not have that provider', () => {
    // Native providers come from the installed pi and arrive after the first
    // render. Until then there is no entry to send anyone to.
    expect(catalogEntryOfSetup(setupOf('kimi-coding'), builtinOnly)).toBeNull();
    expect(catalogEntryOfSetup(setupOf('kimi-coding'), [])).toBeNull();
    // The builtin ones are there from the start.
    expect(catalogEntryOfSetup(setupOf('gemini-custom'), builtinOnly)?.id).toBe('gemini');
  });
});

describe('the ready-made setups an endpoint can be filled from', () => {
  it('leaves out those whose service is a catalog provider with an entry of its own', () => {
    const ids = endpointSetupIds(fullCatalog);

    expect([...ids].sort()).toEqual(['deepseek', 'generic-openai', 'glm-anthropic', 'minimax']);
    for (const id of ['openrouter', 'ollama', 'gemini-custom', 'kimi-coding']) {
      expect(ids.has(id), id).toBe(false);
    }
  });

  it('keeps a setup in the list while the catalog has no entry to send its address to', () => {
    const ids = endpointSetupIds(builtinOnly);

    expect(ids.has('kimi-coding')).toBe(true);
    // Never the two that apply another provider altogether, catalog or no catalog.
    expect(ids.has('openrouter')).toBe(false);
    expect(ids.has('ollama')).toBe(false);
    expect([...endpointSetupIds([])].sort()).toEqual(
      [
        'deepseek',
        'gemini-custom',
        'generic-openai',
        'glm-anthropic',
        'kimi-coding',
        'minimax',
      ].sort()
    );
  });

  it('goes by what a setup says of itself, so one added later is sorted the same way', () => {
    expect(isEndpointSetup({ applyProvider: 'custom' }, fullCatalog)).toBe(true);
    expect(isEndpointSetup({ applyProvider: 'openrouter' }, fullCatalog)).toBe(false);
    expect(
      isEndpointSetup({ applyProvider: 'custom', catalogProvider: 'kimi-coding' }, fullCatalog)
    ).toBe(false);
    expect(
      isEndpointSetup({ applyProvider: 'custom', catalogProvider: 'kimi-coding' }, builtinOnly)
    ).toBe(true);
    // Every setup that names a catalog provider is one the list leaves out
    // once the catalog has it.
    for (const setup of COMMON_PROVIDER_SETUPS) {
      if (catalogEntryOfSetup(setup, fullCatalog)) {
        expect(isEndpointSetup(setup, fullCatalog), setup.id).toBe(false);
      }
    }
  });
});

describe('filling the endpoint form from a ready-made setup', () => {
  it('sets the protocol, the address and the example model', () => {
    expect(applySetupToEndpointForm(blank, 'deepseek')).toEqual({
      name: '',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      defaultModel: 'deepseek-chat',
    });
  });

  it('leaves the name and a key already typed alone', () => {
    const typed = { ...blank, name: 'my gateway', apiKey: 'sk-typed' };
    const filled = applySetupToEndpointForm(typed, 'kimi-coding');

    expect(filled.name).toBe('my gateway');
    expect(filled.apiKey).toBe('sk-typed');
    expect(filled.protocol).toBe('openai');
    expect(filled.baseUrl).toBe('https://api.kimi.com/coding/v1');
  });

  it('keeps a model the user typed', () => {
    const filled = applySetupToEndpointForm({ ...blank, defaultModel: 'my-own-model' }, 'deepseek');
    expect(filled.defaultModel).toBe('my-own-model');
  });

  it('replaces a model left behind by an earlier setup', () => {
    // DeepSeek first, then Kimi: `deepseek-chat` belongs to the first service.
    const first = applySetupToEndpointForm(blank, 'deepseek');
    const second = applySetupToEndpointForm(first, 'kimi-coding');

    expect(second.defaultModel).toBe('kimi-k2-thinking');
    expect(second.baseUrl).toBe('https://api.kimi.com/coding/v1');
  });

  it('takes only the protocol from the generic setup, whose address is an example', () => {
    const filled = applySetupToEndpointForm(blank, 'generic-openai');
    expect(filled).toEqual({ ...blank, protocol: 'openai' });

    // An address and model already typed stay as typed.
    const typed = { ...blank, baseUrl: 'https://llm.internal/v1', defaultModel: 'house-model' };
    expect(applySetupToEndpointForm(typed, 'generic-openai')).toEqual({
      ...typed,
      protocol: 'openai',
    });
  });

  it('never puts an address nobody has into the form', () => {
    for (const setup of COMMON_PROVIDER_SETUPS) {
      const filled = applySetupToEndpointForm(blank, setup.id);
      expect(filled.baseUrl, setup.id).not.toContain('your-provider.example');
    }
  });

  it('does nothing for a catalog provider or an id it does not know', () => {
    expect(applySetupToEndpointForm(blank, 'openrouter')).toBe(blank);
    expect(applySetupToEndpointForm(blank, 'ollama')).toBe(blank);
    expect(applySetupToEndpointForm(blank, 'no-such-setup')).toBe(blank);
  });
});

describe('the model the endpoint dialog checks a connection with', () => {
  const onEndpoint = (id: string, model: string, endpointId = 'custom-endpoint-1') =>
    set({ id, name: id, provider: 'custom', endpointId, model });

  it('is the one in the Default model field', () => {
    expect(
      endpointCheckModel({
        defaultModel: '  typed-model ',
        endpointId: 'custom-endpoint-1',
        configSets: [onEndpoint('work', 'set-model')],
        activeConfigSetId: 'work',
      })
    ).toBe('typed-model');
  });

  it('is otherwise the one a config set already runs on this endpoint, the active set first', () => {
    const configSets = [onEndpoint('first', 'first-model'), onEndpoint('second', 'second-model')];

    expect(
      endpointCheckModel({
        defaultModel: '',
        endpointId: 'custom-endpoint-1',
        configSets,
        activeConfigSetId: 'second',
      })
    ).toBe('second-model');
    expect(
      endpointCheckModel({
        defaultModel: '',
        endpointId: 'custom-endpoint-1',
        configSets,
        activeConfigSetId: 'somewhere-else',
      })
    ).toBe('first-model');
  });

  it('is not taken from a set on another endpoint or on a catalog provider', () => {
    expect(
      endpointCheckModel({
        defaultModel: '',
        endpointId: 'custom-endpoint-1',
        configSets: [
          onEndpoint('other', 'other-endpoint-model', 'custom-endpoint-2'),
          set({ id: 'cloud', model: 'claude-opus-5' }),
        ],
        activeConfigSetId: 'cloud',
      })
    ).toBe('');
  });

  it('is none for an endpoint that is being added with no model named', () => {
    // There is no list to take a first entry from: an endpoint serves whatever
    // its owner set up.
    expect(
      endpointCheckModel({
        defaultModel: '',
        endpointId: null,
        configSets: [onEndpoint('work', 'set-model')],
        activeConfigSetId: 'work',
      })
    ).toBe('');
  });
});

describe('the model the provider dialog checks a connection with', () => {
  const native: ProviderCatalogEntry = {
    id: 'zai',
    name: 'z.ai',
    kind: 'native',
    category: 'coding-plan',
    piProvider: 'zai',
    routeProtocol: 'openai',
    formShape: {
      apiKey: true,
      baseUrl: false,
      protocol: false,
      contextWindow: false,
      modelDropdown: true,
      manualModelToggle: false,
    },
    modelOptions: [
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'glm-4.6', name: 'GLM-4.6' },
    ],
  };
  const catalog: ProviderCatalogEntry[] = [
    ...BUILTIN_ENTRIES,
    native,
    { ...native, id: 'bare', modelOptions: [] },
  ];

  const check = (provider: string, configSets: ApiConfigSet[], activeConfigSetId = 'default') =>
    providerCheckModel({ provider, configSets, activeConfigSetId, presets, catalog });

  it('is the one a config set already runs on this provider, the active set first', () => {
    const configSets = [
      set({ id: 'a', provider: 'anthropic', model: 'claude-haiku-4-5' }),
      set({ id: 'b', provider: 'anthropic', model: 'claude-opus-5' }),
      set({ id: 'c', provider: 'openai', model: 'gpt-5.4' }),
    ];

    expect(check('anthropic', configSets, 'b')).toBe('claude-opus-5');
    // The active set is on another provider: the first set on this one.
    expect(check('anthropic', configSets, 'c')).toBe('claude-haiku-4-5');
    expect(check('openai', configSets, 'b')).toBe('gpt-5.4');
  });

  it('is otherwise the one a new config set on this provider would start on', () => {
    const first = presets.anthropic.models[0].id;
    expect(first).toBeTruthy();
    expect(check('anthropic', [])).toBe(first);
    // A set on another provider says nothing about this one.
    expect(check('anthropic', [set({ provider: 'openai', model: 'gpt-5.4' })])).toBe(first);
  });

  it('prefers that one to the first model the provider happens to list', () => {
    // The full list comes from the registry in its own order; the first entry
    // there is not the one anybody would pick.
    const listed = catalog.map((entry) =>
      entry.id === 'anthropic'
        ? { ...entry, modelOptions: [{ id: 'registry-first', name: 'Registry first' }] }
        : entry
    );

    expect(
      providerCheckModel({
        provider: 'anthropic',
        configSets: [],
        activeConfigSetId: 'default',
        presets,
        catalog: listed,
      })
    ).toBe(presets.anthropic.models[0].id);
  });

  it('is the first model listed for a provider that has no preset of its own', () => {
    expect(check('zai', [])).toBe('glm-5');
  });

  it('is none for Ollama until a config set runs on it', () => {
    // Its models are whatever the local server has; guessing one would report
    // a working server as broken.
    expect(check('ollama', [])).toBe('');
    expect(check('ollama', [set({ provider: 'ollama', model: 'qwen3.5:0.8b' })])).toBe(
      'qwen3.5:0.8b'
    );

    // Not even when a list names some: those are examples, not what is installed.
    const withExamples = {
      ...presets,
      ollama: { ...presets.ollama, models: [{ id: 'llama3', name: 'llama3' }] },
    };
    expect(
      providerCheckModel({
        provider: 'ollama',
        configSets: [],
        activeConfigSetId: 'default',
        presets: withExamples,
        catalog: catalog.map((entry) =>
          entry.id === 'ollama'
            ? { ...entry, modelOptions: [{ id: 'llama3', name: 'llama3' }] }
            : entry
        ),
      })
    ).toBe('');
  });

  it('is none for a provider that lists no model at all', () => {
    expect(check('bare', [])).toBe('');
  });
});

describe('reporting a search for a local Ollama', () => {
  it('says how many models a found server has', () => {
    expect(
      ollamaSearchNote({
        available: true,
        baseUrl: 'http://localhost:11434/v1',
        models: ['qwen3.5:0.8b', 'llama4'],
        status: 'models_available',
      })
    ).toEqual({ tone: 'success', key: 'api.localOllamaDiscovered', values: { count: 2 } });
  });

  it('says so when the server is there but has no models', () => {
    const noModels = { tone: 'warning', key: 'api.localOllamaNoModels' };

    expect(
      ollamaSearchNote({
        available: true,
        baseUrl: 'http://localhost:11434/v1',
        models: [],
        status: 'service_available',
      })
    ).toEqual(noModels);
    // Whatever the status says, an empty list is not "found with models".
    expect(
      ollamaSearchNote({
        available: true,
        baseUrl: 'http://localhost:11434/v1',
        status: 'models_available',
      })
    ).toEqual(noModels);
  });

  it('reads anything short of a clear "found" as not found', () => {
    const notFound = { tone: 'error', key: 'api.localOllamaNotFound' };

    expect(
      ollamaSearchNote({
        available: false,
        baseUrl: 'http://localhost:11434/v1',
        status: 'unavailable',
      })
    ).toEqual(notFound);
    expect(ollamaSearchNote(null)).toEqual(notFound);
    expect(ollamaSearchNote(undefined)).toEqual(notFound);
    // What main's handler returns when the search itself throws.
    expect(ollamaSearchNote([] as unknown as null)).toEqual(notFound);
  });
});

describe("what a catalog provider's dialog opens on", () => {
  // One rule for the Providers tab's dialog and the first step of the first-run
  // wizard, which draw the same fields.
  const anthropic = BUILTIN_ENTRIES.find((entry) => entry.id === 'anthropic')!;
  const ollama = BUILTIN_ENTRIES.find((entry) => entry.id === 'ollama')!;
  const nothingStored = { providerCredentials: {}, customEndpoints: [], credentialConflicts: [] };
  const values = (input: Partial<Parameters<typeof providerDialogValues>[0]>) =>
    providerDialogValues({
      entry: anthropic,
      presets,
      catalog: fullCatalog,
      credentials: nothingStored,
      configSets: [set({})],
      activeConfigSetId: 'default',
      ...input,
    });

  it('is the key as it is stored', () => {
    const opened = values({
      credentials: { ...nothingStored, providerCredentials: { anthropic: { apiKey: 'sk-ant' } } },
    });

    expect(opened.entry).toBe(anthropic);
    expect(opened.apiKey).toBe('sk-ant');
    expect(opened.needsKey).toBe(true);
    expect(opened.protocol).toBe('anthropic');
  });

  it('is an empty address where nobody gave one, with the usual one as the hint', () => {
    // Opened on the address a config set would run with, an untouched Save
    // would store the provider's usual address as if the user had typed it.
    const opened = values({ entry: ollama });

    expect(opened.showsBaseUrl).toBe(true);
    expect(opened.baseUrl).toBe('');
    expect(opened.baseUrlPlaceholder).toBe(presets.ollama.baseUrl);
    expect(opened.baseUrlPlaceholder).not.toBe('');
    expect(opened.needsKey).toBe(false);
  });

  it('is the address the user gave, where they gave one', () => {
    const opened = values({
      entry: ollama,
      credentials: {
        ...nothingStored,
        providerCredentials: { ollama: { apiKey: '', baseUrl: ' http://box.lan:11434/v1 ' } },
      },
    });

    expect(opened.baseUrl).toBe('http://box.lan:11434/v1');
  });

  it("has no address field for a provider whose address is not the user's to set", () => {
    expect(values({}).showsBaseUrl).toBe(false);
    expect(values({ entry: kimiCoding }).showsBaseUrl).toBe(false);
  });

  it('takes the key hints from the preset of a builtin provider, and none for a native one', () => {
    const builtin = values({});
    expect(builtin.keyPlaceholder).toBe(presets.anthropic.keyPlaceholder);
    expect(builtin.keyHintKey).toBe(presets.anthropic.keyHint || undefined);

    const native = values({ entry: { ...kimiCoding, keyPlaceholder: 'sk-kimi-…' } });
    expect(native.keyPlaceholder).toBe('sk-kimi-…');
    expect(native.keyHintKey).toBeUndefined();
  });

  it('says which config sets use the provider, and which lost a key of their own to it', () => {
    const configSets = [
      set({ id: 'default', name: 'Default', provider: 'anthropic' }),
      set({ id: 'work', name: 'Work', provider: 'anthropic' }),
      set({ id: 'local', name: 'Local', provider: 'ollama', model: 'llama3' }),
    ];
    const opened = values({
      configSets,
      credentials: {
        ...nothingStored,
        credentialConflicts: [{ target: 'anthropic', setIds: ['work'] }],
      },
    });

    expect(opened.usedBy).toEqual(['Default', 'Work']);
    expect(opened.droppedKeySets).toEqual(['Work']);
    expect(values({ configSets, entry: ollama }).usedBy).toEqual(['Local']);
    expect(values({ configSets, entry: ollama }).droppedKeySets).toEqual([]);
  });

  it('tries the model the connection-check rule gives for that provider', () => {
    const configSets = [
      set({ id: 'work', name: 'Work', provider: 'anthropic', model: 'claude-x' }),
    ];

    expect(values({ configSets, activeConfigSetId: 'work' }).checkModel).toBe('claude-x');
    expect(values({ configSets: [set({ provider: 'openai', model: 'gpt-5.4' })] }).checkModel).toBe(
      providerCheckModel({
        provider: 'anthropic',
        configSets: [set({ provider: 'openai', model: 'gpt-5.4' })],
        activeConfigSetId: 'default',
        presets,
        catalog: fullCatalog,
      })
    );
    // Ollama's models are whatever its server has: none until a set runs on it.
    expect(values({ entry: ollama, configSets: [set({})] }).checkModel).toBe('');
  });
});
