import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
// `getModel` moved off the pi-ai root entrypoint to `/compat` in 0.80.0.
import {
  getModel,
  getModels,
  getSupportedThinkingLevels,
  clampThinkingLevel,
} from '@earendil-works/pi-ai/compat';
import { isOfficialOpenAIBaseUrl } from '../config/auth-utils';
import { log, logWarn } from '../utils/logger';
import { THINKING_LEVELS } from '../../shared/thinking-levels';
import { getCachedProviderCatalogSync } from '../config/provider-catalog-native';
import {
  getCatalogEntry,
  NATIVE_COLD_START_PROTOCOL,
  NATIVE_PROVIDER_IDS,
} from '../../shared/provider-catalog';

/**
 * Per-process dedup set for the native-provider/model-prefix mismatch warning.
 * Avoids log flooding when a misconfigured model string is used repeatedly.
 * Key: `${rawProvider}\0${parsedProvider}` — one warning per unique pair.
 * Capped at 100 entries to prevent unbounded memory growth in long-lived processes.
 */
const _loggedMismatchPairs = new Set<string>();
const _MISMATCH_LOG_CAP = 100;

/**
 * Centralized map of builtin config provider id -> pi-ai auth provider key
 * for cases where the two differ. Used by resolveRuntimeApiKeyProviders to
 * ensure auth keys are stored under the key pi-ai actually looks up.
 * Extend when new aliases are discovered via pi-ai SDK changes.
 */
export const PROVIDER_AUTH_ALIASES: Record<string, string> = {
  // gemini (OC config id) -> 'google' (pi-ai registry/auth key for all Gemini models)
  gemini: 'google',
};

const COMMON_FALLBACK_PROVIDERS = ['openai', 'anthropic', 'google'] as const;
const INVALID_REGISTRY_PROVIDERS = new Set(['', 'custom']);
const REASONING_MODEL_PATTERN =
  /\bthinking\b|\breasoner\b|deepseek-r1|kimi-k2|qwen3(?:\.5)?(?=[:/-]|$)/i;
type PiRegistryProvider = Parameters<typeof getModel>[0];

export interface PiModelStringInput {
  provider?: string;
  customProtocol?: string;
  model?: string;
  defaultModel?: string;
}

export interface PiModelLookupOptions {
  configProvider?: string;
  rawProvider?: string;
  customBaseUrl?: string;
  customProtocol?: string;
}

export interface PiModelLookupCandidate {
  provider: string;
  model: string;
}

export interface SyntheticPiModelFallbackInput {
  rawModel?: string;
  resolvedModelString: string;
  rawProvider?: string;
  routeProtocol: string;
  baseUrl?: string;
}

export interface SyntheticPiModelFallback {
  provider: string;
  modelId: string;
}

export function resolvePiRouteProtocol(provider?: string, customProtocol?: string): string {
  if (provider === 'custom') {
    if (customProtocol === 'openai' || customProtocol === 'gemini') {
      return customProtocol;
    }
    return 'anthropic';
  }
  if (provider === 'ollama') return 'openai';
  if (provider === 'openai') return 'openai';
  if (provider === 'openrouter') return 'openai';
  if (provider === 'gemini') return 'gemini';
  // Native provider — look up the catalog for the correct route protocol.
  // Cold-start fallback is only applied for known native provider ids (from
  // NATIVE_PROVIDER_IDS) to avoid changing legacy behavior for unknown providers.
  if (provider) {
    const catalog = getCachedProviderCatalogSync();
    if (catalog) {
      const entry = getCatalogEntry(catalog, provider);
      if (entry?.kind === 'native') return entry.routeProtocol;
    } else if (NATIVE_PROVIDER_IDS.has(provider)) {
      // Cold-start: catalog not yet resolved — use static fallback map for
      // known native providers so they get a valid protocol string rather
      // than their raw provider id. Unknown providers fall through to legacy.
      return NATIVE_COLD_START_PROTOCOL[provider] ?? 'openai';
    }
  }
  return provider || 'anthropic';
}

