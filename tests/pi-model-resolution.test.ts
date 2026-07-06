import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCatalogEntry } from '../src/shared/provider-catalog';

// ---------------------------------------------------------------------------
// Mock getCachedProviderCatalogSync so unit tests control catalog state
// without triggering the real pi-ai/compat dynamic import.
// vi.hoisted ensures the variable is initialised before vi.mock's factory
// runs (Vitest hoists vi.mock calls to the top of the module, so any
// variables they reference must also be hoisted).
// ---------------------------------------------------------------------------
const { mockGetCachedCatalog } = vi.hoisted(() => ({
  mockGetCachedCatalog: vi.fn<[], ProviderCatalogEntry[] | null>(() => null),
}));

vi.mock('../src/main/config/provider-catalog-native', () => ({
  getCachedProviderCatalogSync: () => mockGetCachedCatalog(),
  resetProviderCatalogCache: vi.fn(),
  getFullProviderCatalog: vi.fn(),
}));

import {
  applyPiModelRuntimeOverrides,
  buildPiModelLookupCandidates,
  buildSyntheticPiModel,
  inferPiApi,
  resolvePiModelString,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
  resolveRuntimeApiKeyProviders,
} from '../src/main/claude/pi-model-resolution';

/** Minimal catalog entries used across P2 routing tests. */
const MOCK_ZAI_ENTRY: ProviderCatalogEntry = {
  id: 'zai',
  name: 'z.ai (GLM)',
  kind: 'native',
  category: 'coding-plan',
  piProvider: 'zai',
  routeProtocol: 'openai',
  keyEnvVar: 'ZAI_API_KEY',
  formShape: {
    apiKey: true,
    baseUrl: false,
    protocol: false,
    contextWindow: false,
    modelDropdown: true,
    manualModelToggle: true,
  },
  featured: false,
  modelOptions: [],
};

const MOCK_KIMI_ENTRY: ProviderCatalogEntry = {
  id: 'kimi-coding',
  name: 'Kimi (Moonshot)',
  kind: 'native',
  category: 'coding-plan',
  piProvider: 'kimi-coding',
  routeProtocol: 'anthropic',
  keyEnvVar: 'KIMI_API_KEY',
  formShape: {
    apiKey: true,
    baseUrl: false,
    protocol: false,
    contextWindow: false,
    modelDropdown: true,
    manualModelToggle: true,
  },
  featured: false,
  modelOptions: [],
};

const MOCK_DEEPSEEK_ENTRY: ProviderCatalogEntry = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'native',
  category: 'coding-plan',
  piProvider: 'deepseek',
  routeProtocol: 'openai',
  keyEnvVar: 'DEEPSEEK_API_KEY',
  formShape: {
    apiKey: true,
    baseUrl: false,
    protocol: false,
    contextWindow: false,
    modelDropdown: true,
    manualModelToggle: true,
  },
  featured: false,
  modelOptions: [],
};

const MOCK_CATALOG: ProviderCatalogEntry[] = [MOCK_ZAI_ENTRY, MOCK_KIMI_ENTRY, MOCK_DEEPSEEK_ENTRY];

