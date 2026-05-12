/**
 * @module main/config/openrouter-api
 *
 * Fetches model metadata (context window, max output tokens) from the
 * OpenRouter public models API. No authentication required.
 *
 * The full models list is cached in memory with a TTL to avoid repeated
 * network calls on every query within the same session.
 */

import { log, logWarn } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenRouterModelInfo {
  contextWindow: number | undefined;
  maxTokens: number | undefined;
}

interface OpenRouterModelEntry {
  id: string;
  context_length?: number;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Cache keyed by normalized baseUrl to prevent cross-endpoint contamination. */
const modelsCacheByBaseUrl = new Map<
  string,
  { entries: Map<string, OpenRouterModelEntry>; expiresAt: number }
>();

/** In-flight fetch deduplication: concurrent calls for the same baseUrl share one Promise. */
const inflight = new Map<string, Promise<Map<string, OpenRouterModelEntry>>>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchModelsList(baseUrl: string): Promise<Map<string, OpenRouterModelEntry>> {
  const url = `${baseUrl}/models`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter /models returned ${response.status}`);
  }

  const json = (await response.json()) as { data?: OpenRouterModelEntry[] };
  const entries = new Map<string, OpenRouterModelEntry>();

  const models = json.data ?? [];
  for (const model of models) {
    if (model.id) {
      entries.set(model.id, model);
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch model info from the OpenRouter public models endpoint.
 *
 * Returns contextWindow and maxTokens for the given model ID, or undefined
 * values if the model is not found or the API call fails.
 *
 * Results are cached for 10 minutes to avoid repeated network calls.
 */
export async function fetchOpenRouterModelInfo(input: {
  modelId: string;
  baseUrl?: string;
}): Promise<OpenRouterModelInfo> {
  const baseUrl = (input.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const now = Date.now();

  // Return from cache if fresh (keyed by baseUrl)
  const cached = modelsCacheByBaseUrl.get(baseUrl);
  if (cached && cached.expiresAt > now) {
    const entry = cached.entries.get(input.modelId);
    if (entry) {
      return extractModelInfo(entry);
    }
    // Model not in cache — might be newly added, but don't re-fetch within TTL
    return { contextWindow: undefined, maxTokens: undefined };
  }

  // Fetch fresh models list (with in-flight deduplication)
  try {
    let fetchPromise = inflight.get(baseUrl);
    if (!fetchPromise) {
      fetchPromise = fetchModelsList(baseUrl).finally(() => {
        inflight.delete(baseUrl);
      });
      inflight.set(baseUrl, fetchPromise);
    }

    const entries = await fetchPromise;
    modelsCacheByBaseUrl.set(baseUrl, { entries, expiresAt: now + MODELS_CACHE_TTL_MS });
    log(
      '[openrouter-api] Models list fetched:',
      entries.size,
      'models cached for',
      MODELS_CACHE_TTL_MS / 1000,
      's (baseUrl:',
      baseUrl,
      ')'
    );

    const entry = entries.get(input.modelId);
    if (entry) {
      return extractModelInfo(entry);
    }

    logWarn('[openrouter-api] Model not found in OpenRouter models list:', input.modelId);
    return { contextWindow: undefined, maxTokens: undefined };
  } catch (err) {
    logWarn('[openrouter-api] Failed to fetch models list:', err);
    return { contextWindow: undefined, maxTokens: undefined };
  }
}

function extractModelInfo(entry: OpenRouterModelEntry): OpenRouterModelInfo {
  const contextWindow = entry.context_length ?? entry.top_provider?.context_length ?? undefined;

  const maxTokens = entry.top_provider?.max_completion_tokens ?? undefined;

  return { contextWindow, maxTokens };
}

/**
 * Invalidate the cached models list. Clears all baseUrl caches.
 * Useful when the user changes OpenRouter configuration or wants to force a refresh.
 */
export function invalidateOpenRouterModelsCache(): void {
  modelsCacheByBaseUrl.clear();
  inflight.clear();
}
