/**
 * Draft independence (design §6.4, test plan §8.1).
 *
 * The API-settings form has two kinds of unsaved change — to a credential and
 * to a config set — and they must not leak into each other:
 *
 * - a changed model is never carried into a credential write;
 * - a changed key is never carried into a config-set write;
 * - saving one half never discards an unsaved edit to the other.
 *
 * The first two are checked end to end: the payloads the renderer builds are
 * fed to the real store, and the half that was not saved is compared before and
 * after.
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
import type { AppConfig as RendererAppConfig } from '../src/renderer/types';
import { FALLBACK_PROVIDER_PRESETS } from '../src/renderer/hooks/api-config-shared';
import {
  buildModelSetSavePayload,
  buildModelSetsBootstrap,
  hasUnsavedModelSetChanges,
  modelSetsReducer,
  createModelSetsState,
  type ModelSetsState,
} from '../src/renderer/hooks/model-sets-state';
import {
  createProviderCredentialsState,
  credentialTargetKey,
  hasUnsavedCredentialChanges,
  hydrateCredentialDraft,
  planCredentialSave,
  providerCredentialsReducer,
  selectCredentialDraft,
  type CredentialDraft,
  type CredentialSaveStep,
  type CredentialTarget,
  type ProviderCredentialsState,
} from '../src/renderer/hooks/provider-credentials-state';
import { buildCombinedSavePayload } from '../src/renderer/hooks/useApiConfigState';

const presets = FALLBACK_PROVIDER_PRESETS;
const CREDENTIAL_FIELDS = ['apiKey', 'baseUrl', 'customProtocol'];
const SET_FIELDS = ['activeConfigSetId', 'model', 'contextWindow', 'maxTokens', 'thinkingLevel'];

/** The config as the renderer receives it over IPC. */
function rendererConfig(store: ConfigStore): RendererAppConfig {
  return JSON.parse(JSON.stringify(store.getAll())) as RendererAppConfig;
}

function loadSets(config: RendererAppConfig): ModelSetsState {
  return modelSetsReducer(createModelSetsState(config, presets), {
    type: 'APPLY_PERSISTED',
    ...buildModelSetsBootstrap(config, presets),
  });
}

function editCredential(
  state: ProviderCredentialsState,
  target: CredentialTarget,
  patch: Partial<CredentialDraft>
): ProviderCredentialsState {
  return providerCredentialsReducer(state, {
    type: 'PATCH_DRAFT',
    targetKey: credentialTargetKey(target),
    baseline: hydrateCredentialDraft(state, target, presets),
    patch,
  });
}

/** Run one planned credential save against the store, as the hook does over IPC. */
function runCredentialStep(store: ConfigStore, step: CredentialSaveStep): void {
  if (step.kind === 'provider') store.setProviderCredential(step.payload);
  else if (step.kind === 'update-endpoint') store.updateCustomEndpoint(step.payload);
  else if (step.kind === 'create-endpoint') store.createCustomEndpoint(step.payload);
  else if (step.payload) store.updateCustomEndpoint(step.payload);
}

const anthropic: CredentialTarget = { kind: 'slot', slot: 'anthropic' };

