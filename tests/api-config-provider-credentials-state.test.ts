/**
 * The **provider credentials** half of the API-settings form state
 * (`src/renderer/hooks/provider-credentials-state.ts`): what a credential reads
 * as before it is edited, what counts as an unsaved change to it, and which
 * call saves it.
 *
 * Credentials are machine-wide, so an edit is tracked against the credential it
 * changes — a provider's slot or a custom endpoint — and never against a config
 * set. The config-set half is covered by `api-config-state-config-sets.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CustomEndpoint } from '../src/renderer/types';
import { FALLBACK_PROVIDER_PRESETS } from '../src/renderer/hooks/api-config-shared';
import {
  createProviderCredentialsState,
  credentialTargetFor,
  credentialTargetKey,
  defaultCustomBaseUrl,
  dirtyCredentialTargets,
  hasUnsavedCredentialChanges,
  hydrateCredentialDraft,
  planCredentialSave,
  providerCredentialsReducer,
  selectCredentialDraft,
  withEndpointProtocol,
  type CredentialDraft,
  type CredentialTarget,
  type ProviderCredentialsState,
} from '../src/renderer/hooks/provider-credentials-state';

const presets = FALLBACK_PROVIDER_PRESETS;

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

function state(overrides: Parameters<typeof createProviderCredentialsState>[0] = {}) {
  return createProviderCredentialsState(overrides);
}

/** Edit a credential the way the hook does: against its persisted value. */
function edit(
  current: ProviderCredentialsState,
  target: CredentialTarget,
  patch: Partial<CredentialDraft>
): ProviderCredentialsState {
  return providerCredentialsReducer(current, {
    type: 'PATCH_DRAFT',
    targetKey: credentialTargetKey(target),
    baseline: hydrateCredentialDraft(current, target, presets),
    patch,
  });
}

const anthropic: CredentialTarget = { kind: 'slot', slot: 'anthropic' };
const openai: CredentialTarget = { kind: 'slot', slot: 'openai' };
const ollama: CredentialTarget = { kind: 'slot', slot: 'ollama' };
const newEndpoint: CredentialTarget = { kind: 'new-endpoint' };

describe('where a provider keeps its credential', () => {
  it('gives each catalog provider its own slot', () => {
    expect(credentialTargetFor('anthropic', '')).toEqual({ kind: 'slot', slot: 'anthropic' });
    expect(credentialTargetFor('ollama', '')).toEqual({ kind: 'slot', slot: 'ollama' });
    expect(credentialTargetFor('zai', '')).toEqual({ kind: 'slot', slot: 'native:zai' });
  });

  it('gives a custom provider an endpoint: the named one, or one not created yet', () => {
    expect(credentialTargetFor('custom', 'custom-endpoint-1')).toEqual({
      kind: 'endpoint',
      id: 'custom-endpoint-1',
    });
    expect(credentialTargetFor('custom', '')).toEqual({ kind: 'new-endpoint' });
  });

  it('ignores an endpoint id on a catalog provider', () => {
    expect(credentialTargetFor('anthropic', 'custom-endpoint-1')).toEqual(anthropic);
  });
});

