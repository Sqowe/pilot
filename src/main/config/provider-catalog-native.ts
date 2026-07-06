/**
 * @module main/config/provider-catalog-native
 *
 * Builds the native half of the provider catalog from the pi-ai registry.
 * Imports @earendil-works/pi-ai/compat — main-process only, never bundled
 * into the renderer.
 *
 * Exported via IPC channel `config.getProviderCatalog` so the renderer
 * receives a plain serialisable array of ProviderCatalogEntry objects.
 *
 * Bundling note: pi-ai/compat is ESM-only. vite-plugin-electron externalises
 * all node_modules for the main-process bundle by default, so this dynamic
 * import resolves at runtime from node_modules rather than being inlined.
 * If the packaged build ever fails to load it, getFullProviderCatalog degrades
 * gracefully to the builtin-only catalog and logs a warning.
 */

import { log, logWarn } from '../utils/logger';
import {
  BUILTIN_ENTRIES,
  EXCLUDED_NATIVE,
  NATIVE_PROVIDER_META,
  NATIVE_SHAPE,
  apiToRouteProtocol,
  titleCase,
  type ProviderCatalogEntry,
  type ProviderModelOption,
} from '../../shared/provider-catalog';

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/**
 * Supports both sync and async implementations so tests can use plain arrays
 * while the real pi-ai/compat surface (which is currently sync but may become
 * async in a future SDK version) works without changes.
 */
export interface ProviderCatalogDeps {
  getProviders(): string[] | Promise<string[]>;
  getModels(
    provider: string
  ):
    | Array<{ id: string; name: string; api?: string }>
    | undefined
    | Promise<Array<{ id: string; name: string; api?: string }> | undefined>;
}

// ---------------------------------------------------------------------------
// Cache — promise-based to avoid duplicate concurrent builds.
// Only successful builds are memoised; failures clear the cache so the next
// call retries (handles transient startup timing / packaging glitches).
// ---------------------------------------------------------------------------

let cachedCatalogPromise: Promise<ProviderCatalogEntry[]> | null = null;
/** Synchronously-accessible resolved value — set when the promise settles. */
let resolvedCatalogSync: ProviderCatalogEntry[] | null = null;
/**
 * Monotonic generation counter. Incremented on every reset so an in-flight
 * promise that resolves after a reset does not overwrite the cleared state.
 */
let catalogGeneration = 0;

/** Reset the catalog cache. Tests only — do not call in production code. */
export function resetProviderCatalogCache(): void {
  cachedCatalogPromise = null;
  resolvedCatalogSync = null;
  catalogGeneration++;
}

/**
 * Synchronous read of the last successfully resolved catalog.
 * Returns null if the catalog has not yet been built (async still in-flight
 * or not yet requested). Safe to call from synchronous code paths like
 * resolvePiRouteProtocol — callers must handle null gracefully.
 */
export function getCachedProviderCatalogSync(): ProviderCatalogEntry[] | null {
  return resolvedCatalogSync;
}

// ---------------------------------------------------------------------------
// Protocol derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable routing protocol from a full model list.
 *
 * Strategy (deterministic, registry-order-independent):
 * 1. If NATIVE_PROVIDER_META has an explicit `routeProtocol` override, use it.
 * 2. Otherwise inspect ALL models:
 *    - If any model uses `anthropic-messages` → anthropic
 *    - Else if any model uses `google-*` → gemini
 *    - Else → openai (covers openai-completions, mistral-conversations, etc.)
 * 3. Warn when mixed API types are detected so future issues surface in logs.
 */
function deriveRouteProtocol(
  id: string,
  models: Array<{ api?: string }>,
  metaOverride?: 'anthropic' | 'openai' | 'gemini'
): 'anthropic' | 'openai' | 'gemini' {
  if (metaOverride) return metaOverride;
  if (models.length === 0) return 'openai';

  const apis = new Set(models.map((m) => m.api ?? 'openai-completions'));
  const protocols = new Set(Array.from(apis).map(apiToRouteProtocol));

  if (protocols.size > 1) {
    logWarn(
      `[ProviderCatalog] ${id} exposes mixed API types (${Array.from(apis).join(', ')}) — ` +
        `picking most specific protocol. Set routeProtocol in NATIVE_PROVIDER_META to override.`
    );
  }

  // Priority: anthropic > gemini > openai (most specific wins)
  if (protocols.has('anthropic')) return 'anthropic';
  if (protocols.has('gemini')) return 'gemini';
  return 'openai';
}