export interface NativeProviderInfo {
  /** pi-ai registry provider key (equals the catalog id for v1 natives) */
  piProvider: string;
  /** Route protocol derived from the catalog / cold-start map */
  routeProtocol: 'anthropic' | 'openai' | 'gemini';
  /** Registry base URL (from the resolved model, or the provider's first model) */
  baseUrl?: string;
}

/**
 * For a native catalog provider, resolve the registry-backed info the
 * diagnostics engine needs — base URL and route protocol — since native
 * providers carry no user-entered baseUrl (it lives in the pi-ai registry).
 *
 * Returns `undefined` for builtin/custom/unknown providers so callers keep
 * their existing behavior. Works both after the catalog has warmed (uses the
 * catalog entry's piProvider/routeProtocol) and during cold start (falls back
 * to NATIVE_PROVIDER_IDS + NATIVE_COLD_START_PROTOCOL; v1 natives have
 * id === piProvider).
 */
export function resolveNativeProviderInfo(
  provider: string,
  model?: string
): NativeProviderInfo | undefined {
  if (!provider || provider === 'custom') return undefined;

  const catalog = getCachedProviderCatalogSync();
  const entry = catalog ? getCatalogEntry(catalog, provider) : undefined;

  let piProvider: string | undefined;
  let routeProtocol: 'anthropic' | 'openai' | 'gemini' | undefined;
  if (entry?.kind === 'native') {
    piProvider = entry.piProvider;
    routeProtocol = entry.routeProtocol;
  } else if (NATIVE_PROVIDER_IDS.has(provider)) {
    piProvider = provider;
    routeProtocol = NATIVE_COLD_START_PROTOCOL[provider] ?? 'openai';
  }
  if (!piProvider || !routeProtocol) return undefined;

  // Resolve base URL from the registry. Prefer the specific model's baseUrl;
  // fall back to the provider's first model (all models for a native provider
  // share the same endpoint). Guard registry calls defensively.
  let baseUrl: string | undefined;
  const lookup = getModel as (p: string, m: string) => Model<Api> | undefined;
  const listModels = getModels as (p: string) => Model<Api>[] | undefined;
  try {
    if (model) baseUrl = lookup(piProvider, model)?.baseUrl || undefined;
    if (!baseUrl) baseUrl = listModels(piProvider)?.[0]?.baseUrl || undefined;
  } catch {
    // Registry lookup failed — leave baseUrl undefined; caller handles it.
  }

  return { piProvider, routeProtocol, baseUrl };
}

function shouldDisableDeveloperRoleForEndpoint(
  model: Model<Api>,
  options: PiModelLookupOptions
): boolean {
  if (model.api !== 'openai-completions' && model.api !== 'openai-responses') {
    return false;
  }

  const endpoint = options.customBaseUrl?.trim() || model.baseUrl?.trim();
  if (!endpoint || isOfficialOpenAIBaseUrl(endpoint)) {
    return false;
  }

  return true;
}

export function inferPiApi(protocol: string): string {
  switch (protocol) {
    case 'anthropic':
      return 'anthropic-messages';
    case 'gemini':
    case 'google':
      return 'google-generative-ai';
    case 'openai':
    default:
      return 'openai-completions';
  }
}

/**
 * Known context window / max output specs for common Ollama model families.
 * Used as a middle layer between user config overrides and the hardcoded default.
 *
 * NOTE on `maxTokens`: this value is reserved as the output budget on every
 * request and counts against the provider's context window. The values below
 * are *practical* caps, not the provider's theoretical maximum — e.g. GLM-4.x
 * allows 128K output but reserving 128K of a 200K window leaves almost no
 * room for input. Users who need longer outputs should override via the
 * profile UI (Settings → API → Max Tokens).
 */