describe('what a credential reads as before it is edited', () => {
  it('reads a stored key and falls back to the preset address', () => {
    const current = state({ providerCredentials: { anthropic: { apiKey: 'sk-ant' } } });

    expect(selectCredentialDraft(current, anthropic, presets)).toMatchObject({
      apiKey: 'sk-ant',
      baseUrl: presets.anthropic.baseUrl,
    });
  });

  it('reads an unconfigured provider as empty, never as another provider key', () => {
    const current = state({ providerCredentials: { anthropic: { apiKey: 'sk-ant' } } });

    expect(selectCredentialDraft(current, openai, presets).apiKey).toBe('');
  });

  it('reads a stored address override', () => {
    const current = state({
      providerCredentials: { 'native:zai': { apiKey: 'zai', baseUrl: 'https://proxy.example' } },
    });

    expect(
      selectCredentialDraft(current, { kind: 'slot', slot: 'native:zai' }, presets)
    ).toMatchObject({ apiKey: 'zai', baseUrl: 'https://proxy.example' });
  });

  it('normalizes a stored Ollama address to /v1', () => {
    const local = state({
      providerCredentials: { ollama: { apiKey: '', baseUrl: 'http://localhost:11434/api' } },
    });
    expect(selectCredentialDraft(local, ollama, presets).baseUrl).toBe('http://localhost:11434/v1');

    const remote = state({
      providerCredentials: {
        ollama: { apiKey: '', baseUrl: 'https://ollama.example.internal/proxy' },
      },
    });
    expect(selectCredentialDraft(remote, ollama, presets).baseUrl).toBe(
      'https://ollama.example.internal/proxy/v1'
    );
  });

  it('reads an endpoint with its own protocol, address and key', () => {
    const current = state({
      customEndpoints: [
        endpoint({ protocol: 'gemini', baseUrl: 'https://gemini-proxy.example/v1' }),
      ],
    });

    expect(
      selectCredentialDraft(current, { kind: 'endpoint', id: 'custom-endpoint-1' }, presets)
    ).toEqual({ apiKey: 'gw-key', baseUrl: 'https://gemini-proxy.example/v1', protocol: 'gemini' });
  });

  it('reads a not-yet-created endpoint as blank, on the last protocol used', () => {
    const current = state({ customProtocol: 'openai' });

    expect(selectCredentialDraft(current, newEndpoint, presets)).toEqual({
      apiKey: '',
      baseUrl: defaultCustomBaseUrl('openai', presets),
      protocol: 'openai',
    });
  });

  it('reads a pointer to a deleted endpoint as a blank one', () => {
    const current = state({ customEndpoints: [] });

    expect(
      selectCredentialDraft(current, { kind: 'endpoint', id: 'custom-endpoint-9' }, presets).apiKey
    ).toBe('');
  });
});

describe('unsaved changes to a credential', () => {
  it('starts with none', () => {
    expect(hasUnsavedCredentialChanges(state(), presets)).toBe(false);
  });

  it('counts an edited key, and stops counting it when it is typed back', () => {
    const current = state({ providerCredentials: { anthropic: { apiKey: 'sk-ant' } } });

    const edited = edit(current, anthropic, { apiKey: 'sk-ant-new' });
    expect(dirtyCredentialTargets(edited, presets).map((entry) => entry.targetKey)).toEqual([
      'slot:anthropic',
    ]);

    expect(
      hasUnsavedCredentialChanges(edit(edited, anthropic, { apiKey: 'sk-ant' }), presets)
    ).toBe(false);
  });

  it('ignores surrounding whitespace, which a save trims anyway', () => {
    const current = state({ providerCredentials: { anthropic: { apiKey: 'sk-ant' } } });

    expect(
      hasUnsavedCredentialChanges(edit(current, anthropic, { apiKey: ' sk-ant ' }), presets)
    ).toBe(false);
  });

  it('keeps an edit to one provider pending while another is edited', () => {
    // The form shows one provider at a time, but the edits belong to the
    // credentials, not to whatever is on screen.
    let current = state();
    current = edit(current, anthropic, { apiKey: 'sk-ant' });
    current = edit(current, openai, { apiKey: 'sk-oai' });

    expect(
      dirtyCredentialTargets(current, presets)
        .map((entry) => entry.targetKey)
        .sort()
    ).toEqual(['slot:anthropic', 'slot:openai']);
    expect(selectCredentialDraft(current, anthropic, presets).apiKey).toBe('sk-ant');
  });

  it('counts a changed protocol on an endpoint', () => {
    const current = state({ customEndpoints: [endpoint({})] });
    const target: CredentialTarget = { kind: 'endpoint', id: 'custom-endpoint-1' };

    expect(
      hasUnsavedCredentialChanges(edit(current, target, { protocol: 'openai' }), presets)
    ).toBe(true);
  });

  it('keeps unsaved edits when persisted state moves underneath them', () => {
    // The other half of the form saved a config set: the credentials did not
    // change, and a key the user has typed must not be lost to it.
    const edited = edit(state(), anthropic, { apiKey: 'sk-typed' });

    const rebased = providerCredentialsReducer(edited, {
      type: 'APPLY_PERSISTED',
      providerCredentials: { openai: { apiKey: 'sk-oai' } },
      customEndpoints: [],
      mode: 'rebase',
    });

    expect(selectCredentialDraft(rebased, anthropic, presets).apiKey).toBe('sk-typed');
    expect(selectCredentialDraft(rebased, openai, presets).apiKey).toBe('sk-oai');
    expect(hasUnsavedCredentialChanges(rebased, presets)).toBe(true);
  });

  it('drops every unsaved edit on a reset', () => {
    const edited = edit(state(), anthropic, { apiKey: 'sk-typed' });

    const reset = providerCredentialsReducer(edited, {
      type: 'APPLY_PERSISTED',
      providerCredentials: {},
      customEndpoints: [],
      mode: 'reset',
    });

    expect(hasUnsavedCredentialChanges(reset, presets)).toBe(false);
    expect(selectCredentialDraft(reset, anthropic, presets).apiKey).toBe('');
  });

  it('stops counting an edit once the save it was for has landed', () => {
    const edited = edit(state(), anthropic, { apiKey: 'sk-new' });

    const saved = providerCredentialsReducer(edited, {
      type: 'APPLY_PERSISTED',
      providerCredentials: { anthropic: { apiKey: 'sk-new' } },
      customEndpoints: [],
      mode: 'rebase',
    });

    expect(hasUnsavedCredentialChanges(saved, presets)).toBe(false);
  });

  it('does not count an edit to an endpoint that has since been deleted', () => {
    const target: CredentialTarget = { kind: 'endpoint', id: 'custom-endpoint-1' };
    const edited = edit(state({ customEndpoints: [endpoint({})] }), target, { apiKey: 'new' });

    const afterDelete = providerCredentialsReducer(edited, {
      type: 'APPLY_PERSISTED',
      providerCredentials: {},
      customEndpoints: [],
      mode: 'rebase',
    });

    expect(hasUnsavedCredentialChanges(afterDelete, presets)).toBe(false);
  });
});

