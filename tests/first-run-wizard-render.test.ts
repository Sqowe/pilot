/**
 * First render of the first-run wizard — what each of its two steps puts on
 * screen for a range of configs — and what its Continue and Start send.
 *
 * The wizard's frame is drawn into the page body, which this suite does not
 * have, so its state (`useFirstRunWizard`) and its body are rendered once on
 * the server without it. Effects do not run and nothing can be typed or
 * clicked: each case starts from a config that already holds what a user would
 * have entered, and a moment a first render cannot reach by itself — the
 * second step, a save on its way — is set on the state before it is drawn.
 *
 * The calls that write a credential are stood in for; they are the ones the
 * Settings tabs make, tested with the real store elsewhere.
 *
 * Texts appear as their keys: i18n is not initialised here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfigSet, AppConfig, CustomEndpoint } from '../src/renderer/types';
import { COMMON_PROVIDER_SETUPS } from '../src/shared/api-provider-guidance';
import { BUILTIN_ENTRIES, type ProviderCatalogEntry } from '../src/shared/provider-catalog';
import { ConfigModal } from '../src/renderer/components/ConfigModal';
import {
  FirstRunWizardBody,
  FirstRunWizardFooter,
  isRepeatedClick,
} from '../src/renderer/components/FirstRunWizard';
import { FALLBACK_PROVIDER_PRESETS } from '../src/renderer/hooks/api-config-shared';
import { NEW_ENDPOINT_CHOICE } from '../src/renderer/hooks/first-run-wizard-view';
import { useApiSettingsState } from '../src/renderer/hooks/useApiSettingsState';
import {
  useFirstRunWizard,
  type FirstRunWizardState,
} from '../src/renderer/hooks/useFirstRunWizard';

const presets = FALLBACK_PROVIDER_PRESETS;
const openrouterModel = presets.openrouter.models[0].id;

function set(overrides: Partial<ApiConfigSet>): ApiConfigSet {
  return {
    id: 'default',
    name: 'Default',
    isSystem: true,
    provider: 'openrouter',
    model: openrouterModel,
    enableThinking: false,
    thinkingLevel: 'off',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A config with nothing set up: one config set on the default provider, no key anywhere. */
function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: 'openrouter',
    apiKey: '',
    model: openrouterModel,
    providerCredentials: {},
    customEndpoints: [],
    credentialConflicts: [],
    activeConfigSetId: 'default',
    configSets: [set({})],
    isConfigured: false,
    ...overrides,
  } as AppConfig;
}

function endpoint(overrides: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-endpoint-1',
    name: 'hosted-gateway',
    protocol: 'openai',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A native provider as the catalog built from the installed pi lists it. */
const zai: ProviderCatalogEntry = {
  id: 'zai',
  name: 'z.ai (GLM)',
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
    manualModelToggle: true,
  },
  modelOptions: [{ id: 'glm-5', name: 'GLM-5' }],
};
/** The catalog as it is once the installed pi has been read. */
const catalog: ProviderCatalogEntry[] = [...BUILTIN_ENTRIES, zai];
const anthropic = BUILTIN_ENTRIES.find((entry) => entry.id === 'anthropic')!;
const ollama = BUILTIN_ENTRIES.find((entry) => entry.id === 'ollama')!;

type CallResult = { ok: true; config: AppConfig } | { ok: false; error: string };

interface RenderOptions {
  catalog?: ProviderCatalogEntry[];
  loading?: boolean;
  catalogLoading?: boolean;
  /** A save of the config set that is on its way. */
  savingSet?: boolean;
  /** What main answers to a call that writes a credential; by default the config as it was. */
  answer?: CallResult;
  /** Set a moment the first render cannot reach by itself. */
  adjust?: (wizard: FirstRunWizardState) => FirstRunWizardState;
}

function renderWizard(initialConfig: AppConfig | null, options: RenderOptions = {}) {
  const answer: CallResult = options.answer ?? {
    ok: true,
    config: initialConfig ?? config(),
  };
  const calls = {
    saveProviderCredential: vi.fn(async (_payload: unknown) => answer),
    createEndpoint: vi.fn(async (_payload: unknown) => answer),
    updateEndpoint: vi.fn(async (_payload: unknown) => answer),
    changeProvider: vi.fn(),
  };
  const onClose = vi.fn();
  let captured: FirstRunWizardState | null = null;

  function Harness() {
    const loaded = useApiSettingsState({ initialConfig });
    const wizard = (options.adjust ?? ((state) => state))(
      useFirstRunWizard(
        {
          ...loaded,
          // A first render never gets past "loading" by itself: effects do not run.
          isLoadingConfig: options.loading ?? false,
          isCatalogLoading: options.catalogLoading ?? false,
          providerCatalog: options.catalog ?? catalog,
          saveProviderCredential: calls.saveProviderCredential,
          createEndpoint: calls.createEndpoint,
          updateEndpoint: calls.updateEndpoint,
          sets: {
            ...loaded.sets,
            changeProvider: calls.changeProvider,
            isSaving: options.savingSet ?? loaded.sets.isSaving,
          },
        } as ReturnType<typeof useApiSettingsState>,
        onClose
      )
    );
    captured = wizard;
    return createElement(FirstRunWizardBody, { wizard });
  }

  const html = renderToString(createElement(Harness));
  return { html, wizard: captured as unknown as FirstRunWizardState, calls, onClose };
}