// ---------------------------------------------------------------------------
// Core builder (async, parallel model fetching)
// ---------------------------------------------------------------------------

/** Maximum number of concurrent getModels() calls during catalog construction. */
const MODEL_FETCH_CONCURRENCY = 8;

/**
 * Run an array of async tasks with bounded concurrency.
 * Preserves input order in the output array.
 */
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Build ProviderCatalogEntry objects for all native providers not in
 * EXCLUDED_NATIVE.
 *
 * - Accepts sync or async deps — `await Promise.resolve()` normalises both.
 * - Fetches providers' models with bounded concurrency (MODEL_FETCH_CONCURRENCY)
 *   to avoid unbounded parallel work as provider count grows.
 * - Per-provider getModels failures produce an entry with empty modelOptions
 *   rather than aborting the whole build.
 */
export async function buildNativeEntries(
  deps: ProviderCatalogDeps
): Promise<ProviderCatalogEntry[]> {
  // Let getProviders() errors propagate to the caller (_buildCatalog) so it
  // can clear the cache and retry on the next IPC call. Swallowing the error
  // here would produce a cached builtin-only result that locks out native
  // providers for the entire session after a transient startup failure.
  const allProviders = await Promise.resolve(deps.getProviders());

  // Deduplicate and filter falsy ids defensively
  const uniqueIds = Array.from(new Set(allProviders.filter(Boolean))).filter(
    (id) => !EXCLUDED_NATIVE.has(id)
  );

  // Fetch model lists with bounded concurrency to avoid a startup burst
  const tasks = uniqueIds.map(
    (id) =>
      async (): Promise<{ id: string; raw: Array<{ id: string; name: string; api?: string }> }> => {
        try {
          const raw = await Promise.resolve(deps.getModels(id));
          return { id, raw: raw ?? [] };
        } catch (err) {
          logWarn(`[ProviderCatalog] getModels(${id}) threw — using empty model list:`, err);
          return { id, raw: [] };
        }
      }
  );
  const modelResults = await runWithConcurrency(tasks, MODEL_FETCH_CONCURRENCY);

  return modelResults.map(({ id, raw }) => {
    // Sanitize: filter out entries with missing/non-string id or name, trim,
    // and deduplicate by model id so malformed registry data doesn't break UI.
    const seenModelIds = new Set<string>();
    const models: ProviderModelOption[] = [];
    for (const m of raw) {
      const mId = typeof m.id === 'string' ? m.id.trim() : '';
      const mName = typeof m.name === 'string' ? m.name.trim() : '';
      if (!mId || !mName || seenModelIds.has(mId)) continue;
      seenModelIds.add(mId);
      models.push({ id: mId, name: mName });
    }
    const meta = NATIVE_PROVIDER_META[id];
    const routeProtocol = deriveRouteProtocol(id, raw, meta?.routeProtocol);
    const name = meta?.name ?? titleCase(id);
    const category = meta?.category ?? 'inference';

    return {
      id,
      name,
      kind: 'native' as const,
      category,
      piProvider: id,
      routeProtocol,
      keyEnvVar: meta?.keyEnvVar,
      keyPlaceholder: meta?.keyPlaceholder,
      docsUrl: meta?.docsUrl,
      formShape: { ...NATIVE_SHAPE },
      featured: false,
      regionOf: meta?.regionOf,
      regionTag: meta?.regionTag,
      modelOptions: models,
    };
  });
}

// ---------------------------------------------------------------------------
// Full catalog (builtin + native), promise-memoised on success only
// ---------------------------------------------------------------------------

/**
 * Build the full provider catalog: BUILTIN_ENTRIES + native entries.
 * Uses injected deps (tests) or a dynamic pi-ai import (production).
 *
 * Memoisation strategy:
 * - Concurrent callers share the same in-flight Promise.
 * - Only successful builds are cached. If the import or build fails, the
 *   cache is cleared so the next IPC call will retry — avoiding a permanent
 *   builtin-only lock caused by transient startup failures.
 *
 * Call resetProviderCatalogCache() to force a fresh build (tests only).
 *
 * Note: BUILTIN_ENTRIES entries are treated as immutable constants.
 * Do not mutate entries returned from this function.
 */