const KNOWN_MODEL_SPECS: Record<string, { contextWindow: number; maxTokens: number }> = {
  'qwen3.5': { contextWindow: 258048, maxTokens: 32768 },
  qwen3: { contextWindow: 40960, maxTokens: 8192 },
  'qwen2.5': { contextWindow: 131072, maxTokens: 8192 },
  llama3: { contextWindow: 131072, maxTokens: 4096 },
  'llama3.1': { contextWindow: 131072, maxTokens: 4096 },
  'llama3.2': { contextWindow: 131072, maxTokens: 4096 },
  'llama3.3': { contextWindow: 131072, maxTokens: 4096 },
  'deepseek-r1': { contextWindow: 65536, maxTokens: 8192 },
  'deepseek-v3': { contextWindow: 65536, maxTokens: 8192 },
  gemma2: { contextWindow: 8192, maxTokens: 4096 },
  gemma3: { contextWindow: 131072, maxTokens: 8192 },
  phi3: { contextWindow: 131072, maxTokens: 4096 },
  phi4: { contextWindow: 16384, maxTokens: 4096 },
  mistral: { contextWindow: 32768, maxTokens: 4096 },
  mixtral: { contextWindow: 32768, maxTokens: 4096 },
  codellama: { contextWindow: 16384, maxTokens: 4096 },
  'command-r': { contextWindow: 131072, maxTokens: 4096 },
  // Chinese provider families (GLM/MiniMax/Kimi). Context windows reflect
  // provider-advertised limits; maxTokens is a safer practical cap — users can
  // override via profile UI when they genuinely need longer outputs.
  'glm-4.7': { contextWindow: 200000, maxTokens: 8192 },
  'glm-4.6': { contextWindow: 200000, maxTokens: 8192 },
  'glm-4.5': { contextWindow: 131072, maxTokens: 8192 },
  'glm-4': { contextWindow: 131072, maxTokens: 8192 },
  'minimax-m2': { contextWindow: 204800, maxTokens: 8192 },
  'minimax-m1': { contextWindow: 204800, maxTokens: 8192 },
  minimax: { contextWindow: 204800, maxTokens: 8192 },
  'kimi-k2': { contextWindow: 262144, maxTokens: 8192 },
  'kimi-k1': { contextWindow: 131072, maxTokens: 8192 },
  kimi: { contextWindow: 131072, maxTokens: 8192 },
  // Tencent Hunyuan family
  'hy3-preview': { contextWindow: 262144, maxTokens: 8192 },
  'hunyuan-a13b': { contextWindow: 131072, maxTokens: 8192 },
};

function lookupModelSpecs(
  modelId: string
): { contextWindow: number; maxTokens: number } | undefined {
  const lower = modelId.toLowerCase();
  // Strip provider prefix (e.g., "tencent/hy3-preview" → "hy3-preview") so
  // OpenRouter-style prefixed IDs still match KNOWN_MODEL_SPECS keys.
  const stripped = lower.includes('/') ? lower.split('/').slice(1).join('/') : lower;
  // Match by prefix: "qwen3.5:0.8b" → "qwen3.5", "deepseek-r1-distill" → "deepseek-r1"
  for (const [key, specs] of Object.entries(KNOWN_MODEL_SPECS)) {
    if (
      stripped === key ||
      stripped.startsWith(key + ':') ||
      stripped.startsWith(key + '-') ||
      lower === key ||
      lower.startsWith(key + ':') ||
      lower.startsWith(key + '-')
    ) {
      return specs;
    }
  }
  return undefined;
}

export function buildSyntheticPiModel(
  modelId: string,
  provider: string,
  protocol: string,
  baseUrl?: string,
  apiOverride?: string,
  reasoning?: boolean,
  contextWindow?: number,
  maxTokens?: number
): Model<Api> {
  const api = apiOverride || inferPiApi(protocol);
  const autoReasoning = reasoning ?? REASONING_MODEL_PATTERN.test(modelId);
  const knownSpecs = lookupModelSpecs(modelId);
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: baseUrl || '',
    reasoning: autoReasoning,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindow ?? knownSpecs?.contextWindow ?? 128000,
    maxTokens: maxTokens ?? knownSpecs?.maxTokens ?? 16384,
  } as Model<Api>;
}