/** Stand in for the bridge to main, for the one call that saves a config set. */
function stubSetSave(answer?: unknown) {
  const save = vi.fn(async (payload: Partial<AppConfig>) =>
    answer !== undefined ? answer : { success: true, config: config({ ...payload }) }
  );
  vi.stubGlobal('window', { electronAPI: { config: { save } } });
  return save;
}

const atModelStep = (wizard: FirstRunWizardState): FirstRunWizardState => ({
  ...wizard,
  step: 'model',
});

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the first step on a fresh install', () => {
  it('opens on the provider of the default config set, asking for its key', () => {
    const { html, wizard } = renderWizard(config());

    expect(wizard.step).toBe('credential');
    expect(wizard.choiceId).toBe('provider:openrouter');
    expect(wizard.target).toMatchObject({ kind: 'provider', entry: { id: 'openrouter' } });
    expect(html).toContain('api.firstRunSubtitle');
    expect(html).toContain('id="provider-api-key-input"');
    // The dialog's own connection check comes with its fields.
    expect(html).toContain('api.providers.check.title');
    expect(html).not.toContain('id="endpoint-name-input"');
    expect(html).not.toContain('api.firstRun.modelIntro');
  });

  it('lets any catalog provider be chosen, and an endpoint be added', () => {
    const { wizard } = renderWizard(config());
    const ids = wizard.choices.map((choice) => choice.id);

    expect(ids[0]).toBe(NEW_ENDPOINT_CHOICE);
    for (const provider of ['openrouter', 'anthropic', 'openai', 'gemini', 'ollama', 'zai']) {
      expect(ids, provider).toContain(`provider:${provider}`);
    }
    expect(ids).not.toContain('provider:custom');
  });

  it('shows a provider only the installed pi knows, with the fields its catalog entry has', () => {
    const { html, wizard } = renderWizard(
      config({ provider: 'zai', configSets: [set({ provider: 'zai', model: 'glm-5' })] })
    );

    expect(wizard.target).toMatchObject({ kind: 'provider', entry: { id: 'zai' } });
    expect(html).toContain('id="provider-api-key-input"');
    expect(html).not.toContain('id="provider-base-url-input"');
  });

  it('has the address field and the search for a local server for Ollama', () => {
    const { html } = renderWizard(
      config({ provider: 'ollama', configSets: [set({ provider: 'ollama', model: '' })] })
    );

    expect(html).toContain('id="provider-base-url-input"');
    expect(html).toContain('api.discoverLocalOllama');
  });

  it('opens with no config at all', () => {
    const { html, wizard } = renderWizard(null);

    expect(wizard.choiceId).toBe('provider:openrouter');
    expect(html).toContain('id="provider-api-key-input"');
  });

  it('has nothing to fill in, and nothing to send, while the config is loading', () => {
    const { html, wizard, calls } = renderWizard(config(), { loading: true });

    expect(html).toContain('common.loading');
    expect(html).not.toContain('id="provider-api-key-input"');

    wizard.submit();
    expect(calls.saveProviderCredential).not.toHaveBeenCalled();
  });

  it('waits for the catalog as well: a native provider is not in it before', () => {
    const { html, wizard } = renderWizard(config(), { catalogLoading: true });

    expect(wizard.isLoading).toBe(true);
    expect(html).toContain('common.loading');
    expect(html).not.toContain('id="provider-api-key-input"');
  });

  it('holds everything still while a save is on its way', () => {
    const idle = renderWizard(config());
    const saving = renderWizard(config(), { savingSet: true });
    const trigger = (html: string) => html.match(/<button[^>]*role="combobox"[^>]*>/)![0];

    expect(idle.wizard.busy).toBe(false);
    expect(trigger(idle.html)).not.toMatch(/\sdisabled=""/);
    expect(saving.wizard.busy).toBe(true);
    // The list cannot move the step to another credential mid-save.
    expect(trigger(saving.html)).toMatch(/\sdisabled=""/);
  });

  it('shows the list alone for a provider the catalog at hand does not have', () => {
    const { html, wizard, calls } = renderWizard(
      config({ provider: 'zai', configSets: [set({ provider: 'zai', model: 'glm-5' })] }),
      { catalog: [...BUILTIN_ENTRIES] }
    );

    expect(wizard.target).toBeNull();
    expect(html).toContain('api.firstRunSubtitle');
    expect(html).not.toContain('id="provider-api-key-input"');
    expect(html).not.toContain('id="endpoint-name-input"');

    // No step is on screen to say what a submit means.
    wizard.submit();
    expect(calls.saveProviderCredential).not.toHaveBeenCalled();
    expect(calls.createEndpoint).not.toHaveBeenCalled();
  });
});

