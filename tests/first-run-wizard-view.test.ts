/**
 * What the first-run wizard works out before it asks main for anything
 * (`src/renderer/hooks/first-run-wizard-view.ts`): the entries of its list,
 * which of them it opens on, what a chosen entry stands for, and the model its
 * second step starts on.
 *
 * No test can click the wizard, so these decisions are plain functions.
 */
import { describe, expect, it } from 'vitest';
import type { ApiConfigSet, CustomEndpoint } from '../src/renderer/types';
import { COMMON_PROVIDER_SETUPS } from '../src/shared/api-provider-guidance';
import { BUILTIN_ENTRIES, type ProviderCatalogEntry } from '../src/shared/provider-catalog';
import {
  CUSTOM_ENDPOINT_LIMIT,
  FALLBACK_PROVIDER_PRESETS,
} from '../src/renderer/hooks/api-config-shared';
import type { PersistedCredentials } from '../src/renderer/hooks/api-settings-view';
import {
  NEW_ENDPOINT_CHOICE,
  buildWizardChoices,
  endpointStartModel,
  initialWizardChoice,
  keyIsMissing,
  pointsAt,
  resolveWizardTarget,
  startModelFields,
  targetPointer,
} from '../src/renderer/hooks/first-run-wizard-view';

const presets = FALLBACK_PROVIDER_PRESETS;