describe('an edit reads as saved once what it was saved as is persisted', () => {
  // What is typed is not always what is stored: Ollama's address is normalized,
  // a cloud provider's is the preset's, an endpoint's is made canonical. The
  // comparison has to use the stored form on both sides, or a saved credential
  // would go on reading as changed. These tests deliberately keep the draft in
  // place after the save, so they hold whether or not the caller discards it.

  /** Persist exactly what the planned call would send, keeping every draft. */
  function saveAndRebase(current: ProviderCredentialsState): ProviderCredentialsState {
    const providerCredentials = { ...current.providerCredentials };
    let customEndpoints = [...current.customEndpoints];
    for (const step of planCredentialSave(current, presets)) {
      if (step.kind === 'provider') {
        const slot = credentialTargetFor(step.payload.provider, '');
        if (slot.kind !== 'slot') continue;
        providerCredentials[slot.slot] = step.payload.baseUrl
          ? { apiKey: step.payload.apiKey, baseUrl: step.payload.baseUrl }
          : { apiKey: step.payload.apiKey };
      } else if (step.kind === 'update-endpoint') {
        customEndpoints = customEndpoints.map((candidate) =>
          candidate.id === step.payload.id ? { ...candidate, ...step.payload } : candidate
        );
      }
    }
    return providerCredentialsReducer(current, {
      type: 'APPLY_PERSISTED',
      providerCredentials,
      customEndpoints,
      mode: 'rebase',
    });
  }

  it('for an Ollama address typed without /v1', () => {
    const edited = edit(state(), ollama, { baseUrl: 'http://192.168.1.50:11434/api' });
    expect(planCredentialSave(edited, presets)[0]).toMatchObject({
      payload: { provider: 'ollama', baseUrl: 'http://192.168.1.50:11434/v1' },
    });

    expect(hasUnsavedCredentialChanges(saveAndRebase(edited), presets)).toBe(false);
  });

  it('for a cloud provider whose stored address differs from the preset', () => {
    // An address left by an older version. The form has no field for it, so a
    // key rotation saves the preset's — and must then read as saved.
    const current = state({
      providerCredentials: {
        openrouter: { apiKey: 'sk-old', baseUrl: 'https://openrouter.ai/api' },
      },
    });
    const target: CredentialTarget = { kind: 'slot', slot: 'openrouter' };
    expect(hasUnsavedCredentialChanges(current, presets)).toBe(false);

    const edited = edit(current, target, { apiKey: 'sk-new' });
    expect(planCredentialSave(edited, presets)[0]).toMatchObject({
      payload: { provider: 'openrouter', apiKey: 'sk-new', baseUrl: presets.openrouter.baseUrl },
    });

    expect(hasUnsavedCredentialChanges(saveAndRebase(edited), presets)).toBe(false);
  });

  it('for an endpoint address typed with a trailing slash or capitals', () => {
    const target: CredentialTarget = { kind: 'endpoint', id: 'custom-endpoint-1' };
    const edited = edit(state({ customEndpoints: [endpoint({})] }), target, {
      baseUrl: 'http://GW.Example:9000/',
      apiKey: 'rotated',
    });
    expect(planCredentialSave(edited, presets)[0]).toMatchObject({
      kind: 'update-endpoint',
      payload: { baseUrl: 'http://gw.example:9000', apiKey: 'rotated' },
    });

    expect(hasUnsavedCredentialChanges(saveAndRebase(edited), presets)).toBe(false);
  });

  it('does not count a different spelling of the same address as a change', () => {
    const target: CredentialTarget = { kind: 'endpoint', id: 'custom-endpoint-1' };
    const current = state({ customEndpoints: [endpoint({})] });

    expect(
      hasUnsavedCredentialChanges(
        edit(current, target, { baseUrl: 'HTTP://127.0.0.1:9000/' }),
        presets
      )
    ).toBe(false);
    expect(
      hasUnsavedCredentialChanges(
        edit(state(), ollama, { baseUrl: 'http://localhost:11434/api' }),
        presets
      )
    ).toBe(false);
  });
});

