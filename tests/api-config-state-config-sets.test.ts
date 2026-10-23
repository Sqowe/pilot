/**
 * The **model sets** half of the API-settings form state
 * (`src/renderer/hooks/model-sets-state.ts`): the list of config sets, loading
 * the active one into the form, what counts as an unsaved change to it, and
 * what a save sends.
 *
 * A config set selects a provider and a model and holds no credential, so
 * nothing here involves an API key. How a credential reads is covered by
 * `api-settings-view.test.ts`, and the guarantee that the two halves never
 * leak into each other by `api-config-draft-independence.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ApiConfigSet, AppConfig, CustomEndpoint } from '../src/renderer/types';
import type { ProviderCatalogEntry } from '../src/shared/provider-catalog';
import {
  FALLBACK_PROVIDER_PRESETS,
  defaultModelFields,
  finalModelOf,
  parseTokenLimitField,
  withoutDiscoveredModel,
} from '../src/renderer/hooks/api-config-shared';
import {
  buildConfigSets,
  buildModelSetSavePayload,
  buildModelSetSignature,
  buildModelSetsBootstrap,
  createModelSetsState,
  hasUnsavedModelSetChanges,
  hydrateModelSetDraft,
  modelMemoryKey,
  modelSetsReducer,
  type ModelSetsState,
} from '../src/renderer/hooks/model-sets-state';

const presets = FALLBACK_PROVIDER_PRESETS;

/**
 * A provider catalogue that offers the given models for OpenRouter — what the
 * picker shows, and what decides whether a stored model is picked or typed.
 */
function catalogue(models: Array<{ id: string; name: string }>): ProviderCatalogEntry[] {
  return [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'builtin',
      category: 'featured',
      piProvider: 'openrouter',
      routeProtocol: 'openai',
      formShape: {
        apiKey: true,
        baseUrl: false,
        protocol: false,
        contextWindow: false,
        modelDropdown: true,
        manualModelToggle: false,
      },
      modelOptions: models,
    },
  ];
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

