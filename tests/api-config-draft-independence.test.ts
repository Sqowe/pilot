/**
 * Draft independence (design §6.4, test plan §8.1).
 *
 * API settings save two things separately — a credential and a config set —
 * and they must not leak into each other:
 *
 * - a changed model is never carried into a credential write;
 * - a changed key is never carried into a config-set write;
 * - saving a credential never discards an unsaved edit to a config set.
 *
 * The first two are checked end to end: the payloads the Providers tab, the
 * Model Sets tab and the first-run wizard build are fed to the real store, and
 * the half that was not saved is compared before and after.
 *
 * There is no fourth line for "saving a config set never discards a typed
 * key". A key is typed only in a dialog that has its own Save, and no config
 * set can be saved while one is open: there is no unsaved key for a save to
 * discard.
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
  buildCreateEndpointPayload,
  buildProviderCredentialPayload,
  buildUpdateEndpointPayload,
  endpointFormValues,
  type EndpointFormValues,
} from '../src/renderer/hooks/api-settings-view';
import {
  buildModelSetSavePayload,
  buildModelSetsBootstrap,
  hasUnsavedModelSetChanges,
  modelSetsReducer,
  createModelSetsState,
  type ModelSetsState,
} from '../src/renderer/hooks/model-sets-state';

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

/** What a provider's dialog, or the wizard's Continue, sends for a key alone. */
function keyPayload(provider: string, apiKey: string) {
  return buildProviderCredentialPayload({ provider, apiKey, baseUrl: '', showsBaseUrl: false });
}

/** The fields of the endpoint dialog, filled in for a gateway. */
const gateway: EndpointFormValues = {
  name: 'gw',
  protocol: 'openai',
  baseUrl: 'http://gw:1',
  apiKey: 'k',
  defaultModel: '',
};

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

    const sets = modelSetsReducer(loadSets(rendererConfig(store)), {
      type: 'UPDATE_MODEL_FIELDS',
      updater: (previous) => ({
        ...previous,
        customModel: 'claude-sonnet-5',
        useCustomModel: true,
        contextWindow: '200000',
      }),
    });

    store.update(buildModelSetSavePayload(sets.draft, sets.activeConfigSetId));
    const after = store.getAll();

    expect(after.model).toBe('claude-sonnet-5');
    expect(after.contextWindow).toBe(200000);
    expect(after.providerCredentials).toEqual(before.providerCredentials);
    expect(after.customEndpoints).toEqual(before.customEndpoints);
    expect(after.apiKey).toBe('sk-ant');
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

  it('carries no config-set field, in any of the calls that save one', () => {
    const payloads = {
      'a provider key': keyPayload('anthropic', 'sk-ant'),
      'a provider key and address': buildProviderCredentialPayload({
        provider: 'ollama',
        apiKey: '',
        baseUrl: 'http://localhost:11434/v1',
        showsBaseUrl: true,
      }),
      'a new endpoint': buildCreateEndpointPayload(gateway),
      'an endpoint that exists': buildUpdateEndpointPayload('custom-endpoint-1', gateway),
    };

    for (const [call, payload] of Object.entries(payloads)) {
      for (const field of SET_FIELDS) {
        expect(payload, call).not.toHaveProperty(field);
      }
    }
  });

  it('rotates a key in the store and leaves every set exactly as it was', () => {
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    store.createSet({ name: 'Second', mode: 'blank' });
    store.switchSet({ id: 'default' });
    const before = store.getAll();

    // The user rotates the key while a model edit is pending on the Model Sets tab.
    const sets = modelSetsReducer(loadSets(rendererConfig(store)), {
      type: 'UPDATE_MODEL_FIELDS',
      updater: (previous) => ({ ...previous, customModel: 'PENDING-MODEL', useCustomModel: true }),
    });
    expect(hasUnsavedModelSetChanges(sets)).toBe(true);

    store.setProviderCredential(keyPayload('anthropic', 'sk-ant-rotated'));
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

    store.setProviderCredential(keyPayload('openai', 'sk-oai'));
    const after = store.getAll();

    expect(after.providerCredentials.openai?.apiKey).toBe('sk-oai');
    expect(after.provider).toBe('anthropic');
    expect(after.configSets).toEqual(before.configSets);
  });

  it('creates an endpoint, and saves it again, without pointing any set at it', () => {
    // The wizard's Continue for an endpoint. The config set moves to it only
    // on Start, through the config-set save.
    const store = new ConfigStore();
    store.update({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5' });
    const before = store.getAll();

    store.createCustomEndpoint(buildCreateEndpointPayload(gateway));
    const created = rendererConfig(store).customEndpoints[0];
    store.updateCustomEndpoint(
      buildUpdateEndpointPayload(created.id, {
        ...endpointFormValues(created, 'anthropic'),
        apiKey: 'k-rotated',
      })
    );
    const after = store.getAll();

    expect(after.customEndpoints).toHaveLength(1);
    expect(after.customEndpoints[0]).toMatchObject({ baseUrl: 'http://gw:1', apiKey: 'k-rotated' });
    expect(after.provider).toBe('anthropic');
    expect(after.apiKey).toBe('sk-ant');
    expect(after.configSets).toEqual(before.configSets);
    expect(after.activeConfigSetId).toBe(before.activeConfigSetId);
  });
});

describe('saving a credential never discards an unsaved edit to a config set', () => {
  beforeEach(() => {
    mocks.seed = {};
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
    store.setProviderCredential(keyPayload('anthropic', 'sk-ant-rotated'));

    // What the state both tabs share does with the config a credential call
    // returns (`runCredentialCall`, `useApiSettingsState.ts`).
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