export function resolveSyntheticPiModelFallback(
  input: SyntheticPiModelFallbackInput
): SyntheticPiModelFallback {
  const rawModel = input.rawModel?.trim() || '';
  const modelString = input.resolvedModelString.trim();
  const parts = modelString.split('/');
  const parsedProvider = parts.length >= 2 ? parts[0] : '';
  const strippedModelId = parts.length >= 2 ? parts.slice(1).join('/') : modelString;
  const baseUrl = input.baseUrl?.trim() || '';
  const preservesExplicitPrefixedId =
    rawModel.includes('/') &&
    (input.rawProvider === 'openrouter' ||
      input.rawProvider === 'custom' ||
      (input.rawProvider === 'openai' && !!baseUrl && !isOfficialOpenAIBaseUrl(baseUrl))) &&
    input.routeProtocol === 'openai';

  if (input.rawProvider === 'openrouter') {
    return {
      provider: 'openrouter',
      modelId: preservesExplicitPrefixedId ? modelString : strippedModelId,
    };
  }

  const fallbackProvider =
    input.rawProvider === 'custom' || input.rawProvider === 'ollama'
      ? input.routeProtocol || 'anthropic'
      : parsedProvider || input.rawProvider || input.routeProtocol || 'anthropic';

  return {
    provider: preservesExplicitPrefixedId ? parsedProvider || fallbackProvider : fallbackProvider,
    modelId: preservesExplicitPrefixedId ? modelString : strippedModelId,
  };
}

export function resolvePiModelString(input: PiModelStringInput): string {
  const model = input.model?.trim();
  if (!model) {
    return input.defaultModel || 'anthropic/claude-sonnet-4-6';
  }
  if (model.includes('/')) {
    return model;
  }
  const provider = input.provider || 'anthropic';
  // Native catalog providers (z.ai, MiniMax, …) must be prefixed with their
  // registry provider id so the model resolves to the native registry entry.
  // Their `customProtocol` is a routing hint (e.g. 'openai'), NOT a registry
  // provider id — prefixing with it yields 'openai/glm-5.2', which misses the
  // native entry and falls back to a synthetic OpenAI model pointed at
  // api.openai.com. The agent-runner avoids this by passing the bare model id;
  // this path (probe/diagnostics) builds the string here, so fix it at source.
  const nativeInfo = resolveNativeProviderInfo(provider);
  if (nativeInfo) {
    return `${nativeInfo.piProvider}/${model}`;
  }
  const protocol = input.customProtocol || provider;
  return `${protocol}/${model}`;
}