describe('a config-set save never writes a credential', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('carries no credential field, whatever the provider', () => {
    const store = new ConfigStore();
    store.createCustomEndpoint({
      name: 'gw',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:9000/v1',
      apiKey: 'gw-key',
    });
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    store.createSet({ name: 'Gateway', mode: 'blank' });
    store.update({ provider: 'custom', endpointId: store.getAll().customEndpoints[0].id });

    for (const setId of ['default', store.getAll().activeConfigSetId]) {
      store.switchSet({ id: setId });
      const payload = buildModelSetSavePayload(loadSets(rendererConfig(store)).draft, setId);
      for (const field of CREDENTIAL_FIELDS) {
        expect(payload, `set ${setId}`).not.toHaveProperty(field);
      }
      expect(JSON.stringify(payload)).not.toMatch(/sk-ant|gw-key/);
    }
  });

  it('changes the model in the store and leaves every credential as it was', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    store.setProviderCredential({ provider: 'openai', apiKey: 'sk-oai' });
    const before = store.getAll();

    // The user edits the model while a key edit is also pending in the form.
    let sets = loadSets(rendererConfig(store));
    sets = modelSetsReducer(sets, {
      type: 'UPDATE_MODEL_FIELDS',
      updater: (previous) => ({
        ...previous,
        customModel: 'claude-sonnet-5',
        useCustomModel: true,
        contextWindow: '200000',
      }),
    });
    const credentials = editCredential(
      createProviderCredentialsState(rendererConfig(store)),
      anthropic,
      { apiKey: 'sk-ant-PENDING' }
    );
    expect(hasUnsavedCredentialChanges(credentials, presets)).toBe(true);

    store.update(buildModelSetSavePayload(sets.draft, sets.activeConfigSetId));
    const after = store.getAll();

    expect(after.model).toBe('claude-sonnet-5');
    expect(after.contextWindow).toBe(200000);
    // The pending key was not dragged along with the model.
    expect(after.providerCredentials).toEqual(before.providerCredentials);
    expect(after.customEndpoints).toEqual(before.customEndpoints);
    expect(after.apiKey).toBe('sk-ant');
    expect(JSON.stringify(after)).not.toContain('PENDING');
  });

  it('moves a set to another provider without touching either provider key', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    store.setProviderCredential({ provider: 'openai', apiKey: 'sk-oai' });
    const before = store.getAll();

    const sets = modelSetsReducer(loadSets(rendererConfig(store)), {
      type: 'CHANGE_PROVIDER',
      provider: 'openai',
      endpointId: '',
      defaults: {
        model: 'gpt-5.4',
        customModel: '',
        useCustomModel: false,
        contextWindow: '',
        maxTokens: '',
      },
    });
    store.update(buildModelSetSavePayload(sets.draft, sets.activeConfigSetId));
    const after = store.getAll();

    expect(after.provider).toBe('openai');
    expect(after.apiKey).toBe('sk-oai');
    expect(after.providerCredentials).toEqual(before.providerCredentials);
  });
});

describe('a credential save never writes a config set', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('carries no config-set field', () => {
    let credentials = createProviderCredentialsState(null);
    credentials = editCredential(credentials, anthropic, { apiKey: 'sk-ant' });
    credentials = editCredential(
      credentials,
      { kind: 'new-endpoint' },
      { apiKey: 'k', baseUrl: 'http://gw:1', protocol: 'openai' }
    );

    const steps = planCredentialSave(credentials, presets);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      const payload = 'payload' in step && step.payload ? step.payload : {};
      for (const field of SET_FIELDS) {
        expect(payload, step.kind).not.toHaveProperty(field);
      }
    }
  });

  it('rotates a key in the store and leaves every set exactly as it was', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    store.createSet({ name: 'Second', mode: 'blank' });
    store.switchSet({ id: 'default' });
    const before = store.getAll();

    // The user rotates the key while a model edit is also pending in the form.
    const sets = modelSetsReducer(loadSets(rendererConfig(store)), {
      type: 'UPDATE_MODEL_FIELDS',
      updater: (previous) => ({ ...previous, customModel: 'PENDING-MODEL', useCustomModel: true }),
    });
    expect(hasUnsavedModelSetChanges(sets)).toBe(true);
    const credentials = editCredential(
      createProviderCredentialsState(rendererConfig(store)),
      anthropic,
      { apiKey: 'sk-ant-rotated' }
    );

    for (const step of planCredentialSave(credentials, presets)) {
      runCredentialStep(store, step);
    }
    const after = store.getAll();

    expect(after.apiKey).toBe('sk-ant-rotated');
    // Not the model, not the provider, not even a timestamp.
    expect(after.configSets).toEqual(before.configSets);
    expect(after.activeConfigSetId).toBe(before.activeConfigSetId);
    expect(after.model).toBe('claude-opus-5');
    expect(JSON.stringify(after)).not.toContain('PENDING-MODEL');
  });

  it('saves a key for a provider no set is on, without moving any set to it', () => {
    // Impossible through `config.save`, which writes to the active set's
    // provider — and naming another provider there switches the set to it.
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    const before = store.getAll();

    const credentials = editCredential(
      createProviderCredentialsState(rendererConfig(store)),
      { kind: 'slot', slot: 'openai' },
      { apiKey: 'sk-oai' }
    );
    for (const step of planCredentialSave(credentials, presets)) {
      runCredentialStep(store, step);
    }
    const after = store.getAll();

    expect(after.providerCredentials.openai?.apiKey).toBe('sk-oai');
    expect(after.provider).toBe('anthropic');
    expect(after.configSets).toEqual(before.configSets);
  });
});

