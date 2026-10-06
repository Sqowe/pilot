/**
 * Pure helpers shared by the API-settings state slices
 * (`useProviderCredentials`, `useModelSets`) and the layer that composes them
 * (`useApiConfigState`).
 *
 * No React, no IPC: everything here is a plain function, so it can be tested
 * directly and used from either slice without one importing the other.
 */
import type { useTranslation } from 'react-i18next';
import type {
  CustomProtocolType,
  ProviderModelInfo,
  ProviderPresets,
  ProviderProfileKey,
  ProviderType,
} from '../types';
import { isLoopbackBaseUrl } from '../../shared/network/loopback';
import { normalizeLegacyModelId } from '../../shared/legacy-model-id';
import { API_PROVIDER_PRESETS, type SharedProviderPreset } from '../../shared/api-model-presets';
import {
  getCatalogEntry,
  type ProviderCatalogEntry,
  type ProviderFormShape,
} from '../../shared/provider-catalog';
import {
  isValidProviderId,
  isValidProfileKey,
  deriveProfileKey,
  profileKeyToProviderInfo,
} from '../../shared/provider-ids';

export type Translate = ReturnType<typeof useTranslation>['t'];

export const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;
export const CONFIG_SET_LIMIT = 20;
/** Mirrors `MAX_CUSTOM_ENDPOINT_COUNT` in main, which enforces it. */
export const CUSTOM_ENDPOINT_LIMIT = 20;
export const DEFAULT_CONFIG_SET_ID = 'default';
export const DEFAULT_CONFIG_SET_NAME = 'Default';
export const FALLBACK_PROVIDER_PRESETS: ProviderPresets = API_PROVIDER_PRESETS;

const VALID_ROUTE_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini']);

/**
 * Validate and sanitize a single catalog entry returned via IPC.
 * Constructs a fresh typed object (never mutates the IPC input).
 * Returns null for entries that are structurally invalid or missing
 * security-sensitive fields so they are silently dropped before merge.
 *
 * Security posture:
 * - Missing or non-boolean `formShape.apiKey` defaults to `true` (key required).
 *   This ensures unknown/partial entries never accidentally grant allowEmptyApiKey.
 * - All other formShape booleans default to `false` when absent.
 * - `routeProtocol` must be one of the three known values; otherwise entry is dropped.
 */
export function sanitizeCatalogEntry(entry: unknown): ProviderCatalogEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;

  const id = typeof e.id === 'string' ? e.id.trim() : '';
  if (!id) return null;

  const kind = e.kind;
  if (kind !== 'builtin' && kind !== 'native' && kind !== 'custom') return null;

  const routeProtocol = e.routeProtocol;
  if (typeof routeProtocol !== 'string' || !VALID_ROUTE_PROTOCOLS.has(routeProtocol)) return null;

  // Build a fresh formShape — never reference the IPC object's formShape directly.
  // apiKey defaults to true (key required) to preserve security posture when absent.
  let formShape: ProviderFormShape | null = null;
  if (e.formShape !== null && e.formShape !== undefined) {
    if (typeof e.formShape !== 'object') return null;
    const fs = e.formShape as Record<string, unknown>;
    formShape = {
      apiKey: fs.apiKey === true || fs.apiKey !== false, // default true
      baseUrl: fs.baseUrl === true,
      protocol: fs.protocol === true,
      contextWindow: fs.contextWindow === true,
      modelDropdown: fs.modelDropdown === true,
      manualModelToggle: fs.manualModelToggle === true,
    };
  }

  // Validate modelOptions items: each must have string id and name.
  const rawModelOptions = Array.isArray(e.modelOptions) ? e.modelOptions : [];
  const modelOptions = rawModelOptions
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .filter((m) => typeof m.id === 'string' && m.id && typeof m.name === 'string')
    .map((m) => ({ id: (m.id as string).trim(), name: (m.name as string).trim() }))
    .filter((m) => m.id && m.name);

  return {
    id,
    name: typeof e.name === 'string' ? e.name : id,
    kind: kind as ProviderCatalogEntry['kind'],
    category: (typeof e.category === 'string'
      ? e.category
      : 'inference') as ProviderCatalogEntry['category'],
    piProvider: typeof e.piProvider === 'string' && e.piProvider ? e.piProvider : id,
    routeProtocol: routeProtocol as ProviderCatalogEntry['routeProtocol'],
    baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : undefined,
    keyEnvVar: typeof e.keyEnvVar === 'string' ? e.keyEnvVar : undefined,
    keyPlaceholder: typeof e.keyPlaceholder === 'string' ? e.keyPlaceholder : undefined,
    docsUrl: typeof e.docsUrl === 'string' ? e.docsUrl : undefined,
    formShape: formShape ?? {
      // Safe fallback: require API key, hide everything else
      apiKey: true,
      baseUrl: false,
      protocol: false,
      contextWindow: false,
      modelDropdown: false,
      manualModelToggle: false,
    },
    featured: e.featured === true,
    regionOf: typeof e.regionOf === 'string' ? e.regionOf : undefined,
    regionTag: typeof e.regionTag === 'string' ? e.regionTag : undefined,
    modelOptions,
  };
}

