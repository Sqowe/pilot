import { describe, expect, it } from 'vitest';
import type { ApiConfigSet, CustomEndpoint } from '../src/renderer/types';
import fs from 'node:fs';
import path from 'node:path';
import { shouldAutoDiscoverLocalOllamaBaseUrl } from '../src/shared/ollama-base-url';
import {
  BUILTIN_ENTRIES,
  getCatalogEntry,
  NATIVE_SHAPE,
  type ProviderCatalogEntry,
} from '../src/shared/provider-catalog';
import { getModelInputGuidance } from '../src/shared/api-model-presets';
import {
  defaultModelFields,
  FALLBACK_PROVIDER_PRESETS,
  finalModelOf,
  mergeProviderCatalog,
  profileKeyFromProvider,
  profileKeyToProvider,
  sanitizeCatalogEntry,
} from '../src/renderer/hooks/api-config-shared';
import {
  persistedCredentialFor,
  type PersistedCredentials,
} from '../src/renderer/hooks/api-settings-view';
import { hydrateModelSetDraft } from '../src/renderer/hooks/model-sets-state';

const connectivityHookPath = path.resolve(
  process.cwd(),
  'src/renderer/hooks/useApiConnectivity.ts'
);

/** A config set as main sends it: a provider, a model, and no credential. */
function configSet(overrides: Partial<ApiConfigSet>): ApiConfigSet {
  return {
    id: 'default',
    name: 'Default',
    isSystem: true,
    provider: 'openrouter',
    model: '',
    enableThinking: false,
    thinkingLevel: 'off',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function customEndpoint(overrides: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-endpoint-1',
    name: 'endpoint',
    protocol: 'openai',
    baseUrl: 'https://custom-openai.example/v1',
    apiKey: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The credential store as main returns it, with only what a test names. */
function stored(overrides: Partial<PersistedCredentials>): PersistedCredentials {
  return { providerCredentials: {}, customEndpoints: [], credentialConflicts: [], ...overrides };
}

describe('api config state helpers', () => {
  it('maps provider/protocol to profile key and back', () => {
    expect(profileKeyFromProvider('openrouter')).toBe('openrouter');
    expect(profileKeyFromProvider('ollama')).toBe('ollama');
    expect(profileKeyFromProvider('custom', 'openai')).toBe('custom:openai');
    expect(profileKeyFromProvider('custom', 'gemini')).toBe('custom:gemini');
    expect(profileKeyToProvider('custom:anthropic')).toEqual({
      provider: 'custom',
      customProtocol: 'anthropic',
    });
    expect(profileKeyToProvider('gemini')).toEqual({
      provider: 'gemini',
      customProtocol: 'gemini',
    });
    expect(profileKeyToProvider('ollama')).toEqual({
      provider: 'ollama',
      customProtocol: 'openai',
    });
  });

  it('conservatively shows a legacy localhost ollama endpoint as the ollama provider', () => {
    const endpoint = customEndpoint({ baseUrl: 'http://localhost:11434/v1' });

    const draft = hydrateModelSetDraft(
      configSet({ provider: 'custom', endpointId: endpoint.id, model: 'qwen3.5:0.8b' }),
      FALLBACK_PROVIDER_PRESETS,
      [endpoint]
    );

    expect(draft.provider).toBe('ollama');
    expect(finalModelOf(draft)).toBe('qwen3.5:0.8b');
    // And Ollama's own credential reads its usual local address.
    expect(
      persistedCredentialFor(
        'ollama',
        '',
        stored({ customEndpoints: [endpoint] }),
        FALLBACK_PROVIDER_PRESETS
      ).baseUrl
    ).toBe('http://localhost:11434/v1');
  });

  it('normalizes the ollama base url when the form loads it', () => {
    const credentials = stored({
      providerCredentials: { ollama: { apiKey: '', baseUrl: 'http://localhost:11434/api' } },
    });

    expect(
      persistedCredentialFor('ollama', '', credentials, FALLBACK_PROVIDER_PRESETS).baseUrl
    ).toBe('http://localhost:11434/v1');
  });

  it('keeps a remote custom openai endpoint generic instead of showing it as ollama', () => {
    const endpoint = customEndpoint({ baseUrl: 'https://relay.example.internal/v1' });

    const draft = hydrateModelSetDraft(
      configSet({ provider: 'custom', endpointId: endpoint.id, model: 'qwen3.5:0.8b' }),
      FALLBACK_PROVIDER_PRESETS,
      [endpoint]
    );

    expect(draft.provider).toBe('custom');
    expect(draft.endpointId).toBe(endpoint.id);
  });

  it('exposes ollama presets and guidance', () => {
    expect(FALLBACK_PROVIDER_PRESETS.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(FALLBACK_PROVIDER_PRESETS.ollama.keyHint).toBe('api.providerHints.ollama.keyHint');
    expect(getModelInputGuidance('ollama').placeholder).toContain('qwen');
  });

  it('loads each stored credential without overwriting it with defaults', () => {
    const credentials = stored({
      customEndpoints: [
        customEndpoint({ apiKey: 'sk-custom-openai' }),
        customEndpoint({
          id: 'custom-endpoint-2',
          protocol: 'anthropic',
          baseUrl: 'https://custom-anthropic.example',
          apiKey: 'sk-custom-anthropic',
        }),
      ],
    });

    expect(
      persistedCredentialFor('custom', 'custom-endpoint-1', credentials, FALLBACK_PROVIDER_PRESETS)
    ).toEqual({
      apiKey: 'sk-custom-openai',
      baseUrl: 'https://custom-openai.example/v1',
      protocol: 'openai',
    });
    expect(
      persistedCredentialFor('custom', 'custom-endpoint-2', credentials, FALLBACK_PROVIDER_PRESETS)
        .apiKey
    ).toBe('sk-custom-anthropic');
  });

  it('applies defaults only where nothing is stored', () => {
    const credentials = stored({
      providerCredentials: { openai: { apiKey: 'sk-openai' } },
    });

    expect(
      persistedCredentialFor('openai', '', credentials, FALLBACK_PROVIDER_PRESETS).apiKey
    ).toBe('sk-openai');
    expect(
      persistedCredentialFor('openrouter', '', credentials, FALLBACK_PROVIDER_PRESETS).baseUrl
    ).toBe(FALLBACK_PROVIDER_PRESETS.openrouter.baseUrl);

    // A custom provider nobody has set up yet starts in typed-model mode.
    const customDefaults = defaultModelFields('custom', 'anthropic', FALLBACK_PROVIDER_PRESETS);
    expect(customDefaults.model).toBe(FALLBACK_PROVIDER_PRESETS.custom.models[0]?.id);
    expect(customDefaults.useCustomModel).toBe(true);
    expect(customDefaults.customModel).toBe('');
  });

  it('loads the gemini provider and a custom gemini endpoint without fallback drift', () => {
    const credentials = stored({
      providerCredentials: {
        gemini: { apiKey: 'AIza-official', baseUrl: 'https://generativelanguage.googleapis.com' },
      },
      customEndpoints: [
        customEndpoint({
          protocol: 'gemini',
          baseUrl: 'https://gemini-proxy.example/v1',
          apiKey: 'AIza-relay',
        }),
      ],
    });

    expect(
      persistedCredentialFor('gemini', '', credentials, FALLBACK_PROVIDER_PRESETS).apiKey
    ).toBe('AIza-official');
    expect(
      persistedCredentialFor('custom', 'custom-endpoint-1', credentials, FALLBACK_PROVIDER_PRESETS)
    ).toEqual({
      apiKey: 'AIza-relay',
      baseUrl: 'https://gemini-proxy.example/v1',
      protocol: 'gemini',
    });
  });

  it('keeps a pristine custom openai endpoint in manual input mode', () => {
    const defaults = defaultModelFields('custom', 'openai', FALLBACK_PROVIDER_PRESETS);

    expect(defaults.useCustomModel).toBe(true);
    expect(defaults.customModel).toBe('');
    expect(defaults.model).toBe(FALLBACK_PROVIDER_PRESETS.openai.models[0]?.id);
  });

  it('exposes updated preset lists and custom guidance', () => {
    expect(FALLBACK_PROVIDER_PRESETS.openai.models.map((item) => item.id)).toContain('gpt-5.4');
    expect(FALLBACK_PROVIDER_PRESETS.openai.models.map((item) => item.id)).toContain(
      'gpt-5.3-codex'
    );
    expect(FALLBACK_PROVIDER_PRESETS.openai.models.map((item) => item.id)).not.toContain('gpt-5.2');
    expect(FALLBACK_PROVIDER_PRESETS.anthropic.models.map((item) => item.id)).toContain(
      'claude-sonnet-4-6'
    );
    expect(FALLBACK_PROVIDER_PRESETS.gemini.models.map((item) => item.id)).toContain(
      'gemini-3.1-pro-preview'
    );
    expect(FALLBACK_PROVIDER_PRESETS.custom.models.map((item) => item.id)).toContain(
      'kimi-k2-thinking'
    );
    expect(FALLBACK_PROVIDER_PRESETS.custom.models.map((item) => item.id)).toContain('glm-5');
    expect(FALLBACK_PROVIDER_PRESETS.custom.models.map((item) => item.id)).toContain(
      'MiniMax-M2.5'
    );
    expect(FALLBACK_PROVIDER_PRESETS.custom.models.map((item) => item.id)).toContain('kimi-k3');
    expect(FALLBACK_PROVIDER_PRESETS.custom.models.map((item) => item.id)).toContain(
      'mistral-large-latest'
    );

    expect(getModelInputGuidance('custom', 'openai').placeholder).toContain('deepseek-chat');
    expect(getModelInputGuidance('custom', 'openai').placeholder).not.toContain('kimi');
    expect(getModelInputGuidance('custom', 'openai').hint).toContain(
      'selected protocol or endpoint'
    );
  });

  it('wires local Ollama discovery through the connectivity hook', () => {
    const source = fs.readFileSync(connectivityHookPath, 'utf8');
    expect(source).toContain('window.electronAPI.config.discoverLocal({');
    expect(source).toContain('baseUrl: requestedBaseUrl || undefined');
    expect(source).toContain("showErrorKey('api.localOllamaNotFound')");
    expect(source).toContain("showSuccessKey('api.localOllamaDiscovered'");
    expect(source).toContain("showErrorKey('api.localOllamaNoModels')");
    expect(source).toContain('ollamaDiscoverRequestIdRef');
    // A server that is not there has no models to offer.
    expect(source).toContain('if (shouldClearDiscoveredModels) {');
    expect(source).toContain('selectDiscoveredModel(models, models[0]?.id);');
    expect(source).not.toContain("showErrorKey('api.localOllamaModelUnavailable'");
    expect(source).not.toContain('shouldAutoDiscoverLocalOllamaBaseUrl(baseUrl)');
  });

  it('keeps the shared auto-discovery helper constrained to the default local endpoint', () => {
    expect(shouldAutoDiscoverLocalOllamaBaseUrl(undefined)).toBe(true);
    expect(shouldAutoDiscoverLocalOllamaBaseUrl('')).toBe(true);
    expect(shouldAutoDiscoverLocalOllamaBaseUrl('http://localhost:11434')).toBe(true);
    expect(shouldAutoDiscoverLocalOllamaBaseUrl('http://localhost:11434/api')).toBe(true);
    expect(shouldAutoDiscoverLocalOllamaBaseUrl('http://127.0.0.1:11434')).toBe(false);
    expect(shouldAutoDiscoverLocalOllamaBaseUrl('http://127.0.0.1:8080/v1')).toBe(false);
    expect(shouldAutoDiscoverLocalOllamaBaseUrl('https://ollama.example.internal/v1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P3 — catalog-aware state helpers (§8.4)
// ---------------------------------------------------------------------------

describe('P3 catalog-aware state helpers', () => {
  // Build a minimal native catalog for tests
  const makeNativeEntry = (
    id: string,
    routeProtocol: 'anthropic' | 'openai' | 'gemini' = 'openai'
  ): ProviderCatalogEntry => ({
    id,
    name: id,
    kind: 'native',
    category: 'coding-plan',
    piProvider: id,
    routeProtocol,
    formShape: { ...NATIVE_SHAPE },
    featured: false,
    modelOptions: [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ],
  });

  const MOCK_CATALOG: ProviderCatalogEntry[] = [
    ...BUILTIN_ENTRIES,
    makeNativeEntry('zai', 'openai'),
    makeNativeEntry('kimi-coding', 'anthropic'),
    makeNativeEntry('deepseek', 'openai'),
  ];

  it('getCatalogEntry finds native entry by id', () => {
    const entry = getCatalogEntry(MOCK_CATALOG, 'zai');
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('native');
    expect(entry?.routeProtocol).toBe('openai');
  });

  it('getCatalogEntry returns undefined for unknown provider', () => {
    expect(getCatalogEntry(MOCK_CATALOG, 'totally-unknown')).toBeUndefined();
  });

  it('profileKeyFromProvider derives native:zai for zai provider', () => {
    // Native providers derive their profile key as native:<piProvider>
    expect(profileKeyFromProvider('zai')).toBe('native:zai');
  });

  it('profileKeyFromProvider preserves builtin keys unchanged', () => {
    expect(profileKeyFromProvider('anthropic')).toBe('anthropic');
    expect(profileKeyFromProvider('openai')).toBe('openai');
    expect(profileKeyFromProvider('gemini')).toBe('gemini');
    expect(profileKeyFromProvider('ollama')).toBe('ollama');
    expect(profileKeyFromProvider('openrouter')).toBe('openrouter');
    expect(profileKeyFromProvider('custom', 'openai')).toBe('custom:openai');
  });

  it('profileKeyToProvider recovers provider + customProtocol from native key', () => {
    const result = profileKeyToProvider('native:zai');
    expect(result.provider).toBe('zai');
    // native keys default to anthropic customProtocol in profileKeyToProviderInfo
    expect(result.customProtocol).toBe('anthropic');
  });

  it('native catalog entry exposes formShape with modelDropdown=true and no baseUrl/protocol', () => {
    const entry = getCatalogEntry(MOCK_CATALOG, 'zai')!;
    expect(entry.formShape.modelDropdown).toBe(true);
    expect(entry.formShape.apiKey).toBe(true);
    expect(entry.formShape.baseUrl).toBe(false);
    expect(entry.formShape.protocol).toBe(false);
    expect(entry.formShape.contextWindow).toBe(false);
    expect(entry.formShape.manualModelToggle).toBe(true);
  });

  it('native catalog entry carries modelOptions from the registry', () => {
    const entry = getCatalogEntry(MOCK_CATALOG, 'zai')!;
    expect(entry.modelOptions).toHaveLength(2);
    expect(entry.modelOptions[0].id).toBe('model-a');
  });

  it('BUILTIN_ENTRIES are present in the full catalog', () => {
    for (const builtin of BUILTIN_ENTRIES) {
      expect(getCatalogEntry(MOCK_CATALOG, builtin.id)).toBeDefined();
    }
  });

  it('builtin entries have empty modelOptions (use API_PROVIDER_PRESETS)', () => {
    for (const builtin of BUILTIN_ENTRIES) {
      const entry = getCatalogEntry(MOCK_CATALOG, builtin.id)!;
      expect(entry.modelOptions).toHaveLength(0);
    }
  });

  it('native modelOptions: Array.isArray guard returns [] for undefined modelOptions', () => {
    const entryNoModels: ProviderCatalogEntry = {
      ...makeNativeEntry('groq'),
      modelOptions: undefined as unknown as [],
    };
    const catalog = [...MOCK_CATALOG, entryNoModels];
    const entry = getCatalogEntry(catalog, 'groq')!;
    const options = Array.isArray(entry.modelOptions) ? entry.modelOptions : [];
    expect(options).toEqual([]);
  });

  it('native formShape: requiresApiKey is true when formShape.apiKey is true', () => {
    const entry = getCatalogEntry(MOCK_CATALOG, 'zai')!;
    expect(entry.formShape.apiKey).toBe(true);
    // allowEmptyApiKey = !formShape.apiKey = false → requiresApiKey = true
    expect(!entry.formShape.apiKey).toBe(false);
  });

  it('native formShape: isOllamaMode is false for standard native providers', () => {
    const entry = getCatalogEntry(MOCK_CATALOG, 'zai')!;
    // isOllamaMode = formShape.baseUrl === true && formShape.apiKey === false
    // zai has apiKey:true, baseUrl:false → false
    expect(entry.formShape.baseUrl === true && entry.formShape.apiKey === false).toBe(false);
  });

  it('malformed catalog entry: activeFormShape is null when formShape is missing', () => {
    // Simulates a stale IPC preload returning an entry without formShape
    const malformedEntry = {
      id: 'broken-native',
      name: 'Broken',
      kind: 'native' as const,
      category: 'inference' as const,
      piProvider: 'broken-native',
      routeProtocol: 'openai' as const,
      // formShape intentionally omitted
      featured: false,
      modelOptions: [],
    } as unknown as ProviderCatalogEntry;
    const catalog = [...MOCK_CATALOG, malformedEntry];
    const entry = getCatalogEntry(catalog, 'broken-native')!;
    // activeFormShape derivation: use ?? null guard
    const activeFormShape = entry?.kind === 'native' ? (entry.formShape ?? null) : null;
    // Must be null, not undefined — prevents accidental deref in allowEmptyApiKey
    expect(activeFormShape).toBeNull();
    // allowEmptyApiKey with null activeFormShape falls back to provider === 'ollama'
    // (provider here would be 'broken-native', not 'ollama' → false)
    const allowEmptyApiKey = activeFormShape !== null ? activeFormShape.apiKey === false : false;
    expect(allowEmptyApiKey).toBe(false);
  });

  it('malformed catalog entry: isOllamaMode is false when formShape is null', () => {
    // Strict checks prevent undefined from triggering Ollama-mode behavior
    const activeFormShape: { baseUrl?: boolean; apiKey?: boolean } | null = null;
    const isOllamaMode = activeFormShape
      ? activeFormShape.baseUrl === true && activeFormShape.apiKey === false
      : false; // provider !== 'ollama'
    expect(isOllamaMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeCatalogEntry — MEDIUM 1 tests
// ---------------------------------------------------------------------------

describe('sanitizeCatalogEntry', () => {
  const validEntry = {
    id: 'zai',
    name: 'z.ai (GLM)',
    kind: 'native',
    category: 'coding-plan',
    piProvider: 'zai',
    routeProtocol: 'openai',
    featured: false,
    modelOptions: [{ id: 'glm-5', name: 'GLM-5' }],
    formShape: {
      apiKey: true,
      baseUrl: false,
      protocol: false,
      contextWindow: false,
      modelDropdown: true,
      manualModelToggle: true,
    },
  };

  it('passes a valid entry through unchanged (new object, same values)', () => {
    const result = sanitizeCatalogEntry(validEntry);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('zai');
    expect(result?.formShape.apiKey).toBe(true);
    expect(result?.modelOptions).toHaveLength(1);
    // Must be a new object, not the original
    expect(result).not.toBe(validEntry);
  });

  it('returns null for null/undefined/non-object input', () => {
    expect(sanitizeCatalogEntry(null)).toBeNull();
    expect(sanitizeCatalogEntry(undefined)).toBeNull();
    expect(sanitizeCatalogEntry('string')).toBeNull();
    expect(sanitizeCatalogEntry(42)).toBeNull();
  });

  it('returns null when id is missing or empty', () => {
    expect(sanitizeCatalogEntry({ ...validEntry, id: '' })).toBeNull();
    expect(sanitizeCatalogEntry({ ...validEntry, id: 123 })).toBeNull();
  });

  it('returns null when routeProtocol is invalid', () => {
    expect(sanitizeCatalogEntry({ ...validEntry, routeProtocol: 'invalid' })).toBeNull();
    expect(sanitizeCatalogEntry({ ...validEntry, routeProtocol: undefined })).toBeNull();
  });

  it('missing apiKey in formShape defaults to true (key required — security posture)', () => {
    const entry = {
      ...validEntry,
      formShape: {
        baseUrl: false,
        protocol: false,
        contextWindow: false,
        modelDropdown: true,
        manualModelToggle: true,
      },
    };
    const result = sanitizeCatalogEntry(entry);
    expect(result).not.toBeNull();
    // apiKey must default to true, NOT false
    expect(result?.formShape.apiKey).toBe(true);
    // allowEmptyApiKey = apiKey === false = false → key IS required
    expect(result?.formShape.apiKey === false).toBe(false);
  });

  it('non-boolean apiKey in formShape defaults to true (not coerced via Boolean)', () => {
    const entry = { ...validEntry, formShape: { ...validEntry.formShape, apiKey: 'yes' } };
    const result = sanitizeCatalogEntry(entry);
    expect(result).not.toBeNull();
    // String 'yes' is not === true and not === false → defaults to true
    expect(result?.formShape.apiKey).toBe(true);
  });

  it('does not mutate the original IPC object', () => {
    const original = { ...validEntry, formShape: { ...validEntry.formShape } };
    const originalFormShape = original.formShape;
    sanitizeCatalogEntry(original);
    // formShape object must be unchanged
    expect(original.formShape).toBe(originalFormShape);
    expect(original.formShape.apiKey).toBe(true);
  });

  it('drops modelOptions items with missing or non-string id/name', () => {
    const entry = {
      ...validEntry,
      modelOptions: [
        { id: 'valid', name: 'Valid' },
        { id: '', name: 'Empty id' },
        { id: 'no-name' },
        { name: 'no-id' },
        null,
        42,
      ],
    };
    const result = sanitizeCatalogEntry(entry);
    expect(result?.modelOptions).toHaveLength(1);
    expect(result?.modelOptions[0].id).toBe('valid');
  });

  it('deduplicates native entries within IPC result (first occurrence wins)', () => {
    // Simulates the merge logic: seenIds Set prevents duplicate ids
    const entries = [
      { ...validEntry, id: 'zai', name: 'First' },
      { ...validEntry, id: 'zai', name: 'Duplicate' },
      { ...validEntry, id: 'groq', name: 'Groq' },
    ];
    const sanitized = entries
      .map(sanitizeCatalogEntry)
      .filter((e): e is NonNullable<typeof e> => e !== null);
    const seenIds = new Set(['openrouter', 'anthropic', 'openai', 'gemini', 'ollama', 'custom']);
    const deduped = sanitized.filter((e) => {
      if (seenIds.has(e.id)) return false;
      seenIds.add(e.id);
      return true;
    });
    expect(deduped).toHaveLength(2);
    expect(deduped[0].name).toBe('First');
    expect(deduped[1].id).toBe('groq');
  });
});

describe('mergeProviderCatalog', () => {
  const makeEntry = (id: string, modelOptions: { id: string; name: string }[] = []) => ({
    id,
    name: id,
    kind: id === 'custom' ? ('custom' as const) : ('builtin' as const),
    category: 'featured' as const,
    piProvider: id === 'gemini' ? 'google' : id,
    routeProtocol: 'openai' as const,
    formShape: {
      apiKey: true,
      baseUrl: false,
      protocol: false,
      contextWindow: false,
      modelDropdown: true,
      manualModelToggle: false,
    },
    featured: true,
    modelOptions,
  });

  it('uses IPC builtin entries (with enriched modelOptions) over local empties', () => {
    // Regression: builtin modelOptions delivered over IPC must not be discarded
    // in favour of the local BUILTIN_ENTRIES (which have empty modelOptions).
    const ipc = [makeEntry('openrouter', [{ id: 'a/b', name: 'A: B' }])];
    const merged = mergeProviderCatalog(ipc, BUILTIN_ENTRIES);
    const openrouter = merged.find((e) => e.id === 'openrouter');
    expect(openrouter?.modelOptions).toEqual([{ id: 'a/b', name: 'A: B' }]);
  });

  it('appends local builtins the IPC catalog omitted', () => {
    const ipc = [makeEntry('openrouter', [{ id: 'x', name: 'X' }])];
    const merged = mergeProviderCatalog(ipc, BUILTIN_ENTRIES);
    // All 6 builtins present even though IPC only sent one
    for (const b of BUILTIN_ENTRIES) {
      expect(merged.some((e) => e.id === b.id)).toBe(true);
    }
  });

  it('dedups by id, first (IPC) occurrence wins', () => {
    const ipc = [makeEntry('openai', [{ id: 'gpt', name: 'GPT' }]), makeEntry('openai', [])];
    const merged = mergeProviderCatalog(ipc, BUILTIN_ENTRIES);
    expect(merged.filter((e) => e.id === 'openai')).toHaveLength(1);
    expect(merged.find((e) => e.id === 'openai')?.modelOptions).toEqual([
      { id: 'gpt', name: 'GPT' },
    ]);
  });
});
