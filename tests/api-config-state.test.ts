import { describe, expect, it } from 'vitest';
import type { AppConfig, ProviderType } from '../src/renderer/types';
import fs from 'node:fs';
import path from 'node:path';
import { shouldAutoDiscoverLocalOllamaBaseUrl } from '../src/shared/ollama-base-url';
import {
  BUILTIN_ENTRIES,
  getCatalogEntry,
  NATIVE_SHAPE,
  type ProviderCatalogEntry,
} from '../src/shared/provider-catalog';
import {
  FALLBACK_PROVIDER_PRESETS,
  buildApiConfigSnapshot,
  getModelInputGuidance,
  isCustomAnthropicLoopbackGateway,
  isCustomGeminiLoopbackGateway,
  isCustomOpenAiLoopbackGateway,
  profileKeyFromProvider,
  profileKeyToProvider,
  resolveProviderProtocol,
  sanitizeCatalogEntry,
  mergeProviderCatalog,
} from '../src/renderer/hooks/useApiConfigState';

const hookPath = path.resolve(process.cwd(), 'src/renderer/hooks/useApiConfigState.ts');

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

  it('conservatively upgrades legacy localhost ollama config into the ollama profile', () => {
    const config = {
      provider: 'custom',
      customProtocol: 'openai',
      activeProfileKey: 'custom:openai',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.5:0.8b',
      profiles: {
        'custom:openai': {
          apiKey: '',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen3.5:0.8b',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.activeProfileKey).toBe('ollama');
    expect(snapshot.profiles.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(snapshot.profiles.ollama.model).toBe('qwen3.5:0.8b');
  });

  it('normalizes ollama profile base urls during renderer bootstrap', () => {
    const config = {
      provider: 'ollama',
      customProtocol: 'openai',
      activeProfileKey: 'ollama',
      apiKey: '',
      baseUrl: 'http://localhost:11434/api',
      model: 'qwen3.5:0.8b',
      profiles: {
        ollama: {
          apiKey: '',
          baseUrl: 'http://localhost:11434/api',
          model: 'qwen3.5:0.8b',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.profiles.ollama.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('keeps remote custom openai configs generic instead of auto-migrating them to ollama', () => {
    const config = {
      provider: 'custom',
      customProtocol: 'openai',
      activeProfileKey: 'custom:openai',
      apiKey: '',
      baseUrl: 'https://relay.example.internal/v1',
      model: 'qwen3.5:0.8b',
      profiles: {
        'custom:openai': {
          apiKey: '',
          baseUrl: 'https://relay.example.internal/v1',
          model: 'qwen3.5:0.8b',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.activeProfileKey).toBe('custom:openai');
  });

  it('exposes ollama presets and guidance', () => {
    expect(FALLBACK_PROVIDER_PRESETS.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(FALLBACK_PROVIDER_PRESETS.ollama.keyHint).toBe('api.providerHints.ollama.keyHint');
    expect(getModelInputGuidance('ollama').placeholder).toContain('qwen');
  });

  it('loads existing profile values without overwriting them with defaults', () => {
    const config = {
      provider: 'custom',
      customProtocol: 'openai',
      activeProfileKey: 'custom:openai',
      apiKey: 'sk-active',
      baseUrl: 'https://custom-openai.example/v1',
      model: 'gpt-5.3-codex',
      profiles: {
        'custom:openai': {
          apiKey: 'sk-custom-openai',
          baseUrl: 'https://custom-openai.example/v1',
          model: 'gpt-5.3-codex',
        },
        'custom:anthropic': {
          apiKey: 'sk-custom-anthropic',
          baseUrl: 'https://custom-anthropic.example',
          model: 'glm-4.7',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.activeProfileKey).toBe('custom:openai');
    expect(snapshot.profiles['custom:openai'].apiKey).toBe('sk-custom-openai');
    expect(snapshot.profiles['custom:openai'].baseUrl).toBe('https://custom-openai.example/v1');
    expect(snapshot.profiles['custom:anthropic'].apiKey).toBe('sk-custom-anthropic');
  });

  it('applies defaults only for missing profiles', () => {
    const config = {
      provider: 'openai',
      customProtocol: 'anthropic',
      activeProfileKey: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
      profiles: {
        openai: {
          apiKey: 'sk-openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.4',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.profiles.openai.apiKey).toBe('sk-openai');
    expect(snapshot.profiles.openrouter.baseUrl).toBe(FALLBACK_PROVIDER_PRESETS.openrouter.baseUrl);
    expect(snapshot.profiles['custom:anthropic'].model).toBe(
      FALLBACK_PROVIDER_PRESETS.custom.models[0]?.id
    );
    expect(snapshot.profiles['custom:anthropic'].useCustomModel).toBe(true);
    expect(snapshot.profiles['custom:anthropic'].customModel).toBe('');
  });

  it('detects local custom anthropic loopback gateway url', () => {
    expect(isCustomAnthropicLoopbackGateway('http://127.0.0.1:8082')).toBe(true);
    expect(isCustomAnthropicLoopbackGateway('http://localhost:8082')).toBe(true);
    expect(isCustomAnthropicLoopbackGateway('http://[::1]:8082')).toBe(true);
    expect(isCustomAnthropicLoopbackGateway('http://0.0.0.0:8082')).toBe(false);
    expect(isCustomAnthropicLoopbackGateway('https://proxy.example.com')).toBe(false);
  });

  it('detects local custom gemini loopback gateway url', () => {
    expect(isCustomGeminiLoopbackGateway('http://127.0.0.1:8082')).toBe(true);
    expect(isCustomGeminiLoopbackGateway('http://localhost:8082')).toBe(true);
    expect(isCustomGeminiLoopbackGateway('http://[::1]:8082')).toBe(true);
    expect(isCustomGeminiLoopbackGateway('http://0.0.0.0:8082')).toBe(false);
    expect(isCustomGeminiLoopbackGateway('https://proxy.example.com')).toBe(false);
  });

  it('detects local custom openai loopback gateway url', () => {
    expect(isCustomOpenAiLoopbackGateway('http://127.0.0.1:8082/v1')).toBe(true);
    expect(isCustomOpenAiLoopbackGateway('http://localhost:8082')).toBe(true);
    expect(isCustomOpenAiLoopbackGateway('http://[::1]:8082')).toBe(true);
    expect(isCustomOpenAiLoopbackGateway('http://0.0.0.0:8082')).toBe(false);
    expect(isCustomOpenAiLoopbackGateway('https://relay.example.com/v1')).toBe(false);
  });

  it('loads gemini provider and custom gemini profile values without fallback drift', () => {
    const config = {
      provider: 'custom',
      customProtocol: 'gemini',
      activeProfileKey: 'custom:gemini',
      apiKey: 'AIza-relay',
      baseUrl: 'https://gemini-proxy.example/v1',
      model: 'gemini/gemini-2.5-pro',
      profiles: {
        gemini: {
          apiKey: 'AIza-official',
          baseUrl: 'https://generativelanguage.googleapis.com',
          model: 'gemini/gemini-2.5-flash',
        },
        'custom:gemini': {
          apiKey: 'AIza-relay',
          baseUrl: 'https://gemini-proxy.example/v1',
          model: 'gemini/gemini-2.5-pro',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.activeProfileKey).toBe('custom:gemini');
    expect(snapshot.profiles.gemini.apiKey).toBe('AIza-official');
    expect(snapshot.profiles['custom:gemini'].baseUrl).toBe('https://gemini-proxy.example/v1');
  });

  it('keeps pristine custom openai profile in manual input mode', () => {
    const config = {
      provider: 'custom',
      customProtocol: 'openai',
      activeProfileKey: 'custom:openai',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
      profiles: {
        'custom:openai': {
          apiKey: '',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.4',
        },
      },
      isConfigured: false,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.profiles['custom:openai'].useCustomModel).toBe(true);
    expect(snapshot.profiles['custom:openai'].customModel).toBe('');
    expect(snapshot.profiles['custom:openai'].model).toBe('gpt-5.4');
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
    expect(FALLBACK_PROVIDER_PRESETS.custom.models.map((item) => item.id)).toContain(
      'grok-code-fast-1'
    );
    expect(FALLBACK_PROVIDER_PRESETS.custom.models.map((item) => item.id)).toContain(
      'mistral-large-latest'
    );

    expect(getModelInputGuidance('custom', 'openai').placeholder).toContain('deepseek-chat');
    expect(getModelInputGuidance('custom', 'openai').placeholder).not.toContain('kimi');
    expect(getModelInputGuidance('custom', 'openai').hint).toContain(
      'selected protocol or endpoint'
    );
  });

  it('wires local Ollama discovery through the shared config hook', () => {
    const source = fs.readFileSync(hookPath, 'utf8');
    expect(source).toContain('window.electronAPI.config.discoverLocal({');
    expect(source).toContain('baseUrl: requestedBaseUrl || undefined');
    expect(source).toContain("showErrorKey('api.localOllamaNotFound')");
    expect(source).toContain("showSuccessKey('api.localOllamaDiscovered'");
    expect(source).toContain("showErrorKey('api.localOllamaNoModels')");
    expect(source).toContain('ollamaDiscoverRequestIdRef');
    // useReducer refactor: cleared via dispatch action instead of direct setter
    expect(source).toContain(
      "dispatch({ type: 'CLEAR_DISCOVERED_MODELS', profileKey: requestedProfileKey })"
    );
    expect(source).toContain('autoSelectModelId: models[0]?.id');
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

  // -------------------------------------------------------------------------
  // resolveProviderProtocol — behavioral tests for changeProvider protocol logic
  // -------------------------------------------------------------------------

  it('resolveProviderProtocol uses catalog routeProtocol for native openai provider', () => {
    // zai has routeProtocol: 'openai' in MOCK_CATALOG
    expect(resolveProviderProtocol('zai', MOCK_CATALOG)).toBe('openai');
  });

  it('resolveProviderProtocol uses catalog routeProtocol for native anthropic provider', () => {
    // kimi-coding has routeProtocol: 'anthropic'
    expect(resolveProviderProtocol('kimi-coding', MOCK_CATALOG)).toBe('anthropic');
  });

  it('resolveProviderProtocol returns lastCustomProtocol for custom provider', () => {
    expect(resolveProviderProtocol('custom', MOCK_CATALOG, 'gemini')).toBe('gemini');
    expect(resolveProviderProtocol('custom', MOCK_CATALOG, 'openai')).toBe('openai');
  });

  it('resolveProviderProtocol returns anthropic for builtin non-custom providers', () => {
    expect(resolveProviderProtocol('anthropic', MOCK_CATALOG)).toBe('anthropic');
    expect(resolveProviderProtocol('openai', MOCK_CATALOG)).toBe('anthropic');
  });

  it('resolveProviderProtocol falls back to anthropic for unknown provider not in catalog', () => {
    expect(resolveProviderProtocol('totally-unknown' as ProviderType, MOCK_CATALOG)).toBe(
      'anthropic'
    );
  });

  it('resolveProviderProtocol falls back to anthropic when catalog is empty', () => {
    expect(resolveProviderProtocol('zai' as ProviderType, [])).toBe('anthropic');
  });

  it('changeProvider for native derives correct profile key via resolveProviderProtocol', () => {
    // zai → openai protocol → native:zai profile key
    const protocol = resolveProviderProtocol('zai', MOCK_CATALOG);
    expect(profileKeyFromProvider('zai', protocol)).toBe('native:zai');
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