/**
 * Merge the IPC-delivered catalog with the local BUILTIN_ENTRIES.
 *
 * The IPC catalog is authoritative — its builtin entries carry
 * registry-enriched modelOptions. We dedup by id preserving IPC order (builtins
 * first, then natives), then append any local builtin the IPC omitted or that
 * failed sanitization, so all 6 builtins are always present even if the main
 * process returned a partial/degraded catalog.
 *
 * @internal Exported for unit testing only.
 */
export function mergeProviderCatalog(
  ipcEntries: ProviderCatalogEntry[],
  builtins: ProviderCatalogEntry[]
): ProviderCatalogEntry[] {
  const seen = new Set<string>();
  const deduped = ipcEntries.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  const missingBuiltins = builtins.filter((e) => !seen.has(e.id));
  return [...deduped, ...missingBuiltins];
}

/** @internal Exported for unit testing only. */

export function isProfileKey(value: unknown): value is ProviderProfileKey {
  return isValidProfileKey(value);
}

export function isProviderType(value: unknown): value is ProviderType {
  return isValidProviderId(value);
}

export function isCustomProtocol(value: unknown): value is CustomProtocolType {
  return value === 'anthropic' || value === 'openai' || value === 'gemini';
}

export function profileKeyFromProvider(
  provider: ProviderType,
  customProtocol: CustomProtocolType = 'anthropic'
): ProviderProfileKey {
  return deriveProfileKey(provider, customProtocol) as ProviderProfileKey;
}

export function profileKeyToProvider(profileKey: ProviderProfileKey): {
  provider: ProviderType;
  customProtocol: CustomProtocolType;
} {
  return profileKeyToProviderInfo(profileKey);
}

/** The protocol a provider routes through. `custom` takes it from its endpoint. */
export function protocolOf(
  provider: ProviderType,
  endpointProtocol: CustomProtocolType
): CustomProtocolType {
  return provider === 'custom'
    ? endpointProtocol
    : profileKeyToProvider(profileKeyFromProvider(provider)).customProtocol;
}

/**
 * Resolve the routing protocol for a provider, consulting the catalog entry
 * when available. Used by changeProvider and exposed for testing.
 */
export function resolveProviderProtocol(
  provider: ProviderType,
  catalog: ProviderCatalogEntry[],
  lastCustomProtocol: CustomProtocolType = 'anthropic'
): CustomProtocolType {
  const entry = getCatalogEntry(catalog, provider);
  const entryProtocol = entry?.kind === 'native' ? entry.routeProtocol : undefined;
  if (isCustomProtocol(entryProtocol)) return entryProtocol;
  if (provider === 'custom') return lastCustomProtocol;
  return 'anthropic';
}

export function isCustomAnthropicLoopbackGateway(baseUrl: string): boolean {
  return isLoopbackBaseUrl(baseUrl);
}

export function isCustomGeminiLoopbackGateway(baseUrl: string): boolean {
  return isLoopbackBaseUrl(baseUrl);
}

export function isCustomOpenAiLoopbackGateway(baseUrl: string): boolean {
  return isLoopbackBaseUrl(baseUrl);
}

export function isLegacyOllamaConfig(
  config:
    | { provider?: ProviderType; customProtocol?: CustomProtocolType; baseUrl?: string }
    | null
    | undefined
): boolean {
  if (!(config?.provider === 'custom' && config.customProtocol === 'openai')) {
    return false;
  }
  const baseUrl = config.baseUrl?.trim();
  if (!baseUrl || !isLoopbackBaseUrl(baseUrl)) {
    return false;
  }
  try {
    const parsed = new URL(baseUrl);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return port === '11434' && (!pathname || pathname === '/v1');
  } catch {
    return false;
  }
}

export const EMPTY_PRESET: SharedProviderPreset = {
  name: '',
  baseUrl: '',
  models: [],
  keyPlaceholder: '',
  keyHint: '',
};