function set(overrides: Partial<ApiConfigSet>): ApiConfigSet {
  return {
    id: 'default',
    name: 'Default',
    isSystem: true,
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    enableThinking: false,
    thinkingLevel: 'off',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
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

function credentials(overrides: Partial<PersistedCredentials> = {}): PersistedCredentials {
  return { providerCredentials: {}, customEndpoints: [], credentialConflicts: [], ...overrides };
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
const catalog: ProviderCatalogEntry[] = [...BUILTIN_ENTRIES, zai];
const anthropic = BUILTIN_ENTRIES.find((entry) => entry.id === 'anthropic')!;
const ollama = BUILTIN_ENTRIES.find((entry) => entry.id === 'ollama')!;

describe('the list the first step chooses from', () => {
  it('on a fresh install is the entry that adds an endpoint, then the whole catalog', () => {
    const choices = buildWizardChoices({
      catalog,
      credentials: credentials(),
      configSets: [set({})],
    });

    expect(choices[0]).toMatchObject({
      id: NEW_ENDPOINT_CHOICE,
      kind: 'new-endpoint',
      group: 'endpoints',
    });
    const providers = choices.slice(1);
    expect(providers.every((choice) => choice.kind === 'provider')).toBe(true);
    // Every catalog provider — the six the old dialog had as buttons and the
    // ones only the installed pi knows — and never the bare "Custom".
    expect(providers.map((choice) => choice.id).sort()).toEqual(
      catalog
        .filter((entry) => entry.id !== 'custom')
        .map((entry) => `provider:${entry.id}`)
        .sort()
    );
  });

  it('lists an endpoint that exists by its name, before the entry that adds one', () => {
    const local = endpoint({ id: 'custom-endpoint-1', name: 'kiro-gateway' });
    const hosted = endpoint({ id: 'custom-endpoint-2', name: 'hosted-gateway' });
    const choices = buildWizardChoices({
      catalog,
      credentials: credentials({ customEndpoints: [local, hosted] }),
      configSets: [set({})],
    });

    expect(choices.slice(0, 3).map((choice) => [choice.kind, choice.label])).toEqual([
      ['endpoint', 'kiro-gateway'],
      ['endpoint', 'hosted-gateway'],
      ['new-endpoint', ''],
    ]);
    expect(choices[3].kind).toBe('provider');
  });

  it('has no entry for "a custom set with no endpoint": that is a state, not a choice', () => {
    const choices = buildWizardChoices({
      catalog,
      credentials: credentials(),
      configSets: [set({ provider: 'custom' })],
    });

    expect(choices.some((choice) => choice.kind === 'no-endpoint')).toBe(false);
  });

  it('does not offer to add an endpoint once the store can take no more', () => {
    const full = Array.from({ length: CUSTOM_ENDPOINT_LIMIT }, (_, index) =>
      endpoint({ id: `custom-endpoint-${index + 1}`, name: `gateway-${index + 1}` })
    );
    const choices = buildWizardChoices({
      catalog,
      credentials: credentials({ customEndpoints: full }),
      configSets: [set({})],
    });

    expect(choices.some((choice) => choice.kind === 'new-endpoint')).toBe(false);
    expect(choices.filter((choice) => choice.kind === 'endpoint')).toHaveLength(
      CUSTOM_ENDPOINT_LIMIT
    );

    const oneLeft = buildWizardChoices({
      catalog,
      credentials: credentials({ customEndpoints: full.slice(1) }),
      configSets: [set({})],
    });
    expect(oneLeft.some((choice) => choice.kind === 'new-endpoint')).toBe(true);
  });
});

describe('the entry the first step opens on', () => {
  const existing = endpoint({ id: 'custom-endpoint-2' });

  it('is the provider of the active config set', () => {
    expect(initialWizardChoice({ provider: 'openrouter', endpointId: '' }, [])).toBe(
      'provider:openrouter'
    );
    expect(initialWizardChoice({ provider: 'zai', endpointId: '' }, [existing])).toBe(
      'provider:zai'
    );
  });

  it('is the endpoint of a custom set, by its own entry', () => {
    expect(
      initialWizardChoice({ provider: 'custom', endpointId: 'custom-endpoint-2' }, [existing])
    ).toBe('endpoint:custom-endpoint-2');
  });

  it('is the entry that adds one when a custom set has no endpoint, or its endpoint is gone', () => {
    expect(initialWizardChoice({ provider: 'custom', endpointId: '' }, [existing])).toBe(
      NEW_ENDPOINT_CHOICE
    );
    // Another endpoint exists, and is not picked on the user's behalf.
    expect(
      initialWizardChoice({ provider: 'custom', endpointId: 'custom-endpoint-9' }, [existing])
    ).toBe(NEW_ENDPOINT_CHOICE);
  });
});

describe('what a chosen entry stands for', () => {
  const existing = endpoint({ id: 'custom-endpoint-2' });

  it('is a catalog provider, with its catalog entry', () => {
    expect(resolveWizardTarget('provider:zai', catalog, [])).toEqual({
      kind: 'provider',
      entry: zai,
    });
  });

  it('is an endpoint that exists', () => {
    expect(resolveWizardTarget('endpoint:custom-endpoint-2', catalog, [existing])).toEqual({
      kind: 'endpoint',
      endpoint: existing,
    });
  });

  it('is an endpoint still to be added', () => {
    expect(resolveWizardTarget(NEW_ENDPOINT_CHOICE, catalog, [existing])).toEqual({
      kind: 'new-endpoint',
    });
  });

  it('is nothing for a provider the catalog at hand does not have', () => {
    // Native providers arrive with the catalog read from the installed pi.
    expect(resolveWizardTarget('provider:zai', [...BUILTIN_ENTRIES], [])).toBeNull();
  });

  it('is nothing for an endpoint deleted since, for the bare "Custom", and for anything else', () => {
    expect(resolveWizardTarget('endpoint:custom-endpoint-9', catalog, [existing])).toBeNull();
    expect(resolveWizardTarget('provider:custom', catalog, [existing])).toBeNull();
    expect(resolveWizardTarget('', catalog, [existing])).toBeNull();
    expect(resolveWizardTarget('zai', catalog, [existing])).toBeNull();
  });
});

describe('where a config set points', () => {
  const existing = endpoint({ id: 'custom-endpoint-2' });

  it('names a provider alone, or the custom provider with its endpoint', () => {
    expect(targetPointer({ kind: 'provider', entry: anthropic })).toEqual({
      provider: 'anthropic',
      endpointId: '',
    });
    expect(targetPointer({ kind: 'endpoint', endpoint: existing })).toEqual({
      provider: 'custom',
      endpointId: 'custom-endpoint-2',
    });
  });

  it('is at a catalog provider when the set names it', () => {
    const target = { kind: 'provider' as const, entry: anthropic };

    expect(pointsAt({ provider: 'anthropic', endpointId: '' }, target)).toBe(true);
    expect(pointsAt({ provider: 'openrouter', endpointId: '' }, target)).toBe(false);
  });

  it('is at an endpoint only when the set names that endpoint, not just "custom"', () => {
    const target = { kind: 'endpoint' as const, endpoint: existing };

    expect(pointsAt({ provider: 'custom', endpointId: 'custom-endpoint-2' }, target)).toBe(true);
    expect(pointsAt({ provider: 'custom', endpointId: 'custom-endpoint-1' }, target)).toBe(false);
    expect(pointsAt({ provider: 'custom', endpointId: '' }, target)).toBe(false);
    expect(pointsAt({ provider: 'openai', endpointId: '' }, target)).toBe(false);
  });
});

describe('the model the second step starts on', () => {
  const deepseek = COMMON_PROVIDER_SETUPS.find((setup) => setup.id === 'deepseek')!;

  it('is the default model an endpoint names', () => {
    expect(endpointStartModel({ defaultModel: ' claude-opus-5 ', baseUrl: 'http://x.test' })).toBe(
      'claude-opus-5'
    );
    // Its own default model wins over what its address suggests.
    expect(
      endpointStartModel({ defaultModel: 'my-model', baseUrl: deepseek.recommendedBaseUrl })
    ).toBe('my-model');
  });

  it("is the example model of the well-known service an endpoint's address belongs to", () => {
    expect(deepseek.exampleModel).not.toBe('');
    expect(endpointStartModel({ baseUrl: deepseek.recommendedBaseUrl })).toBe(
      deepseek.exampleModel
    );
    expect(endpointStartModel({ defaultModel: '   ', baseUrl: deepseek.recommendedBaseUrl })).toBe(
      deepseek.exampleModel
    );
  });

  it('is none for an endpoint that names no model at an address nobody knows', () => {
    expect(endpointStartModel({ baseUrl: 'https://gateway.example.com/v1' })).toBe('');
    expect(endpointStartModel({ baseUrl: '' })).toBe('');
  });

  it('is typed, never picked, for an endpoint', () => {
    const fields = startModelFields(
      { kind: 'endpoint', endpoint: endpoint({ defaultModel: 'gpt-5.4' }) },
      presets
    );

    expect(fields).toMatchObject({ useCustomModel: true, customModel: 'gpt-5.4' });
    expect(fields.contextWindow).toBe('');
    expect(fields.maxTokens).toBe('');
  });

  it('is typed and empty for an endpoint with nothing to start on', () => {
    expect(startModelFields({ kind: 'endpoint', endpoint: endpoint({}) }, presets)).toMatchObject({
      useCustomModel: true,
      customModel: '',
    });
  });

  it('reads an endpoint with an unknown protocol as the Anthropic one, as the store does', () => {
    const odd = endpoint({ protocol: 'grpc' as CustomEndpoint['protocol'], defaultModel: 'm' });

    expect(startModelFields({ kind: 'endpoint', endpoint: odd }, presets)).toMatchObject({
      useCustomModel: true,
      customModel: 'm',
    });
  });

  it("is the first of a catalog provider's own models, picked", () => {
    const fields = startModelFields({ kind: 'provider', entry: anthropic }, presets);

    expect(fields.useCustomModel).toBe(false);
    expect(fields.model).toBe(presets.anthropic.models[0].id);
    expect(fields.customModel).toBe('');
  });

  it('is none for Ollama, whose models are whatever its server has', () => {
    expect(startModelFields({ kind: 'provider', entry: ollama }, presets)).toMatchObject({
      model: '',
      useCustomModel: false,
    });
  });

  it('is none for a provider that has no preset list, exactly as on the Model Sets tab', () => {
    // A native provider's models come with the catalog; a config set moved to
    // one on the tab starts with nothing picked, and so does the wizard.
    expect(startModelFields({ kind: 'provider', entry: zai }, presets)).toMatchObject({
      model: '',
      useCustomModel: false,
    });
  });
});

describe('whether the first step stops for a key', () => {
  it('does where one is needed and none is typed', () => {
    expect(keyIsMissing(true, '')).toBe(true);
    expect(keyIsMissing(true, '   ')).toBe(true);
  });

  it('does not once there is one, or where none is needed', () => {
    expect(keyIsMissing(true, 'sk-typed')).toBe(false);
    expect(keyIsMissing(false, '')).toBe(false);
  });
});
