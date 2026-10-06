/**
 * First-render check of the state behind the Providers and Model Sets tabs:
 * `useApiSettingsState` (what the two tabs share) and `useModelSetForm` (the
 * Model Sets tab as a form).
 *
 * The decisions are tested as plain functions in `api-settings-view.test.ts`;
 * this checks they are connected to the right fields, for a range of configs,
 * by rendering the two once on the server. It does not run effects, so loading,
 * saving and the calls to main are out of reach here.
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiConfigSet, AppConfig, CustomEndpoint } from '../src/renderer/types';
import type { ProviderCatalogEntry } from '../src/shared/provider-catalog';
import { useApiSettingsState } from '../src/renderer/hooks/useApiSettingsState';
import { useModelSetForm } from '../src/renderer/hooks/useModelSetForm';

interface Rendered {
  settings: ReturnType<typeof useApiSettingsState>;
  form: ReturnType<typeof useModelSetForm>;
}

function render(initialConfig: AppConfig | null): Rendered {
  let captured: Rendered | null = null;
  function Probe() {
    const settings = useApiSettingsState({ initialConfig });
    captured = { settings, form: useModelSetForm(settings) };
    return null;
  }
  renderToString(createElement(Probe));
  if (!captured) throw new Error('hooks did not render');
  return captured;
}

function set(overrides: Partial<ApiConfigSet>): ApiConfigSet {
  return {
    id: 'default',
    name: 'Default',
    isSystem: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    enableThinking: false,
    thinkingLevel: 'off',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function config(overrides: Partial<AppConfig>): AppConfig {
  return {
    provider: 'anthropic',
    apiKey: '',
    model: 'claude-sonnet-4-6',
    providerCredentials: {},
    customEndpoints: [],
    credentialConflicts: [],
    activeConfigSetId: 'default',
    configSets: [set({})],
    isConfigured: true,
    ...overrides,
  } as AppConfig;
}

const local: CustomEndpoint = {
  id: 'custom-endpoint-1',
  name: 'kiro-gateway',
  protocol: 'anthropic',
  baseUrl: 'http://127.0.0.1:9000',
  apiKey: '',
  defaultModel: 'claude-opus-5',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const hosted: CustomEndpoint = {
  id: 'custom-endpoint-2',
  name: 'hosted-gateway',
  protocol: 'openai',
  baseUrl: 'https://gateway.example.com/v1',
  apiKey: 'gw-key',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('a config set on one of two custom endpoints', () => {
  const { settings, form } = render(
    config({
      provider: 'custom',
      customEndpoints: [local, hosted],
      configSets: [set({ provider: 'custom', endpointId: hosted.id, model: 'gpt-5.4' })],
    })
  );

  it('shows which endpoint the set runs on, by its own entry', () => {
    expect(form.providerChoice).toBe('endpoint:custom-endpoint-2');
    expect(form.endpoint?.name).toBe('hosted-gateway');
  });

  it('offers both endpoints by name', () => {
    expect(
      form.providerChoices.filter((choice) => choice.kind === 'endpoint').map((c) => c.label)
    ).toEqual(['kiro-gateway', 'hosted-gateway']);
  });

  it('reads the protocol, address and key of that endpoint, not of the other', () => {
    expect(form.customProtocol).toBe('openai');
    expect(form.baseUrl).toBe('https://gateway.example.com/v1');
    expect(form.apiKey).toBe('gw-key');
  });

  it('shows the model as typed', () => {
    expect(form.useCustomModel).toBe(true);
    expect(form.customModel).toBe('gpt-5.4');
    expect(form.modelOptions).toEqual([]);
  });

  it('shares one credential store between the two tabs', () => {
    expect(settings.credentials.customEndpoints).toEqual([local, hosted]);
  });
});

describe('a config set on a catalog provider', () => {
  it('reads that provider key and offers it as the chosen entry', () => {
    const { form } = render(config({ providerCredentials: { anthropic: { apiKey: 'sk-ant' } } }));

    expect(form.providerChoice).toBe('provider:anthropic');
    expect(form.endpoint).toBeUndefined();
    expect(form.apiKey).toBe('sk-ant');
    expect(form.requiresApiKey).toBe(true);
  });

  it('reads a provider without a key as empty, never as another provider key', () => {
    const { form } = render(config({ providerCredentials: { openai: { apiKey: 'sk-oai' } } }));

    expect(form.apiKey).toBe('');
    expect(form.requiresApiKey).toBe(true);
  });

  it('needs no key for Ollama', () => {
    const { form } = render(
      config({ provider: 'ollama', configSets: [set({ provider: 'ollama', model: 'llama3' })] })
    );

    expect(form.providerChoice).toBe('provider:ollama');
    expect(form.requiresApiKey).toBe(false);
    expect(form.isOllamaMode).toBe(true);
  });
});

describe('a custom config set that points at no endpoint', () => {
  it.each([
    ['no endpoint id', undefined],
    ['an id that names no endpoint', 'custom-endpoint-9'],
  ])('with %s runs nowhere, and says so', (_label, endpointId) => {
    const { form } = render(
      config({
        provider: 'custom',
        customEndpoints: [hosted],
        configSets: [
          set({ provider: 'custom', ...(endpointId ? { endpointId } : {}), model: 'm' }),
        ],
      })
    );

    expect(form.endpoint).toBeUndefined();
    expect(form.providerChoice).toBe('provider:custom');
    expect(form.providerChoices[0]).toMatchObject({ id: 'provider:custom', kind: 'no-endpoint' });
    // No address is made up for it, and no key borrowed from the endpoint that exists.
    expect(form.baseUrl).toBe('');
    expect(form.apiKey).toBe('');
    expect(form.requiresApiKey).toBe(true);
  });
});

describe('a choice whose endpoint is deleted afterwards', () => {
  it('reads as no endpoint, instead of pointing at something that is gone', () => {
    // The two tabs share one credential store. An endpoint that no saved set
    // uses can be deleted on Providers while a set on Model Sets, loaded
    // earlier, still holds its id. Rendered here as exactly that: the set as it
    // was loaded, against a store the endpoint has since left.
    let form: Rendered['form'] | null = null;
    function Probe() {
      const settings = useApiSettingsState({
        initialConfig: config({
          provider: 'custom',
          customEndpoints: [local, hosted],
          configSets: [set({ provider: 'custom', endpointId: hosted.id, model: 'gpt-5.4' })],
        }),
      });
      form = useModelSetForm({
        ...settings,
        credentials: { ...settings.credentials, customEndpoints: [local] },
      });
      return null;
    }
    renderToString(createElement(Probe));
    const rendered = form as unknown as Rendered['form'];

    expect(rendered.endpoint).toBeUndefined();
    expect(rendered.providerChoice).toBe('provider:custom');
    expect(rendered.providerChoices[0]).toMatchObject({ kind: 'no-endpoint' });
    expect(rendered.baseUrl).toBe('');
    expect(rendered.apiKey).toBe('');
  });
});

describe('the controls that exist for Ollama only', () => {
  it('follow the Ollama provider, not any keyless provider with an address', () => {
    // Refreshing the model list and finding a local server only ever run for
    // Ollama. A provider that merely has the same form shape must not be given
    // buttons that do nothing for it.
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
    let form: Rendered['form'] | null = null;
    function Probe() {
      const settings = useApiSettingsState({
        initialConfig: config({
          provider: 'localai',
          configSets: [set({ provider: 'localai', model: 'some-model' })],
        }),
      });
      form = useModelSetForm({
        ...settings,
        providerCatalog: [...settings.providerCatalog, keylessNative],
      });
      return null;
    }
    renderToString(createElement(Probe));
    const rendered = form as unknown as Rendered['form'];

    expect(rendered.provider).toBe('localai');
    expect(rendered.requiresApiKey).toBe(false);
    expect(rendered.isOllamaMode).toBe(false);
  });
});

describe('a gateway on this computer', () => {
  it('may run without a key', () => {
    const { form } = render(
      config({
        provider: 'custom',
        customEndpoints: [local],
        configSets: [set({ provider: 'custom', endpointId: local.id, model: 'claude-opus-5' })],
      })
    );

    expect(form.apiKey).toBe('');
    expect(form.requiresApiKey).toBe(false);
  });
});

describe('before anything is edited', () => {
  it('has no unsaved changes', () => {
    expect(render(config({})).form.hasUnsavedChanges).toBe(false);
    expect(render(null).form.hasUnsavedChanges).toBe(false);
  });

  it('renders without a config at all', () => {
    const { settings, form } = render(null);

    expect(settings.credentials).toEqual({ providerCredentials: {}, customEndpoints: [] });
    expect(form.configSets).toHaveLength(1);
  });

  it('keeps the interface the Model Sets tab is written against', () => {
    // The tab reads these by name. One renamed or dropped would otherwise only
    // show as `undefined` at run time, in a screen no test can click.
    const { settings, form } = render(config({}));

    for (const name of [
      'changeProviderChoice',
      'setModel',
      'setCustomModel',
      'toggleCustomModel',
      'setContextWindow',
      'setMaxTokens',
      'setThinkingLevel',
      'refreshModelOptions',
      'handleDiagnose',
      'handleDeepDiagnose',
      'handleSave',
      'requestConfigSetSwitch',
      'requestCreateBlankConfigSet',
      'cancelPendingConfigSetAction',
      'saveAndContinuePendingConfigSetAction',
      'discardAndContinuePendingConfigSetAction',
      'renameConfigSet',
      'deleteConfigSet',
    ] as const) {
      expect(typeof form[name], name).toBe('function');
    }
    for (const name of [
      'createEndpoint',
      'updateEndpoint',
      'deleteEndpoint',
      'saveProviderCredential',
    ] as const) {
      expect(typeof settings[name], name).toBe('function');
    }
  });
});
