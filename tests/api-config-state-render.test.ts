/**
 * First-render check of `useApiConfigState`.
 *
 * The hook is a composition of two state slices, and nothing else in the suite
 * actually runs it: the slices are tested as pure reducers, the wiring between
 * them is not. This renders it once on the server for a range of configs and
 * checks what the form would show before any effect or user input — enough to
 * catch a slice wired to the wrong field, or a render-time throw for a config
 * shape nobody tried.
 *
 * It does not run effects, so loading, saving and discovery are out of reach
 * here.
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiConfigSet, AppConfig, CustomEndpoint } from '../src/renderer/types';
import { useApiConfigState } from '../src/renderer/hooks/useApiConfigState';

type FormState = ReturnType<typeof useApiConfigState>;

function renderForm(initialConfig: AppConfig | null): FormState {
  let captured: FormState | null = null;
  function Probe() {
    captured = useApiConfigState({ initialConfig, enabled: false });
    return null;
  }
  renderToString(createElement(Probe));
  if (!captured) throw new Error('hook did not render');
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

const gateway: CustomEndpoint = {
  id: 'custom-endpoint-1',
  name: 'kiro',
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:9000/v1',
  apiKey: 'gw-key',
  defaultModel: 'local-model',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useApiConfigState — what the form shows on first render', () => {
  it('renders with no config at all', () => {
    const form = renderForm(null);

    expect(form.provider).toBe('openrouter');
    expect(form.apiKey).toBe('');
    expect(form.hasUnsavedChanges).toBe(false);
    expect(form.configSets).toHaveLength(1);
  });

  it('takes the model from the config set and the key from the provider credential', () => {
    const form = renderForm(
      config({
        providerCredentials: { anthropic: { apiKey: 'sk-ant' }, openai: { apiKey: 'sk-oai' } },
        configSets: [set({ contextWindow: 200000, thinkingLevel: 'high', enableThinking: true })],
      })
    );

    expect(form.provider).toBe('anthropic');
    expect(form.customProtocol).toBe('anthropic');
    expect(form.apiKey).toBe('sk-ant');
    expect(form.baseUrl).toBe(form.presets.anthropic.baseUrl);
    expect(form.model).toBe('claude-sonnet-4-6');
    expect(form.useCustomModel).toBe(false);
    expect(form.contextWindow).toBe('200000');
    expect(form.thinkingLevel).toBe('high');
    expect(form.enableThinking).toBe(true);
    expect(form.requiresApiKey).toBe(true);
    expect(form.hasUnsavedChanges).toBe(false);
  });

  it('shows the active set, not the first one', () => {
    const form = renderForm(
      config({
        activeConfigSetId: 'work',
        providerCredentials: { anthropic: { apiKey: 'sk-ant' }, openai: { apiKey: 'sk-oai' } },
        configSets: [
          set({}),
          set({ id: 'work', name: 'Work', isSystem: false, provider: 'openai', model: 'gpt-5.4' }),
        ],
      })
    );

    expect(form.activeConfigSetId).toBe('work');
    expect(form.currentConfigSet?.name).toBe('Work');
    expect(form.provider).toBe('openai');
    expect(form.customProtocol).toBe('openai');
    expect(form.apiKey).toBe('sk-oai');
    expect(form.model).toBe('gpt-5.4');
    expect(form.canDeleteCurrentConfigSet).toBe(true);
  });

  it('reads an unconfigured provider as empty, never as another provider key', () => {
    const form = renderForm(
      config({
        provider: 'openai',
        providerCredentials: { anthropic: { apiKey: 'sk-ant' } },
        configSets: [set({ provider: 'openai', model: 'gpt-5.4' })],
      })
    );

    expect(form.apiKey).toBe('');
  });

  it('takes protocol, address and key of a custom set from its endpoint', () => {
    const form = renderForm(
      config({
        provider: 'custom',
        customEndpoints: [gateway],
        configSets: [set({ provider: 'custom', endpointId: gateway.id, model: 'local-model' })],
      })
    );

    expect(form.provider).toBe('custom');
    expect(form.customProtocol).toBe('openai');
    expect(form.baseUrl).toBe('http://127.0.0.1:9000/v1');
    expect(form.apiKey).toBe('gw-key');
    expect(form.customModel).toBe('local-model');
    expect(form.useCustomModel).toBe(true);
    // No list to pick from for a custom endpoint.
    expect(form.modelOptions).toEqual([]);
    // A loopback gateway may run without a key.
    expect(form.requiresApiKey).toBe(false);
    expect(form.hasUnsavedChanges).toBe(false);
  });

  it('shows a blank endpoint for a custom set that has none yet', () => {
    const form = renderForm(
      config({
        provider: 'custom',
        customProtocol: 'gemini',
        configSets: [set({ provider: 'custom', model: '' })],
      })
    );

    expect(form.provider).toBe('custom');
    // The last protocol used is where a new endpoint starts.
    expect(form.customProtocol).toBe('gemini');
    expect(form.baseUrl).toBe(form.presets.gemini.baseUrl);
    expect(form.apiKey).toBe('');
    expect(form.customModel).toBe('');
    expect(form.requiresApiKey).toBe(true);
    expect(form.hasUnsavedChanges).toBe(false);
  });

  it('shows Ollama with its address and no key requirement', () => {
    const form = renderForm(
      config({
        provider: 'ollama',
        providerCredentials: { ollama: { apiKey: '', baseUrl: 'http://192.168.1.50:11434/v1' } },
        configSets: [set({ provider: 'ollama', model: 'qwen3.5' })],
      })
    );

    expect(form.provider).toBe('ollama');
    expect(form.customProtocol).toBe('openai');
    expect(form.baseUrl).toBe('http://192.168.1.50:11434/v1');
    expect(form.isOllamaMode).toBe(true);
    expect(form.requiresApiKey).toBe(false);
    expect(form.hasUnsavedChanges).toBe(false);
  });

  it('shows a native provider from its own credential slot', () => {
    const form = renderForm(
      config({
        provider: 'zai',
        providerCredentials: { 'native:zai': { apiKey: 'zai-key' } },
        configSets: [set({ provider: 'zai', model: 'glm-5.2' })],
      })
    );

    expect(form.provider).toBe('zai');
    expect(form.apiKey).toBe('zai-key');
    // Not in any preset list, so it is shown as typed.
    expect(form.customModel).toBe('glm-5.2');
    expect(form.hasUnsavedChanges).toBe(false);
  });

  it('keeps the interface the first-run dialog is written against', () => {
    // ConfigModal destructures these by name. A slice renamed or
    // dropped would otherwise only show as `undefined` at run time.
    const form = renderForm(config({}));

    for (const name of [
      'setApiKey',
      'setBaseUrl',
      'setModel',
      'setCustomModel',
      'setContextWindow',
      'setMaxTokens',
      'toggleCustomModel',
      'setThinkingLevel',
      'applyCommonProviderSetup',
      'changeProvider',
      'changeProtocol',
      'requestConfigSetSwitch',
      'requestCreateBlankConfigSet',
      'cancelPendingConfigSetAction',
      'saveAndContinuePendingConfigSetAction',
      'discardAndContinuePendingConfigSetAction',
      'createConfigSet',
      'renameConfigSet',
      'deleteConfigSet',
      'handleSave',
      'handleTest',
      'handleDiagnose',
      'handleDeepDiagnose',
      'refreshModelOptions',
      'discoverLocalOllama',
      'setError',
      'setSuccessMessage',
    ] as const) {
      expect(typeof form[name], name).toBe('function');
    }
    for (const name of [
      'isLoadingConfig',
      'isCatalogLoading',
      'isSaving',
      'isTesting',
      'isRefreshingModels',
      'isDiscoveringLocalOllama',
      'isDiagnosing',
      'isMutatingConfigSet',
      'shouldShowOllamaManualModelToggle',
    ] as const) {
      expect(typeof form[name], name).toBe('boolean');
    }
    expect(form.configSetLimit).toBe(20);
    expect(form.pendingConfigSetAction).toBeNull();
    expect(form.pendingConfigSet).toBeNull();
    expect(form.testResult).toBeNull();
    expect(form.diagnosticResult).toBeNull();
    expect(form.error).toBe('');
    expect(form.successMessage).toBe('');
    expect(Array.isArray(form.providerCatalog)).toBe(true);
    expect(Array.isArray(form.commonProviderSetups)).toBe(true);
    expect(form.thinkingCapabilities).toEqual({ supportsThinking: false, levels: ['off'] });
    expect(form.effectiveThinkingLevel).toBe('off');
  });
});