export function modelPresetForProfile(
  profileKey: ProviderProfileKey,
  presets: ProviderPresets
): SharedProviderPreset | undefined {
  if (profileKey === 'ollama') return presets.ollama;
  if (profileKey === 'custom:openai') return presets.openai;
  if (profileKey === 'custom:gemini') return presets.gemini;
  if (profileKey === 'custom:anthropic') return presets.custom;
  // Builtin keys (openrouter, anthropic, openai, gemini)
  if (Object.prototype.hasOwnProperty.call(presets, profileKey)) {
    const builtin = (presets as unknown as Record<string, SharedProviderPreset | undefined>)[
      profileKey
    ];
    if (builtin) return builtin;
  }
  // Native keys (native:zai, etc.) have no preset — return undefined.
  // Callers must handle undefined for native providers.
  return undefined;
}

/**
 * Like modelPresetForProfile but always returns a non-null preset.
 * Uses EMPTY_PRESET for native providers that have no builtin preset entry.
 * Only use this where an empty baseUrl/models is safe (e.g. building UI defaults).
 * Do NOT use this when the baseUrl will be passed to URL() or a network client.
 */
export function modelPresetForProfileSafe(
  profileKey: ProviderProfileKey,
  presets: ProviderPresets
): SharedProviderPreset {
  return modelPresetForProfile(profileKey, presets) ?? EMPTY_PRESET;
}

export function normalizeDiscoveredOllamaModels(models: string[] | undefined): ProviderModelInfo[] {
  return (models || [])
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id }));
}

/**
 * Parse a token-limit form field (`contextWindow` / `maxTokens`) for the save
 * payload.
 *
 * Empty, non-numeric and non-positive input all mean "no override" and are sent
 * as `0`, never left out: IPC drops `undefined`, and the store reads an absent
 * key as "leave the stored limit unchanged" — so omitting the field would make
 * a cleared limit impossible to save. The store treats any non-positive number
 * as a clear.
 */
export function parseTokenLimitField(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The text of an error as main threw it.
 *
 * A handler that throws reaches the renderer as a new error whose message
 * Electron has put its own text in front of:
 * `Error invoking remote method '<channel>': Error: <message>`. Everything that
 * recognises a message has to look past that, or it never matches anything.
 */
export function stripIpcErrorPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}

/**
 * Turn an error from a config call into a message for the user.
 *
 * Main reports failures as English text. The ones a user can run into are
 * translated here; anything else is shown as main worded it, without Electron's
 * prefix.
 */
export function translateApiConfigErrorMessage(rawMessage: string, t: Translate): string {
  const message = stripIpcErrorPrefix(rawMessage);

  if (message === 'Config set name is required') {
    return t('api.configSetNameRequired');
  }
  if (message === 'Config set clone source not found') {
    return t('api.configSetCloneSourceMissing');
  }
  if (message === 'Config set not found') {
    return t('api.configSetMissing');
  }
  if (message === 'System config set cannot be deleted') {
    return t('api.configSetSystemDeleteForbidden');
  }
  if (message === 'At least one config set must be kept') {
    return t('api.configSetKeepOne');
  }

  const limitMatch = message.match(/^Config set limit reached: max\s+(\d+)$/);
  if (limitMatch) {
    return t('api.configSetLimitReached', { count: Number(limitMatch[1]) });
  }

  // Custom endpoints
  if (message === 'Endpoint base URL is required') {
    return t('api.providers.errors.baseUrlRequired');
  }
  if (message === 'An endpoint with this protocol and base URL already exists') {
    return t('api.providers.errors.duplicate');
  }
  if (message === 'Custom endpoint not found') {
    return t('api.providers.errors.notFound');
  }
  const endpointLimitMatch = message.match(/^Custom endpoint limit reached: max\s+(\d+)$/);
  if (endpointLimitMatch) {
    return t('api.providers.errors.limitReached', { count: Number(endpointLimitMatch[1]) });
  }
  const inUseMatch = message.match(/^Endpoint is in use by config set\(s\): (.+)$/);
  if (inUseMatch) {
    return t('api.providers.errors.inUse', { sets: inUseMatch[1] });
  }

  return message;
}

export function protocolLabel(protocol: CustomProtocolType, t: Translate): string {
  if (protocol === 'openai') {
    return t('api.guidance.protocolLabels.openai');
  }
  if (protocol === 'gemini') {
    return t('api.guidance.protocolLabels.gemini');
  }
  return t('api.guidance.protocolLabels.anthropic');
}

export function providerTabLabel(
  provider: ProviderType,
  presets: ProviderPresets,
  t: Translate
): string {
  if (provider === 'custom') {
    return t('api.custom');
  }
  return (
    (Object.prototype.hasOwnProperty.call(presets, provider)
      ? (presets as unknown as Record<string, { name?: string }>)[provider]
      : undefined
    )?.name || provider
  );
}