function addLookupCandidate(
  candidates: PiModelLookupCandidate[],
  seen: Set<string>,
  provider: string | undefined,
  model: string | undefined
): void {
  const normalizedProvider = provider?.trim() || '';
  const normalizedModel = model?.trim() || '';
  if (
    !normalizedProvider ||
    !normalizedModel ||
    INVALID_REGISTRY_PROVIDERS.has(normalizedProvider)
  ) {
    return;
  }

  const key = `${normalizedProvider}\u0000${normalizedModel}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push({ provider: normalizedProvider, model: normalizedModel });
}

export function buildPiModelLookupCandidates(
  modelString: string,
  options: Pick<PiModelLookupOptions, 'configProvider' | 'rawProvider'> = {}
): PiModelLookupCandidate[] {
  const keyProvider =
    options.configProvider === 'custom' ? 'anthropic' : options.configProvider || 'anthropic';
  const rawProvider = options.rawProvider?.trim() || '';
  const trimmedModel = modelString.trim();
  const parts = trimmedModel.split('/');
  const seen = new Set<string>();
  const candidates: PiModelLookupCandidate[] = [];

  // Track whether rawProvider was handled by the native injection block above.
  // When it was (or was deliberately skipped for mismatch), we must not add it
  // again in the generic tail — that would produce malformed candidates like
  // {provider:'zai', model:'openai/gpt-4'}.
  let nativeRawProviderHandled = false;

  // For native providers, unshift the registry lookup candidate first so the
  // native model (with correct compat quirks) takes precedence over generic
  // fallbacks. Only inject when the model string has no provider prefix, or
  // when the prefix already matches the native piProvider — injecting with a
  // mismatched prefix (e.g. model="openai/gpt-4" with rawProvider="zai")
  // would create an invalid candidate like {provider:"zai", model:"openai/gpt-4"}.
  if (rawProvider && !INVALID_REGISTRY_PROVIDERS.has(rawProvider)) {
    const catalog = getCachedProviderCatalogSync();
    if (catalog) {
      const entry = getCatalogEntry(catalog, rawProvider);
      if (entry?.kind === 'native') {
        // Mark as handled regardless of whether we inject — the native block
        // owns this rawProvider slot and the tail must not duplicate/corrupt it.
        nativeRawProviderHandled = true;
        const piProvider = entry.piProvider;
        if (parts.length < 2) {
          // Bare model id — inject directly
          addLookupCandidate(candidates, seen, piProvider, trimmedModel);
        } else if (parts[0] === piProvider) {
          // Prefix matches piProvider — strip and inject bare model id
          addLookupCandidate(candidates, seen, piProvider, parts.slice(1).join('/'));
        } else {
          // Prefix is a different provider — skip injection to avoid producing
          // a malformed candidate like {provider:'zai', model:'openai/gpt-4'}.
          // Log once per unique (rawProvider, parsedProvider) pair to surface
          // misconfigured model strings without flooding the log.
          const mismatchKey = `${rawProvider}\0${parts[0]}`;
          if (
            !_loggedMismatchPairs.has(mismatchKey) &&
            _loggedMismatchPairs.size < _MISMATCH_LOG_CAP
          ) {
            _loggedMismatchPairs.add(mismatchKey);
            log(
              `[PiModelResolution] Native rawProvider '${rawProvider}' ignored: ` +
                `model string '${trimmedModel}' is prefixed with a different provider ('${parts[0]}'). ` +
                `Resolving via parsed provider only.`
            );
          }
        }
      }
    }
  }

  if (parts.length >= 2) {
    const parsedProvider = parts[0];
    const parsedModelId = parts.slice(1).join('/');

    if (
      rawProvider &&
      rawProvider !== keyProvider &&
      rawProvider !== parsedProvider &&
      !nativeRawProviderHandled
    ) {
      addLookupCandidate(candidates, seen, rawProvider, trimmedModel);
    }
    if (keyProvider !== parsedProvider) {
      addLookupCandidate(candidates, seen, keyProvider, trimmedModel);
    }
    addLookupCandidate(candidates, seen, parsedProvider, parsedModelId);
    for (const fallbackProvider of COMMON_FALLBACK_PROVIDERS) {
      addLookupCandidate(candidates, seen, fallbackProvider, parsedModelId);
    }
    return candidates;
  }

  addLookupCandidate(candidates, seen, keyProvider, trimmedModel);
  for (const fallbackProvider of COMMON_FALLBACK_PROVIDERS) {
    addLookupCandidate(candidates, seen, fallbackProvider, trimmedModel);
  }
  return candidates;
}

export function applyPiModelRuntimeOverrides(
  model: Model<Api>,
  options: PiModelLookupOptions = {}
): Model<Api> {
  let nextModel = model;
  const isCustomProvider = options.rawProvider === 'custom' || options.configProvider === 'custom';
  const shouldHonorConfiguredBaseUrl = options.rawProvider === 'openai' || isCustomProvider;
  const modelHasBaseUrl = Boolean(nextModel.baseUrl);

  if (options.customBaseUrl && (shouldHonorConfiguredBaseUrl || !modelHasBaseUrl)) {
    nextModel = { ...nextModel, baseUrl: options.customBaseUrl } as typeof nextModel;
  }

  const effectiveProvider = options.rawProvider || options.configProvider;
  if (options.customBaseUrl && isCustomProvider && nextModel.api === 'openai-responses') {
    // Most custom OpenAI-compatible relays only implement chat/completions.
    nextModel = { ...nextModel, api: 'openai-completions' } as typeof nextModel;
  }
  if (effectiveProvider === 'openrouter' && nextModel.api !== 'openai-completions') {
    nextModel = { ...nextModel, api: 'openai-completions' } as typeof nextModel;
  }
  if (shouldDisableDeveloperRoleForEndpoint(nextModel, options)) {
    nextModel = {
      ...nextModel,
      compat: {
        ...(nextModel.compat || {}),
        supportsDeveloperRole: false,
        supportsStore: false,
      },
    } as typeof nextModel;
  }

  if (
    options.rawProvider === 'ollama' &&
    nextModel.reasoning &&
    nextModel.api === 'openai-completions'
  ) {
    const currentCompat = (nextModel.compat || {}) as Record<string, unknown>;
    const currentReasoningEffortMap = (
      currentCompat.reasoningEffortMap && typeof currentCompat.reasoningEffortMap === 'object'
        ? currentCompat.reasoningEffortMap
        : {}
    ) as Record<string, string>;
    nextModel = {
      ...nextModel,
      compat: {
        ...currentCompat,
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          ...currentReasoningEffortMap,
          off: 'none',
        },
      },
    } as typeof nextModel;
  }

  // Handle custom provider with explicit protocol override
  if (isCustomProvider && options.customProtocol) {
    const targetApi = inferPiApi(options.customProtocol);
    if (nextModel.api !== targetApi) {
      nextModel = { ...nextModel, api: targetApi } as typeof nextModel;
    }
  }

  return nextModel;
}

export function resolvePiRegistryModel(
  modelString: string,
  options: PiModelLookupOptions = {}
): Model<Api> | undefined {
  for (const candidate of buildPiModelLookupCandidates(modelString, options)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (getModel as (...args: unknown[]) => Model<Api> | undefined)(
      candidate.provider as PiRegistryProvider,
      candidate.model
    );
    if (model) {
      return applyPiModelRuntimeOverrides(model, options);
    }
  }
  return undefined;
}

export interface ThinkingCapabilities {
  supportsThinking: boolean;
  levels: ModelThinkingLevel[];
}

/**
 * Resolve a model string to a pi `Model`, falling back to a synthetic one for
 * models absent from the registry. Shared by the two thinking-level helpers so
 * both agree on which model they are describing.
 */
function resolveModelForThinking(modelString: string, options: PiModelLookupOptions): Model<Api> {
  const registryModel = resolvePiRegistryModel(modelString, options);
  if (registryModel) return registryModel;

  const synthProvider = options.rawProvider || options.configProvider || 'anthropic';
  const synthProtocol = resolvePiRouteProtocol(synthProvider, options.customProtocol);
  return buildSyntheticPiModel(modelString, synthProvider, synthProtocol, options.customBaseUrl);
}

/**
 * Thinking capabilities of an already-resolved pi `Model`.
 * Delegates entirely to pi-ai's `getSupportedThinkingLevels` — no per-model
 * tables are hardcoded here.
 *
 * `supportsThinking` is false when the model has no reasoning support *or* when
 * its `thinkingLevelMap` masks every non-off level (nothing left to choose).
 */
export function resolveThinkingCapabilitiesForModel(model: Model<Api>): ThinkingCapabilities {
  if (!model.reasoning) return { supportsThinking: false, levels: ['off'] };

  const supported = getSupportedThinkingLevels(model) as string[];
  // Re-order through THINKING_LEVELS so callers always get canonical order, and
  // drop anything a newer pi-ai adds that this build doesn't know about.
  const levels = (THINKING_LEVELS as readonly string[]).filter((level) =>
    supported.includes(level)
  ) as ModelThinkingLevel[];
  const nonOff = levels.filter((level) => level !== 'off');

  // 'off' is always offered so a stored non-off level can always be cleared.
  return { supportsThinking: nonOff.length > 0, levels: ['off', ...nonOff] };
}

/**
 * Clamp a stored thinking level to one an already-resolved model supports.
 * Delegates to pi-ai's `clampThinkingLevel` — handles the up/down/off search.
 *
 * Prefer this over {@link clampModelThinkingLevel} wherever the caller already
 * holds the `Model`: re-resolving from a model *string* can land on a different
 * model than the one actually in use.
 */
export function clampThinkingLevelForModel(
  model: Model<Api>,
  level: ModelThinkingLevel
): ModelThinkingLevel {
  // Short-circuit non-reasoning models — never return a non-off level.
  if (!model.reasoning) return 'off';
  try {
    const clamped = clampThinkingLevel(model, level) as string;
    return (THINKING_LEVELS as readonly string[]).includes(clamped)
      ? (clamped as ModelThinkingLevel)
      : 'off';
  } catch (err) {
    // Silent downgrade to 'off' looks like "the model stopped reasoning" with
    // nothing to grep for — always leave a trail.
    logWarn(
      '[pi-model-resolution] clampThinkingLevel failed for',
      model.provider,
      model.id,
      '— falling back to off:',
      err
    );
    return 'off';
  }
}

/**
 * Resolve the thinking levels supported by a given model string.
 * String-keyed entry point for callers without a resolved `Model` (e.g. the
 * Settings IPC handler).
 */
export function resolveThinkingCapabilities(
  modelString: string,
  options: PiModelLookupOptions = {}
): ThinkingCapabilities {
  try {
    return resolveThinkingCapabilitiesForModel(resolveModelForThinking(modelString, options));
  } catch (err) {
    logWarn(
      '[pi-model-resolution] resolveThinkingCapabilities failed for',
      modelString,
      '— reporting no thinking support:',
      err
    );
    return { supportsThinking: false, levels: ['off'] };
  }
}

/**
 * Clamp a stored thinking level against a model *string*.
 * Use {@link clampThinkingLevelForModel} instead when the resolved `Model` is
 * already in hand.
 */
export function clampModelThinkingLevel(
  modelString: string,
  level: ModelThinkingLevel,
  options: PiModelLookupOptions = {}
): ModelThinkingLevel {
  try {
    return clampThinkingLevelForModel(resolveModelForThinking(modelString, options), level);
  } catch (err) {
    logWarn(
      '[pi-model-resolution] clampModelThinkingLevel failed to resolve',
      modelString,
      '— falling back to off:',
      err
    );
    return 'off';
  }
}

/**
 * Compute the set of pi-ai provider keys under which an API key should be
 * stored in AuthStorage for a given agent run.
 *
 * Returns an array of provider key strings (deduplicated, length 1 or 2):
 * - Always includes `piProvider` (the primary resolved key).
 * - Conditionally includes `piModelProvider` (the SDK model's own provider)
 *   for explicitly known-safe secondary-key scenarios only:
 *   - openrouter: aggregator routes through underlying native providers
 *     (e.g. pi-ai looks up 'google' for gemini models served via openrouter)
 *   - custom with explicit protocol: relay routing where the protocol
 *     identifies the actual provider SDK path
 *
 * Cold-start (catalog not yet resolved) is intentionally NOT a reason to add
 * a secondary key — doing so risks storing a native-provider key under an
 * unintended provider id (e.g. 'openai') and causing credential leakage or
 * auth failures in multi-provider processes. Native providers in the v1
 * allowlist all have id === piProvider, so the primary key is sufficient.
 *
 * Secondary keys set for aggregator paths must be removed after the run
 * completes (see `secondaryRuntimeKeys` cleanup in agent-runner.ts `finally`)
 * to prevent them persisting into subsequent runs via shared AuthStorage.
 *
 * Exported as a pure helper so it can be unit-tested independently.
 */
export function resolveRuntimeApiKeyProviders({
  provider,
  customProtocol,
  piProvider,
  piModelProvider,
}: {
  provider: string;
  customProtocol?: string;
  piProvider: string;
  piModelProvider: string;
}): string[] {
  const keys: string[] = [piProvider];
  if (piModelProvider === piProvider) return [...new Set(keys)]; // no-op

  const isAggregatorPath = provider === 'openrouter' || (provider === 'custom' && !!customProtocol);

  // Known provider-alias mappings: some builtin providers store models under a
  // different pi-ai provider key than their config id. These are not aggregator
  // paths but require the secondary key for auth lookup to succeed.
  // Centralized here so routing and auth key storage share the same source of truth.
  // Extend when new aliases are discovered via pi-ai SDK changes.
  const isKnownAlias = piModelProvider === PROVIDER_AUTH_ALIASES[provider];

  if (isAggregatorPath || isKnownAlias) {
    keys.push(piModelProvider);
  }
  // Deduplicate explicitly to keep the length-1-or-2 contract even if
  // future callers pass identical piProvider/piModelProvider values.
  return [...new Set(keys)];
}
