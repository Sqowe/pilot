import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUILTIN_ENTRIES,
  EXCLUDED_NATIVE,
  NATIVE_PROVIDER_META,
  getCatalogEntry,
  getFeaturedEntries,
  getNonFeaturedEntries,
  groupEntriesByCategory,
  apiToRouteProtocol,
  titleCase,
  type NativeProviderMeta,
  type ProviderCatalogEntry,
} from '../../shared/provider-catalog';
import {
  buildNativeEntries,
  getFullProviderCatalog,
  resetProviderCatalogCache,
  type ProviderCatalogDeps,
} from '../../main/config/provider-catalog-native';

// ---------------------------------------------------------------------------
// Stub deps — minimal pi-ai compat surface for tests
// ---------------------------------------------------------------------------

function makeStubDeps(overrides?: {
  providers?: string[];
  modelMap?: Record<string, Array<{ id: string; name: string; api?: string }>>;
}): ProviderCatalogDeps {
  const providers = overrides?.providers ?? [
    'zai',
    'minimax',
    'deepseek',
    'groq',
    'kimi-coding',
    'xai',
    'fireworks',
    'mistral',
  ];
  const modelMap = overrides?.modelMap ?? {
    zai: [{ id: 'glm-4.5-air', name: 'GLM-4.5 Air', api: 'openai-completions' }],
    minimax: [{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7', api: 'anthropic-messages' }],
    deepseek: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', api: 'openai-completions' }],
    groq: [{ id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', api: 'openai-completions' }],
    'kimi-coding': [{ id: 'k2p7', name: 'Kimi K2.7 Code', api: 'anthropic-messages' }],
    xai: [{ id: 'grok-4', name: 'Grok 4', api: 'openai-completions' }],
    fireworks: [{ id: 'llama-v3p3-70b', name: 'Llama 3.3 70B', api: 'anthropic-messages' }],
    mistral: [{ id: 'mistral-large', name: 'Mistral Large', api: 'mistral-conversations' }],
  };
  return {
    getProviders: () => providers,
    getModels: (id) => modelMap[id] ?? [],
  };
}

// ---------------------------------------------------------------------------
// shared/provider-catalog helpers
// ---------------------------------------------------------------------------

describe('shared/provider-catalog — BUILTIN_ENTRIES', () => {
  it('contains exactly 6 builtin entries', () => {
    expect(BUILTIN_ENTRIES).toHaveLength(6);
  });

  it('all 6 legacy provider ids are present', () => {
    const ids = BUILTIN_ENTRIES.map((e) => e.id);
    expect(ids).toContain('openrouter');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('gemini');
    expect(ids).toContain('ollama');
    expect(ids).toContain('custom');
  });

  it('gemini piProvider is "google"', () => {
    const gemini = BUILTIN_ENTRIES.find((e) => e.id === 'gemini')!;
    expect(gemini.piProvider).toBe('google');
  });

  it('all featured entries have featured=true', () => {
    for (const entry of BUILTIN_ENTRIES) {
      expect(entry.featured).toBe(true);
    }
  });

  it('custom entry has full form shape', () => {
    const custom = BUILTIN_ENTRIES.find((e) => e.id === 'custom')!;
    expect(custom.formShape.protocol).toBe(true);
    expect(custom.formShape.baseUrl).toBe(true);
    expect(custom.formShape.contextWindow).toBe(true);
  });

  it('ollama entry has no apiKey field and has baseUrl', () => {
    const ollama = BUILTIN_ENTRIES.find((e) => e.id === 'ollama')!;
    expect(ollama.formShape.apiKey).toBe(false);
    expect(ollama.formShape.baseUrl).toBe(true);
  });

  it('builtin cloud entries have no baseUrl/protocol/contextWindow form fields', () => {
    for (const entry of BUILTIN_ENTRIES.filter((e) => e.kind === 'builtin' && e.id !== 'ollama')) {
      expect(entry.formShape.baseUrl).toBe(false);
      expect(entry.formShape.protocol).toBe(false);
      expect(entry.formShape.contextWindow).toBe(false);
    }
  });
});

describe('apiToRouteProtocol', () => {
  it('maps anthropic-messages → anthropic', () => {
    expect(apiToRouteProtocol('anthropic-messages')).toBe('anthropic');
  });

  it('maps google-generative-ai → gemini', () => {
    expect(apiToRouteProtocol('google-generative-ai')).toBe('gemini');
  });

  it('maps google-vertex → gemini', () => {
    expect(apiToRouteProtocol('google-vertex')).toBe('gemini');
  });

  it('maps any google-* variant → gemini (prefix matching)', () => {
    expect(apiToRouteProtocol('google-generative-ai-stream')).toBe('gemini');
    expect(apiToRouteProtocol('google-new-future-api')).toBe('gemini');
    expect(apiToRouteProtocol('google-')).toBe('gemini');
  });

  it('maps openai-completions → openai', () => {
    expect(apiToRouteProtocol('openai-completions')).toBe('openai');
  });

  it('maps mistral-conversations → openai (routing compat)', () => {
    expect(apiToRouteProtocol('mistral-conversations')).toBe('openai');
  });

  it('maps unknown api strings → openai as fallback', () => {
    expect(apiToRouteProtocol('bedrock-converse-stream')).toBe('openai');
    expect(apiToRouteProtocol('some-future-api')).toBe('openai');
  });
});

describe('titleCase', () => {
  it('title-cases a simple kebab id', () => {
    expect(titleCase('my-provider')).toBe('My Provider');
  });

  it('handles single word', () => {
    expect(titleCase('groq')).toBe('Groq');
  });
});

describe('getCatalogEntry', () => {
  it('returns the entry for a known id', () => {
    const entry = getCatalogEntry(BUILTIN_ENTRIES, 'anthropic');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('anthropic');
  });

  it('returns undefined for an unknown id', () => {
    expect(getCatalogEntry(BUILTIN_ENTRIES, 'bedrock')).toBeUndefined();
  });
});

describe('getFeaturedEntries', () => {
  it('returns only featured entries', () => {
    const featured = getFeaturedEntries(BUILTIN_ENTRIES);
    expect(featured.length).toBeGreaterThan(0);
    for (const e of featured) {
      expect(e.featured).toBe(true);
    }
  });
});

describe('getNonFeaturedEntries', () => {
  it('returns no builtin entries (all 6 are featured)', () => {
    expect(getNonFeaturedEntries(BUILTIN_ENTRIES)).toHaveLength(0);
  });

  it('sorts by category then name', () => {
    const extras: ProviderCatalogEntry[] = [
      {
        id: 'groq',
        name: 'Groq',
        kind: 'native',
        category: 'inference',
        piProvider: 'groq',
        routeProtocol: 'openai',
        formShape: {
          apiKey: true,
          baseUrl: false,
          protocol: false,
          contextWindow: false,
          modelDropdown: true,
          manualModelToggle: true,
        },
        modelOptions: [],
      },
      {
        id: 'zai',
        name: 'z.ai',
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
        modelOptions: [],
      },
    ];
    const sorted = getNonFeaturedEntries(extras);
    expect(sorted[0].id).toBe('zai'); // coding-plan < inference
    expect(sorted[1].id).toBe('groq');
  });
});

describe('groupEntriesByCategory', () => {
  it('groups entries correctly', async () => {
    const stub = makeStubDeps();
    const entries = await buildNativeEntries(stub);
    const groups = groupEntriesByCategory(entries);
    const categories = groups.map((g) => g.category);
    // Should have coding-plan and inference at minimum
    expect(categories).toContain('coding-plan');
    expect(categories).toContain('inference');
    // coding-plan comes before inference
    expect(categories.indexOf('coding-plan')).toBeLessThan(categories.indexOf('inference'));
  });
});

// ---------------------------------------------------------------------------
// EXCLUDED_NATIVE
// ---------------------------------------------------------------------------

describe('EXCLUDED_NATIVE', () => {
  it('excludes oauth/multi-field providers', () => {
    expect(EXCLUDED_NATIVE.has('amazon-bedrock')).toBe(true);
    expect(EXCLUDED_NATIVE.has('google-vertex')).toBe(true);
    expect(EXCLUDED_NATIVE.has('github-copilot')).toBe(true);
    expect(EXCLUDED_NATIVE.has('azure-openai-responses')).toBe(true);
    expect(EXCLUDED_NATIVE.has('cloudflare-ai-gateway')).toBe(true);
    expect(EXCLUDED_NATIVE.has('openai-codex')).toBe(true);
  });

  it('excludes providers already covered as builtin entries', () => {
    expect(EXCLUDED_NATIVE.has('anthropic')).toBe(true);
    expect(EXCLUDED_NATIVE.has('openai')).toBe(true);
    expect(EXCLUDED_NATIVE.has('openrouter')).toBe(true);
    expect(EXCLUDED_NATIVE.has('google')).toBe(true);
    expect(EXCLUDED_NATIVE.has('ollama')).toBe(true);
  });

  it('does NOT exclude allowlist providers', () => {
    const allowlist = ['zai', 'minimax', 'deepseek', 'groq', 'kimi-coding', 'xai', 'mistral'];
    for (const id of allowlist) {
      expect(EXCLUDED_NATIVE.has(id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// NATIVE_PROVIDER_META
// ---------------------------------------------------------------------------

describe('NATIVE_PROVIDER_META', () => {
  it('each entry has a non-empty name and valid category', () => {
    const validCategories = ['featured', 'coding-plan', 'inference', 'local', 'custom'];
    for (const [id, meta] of Object.entries(NATIVE_PROVIDER_META)) {
      expect(meta.name, `${id}.name is empty`).toBeTruthy();
      expect(validCategories, `${id}.category is invalid`).toContain(meta.category);
    }
  });

  it('region variants have regionOf and regionTag set', () => {
    expect(NATIVE_PROVIDER_META['zai-coding-cn'].regionOf).toBe('zai');
    expect(NATIVE_PROVIDER_META['zai-coding-cn'].regionTag).toBe('CN');
    expect(NATIVE_PROVIDER_META['minimax-cn'].regionOf).toBe('minimax');
    expect(NATIVE_PROVIDER_META['minimax-cn'].regionTag).toBe('CN');
    expect(NATIVE_PROVIDER_META['moonshotai-cn'].regionOf).toBe('moonshotai');
  });

  it('routeProtocol override, when present, is a valid protocol', () => {
    const validProtocols = ['anthropic', 'openai', 'gemini'];
    for (const [id, meta] of Object.entries(NATIVE_PROVIDER_META)) {
      if (meta.routeProtocol !== undefined) {
        expect(validProtocols, `${id}.routeProtocol is invalid`).toContain(meta.routeProtocol);
      }
    }
  });

  it('every entry in the meta map is not in EXCLUDED_NATIVE', () => {
    for (const id of Object.keys(NATIVE_PROVIDER_META)) {
      expect(
        EXCLUDED_NATIVE.has(id),
        `${id} is in both NATIVE_PROVIDER_META and EXCLUDED_NATIVE`
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildNativeEntries
// ---------------------------------------------------------------------------

describe('buildNativeEntries', () => {
  it('returns an entry for each non-excluded provider', async () => {
    const stub = makeStubDeps();
    const entries = await buildNativeEntries(stub);
    // All stub providers are in the allowlist
    expect(entries).toHaveLength(8);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('zai');
    expect(ids).toContain('minimax');
    expect(ids).toContain('groq');
    expect(ids).toContain('mistral');
  });

  it('filters out excluded providers', async () => {
    const stub = makeStubDeps({
      providers: ['zai', 'amazon-bedrock', 'github-copilot', 'groq'],
    });
    const entries = await buildNativeEntries(stub);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('zai');
    expect(ids).toContain('groq');
    expect(ids).not.toContain('amazon-bedrock');
    expect(ids).not.toContain('github-copilot');
  });

  it('deduplicates duplicate provider ids from registry', async () => {
    const stub = makeStubDeps({
      providers: ['zai', 'zai', 'groq', 'groq'],
    });
    const entries = await buildNativeEntries(stub);
    const ids = entries.map((e) => e.id);
    expect(ids.filter((id) => id === 'zai')).toHaveLength(1);
    expect(ids.filter((id) => id === 'groq')).toHaveLength(1);
  });

  it('filters out falsy/empty provider ids', async () => {
    const stub: ProviderCatalogDeps = {
      getProviders: () => ['zai', '', 'groq'] as string[],
      getModels: (id) =>
        makeStubDeps().getModels(id) as ReturnType<ProviderCatalogDeps['getModels']>,
    };
    const entries = await buildNativeEntries(stub);
    expect(entries.map((e) => e.id)).not.toContain('');
  });

  it('supports async getProviders and getModels', async () => {
    const asyncStub: ProviderCatalogDeps = {
      getProviders: () => Promise.resolve(['zai', 'groq']),
      getModels: (id) =>
        Promise.resolve(
          id === 'zai'
            ? [{ id: 'glm-4.5-air', name: 'GLM-4.5 Air', api: 'openai-completions' }]
            : [{ id: 'llama-3.1-8b', name: 'Llama 3.1 8B', api: 'openai-completions' }]
        ),
    };
    const entries = await buildNativeEntries(asyncStub);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.id === 'zai')?.modelOptions[0].id).toBe('glm-4.5-air');
    expect(entries.find((e) => e.id === 'groq')?.modelOptions[0].id).toBe('llama-3.1-8b');
  });

  it('derives routeProtocol from ALL models, not just the first', async () => {
    // Provider with mixed models: first is openai but majority are anthropic
    const stub: ProviderCatalogDeps = {
      getProviders: () => ['mixed-provider'],
      getModels: () => [
        { id: 'model-a', name: 'Model A', api: 'openai-completions' },
        { id: 'model-b', name: 'Model B', api: 'anthropic-messages' },
        { id: 'model-c', name: 'Model C', api: 'anthropic-messages' },
      ],
    };
    const entries = await buildNativeEntries(stub);
    // anthropic wins even though first model is openai
    expect(entries[0].routeProtocol).toBe('anthropic');
  });

  it('derives routeProtocol from all models (protocol derivation)', async () => {
    const stub = makeStubDeps();
    const entries = await buildNativeEntries(stub);

    const zai = entries.find((e) => e.id === 'zai')!;
    expect(zai.routeProtocol).toBe('openai'); // openai-completions

    const minimax = entries.find((e) => e.id === 'minimax')!;
    expect(minimax.routeProtocol).toBe('anthropic'); // anthropic-messages

    const mistral = entries.find((e) => e.id === 'mistral')!;
    expect(mistral.routeProtocol).toBe('openai'); // mistral-conversations → openai

    const kimi = entries.find((e) => e.id === 'kimi-coding')!;
    expect(kimi.routeProtocol).toBe('anthropic'); // anthropic-messages
  });

  it('populates modelOptions from getModels()', async () => {
    const stub = makeStubDeps();
    const entries = await buildNativeEntries(stub);

    const zai = entries.find((e) => e.id === 'zai')!;
    expect(zai.modelOptions).toHaveLength(1);
    expect(zai.modelOptions[0].id).toBe('glm-4.5-air');
  });

  it('uses NATIVE_PROVIDER_META name and category', async () => {
    const stub = makeStubDeps();
    const entries = await buildNativeEntries(stub);

    const zai = entries.find((e) => e.id === 'zai')!;
    expect(zai.name).toBe('z.ai (GLM)');
    expect(zai.category).toBe('coding-plan');
    expect(zai.keyEnvVar).toBe('ZAI_API_KEY');
  });

  it('falls back to titleCase name for unknown provider not in meta', async () => {
    const stub = makeStubDeps({
      providers: ['some-new-provider'],
      modelMap: {
        'some-new-provider': [{ id: 'model-1', name: 'Model 1', api: 'openai-completions' }],
      },
    });
    const entries = await buildNativeEntries(stub);
    expect(entries[0].name).toBe('Some New Provider');
    expect(entries[0].category).toBe('inference'); // fallback category
  });

  it('handles getModels() returning undefined gracefully', async () => {
    const stub: ProviderCatalogDeps = {
      getProviders: () => ['groq'],
      getModels: () => undefined,
    };
    const entries = await buildNativeEntries(stub);
    expect(entries).toHaveLength(1);
    expect(entries[0].modelOptions).toHaveLength(0);
    expect(entries[0].routeProtocol).toBe('openai'); // fallback
  });

  it('handles getProviders() throwing gracefully — error propagates to caller', async () => {
    const stub: ProviderCatalogDeps = {
      getProviders: () => {
        throw new Error('registry unavailable');
      },
      getModels: () => [],
    };
    // buildNativeEntries now re-throws getProviders() errors so _buildCatalog
    // can clear the cache and retry. Direct callers must handle the rejection.
    await expect(buildNativeEntries(stub)).rejects.toThrow('registry unavailable');
  });

  it('all native entries have kind="native" and featured=false', async () => {
    const stub = makeStubDeps();
    for (const entry of await buildNativeEntries(stub)) {
      expect(entry.kind).toBe('native');
      expect(entry.featured).toBeFalsy();
    }
  });

  it('native form shape: no baseUrl/protocol/contextWindow, has manualModelToggle', async () => {
    const stub = makeStubDeps();
    for (const entry of await buildNativeEntries(stub)) {
      expect(entry.formShape.baseUrl).toBe(false);
      expect(entry.formShape.protocol).toBe(false);
      expect(entry.formShape.contextWindow).toBe(false);
      expect(entry.formShape.manualModelToggle).toBe(true);
      expect(entry.formShape.apiKey).toBe(true);
    }
  });

  it('sanitizes model entries — filters falsy ids/names, trims, deduplicates', async () => {
    const stub: ProviderCatalogDeps = {
      getProviders: () => ['zai'],
      getModels: () => [
        { id: 'glm-4.5-air', name: 'GLM-4.5 Air', api: 'openai-completions' },
        { id: '', name: 'Empty id', api: 'openai-completions' }, // filtered: empty id
        { id: 'valid-model', name: '', api: 'openai-completions' }, // filtered: empty name
        { id: '  trimmed  ', name: '  Name  ', api: 'openai-completions' }, // trimmed
        { id: 'glm-4.5-air', name: 'Duplicate', api: 'openai-completions' }, // deduped
      ],
    };
    const entries = await buildNativeEntries(stub);
    const models = entries[0].modelOptions;
    expect(models).toHaveLength(2); // glm-4.5-air + trimmed
    expect(models.find((m) => m.id === 'glm-4.5-air')).toBeDefined();
    expect(models.find((m) => m.id === 'trimmed')).toBeDefined();
    expect(models.find((m) => m.id === 'trimmed')?.name).toBe('Name');
    expect(models.find((m) => m.id === '')).toBeUndefined();
  });

  it('each builtin entry has its own formShape object (no shared references)', () => {
    const openrouter = BUILTIN_ENTRIES.find((e) => e.id === 'openrouter')!;
    const anthropic = BUILTIN_ENTRIES.find((e) => e.id === 'anthropic')!;
    expect(openrouter.formShape).not.toBe(anthropic.formShape);
    // Mutating one does not affect the other
    const orig = openrouter.formShape.apiKey;
    (openrouter.formShape as unknown as Record<string, unknown>).apiKey = false;
    expect(anthropic.formShape.apiKey).toBe(orig);
    (openrouter.formShape as unknown as Record<string, unknown>).apiKey = orig; // restore
  });

  it('region variants carry regionOf and regionTag', async () => {
    const stub = makeStubDeps({ providers: ['minimax-cn'] });
    const entries = await buildNativeEntries(stub);
    expect(entries[0].regionOf).toBe('minimax');
    expect(entries[0].regionTag).toBe('CN');
  });

  it('NATIVE_PROVIDER_META routeProtocol override wins over api-derived protocol', async () => {
    // mixed-provider would derive 'anthropic' from its models, but meta overrides to 'openai'
    const stub: ProviderCatalogDeps = {
      getProviders: () => ['mixed-provider'],
      getModels: () => [
        { id: 'model-a', name: 'Model A', api: 'anthropic-messages' },
        { id: 'model-b', name: 'Model B', api: 'anthropic-messages' },
      ],
    };
    // Temporarily inject a meta override for the test provider
    const original = { ...NATIVE_PROVIDER_META };
    (NATIVE_PROVIDER_META as Record<string, NativeProviderMeta>)['mixed-provider'] = {
      name: 'Mixed Provider',
      category: 'inference',
      routeProtocol: 'openai',
    };
    try {
      const entries = await buildNativeEntries(stub);
      expect(entries[0].routeProtocol).toBe('openai'); // override wins
    } finally {
      delete (NATIVE_PROVIDER_META as Record<string, NativeProviderMeta>)['mixed-provider'];
      // Restore any keys removed (none in this case)
      void original;
    }
  });

  it('per-provider getModels() throw does not abort the whole build', async () => {
    let callCount = 0;
    const stub: ProviderCatalogDeps = {
      getProviders: () => ['zai', 'groq', 'deepseek'],
      getModels: (id) => {
        callCount++;
        if (id === 'groq') throw new Error('groq registry unavailable');
        return [{ id: `${id}-model`, name: `${id} model`, api: 'openai-completions' }];
      },
    };
    const entries = await buildNativeEntries(stub);
    // All 3 providers produce entries
    expect(entries).toHaveLength(3);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('zai');
    expect(ids).toContain('groq');
    expect(ids).toContain('deepseek');
    // groq has empty modelOptions due to throw
    const groq = entries.find((e) => e.id === 'groq')!;
    expect(groq.modelOptions).toHaveLength(0);
    expect(groq.routeProtocol).toBe('openai'); // fallback
    // others have their model
    expect(entries.find((e) => e.id === 'zai')!.modelOptions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getFullProviderCatalog (integration — injected deps)
// ---------------------------------------------------------------------------

describe('getFullProviderCatalog', () => {
  beforeEach(() => {
    resetProviderCatalogCache();
  });

  it('returns builtin + native entries combined', async () => {
    const stub = makeStubDeps();
    const catalog = await getFullProviderCatalog(stub);

    // All 6 builtins present
    for (const entry of BUILTIN_ENTRIES) {
      expect(catalog.some((e) => e.id === entry.id)).toBe(true);
    }
    // Native entries present
    expect(catalog.some((e) => e.id === 'zai')).toBe(true);
    expect(catalog.some((e) => e.id === 'groq')).toBe(true);
  });

  it('excluded ids are absent from the full catalog', async () => {
    const stub = makeStubDeps({
      providers: ['zai', 'amazon-bedrock', 'github-copilot', 'deepseek'],
    });
    const catalog = await getFullProviderCatalog(stub);
    const ids = catalog.map((e) => e.id);
    expect(ids).not.toContain('amazon-bedrock');
    expect(ids).not.toContain('github-copilot');
    expect(ids).toContain('zai');
    expect(ids).toContain('deepseek');
  });

  it('is memoised — second call with different deps returns cached result', async () => {
    const stub1 = makeStubDeps({ providers: ['zai'] });
    const catalog1 = await getFullProviderCatalog(stub1);

    // Second call with different stub — should return same cached catalog
    const stub2 = makeStubDeps({ providers: ['groq'] });
    const catalog2 = await getFullProviderCatalog(stub2);

    expect(catalog1).toBe(catalog2); // strict reference equality
  });

  it('resetProviderCatalogCache allows a fresh build', async () => {
    const stub1 = makeStubDeps({ providers: ['zai'] });
    const catalog1 = await getFullProviderCatalog(stub1);

    resetProviderCatalogCache();

    const stub2 = makeStubDeps({ providers: ['groq'] });
    const catalog2 = await getFullProviderCatalog(stub2);

    expect(catalog1).not.toBe(catalog2);
    expect(catalog2.some((e) => e.id === 'groq')).toBe(true);
  });

  it('clears cache on getProviders() failure so next call retries', async () => {
    let attempt = 0;
    const flakyDeps: ProviderCatalogDeps = {
      getProviders: () => {
        attempt++;
        if (attempt === 1) throw new Error('transient registry failure');
        return ['zai'];
      },
      getModels: () => [{ id: 'glm-4.5-air', name: 'GLM-4.5 Air', api: 'openai-completions' }],
    };

    // First call: getProviders throws → _buildCatalog catches, clears cache, returns builtin-only
    const result1 = await getFullProviderCatalog(flakyDeps);
    expect(result1).toHaveLength(BUILTIN_ENTRIES.length); // builtin-only
    expect(result1.some((e) => e.id === 'zai')).toBe(false);

    // Cache was cleared by the failure — second call rebuilds successfully with zai
    const result2 = await getFullProviderCatalog(flakyDeps);
    expect(result2.some((e) => e.id === 'zai')).toBe(true);
    expect(result2.length).toBeGreaterThan(BUILTIN_ENTRIES.length);

    // Third call: cache hit from the successful build
    const result3 = await getFullProviderCatalog(flakyDeps);
    expect(result3).toBe(result2);
  });

  it('caches result after successful build — subsequent calls return same reference', async () => {
    let attempt = 0;
    const flakyDeps: ProviderCatalogDeps = {
      getProviders: () => {
        attempt++;
        return attempt === 1 ? [] : ['zai'];
      },
      getModels: () => [{ id: 'glm-4.5-air', name: 'GLM-4.5 Air', api: 'openai-completions' }],
    };

    // First call: getProviders returns [] → builtin-only, result is cached
    const result1 = await getFullProviderCatalog(flakyDeps);
    expect(result1).toHaveLength(BUILTIN_ENTRIES.length);

    // Second call: returns the CACHED result (not a fresh build with zai)
    const result2 = await getFullProviderCatalog(flakyDeps);
    expect(result2).toBe(result1); // strict cache hit

    // After explicit reset, a fresh build picks up zai
    resetProviderCatalogCache();
    const result3 = await getFullProviderCatalog(flakyDeps);
    expect(result3.some((e) => e.id === 'zai')).toBe(true);
  });

  it('builtin entries in catalog are shallow-cloned (not shared references)', async () => {
    const stub = makeStubDeps({ providers: [] });
    const catalog = await getFullProviderCatalog(stub);
    const anthropicInCatalog = catalog.find((e) => e.id === 'anthropic')!;
    const anthropicOriginal = BUILTIN_ENTRIES.find((e) => e.id === 'anthropic')!;
    // Different object references
    expect(anthropicInCatalog).not.toBe(anthropicOriginal);
    expect(anthropicInCatalog.formShape).not.toBe(anthropicOriginal.formShape);
    // But same values
    expect(anthropicInCatalog.name).toBe(anthropicOriginal.name);
    expect(anthropicInCatalog.routeProtocol).toBe(anthropicOriginal.routeProtocol);
  });

  it('getNativeModelOptions returns models for a native entry', async () => {
    const stub = makeStubDeps();
    const catalog = await getFullProviderCatalog(stub);
    const zai = catalog.find((e) => e.id === 'zai')!;
    expect(zai.modelOptions.length).toBeGreaterThan(0);
    expect(zai.modelOptions[0].id).toBe('glm-4.5-air');
  });

  it('builtin entries have empty modelOptions (use API_PROVIDER_PRESETS instead)', async () => {
    const stub = makeStubDeps();
    const catalog = await getFullProviderCatalog(stub);
    for (const entry of BUILTIN_ENTRIES) {
      const found = catalog.find((e) => e.id === entry.id)!;
      expect(found.modelOptions).toHaveLength(0);
    }
  });
});