describe('changing the protocol of an endpoint', () => {
  it('moves a placeholder address to the new protocol default', () => {
    const blank = hydrateCredentialDraft(state(), newEndpoint, presets);

    const onOpenAI = withEndpointProtocol(blank, 'openai', presets);

    expect(onOpenAI.protocol).toBe('openai');
    expect(onOpenAI.baseUrl).toBe(defaultCustomBaseUrl('openai', presets));
  });

  it('keeps an address the user typed', () => {
    const typed: CredentialDraft = {
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:9000',
      protocol: 'anthropic',
    };

    expect(withEndpointProtocol(typed, 'openai', presets)).toEqual({
      ...typed,
      protocol: 'openai',
    });
  });
});

describe('which call saves a credential', () => {
  it('plans nothing when nothing is edited', () => {
    expect(planCredentialSave(state(), presets)).toEqual([]);
  });

  it('saves a catalog provider through its own call, naming the provider', () => {
    const edited = edit(state(), anthropic, { apiKey: '  sk-ant  ' });

    expect(planCredentialSave(edited, presets)).toEqual([
      {
        kind: 'provider',
        targetKey: 'slot:anthropic',
        payload: { provider: 'anthropic', apiKey: 'sk-ant', baseUrl: presets.anthropic.baseUrl },
      },
    ]);
  });

  it('saves a native provider under its provider id, with its own address', () => {
    const target: CredentialTarget = { kind: 'slot', slot: 'native:zai' };
    const edited = edit(state(), target, { apiKey: 'zai-key', baseUrl: 'https://proxy.example ' });

    expect(planCredentialSave(edited, presets)[0]).toMatchObject({
      kind: 'provider',
      payload: { provider: 'zai', apiKey: 'zai-key', baseUrl: 'https://proxy.example' },
    });
  });

  it('saves the Ollama address the user typed, not the preset', () => {
    const edited = edit(state(), ollama, { baseUrl: 'http://192.168.1.50:11434/v1' });

    expect(planCredentialSave(edited, presets)[0]).toMatchObject({
      kind: 'provider',
      payload: { provider: 'ollama', apiKey: '', baseUrl: 'http://192.168.1.50:11434/v1' },
    });
  });

  it('saves every edited provider, not only the one on screen', () => {
    let current = state();
    current = edit(current, anthropic, { apiKey: 'sk-ant' });
    current = edit(current, openai, { apiKey: 'sk-oai' });

    expect(
      planCredentialSave(current, presets)
        .map((step) => (step.kind === 'provider' ? step.payload.provider : step.kind))
        .sort()
    ).toEqual(['anthropic', 'openai']);
  });

  it('updates an existing endpoint in place', () => {
    const target: CredentialTarget = { kind: 'endpoint', id: 'custom-endpoint-1' };
    const edited = edit(state({ customEndpoints: [endpoint({})] }), target, { apiKey: 'rotated' });

    expect(planCredentialSave(edited, presets)).toEqual([
      {
        kind: 'update-endpoint',
        targetKey: 'endpoint:custom-endpoint-1',
        payload: {
          id: 'custom-endpoint-1',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'rotated',
        },
      },
    ]);
  });

  it('creates an endpoint for a new address, carrying the model as its default', () => {
    const edited = edit(state(), newEndpoint, {
      apiKey: 'gw-key',
      baseUrl: 'http://127.0.0.1:9000',
      protocol: 'anthropic',
    });

    expect(
      planCredentialSave(edited, presets, { newEndpointDefaultModel: 'claude-opus-5' })
    ).toEqual([
      {
        kind: 'create-endpoint',
        targetKey: 'endpoint:new',
        payload: {
          name: '',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9000',
          apiKey: 'gw-key',
          defaultModel: 'claude-opus-5',
        },
      },
    ]);
  });

  it('reuses an endpoint that already exists at the typed address instead of creating a twin', () => {
    // Same gateway, written with a trailing slash.
    const current = state({ customEndpoints: [endpoint({})] });
    const edited = edit(current, newEndpoint, {
      baseUrl: 'http://127.0.0.1:9000/',
      protocol: 'anthropic',
    });

    expect(planCredentialSave(edited, presets)).toEqual([
      { kind: 'reuse-endpoint', targetKey: 'endpoint:new', endpointId: 'custom-endpoint-1' },
    ]);
  });

  it('passes a typed key on to the endpoint it reuses', () => {
    const current = state({ customEndpoints: [endpoint({})] });
    const edited = edit(current, newEndpoint, {
      apiKey: 'rotated',
      baseUrl: 'http://127.0.0.1:9000',
      protocol: 'anthropic',
    });

    expect(planCredentialSave(edited, presets)[0]).toMatchObject({
      kind: 'reuse-endpoint',
      endpointId: 'custom-endpoint-1',
      payload: { id: 'custom-endpoint-1', apiKey: 'rotated' },
    });
  });

  it('re-points instead of colliding when an endpoint is given another endpoint address', () => {
    // Main refuses two endpoints at one address. The form has no endpoint list
    // yet, so rather than surface that as an error it reads the edit the way the
    // user means it: use the endpoint that lives there.
    const current = state({
      customEndpoints: [
        endpoint({}),
        endpoint({
          id: 'custom-endpoint-2',
          baseUrl: 'http://127.0.0.1:4000',
          apiKey: 'other-key',
        }),
      ],
    });
    const target: CredentialTarget = { kind: 'endpoint', id: 'custom-endpoint-1' };
    const edited = edit(current, target, { baseUrl: 'http://127.0.0.1:4000' });

    // The key on screen is endpoint 1's. It must not be written over endpoint 2's.
    expect(planCredentialSave(edited, presets)).toEqual([
      {
        kind: 'reuse-endpoint',
        targetKey: 'endpoint:custom-endpoint-1',
        endpointId: 'custom-endpoint-2',
      },
    ]);

    // A key typed in the same edit is the user's choice for where they landed.
    const withKey = edit(edited, target, { apiKey: 'typed' });
    expect(planCredentialSave(withKey, presets)[0]).toMatchObject({
      kind: 'reuse-endpoint',
      endpointId: 'custom-endpoint-2',
      payload: { id: 'custom-endpoint-2', apiKey: 'typed' },
    });
  });

  it('treats the same address on another protocol as a different endpoint', () => {
    const current = state({ customEndpoints: [endpoint({})] });
    const edited = edit(current, newEndpoint, {
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:9000',
      protocol: 'openai',
    });

    expect(planCredentialSave(edited, presets)[0].kind).toBe('create-endpoint');
  });

  it('skips a new endpoint that has no address to be created at', () => {
    const edited = edit(state(), newEndpoint, { apiKey: 'k', baseUrl: '   ' });

    expect(planCredentialSave(edited, presets)).toEqual([]);
  });

  it('saves catalog providers before endpoints', () => {
    // One failing endpoint call must never hold a provider key back.
    let current = state();
    current = edit(current, newEndpoint, { apiKey: 'k', baseUrl: 'http://gw:1' });
    current = edit(current, anthropic, { apiKey: 'sk-ant' });

    expect(planCredentialSave(current, presets).map((step) => step.kind)).toEqual([
      'provider',
      'create-endpoint',
    ]);
  });

  it('never names a config set, a model or a provider switch', () => {
    // The whole point of the split (design §6.4): saving a key cannot change
    // what a chat runs on.
    let current = state({ customEndpoints: [endpoint({})] });
    current = edit(current, anthropic, { apiKey: 'sk-ant' });
    current = edit(current, { kind: 'endpoint', id: 'custom-endpoint-1' }, { apiKey: 'rotated' });
    current = edit(current, newEndpoint, { apiKey: 'k', baseUrl: 'http://other:1' });

    for (const step of planCredentialSave(current, presets)) {
      const payload = 'payload' in step && step.payload ? step.payload : {};
      for (const field of [
        'activeConfigSetId',
        'model',
        'configSets',
        'contextWindow',
        'thinkingLevel',
      ]) {
        expect(payload, `${step.kind} payload`).not.toHaveProperty(field);
      }
    }
  });
});