// ---------------------------------------------------------------------------
// Model selection, as the form holds it
// ---------------------------------------------------------------------------

/**
 * The model-related fields of the form. A model is either picked from a list
 * (`model`) or typed by hand (`customModel`), and `useCustomModel` says which
 * one counts. The two token limits are text because they are bound to inputs.
 */
export interface ModelFields {
  model: string;
  customModel: string;
  useCustomModel: boolean;
  contextWindow: string;
  maxTokens: string;
}

/**
 * The model id a set of form fields stands for — `''` when the user is typing
 * one by hand and has typed nothing.
 *
 * Deliberately no fallback from an empty typed model to the picked one: in
 * typed mode the picker is hidden, so falling back would save a model the user
 * cannot see.
 */
export function finalModelOf(
  fields: Pick<ModelFields, 'model' | 'customModel' | 'useCustomModel'>
): string {
  return fields.useCustomModel ? fields.customModel.trim() : fields.model;
}

// Applied when a stored model is loaded into the form, so the picker can find
// it in its list. Main applies the same rule to the sets it stores; the rule
// lives in `shared/` so the two cannot drift apart.
export { normalizeLegacyModelId };

/**
 * The preset list a provider's models are picked from. `custom` borrows the
 * list of the protocol it speaks; a native provider has none (its models come
 * from the catalog).
 */
export function modelPresetFor(
  provider: ProviderType,
  customProtocol: CustomProtocolType,
  presets: ProviderPresets
): SharedProviderPreset {
  return modelPresetForProfileSafe(profileKeyFromProvider(provider, customProtocol), presets);
}

/** The model fields a provider starts on before the user has chosen anything. */
export function defaultModelFields(
  provider: ProviderType,
  customProtocol: CustomProtocolType,
  presets: ProviderPresets,
  endpointDefaultModel?: string
): ModelFields {
  const preset = modelPresetFor(provider, customProtocol, presets);
  return {
    // Ollama's models are whatever the local server has; nothing to preselect.
    model: provider === 'ollama' ? '' : preset.models[0]?.id || '',
    // A custom endpoint serves whatever its owner configured, so the model is
    // typed by hand — pre-filled only when the endpoint itself names one.
    customModel: provider === 'custom' ? (endpointDefaultModel ?? '') : '',
    useCustomModel: provider === 'custom',
    contextWindow: '',
    maxTokens: '',
  };
}

/**
 * Split a stored model id into the form's picked / typed pair: picked when the
 * provider's preset list has it, typed otherwise.
 */
export function splitModelSelection(
  storedModel: string,
  provider: ProviderType,
  customProtocol: CustomProtocolType,
  presets: ProviderPresets
): Pick<ModelFields, 'model' | 'customModel' | 'useCustomModel'> {
  const defaults = defaultModelFields(provider, customProtocol, presets);
  const modelValue = normalizeLegacyModelId(provider, storedModel) || defaults.model;
  const hasPresetModel = modelPresetFor(provider, customProtocol, presets).models.some(
    (item) => item.id === modelValue
  );
  return {
    model: hasPresetModel ? modelValue : defaults.model,
    customModel: hasPresetModel ? '' : modelValue,
    useCustomModel: !hasPresetModel,
  };
}

/**
 * Forget a model that was picked from a server's discovered list.
 *
 * A picked model that is not a built-in one can only have come from the list of
 * the server the form was pointing at. Once the address changes that list is
 * gone, and so is any reason to think the new server has the model. A typed
 * model is the user's own statement and stays; so does a built-in one.
 */
export function withoutDiscoveredModel(
  fields: ModelFields,
  presetModels: ProviderModelInfo[]
): ModelFields {
  return !fields.useCustomModel &&
    fields.model &&
    !presetModels.some((item) => item.id === fields.model)
    ? { ...fields, model: '' }
    : fields;
}

/** Whether the form shows a base URL field for this provider. */
export function providerShowsBaseUrl(
  provider: ProviderType,
  formShape: ProviderFormShape | null
): boolean {
  return formShape != null ? formShape.baseUrl : provider === 'custom' || provider === 'ollama';
}

/** The catalog-driven form shape. Only native providers use it; builtins keep their literal checks. */
export function formShapeFor(
  catalog: ProviderCatalogEntry[],
  provider: ProviderType
): ProviderFormShape | null {
  const entry = getCatalogEntry(catalog, provider);
  return entry?.kind === 'native' ? (entry.formShape ?? null) : null;
}
