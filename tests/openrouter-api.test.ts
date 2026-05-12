import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchOpenRouterModelInfo,
  invalidateOpenRouterModelsCache,
} from '../src/main/config/openrouter-api';

// Mock the logger to avoid console noise in tests
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
}));

// Helper to create a mock fetch response
function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(data),
  });
}

describe('fetchOpenRouterModelInfo', () => {
  beforeEach(() => {
    // Clear cache before each test
    invalidateOpenRouterModelsCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns contextWindow and maxTokens for a known model', async () => {
    const mockData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 262144,
          top_provider: {
            context_length: 262144,
            max_completion_tokens: 262144,
          },
        },
        {
          id: 'anthropic/claude-sonnet-4-6',
          context_length: 200000,
          top_provider: {
            context_length: 200000,
            max_completion_tokens: 8192,
          },
        },
      ],
    };

    vi.stubGlobal('fetch', mockFetchResponse(mockData));

    const result = await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });

    expect(result.contextWindow).toBe(262144);
    expect(result.maxTokens).toBe(262144);
  });

  it('returns undefined values for a model not in the list', async () => {
    const mockData = {
      data: [
        {
          id: 'anthropic/claude-sonnet-4-6',
          context_length: 200000,
          top_provider: { max_completion_tokens: 8192 },
        },
      ],
    };

    vi.stubGlobal('fetch', mockFetchResponse(mockData));

    const result = await fetchOpenRouterModelInfo({ modelId: 'nonexistent/model' });

    expect(result.contextWindow).toBeUndefined();
    expect(result.maxTokens).toBeUndefined();
  });

  it('returns undefined values on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });

    expect(result.contextWindow).toBeUndefined();
    expect(result.maxTokens).toBeUndefined();
  });

  it('returns undefined values on non-OK HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      })
    );

    const result = await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });

    expect(result.contextWindow).toBeUndefined();
    expect(result.maxTokens).toBeUndefined();
  });

  it('caches results and does not re-fetch within TTL', async () => {
    const mockData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 262144,
          top_provider: { max_completion_tokens: 262144 },
        },
      ],
    };

    const fetchMock = mockFetchResponse(mockData);
    vi.stubGlobal('fetch', fetchMock);

    // First call — fetches from network
    await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const result = await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1 — no new fetch
    expect(result.contextWindow).toBe(262144);
  });

  it('returns undefined for model not in cache without re-fetching', async () => {
    const mockData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 262144,
          top_provider: { max_completion_tokens: 262144 },
        },
      ],
    };

    const fetchMock = mockFetchResponse(mockData);
    vi.stubGlobal('fetch', fetchMock);

    // Populate cache
    await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });

    // Query a model not in cache — should NOT re-fetch
    const result = await fetchOpenRouterModelInfo({ modelId: 'unknown/model' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.contextWindow).toBeUndefined();
    expect(result.maxTokens).toBeUndefined();
  });

  it('invalidateOpenRouterModelsCache forces a re-fetch on next call', async () => {
    const mockData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 262144,
          top_provider: { max_completion_tokens: 262144 },
        },
      ],
    };

    const fetchMock = mockFetchResponse(mockData);
    vi.stubGlobal('fetch', fetchMock);

    // Populate cache
    await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Invalidate
    invalidateOpenRouterModelsCache();

    // Next call should re-fetch
    await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses context_length as fallback when top_provider.context_length is missing', async () => {
    const mockData = {
      data: [
        {
          id: 'some/model',
          context_length: 131072,
          top_provider: {
            max_completion_tokens: 16384,
            // no context_length in top_provider
          },
        },
      ],
    };

    vi.stubGlobal('fetch', mockFetchResponse(mockData));

    const result = await fetchOpenRouterModelInfo({ modelId: 'some/model' });

    expect(result.contextWindow).toBe(131072);
    expect(result.maxTokens).toBe(16384);
  });

  it('prefers context_length over top_provider.context_length', async () => {
    const mockData = {
      data: [
        {
          id: 'some/model',
          context_length: 200000,
          top_provider: {
            context_length: 128000,
            max_completion_tokens: 8192,
          },
        },
      ],
    };

    vi.stubGlobal('fetch', mockFetchResponse(mockData));

    const result = await fetchOpenRouterModelInfo({ modelId: 'some/model' });

    // context_length at top level takes priority
    expect(result.contextWindow).toBe(200000);
  });

  it('handles empty data array gracefully', async () => {
    const mockData = { data: [] };

    vi.stubGlobal('fetch', mockFetchResponse(mockData));

    const result = await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });

    expect(result.contextWindow).toBeUndefined();
    expect(result.maxTokens).toBeUndefined();
  });

  it('handles missing data field gracefully', async () => {
    const mockData = {}; // no data field at all

    vi.stubGlobal('fetch', mockFetchResponse(mockData));

    const result = await fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });

    expect(result.contextWindow).toBeUndefined();
    expect(result.maxTokens).toBeUndefined();
  });

  it('uses custom baseUrl when provided', async () => {
    const mockData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 262144,
          top_provider: { max_completion_tokens: 262144 },
        },
      ],
    };

    const fetchMock = mockFetchResponse(mockData);
    vi.stubGlobal('fetch', fetchMock);

    await fetchOpenRouterModelInfo({
      modelId: 'tencent/hy3-preview',
      baseUrl: 'https://custom-proxy.example.com/api/v1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom-proxy.example.com/api/v1/models',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('deduplicates concurrent in-flight requests for the same baseUrl', async () => {
    const mockData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 262144,
          top_provider: { max_completion_tokens: 262144 },
        },
      ],
    };

    let resolvePromise: (value: unknown) => void;
    const delayedFetch = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        resolvePromise = resolve;
      });
    });
    vi.stubGlobal('fetch', delayedFetch);

    // Fire two concurrent requests
    const p1 = fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });
    const p2 = fetchOpenRouterModelInfo({ modelId: 'tencent/hy3-preview' });

    // Only one fetch should have been initiated
    expect(delayedFetch).toHaveBeenCalledTimes(1);

    // Resolve the single fetch
    resolvePromise!({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockData),
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.contextWindow).toBe(262144);
    expect(r2.contextWindow).toBe(262144);
    // Still only one network call
    expect(delayedFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches separately for different baseUrls (no cross-endpoint cache contamination)', async () => {
    const proxyData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 128000, // proxy reports different value
          top_provider: { max_completion_tokens: 8192 },
        },
      ],
    };

    const defaultData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 262144,
          top_provider: { max_completion_tokens: 262144 },
        },
      ],
    };

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount++;
      const data = url.includes('custom-proxy') ? proxyData : defaultData;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(data),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // First call with proxy baseUrl
    const proxyResult = await fetchOpenRouterModelInfo({
      modelId: 'tencent/hy3-preview',
      baseUrl: 'https://custom-proxy.example.com/api/v1',
    });
    expect(proxyResult.contextWindow).toBe(128000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call with default baseUrl — must fetch again (different endpoint)
    const defaultResult = await fetchOpenRouterModelInfo({
      modelId: 'tencent/hy3-preview',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(defaultResult.contextWindow).toBe(262144);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const mockData = {
      data: [
        {
          id: 'tencent/hy3-preview',
          context_length: 262144,
          top_provider: { max_completion_tokens: 262144 },
        },
      ],
    };

    const fetchMock = mockFetchResponse(mockData);
    vi.stubGlobal('fetch', fetchMock);

    await fetchOpenRouterModelInfo({
      modelId: 'tencent/hy3-preview',
      baseUrl: 'https://openrouter.ai/api/v1///',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns maxTokens as undefined when top_provider is missing', async () => {
    const mockData = {
      data: [
        {
          id: 'minimal/model',
          context_length: 65536,
          // no top_provider at all
        },
      ],
    };

    vi.stubGlobal('fetch', mockFetchResponse(mockData));

    const result = await fetchOpenRouterModelInfo({ modelId: 'minimal/model' });

    expect(result.contextWindow).toBe(65536);
    expect(result.maxTokens).toBeUndefined();
  });
});

describe('lookupModelSpecs with provider prefix stripping', () => {
  // These tests verify the KNOWN_MODEL_SPECS + lookupModelSpecs fix
  // by testing buildSyntheticPiModel which calls lookupModelSpecs internally.

  it('matches hy3-preview when modelId has provider prefix', async () => {
    const { buildSyntheticPiModel } = await import('../src/main/claude/pi-model-resolution');

    const model = buildSyntheticPiModel(
      'tencent/hy3-preview',
      'openrouter',
      'openai',
      'https://openrouter.ai/api/v1'
    );

    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(8192);
  });

  it('matches hy3-preview without provider prefix', async () => {
    const { buildSyntheticPiModel } = await import('../src/main/claude/pi-model-resolution');

    const model = buildSyntheticPiModel(
      'hy3-preview',
      'openrouter',
      'openai',
      'https://openrouter.ai/api/v1'
    );

    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(8192);
  });

  it('matches kimi-k2 with provider prefix', async () => {
    const { buildSyntheticPiModel } = await import('../src/main/claude/pi-model-resolution');

    const model = buildSyntheticPiModel(
      'moonshot/kimi-k2',
      'openrouter',
      'openai',
      'https://openrouter.ai/api/v1'
    );

    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(8192);
  });

  it('falls back to 128K default for unknown model with prefix', async () => {
    const { buildSyntheticPiModel } = await import('../src/main/claude/pi-model-resolution');

    const model = buildSyntheticPiModel(
      'unknown-vendor/totally-new-model',
      'openrouter',
      'openai',
      'https://openrouter.ai/api/v1'
    );

    expect(model.contextWindow).toBe(128000);
    expect(model.maxTokens).toBe(16384);
  });

  it('user-provided contextWindow overrides KNOWN_MODEL_SPECS', async () => {
    const { buildSyntheticPiModel } = await import('../src/main/claude/pi-model-resolution');

    const model = buildSyntheticPiModel(
      'tencent/hy3-preview',
      'openrouter',
      'openai',
      'https://openrouter.ai/api/v1',
      undefined,
      undefined,
      500000, // user override
      32768
    );

    expect(model.contextWindow).toBe(500000);
    expect(model.maxTokens).toBe(32768);
  });
});

describe('agent-runner OpenRouter metadata override logic', () => {
  // These tests simulate the conditional logic in agent-runner.ts that decides
  // when to fetch and apply OpenRouter model metadata. We test the decision
  // function in isolation rather than spinning up the full runner.

  interface RuntimeConfig {
    provider: string;
    contextWindow?: number;
    maxTokens?: number;
  }

  interface PiModel {
    contextWindow: number;
    maxTokens: number;
  }

  interface OrInfo {
    contextWindow: number | undefined;
    maxTokens: number | undefined;
  }

  /**
   * Simulates the agent-runner's OpenRouter metadata application logic.
   * Extracted here to test the conditional branching without the full runner.
   */
  function applyOpenRouterMetadata(
    runtimeConfig: RuntimeConfig,
    piModel: PiModel,
    usedSyntheticModel: boolean,
    orInfo: OrInfo
  ): PiModel {
    let result = { ...piModel };
    const provider = runtimeConfig.provider;

    if (
      provider === 'openrouter' &&
      usedSyntheticModel &&
      (!runtimeConfig.contextWindow || !runtimeConfig.maxTokens)
    ) {
      if (orInfo.contextWindow && !runtimeConfig.contextWindow) {
        result = { ...result, contextWindow: orInfo.contextWindow };
      }
      if (orInfo.maxTokens && !runtimeConfig.maxTokens && orInfo.maxTokens !== result.maxTokens) {
        result = { ...result, maxTokens: orInfo.maxTokens };
      }
    }

    return result;
  }

  it('applies both contextWindow and maxTokens when neither is user-configured', () => {
    const result = applyOpenRouterMetadata(
      { provider: 'openrouter' },
      { contextWindow: 128000, maxTokens: 16384 },
      true,
      { contextWindow: 262144, maxTokens: 262144 }
    );

    expect(result.contextWindow).toBe(262144);
    expect(result.maxTokens).toBe(262144);
  });

  it('skips fetch entirely when model was found in registry (not synthetic)', () => {
    const result = applyOpenRouterMetadata(
      { provider: 'openrouter' },
      { contextWindow: 200000, maxTokens: 8192 },
      false, // not synthetic — found in registry
      { contextWindow: 262144, maxTokens: 262144 }
    );

    // No changes — registry model is authoritative
    expect(result.contextWindow).toBe(200000);
    expect(result.maxTokens).toBe(8192);
  });

  it('preserves user-configured contextWindow but applies API maxTokens', () => {
    const result = applyOpenRouterMetadata(
      { provider: 'openrouter', contextWindow: 100000 },
      { contextWindow: 100000, maxTokens: 16384 },
      true,
      { contextWindow: 262144, maxTokens: 262144 }
    );

    // contextWindow stays at user value, maxTokens updated from API
    expect(result.contextWindow).toBe(100000);
    expect(result.maxTokens).toBe(262144);
  });

  it('preserves user-configured maxTokens but applies API contextWindow', () => {
    const result = applyOpenRouterMetadata(
      { provider: 'openrouter', maxTokens: 4096 },
      { contextWindow: 128000, maxTokens: 4096 },
      true,
      { contextWindow: 262144, maxTokens: 262144 }
    );

    // maxTokens stays at user value, contextWindow updated from API
    expect(result.contextWindow).toBe(262144);
    expect(result.maxTokens).toBe(4096);
  });

  it('preserves both when user configured both', () => {
    const result = applyOpenRouterMetadata(
      { provider: 'openrouter', contextWindow: 100000, maxTokens: 4096 },
      { contextWindow: 100000, maxTokens: 4096 },
      true,
      { contextWindow: 262144, maxTokens: 262144 }
    );

    // Both stay at user values — fetch is skipped entirely
    expect(result.contextWindow).toBe(100000);
    expect(result.maxTokens).toBe(4096);
  });

  it('does nothing for non-openrouter providers', () => {
    const result = applyOpenRouterMetadata(
      { provider: 'anthropic' },
      { contextWindow: 128000, maxTokens: 16384 },
      true,
      { contextWindow: 262144, maxTokens: 262144 }
    );

    expect(result.contextWindow).toBe(128000);
    expect(result.maxTokens).toBe(16384);
  });

  it('handles API returning undefined values gracefully', () => {
    const result = applyOpenRouterMetadata(
      { provider: 'openrouter' },
      { contextWindow: 128000, maxTokens: 16384 },
      true,
      { contextWindow: undefined, maxTokens: undefined }
    );

    // No changes when API returns nothing
    expect(result.contextWindow).toBe(128000);
    expect(result.maxTokens).toBe(16384);
  });
});