export function getFullProviderCatalog(
  deps?: ProviderCatalogDeps
): Promise<ProviderCatalogEntry[]> {
  if (cachedCatalogPromise) return cachedCatalogPromise;

  // Capture generation at promise creation time so an in-flight build that
  // resolves after resetProviderCatalogCache() does not overwrite the cleared state.
  const buildGeneration = catalogGeneration;

  // Store the promise immediately so concurrent callers share it
  const promise = _buildCatalog(deps, () => {
    // Only clear the cache if this build is still the current one —
    // prevents a stale in-flight build from wiping a newer build's state.
    if (catalogGeneration === buildGeneration && cachedCatalogPromise === promise) {
      cachedCatalogPromise = null;
    }
  }).then(
    (catalog) => {
      // Only commit if this build is still the current generation
      if (catalogGeneration === buildGeneration) {
        resolvedCatalogSync = catalog;
      }
      return catalog;
    },
    (err) => {
      // Should never reach here (buildCatalog catches internally),
      // but clear cache defensively so next call retries.
      // Guard both mutations with generation + promise identity checks so a
      // stale in-flight rejection cannot corrupt a newer build's cache state.
      logWarn('[ProviderCatalog] Unexpected rejection from _buildCatalog:', err);
      if (catalogGeneration === buildGeneration && cachedCatalogPromise === promise) {
        cachedCatalogPromise = null;
        resolvedCatalogSync = [...BUILTIN_ENTRIES];
      }
      return [...BUILTIN_ENTRIES];
    }
  );

  cachedCatalogPromise = promise;
  return promise;
}

async function _buildCatalog(
  deps: ProviderCatalogDeps | undefined,
  clearCacheIfStale: () => void
): Promise<ProviderCatalogEntry[]> {
  // Yield to the microtask queue immediately so the caller (getFullProviderCatalog)
  // always completes `cachedCatalogPromise = promise` before any failure path
  // in this function can invoke clearCacheIfStale(). Without this, a synchronous
  // throw before the first real await would call clearCacheIfStale() while
  // cachedCatalogPromise is still null, making the identity check always false
  // and preventing proper retry behavior.
  await Promise.resolve();

  let resolvedDeps: ProviderCatalogDeps;

  if (deps) {
    resolvedDeps = deps;
  } else {
    try {
      // Dynamic import — ESM-only; vite-plugin-electron externalises node_modules
      // for the main bundle so this resolves at runtime, not at bundle time.
      const compat = (await import('@earendil-works/pi-ai/compat')) as {
        getProviders: () => string[];
        getModels: (
          provider: string
        ) => Array<{ id: string; name: string; api?: string }> | undefined;
      };
      log('[ProviderCatalog] pi-ai/compat imported successfully');
      resolvedDeps = {
        getProviders: compat.getProviders,
        getModels: compat.getModels,
      };
    } catch (err) {
      logWarn('[ProviderCatalog] Failed to import pi-ai/compat — using builtin-only catalog:', err);
      // Clear cache so next call retries the import (transient failure recovery)
      clearCacheIfStale();
      return [...BUILTIN_ENTRIES];
    }
  }

  try {
    const nativeEntries = await buildNativeEntries(resolvedDeps);
    // Shallow-clone builtin entries so main-process callers cannot accidentally
    // mutate the shared BUILTIN_ENTRIES constants.
    const clonedBuiltins = BUILTIN_ENTRIES.map((e) => ({
      ...e,
      formShape: { ...e.formShape },
      modelOptions: [...e.modelOptions],
    }));
    const catalog = [...clonedBuiltins, ...nativeEntries];
    log(
      `[ProviderCatalog] Built catalog: ${BUILTIN_ENTRIES.length} builtin + ${nativeEntries.length} native entries`
    );
    return catalog;
  } catch (err) {
    logWarn('[ProviderCatalog] Failed to build native entries — using builtin-only catalog:', err);
    // Clear cache so next call retries
    clearCacheIfStale();
    return [...BUILTIN_ENTRIES];
  }
}