describe('the first step for a custom endpoint', () => {
  const hosted = endpoint({ id: 'custom-endpoint-2' });
  const onHosted = config({
    provider: 'custom',
    customEndpoints: [hosted],
    configSets: [set({ provider: 'custom', endpointId: hosted.id, model: 'gpt-5.4' })],
  });

  it('opens on the endpoint the active config set points at, to be edited', () => {
    const { html, wizard } = renderWizard(onHosted);

    expect(wizard.choiceId).toBe('endpoint:custom-endpoint-2');
    expect(wizard.target).toEqual({ kind: 'endpoint', endpoint: hosted });
    expect(html).toContain('id="endpoint-name-input"');
    expect(html).toContain('value="hosted-gateway"');
    expect(html).toContain('value="https://gateway.example.com/v1"');
    // The ready-made setups fill in a new endpoint; this one exists.
    expect(html).not.toContain('api.guidance.commonSetupsTitle');
    // Whoever else runs on it is told about, as in the tab's dialog.
    expect(html).toContain('api.providers.sharedEndpointNotice');
  });

  it('opens on an endpoint to add when the config set points at none', () => {
    const { html, wizard } = renderWizard(
      config({
        provider: 'custom',
        customEndpoints: [hosted],
        configSets: [set({ provider: 'custom', endpointId: 'custom-endpoint-9', model: 'm' })],
      })
    );

    expect(wizard.choiceId).toBe(NEW_ENDPOINT_CHOICE);
    expect(wizard.target).toEqual({ kind: 'new-endpoint' });
    expect(html).toContain('id="endpoint-name-input"');
    expect(html).toContain('api.guidance.commonSetupsTitle');
    expect(html).not.toContain('value="hosted-gateway"');
    // The list says what is chosen: the entry that adds an endpoint.
    expect(html.match(/<button[^>]*role="combobox"[^>]*>[\s\S]*?<\/button>/)![0]).toContain(
      'api.providers.addEndpoint'
    );
    // The one that exists is in the list, by name, to be chosen instead.
    expect(wizard.choices.map((choice) => choice.label)).toContain('hosted-gateway');
  });

  it('words the hint towards a catalog provider for a list, not for a tab', () => {
    const asOpenRouter = endpoint({
      id: 'custom-endpoint-2',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const { html } = renderWizard(
      config({
        provider: 'custom',
        customEndpoints: [asOpenRouter],
        configSets: [set({ provider: 'custom', endpointId: asOpenRouter.id, model: 'm' })],
      })
    );

    expect(html).toContain('api.firstRun.catalogProviderHint');
    expect(html).toContain('api.firstRun.chooseCatalogProvider');
    expect(html).not.toContain('api.providers.catalogProviderHint');
    expect(html).not.toContain('api.providers.openCatalogProvider');
  });

  it('has that hint choose the provider in the list, where the tab opens a second dialog', () => {
    const steps = read('src/renderer/components/FirstRunWizardSteps.tsx');

    expect(steps).toContain("catalogProviderAt: 'list',");
    expect(steps).toContain('onOpenProvider: wizard.chooseProvider,');
  });
});

describe('Continue, for a catalog provider', () => {
  it('saves the key through the call the Providers tab makes, and no config set', async () => {
    const save = stubSetSave();
    const { wizard, calls } = renderWizard(config());

    const result = await wizard.saveProvider(
      anthropic,
      { showsBaseUrl: false, needsKey: true },
      { apiKey: '  sk-ant-typed ', baseUrl: '' }
    );

    expect(result.ok).toBe(true);
    expect(calls.saveProviderCredential).toHaveBeenCalledTimes(1);
    // No address for a provider that has no address field: main keeps its own.
    expect(calls.saveProviderCredential).toHaveBeenCalledWith({
      provider: 'anthropic',
      apiKey: 'sk-ant-typed',
    });
    expect(calls.createEndpoint).not.toHaveBeenCalled();
    expect(calls.updateEndpoint).not.toHaveBeenCalled();
    // The config set is saved by the second step, in a call of its own.
    expect(save).not.toHaveBeenCalled();
  });

  it("moves the config set to it in the wizard's unsaved state, on that provider's first model", async () => {
    const { wizard, calls } = renderWizard(config());

    await wizard.saveProvider(
      anthropic,
      { showsBaseUrl: false, needsKey: true },
      { apiKey: 'sk-ant-typed', baseUrl: '' }
    );

    expect(calls.changeProvider).toHaveBeenCalledTimes(1);
    expect(calls.changeProvider).toHaveBeenCalledWith(
      'anthropic',
      '',
      expect.objectContaining({
        model: presets.anthropic.models[0].id,
        useCustomModel: false,
      })
    );
  });

  it('leaves a config set that is already on that provider, and its model, alone', async () => {
    const { wizard, calls } = renderWizard(config());
    const openrouter = BUILTIN_ENTRIES.find((entry) => entry.id === 'openrouter')!;

    const result = await wizard.saveProvider(
      openrouter,
      { showsBaseUrl: false, needsKey: true },
      { apiKey: 'sk-or-typed', baseUrl: '' }
    );

    expect(result.ok).toBe(true);
    expect(calls.changeProvider).not.toHaveBeenCalled();
  });

  it('sends the address where the provider has a field for it', async () => {
    const { wizard, calls } = renderWizard(config());

    await wizard.saveProvider(
      ollama,
      { showsBaseUrl: true, needsKey: false },
      { apiKey: '', baseUrl: ' http://localhost:11434/v1 ' }
    );

    expect(calls.saveProviderCredential).toHaveBeenCalledWith({
      provider: 'ollama',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('does not go on without a key where one is needed, and asks main nothing', async () => {
    const { wizard, calls } = renderWizard(config());

    for (const apiKey of ['', '   ']) {
      const result = await wizard.saveProvider(
        anthropic,
        { showsBaseUrl: false, needsKey: true },
        { apiKey, baseUrl: '' }
      );
      expect(result).toEqual({ ok: false, error: 'api.testError.missing_key' });
    }
    expect(calls.saveProviderCredential).not.toHaveBeenCalled();
    expect(calls.changeProvider).not.toHaveBeenCalled();
  });

  it('goes on without a key for a provider that needs none', async () => {
    const { wizard, calls } = renderWizard(config());

    const result = await wizard.saveProvider(
      ollama,
      { showsBaseUrl: true, needsKey: false },
      { apiKey: '', baseUrl: '' }
    );

    expect(result.ok).toBe(true);
    expect(calls.changeProvider).toHaveBeenCalledWith('ollama', '', expect.anything());
  });

  it('stays where it is, with the reason, when main refuses the save', async () => {
    const refused: CallResult = { ok: false, error: 'the store said no' };
    const { wizard, calls } = renderWizard(config(), { answer: refused });

    const result = await wizard.saveProvider(
      anthropic,
      { showsBaseUrl: false, needsKey: true },
      { apiKey: 'sk-ant-typed', baseUrl: '' }
    );

    expect(result).toEqual(refused);
    expect(calls.changeProvider).not.toHaveBeenCalled();
  });

  it('is what a submit of the frame does: the fields on screen, then the next step', async () => {
    const advance = vi.fn();
    const { wizard, calls } = renderWizard(
      config({ providerCredentials: { openrouter: { apiKey: 'sk-or-stored' } } }),
      { adjust: (state) => ({ ...state, advance }) }
    );

    wizard.submit();

    await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
    expect(calls.saveProviderCredential).toHaveBeenCalledWith({
      provider: 'openrouter',
      apiKey: 'sk-or-stored',
    });
  });

  it('does not reach the next step when the fields on screen have no key', async () => {
    const advance = vi.fn();
    const { wizard, calls } = renderWizard(config(), {
      adjust: (state) => ({ ...state, advance }),
    });

    wizard.submit();
    // Long enough for a save that had been let through to have come back.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.saveProviderCredential).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });
});

describe('Continue, for a custom endpoint', () => {
  const values = {
    name: ' kiro-gateway ',
    protocol: 'anthropic' as const,
    baseUrl: 'http://127.0.0.1:9000/',
    apiKey: '',
    defaultModel: ' claude-opus-5 ',
  };

  it('creates it, then moves the config set to the endpoint that was created', async () => {
    const save = stubSetSave();
    const created = endpoint({
      id: 'custom-endpoint-7',
      name: 'kiro-gateway',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
      defaultModel: 'claude-opus-5',
    });
    const { wizard, calls } = renderWizard(config(), {
      answer: { ok: true, config: config({ customEndpoints: [created] }) },
    });

    const result = await wizard.saveEndpoint(null, values);

    expect(result.ok).toBe(true);
    expect(calls.createEndpoint).toHaveBeenCalledWith({
      name: 'kiro-gateway',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:9000',
      apiKey: '',
      defaultModel: 'claude-opus-5',
    });
    expect(calls.updateEndpoint).not.toHaveBeenCalled();
    // By the id main gave it, on the model the endpoint names, typed.
    expect(calls.changeProvider).toHaveBeenCalledWith(
      'custom',
      'custom-endpoint-7',
      expect.objectContaining({ useCustomModel: true, customModel: 'claude-opus-5' })
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('tells the created endpoint from the ones that were there before', async () => {
    const before = endpoint({ id: 'custom-endpoint-1', name: 'older' });
    const created = endpoint({ id: 'custom-endpoint-2', name: 'newer', baseUrl: 'http://b.test' });
    const { wizard, calls } = renderWizard(config({ customEndpoints: [before] }), {
      answer: { ok: true, config: config({ customEndpoints: [before, created] }) },
    });

    await wizard.saveEndpoint(null, { ...values, baseUrl: 'http://b.test', apiKey: 'k' });

    expect(calls.changeProvider).toHaveBeenCalledWith(
      'custom',
      'custom-endpoint-2',
      expect.anything()
    );
  });

  it('starts on the example model of a well-known service when the endpoint names none', async () => {
    const deepseek = COMMON_PROVIDER_SETUPS.find((setup) => setup.id === 'deepseek')!;
    const created = endpoint({
      id: 'custom-endpoint-3',
      protocol: deepseek.recommendedProtocol,
      baseUrl: deepseek.recommendedBaseUrl,
      apiKey: 'sk-deep',
    });
    const { wizard, calls } = renderWizard(config(), {
      answer: { ok: true, config: config({ customEndpoints: [created] }) },
    });

    await wizard.saveEndpoint(null, {
      name: '',
      protocol: deepseek.recommendedProtocol,
      baseUrl: deepseek.recommendedBaseUrl,
      apiKey: 'sk-deep',
      defaultModel: '',
    });

    expect(calls.changeProvider).toHaveBeenCalledWith(
      'custom',
      'custom-endpoint-3',
      expect.objectContaining({ customModel: deepseek.exampleModel })
    );
  });

  it('does not go on when it cannot tell which endpoint was created', async () => {
    // Main answered with the list it had: nothing in it is new.
    const { wizard, calls } = renderWizard(config());

    const result = await wizard.saveEndpoint(null, values);

    expect(calls.createEndpoint).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, error: 'api.saveFailed' });
    // Going on would leave a config set that points at nothing.
    expect(calls.changeProvider).not.toHaveBeenCalled();
  });

  it('saves an endpoint that exists under its own id, and moves the config set to it', async () => {
    const hosted = endpoint({ id: 'custom-endpoint-2' });
    const { wizard, calls } = renderWizard(config({ customEndpoints: [hosted] }), {
      answer: {
        ok: true,
        config: config({ customEndpoints: [{ ...hosted, apiKey: 'gw-typed' }] }),
      },
    });

    const result = await wizard.saveEndpoint(hosted, {
      name: 'hosted-gateway',
      protocol: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: ' gw-typed ',
      defaultModel: '',
    });

    expect(result.ok).toBe(true);
    expect(calls.createEndpoint).not.toHaveBeenCalled();
    expect(calls.updateEndpoint).toHaveBeenCalledWith({
      id: 'custom-endpoint-2',
      name: 'hosted-gateway',
      protocol: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'gw-typed',
      defaultModel: '',
    });
    expect(calls.changeProvider).toHaveBeenCalledWith(
      'custom',
      'custom-endpoint-2',
      expect.anything()
    );
  });

  it('leaves a config set that is already on that endpoint, and its model, alone', async () => {
    const hosted = endpoint({ id: 'custom-endpoint-2' });
    const onHosted = config({
      provider: 'custom',
      customEndpoints: [hosted],
      configSets: [set({ provider: 'custom', endpointId: hosted.id, model: 'gpt-5.4' })],
    });
    const { wizard, calls } = renderWizard(onHosted);

    const result = await wizard.saveEndpoint(hosted, {
      name: 'hosted-gateway',
      protocol: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'gw-typed',
      defaultModel: 'another-model',
    });

    expect(result.ok).toBe(true);
    expect(calls.changeProvider).not.toHaveBeenCalled();
  });

  it('does not go on without a key for a service that is not on this computer', async () => {
    const { wizard, calls } = renderWizard(config());

    const result = await wizard.saveEndpoint(null, {
      ...values,
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: ' ',
    });

    expect(result).toEqual({ ok: false, error: 'api.testError.missing_key' });
    expect(calls.createEndpoint).not.toHaveBeenCalled();
  });

  it('goes on without a key for a gateway on this computer', async () => {
    const { wizard, calls } = renderWizard(config());

    await wizard.saveEndpoint(null, values);

    expect(calls.createEndpoint).toHaveBeenCalledTimes(1);
  });

  it('is what a submit of the frame does: the fields on screen, then the next step', async () => {
    const advance = vi.fn();
    const hosted = endpoint({ id: 'custom-endpoint-2', apiKey: 'gw-stored' });
    const { wizard, calls } = renderWizard(
      config({
        provider: 'custom',
        customEndpoints: [hosted],
        configSets: [set({ provider: 'custom', endpointId: hosted.id, model: 'gpt-5.4' })],
      }),
      { adjust: (state) => ({ ...state, advance }) }
    );

    wizard.submit();

    await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
    expect(calls.updateEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-endpoint-2', apiKey: 'gw-stored' })
    );
  });

  it('asks for an address before anything else, and does not reach the next step', async () => {
    // A new endpoint, nothing typed: the dialog's own check stops it first.
    const advance = vi.fn();
    const { wizard, calls } = renderWizard(
      config({ provider: 'custom', configSets: [set({ provider: 'custom', model: '' })] }),
      { adjust: (state) => ({ ...state, advance }) }
    );

    wizard.submit();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.createEndpoint).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it('stays where it is, with the reason, when main refuses the save', async () => {
    const refused: CallResult = { ok: false, error: 'api.providers.errors.duplicate' };
    const { wizard, calls } = renderWizard(config(), { answer: refused });

    const result = await wizard.saveEndpoint(null, values);

    expect(result).toEqual(refused);
    expect(calls.changeProvider).not.toHaveBeenCalled();
  });
});

describe('the second step', () => {
  const withKey = config({
    provider: 'anthropic',
    providerCredentials: { anthropic: { apiKey: 'sk-ant-stored' } },
    configSets: [set({ name: 'Work', provider: 'anthropic', model: 'claude-opus-5' })],
  });

  it('asks for the model, and says which config set and provider it is for', () => {
    const { html } = renderWizard(withKey, { adjust: atModelStep });

    expect(html).toContain('api.firstRun.modelIntro');
    expect(html).toContain('api.model');
    expect(html).toContain('Anthropic');
    // Nothing of the first step, and nothing else of a config set.
    expect(html).not.toContain('id="provider-api-key-input"');
    expect(html).not.toContain('api.firstRunSubtitle');
    expect(html).not.toContain('api.thinkingLevel');
    expect(html).not.toContain('api.contextWindow');
  });

  it('shows the model of a custom endpoint as typed, and names the endpoint', () => {
    const hosted = endpoint({ id: 'custom-endpoint-2', apiKey: 'gw-key' });
    const { html } = renderWizard(
      config({
        provider: 'custom',
        customEndpoints: [hosted],
        configSets: [set({ provider: 'custom', endpointId: hosted.id, model: 'gpt-5.4' })],
      }),
      { adjust: atModelStep }
    );

    expect(html).toContain('hosted-gateway');
    expect(html).toContain('id="api-model-input"');
    expect(html).toContain('value="gpt-5.4"');
    // Still the model alone: an endpoint's token limits are on the tab.
    expect(html).not.toContain('api.contextWindow');
  });

  it('saves the config set on Start — its own fields, no credential — and closes', async () => {
    const save = stubSetSave();
    const { wizard, calls, onClose } = renderWizard(withKey, { adjust: atModelStep });

    wizard.submit();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1);
    const payload = save.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      activeConfigSetId: 'default',
      provider: 'anthropic',
      model: 'claude-opus-5',
      thinkingLevel: 'off',
    });
    for (const field of ['apiKey', 'baseUrl', 'customProtocol']) {
      expect(payload, field).not.toHaveProperty(field);
    }
    // The credential was the first step's to save.
    expect(calls.saveProviderCredential).not.toHaveBeenCalled();
  });

  it('names the endpoint in that save for a config set on a custom endpoint', async () => {
    const save = stubSetSave();
    const hosted = endpoint({ id: 'custom-endpoint-2', apiKey: 'gw-key' });
    const { wizard, onClose } = renderWizard(
      config({
        provider: 'custom',
        customEndpoints: [hosted],
        configSets: [set({ provider: 'custom', endpointId: hosted.id, model: 'gpt-5.4' })],
      }),
      { adjust: atModelStep }
    );

    wizard.submit();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({
      provider: 'custom',
      endpointId: 'custom-endpoint-2',
      model: 'gpt-5.4',
    });
  });

  it('is busy from the press itself: nothing is waited for before the save is marked', () => {
    // Back and the frame's close are switched off by `busy`, which a save of
    // the config set raises through `sets.isSaving`. That mark is set in the
    // same turn as the press — React then draws the buttons off before the
    // next press can be delivered. An `await` slipped in ahead of it would
    // open a moment in which Back still worked while Start was saving.
    const beforeFirstWait = (source: string, from: string, to: string) => {
      const start = source.indexOf(from);
      const end = source.indexOf(to, start);
      expect(start, from).toBeGreaterThan(-1);
      expect(end, to).toBeGreaterThan(start);
      return source.slice(start, end);
    };

    const press = beforeFirstWait(
      read('src/renderer/components/FirstRunWizardSteps.tsx'),
      'wizard.submitRef.current = () => {\n    void startOnce(',
      'await handleSave('
    );
    const once = beforeFirstWait(
      read('src/renderer/components/settings/SettingsDialogFrame.tsx'),
      'export function useSingleFlight() {',
      'await action();'
    );
    const form = beforeFirstWait(
      read('src/renderer/hooks/useModelSetForm.ts'),
      'const handleSave = useCallback(',
      'await saveSet(presets)'
    );
    const save = beforeFirstWait(
      read('src/renderer/hooks/useModelSets.ts'),
      'const saveSet = useCallback(',
      "dispatch({ type: 'SET_IS_SAVING', payload: true });"
    );
    for (const [name, stretch] of Object.entries({ press, once, form, save })) {
      expect(stretch, name).not.toMatch(/\bawait\b/);
    }

    expect(read('src/renderer/hooks/useFirstRunWizard.ts')).toContain(
      'busy: isSavingCredential || sets.isSaving || sets.isMutatingConfigSet,'
    );
  });

  it('does not start, and stays open, with no model', async () => {
    const save = stubSetSave();
    const hosted = endpoint({ id: 'custom-endpoint-2', apiKey: 'gw-key' });
    const { wizard, onClose } = renderWizard(
      config({
        provider: 'custom',
        customEndpoints: [hosted],
        configSets: [set({ provider: 'custom', endpointId: hosted.id, model: '' })],
      }),
      { adjust: atModelStep }
    );

    wizard.submit();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(save).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when main refuses the save', async () => {
    const save = stubSetSave({ success: false, error: 'the store said no' });
    const { wizard, onClose } = renderWizard(withKey, { adjust: atModelStep });

    wizard.submit();

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the two buttons of a step', () => {
  function renderFooter(adjust: (wizard: FirstRunWizardState) => FirstRunWizardState) {
    const { wizard } = renderWizard(config());
    return renderToString(createElement(FirstRunWizardFooter, { wizard: adjust(wizard) }));
  }

  it('are Cancel and Continue on the first step', () => {
    const html = renderFooter((wizard) => wizard);

    expect(html).toContain('common.cancel');
    expect(html).toContain('api.firstRun.continue');
    expect(html).not.toContain('api.firstRun.back');
    expect(html).not.toContain('api.getStarted');
  });

  it('are Back and Start on the second', () => {
    const html = renderFooter(atModelStep);

    expect(html).toContain('api.firstRun.back');
    expect(html).toContain('api.getStarted');
    expect(html).not.toContain('common.cancel');
    expect(html).not.toContain('api.firstRun.continue');
  });

  it('have one submit button, so Enter in a field does what a click on it does', () => {
    for (const adjust of [(wizard: FirstRunWizardState) => wizard, atModelStep]) {
      const html = renderFooter(adjust);
      expect(html.match(/type="submit"/g)).toHaveLength(1);
      expect(html.match(/type="button"/g)).toHaveLength(1);
    }
  });

  it('keep the pressed button able to hold focus while its save is on its way', () => {
    const html = renderFooter((wizard) => ({ ...wizard, busy: true }));
    const submit = html.match(/<button[^>]*type="submit"[^>]*>/)![0];

    expect(submit).toContain('aria-disabled="true"');
    expect(submit).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('common.saving');
    // The other button is not the one that was pressed, and is simply off.
    expect(html.match(/<button[^>]*type="button"[^>]*>/)![0]).toMatch(/\sdisabled=""/);
  });

  it('switch the submit button off only when there is nothing to send at all', () => {
    const submitOf = (html: string) => html.match(/<button[^>]*type="submit"[^>]*>/)![0];

    expect(submitOf(renderFooter((wizard) => wizard))).not.toMatch(/\sdisabled=""/);
    expect(submitOf(renderFooter((wizard) => ({ ...wizard, isLoading: true })))).toMatch(
      /\sdisabled=""/
    );
    expect(submitOf(renderFooter((wizard) => ({ ...wizard, target: null })))).toMatch(
      /\sdisabled=""/
    );
    // On the second step there is always a config set to save.
    expect(
      submitOf(renderFooter((wizard) => ({ ...atModelStep(wizard), target: null })))
    ).not.toMatch(/\sdisabled=""/);
  });

  it('have the left-hand one close the wizard on the first step and go back on the second', () => {
    // Nothing here can press a button, so which one does what is read from the
    // source: Cancel and Back sit in the same place.
    const footer = read('src/renderer/components/FirstRunWizard.tsx');
    const cancelAt = footer.indexOf('key="cancel"');
    const backAt = footer.indexOf('key="back"');
    const submitAt = footer.indexOf('key={step}');

    expect(cancelAt).toBeGreaterThan(-1);
    expect(backAt).toBeGreaterThan(cancelAt);
    expect(submitAt).toBeGreaterThan(backAt);
    expect(footer.slice(cancelAt, backAt)).toContain('onClick={wizard.close}');
    expect(footer.slice(cancelAt, backAt)).not.toContain('wizard.goBack');
    expect(footer.slice(backAt, submitAt)).toContain('onClick={wizard.goBack}');
    expect(footer.slice(backAt, submitAt)).not.toContain('wizard.close');
  });

  it('do not take the second half of a double click', () => {
    // Both steps have their buttons in the same two places.
    expect(isRepeatedClick({ detail: 2 })).toBe(true);
    expect(isRepeatedClick({ detail: 3 })).toBe(true);
    expect(isRepeatedClick({ detail: 1 })).toBe(false);
    // A press of Enter or Space on a focused button.
    expect(isRepeatedClick({ detail: 0 })).toBe(false);

    const footer = read('src/renderer/components/FirstRunWizard.tsx');
    expect(footer).toContain('onClickCapture={ignoreRepeatedClick}');
  });
});

describe('the wizard as a dialog', () => {
  const wizard = read('src/renderer/components/FirstRunWizard.tsx');
  const steps = read('src/renderer/components/FirstRunWizardSteps.tsx');

  it('is drawn in the frame the Settings dialogs have, as a form', () => {
    // Escape, Tab kept inside, focus returned, Enter as a form submit.
    expect(wizard).toContain('<SettingsDialogFrame');
    expect(wizard).toContain('onSubmit={wizard.submit}');
    expect(wizard).toContain('busy={wizard.busy}');
  });

  it('is mounted only while it is open', () => {
    const shell = read('src/renderer/components/ConfigModal.tsx');

    expect(renderToString(createElement(ConfigModal, { isOpen: false, onClose: vi.fn() }))).toBe(
      ''
    );
    expect(shell.indexOf('if (!isOpen) {')).toBeGreaterThan(-1);
    expect(shell.indexOf('<FirstRunWizard')).toBeGreaterThan(shell.indexOf('if (!isOpen) {'));
  });

  it('draws the very fields the Providers tab and the Model Sets tab have', () => {
    expect(steps).toContain('useProviderConfigDialog({');
    expect(steps).toContain('<ProviderCredentialFields form={form} />');
    expect(steps).toContain('useCustomEndpointDialog({');
    expect(steps).toContain('<CustomEndpointFields form={form} />');
    expect(steps).toContain('useModelSetForm(wizard.settings)');
    expect(steps).toContain('<ModelPickerField form={form} />');
  });

  it('opens a provider on the same values as the Providers tab does', () => {
    const tab = read('src/renderer/components/settings/SettingsProviders.tsx');

    expect(steps).toContain('providerDialogValues({');
    expect(tab).toContain('providerDialogValues({');
  });

  it('builds no save of its own: each half goes through the call the tabs make', () => {
    for (const file of [
      'src/renderer/hooks/useFirstRunWizard.ts',
      'src/renderer/hooks/first-run-wizard-view.ts',
      'src/renderer/components/FirstRunWizard.tsx',
      'src/renderer/components/FirstRunWizardSteps.tsx',
      'src/renderer/components/ConfigModal.tsx',
    ]) {
      const source = read(file);
      expect(source, file).not.toContain('electronAPI');
      expect(source, file).not.toContain('buildCombinedSavePayload');
      expect(source, file).not.toContain('useApiConfigState');
    }
  });

  it('gives each step a submit button of its own', () => {
    expect(wizard).toContain('key={step}');
  });

  it('puts focus on the second step when it arrives, not into its field', () => {
    expect(steps).toContain('stepRef.current?.focus();');
    expect(steps).toContain('tabIndex={-1}');
  });
});

describe('controls that now sit inside a form', () => {
  it('never let Enter in the search box of a list submit the form around it', () => {
    // With nothing to pick the handler used to return before it reached Enter,
    // and the browser then took the key for "submit".
    const combobox = read('src/renderer/components/SearchableCombobox.tsx');
    const handler = combobox.slice(
      combobox.indexOf('const handleSearchKeyDown = useCallback('),
      combobox.indexOf('// Scroll focused item into view')
    );
    const enterAt = handler.indexOf("if (e.key === 'Enter') {");
    const nothingToPickAt = handler.indexOf('if (selectableItems.length === 0) return;');

    expect(enterAt).toBeGreaterThan(-1);
    expect(nothingToPickAt).toBeGreaterThan(enterAt);
    expect(handler.slice(enterAt, nothingToPickAt)).toContain('e.preventDefault();');
  });

  it('are all plain buttons, apart from the one that submits', () => {
    // A button with no type inside a form submits it.
    for (const file of [
      'src/renderer/components/FirstRunWizard.tsx',
      'src/renderer/components/SearchableCombobox.tsx',
      'src/renderer/components/settings/ModelFieldsSection.tsx',
    ]) {
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const buttons = source.match(/<button\b/g) ?? [];
      const typed = source.match(/\btype="(?:button|submit)"/g) ?? [];
      expect(buttons.length, file).toBeGreaterThan(0);
      expect(typed, file).toHaveLength(buttons.length);
    }
    expect(read('src/renderer/components/FirstRunWizardSteps.tsx')).not.toMatch(/<button\b/);
  });
});

describe('what opens the wizard', () => {
  const app = read('src/renderer/App.tsx');
  const handler = app.slice(
    app.indexOf("if (action === 'open_api_settings') {"),
    app.indexOf("} else if (action === 'navigate_settings_skills') {")
  );

  it('finds the branch of the notice button, so the checks below cannot pass on nothing', () => {
    expect(handler.length).toBeGreaterThan(100);
  });

  it('is the notice button when nothing is set up to start a chat with', () => {
    const elseAt = handler.indexOf('} else {');

    expect(elseAt).toBeGreaterThan(-1);
    expect(handler.slice(elseAt)).toContain('setShowConfigModal(true);');
    expect(handler.slice(elseAt)).not.toContain('setShowSettings');
  });

  it('never has Settings drawn under it, whatever asks for Settings meanwhile', () => {
    // The wizard and the Settings panel each hold a copy of the same state. The
    // menu shortcut can ask for Settings while the wizard is open; drawn then,
    // its copy would miss what the wizard goes on to save.
    expect(app).toContain('const settingsOnScreen = showSettings && !showConfigModal;');
    expect(app).toContain('{settingsOnScreen ? (');
    expect(app).not.toContain('{showSettings ? (');
  });

  it('has nothing under it move when Settings is asked for meanwhile', () => {
    // What follows "Settings is open" — the collapsed sidebar, the hidden
    // context panel — follows whether Settings is on screen, not the request.
    // The request is read in one place: where that is worked out.
    expect(app).toContain('{activeSessionId && !settingsOnScreen && (');
    expect(app).toContain('if (settingsOnScreen) {');
    expect(app).toContain('}, [settingsOnScreen]);');
    expect(app.match(/\bshowSettings\b/g)).toHaveLength(2); // read from the store, and used once
  });

  it('is not when another config set can: that is a config set to edit, in Settings', () => {
    const configuredAt = handler.indexOf('if (isConfigured) {');
    const elseAt = handler.indexOf('} else {');
    const configured = handler.slice(configuredAt, elseAt);

    expect(configuredAt).toBeGreaterThan(-1);
    expect(configured).toContain("setSettingsTab('modelSets');");
    expect(configured).toContain('setShowSettings(true);');
    expect(configured).not.toContain('setShowConfigModal');
  });

  it('no longer has the app save a config itself', () => {
    expect(app).not.toContain('config.save(');
    expect(app).not.toContain('handleConfigSave');
    expect(app).toContain('<ConfigModal isOpen={showConfigModal} onClose={handleConfigClose} />');
  });
});