describe('pi model resolution helpers', () => {
  it('skips invalid custom raw provider lookups and deduplicates candidates', () => {
    const candidates = buildPiModelLookupCandidates('openai/gpt-5.4', {
      configProvider: 'openai',
      rawProvider: 'custom',
    });

    expect(candidates).toEqual([
      { provider: 'openai', model: 'gpt-5.4' },
      { provider: 'anthropic', model: 'gpt-5.4' },
      { provider: 'google', model: 'gpt-5.4' },
    ]);
  });

  it('prefers openrouter full model id before native provider lookup', () => {
    const candidates = buildPiModelLookupCandidates('anthropic/claude-sonnet-4-6', {
      configProvider: 'anthropic',
      rawProvider: 'openrouter',
    });

    expect(candidates).toEqual([
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'claude-sonnet-4-6' },
      { provider: 'google', model: 'claude-sonnet-4-6' },
    ]);
  });

  it('builds provider-prefixed model ids from config-like input', () => {
    expect(
      resolvePiModelString({ provider: 'openai', customProtocol: 'openai', model: 'gpt-5.4' })
    ).toBe('openai/gpt-5.4');
    expect(
      resolvePiModelString({
        provider: 'custom',
        customProtocol: 'gemini',
        model: 'gemini-3-flash-preview',
      })
    ).toBe('gemini/gemini-3-flash-preview');
    expect(
      resolvePiModelString({
        provider: 'anthropic',
        customProtocol: 'anthropic',
        model: 'anthropic/claude-sonnet-4-6',
      })
    ).toBe('anthropic/claude-sonnet-4-6');
  });

  it('routes openrouter through the openai-compatible protocol', () => {
    expect(resolvePiRouteProtocol('openrouter', 'anthropic')).toBe('openai');
    expect(resolvePiRouteProtocol('ollama', 'openai')).toBe('openai');
    expect(resolvePiRouteProtocol('custom', 'gemini')).toBe('gemini');
    expect(resolvePiRouteProtocol('custom', 'anthropic')).toBe('anthropic');
  });

  it('builds synthetic models with protocol-specific api defaults', () => {
    expect(inferPiApi('anthropic')).toBe('anthropic-messages');
    expect(inferPiApi('gemini')).toBe('google-generative-ai');
    expect(inferPiApi('unknown')).toBe('openai-completions');

    const model = buildSyntheticPiModel('grok-code-fast-1', 'xai', 'openai', 'https://api.x.ai/v1');
    expect(model.id).toBe('grok-code-fast-1');
    expect(model.provider).toBe('xai');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://api.x.ai/v1');
  });

  it('preserves explicit provider-prefixed ids for openrouter synthetic fallbacks', () => {
    const fallback = resolveSyntheticPiModelFallback({
      rawModel: 'z-ai/glm-5-turbo',
      resolvedModelString: 'z-ai/glm-5-turbo',
      rawProvider: 'openrouter',
      routeProtocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    expect(fallback).toEqual({
      provider: 'openrouter',
      modelId: 'z-ai/glm-5-turbo',
    });
  });

  it('strips helper-added provider prefixes for first-party openai fallbacks', () => {
    const fallback = resolveSyntheticPiModelFallback({
      rawModel: 'gpt-5.4',
      resolvedModelString: 'openai/gpt-5.4',
      rawProvider: 'openai',
      routeProtocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(fallback).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.4',
    });
  });

  it('maps ollama synthetic fallbacks onto the openai provider', () => {
    const fallback = resolveSyntheticPiModelFallback({
      rawModel: 'qwen3.5:0.8b',
      resolvedModelString: 'qwen3.5:0.8b',
      rawProvider: 'ollama',
      routeProtocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
    });

    expect(fallback).toEqual({
      provider: 'openai',
      modelId: 'qwen3.5:0.8b',
    });
  });

  it('downgrades openai responses api to completions for custom endpoints', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'gpt-5.4',
        name: 'gpt-5.4',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        configProvider: 'openai',
        rawProvider: 'custom',
        customBaseUrl: 'https://relay.example.com/v1',
      }
    );

    expect(model.baseUrl).toBe('https://relay.example.com/v1');
    expect(model.api).toBe('openai-completions');
  });

  it('keeps openai responses api for first-party openai endpoints', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'gpt-5.4',
        name: 'gpt-5.4',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        configProvider: 'openai',
        rawProvider: 'openai',
        customBaseUrl: 'https://api.openai.com/v1',
      }
    );

    expect(model.api).toBe('openai-responses');
  });

  it('disables developer role for third-party openai-compatible endpoints', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'kimi-k2.5',
        name: 'kimi-k2.5',
        api: 'openai-completions',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        configProvider: 'openai',
        rawProvider: 'openai',
        customBaseUrl: 'https://api.moonshot.cn/v1',
      }
    );

    expect(model.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(model.compat?.supportsDeveloperRole).toBe(false);
  });

  it('keeps developer role enabled for first-party openai endpoints', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'gpt-5.4',
        name: 'gpt-5.4',
        api: 'openai-completions',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        configProvider: 'openai',
        rawProvider: 'openai',
        customBaseUrl: 'https://api.openai.com/v1',
      }
    );

    expect(model.compat?.supportsDeveloperRole).toBeUndefined();
  });

  it('auto-detects reasoning models by model id pattern', () => {
    const thinking = buildSyntheticPiModel(
      'kimi-k2-thinking',
      'moonshot',
      'openai',
      'https://api.moonshot.cn/v1'
    );
    expect(thinking.reasoning).toBe(true);

    const kimiK2 = buildSyntheticPiModel(
      'kimi-k2.5',
      'moonshot',
      'openai',
      'https://api.moonshot.cn/v1'
    );
    expect(kimiK2.reasoning).toBe(true);

    const deepseekR1 = buildSyntheticPiModel(
      'deepseek-r1-distill',
      'deepseek',
      'openai',
      'https://api.deepseek.com/v1'
    );
    expect(deepseekR1.reasoning).toBe(true);

    const qwen35 = buildSyntheticPiModel(
      'qwen3.5:0.8b',
      'openai',
      'openai',
      'http://localhost:11434/v1'
    );
    expect(qwen35.reasoning).toBe(true);

    const qwen3 = buildSyntheticPiModel(
      'qwen3:8b',
      'openai',
      'openai',
      'http://localhost:11434/v1'
    );
    expect(qwen3.reasoning).toBe(true);

    const reasoner = buildSyntheticPiModel('o3-reasoner', 'openai', 'openai');
    expect(reasoner.reasoning).toBe(true);

    // Non-reasoning models should default to false
    const gpt = buildSyntheticPiModel('gpt-5.4', 'openai', 'openai');
    expect(gpt.reasoning).toBe(false);

    const llama = buildSyntheticPiModel('llama-4-scout', 'meta', 'openai');
    expect(llama.reasoning).toBe(false);
  });

  it('allows explicit reasoning override in buildSyntheticPiModel', () => {
    // Force reasoning=true on a model that wouldn't auto-detect
    const forced = buildSyntheticPiModel('custom-model', 'custom', 'openai', '', undefined, true);
    expect(forced.reasoning).toBe(true);

    // Force reasoning=false on a model that would auto-detect
    const suppressed = buildSyntheticPiModel(
      'kimi-k2.5',
      'moonshot',
      'openai',
      '',
      undefined,
      false
    );
    expect(suppressed.reasoning).toBe(false);
  });

  it('does not false-positive on models with thinking as a substring', () => {
    // "critical-thinking-v2" should NOT match — \bthinking\b requires word boundary,
    // but here "thinking" IS a whole word between hyphens, so it WILL match.
    // This is intentional — hyphens are not \w so \b fires.
    const critical = buildSyntheticPiModel('critical-thinking-v2', 'custom', 'openai');
    expect(critical.reasoning).toBe(true);

    // But a model like "rethinkingai" should NOT match — no word boundary around "thinking"
    const rethinking = buildSyntheticPiModel('rethinkingai', 'custom', 'openai');
    expect(rethinking.reasoning).toBe(false);
  });

  it('disables developer role for ollama with custom endpoint', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'qwen3:8b',
        name: 'qwen3:8b',
        api: 'openai-completions',
        provider: 'ollama',
        baseUrl: '',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 40960,
        maxTokens: 8192,
      },
      {
        configProvider: 'ollama',
        rawProvider: 'ollama',
        customBaseUrl: 'http://localhost:11434/v1',
      }
    );

    expect(model.baseUrl).toBe('http://localhost:11434/v1');
    expect(model.compat?.supportsDeveloperRole).toBe(false);
  });

  it('maps ollama thinking off to reasoning_effort none for reasoning models', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'qwen3.5:0.8b',
        name: 'qwen3.5:0.8b',
        api: 'openai-completions',
        provider: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 258048,
        maxTokens: 32768,
      },
      {
        configProvider: 'openai',
        rawProvider: 'ollama',
        customBaseUrl: 'http://localhost:11434/v1',
      }
    );

    expect(model.compat?.supportsReasoningEffort).toBe(true);
    expect((model.compat?.reasoningEffortMap as Record<string, string> | undefined)?.off).toBe(
      'none'
    );
  });

  it('disables developer role for openrouter with custom endpoint', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'anthropic/claude-sonnet-4-6',
        name: 'claude-sonnet-4-6',
        api: 'openai-completions',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        configProvider: 'openrouter',
        rawProvider: 'openrouter',
        customBaseUrl: 'https://openrouter.ai/api/v1',
      }
    );

    expect(model.compat?.supportsDeveloperRole).toBe(false);
  });

  it('disables supportsStore alongside developer role for non-standard endpoints', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'kimi-k2.5',
        name: 'kimi-k2.5',
        api: 'openai-completions',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        configProvider: 'openai',
        rawProvider: 'openai',
        customBaseUrl: 'https://api.moonshot.cn/v1',
      }
    );

    expect(model.compat?.supportsDeveloperRole).toBe(false);
    expect(model.compat?.supportsStore).toBe(false);
  });

  it('preserves existing compat fields when disabling developer role', () => {
    const model = applyPiModelRuntimeOverrides(
      {
        id: 'custom-model',
        name: 'custom-model',
        api: 'openai-completions',
        provider: 'custom',
        baseUrl: '',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        compat: { supportsStreaming: true } as Record<string, unknown>,
      } as Parameters<typeof applyPiModelRuntimeOverrides>[0],
      {
        configProvider: 'custom',
        rawProvider: 'custom',
        customBaseUrl: 'https://my-relay.example.com/v1',
      }
    );

    expect(model.compat?.supportsDeveloperRole).toBe(false);
    expect(model.compat?.supportsStore).toBe(false);
    expect((model.compat as Record<string, unknown>)?.supportsStreaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P2 — catalog-aware routing tests (§8.3)
// ---------------------------------------------------------------------------

describe('P2 catalog-aware routing', () => {
  // Restore catalog mock to null after each test so tests are isolated
  afterEach(() => {
    mockGetCachedCatalog.mockReset();
    mockGetCachedCatalog.mockReturnValue(null);
  });

  // -- resolvePiRouteProtocol with catalog ----------------------------------

  it('returns openai for zai when catalog is available', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    expect(resolvePiRouteProtocol('zai')).toBe('openai');
  });

  it('returns anthropic for kimi-coding when catalog is available', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    expect(resolvePiRouteProtocol('kimi-coding')).toBe('anthropic');
  });

  it('returns openai default for known native providers when catalog is not yet ready (null)', () => {
    mockGetCachedCatalog.mockReturnValue(null);
    // Cold-start fallback for known native provider: zai has no routeProtocol
    // override in NATIVE_PROVIDER_META, so defaults to 'openai'.
    expect(resolvePiRouteProtocol('zai')).toBe('openai');
  });

  it('returns the raw provider id for unknown/non-native providers when catalog is null (legacy)', () => {
    mockGetCachedCatalog.mockReturnValue(null);
    // 'totally-unknown-provider' is not in NATIVE_PROVIDER_IDS — legacy fallback
    // must preserve the provider id string, not force 'openai'.
    expect(resolvePiRouteProtocol('totally-unknown-provider')).toBe('totally-unknown-provider');
  });

  it('returns the provider id string for unknown providers not in catalog', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    // 'groq' is not in MOCK_CATALOG — falls through to the legacy return
    expect(resolvePiRouteProtocol('groq')).toBe('groq');
  });

  it('does not consult catalog for the 5 hard-coded builtin providers', () => {
    // Catalog mock should never be reached for these
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    expect(resolvePiRouteProtocol('custom', 'openai')).toBe('openai');
    expect(resolvePiRouteProtocol('ollama')).toBe('openai');
    expect(resolvePiRouteProtocol('openai')).toBe('openai');
    expect(resolvePiRouteProtocol('openrouter')).toBe('openai');
    expect(resolvePiRouteProtocol('gemini')).toBe('gemini');
    // Catalog mock must not have been called for these builtin fast paths
    // (they return before the catalog lookup branch)
    expect(mockGetCachedCatalog).not.toHaveBeenCalled();
  });

  // -- buildPiModelLookupCandidates with catalog ----------------------------

  it('places native piProvider candidate first for a native raw provider (bare model id)', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    const candidates = buildPiModelLookupCandidates('glm-5', {
      configProvider: 'openai',
      rawProvider: 'zai',
    });
    // zai/glm-5 must be first
    expect(candidates[0]).toEqual({ provider: 'zai', model: 'glm-5' });
  });

  it('places native piProvider candidate first for a native raw provider (prefixed model id)', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    const candidates = buildPiModelLookupCandidates('zai/glm-5', {
      configProvider: 'openai',
      rawProvider: 'zai',
    });
    // zai/glm-5 (bare) must be first
    expect(candidates[0]).toEqual({ provider: 'zai', model: 'glm-5' });
  });

  it('does not duplicate the native candidate in the tail fallbacks', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    const candidates = buildPiModelLookupCandidates('glm-5', {
      configProvider: 'openai',
      rawProvider: 'zai',
    });
    const zaiEntries = candidates.filter((c) => c.provider === 'zai');
    expect(zaiEntries).toHaveLength(1);
  });

  it('falls back to legacy ordering when catalog is null', () => {
    mockGetCachedCatalog.mockReturnValue(null);
    const candidates = buildPiModelLookupCandidates('glm-5', {
      configProvider: 'openai',
      rawProvider: 'zai',
    });
    // No native-first insertion — legacy: keyProvider (openai) first
    expect(candidates[0]).toEqual({ provider: 'openai', model: 'glm-5' });
  });

  it('places kimi-coding candidate first for kimi-coding native raw provider', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    const candidates = buildPiModelLookupCandidates('kimi-k2.5', {
      configProvider: 'anthropic',
      rawProvider: 'kimi-coding',
    });
    expect(candidates[0]).toEqual({ provider: 'kimi-coding', model: 'kimi-k2.5' });
  });

  it('does not inject a native candidate when model is prefixed with a different provider', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    const candidates = buildPiModelLookupCandidates('openai/gpt-4', {
      configProvider: 'openai',
      rawProvider: 'zai',
    });
    // Intentional behavior change from legacy: the rawProvider ('zai') candidate
    // is also suppressed when a native entry owns that rawProvider slot and the
    // model has a mismatched prefix. Adding {provider:'zai', model:'openai/gpt-4'}
    // would be a malformed candidate that can never match the registry and could
    // resolve to a wrong model via synthetic fallback. This is the desired outcome.
    const zaiEntries = candidates.filter((c) => c.provider === 'zai');
    expect(zaiEntries).toHaveLength(0);
    // Standard parsed-provider candidates must still be present
    expect(candidates).toContainEqual({ provider: 'openai', model: 'gpt-4' });
  });

  it('does not inject a native candidate for non-native providers (openrouter)', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    const candidates = buildPiModelLookupCandidates('anthropic/claude-sonnet-4-6', {
      configProvider: 'anthropic',
      rawProvider: 'openrouter',
    });
    // openrouter is not in MOCK_CATALOG as a native entry — no special injection
    expect(candidates[0]).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6' });
  });

  it('existing builtin candidate behavior is preserved when catalog is populated', () => {
    mockGetCachedCatalog.mockReturnValue(MOCK_CATALOG);
    // Existing test case: custom raw provider — must behave identically
    const candidates = buildPiModelLookupCandidates('openai/gpt-5.4', {
      configProvider: 'openai',
      rawProvider: 'custom',
    });
    expect(candidates).toEqual([
      { provider: 'openai', model: 'gpt-5.4' },
      { provider: 'anthropic', model: 'gpt-5.4' },
      { provider: 'google', model: 'gpt-5.4' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveRuntimeApiKeyProviders — pure helper unit tests (MEDIUM 2 / §8.3)
// ---------------------------------------------------------------------------

describe('resolveRuntimeApiKeyProviders', () => {
  it('returns only piProvider for a well-formed native entry (piProvider === piModelProvider)', () => {
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'zai',
      piProvider: 'zai',
      piModelProvider: 'zai',
    });
    expect(keys).toEqual(['zai']);
  });

  it('returns only piProvider for an unknown provider not in catalog', () => {
    // Unknown provider — must not set secondary key (no aggregator path)
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'some-unknown-provider',
      piProvider: 'some-unknown-provider',
      piModelProvider: 'openai',
    });
    expect(keys).toEqual(['some-unknown-provider']);
  });

  it('returns both keys for openrouter (aggregator path)', () => {
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'openrouter',
      piProvider: 'openrouter',
      piModelProvider: 'google',
    });
    expect(keys).toEqual(['openrouter', 'google']);
  });

  it('returns both keys for custom provider with explicit protocol', () => {
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'custom',
      customProtocol: 'openai',
      piProvider: 'openai',
      piModelProvider: 'anthropic',
    });
    expect(keys).toEqual(['openai', 'anthropic']);
  });

  it('returns only piProvider for custom provider without protocol (no relay path)', () => {
    // Mirrors the actual agent-runner call site: when customProtocol is undefined,
    // piProvider is set to 'anthropic' (customProtocol || 'anthropic'), not 'custom'.
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'custom',
      customProtocol: undefined,
      piProvider: 'anthropic',
      piModelProvider: 'openai',
    });
    expect(keys).toEqual(['anthropic']);
  });

  it('returns only piProvider on cold-start when provider is native (not aggregator)', () => {
    // Security: cold-start (catalog not yet resolved) is NOT a reason to add
    // a secondary key. A native provider key must not be stored under an
    // unintended provider id (e.g. 'openai'), which could cause credential
    // leakage. Native v1 providers have id === piProvider so the primary key
    // is sufficient; the secondary write would only create a cross-provider leak.
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'zai',
      piProvider: 'zai',
      piModelProvider: 'openai', // SDK resolved to a different top-level provider
    });
    expect(keys).toEqual(['zai']); // must NOT include 'openai'
  });

  it('returns single key when piProvider equals piModelProvider (no-op case)', () => {
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'anthropic',
      piProvider: 'anthropic',
      piModelProvider: 'anthropic',
    });
    expect(keys).toEqual(['anthropic']);
  });

  it('returns single key for native provider (piProvider === piModelProvider)', () => {
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'deepseek',
      piProvider: 'deepseek',
      piModelProvider: 'deepseek',
    });
    expect(keys).toEqual(['deepseek']);
  });

  it('returns only piProvider for builtin provider with different piModelProvider and no aggregator', () => {
    // e.g. anthropic provider resolving a model whose SDK provider is 'openai' —
    // must not store under 'openai' (would overwrite unrelated key)
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'anthropic',
      piProvider: 'anthropic',
      piModelProvider: 'openai',
    });
    expect(keys).toEqual(['anthropic']);
  });

  it('returns both keys for gemini provider with google piModelProvider (alias path)', () => {
    // pi-ai uses 'google' as the registry provider key for Gemini models.
    // The config provider is 'gemini' but pi-ai looks up 'google' for auth,
    // so both must be stored to prevent auth regressions.
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'gemini',
      piProvider: 'gemini',
      piModelProvider: 'google',
    });
    expect(keys).toEqual(['gemini', 'google']);
  });

  it('returns only piProvider for gemini when piModelProvider is not google', () => {
    // If the model resolves under a different provider, do not store under it
    const keys = resolveRuntimeApiKeyProviders({
      provider: 'gemini',
      piProvider: 'gemini',
      piModelProvider: 'openai',
    });
    expect(keys).toEqual(['gemini']);
  });
});