function endpoint(overrides: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-endpoint-1',
    name: 'gateway',
    protocol: 'anthropic',
    baseUrl: 'http://127.0.0.1:9000',
    apiKey: 'gw-key',
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

/** A state as the hook holds it once a config has loaded. */
function loadedState(source: AppConfig): ModelSetsState {
  const state = createModelSetsState(source, presets);
  return modelSetsReducer(state, {
    type: 'APPLY_PERSISTED',
    configSets: state.configSets,
    activeConfigSetId: state.activeConfigSetId,
    draft: state.draft,
  });
}

describe('listing config sets', () => {
  it('takes the config sets from the app config as they are', () => {
    const sets = buildConfigSets(
      config({
        activeConfigSetId: 'work',
        configSets: [
          set({ name: '默认方案', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }),
          set({
            id: 'work',
            name: 'Work OpenAI',
            isSystem: false,
            provider: 'openai',
            model: 'gpt-5.2-mini',
            enableThinking: true,
            thinkingLevel: 'high',
          }),
        ],
      })
    );

    expect(sets.length).toBe(2);
    expect(sets[1].name).toBe('Work OpenAI');
    expect(sets[1].provider).toBe('openai');
    expect(sets[1].model).toBe('gpt-5.2-mini');
    expect(sets[1].thinkingLevel).toBe('high');
  });

  it('copies the known fields only, whatever else an incoming set carries', () => {
    // A set holds no credential. Building each one field by field is what keeps
    // that true even if the object that arrives has more on it — a pre-split
    // `profiles` map, say, with keys in it.
    const sets = buildConfigSets(
      config({
        configSets: [
          {
            ...set({ provider: 'custom', endpointId: 'custom-endpoint-1', contextWindow: 64000 }),
            customProtocol: 'openai',
            activeProfileKey: 'custom:openai',
            profiles: {
              'custom:openai': { apiKey: 'sk-leftover', baseUrl: 'http://x', model: 'm' },
            },
            apiKey: 'sk-on-the-set',
          } as never,
        ],
      })
    );

    expect(Object.keys(sets[0]).sort()).toEqual(
      [
        'id',
        'name',
        'isSystem',
        'provider',
        'endpointId',
        'model',
        'contextWindow',
        'enableThinking',
        'thinkingLevel',
        'updatedAt',
      ].sort()
    );
    expect(JSON.stringify(sets)).not.toMatch(/sk-leftover|sk-on-the-set/);
  });

  it('keeps an endpoint pointer on a custom set only', () => {
    const sets = buildConfigSets(
      config({ configSets: [set({ provider: 'anthropic', endpointId: 'custom-endpoint-1' })] })
    );

    expect(sets[0]).not.toHaveProperty('endpointId');
  });

  it('builds a fallback default set from the flat fields when configSets are missing', () => {
    const sets = buildConfigSets({
      provider: 'openrouter',
      apiKey: 'sk-or',
      baseUrl: 'https://openrouter.ai/api',
      model: 'anthropic/claude-sonnet-4.5',
      isConfigured: true,
    } as AppConfig);

    expect(sets.length).toBe(1);
    expect(sets[0].isSystem).toBe(true);
    expect(sets[0].provider).toBe('openrouter');
    expect(sets[0].model).toBe('anthropic/claude-sonnet-4.5');
    // A set never carries the credential, not even one built as a stand-in.
    expect(JSON.stringify(sets)).not.toContain('sk-or');
  });

  it('derives a thinking level for a set that only has the legacy boolean', () => {
    const sets = buildConfigSets(
      config({
        configSets: [{ ...set({ enableThinking: true }), thinkingLevel: undefined } as never],
      })
    );

    expect(sets[0].thinkingLevel).toBe('medium');
  });

  it('falls back to the first set when the active id names none', () => {
    const bootstrap = buildModelSetsBootstrap(
      config({
        provider: 'openai',
        model: 'gpt-5.4',
        activeConfigSetId: 'missing',
        configSets: [set({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' })],
      }),
      presets
    );

    expect(bootstrap.configSets).toHaveLength(1);
    expect(bootstrap.activeConfigSetId).toBe('default');
    // The form shows the set it resolved to, not the flat fields of a set that
    // does not exist.
    expect(bootstrap.draft.provider).toBe('openrouter');
  });
});

describe('loading a config set into the form', () => {
  it('shows a model from the preset list as picked', () => {
    const draft = hydrateModelSetDraft(set({ provider: 'openai', model: 'gpt-5.4' }), presets, []);

    expect(draft.provider).toBe('openai');
    expect(draft.model).toBe('gpt-5.4');
    expect(draft.useCustomModel).toBe(false);
    expect(draft.customModel).toBe('');
  });

  it('shows a model the preset list does not have as typed', () => {
    const draft = hydrateModelSetDraft(
      set({ provider: 'openai', model: 'my-fine-tune' }),
      presets,
      []
    );

    expect(draft.useCustomModel).toBe(true);
    expect(draft.customModel).toBe('my-fine-tune');
    expect(finalModelOf(draft)).toBe('my-fine-tune');
  });

  it('carries the token limits and the thinking level', () => {
    const draft = hydrateModelSetDraft(
      set({ contextWindow: 200000, maxTokens: 8192, thinkingLevel: 'high', enableThinking: true }),
      presets,
      []
    );

    expect(draft.contextWindow).toBe('200000');
    expect(draft.maxTokens).toBe('8192');
    expect(draft.thinkingLevel).toBe('high');
  });

  it('points a custom set at its endpoint and types its model', () => {
    const draft = hydrateModelSetDraft(
      set({ provider: 'custom', endpointId: 'custom-endpoint-1', model: 'claude-opus-5' }),
      presets,
      [endpoint({})]
    );

    expect(draft.provider).toBe('custom');
    expect(draft.endpointId).toBe('custom-endpoint-1');
    expect(draft.useCustomModel).toBe(true);
    expect(draft.customModel).toBe('claude-opus-5');
  });

  it('shows no model for a custom set that names none', () => {
    const draft = hydrateModelSetDraft(set({ provider: 'custom', model: '' }), presets, []);

    expect(draft.endpointId).toBe('');
    expect(draft.useCustomModel).toBe(true);
    expect(draft.customModel).toBe('');
    expect(finalModelOf(draft)).toBe('');
  });

  it('shows a custom set model as typed even when a preset shares its id', () => {
    // The form has no picker for a custom endpoint. Treating this as "picked"
    // would leave the typed field empty while a model was in fact saved.
    const presetId = presets.custom.models[0].id;
    const draft = hydrateModelSetDraft(
      set({ provider: 'custom', endpointId: 'custom-endpoint-1', model: presetId }),
      presets,
      [endpoint({})]
    );

    expect(draft.useCustomModel).toBe(true);
    expect(draft.customModel).toBe(presetId);
    expect(finalModelOf(draft)).toBe(presetId);
  });

  it('shows a model the catalogue offers as picked, even when the curated list does not name it', () => {
    // The picker lists the provider's whole catalogue; the curated list is only
    // a short pick out of it. A model the picker offers must open as picked —
    // as typed it would be a bare text field, and a builtin cloud provider has
    // no toggle back to the list.
    const draft = hydrateModelSetDraft(
      set({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' }),
      presets,
      [],
      catalogue([
        { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017' },
      ])
    );

    expect(draft.useCustomModel).toBe(false);
    expect(draft.model).toBe('deepseek/deepseek-v4.1-flash-1017');
    expect(draft.customModel).toBe('');
    expect(finalModelOf(draft)).toBe('deepseek/deepseek-v4.1-flash-1017');
  });

  it('still types a model that neither the curated list nor the catalogue has', () => {
    const draft = hydrateModelSetDraft(
      set({ provider: 'openrouter', model: 'my-fine-tune' }),
      presets,
      [],
      catalogue([
        { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash' },
      ])
    );

    expect(draft.useCustomModel).toBe(true);
    expect(draft.customModel).toBe('my-fine-tune');
    expect(finalModelOf(draft)).toBe('my-fine-tune');
  });

  it('types a model outside the curated list while the catalogue has not arrived', () => {
    // Before the catalogue is loaded the curated list is all the app knows, so
    // a model outside it stays typed — the form has no list to pick from yet.
    const draft = hydrateModelSetDraft(
      set({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' }),
      presets,
      []
    );

    expect(draft.useCustomModel).toBe(true);
    expect(draft.customModel).toBe('deepseek/deepseek-v4.1-flash-1017');
  });

  it('keeps a custom endpoint typed even when the catalogue lists its model', () => {
    const draft = hydrateModelSetDraft(
      set({ provider: 'custom', endpointId: 'custom-endpoint-1', model: 'gpt-5.4' }),
      presets,
      [endpoint({})],
      catalogue([{ id: 'gpt-5.4', name: 'gpt-5.4' }])
    );

    expect(draft.useCustomModel).toBe(true);
    expect(draft.customModel).toBe('gpt-5.4');
  });

  it('drops a pointer to an endpoint that no longer exists', () => {
    const draft = hydrateModelSetDraft(
      set({ provider: 'custom', endpointId: 'custom-endpoint-9', model: 'm' }),
      presets,
      [endpoint({})]
    );

    expect(draft.endpointId).toBe('');
  });

  it('rewrites the two legacy model spellings so the picker can find them', () => {
    const openrouter = hydrateModelSetDraft(
      set({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }),
      presets,
      []
    );
    expect(finalModelOf(openrouter)).toBe('anthropic/claude-sonnet-4.5');

    const gemini = hydrateModelSetDraft(
      set({ provider: 'gemini', model: 'gemini/gemini-2.5-flash' }),
      presets,
      []
    );
    expect(finalModelOf(gemini)).toBe('gemini-2.5-flash');
  });

  it('shows a custom endpoint on the local Ollama port as Ollama', () => {
    // An Ollama setup from before Ollama had its own provider. Shown as Ollama
    // so the user gets model discovery; the list of sets is left as persisted.
    const legacy = config({
      provider: 'custom',
      customProtocol: 'openai',
      endpointId: 'custom-endpoint-1',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.5:0.8b',
      activeConfigSetId: 'legacy-ollama',
      customEndpoints: [
        endpoint({ protocol: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: '' }),
      ],
      configSets: [
        set({
          id: 'legacy-ollama',
          name: 'Legacy Ollama',
          isSystem: false,
          provider: 'custom',
          endpointId: 'custom-endpoint-1',
          model: 'qwen3.5:0.8b',
        }),
      ],
    });

    const bootstrap = buildModelSetsBootstrap(legacy, presets);
    expect(bootstrap.draft.provider).toBe('ollama');
    expect(bootstrap.draft.endpointId).toBe('');
    expect(finalModelOf(bootstrap.draft)).toBe('qwen3.5:0.8b');
    expect(bootstrap.configSets[0].provider).toBe('custom');

    // Presenting it differently is not an edit: the form opens clean.
    expect(hasUnsavedModelSetChanges(loadedState(legacy))).toBe(false);
  });

  it('keeps a remote custom OpenAI endpoint generic', () => {
    const draft = hydrateModelSetDraft(
      set({ provider: 'custom', endpointId: 'custom-endpoint-1', model: 'qwen3.5:0.8b' }),
      presets,
      [endpoint({ protocol: 'openai', baseUrl: 'https://relay.example.internal/v1' })]
    );

    expect(draft.provider).toBe('custom');
  });
});

describe('unsaved changes to a config set', () => {
  it('generates a stable signature and detects a changed model', () => {
    const state = loadedState(config({}));
    expect(buildModelSetSignature(state.draft)).toBe(buildModelSetSignature({ ...state.draft }));
    expect(hasUnsavedModelSetChanges(state)).toBe(false);

    const changed = modelSetsReducer(state, {
      type: 'UPDATE_MODEL_FIELDS',
      updater: (previous) => ({ ...previous, customModel: 'claude-opus-5', useCustomModel: true }),
    });
    expect(hasUnsavedModelSetChanges(changed)).toBe(true);
  });

  it('reads as unchanged before any config has loaded', () => {
    // The bootstrap defaults are not something the user changed.
    const state = createModelSetsState(null, presets);
    const edited = modelSetsReducer(state, { type: 'SET_THINKING_LEVEL', payload: 'high' });

    expect(hasUnsavedModelSetChanges(edited)).toBe(false);
  });

  it('treats an edited context window or max tokens as an unsaved change', () => {
    // Both limits are persisted on the config set. A draft that differs only
    // there used to look clean, so switching sets dropped the edit without the
    // unsaved-changes dialog ever appearing.
    const state = loadedState(
      config({ provider: 'custom', configSets: [set({ provider: 'custom' })] })
    );
    const base = buildModelSetSignature(state.draft);

    const withContextWindow = buildModelSetSignature({ ...state.draft, contextWindow: '200000' });
    const withMaxTokens = buildModelSetSignature({ ...state.draft, maxTokens: '8192' });

    expect(withContextWindow).not.toBe(base);
    expect(withMaxTokens).not.toBe(base);
    expect(withContextWindow).not.toBe(withMaxTokens);
  });

  it('treats a different provider or endpoint as an unsaved change', () => {
    const state = loadedState(
      config({
        provider: 'custom',
        customEndpoints: [
          endpoint({}),
          endpoint({ id: 'custom-endpoint-2', baseUrl: 'http://b:1' }),
        ],
        configSets: [set({ provider: 'custom', endpointId: 'custom-endpoint-1', model: 'm' })],
      })
    );

    const repointed = modelSetsReducer(state, {
      type: 'CHANGE_PROVIDER',
      provider: 'custom',
      endpointId: 'custom-endpoint-2',
      defaults: defaultModelFields('custom', 'anthropic', presets),
    });
    expect(hasUnsavedModelSetChanges(repointed)).toBe(true);

    const moved = modelSetsReducer(state, {
      type: 'CHANGE_PROVIDER',
      provider: 'anthropic',
      endpointId: '',
      defaults: defaultModelFields('anthropic', 'anthropic', presets),
    });
    expect(hasUnsavedModelSetChanges(moved)).toBe(true);
  });

  it('parses a token-limit field to a number the store can act on', () => {
    expect(parseTokenLimitField('200000')).toBe(200000);
    // Empty, non-numeric and non-positive all mean "no override". They are sent
    // as 0 rather than left out: IPC drops `undefined`, and the store reads an
    // absent key as "leave the stored limit unchanged".
    expect(parseTokenLimitField('')).toBe(0);
    expect(parseTokenLimitField('abc')).toBe(0);
    expect(parseTokenLimitField('-5')).toBe(0);
    expect(parseTokenLimitField('0')).toBe(0);
  });

  it('keeps the draft when persisted state moves underneath it', () => {
    // A rename, or a credential saved by the other half of the form: the list is
    // refreshed, the user's edits are not thrown away.
    const state = loadedState(config({}));
    const edited = modelSetsReducer(state, { type: 'SET_THINKING_LEVEL', payload: 'high' });

    const rebased = modelSetsReducer(edited, {
      type: 'REBASE_PERSISTED',
      configSets: [set({ name: 'Renamed' })],
      activeConfigSetId: 'default',
    });

    expect(rebased.configSets[0].name).toBe('Renamed');
    expect(rebased.draft.thinkingLevel).toBe('high');
    expect(hasUnsavedModelSetChanges(rebased)).toBe(true);
  });

  it('reads as saved once the draft is marked saved', () => {
    const state = loadedState(config({}));
    const edited = modelSetsReducer(state, { type: 'SET_THINKING_LEVEL', payload: 'high' });

    expect(hasUnsavedModelSetChanges(modelSetsReducer(edited, { type: 'MARK_SAVED' }))).toBe(false);
  });
});

describe('changing the provider of a config set', () => {
  const openaiDefaults = defaultModelFields('openai', 'openai', presets);
  const anthropicDefaults = defaultModelFields('anthropic', 'anthropic', presets);

  it('starts the new provider on its own default model, not the old provider model', () => {
    // A set stores one model. Carrying it across would leave a Claude id
    // selected on OpenAI.
    const state = loadedState(config({}));

    const onOpenAI = modelSetsReducer(state, {
      type: 'CHANGE_PROVIDER',
      provider: 'openai',
      endpointId: '',
      defaults: openaiDefaults,
    });

    expect(onOpenAI.draft.provider).toBe('openai');
    expect(finalModelOf(onOpenAI.draft)).toBe(presets.openai.models[0].id);
    expect(finalModelOf(onOpenAI.draft)).not.toBe('claude-sonnet-4-6');
  });

  it('remembers what was chosen for each provider until the form is saved or reloaded', () => {
    let state = loadedState(config({}));
    state = modelSetsReducer(state, {
      type: 'UPDATE_MODEL_FIELDS',
      updater: (previous) => ({ ...previous, customModel: 'claude-opus-5', useCustomModel: true }),
    });

    state = modelSetsReducer(state, {
      type: 'CHANGE_PROVIDER',
      provider: 'openai',
      endpointId: '',
      defaults: openaiDefaults,
    });
    state = modelSetsReducer(state, {
      type: 'UPDATE_MODEL_FIELDS',
      updater: (previous) => ({ ...previous, contextWindow: '128000' }),
    });

    // Back to Anthropic: what was typed there is still there.
    state = modelSetsReducer(state, {
      type: 'CHANGE_PROVIDER',
      provider: 'anthropic',
      endpointId: '',
      defaults: anthropicDefaults,
    });
    expect(finalModelOf(state.draft)).toBe('claude-opus-5');
    expect(state.draft.contextWindow).toBe('');

    // And OpenAI again: its limit is still there too.
    state = modelSetsReducer(state, {
      type: 'CHANGE_PROVIDER',
      provider: 'openai',
      endpointId: '',
      defaults: openaiDefaults,
    });
    expect(state.draft.contextWindow).toBe('128000');

    // Applying persisted state ends the session: nothing is remembered.
    const reloaded = modelSetsReducer(state, {
      type: 'APPLY_PERSISTED',
      configSets: state.configSets,
      activeConfigSetId: state.activeConfigSetId,
      draft: hydrateModelSetDraft(state.configSets[0], presets, []),
    });
    expect(reloaded.modelMemory).toEqual({});
  });

  it('keeps the thinking level across a provider change', () => {
    // The level is the user's intent, independent of the model.
    let state = loadedState(config({}));
    state = modelSetsReducer(state, { type: 'SET_THINKING_LEVEL', payload: 'high' });

    state = modelSetsReducer(state, {
      type: 'CHANGE_PROVIDER',
      provider: 'openai',
      endpointId: '',
      defaults: openaiDefaults,
    });

    expect(state.draft.thinkingLevel).toBe('high');
  });

  it('remembers a custom provider model per endpoint', () => {
    // Two gateways serve different models, so one memory for "custom" would
    // offer the first gateway's model on the second.
    expect(modelMemoryKey('custom', 'custom-endpoint-1')).not.toBe(
      modelMemoryKey('custom', 'custom-endpoint-2')
    );
    expect(modelMemoryKey('anthropic', '')).toBe('anthropic');
  });

  it('keeps what was typed for each endpoint when a set moves between two of them', () => {
    // Moving a set to another endpoint goes through the same action as moving
    // it to another provider, so the model stays with the endpoint it was typed
    // for instead of following the set to a gateway that may not serve it.
    const toEndpoint = (current: ModelSetsState, endpointId: string, endpointModel: string) =>
      modelSetsReducer(current, {
        type: 'CHANGE_PROVIDER',
        provider: 'custom',
        endpointId,
        defaults: defaultModelFields('custom', 'anthropic', presets, endpointModel),
      });
    const typeModel = (current: ModelSetsState, model: string) =>
      modelSetsReducer(current, {
        type: 'UPDATE_MODEL_FIELDS',
        updater: (fields) => ({ ...fields, customModel: model, useCustomModel: true }),
      });

    const loaded = loadedState(
      config({
        provider: 'custom',
        customEndpoints: [
          endpoint({}),
          endpoint({ id: 'custom-endpoint-2', baseUrl: 'http://b:1' }),
        ],
        configSets: [set({ provider: 'custom', endpointId: 'custom-endpoint-1', model: 'first' })],
      })
    );

    const onSecond = toEndpoint(typeModel(loaded, 'first-edited'), 'custom-endpoint-2', 'second');
    expect(onSecond.draft.endpointId).toBe('custom-endpoint-2');
    expect(finalModelOf(onSecond.draft)).toBe('second');

    const backOnFirst = toEndpoint(typeModel(onSecond, 'second-edited'), 'custom-endpoint-1', '');
    expect(finalModelOf(backOnFirst.draft)).toBe('first-edited');

    const onSecondAgain = toEndpoint(backOnFirst, 'custom-endpoint-2', 'second');
    expect(finalModelOf(onSecondAgain.draft)).toBe('second-edited');
  });

  it('starts a custom endpoint on its own default model when it names one', () => {
    const fields = defaultModelFields('custom', 'anthropic', presets, 'claude-opus-5');

    expect(fields.useCustomModel).toBe(true);
    expect(fields.customModel).toBe('claude-opus-5');
  });
});

describe('forgetting a model when the Ollama address changes', () => {
  const builtIn = [{ id: 'built-in-model', name: 'built-in-model' }];
  const fields = (overrides: Partial<ReturnType<typeof defaultModelFields>>) => ({
    ...defaultModelFields('ollama', 'openai', presets),
    ...overrides,
  });

  it('clears a model that was picked from the old server list', () => {
    // Not a built-in one, so it can only have come from the list of the server
    // the form was pointing at — which says nothing about the new one.
    expect(withoutDiscoveredModel(fields({ model: 'qwen3.5:0.8b' }), builtIn).model).toBe('');
  });

  it('keeps a model the user typed', () => {
    const typed = fields({ customModel: 'qwen3.5:0.8b', useCustomModel: true });

    expect(withoutDiscoveredModel(typed, builtIn)).toBe(typed);
  });

  it('keeps a built-in model, and an empty selection', () => {
    const picked = fields({ model: 'built-in-model' });
    const empty = fields({ model: '' });

    expect(withoutDiscoveredModel(picked, builtIn)).toBe(picked);
    expect(withoutDiscoveredModel(empty, builtIn)).toBe(empty);
  });

  it('leaves a saved Ollama model alone, because it loads as typed', () => {
    // The case that matters on opening Settings: a saved model that is not in
    // the built-in list is shown as typed, so it survives any address reset.
    const draft = hydrateModelSetDraft(
      set({ provider: 'ollama', model: 'my-local-model:latest' }),
      presets,
      []
    );

    expect(draft.useCustomModel).toBe(true);
    expect(
      finalModelOf({ ...draft, ...withoutDiscoveredModel(draft, presets.ollama.models) })
    ).toBe('my-local-model:latest');
  });

  it('leaves a saved built-in Ollama model alone as well', () => {
    const builtInId = presets.ollama.models[0].id;
    const draft = hydrateModelSetDraft(set({ provider: 'ollama', model: builtInId }), presets, []);

    expect(draft.useCustomModel).toBe(false);
    expect(withoutDiscoveredModel(draft, presets.ollama.models).model).toBe(builtInId);
  });
});

describe('what saving a config set sends', () => {
  it('sends the set fields, with token limits as numbers', () => {
    const state = loadedState(
      config({
        configSets: [set({ contextWindow: 200000, thinkingLevel: 'high', enableThinking: true })],
      })
    );

    expect(buildModelSetSavePayload(state.draft, 'default')).toEqual({
      activeConfigSetId: 'default',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contextWindow: 200000,
      // 0, not absent: an absent key would leave a stored limit in place.
      maxTokens: 0,
      enableThinking: true,
      thinkingLevel: 'high',
    });
  });

  it('names the endpoint for a custom set, and an empty one to unpin', () => {
    const pinned = hydrateModelSetDraft(
      set({ provider: 'custom', endpointId: 'custom-endpoint-1', model: 'm' }),
      presets,
      [endpoint({})]
    );
    expect(buildModelSetSavePayload(pinned, 'default').endpointId).toBe('custom-endpoint-1');

    const unpinned = { ...pinned, endpointId: '' };
    expect(buildModelSetSavePayload(unpinned, 'default')).toHaveProperty('endpointId', '');
  });

  it('names no endpoint for a catalog provider', () => {
    const draft = hydrateModelSetDraft(set({}), presets, []);

    expect(buildModelSetSavePayload(draft, 'default')).not.toHaveProperty('endpointId');
  });
});