describe('saving one half never discards an unsaved edit to the other', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('keeps a typed key across a config-set save', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });

    let credentials = editCredential(
      createProviderCredentialsState(rendererConfig(store)),
      anthropic,
      { apiKey: 'sk-typed-not-saved' }
    );
    store.update({ model: 'claude-sonnet-5' });

    // What the form does with the config a set save returns.
    const returned = rendererConfig(store);
    credentials = providerCredentialsReducer(credentials, {
      type: 'APPLY_PERSISTED',
      providerCredentials: returned.providerCredentials,
      customEndpoints: returned.customEndpoints,
      mode: 'rebase',
    });

    expect(selectCredentialDraft(credentials, anthropic, presets).apiKey).toBe(
      'sk-typed-not-saved'
    );
    expect(hasUnsavedCredentialChanges(credentials, presets)).toBe(true);
  });

  it('keeps an edited model across a credential save', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });

    let sets = modelSetsReducer(loadSets(rendererConfig(store)), {
      type: 'UPDATE_MODEL_FIELDS',
      updater: (previous) => ({
        ...previous,
        customModel: 'edited-not-saved',
        useCustomModel: true,
      }),
    });
    store.setProviderCredential({ provider: 'anthropic', apiKey: 'sk-ant-rotated' });

    // What the form does with the config a credential save returns.
    const bootstrap = buildModelSetsBootstrap(rendererConfig(store), presets);
    sets = modelSetsReducer(sets, {
      type: 'REBASE_PERSISTED',
      configSets: bootstrap.configSets,
      activeConfigSetId: bootstrap.activeConfigSetId,
    });

    expect(sets.draft.customModel).toBe('edited-not-saved');
    expect(hasUnsavedModelSetChanges(sets)).toBe(true);
  });
});

describe('the one payload that carries both halves', () => {
  // Used only by a caller that performs the save itself (the first-run dialog).
  // That the Settings form does not use it is asserted against the hook source
  // in `config-ipc-mutation-contract.test.ts`.
  it('gives the combined payload both halves, for the first-run dialog', () => {
    const payload = buildCombinedSavePayload({
      setDraft: {
        provider: 'custom',
        endpointId: '',
        model: '',
        customModel: 'claude-opus-5',
        useCustomModel: true,
        contextWindow: '200000',
        maxTokens: '',
        thinkingLevel: 'high',
      },
      credentialDraft: {
        apiKey: ' gw-key ',
        baseUrl: ' http://127.0.0.1:9000 ',
        protocol: 'anthropic',
      },
      customProtocol: 'anthropic',
      presetBaseUrl: 'https://unused.example',
      activeConfigSetId: 'default',
    });

    expect(payload).toEqual({
      activeConfigSetId: 'default',
      provider: 'custom',
      endpointId: '',
      model: 'claude-opus-5',
      contextWindow: 200000,
      maxTokens: 0,
      enableThinking: true,
      thinkingLevel: 'high',
      apiKey: 'gw-key',
      baseUrl: 'http://127.0.0.1:9000',
      customProtocol: 'anthropic',
    });
  });

  it('lets the store turn the combined payload into an endpoint the set points at', () => {
    // The first-run path end to end: one call, one provider, one set.
    mocks.seed = {};
    const store = new ConfigStore();
    store.update(
      buildCombinedSavePayload({
        setDraft: {
          provider: 'custom',
          endpointId: '',
          model: '',
          customModel: 'claude-opus-5',
          useCustomModel: true,
          contextWindow: '',
          maxTokens: '',
          thinkingLevel: 'off',
        },
        credentialDraft: {
          apiKey: 'gw-key',
          baseUrl: 'http://127.0.0.1:9000',
          protocol: 'anthropic',
        },
        customProtocol: 'anthropic',
        presetBaseUrl: '',
        activeConfigSetId: 'default',
      })
    );
    const config = store.getAll();

    expect(config.customEndpoints).toHaveLength(1);
    expect(config.endpointId).toBe(config.customEndpoints[0].id);
    expect(config.apiKey).toBe('gw-key');
    expect(config.model).toBe('claude-opus-5');
  });

  it('uses the preset address for a cloud provider in the combined payload', () => {
    const payload = buildCombinedSavePayload({
      setDraft: {
        provider: 'anthropic',
        endpointId: '',
        model: 'claude-sonnet-4-6',
        customModel: '',
        useCustomModel: false,
        contextWindow: '',
        maxTokens: '',
        thinkingLevel: 'off',
      },
      credentialDraft: { apiKey: 'sk-ant', baseUrl: 'ignored', protocol: 'anthropic' },
      customProtocol: 'anthropic',
      presetBaseUrl: 'https://api.anthropic.com',
      activeConfigSetId: 'default',
    });

    expect(payload.baseUrl).toBe('https://api.anthropic.com');
    expect(payload).not.toHaveProperty('endpointId');
  });
});
