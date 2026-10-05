/**
 * @module main/config/config-store
 *
 * Persistent application configuration (1373 lines).
 *
 * Responsibilities:
 * - electron-store backed config persistence (API keys, model presets, settings)
 * - Config set management: create, rename, delete, switch between config profiles
 * - API key validation and provider credential resolution
 * - Model preset definitions (Anthropic, OpenAI, Gemini, OpenRouter, Ollama)
 *
 * Dependencies: electron-store, auth-utils, api-model-presets
 */
import * as fs from 'fs';
import Store, { type Options as StoreOptions } from 'electron-store';
import { log, logWarn } from '../utils/logger';
import {
  createEncryptedStoreWithKeyRotation,
  getLegacyDerivedKeyHexes,
} from '../utils/store-encryption';
import {
  isOpenAIProvider,
  isOllamaLegacyCustomOpenAIConfig,
  normalizeAnthropicBaseUrl,
  normalizeOllamaBaseUrl,
  resolveOllamaCredentials,
  resolveOpenAICredentials,
  shouldAllowEmptyOllamaApiKey,
  shouldAllowEmptyAnthropicApiKey,
  shouldAllowEmptyGeminiApiKey,
  shouldUseAnthropicAuthToken,
} from './auth-utils';
import { API_PROVIDER_PRESETS, PI_AI_CURATED_PRESETS } from '../../shared/api-model-presets';
import {
  isValidSystemPromptFileChoice,
  normalizeSystemPromptPriority,
  DEFAULT_SYSTEM_PROMPT_PRIORITY,
  type SystemPromptFileChoice,
  type SystemPromptFileName,
} from '../../shared/system-prompt-file-choices';
import { sanitizeBashCommandList, sanitizeTrustedDirectories } from './permission-rules-store';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { THINKING_LEVELS } from '../../shared/thinking-levels';
import {
  normalizeProviderId,
  isValidProviderId,
  isValidProfileKey,
  isNativeProfileKey,
  deriveProfileKey,
  profileKeyToProviderInfo,
  BUILTIN_PROVIDER_ID_LIST,
} from '../../shared/provider-ids';
// Import normalizePermissionTimeout and DEFAULT_BASH_RESTRICTIONS_SETTINGS from the shared module.
// defaultConfig.permissionTimeoutSeconds is set to DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds
// below so the two values are guaranteed to stay in sync — there is no separate copy to drift.
import {
  normalizePermissionTimeout,
  DEFAULT_BASH_RESTRICTIONS_SETTINGS,
} from '../../shared/bash-restrictions';
import { isValidCatchUpPolicy, isValidConflictPolicy } from '../../shared/schedule/types';
import {
  createDefaultSkillConflictConfig,
  normalizeSkillConflictConfig,
} from '../../shared/skill-conflict-types';

/**
 * The 6 legacy builtin provider ids. Use for exhaustive switches over builtins.
 */
export type BuiltinProviderType =
  | 'openrouter'
  | 'anthropic'
  | 'custom'
  | 'openai'
  | 'gemini'
  | 'ollama';
/**
 * Open provider type — accepts any catalog id including native providers
 * (e.g. 'zai', 'minimax', 'deepseek') and the 6 legacy builtin ids.
 * Use BuiltinProviderType when you need exhaustive matching over the 6.
 */
export type ProviderType = string;
/**
 * Superset of ProviderType that additionally allows 'local' for the embedding sub-config only.
 * The 'local' value must never appear on the main LLM config or any ApiConfigSet provider field.
 */
export type EmbeddingProviderType = ProviderType | 'local';
export type CustomProtocolType = 'anthropic' | 'openai' | 'gemini';
export type AppTheme = 'dark' | 'light' | 'system';
/**
 * Builtin profile keys for the 6 legacy providers.
 */
export type BuiltinProfileKey =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'custom:anthropic'
  | 'custom:openai'
  | 'custom:gemini';
/**
 * Profile key — builtin slot or a native provider slot (`native:<piProvider>`).
 * Each native provider gets its own credential slot so switching between
 * providers preserves both saved keys.
 */
export type ProviderProfileKey = BuiltinProfileKey | `native:${string}`;
export type ConfigSetId = string;
export type CreateSetMode = 'blank' | 'clone';

export interface CreateConfigSetPayload {
  name: string;
  mode?: CreateSetMode;
  fromSetId?: string;
}

export interface ProviderProfile {
  apiKey: string;
  baseUrl?: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Credentials for one provider id — global, one slot per provider.
 *
 * Replaces the per-config-set `ProviderProfile` for the credential half of the
 * old shape: `model` / `contextWindow` / `maxTokens` are model selection and
 * live on `ApiConfigSet` instead. See
 * `docs/design/provider-credentials-and-model-sets.md` §3.1.
 */
export interface ProviderCredentials {
  apiKey: string;
  /** Endpoint override: ollama, or a native provider's own base URL. */
  baseUrl?: string;
}

/**
 * Keyed by the existing `ProviderProfileKey` space — one slot per provider id.
 * The slot space is unchanged; only its *owner* moves from the config set to
 * `AppConfig` (design §4).
 */
export type ProviderCredentialMap = Partial<Record<ProviderProfileKey, ProviderCredentials>>;

/**
 * A user-created custom endpoint — the only user-named credential object.
 *
 * Catalog providers need no such type: the catalog already names them, one
 * endpoint and normally one key each (design §2.1). Only `custom` lets the user
 * supply protocol *and* base URL, and legitimately run several at once
 * (kiro-gateway, LiteLLM, an internal gateway).
 */
export interface CustomEndpoint {
  /** Stable id, never renumbered once minted. */
  id: string;
  /** User-facing label; defaults to the base URL host on migration. */
  name: string;
  protocol: CustomProtocolType;
  baseUrl: string;
  apiKey: string;
  /**
   * Optional model to pre-fill when a set first points at this endpoint.
   *
   * `custom` is in `BUILTIN_NO_REGISTRY_MODELS`
   * (`provider-catalog-native.ts`), so it ships `modelOptions: []`, and unlike
   * `ollama` it has no Discover fallback. Without this, the first-run wizard's
   * model step is an empty picker for exactly the gateway users most likely to
   * reach it. Design decision #10.
   */
  defaultModel?: string;
  updatedAt: string;
}

export interface ApiConfigSet {
  id: ConfigSetId;
  name: string;
  isSystem?: boolean;
  provider: ProviderType;
  /**
   * Which `customEndpoints` entry supplies the credential. Set only when
   * `provider === 'custom'`; ignored otherwise. Design §3.3.
   */
  endpointId?: string;
  /**
   * Model selection, hoisted out of `profiles` — these describe the model, not
   * the credential (design §3.3). `model` is always present after normalization.
   */
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  /**
   * @deprecated Phase 2a: read-only legacy input. Normalization still reads
   * these to migrate pre-split configs and to keep the renderer compiling until
   * Phase 2b, but **no write path puts credentials back into a set**. Phase 2b
   * removes `profiles` and `activeProfileKey`; `customProtocol` survives on the
   * projection only, sourced from the resolved endpoint.
   */
  customProtocol: CustomProtocolType;
  /** @deprecated See `customProtocol`. Removed in Phase 2b. */
  activeProfileKey: ProviderProfileKey;
  /** @deprecated See `customProtocol`. Removed in Phase 2b. */
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;
  enableThinking: boolean;
  /** Replaces enableThinking. Always a valid ModelThinkingLevel after normalization. */
  thinkingLevel: ModelThinkingLevel;
  updatedAt: string;
}

export interface AppConfig {
  // API Provider
  provider: ProviderType;

  // API credentials
  apiKey: string;
  baseUrl?: string;
  customProtocol?: CustomProtocolType;

  // Model selection
  model: string;
  contextWindow?: number;
  maxTokens?: number;

  // Active profile
  activeProfileKey: ProviderProfileKey;
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;

  /**
   * Provider credentials — global, one slot per provider id.
   *
   * **Phase 2a: authoritative.** `resolveCredentials` reads this (or the
   * referenced `customEndpoints` entry) to build the runtime projection, and
   * `update({ apiKey, baseUrl })` writes here rather than into a config set.
   *
   * Still *populated by derivation* from the sets' legacy `profiles` on read, so
   * a pre-split config migrates without a schema bump (design §5). That input
   * disappears in Phase 2b once the renderer stops sending `profiles`; until
   * then `applyProfilesToCredentials` forwards a renderer-supplied profile map
   * here so a key typed in the old UI is not lost.
   *
   * Precedence matters: a profile edit must win over a previously derived value,
   * or rotating a key silently no-ops. See `deriveProviderCredentials`.
   */
  providerCredentials: ProviderCredentialMap;

  /**
   * User-created custom endpoints — the only user-named credential object.
   *
   * **Phase 2a: authoritative.** A `provider:'custom'` set resolves its
   * credential *and* routing protocol from the entry its `endpointId` names.
   * Entries created through the CRUD API have no legacy profile behind them and
   * are preserved as-is; entries that were derived from a `custom:*` profile are
   * pruned when that profile stops describing them, so editing a gateway URL
   * does not leave a stale twin.
   */
  customEndpoints: CustomEndpoint[];

  // Active config set
  activeConfigSetId: ConfigSetId;
  configSets: ApiConfigSet[];

  // Optional: Claude Code CLI path override
  claudeCodePath?: string;

  // Optional: Default working directory
  defaultWorkdir?: string;

  // Optional: Global skills storage directory
  globalSkillsPath?: string;

  // Optional: Local development PATH directories to prepend to system PATH.
  // Colon-separated (macOS/Linux) or semicolon-separated (Windows) list of directories.
  localDevPath?: string;

  /**
   * @deprecated Use `systemPromptFileEnabled` + `systemPromptFilePriority`.
   * Kept only for migration reading; not written after Phase 4.
   */
  systemPromptFile?: SystemPromptFileChoice;

  // Master on/off toggle for workspace-instructions auto-discovery.
  // Replaces the old '' = None sentinel in systemPromptFile.
  systemPromptFileEnabled: boolean;

  // Ordered list of candidate filenames; the first existing file wins.
  // Always a full permutation of DEFAULT_SYSTEM_PROMPT_PRIORITY after
  // normalisation. User may reorder but not add/remove entries.
  systemPromptFilePriority: SystemPromptFileName[];

  // Bash command trust list (prefix patterns with `*` wildcard).
  // Persisted here so the main process has them at startup, before the
  // renderer's IPC hydration races with the first tool call.
  bashTrustedCommands: string[];

  // Bash command denylist (substring patterns). Forces manual approval
  // even when a matching trust pattern exists.
  bashDenylist: string[];

  // Directories the agent may write to without being asked — visible bash
  // write targets and the write/edit tools. Entries are stored as written
  // (`./` is relative to each session's workspace). Empty = write checks off.
  // See docs/design/trusted-directories.md.
  trustedDirectories: string[];

  // Developer logs
  enableDevLogs: boolean;

  // UI theme preference
  theme: AppTheme;

  // Sandbox mode (WSL/Lima isolation)
  sandboxEnabled: boolean;

  // Global memory toggle
  memoryEnabled: boolean;

  // Dedicated memory runtime config
  memoryRuntime: MemoryRuntimeConfig;

  // Enable thinking mode (show thinking steps)
  enableThinking: boolean;
  /** Per-model thinking level. Always a valid ModelThinkingLevel after normalization.
   * Optional in AppConfig (storage) because it may be absent in old on-disk configs
   * — always present and required in ApiConfigSet after normalization. */
  thinkingLevel?: ModelThinkingLevel;

  // First run flag
  isConfigured: boolean;

  /**
   * Config schema version — used to distinguish a truly fresh install from an
   * existing install that was upgraded before this field existed.
   *
   * 0 = default (field absent from disk, or written before schema versioning).
   *     Treated as an existing install during migration.
   * 1 = migrated to systemPromptFileEnabled / systemPromptFilePriority.
   */
  configSchemaVersion: number;

  // Scheduler settings (v2)
  schedulerCatchUpPolicy: 'skip' | 'run-once' | 'run-all' | 'ask';
  schedulerConflictPolicy: 'queue' | 'skip-if-busy';
  schedulerRunHistoryDepth: number;

  // Permission dialog timeout in seconds.
  // 0 means infinite (no timeout — wait forever for user response).
  permissionTimeoutSeconds: number;

  // Default MCP tool execution timeout in seconds.
  // If an MCP tool does not respond within this time, the agent receives a
  // timeout error and can decide to retry or try a different approach.
  // Per-server overrides take precedence over this global default.
  // 0 means no timeout (wait indefinitely — not recommended).
  mcpToolTimeoutSeconds: number;

  // Native desktop notifications when the app is not focused.
  // Fires on permission requests and agent response completion.
  notificationsEnabled: boolean;

  // Skill conflict resolution config.
  // Controls how name collisions between custom and built-in skills are resolved,
  // which skills are disabled, and per-skill source overrides.
  skillConflictConfig: import('../../shared/skill-conflict-types').SkillConflictConfig;

  // Workspace orphan detection dismissals.
  // Tracks per-workspace dismissals so we don't re-notify until config files change.
  orphanDismissals: import('../../shared/workspace-orphan-types').WorkspaceOrphanDismissal[];

  // Optional HTTP proxy URL for all outbound API requests (e.g. http://proxy:8080).
  // Applied via applyConfigHttpProxy() in src/main/utils/http-proxy.ts at startup
  // and whenever the value changes. Empty string or undefined means no override
  // (shell/OS proxy env vars are inherited as-is).
  httpProxy?: string;
}

/** Shared fields for both LLM and embedding memory runtime sub-configs. */
export interface MemoryModelRuntimeConfigBase {
  inheritFromActive: boolean;
  customProtocol?: CustomProtocolType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
}

/** LLM sub-config: provider is always a ProviderType (never 'local'). */
export interface MemoryLLMRuntimeConfig extends MemoryModelRuntimeConfigBase {
  provider?: ProviderType;
}

/** Embedding sub-config: provider may be 'local' for in-process ONNX inference. */
export interface MemoryEmbeddingRuntimeConfig extends MemoryModelRuntimeConfigBase {
  provider?: EmbeddingProviderType;
}

/**
 * @deprecated Use MemoryLLMRuntimeConfig or MemoryEmbeddingRuntimeConfig directly.
 * Kept as a union alias so existing consumers that reference MemoryModelRuntimeConfig
 * continue to compile during the transition.
 */
export type MemoryModelRuntimeConfig = MemoryLLMRuntimeConfig | MemoryEmbeddingRuntimeConfig;

export interface MemoryRuntimeConfig {
  llm: MemoryLLMRuntimeConfig;
  embedding: MemoryEmbeddingRuntimeConfig;
  useEmbedding: boolean;
  maxNavSteps: number;
  ingestionConcurrency: number;
  storageRoot?: string;
  evalEnabled?: boolean;
  evalWorkspaces?: string[];
  evalMaxRounds?: number;
  evalArtifactsRoot?: string;
  promptIterationRounds?: number;
  // Advanced retrieval scoring parameters
  recencyFloor?: number;
  recencyCeiling?: number;
  recencyDecayDays?: number;
  supersessionPenalty?: number;
  supersessionKeywordThreshold?: number;
  /** Tool name patterns whose results are included in extraction but workspace-pinned. */
  pinnedToolPatterns?: string[];
}

const DEFAULT_CONFIG_SET_ID = 'default';
const MAX_CONFIG_SET_COUNT = 20;
/**
 * Separate from MAX_CONFIG_SET_COUNT on purpose (design decision #11): the
 * renderer recovers the config-set cap by parsing the thrown message
 * (`useApiConfigState.ts` — /^Config set limit reached: max\s+(\d+)$/), so one
 * shared constant across two entity types would make that parse ambiguous.
 */
const MAX_CUSTOM_ENDPOINT_COUNT = 20;
const CUSTOM_ENDPOINT_ID_PREFIX = 'custom-endpoint-';
const LOCAL_ANTHROPIC_PLACEHOLDER_KEY = 'sk-ant-local-proxy';
const DIRECT_READ_KEYS = new Set<keyof AppConfig>([
  'provider',
  'apiKey',
  'baseUrl',
  'customProtocol',
  'activeProfileKey',
  'activeConfigSetId',
  'claudeCodePath',
  'defaultWorkdir',
  'globalSkillsPath',
  'localDevPath',
  'systemPromptFile',
  'enableDevLogs',
  'theme',
  'sandboxEnabled',
  'memoryEnabled',
  'enableThinking',
  'isConfigured',
  'schedulerCatchUpPolicy',
  'schedulerConflictPolicy',
  'schedulerRunHistoryDepth',
]);

const defaultProfiles: Record<ProviderProfileKey, ProviderProfile> = {
  openrouter: {
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4-6',
  },
  anthropic: {
    apiKey: '',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-6',
  },
  openai: {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
  },
  ollama: {
    apiKey: '',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
  },
  gemini: {
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
  },
  'custom:anthropic': {
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5',
  },
  'custom:openai': {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
  },
  'custom:gemini': {
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
  },
};

const defaultConfigSet: ApiConfigSet = {
  id: DEFAULT_CONFIG_SET_ID,
  name: 'Default',
  isSystem: true,
  provider: 'openrouter',
  model: defaultProfiles.openrouter.model,
  customProtocol: 'anthropic',
  activeProfileKey: 'openrouter',
  profiles: defaultProfiles,
  enableThinking: false,
  thinkingLevel: 'off' as ModelThinkingLevel,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

const defaultConfig: AppConfig = {
  provider: defaultConfigSet.provider,
  apiKey: defaultProfiles.openrouter.apiKey,
  baseUrl: defaultProfiles.openrouter.baseUrl,
  customProtocol: defaultConfigSet.customProtocol,
  model: defaultProfiles.openrouter.model,
  activeProfileKey: defaultConfigSet.activeProfileKey,
  profiles: defaultProfiles,
  // Derived by normalizeConfig from the sets' profiles (Phase 1); empty here so
  // a fresh install starts with no credential claims and nothing to migrate.
  providerCredentials: {},
  customEndpoints: [],
  activeConfigSetId: DEFAULT_CONFIG_SET_ID,
  configSets: [defaultConfigSet],
  claudeCodePath: '',
  defaultWorkdir: '',
  globalSkillsPath: '',
  localDevPath: '',
  systemPromptFile: '',
  systemPromptFileEnabled: true,
  systemPromptFilePriority: [...DEFAULT_SYSTEM_PROMPT_PRIORITY],
  bashTrustedCommands: [],

  bashDenylist: [],
  trustedDirectories: [],
  enableDevLogs: false,
  theme: 'light',
  sandboxEnabled: false,
  memoryEnabled: true,
  memoryRuntime: {
    llm: {
      inheritFromActive: true,
      provider: undefined,
      customProtocol: undefined,
      apiKey: '',
      baseUrl: '',
      model: '',
      timeoutMs: 180000,
    },
    embedding: {
      inheritFromActive: false,
      provider: 'local' as const,
      customProtocol: undefined,
      apiKey: '',
      baseUrl: '',
      // Safe fallback model for non-local providers. Ignored when provider === 'local'
      // since the model ID is hardcoded in local-embedding-provider.ts (design D1).
      model: 'text-embedding-3-small',
      timeoutMs: 180000,
    },
    useEmbedding: true,
    maxNavSteps: 2,
    ingestionConcurrency: 4,
    storageRoot: '',
    evalEnabled: false,
    evalWorkspaces: [],
    evalMaxRounds: 12,
    evalArtifactsRoot: '',
    promptIterationRounds: 2,
    recencyFloor: 0.05,
    recencyCeiling: 0.25,
    recencyDecayDays: 90,
    supersessionPenalty: 0.2,
    supersessionKeywordThreshold: 0.5,
    pinnedToolPatterns: ['^mcp__claude_cowork_memory__cowork_'],
  },
  enableThinking: false,
  isConfigured: false,
  configSchemaVersion: 0,
  schedulerCatchUpPolicy: 'ask',
  schedulerConflictPolicy: 'queue',
  schedulerRunHistoryDepth: 10,
  permissionTimeoutSeconds: DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds,
  mcpToolTimeoutSeconds: 240,
  notificationsEnabled: true,
  skillConflictConfig: createDefaultSkillConflictConfig(),
  orphanDismissals: [],
};

export const PROVIDER_PRESETS = API_PROVIDER_PRESETS;
const PI_AI_CURATED: Record<string, { piProvider: string; pick: string[] }> = PI_AI_CURATED_PRESETS;

// Cached dynamic presets — populated once by async import.
let cachedDynamicPresets: typeof PROVIDER_PRESETS | null = null;

/**
 * Build model presets dynamically from pi-ai registry.
 * Returns PROVIDER_PRESETS with models arrays replaced by registry data where available.
 * Uses async import() because pi-ai is ESM-only.
 */
export async function getPiAiModelPresets(): Promise<typeof PROVIDER_PRESETS> {
  if (cachedDynamicPresets) return cachedDynamicPresets;

  try {
    // `getModels` moved off the pi-ai root entrypoint to `/compat` in 0.80.0.
    const { getModels } = (await import('@earendil-works/pi-ai/compat')) as {
      getModels: (provider: string) => Array<{ id: string; name: string }> | undefined;
    };

    const result = { ...PROVIDER_PRESETS } as Record<
      string,
      (typeof PROVIDER_PRESETS)[keyof typeof PROVIDER_PRESETS]
    >;

    for (const [providerKey, curated] of Object.entries(PI_AI_CURATED)) {
      const preset = PROVIDER_PRESETS[providerKey as keyof typeof PROVIDER_PRESETS];
      if (!preset) continue;

      const registryModels = getModels(curated.piProvider);
      if (!registryModels || registryModels.length === 0) continue;

      const registryIds = new Set(registryModels.map((m) => m.id));
      const picked = curated.pick
        .filter((id) => registryIds.has(id))
        .map((id) => {
          const reg = registryModels.find((m) => m.id === id);
          return { id, name: reg?.name || id };
        });

      if (picked.length > 0) {
        result[providerKey] = { ...preset, models: picked };
      }
    }

    cachedDynamicPresets = result as unknown as typeof PROVIDER_PRESETS;
    return cachedDynamicPresets;
  } catch (err) {
    logWarn('[ConfigStore] Failed to load pi-ai model presets, using hardcoded fallback:', err);
    return PROVIDER_PRESETS;
  }
}

const BUILTIN_PROFILE_KEYS: BuiltinProfileKey[] = [
  'openrouter',
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'custom:anthropic',
  'custom:openai',
  'custom:gemini',
];

/**
 * PROFILE_KEYS enumerates only the builtin slots.
 * Native slots (native:*) are dynamic and not enumerable upfront —
 * they live in the sparse profiles map and are accessed by key.
 */
const PROFILE_KEYS: BuiltinProfileKey[] = BUILTIN_PROFILE_KEYS;
const VALID_THEMES: AppTheme[] = ['dark', 'light', 'system'];

/**
 * Accepts any non-empty string as a provider id EXCEPT 'local', which is
 * reserved for EmbeddingProviderType and must never appear on the main LLM
 * config or any ApiConfigSet provider field.
 * Provider ids are trimmed at persistence boundaries (see normalizeConfig)
 * so callers receive canonical values.
 */
/** Accepts any valid provider id (non-empty, not 'local', not a prototype key). */
function isProviderType(value: unknown): value is ProviderType {
  return isValidProviderId(value);
}

/** Type-guard for the 6 legacy builtin provider ids (trims before checking). */
function isBuiltinProviderType(value: unknown): value is BuiltinProviderType {
  if (typeof value !== 'string') return false;
  return (BUILTIN_PROVIDER_ID_LIST as readonly string[]).includes(value.trim());
}

function isCustomProtocol(value: unknown): value is CustomProtocolType {
  return value === 'anthropic' || value === 'openai' || value === 'gemini';
}

/** Accepts builtin profile keys and `native:<canonical-id>` keys. */
function isProfileKey(value: unknown): value is ProviderProfileKey {
  return isValidProfileKey(value);
}

function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && VALID_THEMES.includes(value as AppTheme);
}

function normalizeRunHistoryDepth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultConfig.schedulerRunHistoryDepth;
  }
  const clamped = Math.floor(value);
  if (clamped < 1) return 1;
  if (clamped > 100) return 100;
  return clamped;
}

/**
 * Normalize MCP tool timeout. 0 means no timeout (not recommended).
 * Minimum 10s to avoid instant-timeout, max 600s (10 minutes).
 */
function normalizeMcpToolTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultConfig.mcpToolTimeoutSeconds;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) return 0; // disabled
  if (rounded < 10) return 10; // minimum 10 seconds
  if (rounded > 600) return 600; // maximum 10 minutes
  return rounded;
}

/**
 * Normalize catch-up policy. 'run-all' is not yet implemented and is
 * coerced to 'run-once' to prevent silent behavior mismatch.
 */
function normalizeCatchUpPolicy(value: unknown): AppConfig['schedulerCatchUpPolicy'] {
  if (!isValidCatchUpPolicy(value)) {
    return defaultConfig.schedulerCatchUpPolicy;
  }
  if (value === 'run-all') {
    logWarn(
      '[ConfigStore] schedulerCatchUpPolicy "run-all" is not yet implemented, using "run-once"'
    );
    return 'run-once';
  }
  return value;
}

function isEmbeddingProviderType(value: unknown): value is EmbeddingProviderType {
  return isProviderType(value) || value === 'local';
}

function isMemoryModelRuntimeConfig(
  value: unknown
): value is Partial<MemoryModelRuntimeConfigBase> {
  return typeof value === 'object' && value !== null;
}

function normalizeMemoryModelRuntimeConfigBase(
  raw: unknown,
  fallback: MemoryModelRuntimeConfigBase
): MemoryModelRuntimeConfigBase {
  const value = isMemoryModelRuntimeConfig(raw) ? raw : {};
  return {
    inheritFromActive: toBoolean(value.inheritFromActive, fallback.inheritFromActive),
    customProtocol: isCustomProtocol(value.customProtocol)
      ? value.customProtocol
      : fallback.customProtocol,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : fallback.apiKey,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : fallback.baseUrl,
    model: typeof value.model === 'string' ? value.model : fallback.model,
    timeoutMs:
      typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)
        ? Math.max(5000, Math.round(value.timeoutMs))
        : fallback.timeoutMs,
  };
}

function normalizeMemoryLLMRuntimeConfig(
  raw: unknown,
  fallback: MemoryLLMRuntimeConfig
): MemoryLLMRuntimeConfig {
  const base = normalizeMemoryModelRuntimeConfigBase(raw, fallback);
  const rawProvider = isMemoryModelRuntimeConfig(raw)
    ? (raw as Partial<MemoryLLMRuntimeConfig>).provider
    : undefined;
  return {
    ...base,
    // Memory LLM provider is intentionally constrained to the 6 builtin ids
    // (§6.2 of native-provider-catalog design). The memory sub-config has its
    // own UI path and does not participate in the native provider catalog.
    // ProviderType widening does NOT affect this field — native provider ids
    // saved here would be coerced to the fallback, which is the correct behavior.
    provider: isBuiltinProviderType(rawProvider) ? rawProvider : fallback.provider,
  };
}

function normalizeMemoryEmbeddingRuntimeConfig(
  raw: unknown,
  fallback: MemoryEmbeddingRuntimeConfig
): MemoryEmbeddingRuntimeConfig {
  const base = normalizeMemoryModelRuntimeConfigBase(raw, fallback);
  const rawProvider = isMemoryModelRuntimeConfig(raw)
    ? (raw as Partial<MemoryEmbeddingRuntimeConfig>).provider
    : undefined;
  return {
    ...base,
    provider: isEmbeddingProviderType(rawProvider) ? rawProvider : fallback.provider,
  };
}

function normalizeMemoryRuntimeConfig(
  raw: unknown,
  schemaVersion?: number,
  isFreshInstall?: boolean
): MemoryRuntimeConfig {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Partial<MemoryRuntimeConfig>) : {};

  // Embedding defaults are schema-version and install-type aware:
  // - Pre-v2 (existing installs before this feature): old defaults — no local embedding.
  // - v2+ fresh install: new defaults — useEmbedding: true, provider: 'local'.
  // - v2+ upgrade (was v0 or v1): preserve old behavior — provider: undefined, useEmbedding
  //   is frozen via migrateToV2(). We must NOT fall back to 'local' for upgraded users who
  //   never explicitly set a provider, otherwise they'd silently get local embeddings.
  const isPreV2 = typeof schemaVersion === 'number' && schemaVersion < 2;
  const isTrulyFreshV2 = !isPreV2 && isFreshInstall === true;

  const embeddingFallback: MemoryEmbeddingRuntimeConfig =
    isPreV2 || !isTrulyFreshV2
      ? {
          ...defaultConfig.memoryRuntime.embedding,
          provider: undefined,
          model: 'text-embedding-3-small',
        }
      : defaultConfig.memoryRuntime.embedding;
  const useEmbeddingFallback = isTrulyFreshV2 ? defaultConfig.memoryRuntime.useEmbedding : false;

  const result: MemoryRuntimeConfig = {
    llm: normalizeMemoryLLMRuntimeConfig(value.llm, defaultConfig.memoryRuntime.llm),
    embedding: normalizeMemoryEmbeddingRuntimeConfig(value.embedding, embeddingFallback),
    useEmbedding: toBoolean(value.useEmbedding, useEmbeddingFallback),
    maxNavSteps:
      typeof value.maxNavSteps === 'number' && Number.isFinite(value.maxNavSteps)
        ? Math.max(0, Math.min(4, Math.round(value.maxNavSteps)))
        : defaultConfig.memoryRuntime.maxNavSteps,
    ingestionConcurrency:
      typeof value.ingestionConcurrency === 'number' && Number.isFinite(value.ingestionConcurrency)
        ? Math.max(1, Math.min(16, Math.round(value.ingestionConcurrency)))
        : defaultConfig.memoryRuntime.ingestionConcurrency,
    storageRoot:
      typeof value.storageRoot === 'string'
        ? value.storageRoot
        : defaultConfig.memoryRuntime.storageRoot,
    evalEnabled: toBoolean(value.evalEnabled, defaultConfig.memoryRuntime.evalEnabled ?? false),
    evalWorkspaces: Array.isArray(value.evalWorkspaces)
      ? value.evalWorkspaces.filter((item): item is string => typeof item === 'string')
      : defaultConfig.memoryRuntime.evalWorkspaces,
    evalMaxRounds:
      typeof value.evalMaxRounds === 'number' && Number.isFinite(value.evalMaxRounds)
        ? Math.max(1, Math.min(100, Math.round(value.evalMaxRounds)))
        : defaultConfig.memoryRuntime.evalMaxRounds,
    evalArtifactsRoot:
      typeof value.evalArtifactsRoot === 'string'
        ? value.evalArtifactsRoot
        : defaultConfig.memoryRuntime.evalArtifactsRoot,
    promptIterationRounds:
      typeof value.promptIterationRounds === 'number' &&
      Number.isFinite(value.promptIterationRounds)
        ? Math.max(0, Math.min(10, Math.round(value.promptIterationRounds)))
        : defaultConfig.memoryRuntime.promptIterationRounds,
    recencyFloor:
      typeof value.recencyFloor === 'number' && Number.isFinite(value.recencyFloor)
        ? Math.max(0.01, Math.min(0.2, value.recencyFloor))
        : defaultConfig.memoryRuntime.recencyFloor,
    recencyCeiling:
      typeof value.recencyCeiling === 'number' && Number.isFinite(value.recencyCeiling)
        ? Math.max(0.1, Math.min(0.5, value.recencyCeiling))
        : defaultConfig.memoryRuntime.recencyCeiling,
    recencyDecayDays:
      typeof value.recencyDecayDays === 'number' && Number.isFinite(value.recencyDecayDays)
        ? Math.max(30, Math.min(180, Math.round(value.recencyDecayDays)))
        : defaultConfig.memoryRuntime.recencyDecayDays,
    supersessionPenalty:
      typeof value.supersessionPenalty === 'number' && Number.isFinite(value.supersessionPenalty)
        ? Math.max(0, Math.min(0.5, value.supersessionPenalty))
        : defaultConfig.memoryRuntime.supersessionPenalty,
    supersessionKeywordThreshold:
      typeof value.supersessionKeywordThreshold === 'number' &&
      Number.isFinite(value.supersessionKeywordThreshold)
        ? Math.max(0.3, Math.min(0.8, value.supersessionKeywordThreshold))
        : defaultConfig.memoryRuntime.supersessionKeywordThreshold,
    pinnedToolPatterns: Array.isArray(value.pinnedToolPatterns)
      ? value.pinnedToolPatterns.filter((item): item is string => typeof item === 'string')
      : defaultConfig.memoryRuntime.pinnedToolPatterns,
  };
  // Enforce floor <= ceiling: if floor exceeds ceiling, clamp floor down
  if (
    result.recencyFloor !== undefined &&
    result.recencyCeiling !== undefined &&
    result.recencyFloor > result.recencyCeiling
  ) {
    result.recencyFloor = result.recencyCeiling;
  }
  return result;
}

/**
 * Normalize orphan dismissals array from config store.
 * Validates each entry fully and caps the array size.
 */
const MAX_ORPHAN_DISMISSALS = 50;

function normalizeOrphanDismissals(
  raw: unknown
): import('../../shared/workspace-orphan-types').WorkspaceOrphanDismissal[] {
  if (!Array.isArray(raw)) return [];

  const result: import('../../shared/workspace-orphan-types').WorkspaceOrphanDismissal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;

    // Validate required fields
    if (typeof d.cwd !== 'string' || d.cwd.length === 0) continue;
    if (typeof d.dismissedAt !== 'number' || !Number.isFinite(d.dismissedAt)) continue;

    // Validate optional mtime fields: must be null or a finite number
    const skillsMtime = d.skillsProfileMtimeMs;
    const mcpMtime = d.mcpProfileMtimeMs;
    const validSkillsMtime =
      skillsMtime === null || (typeof skillsMtime === 'number' && Number.isFinite(skillsMtime));
    const validMcpMtime =
      mcpMtime === null || (typeof mcpMtime === 'number' && Number.isFinite(mcpMtime));
    if (!validSkillsMtime || !validMcpMtime) continue;

    result.push({
      cwd: d.cwd,
      dismissedAt: d.dismissedAt,
      skillsProfileMtimeMs: (skillsMtime as number | null) ?? null,
      mcpProfileMtimeMs: (mcpMtime as number | null) ?? null,
    });

    if (result.length >= MAX_ORPHAN_DISMISSALS) break;
  }

  return result;
}

function profileKeyFromProvider(
  provider: ProviderType,
  customProtocol: CustomProtocolType = 'anthropic'
): ProviderProfileKey {
  return deriveProfileKey(provider, customProtocol) as ProviderProfileKey;
}

function profileKeyToProvider(profileKey: ProviderProfileKey): {
  provider: ProviderType;
  customProtocol: CustomProtocolType;
} {
  return profileKeyToProviderInfo(profileKey);
}

// VALID_THINKING_LEVELS is now THINKING_LEVELS from shared/thinking-levels

function normalizeThinkingLevel(value: unknown, fallback: ModelThinkingLevel): ModelThinkingLevel {
  if (typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ModelThinkingLevel;
  }
  return fallback;
}

/**
 * Canonical form of a base URL for *comparison*: lowercased host, no trailing
 * slash. Shared by endpoint identity (`customEndpointKey`) and the
 * "is this slot still at its default?" checks in both derivation helpers, so
 * slash/case noise can never be mistaken for user intent and invent a
 * credential the user never configured.
 */
function canonicalBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hostname = parsed.hostname.toLowerCase();
    // toString() canonicalizes the path, so a trailing slash is already
    // normalized away here; the catch branch below handles it explicitly.
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    // Not a parseable URL — compare the trimmed string rather than dropping it.
    // A malformed base URL is still the user's data.
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Canonical key for deduplicating custom endpoints: protocol + canonical base
 * URL. Two sets pointing at the same gateway with the same protocol must yield
 * one endpoint entry, not two (design §5.1 rule 1, idempotence).
 */
function customEndpointKey(protocol: CustomProtocolType, baseUrl: string): string {
  return `${protocol}::${canonicalBaseUrl(baseUrl)}`;
}

/**
 * Default display name for a migrated endpoint: the base URL's host (with port
 * when present), falling back to the raw string. Design §5.1 rule 3 — names come
 * from what exists, because the host is the only thing the old data knows. The
 * user can rename afterwards.
 */
function defaultCustomEndpointName(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return 'Custom endpoint';
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed;
  }
}

/** Derive a ModelThinkingLevel from either the new thinkingLevel field or the
 * legacy enableThinking boolean. New field wins when present and valid. */
function resolveThinkingLevelFromRaw(
  thinkingLevel: unknown,
  enableThinking: unknown
): ModelThinkingLevel {
  const hasExplicitLevel =
    typeof thinkingLevel === 'string' &&
    (THINKING_LEVELS as readonly string[]).includes(thinkingLevel);

  if (hasExplicitLevel) {
    // 'off' wins only when enableThinking is absent or false.
    // If enableThinking is explicitly true and thinkingLevel is 'off',
    // that's legacy/default bleedthrough — honour the boolean intent instead.
    if (thinkingLevel !== 'off') return thinkingLevel as ModelThinkingLevel;
    if (typeof enableThinking === 'boolean' && enableThinking) return 'medium';
    return 'off';
  }

  // No valid stored level — migrate from the legacy boolean.
  return typeof enableThinking === 'boolean' && enableThinking ? 'medium' : 'off';
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// `toStringArray` is the old internal name used throughout this file; it
// now forwards to the shared sanitizer in `permission-rules-store` so the
// IPC handler, runtime policy, and persisted config all normalize
// identically at the trust boundary.
const toStringArray = sanitizeBashCommandList;

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nowISO(): string {
  return new Date().toISOString();
}

function normalizeCustomProtocol(
  value: CustomProtocolType | undefined,
  fallback: CustomProtocolType = 'anthropic'
): CustomProtocolType {
  if (value === 'openai' || value === 'gemini' || value === 'anthropic') {
    return value;
  }
  return fallback;
}

function defaultProtocolForProvider(provider: ProviderType): CustomProtocolType {
  if (provider === 'openai' || provider === 'ollama') {
    return 'openai';
  }
  if (provider === 'gemini') {
    return 'gemini';
  }
  return 'anthropic';
}

/**
 * Deep-merge a partial memoryRuntime update with the current persisted value.
 * Only top-level scalar fields and the llm/embedding sub-objects are merged
 * field-by-field; all other fields fall through to the incoming update or current.
 * This prevents partial UI saves from resetting unrelated nested keys.
 */
function mergeMemoryRuntime(
  current: MemoryRuntimeConfig,
  incoming: Partial<MemoryRuntimeConfig>
): Partial<MemoryRuntimeConfig> {
  return {
    ...current,
    ...incoming,
    // Merge llm sub-object field-by-field so partial updates don't wipe e.g. apiKey.
    llm: incoming.llm !== undefined ? { ...current.llm, ...incoming.llm } : current.llm,
    // Merge embedding sub-object field-by-field for the same reason.
    embedding:
      incoming.embedding !== undefined
        ? { ...current.embedding, ...incoming.embedding }
        : current.embedding,
  };
}

export class ConfigStore {
  private store: Store<AppConfig>;

  constructor() {
    const storeOptions: StoreOptions<AppConfig> & { projectName?: string } = {
      name: 'config',
      projectName: 'open-cowork',
      defaults: defaultConfig,
    };

    // Cast to satisfy the Record<string, unknown> constraint of the encrypted store utility;
    // AppConfig is a structurally compatible object type at runtime.
    type AppConfigRecord = AppConfig & Record<string, unknown>;
    this.store = createEncryptedStoreWithKeyRotation<AppConfigRecord>({
      stableKey: 'open-cowork-config-stable-v1',
      legacyKeys: [
        'open-cowork-config-v1',
        ...getLegacyDerivedKeyHexes({
          moduleDirname: __dirname,
          stableSeed: 'open-cowork-config-stable-v1',
          legacySeed: 'open-cowork-config-v1',
          salt: 'open-cowork-config-salt',
        }),
      ],
      storeOptions: storeOptions as StoreOptions<AppConfigRecord> & { projectName?: string },
      logPrefix: '[ConfigStore]',
      log,
      warn: logWarn,
    }) as unknown as Store<AppConfig>;
    this.ensureNormalized();
  }

  private ensureNormalized(): void {
    // Detect a truly fresh install *before* any write below can create the
    // file. electron-store keeps `defaults` in memory only and does not write
    // the config file until the first `set`, so an absent file here means a
    // brand-new install. (Key rotation writes only when migrating an existing
    // legacy-key file, so it never fires on a fresh install.)
    const configFileExists = fs.existsSync(this.store.path);

    // Source of truth is the *decrypted* in-memory store, never the on-disk
    // file: the config file is AES-encrypted and cannot be JSON-parsed. The
    // store returns each persisted value, or the schema default when a key was
    // never written. `configSchemaVersion` defaults to 0, so a pre-versioning
    // install reads 0 and triggers migration; once we stamp 1 it persists in
    // the encrypted store and migration never re-runs.
    const rawVersion = this.store.get('configSchemaVersion');
    const currentVersion =
      typeof rawVersion === 'number' && rawVersion >= 1 ? (rawVersion >= 2 ? 2 : 1) : 0;

    if (!configFileExists) {
      // Truly fresh install → new defaults (useEmbedding: true, provider: 'local') apply
      // naturally from defaultConfig. Just stamp the current schema version.
      this.store.set({ configSchemaVersion: 2 } as unknown as AppConfig);
    } else if (currentVersion === 0) {
      // Existing pre-v1 install → run legacy migration then fall through to v1→v2 below.
      const migrated = this.migrateFromLegacy(this.store.get('systemPromptFile'));
      this.store.set({
        ...migrated,
        configSchemaVersion: 1,
      } as unknown as AppConfig);
      // Fall through to v1→v2 migration — use dot-path sets to preserve all
      // other memoryRuntime fields (llm, ingestionConcurrency, storageRoot, etc.).
      this.migrateToV2();
      this.store.set({ configSchemaVersion: 2 } as unknown as AppConfig);
    } else if (currentVersion === 1) {
      // Existing v1 install → freeze current embedding behavior so the new
      // defaults (useEmbedding: true, provider: 'local') never apply to them.
      // Use dot-path sets to preserve all other memoryRuntime fields.
      this.migrateToV2();
      this.store.set({ configSchemaVersion: 2 } as unknown as AppConfig);
    }

    const normalized = this.normalizeConfig(
      this.store.store as Partial<AppConfig>,
      !configFileExists
    );
    this.store.set(normalized);
  }

  /**
   * Derive `systemPromptFileEnabled` / `systemPromptFilePriority` from the
   * decrypted legacy `systemPromptFile` value for a pre-migration config
   * (configSchemaVersion 0). Called once from `ensureNormalized`; the result is
   * written back alongside `configSchemaVersion: 1` so it never runs again.
   *
   * A specific whitelisted file → enable it and hoist it to position 0.
   * '' (None), a value defaulted to '' (key never set), or an invalid value →
   * disabled with the default order, preserving pre-feature behavior.
   */
  private migrateFromLegacy(legacy: unknown): {
    systemPromptFileEnabled: boolean;
    systemPromptFilePriority: SystemPromptFileName[];
  } {
    if (typeof legacy === 'string' && legacy !== '' && isValidSystemPromptFileChoice(legacy)) {
      return {
        systemPromptFileEnabled: true,
        systemPromptFilePriority: normalizeSystemPromptPriority([legacy]),
      };
    }
    return {
      systemPromptFileEnabled: false,
      systemPromptFilePriority: [...DEFAULT_SYSTEM_PROMPT_PRIORITY],
    };
  }

  /**
   * Freeze useEmbedding for existing (v1) installs so the new default (true)
   * doesn't silently enable embeddings for users who never opted in.
   *
   * embedding.provider is intentionally NOT touched here — normalization is now
   * schema-version-aware (see normalizeMemoryRuntimeConfig). For pre-v2 configs,
   * the old defaults (provider: undefined, useEmbedding: false) are used as
   * fallbacks regardless of what defaultConfig says. So writing provider is
   * unnecessary and could clobber an existing custom provider value.
   *
   * Only sets memoryRuntime.useEmbedding (dot-path, non-destructive) and stamps
   * configSchemaVersion: 2 in the caller.
   */
  private migrateToV2(): void {
    const rawMemory = this.store.get('memoryRuntime');
    const { useEmbedding } = computeV2Migration(rawMemory);
    // Dot-path write: only useEmbedding is frozen; all other fields are untouched.
    this.store.set('memoryRuntime.useEmbedding' as unknown as keyof AppConfig, useEmbedding);
  }

  private normalizeModelIds(config: AppConfig): void {
    // Fix legacy "gemini/gemini-*" → "gemini-*" for gemini profiles
    // (pi-ai google provider uses bare model IDs, not prefixed)
    for (const key of ['gemini', 'custom:gemini'] as const) {
      const profile = config.profiles?.[key];
      if (profile?.model?.startsWith('gemini/')) {
        profile.model = profile.model.slice('gemini/'.length);
      }
    }
    // Fix openrouter baseUrl: /api → /api/v1
    const orProfile = config.profiles?.openrouter;
    if (orProfile?.baseUrl === 'https://openrouter.ai/api') {
      orProfile.baseUrl = 'https://openrouter.ai/api/v1';
    }
    // Fix openrouter model IDs: dashes → dots for claude models
    // Registry uses "anthropic/claude-sonnet-4.5", old config had "anthropic/claude-sonnet-4-5"
    if (orProfile?.model) {
      orProfile.model = orProfile.model.replace(
        /^(anthropic\/claude-(?:sonnet|opus|haiku)-\d+)-(\d+)/,
        '$1.$2'
      );
    }
    // Also fix the flat model field (legacy compat)
    if (config.model?.startsWith('gemini/')) {
      config.model = config.model.slice('gemini/'.length);
    }
    // Fix flat baseUrl for openrouter
    if (config.baseUrl === 'https://openrouter.ai/api' && config.provider === 'openrouter') {
      config.baseUrl = 'https://openrouter.ai/api/v1';
    }
  }

  private getDefaultProfile(profileKey: ProviderProfileKey): ProviderProfile {
    const fallback = defaultProfiles[profileKey];
    // Native provider slots (native:*) are dynamic and have no static default
    // in `defaultProfiles`. Return an empty profile so callers never crash on a
    // missing key — the base URL and model come from the pi-ai registry at
    // runtime, not from a persisted default. baseUrl is '' (never undefined):
    // electron-store persists via JSON and rejects `undefined` values.
    if (!fallback) {
      return { apiKey: '', baseUrl: '', model: '' };
    }
    return {
      apiKey: fallback.apiKey,
      baseUrl: fallback.baseUrl,
      model: fallback.model,
    };
  }

  private normalizeProfile(
    profileKey: ProviderProfileKey,
    profile: Partial<ProviderProfile> | undefined
  ): ProviderProfile {
    const fallback = this.getDefaultProfile(profileKey);
    const model =
      typeof profile?.model === 'string' && profile.model.trim()
        ? profile.model.trim()
        : fallback.model;
    const rawBaseUrl =
      typeof profile?.baseUrl === 'string' && profile.baseUrl.trim()
        ? profile.baseUrl.trim()
        : fallback.baseUrl;
    const baseUrl =
      profileKey === 'ollama' ? normalizeOllamaBaseUrl(rawBaseUrl) || fallback.baseUrl : rawBaseUrl;
    const result: ProviderProfile = {
      apiKey: typeof profile?.apiKey === 'string' ? profile.apiKey : '',
      // Coerce to '' — never undefined. electron-store persists via JSON and
      // rejects undefined values (native providers have no default baseUrl).
      baseUrl: baseUrl ?? '',
      model,
    };
    // Preserve optional numeric fields so callers don't silently lose user-set values
    if (typeof profile?.contextWindow === 'number' && profile.contextWindow > 0) {
      result.contextWindow = profile.contextWindow;
    }
    if (typeof profile?.maxTokens === 'number' && profile.maxTokens > 0) {
      result.maxTokens = profile.maxTokens;
    }
    return result;
  }

  private cloneProfiles(
    profiles: Partial<Record<ProviderProfileKey, ProviderProfile>> | undefined
  ): Record<ProviderProfileKey, ProviderProfile> {
    const cloned = {} as Record<ProviderProfileKey, ProviderProfile>;
    for (const key of PROFILE_KEYS) {
      cloned[key] = this.normalizeProfile(key, profiles?.[key]);
    }
    // Preserve native provider slots (native:<id>), which are dynamic and not
    // enumerated in PROFILE_KEYS. Without this, native credentials are dropped
    // on every normalize and native config sets can't persist their API keys.
    if (profiles) {
      for (const key of Object.keys(profiles)) {
        if (isNativeProfileKey(key) && !(key in cloned)) {
          const nativeKey = key as ProviderProfileKey;
          cloned[nativeKey] = this.normalizeProfile(nativeKey, profiles[nativeKey]);
        }
      }
    }
    return cloned;
  }

  /**
   * Order config sets for credential derivation: active set first, then array
   * order. Design §5.1 rule 2 — "first non-empty wins", and *which* set is first
   * must be deterministic, so the lossy case (two different keys for one
   * provider) resolves the same way on every read.
   */
  private orderSetsForDerivation(
    configSets: ApiConfigSet[],
    activeConfigSetId: string
  ): ApiConfigSet[] {
    const activeIndex = configSets.findIndex((set) => set.id === activeConfigSetId);
    if (activeIndex <= 0) return configSets;
    return [configSets[activeIndex], ...configSets.filter((_, i) => i !== activeIndex)];
  }

  /**
   * Derive the global credential map from the config sets' per-set profiles.
   *
   * **Phase 2a: the persisted map wins; legacy profiles only fill gaps.**
   *
   * This is the inverse of Phase 1, and the inversion is the point of the phase.
   * In Phase 1 nothing wrote this map, so anything on disk could only be a stale
   * cache and had to be ignored. Now `update()` and the endpoint CRUD write here,
   * so a persisted slot is the user's actual credential and must survive a read
   * even when no `profiles` entry describes it.
   *
   * Legacy `profiles` are therefore consulted **only for slots the persisted map
   * does not already hold** — that is the migration (§5), and it is why a
   * pre-split config still works with no schema bump. Once Phase 2b stops the
   * renderer sending `profiles`, this second pass becomes dead and is deleted
   * along with the field.
   *
   * Rules (design §5.1):
   * - **First non-empty wins**, active set first (`orderSetsForDerivation`), so
   *   the lossy case resolves identically on every read.
   * - A credential counts as populated when it has a non-empty `apiKey`, or a
   *   `baseUrl` differing from the slot's default. The latter matters for
   *   `ollama`, which is a legitimately keyless slot (decision #4) — keying only
   *   on `apiKey` would drop a user's custom Ollama URL.
   * - `custom:*` slots are excluded: those become `customEndpoints` entries
   *   instead (decision #3), since the user supplies protocol *and* base URL
   *   there and may run several at once.
   *
   * Note that `cloneProfiles` materializes all 8 builtin slots on every set, so
   * a slot's *presence* in `profiles` means nothing — only its contents do.
   */
  private deriveProviderCredentials(
    configSets: ApiConfigSet[],
    activeConfigSetId: string,
    persisted?: unknown
  ): ProviderCredentialMap {
    const derived: ProviderCredentialMap = {};

    // Pass 1 — the authoritative persisted map.
    //
    // A slot that is *present* wins, even when empty. Empty and missing are
    // different states: `update({ apiKey: '' })` clears a credential on purpose,
    // and if an empty slot counted as missing, pass 2 would resurrect the old key
    // from any other set whose legacy `profiles` still carried it.
    const persistedSlots = new Set<string>();
    if (persisted && typeof persisted === 'object' && !Array.isArray(persisted)) {
      for (const [key, value] of Object.entries(persisted as Record<string, unknown>)) {
        if (!isProfileKey(key) || key.startsWith('custom:')) continue;
        if (!value || typeof value !== 'object') continue;
        const raw = value as Partial<ProviderCredentials>;
        const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
        const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
        // Claim the slot so pass 2 cannot migrate over it. An empty slot is a
        // *cleared* credential and is kept verbatim: dropping it here would make
        // it indistinguishable from "never configured" on the next read, and the
        // legacy-profile migration would revive the old key.
        persistedSlots.add(key);
        const next: ProviderCredentials = { apiKey };
        if (baseUrl) next.baseUrl = baseUrl;
        derived[key as ProviderProfileKey] = next;
      }
    }

    // Pass 2 — migrate from legacy per-set profiles for slots still unfilled.
    for (const set of this.orderSetsForDerivation(configSets, activeConfigSetId)) {
      for (const [rawKey, profile] of Object.entries(set.profiles || {})) {
        if (!isProfileKey(rawKey) || rawKey.startsWith('custom:')) continue;
        const key = rawKey as ProviderProfileKey;
        if (derived[key]) continue; // persisted, or an earlier set already won it
        if (persistedSlots.has(rawKey)) continue; // explicitly cleared — do not revive
        if (!profile) continue;

        const apiKey = typeof profile.apiKey === 'string' ? profile.apiKey : '';
        const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
        const defaultBaseUrl = this.getDefaultProfile(key).baseUrl || '';
        const hasKey = Boolean(apiKey.trim());
        // Compare canonically: a default URL that differs only by trailing slash
        // or host case is still the default, not a customization.
        const hasMeaningfulBaseUrl =
          Boolean(baseUrl) && canonicalBaseUrl(baseUrl) !== canonicalBaseUrl(defaultBaseUrl);
        if (!hasKey && !hasMeaningfulBaseUrl) continue;

        derived[key] = baseUrl ? { apiKey, baseUrl } : { apiKey };
      }
    }

    return derived;
  }

  /**
   * Derive custom endpoints from the sets' `custom:*` profiles — one entry per
   * distinct protocol + base URL (design §5, decision #3).
   *
   * **Phase 1: a pure function of the current config sets**, same contract as
   * `deriveProviderCredentials`. The persisted list contributes only *identity*
   * (`id` and a user-edited `name`) for endpoints the profiles still describe;
   * credentials and URLs always come from the live profile. An endpoint no
   * profile produces any more is pruned rather than kept forever — otherwise
   * editing a gateway URL leaves the old entry behind, and accumulated orphans
   * would consume `MAX_CUSTOM_ENDPOINT_COUNT` and start evicting real ones.
   *
   * Idempotence (§5.1 rule 1) comes from `customEndpointKey`: re-running this
   * over already-derived data matches existing entries and reuses their id and
   * name rather than minting a second entry.
   */
  private deriveCustomEndpoints(
    configSets: ApiConfigSet[],
    activeConfigSetId: string,
    existing: unknown
  ): CustomEndpoint[] {
    // Identity of previously persisted endpoints, keyed by protocol+baseUrl.
    // Config sets will reference these ids from Phase 2 on, so a matching
    // endpoint must keep its id across reads. `apiKey` / `defaultModel` are
    // carried only to decide whether `updatedAt` should be re-stamped — their
    // values always come from the live profile.
    const persistedByKey = new Map<
      string,
      { id: string; name?: string; apiKey?: string; defaultModel?: string; updatedAt: string }
    >();
    const usedIds = new Set<string>();
    if (Array.isArray(existing)) {
      for (const raw of existing) {
        if (!raw || typeof raw !== 'object') continue;
        const candidate = raw as Partial<CustomEndpoint>;
        const baseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl.trim() : '';
        const id = toNonEmptyString(candidate.id);
        if (!baseUrl || !id || usedIds.has(id)) continue;
        const protocol: CustomProtocolType = isCustomProtocol(candidate.protocol)
          ? candidate.protocol
          : 'anthropic';
        const key = customEndpointKey(protocol, baseUrl);
        if (persistedByKey.has(key)) continue;
        usedIds.add(id);
        persistedByKey.set(key, {
          id,
          name: toNonEmptyString(candidate.name) ?? undefined,
          // Preserved as-is, including `''`. Collapsing a missing property to `''`
          // would erase the empty-vs-missing distinction the clear path relies on.
          apiKey: typeof candidate.apiKey === 'string' ? candidate.apiKey : undefined,
          defaultModel: toNonEmptyString(candidate.defaultModel) ?? undefined,
          updatedAt: toNonEmptyString(candidate.updatedAt) || nowISO(),
        });
      }
    }

    let counter = 1;
    const mintId = (): string => {
      let candidate = `${CUSTOM_ENDPOINT_ID_PREFIX}${counter}`;
      while (usedIds.has(candidate)) {
        counter += 1;
        candidate = `${CUSTOM_ENDPOINT_ID_PREFIX}${counter}`;
      }
      usedIds.add(candidate);
      return candidate;
    };

    // Slots whose set already names a live persisted endpoint. Their legacy
    // profile is a **stale mirror**, not a source: deriving from it would mint a
    // twin at the old address every time CRUD changed the endpoint's URL or
    // protocol, and resurrect a deleted endpoint from the leftover mirror.
    // The endpoint itself is still kept — see the persisted pass below.
    const pinnedSlots = new Set<string>();
    const pinnedIds = new Set<string>();
    if (Array.isArray(existing)) {
      const persistedIds = new Set(
        (existing as Array<Partial<CustomEndpoint>>)
          .map((candidate) => toNonEmptyString(candidate?.id))
          .filter((id): id is string => Boolean(id))
      );
      for (const set of configSets) {
        if (set.provider !== 'custom' || !set.endpointId) continue;
        if (!persistedIds.has(set.endpointId)) continue;
        const protocol = isCustomProtocol(set.customProtocol) ? set.customProtocol : 'anthropic';
        pinnedSlots.add(`${set.id}::${profileKeyFromProvider('custom', protocol)}`);
        pinnedIds.add(set.endpointId);
      }
    }

    const byKey = new Map<string, CustomEndpoint>();
    for (const set of this.orderSetsForDerivation(configSets, activeConfigSetId)) {
      for (const [rawKey, profile] of Object.entries(set.profiles || {})) {
        // Validate the key before deriving: a hand-edited `custom:bogus` must be
        // skipped, not turned into an endpoint with a guessed protocol.
        if (!isProfileKey(rawKey) || !rawKey.startsWith('custom:') || !profile) continue;
        if (pinnedSlots.has(`${set.id}::${rawKey}`)) continue;
        const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
        if (!baseUrl) continue;

        const { customProtocol } = profileKeyToProvider(rawKey as ProviderProfileKey);
        if (!isCustomProtocol(customProtocol)) continue;
        const apiKey = typeof profile.apiKey === 'string' ? profile.apiKey : '';
        // A slot left at its untouched default carries no user intent — deriving
        // from it would invent an endpoint the user never configured. Compared
        // canonically so slash/case noise does not read as a customization.
        const defaultBaseUrl = this.getDefaultProfile(rawKey as ProviderProfileKey).baseUrl || '';
        if (!apiKey.trim() && canonicalBaseUrl(baseUrl) === canonicalBaseUrl(defaultBaseUrl)) {
          continue;
        }

        const key = customEndpointKey(customProtocol, baseUrl);
        const found = byKey.get(key);
        if (found) {
          // Same endpoint reached from another set: fill in what the winning set
          // left blank, but never overwrite a value it did provide. A persisted
          // entry's key is authoritative even when empty, so a second set's stale
          // mirror cannot refill a cleared one.
          const persisted = persistedByKey.get(key);
          const keyIsAuthoritative = typeof persisted?.apiKey === 'string';
          if (!keyIsAuthoritative && !found.apiKey.trim() && apiKey.trim()) {
            found.apiKey = apiKey;
          }
          if (!found.defaultModel) {
            const otherModel = typeof profile.model === 'string' ? profile.model.trim() : '';
            if (otherModel) found.defaultModel = otherModel;
          }
          continue;
        }

        const carried = persistedByKey.get(key);
        // Store the canonical URL, not the first-seen spelling: otherwise which
        // set is ordered first decides whether the trailing slash is kept, and
        // the stored value churns with set order.
        const canonicalUrl = canonicalBaseUrl(baseUrl) || baseUrl;
        const model = typeof profile.model === 'string' ? profile.model.trim() : '';
        // The persisted endpoint is authoritative for the key (Phase 2a), exactly
        // as `providerCredentials` is for catalog slots — including the
        // empty-vs-missing distinction. An explicitly cleared key is `''`, not
        // "absent": treating `''` as missing would revive the pre-clear value from
        // any set's legacy mirror, including an unpinned one that still points at
        // this URL. Fall back to the profile only when the persisted entry has no
        // `apiKey` property at all, which is the migration case.
        const effectiveApiKey = carried
          ? typeof carried.apiKey === 'string'
            ? carried.apiKey
            : apiKey
          : apiKey;
        const entry: CustomEndpoint = {
          id: carried?.id ?? mintId(),
          name: carried?.name ?? defaultCustomEndpointName(canonicalUrl),
          protocol: customProtocol,
          baseUrl: canonicalUrl,
          apiKey: effectiveApiKey,
          // Preserve the persisted timestamp when nothing material changed, so a
          // plain update() does not churn it. A real edit (key, model) re-stamps.
          updatedAt:
            carried && carried.apiKey === effectiveApiKey && (carried.defaultModel ?? '') === model
              ? carried.updatedAt
              : nowISO(),
        };
        if (model) entry.defaultModel = model;
        byKey.set(key, entry);
      }
    }

    // Pass 2 — keep explicitly persisted endpoints that no profile describes.
    //
    // Phase 2a: `customEndpoints` is authoritative, so an entry created through
    // the CRUD API (or Phase 2b's UI) has no legacy `custom:*` profile behind it
    // and must not be pruned as an orphan. Only entries that *were* derived and
    // whose source profile has since changed get dropped, which is what keeps a
    // gateway-URL edit from leaving a stale twin.
    if (Array.isArray(existing)) {
      const derivedKeys = new Set(byKey.keys());
      const profileKeys = new Set<string>();
      for (const set of configSets) {
        for (const [rawKey, profile] of Object.entries(set.profiles || {})) {
          if (!isProfileKey(rawKey) || !rawKey.startsWith('custom:') || !profile) continue;
          const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
          if (!baseUrl) continue;
          const { customProtocol } = profileKeyToProvider(rawKey as ProviderProfileKey);
          if (!isCustomProtocol(customProtocol)) continue;
          profileKeys.add(customEndpointKey(customProtocol, baseUrl));
        }
      }

      for (const raw of existing) {
        if (!raw || typeof raw !== 'object') continue;
        const candidate = raw as Partial<CustomEndpoint>;
        const baseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl.trim() : '';
        const id = toNonEmptyString(candidate.id);
        if (!baseUrl || !id) continue;
        const protocol: CustomProtocolType = isCustomProtocol(candidate.protocol)
          ? candidate.protocol
          : 'anthropic';
        const key = customEndpointKey(protocol, baseUrl);
        if (derivedKeys.has(key)) continue;
        // A key some profile still points at was handled by pass 1; anything else
        // here is a standalone entry worth keeping. A **pinned** endpoint is kept
        // regardless: a set names it by id, and its matching profile is a stale
        // mirror whose derivation was suppressed above.
        if (profileKeys.has(key) && !pinnedIds.has(id)) continue;
        if (byKey.size >= MAX_CUSTOM_ENDPOINT_COUNT) break;
        const entry: CustomEndpoint = {
          id,
          name: toNonEmptyString(candidate.name) || defaultCustomEndpointName(baseUrl),
          protocol,
          baseUrl,
          apiKey: typeof candidate.apiKey === 'string' ? candidate.apiKey : '',
          updatedAt: toNonEmptyString(candidate.updatedAt) || nowISO(),
        };
        const defaultModel = toNonEmptyString(candidate.defaultModel);
        if (defaultModel) entry.defaultModel = defaultModel;
        byKey.set(key, entry);
      }
    }

    // Cap defensively (decision #11). With orphans pruned above this is a
    // last-resort guard, not the eviction policy: derivation is bounded by
    // MAX_CONFIG_SET_COUNT × 3 custom slots.
    return [...byKey.values()].slice(0, MAX_CUSTOM_ENDPOINT_COUNT);
  }

  /**
   * Fill a **missing or dangling** `endpointId` on a `provider:'custom'` set from
   * the endpoint its legacy `custom:*` profile describes (design §5).
   *
   * Runs after `deriveCustomEndpoints` because it needs the minted ids.
   *
   * **A valid pin always wins.** An earlier revision let a profile URL override a
   * live `endpointId`, on the theory that the profile edit was the newer intent.
   * That broke CRUD: `updateCustomEndpoint({ baseUrl })` changes the endpoint while
   * the set's mirror still holds the old URL, so the next read derived a twin at
   * the old address and silently retargeted the set back to it. The write path
   * handles the genuine profile-edit case instead — `update()` drops a pin the
   * incoming payload contradicts, and this function then re-links it.
   *
   * A custom set whose profile matches no endpoint keeps whatever pin it has, or
   * none — resolving to an empty credential, which is the honest outcome.
   *
   * Phase 2b deletes this: once `profiles` is gone, `endpointId` is the only
   * pointer and nothing can contradict it.
   */
  private linkCustomEndpointIds(
    configSets: ApiConfigSet[],
    customEndpoints: CustomEndpoint[]
  ): ApiConfigSet[] {
    if (customEndpoints.length === 0) return configSets;
    const byKey = new Map(
      customEndpoints.map((endpoint) => [
        customEndpointKey(endpoint.protocol, endpoint.baseUrl),
        endpoint.id,
      ])
    );
    const validIds = new Set(customEndpoints.map((endpoint) => endpoint.id));

    return configSets.map((set) => {
      if (set.provider !== 'custom') return set;
      if (set.endpointId && validIds.has(set.endpointId)) return set;

      const protocol = isCustomProtocol(set.customProtocol) ? set.customProtocol : 'anthropic';
      const slot = profileKeyFromProvider('custom', protocol) as ProviderProfileKey;
      const baseUrl = set.profiles?.[slot]?.baseUrl?.trim();
      if (!baseUrl) return set;

      const endpointId = byKey.get(customEndpointKey(protocol, baseUrl));
      if (!endpointId) return set;
      return { ...set, endpointId };
    });
  }

  /**
   * Write `apiKey` / `baseUrl` to wherever the active set's provider keeps them
   * (design §4.1): the referenced custom endpoint, or the global slot.
   *
   * Mutates `providerCredentials` in place and returns the (possibly extended)
   * endpoint list plus the endpoint id the set should now reference — writing to
   * a custom provider with no endpoint yet mints one, which is what makes the
   * first-run and "paste a gateway URL" flows work before any Providers UI
   * exists.
   */
  private writeCredential(input: {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    endpointId?: string;
    apiKey?: string;
    baseUrl?: string;
    /**
     * Set only when the caller actually asked for a protocol change. Absent means
     * "leave the endpoint's protocol alone" — `customProtocol` below is the set's
     * legacy mirror and may have diverged, so it must not be written implicitly.
     */
    explicitProtocol?: CustomProtocolType;
    providerCredentials: ProviderCredentialMap;
    customEndpoints: CustomEndpoint[];
  }): { customEndpoints: CustomEndpoint[]; endpointId?: string } {
    const trimmedBaseUrl = input.baseUrl?.trim();
    const explicitProtocol = input.explicitProtocol;

    if (input.provider === 'custom') {
      const endpoints = [...input.customEndpoints];
      const existingIndex = input.endpointId
        ? endpoints.findIndex((candidate) => candidate.id === input.endpointId)
        : -1;

      if (existingIndex >= 0) {
        const existing = endpoints[existingIndex];
        // Default to the **endpoint's own** protocol and URL. `input.customProtocol`
        // comes from the set's legacy mirror, which can have diverged from the
        // endpoint (the read path already prefers the endpoint's). Taking it
        // unconditionally would reset the protocol as a side effect of rotating a
        // key — and could collide with another protocol+URL entry.
        const nextProtocol = explicitProtocol ?? existing.protocol;
        const nextBaseUrl =
          trimmedBaseUrl !== undefined
            ? canonicalBaseUrl(trimmedBaseUrl) || trimmedBaseUrl
            : existing.baseUrl;

        // Re-pointing this endpoint must not duplicate another one. Two entries
        // sharing protocol + URL would make every key-based lookup
        // (`deriveCustomEndpoints`, `linkCustomEndpointIds`) last-write-wins, and
        // sets could silently retarget. `updateCustomEndpoint` enforces the same
        // rule; this path is reachable from `update()`, so it needs it too.
        const nextKey = customEndpointKey(nextProtocol, nextBaseUrl);
        const collisionIndex = endpoints.findIndex(
          (candidate) =>
            candidate.id !== existing.id &&
            customEndpointKey(candidate.protocol, candidate.baseUrl) === nextKey
        );
        if (collisionIndex >= 0) {
          // An endpoint for this protocol + URL already exists: retarget the set
          // to it rather than creating a duplicate or throwing at the user, and
          // carry over the key they just supplied.
          const collision = endpoints[collisionIndex];
          endpoints[collisionIndex] = {
            ...collision,
            ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
            updatedAt: nowISO(),
          };
          return { customEndpoints: endpoints, endpointId: collision.id };
        }

        endpoints[existingIndex] = {
          ...existing,
          protocol: nextProtocol,
          baseUrl: nextBaseUrl,
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          updatedAt: nowISO(),
        };
        return { customEndpoints: endpoints, endpointId: existing.id };
      }

      // No endpoint referenced yet. Match an existing one by protocol + URL
      // before minting, so repeated saves of the same gateway do not accumulate
      // duplicates (the same idempotence rule derivation uses).
      const effectiveUrl = trimmedBaseUrl ?? '';
      if (!effectiveUrl) {
        // Nothing to key an endpoint on; drop the write rather than create a
        // nameless entry with no URL.
        return { customEndpoints: endpoints, endpointId: input.endpointId };
      }
      const key = customEndpointKey(input.customProtocol, effectiveUrl);
      const matchIndex = endpoints.findIndex(
        (candidate) => customEndpointKey(candidate.protocol, candidate.baseUrl) === key
      );
      if (matchIndex >= 0) {
        const match = endpoints[matchIndex];
        endpoints[matchIndex] = {
          ...match,
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          updatedAt: nowISO(),
        };
        return { customEndpoints: endpoints, endpointId: match.id };
      }

      if (endpoints.length >= MAX_CUSTOM_ENDPOINT_COUNT) {
        throw new Error(`Custom endpoint limit reached: max ${MAX_CUSTOM_ENDPOINT_COUNT}`);
      }
      const canonical = canonicalBaseUrl(effectiveUrl) || effectiveUrl;
      const minted: CustomEndpoint = {
        id: this.generateCustomEndpointId(endpoints),
        name: defaultCustomEndpointName(canonical),
        protocol: input.customProtocol,
        baseUrl: canonical,
        apiKey: input.apiKey ?? '',
        updatedAt: nowISO(),
      };
      endpoints.push(minted);
      return { customEndpoints: endpoints, endpointId: minted.id };
    }

    // Catalog provider: one global slot, keyed exactly as before (design §4).
    const slot = profileKeyFromProvider(input.provider, defaultProtocolForProvider(input.provider));
    const existing = input.providerCredentials[slot];
    const apiKey = input.apiKey !== undefined ? input.apiKey : (existing?.apiKey ?? '');
    const baseUrl = trimmedBaseUrl !== undefined ? trimmedBaseUrl : existing?.baseUrl;
    const next: ProviderCredentials = { apiKey };
    if (baseUrl) next.baseUrl = baseUrl;
    input.providerCredentials[slot] = next;
    return { customEndpoints: input.customEndpoints, endpointId: input.endpointId };
  }

  /**
   * Forward a renderer-supplied `profiles` map into the global credential store.
   *
   * Phase 2a-only bridge. `handleSave` still sends the whole per-set profile map,
   * and ignoring it would lose a key the user just typed.
   *
   * **Scoped to the active slot on purpose.** Writing every non-empty slot looks
   * harmless but reverts key rotation: the renderer's map is a snapshot, so an
   * inactive slot can hold a value that was authoritative when the UI loaded and
   * is stale by the time the user saves. A save of set A would then overwrite a
   * key rotated on set B. Only the slot the save is actually about is written; the
   * others are already mirrored back from the store by `projectFromConfigSet`.
   *
   * Empty values never overwrite a populated one — the renderer sends all eight
   * builtin slots on every save, most of them blank.
   */
  private applyProfilesToCredentials(
    profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>,
    providerCredentials: ProviderCredentialMap,
    customEndpoints: CustomEndpoint[],
    activeSlot: ProviderProfileKey
  ): void {
    for (const [rawKey, profile] of Object.entries(profiles)) {
      if (!isProfileKey(rawKey) || !profile) continue;
      if (rawKey !== activeSlot) continue; // see the note above — scoped write
      const key = rawKey as ProviderProfileKey;
      const apiKey = typeof profile.apiKey === 'string' ? profile.apiKey : '';
      const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';

      if (rawKey.startsWith('custom:')) {
        if (!baseUrl) continue;
        const { customProtocol } = profileKeyToProvider(key);
        if (!isCustomProtocol(customProtocol)) continue;
        const target = customEndpoints.find(
          (candidate) =>
            customEndpointKey(candidate.protocol, candidate.baseUrl) ===
            customEndpointKey(customProtocol, baseUrl)
        );
        if (target && apiKey.trim() && target.apiKey !== apiKey) {
          target.apiKey = apiKey;
          target.updatedAt = nowISO();
        }
        continue;
      }

      const defaultBaseUrl = this.getDefaultProfile(key).baseUrl || '';
      const hasKey = Boolean(apiKey.trim());
      const hasOwnBaseUrl =
        Boolean(baseUrl) && canonicalBaseUrl(baseUrl) !== canonicalBaseUrl(defaultBaseUrl);
      if (!hasKey && !hasOwnBaseUrl) continue;

      const existing = providerCredentials[key];
      const next: ProviderCredentials = {
        apiKey: hasKey ? apiKey : (existing?.apiKey ?? ''),
      };
      const effectiveBaseUrl = hasOwnBaseUrl ? baseUrl : existing?.baseUrl;
      if (effectiveBaseUrl) next.baseUrl = effectiveBaseUrl;
      providerCredentials[key] = next;
    }
  }

  /** Mint an unused custom-endpoint id, mirroring generateConfigSetId. */
  private generateCustomEndpointId(existing: CustomEndpoint[]): string {
    const used = new Set(existing.map((endpoint) => endpoint.id));
    let index = existing.length + 1;
    let candidate = `${CUSTOM_ENDPOINT_ID_PREFIX}${index}`;
    while (used.has(candidate)) {
      index += 1;
      candidate = `${CUSTOM_ENDPOINT_ID_PREFIX}${index}`;
    }
    return candidate;
  }

  /**
   * Collect the protocol+URL keys that config sets' legacy `custom:*` profiles
   * describe. Phase 2a only — removed with `profiles` in Phase 2b.
   */
  private customEndpointKeysFromProfiles(configSets: ApiConfigSet[]): Set<string> {
    const keys = new Set<string>();
    for (const set of configSets) {
      for (const [rawKey, profile] of Object.entries(set.profiles || {})) {
        if (!isProfileKey(rawKey) || !rawKey.startsWith('custom:') || !profile) continue;
        const url = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
        if (!url) continue;
        const { customProtocol } = profileKeyToProvider(rawKey as ProviderProfileKey);
        if (!isCustomProtocol(customProtocol)) continue;
        keys.add(customEndpointKey(customProtocol, url));
      }
    }
    return keys;
  }

  /**
   * Re-derive endpoints for a config-set write, then evict only the **stale
   * derived twin** a profile URL edit leaves behind.
   *
   * The single eviction policy for `update()`. Getting the predicate wrong here
   * destroys credentials: an endpoint created through the CRUD API is by design
   * unreferenced and has no legacy profile, so a predicate of "unreferenced and
   * undescribed" deletes it and its API key on the next `handleSave`. An endpoint
   * is therefore pruned only when **a profile used to describe it and no longer
   * does** — which is exactly the gateway-URL-edit case, and nothing else.
   *
   * Without eviction, repeatedly editing a URL accumulates entries until
   * `MAX_CUSTOM_ENDPOINT_COUNT` starts evicting live ones.
   */
  private evictStaleDerivedEndpoints(
    priorConfigSets: ApiConfigSet[],
    nextConfigSets: ApiConfigSet[],
    activeConfigSetId: string,
    endpoints: CustomEndpoint[]
  ): CustomEndpoint[] {
    // Keys a profile described *before* this write. Only these are candidates:
    // anything never described by a profile is user-created and untouchable.
    const priorProfileKeys = this.customEndpointKeysFromProfiles(priorConfigSets);
    const derived = this.deriveCustomEndpoints(nextConfigSets, activeConfigSetId, endpoints);
    const nextProfileKeys = this.customEndpointKeysFromProfiles(nextConfigSets);
    const referencedIds = new Set(
      nextConfigSets
        .filter((set) => set.provider === 'custom' && set.endpointId)
        .map((set) => set.endpointId as string)
    );

    return derived.filter((endpoint) => {
      if (referencedIds.has(endpoint.id)) return true;
      const key = customEndpointKey(endpoint.protocol, endpoint.baseUrl);
      if (nextProfileKeys.has(key)) return true;
      // Prune only a former profile-derived entry that no profile names any more.
      return !priorProfileKeys.has(key);
    });
  }

  /**
   * Resolve the credential a config set should run with — the single seam the
   * whole design turns on (§4).
   *
   * Precedence, in order:
   * 1. `customEndpoints[set.endpointId]` when `provider === 'custom'`. The
   *    endpoint also supplies the routing `protocol`, since for a custom
   *    gateway the user chooses it.
   * 2. `providerCredentials[profileKeyFromProvider(provider, protocol)]`.
   * 3. **Empty** — `apiKey: ''`, no `baseUrl`. Never a value belonging to a
   *    different provider. A set pointing at an unconfigured provider must fail
   *    loudly downstream (`hasAnyUsableCredentials`, the diagnostics panel)
   *    rather than silently borrow someone else's key.
   *
   * `baseUrl` falls back to the slot default so builtin providers keep their
   * preset endpoint (`https://api.anthropic.com`, `http://localhost:11434/v1`)
   * when the credential carries no override. It is **always a string, never
   * `undefined`** — the value lands on `AppConfig.baseUrl`, and electron-store
   * persists via JSON, which rejects undefined. A native provider has no default
   * base URL, so this is the exact path that once crashed `config.save`.
   */
  private resolveCredentials(
    set: Pick<ApiConfigSet, 'provider' | 'endpointId' | 'customProtocol'>,
    providerCredentials: ProviderCredentialMap,
    customEndpoints: CustomEndpoint[]
  ): { apiKey: string; baseUrl: string; customProtocol: CustomProtocolType } {
    const provider = set.provider;

    if (provider === 'custom') {
      const endpointId = toNonEmptyString(set.endpointId);
      const endpoint = endpointId
        ? customEndpoints.find((candidate) => candidate.id === endpointId)
        : undefined;
      if (endpoint) {
        return {
          apiKey: endpoint.apiKey,
          // '' not undefined — see the note on the catalog branch below.
          baseUrl: endpoint.baseUrl || '',
          customProtocol: endpoint.protocol,
        };
      }
      // A custom set with a dangling or absent endpointId resolves empty rather
      // than falling through to a catalog slot: 'custom' has no slot of its own,
      // and borrowing `custom:<protocol>` would resurrect the per-set behaviour
      // this design removes.
      return {
        apiKey: '',
        baseUrl: '',
        customProtocol: isCustomProtocol(set.customProtocol)
          ? set.customProtocol
          : defaultProtocolForProvider(provider),
      };
    }

    const customProtocol = defaultProtocolForProvider(provider);
    const slot = profileKeyFromProvider(provider, customProtocol);
    const credential = providerCredentials[slot];
    // Coerce to '' — never undefined. This value reaches `AppConfig.baseUrl`,
    // which electron-store persists as JSON and which rejects undefined, so a
    // native provider (no default base URL) would crash config.save. Regression
    // guard: see tests/config-store-profiles.test.ts.
    const fallbackBaseUrl = this.getDefaultProfile(slot).baseUrl || '';

    if (!credential) {
      return { apiKey: '', baseUrl: fallbackBaseUrl, customProtocol };
    }
    return {
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl || fallbackBaseUrl,
      customProtocol,
    };
  }

  private normalizeLegacyProjection(raw: Partial<AppConfig>): {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    enableThinking: boolean;
    thinkingLevel: ModelThinkingLevel;
  } {
    const provider = normalizeProviderId(raw.provider) ?? defaultConfig.provider;
    const customProtocol: CustomProtocolType = isCustomProtocol(raw.customProtocol)
      ? raw.customProtocol
      : defaultProtocolForProvider(provider);
    const derivedProfileKey = profileKeyFromProvider(provider, customProtocol);

    const hasAnyRawProfiles = Boolean(raw.profiles && Object.keys(raw.profiles).length > 0);
    const hasProfileUserData = PROFILE_KEYS.some((key) => {
      const rawProfile = raw.profiles?.[key];
      if (!rawProfile) {
        return false;
      }
      const fallback = this.getDefaultProfile(key);
      if (typeof rawProfile.apiKey === 'string' && rawProfile.apiKey.trim()) {
        return true;
      }
      if (
        typeof rawProfile.baseUrl === 'string' &&
        rawProfile.baseUrl.trim() &&
        rawProfile.baseUrl.trim() !== fallback.baseUrl
      ) {
        return true;
      }
      if (
        typeof rawProfile.model === 'string' &&
        rawProfile.model.trim() &&
        rawProfile.model.trim() !== fallback.model
      ) {
        return true;
      }
      return false;
    });
    const shouldUseLegacyProjection = !hasAnyRawProfiles || !hasProfileUserData;

    let activeProfileKey: ProviderProfileKey = shouldUseLegacyProjection
      ? derivedProfileKey
      : isProfileKey(raw.activeProfileKey)
        ? raw.activeProfileKey
        : derivedProfileKey;

    const profiles = this.cloneProfiles(raw.profiles);
    const hasLegacyProjection =
      typeof raw.apiKey === 'string' ||
      typeof raw.baseUrl === 'string' ||
      typeof raw.model === 'string';

    if (shouldUseLegacyProjection && hasLegacyProjection) {
      profiles[derivedProfileKey] = this.normalizeProfile(derivedProfileKey, {
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
        model: typeof raw.model === 'string' ? raw.model : undefined,
      });
      activeProfileKey = derivedProfileKey;
    }

    if (
      activeProfileKey === 'custom:openai' &&
      isOllamaLegacyCustomOpenAIConfig({
        provider,
        customProtocol,
        baseUrl: profiles['custom:openai']?.baseUrl,
      })
    ) {
      profiles.ollama = this.normalizeProfile('ollama', profiles['custom:openai']);
    }

    if (!profiles[activeProfileKey]) {
      activeProfileKey = derivedProfileKey;
    }

    const thinkingLevel = resolveThinkingLevelFromRaw(raw.thinkingLevel, raw.enableThinking);
    return {
      provider,
      customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: thinkingLevel !== 'off',
      thinkingLevel,
    };
  }

  /**
   * Turn a config set into runtime configuration — one of the two seams the
   * whole design turns on (§4).
   *
   * Phase 2a: credentials now come from `resolveCredentials` (global map or the
   * referenced custom endpoint), **not** from the set's `profiles`. Model
   * selection comes from the set itself, where it was hoisted. `profiles` is
   * still cloned onto the projection because the renderer reads it until Phase
   * 2b; it is output only and no longer feeds any credential decision.
   */
  private projectFromConfigSet(
    configSet: ApiConfigSet,
    providerCredentials: ProviderCredentialMap,
    customEndpoints: CustomEndpoint[]
  ): {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    apiKey: string;
    baseUrl?: string;
    model: string;
    contextWindow?: number;
    maxTokens?: number;
    enableThinking: boolean;
    thinkingLevel: ModelThinkingLevel;
  } {
    const resolved = this.resolveCredentials(configSet, providerCredentials, customEndpoints);
    const thinkingLevel = resolveThinkingLevelFromRaw(
      configSet.thinkingLevel,
      configSet.enableThinking
    );
    // Legacy mirrors, kept byte-compatible for the renderer until Phase 2b.
    //
    // **Every** slot is overlaid from the authoritative store, not just the
    // active one. The renderer hydrates its whole `profiles` map from here and
    // sends it all back on save, so a stale inactive slot would be written over
    // the global credential and silently revert a key rotated while a different
    // provider was active — the exact failure this phase exists to prevent.
    const activeProfileKey = profileKeyFromProvider(configSet.provider, resolved.customProtocol);
    const profiles = this.cloneProfiles(configSet.profiles);
    for (const slot of Object.keys(profiles) as ProviderProfileKey[]) {
      if (slot.startsWith('custom:')) continue; // handled below, keyed by endpoint
      const credential = providerCredentials[slot];
      if (!credential) continue;
      profiles[slot] = this.normalizeProfile(slot, {
        ...profiles[slot],
        apiKey: credential.apiKey,
        baseUrl: credential.baseUrl || profiles[slot]?.baseUrl,
      });
    }
    // `custom:*` slots mirror the endpoint matching their protocol + URL, so a
    // key changed through `updateCustomEndpoint` cannot be reverted either.
    for (const slot of Object.keys(profiles) as ProviderProfileKey[]) {
      if (!slot.startsWith('custom:')) continue;
      const slotUrl = profiles[slot]?.baseUrl?.trim();
      if (!slotUrl) continue;
      const { customProtocol } = profileKeyToProvider(slot);
      if (!isCustomProtocol(customProtocol)) continue;
      const match = customEndpoints.find(
        (endpoint) =>
          customEndpointKey(endpoint.protocol, endpoint.baseUrl) ===
          customEndpointKey(customProtocol, slotUrl)
      );
      if (!match) continue;
      profiles[slot] = this.normalizeProfile(slot, { ...profiles[slot], apiKey: match.apiKey });
    }
    profiles[activeProfileKey] = this.normalizeProfile(activeProfileKey, {
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      model: configSet.model,
      contextWindow: configSet.contextWindow,
      maxTokens: configSet.maxTokens,
    });

    return {
      provider: configSet.provider,
      customProtocol: resolved.customProtocol,
      activeProfileKey,
      profiles,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      model: configSet.model,
      contextWindow: configSet.contextWindow,
      maxTokens: configSet.maxTokens,
      enableThinking: thinkingLevel !== 'off',
      thinkingLevel,
    };
  }

  private normalizeConfigSet(
    rawSet: Partial<ApiConfigSet> | undefined,
    fallback: {
      id: string;
      name: string;
      provider: ProviderType;
      customProtocol: CustomProtocolType;
      activeProfileKey: ProviderProfileKey;
      profiles: Record<ProviderProfileKey, ProviderProfile>;
      enableThinking: boolean;
      thinkingLevel: ModelThinkingLevel;
      isSystem?: boolean;
    }
  ): ApiConfigSet {
    const provider = normalizeProviderId(rawSet?.provider) ?? fallback.provider;
    const customProtocol: CustomProtocolType = isCustomProtocol(rawSet?.customProtocol)
      ? rawSet.customProtocol
      : defaultProtocolForProvider(provider);

    const derivedProfileKey = profileKeyFromProvider(provider, customProtocol);
    const activeProfileKey = isProfileKey(rawSet?.activeProfileKey)
      ? rawSet.activeProfileKey
      : fallback.activeProfileKey || derivedProfileKey;

    const profiles = this.cloneProfiles(rawSet?.profiles || fallback.profiles);

    if (!profiles[activeProfileKey]) {
      profiles[activeProfileKey] = this.getDefaultProfile(activeProfileKey);
    }

    const id = toNonEmptyString(rawSet?.id) || fallback.id;
    const name = toNonEmptyString(rawSet?.name) || fallback.name;
    const updatedAt = toNonEmptyString(rawSet?.updatedAt) || nowISO();

    // `endpointId` only means something for a custom set. Preserved verbatim
    // here; legacy sets that predate it get linked to a derived endpoint by
    // `linkCustomEndpointIds`, which runs once the endpoint list exists.
    const endpointId = provider === 'custom' ? toNonEmptyString(rawSet?.endpointId) : null;

    // Hoist model selection out of `profiles` (design §3.3). A set written before
    // the split has no top-level `model`, so fall back to the active profile's —
    // that is the migration. `cloneProfiles` has already substituted the slot
    // default for an empty model, so this is never blank for a known slot.
    const legacyActive = profiles[activeProfileKey];
    const model =
      typeof rawSet?.model === 'string' && rawSet.model.trim()
        ? rawSet.model.trim()
        : legacyActive?.model || '';
    const contextWindow =
      typeof rawSet?.contextWindow === 'number' && rawSet.contextWindow > 0
        ? rawSet.contextWindow
        : legacyActive?.contextWindow;
    const maxTokens =
      typeof rawSet?.maxTokens === 'number' && rawSet.maxTokens > 0
        ? rawSet.maxTokens
        : legacyActive?.maxTokens;

    // Only treat rawSet.thinkingLevel as 'present' when it's a recognized valid level.
    // Invalid/unknown strings (e.g. future levels from a newer pi-ai) fall through to
    // the enableThinking migration or the fallback, preserving user intent.
    const rawThinkingLevelValid =
      rawSet?.thinkingLevel !== undefined &&
      (THINKING_LEVELS as readonly string[]).includes(rawSet.thinkingLevel as string);
    const thinkingLevel = resolveThinkingLevelFromRaw(
      rawThinkingLevelValid ? rawSet!.thinkingLevel : undefined,
      rawSet?.enableThinking
    );
    // fallback.thinkingLevel may be undefined (intentionally absent from defaults);
    // coalesce to 'off' so resolvedThinkingLevel is always a valid ModelThinkingLevel.
    const fallbackThinkingLevel: ModelThinkingLevel =
      fallback.thinkingLevel ?? (fallback.enableThinking ? 'medium' : 'off');
    const resolvedThinkingLevel: ModelThinkingLevel =
      rawThinkingLevelValid || rawSet?.enableThinking !== undefined
        ? thinkingLevel
        : fallbackThinkingLevel;
    return {
      id,
      name,
      isSystem: toBoolean(rawSet?.isSystem, Boolean(fallback.isSystem)),
      provider,
      ...(endpointId ? { endpointId } : {}),
      model,
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
      customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: resolvedThinkingLevel !== 'off',
      thinkingLevel: resolvedThinkingLevel,
      updatedAt,
    };
  }

  private makeDefaultConfigSetFromLegacy(legacy: {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    enableThinking: boolean;
    thinkingLevel: ModelThinkingLevel;
  }): ApiConfigSet {
    return this.normalizeConfigSet(
      {
        id: DEFAULT_CONFIG_SET_ID,
        name: defaultConfigSet.name,
        isSystem: true,
        provider: legacy.provider,
        customProtocol: legacy.customProtocol,
        activeProfileKey: legacy.activeProfileKey,
        profiles: legacy.profiles,
        enableThinking: legacy.enableThinking,
        thinkingLevel: legacy.thinkingLevel,
        updatedAt: nowISO(),
      },
      {
        id: DEFAULT_CONFIG_SET_ID,
        name: defaultConfigSet.name,
        isSystem: true,
        provider: legacy.provider,
        customProtocol: legacy.customProtocol,
        activeProfileKey: legacy.activeProfileKey,
        profiles: legacy.profiles,
        enableThinking: legacy.enableThinking,
        thinkingLevel: legacy.thinkingLevel,
      }
    );
  }

  private normalizeConfigSets(
    rawSets: unknown,
    legacy: {
      provider: ProviderType;
      customProtocol: CustomProtocolType;
      activeProfileKey: ProviderProfileKey;
      profiles: Record<ProviderProfileKey, ProviderProfile>;
      enableThinking: boolean;
      thinkingLevel: ModelThinkingLevel;
    }
  ): ApiConfigSet[] {
    const list = Array.isArray(rawSets) ? rawSets : [];
    if (list.length === 0) {
      return [this.makeDefaultConfigSetFromLegacy(legacy)];
    }

    const normalized: ApiConfigSet[] = [];
    const usedIds = new Set<string>();

    for (let index = 0; index < list.length; index += 1) {
      const rawSet = (list[index] || {}) as Partial<ApiConfigSet>;
      const seedId = toNonEmptyString(rawSet.id) || `set-${index + 1}`;
      let nextId = seedId;
      let suffix = 2;
      while (usedIds.has(nextId)) {
        nextId = `${seedId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(nextId);

      const normalizedSet = this.normalizeConfigSet(rawSet, {
        id: nextId,
        name: toNonEmptyString(rawSet.name) || `方案 ${index + 1}`,
        provider: legacy.provider,
        customProtocol: legacy.customProtocol,
        activeProfileKey: legacy.activeProfileKey,
        profiles: legacy.profiles,
        enableThinking: legacy.enableThinking,
        thinkingLevel: legacy.thinkingLevel,
        isSystem: Boolean(rawSet.isSystem),
      });
      normalizedSet.id = nextId;
      normalized.push(normalizedSet);
    }

    const hasSystemSet = normalized.some((set) => set.isSystem);
    if (!hasSystemSet) {
      normalized.unshift(this.makeDefaultConfigSetFromLegacy(legacy));
    }

    return normalized;
  }

  private hasLegacySignal(legacy: {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    enableThinking: boolean;
    thinkingLevel: ModelThinkingLevel;
  }): boolean {
    if (
      legacy.provider !== defaultConfig.provider ||
      legacy.customProtocol !== (defaultConfig.customProtocol || 'anthropic') ||
      legacy.activeProfileKey !== defaultConfig.activeProfileKey ||
      (legacy.thinkingLevel ?? (legacy.enableThinking ? 'medium' : 'off')) !==
        (defaultConfig.thinkingLevel ?? 'off')
    ) {
      return true;
    }

    const fallbackActive = this.getDefaultProfile(legacy.activeProfileKey);
    const activeProfile = legacy.profiles[legacy.activeProfileKey] ?? fallbackActive;
    return Boolean(
      activeProfile.apiKey.trim() ||
      (activeProfile.baseUrl || '') !== (fallbackActive.baseUrl || '') ||
      activeProfile.model !== fallbackActive.model
    );
  }

  private shouldPreferLegacyConfigSetProjection(
    normalizedSets: ApiConfigSet[],
    legacy: {
      provider: ProviderType;
      customProtocol: CustomProtocolType;
      activeProfileKey: ProviderProfileKey;
      profiles: Record<ProviderProfileKey, ProviderProfile>;
      enableThinking: boolean;
      thinkingLevel: ModelThinkingLevel;
    }
  ): boolean {
    if (!this.hasLegacySignal(legacy)) {
      return false;
    }
    if (normalizedSets.length !== 1) {
      return false;
    }

    const onlySet = normalizedSets[0];
    if (!(onlySet.id === DEFAULT_CONFIG_SET_ID && onlySet.isSystem)) {
      return false;
    }

    // Compare against a projection resolved from this one set's own credentials,
    // so the check stays self-consistent with how the set would actually run.
    const onlyCredentials = this.deriveProviderCredentials([onlySet], onlySet.id);
    const onlyEndpoints = this.deriveCustomEndpoints([onlySet], onlySet.id, undefined);
    const linked = this.linkCustomEndpointIds([onlySet], onlyEndpoints)[0];
    const projected = this.projectFromConfigSet(linked, onlyCredentials, onlyEndpoints);
    const legacyActive =
      legacy.profiles[legacy.activeProfileKey] ?? this.getDefaultProfile(legacy.activeProfileKey);
    return !(
      projected.provider === legacy.provider &&
      projected.customProtocol === legacy.customProtocol &&
      projected.activeProfileKey === legacy.activeProfileKey &&
      projected.thinkingLevel ===
        (legacy.thinkingLevel ?? (legacy.enableThinking ? 'medium' : 'off')) &&
      projected.apiKey === legacyActive.apiKey &&
      (projected.baseUrl || '') === (legacyActive.baseUrl || '') &&
      projected.model === legacyActive.model
    );
  }

  private normalizeConfig(
    rawConfig: Partial<AppConfig> | undefined,
    isFreshInstall?: boolean
  ): AppConfig {
    const raw = rawConfig || {};
    const legacy = this.normalizeLegacyProjection(raw);
    const normalizedFromRaw = this.normalizeConfigSets(raw.configSets, legacy);
    const preLinkSets = this.shouldPreferLegacyConfigSetProjection(normalizedFromRaw, legacy)
      ? [this.makeDefaultConfigSetFromLegacy(legacy)]
      : normalizedFromRaw;

    const requestedActiveSetId = toNonEmptyString(raw.activeConfigSetId);
    const activeConfigSetId = preLinkSets.some((set) => set.id === requestedActiveSetId)
      ? (requestedActiveSetId as string)
      : preLinkSets[0].id;

    // Credentials and endpoints must exist before the projection can resolve
    // anything, and before legacy custom sets can be linked to an endpoint id.
    const providerCredentials = this.deriveProviderCredentials(
      preLinkSets,
      activeConfigSetId,
      raw.providerCredentials
    );
    const customEndpoints = this.deriveCustomEndpoints(
      preLinkSets,
      activeConfigSetId,
      raw.customEndpoints
    );
    const configSets = this.linkCustomEndpointIds(preLinkSets, customEndpoints);

    const activeConfigSet = configSets.find((set) => set.id === activeConfigSetId) || configSets[0];
    const projected = this.projectFromConfigSet(
      activeConfigSet,
      providerCredentials,
      customEndpoints
    );

    const result: AppConfig = {
      provider: projected.provider,
      customProtocol: projected.customProtocol,
      apiKey: projected.apiKey,
      baseUrl: projected.baseUrl,
      model: projected.model,
      ...(typeof projected.contextWindow === 'number'
        ? { contextWindow: projected.contextWindow }
        : {}),
      ...(typeof projected.maxTokens === 'number' ? { maxTokens: projected.maxTokens } : {}),
      activeProfileKey: projected.activeProfileKey,
      profiles: projected.profiles,
      // Phase 2a: authoritative for credential resolution. Still *derived* from
      // the sets' legacy `profiles` on read, so a pre-split config migrates
      // without a schema bump (design §5); Phase 2b removes that input once the
      // renderer stops writing it.
      providerCredentials,
      customEndpoints,
      activeConfigSetId,
      configSets,
      claudeCodePath:
        typeof raw.claudeCodePath === 'string' ? raw.claudeCodePath : defaultConfig.claudeCodePath,
      defaultWorkdir:
        typeof raw.defaultWorkdir === 'string' ? raw.defaultWorkdir : defaultConfig.defaultWorkdir,
      globalSkillsPath:
        typeof raw.globalSkillsPath === 'string'
          ? raw.globalSkillsPath
          : defaultConfig.globalSkillsPath,
      localDevPath:
        typeof raw.localDevPath === 'string' ? raw.localDevPath : defaultConfig.localDevPath,
      systemPromptFile: isValidSystemPromptFileChoice(raw.systemPromptFile)
        ? raw.systemPromptFile
        : defaultConfig.systemPromptFile,
      // By the time normalizeConfig runs, ensureNormalized has already:
      //   - parsed the on-disk JSON for authoritative key presence
      //   - run migrateFromLegacy (for version-0 installs)
      //   - stamped configSchemaVersion: 1 and written the migrated values
      // So we can read the new fields directly without migration logic here.
      systemPromptFileEnabled: toBoolean(
        raw.systemPromptFileEnabled,
        defaultConfig.systemPromptFileEnabled
      ),
      systemPromptFilePriority: normalizeSystemPromptPriority(raw.systemPromptFilePriority),
      bashTrustedCommands: toStringArray(raw.bashTrustedCommands),
      bashDenylist: toStringArray(raw.bashDenylist),
      trustedDirectories: sanitizeTrustedDirectories(raw.trustedDirectories),
      enableDevLogs: toBoolean(raw.enableDevLogs, defaultConfig.enableDevLogs),
      theme: isAppTheme(raw.theme) ? raw.theme : defaultConfig.theme,
      sandboxEnabled: toBoolean(raw.sandboxEnabled, defaultConfig.sandboxEnabled),
      memoryEnabled: toBoolean(raw.memoryEnabled, defaultConfig.memoryEnabled),
      memoryRuntime: normalizeMemoryRuntimeConfig(
        raw.memoryRuntime,
        typeof raw.configSchemaVersion === 'number' ? raw.configSchemaVersion : 0,
        isFreshInstall
      ),
      enableThinking: projected.enableThinking,
      thinkingLevel: projected.thinkingLevel,
      isConfigured: toBoolean(raw.isConfigured, defaultConfig.isConfigured),
      configSchemaVersion:
        typeof raw.configSchemaVersion === 'number' && raw.configSchemaVersion >= 2
          ? 2
          : raw.configSchemaVersion === 1
            ? 1
            : 0,
      schedulerCatchUpPolicy: normalizeCatchUpPolicy(raw.schedulerCatchUpPolicy),
      schedulerConflictPolicy: isValidConflictPolicy(raw.schedulerConflictPolicy)
        ? raw.schedulerConflictPolicy
        : defaultConfig.schedulerConflictPolicy,
      schedulerRunHistoryDepth: normalizeRunHistoryDepth(raw.schedulerRunHistoryDepth),
      permissionTimeoutSeconds: normalizePermissionTimeout(raw.permissionTimeoutSeconds),
      mcpToolTimeoutSeconds: normalizeMcpToolTimeout(raw.mcpToolTimeoutSeconds),
      notificationsEnabled: toBoolean(raw.notificationsEnabled, defaultConfig.notificationsEnabled),
      skillConflictConfig: normalizeSkillConflictConfig(raw.skillConflictConfig),
      orphanDismissals: normalizeOrphanDismissals(raw.orphanDismissals),
      ...(typeof raw.httpProxy === 'string' && raw.httpProxy.trim()
        ? { httpProxy: raw.httpProxy.trim() }
        : {}),
    };
    this.normalizeModelIds(result);
    return result;
  }

  private cloneConfigSet(configSet: ApiConfigSet): ApiConfigSet {
    return {
      ...configSet,
      profiles: this.cloneProfiles(configSet.profiles),
      updatedAt: toNonEmptyString(configSet.updatedAt) || nowISO(),
    };
  }

  private saveConfig(config: AppConfig): void {
    const normalized = this.normalizeConfig(config);
    this.store.set(normalized);
  }

  /**
   * Build the projected `AppConfig` for a given set list + active id.
   *
   * Phase 2a: credentials are passed in explicitly rather than derived here.
   * `update()` is the one caller that mutates them, and it must be able to hand
   * over the post-write map — re-deriving from `profiles` at this point would
   * discard the write it just made.
   */
  private composeProjectedConfig(
    base: AppConfig,
    nextConfigSets: ApiConfigSet[],
    requestedActiveConfigSetId: string,
    credentials?: { providerCredentials: ProviderCredentialMap; customEndpoints: CustomEndpoint[] }
  ): AppConfig {
    const activeConfigSet =
      nextConfigSets.find((set) => set.id === requestedActiveConfigSetId) || nextConfigSets[0];
    const providerCredentials =
      credentials?.providerCredentials ??
      this.deriveProviderCredentials(nextConfigSets, activeConfigSet.id, base.providerCredentials);
    const customEndpoints =
      credentials?.customEndpoints ??
      this.deriveCustomEndpoints(nextConfigSets, activeConfigSet.id, base.customEndpoints);
    const linkedSets = this.linkCustomEndpointIds(nextConfigSets, customEndpoints);
    const linkedActive = linkedSets.find((set) => set.id === activeConfigSet.id) || linkedSets[0];
    const projected = this.projectFromConfigSet(linkedActive, providerCredentials, customEndpoints);
    return {
      ...base,
      provider: projected.provider,
      customProtocol: projected.customProtocol,
      apiKey: projected.apiKey,
      baseUrl: projected.baseUrl,
      model: projected.model,
      activeProfileKey: projected.activeProfileKey,
      profiles: projected.profiles,
      providerCredentials,
      customEndpoints,
      enableThinking: projected.enableThinking,
      thinkingLevel: projected.thinkingLevel,
      activeConfigSetId: linkedActive.id,
      configSets: linkedSets,
    };
  }

  private buildUniqueConfigSetName(
    name: string,
    existingSets: ApiConfigSet[],
    excludeId?: string
  ): string {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Config set name is required');
    }

    const usedNames = new Set(
      existingSets.filter((set) => set.id !== excludeId).map((set) => set.name)
    );

    if (!usedNames.has(trimmed)) {
      return trimmed;
    }

    let suffix = 2;
    let candidate = `${trimmed} (${suffix})`;
    while (usedNames.has(candidate) && suffix <= 100) {
      suffix += 1;
      candidate = `${trimmed} (${suffix})`;
    }
    return candidate;
  }

  private generateConfigSetId(existingSets: ApiConfigSet[]): ConfigSetId {
    let index = existingSets.length + 1;
    let candidate = `set-${index}`;
    const used = new Set(existingSets.map((set) => set.id));
    while (used.has(candidate)) {
      index += 1;
      candidate = `set-${index}`;
    }
    return candidate;
  }

  private buildBlankConfigSet(payload: {
    id: ConfigSetId;
    name: string;
    provider: ProviderType;
    customProtocol: CustomProtocolType;
  }): ApiConfigSet {
    const activeProfileKey = profileKeyFromProvider(payload.provider, payload.customProtocol);
    const profiles = this.cloneProfiles(undefined);
    const defaultProfile = this.getDefaultProfile(activeProfileKey);
    profiles[activeProfileKey] = this.normalizeProfile(activeProfileKey, {
      apiKey: '',
      baseUrl: defaultProfile.baseUrl,
      model: defaultProfile.model,
    });

    return {
      id: payload.id,
      name: payload.name,
      isSystem: false,
      provider: payload.provider,
      // A blank set starts on the provider's default model. It carries no
      // credential of its own — that now comes from the global map, which is the
      // entire point of the split (design §1.2, consequence 1).
      model: defaultProfile.model,
      customProtocol: payload.customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: false,
      thinkingLevel: 'off' as ModelThinkingLevel,
      updatedAt: nowISO(),
    };
  }

  /**
   * Get all config
   */
  getAll(): AppConfig {
    return this.normalizeConfig(this.store.store as Partial<AppConfig>);
  }

  /**
   * Get a specific config value
   */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    if (DIRECT_READ_KEYS.has(key)) {
      const rawValue = this.store.get(key as string) as AppConfig[K] | undefined;
      if (rawValue !== undefined) {
        // Per-field guards: reject raw values that fail type/range checks
        if (key === 'provider' && !isProviderType(rawValue)) {
          return defaultConfig[key];
        }
        if (key === 'customProtocol' && !isCustomProtocol(rawValue)) {
          return defaultConfig[key];
        }
        if (key === 'activeProfileKey' && !isProfileKey(rawValue)) {
          return defaultConfig[key];
        }
        if (key === 'theme' && !isAppTheme(rawValue)) {
          return defaultConfig[key];
        }
        if (
          (key === 'enableDevLogs' ||
            key === 'sandboxEnabled' ||
            key === 'memoryEnabled' ||
            key === 'enableThinking' ||
            key === 'isConfigured') &&
          typeof rawValue !== 'boolean'
        ) {
          return defaultConfig[key];
        }
        return rawValue;
      }
      return defaultConfig[key];
    }
    return this.getAll()[key];
  }

  /**
   * Set a specific config value
   */
  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.update({ [key]: value } as Partial<AppConfig>);
  }

  /**
   * Create a new named config set.
   * - mode=blank: create a fresh set from current provider/protocol defaults
   * - mode=clone: clone current/selected set
   */
  createSet(payload: CreateConfigSetPayload): AppConfig {
    const current = this.getAll();
    if (current.configSets.length >= MAX_CONFIG_SET_COUNT) {
      throw new Error(`Config set limit reached: max ${MAX_CONFIG_SET_COUNT}`);
    }

    const id = this.generateConfigSetId(current.configSets);
    const name = this.buildUniqueConfigSetName(payload.name, current.configSets);
    const mode: CreateSetMode = payload.mode === 'blank' ? 'blank' : 'clone';
    let newSet: ApiConfigSet;

    if (mode === 'blank') {
      const activeSet =
        current.configSets.find((set) => set.id === current.activeConfigSetId) ||
        current.configSets[0];
      const seedProvider = activeSet?.provider || current.provider;
      const seedProtocol: CustomProtocolType = normalizeCustomProtocol(
        activeSet?.customProtocol,
        defaultProtocolForProvider(seedProvider)
      );
      newSet = this.buildBlankConfigSet({
        id,
        name,
        provider: seedProvider,
        customProtocol: seedProtocol,
      });
    } else {
      const source =
        current.configSets.find((set) => set.id === payload.fromSetId) ||
        current.configSets.find((set) => set.id === current.activeConfigSetId) ||
        current.configSets[0];

      if (!source) {
        throw new Error('Config set clone source not found');
      }

      const cloned = this.cloneConfigSet(source);
      newSet = {
        ...cloned,
        id,
        name,
        isSystem: false,
        updatedAt: nowISO(),
      };
    }

    this.saveConfig({
      ...this.composeProjectedConfig(current, [...current.configSets, newSet], id),
    } as AppConfig);

    return this.getAll();
  }

  renameSet(payload: { id: string; name: string }): AppConfig {
    const current = this.getAll();
    const target = current.configSets.find((set) => set.id === payload.id);
    if (!target) {
      throw new Error('Config set not found');
    }

    const nextName = this.buildUniqueConfigSetName(payload.name, current.configSets, payload.id);
    const nextSets = current.configSets.map((set) => {
      if (set.id !== payload.id) {
        return this.cloneConfigSet(set);
      }
      return {
        ...this.cloneConfigSet(set),
        name: nextName,
        updatedAt: nowISO(),
      };
    });

    this.saveConfig(this.composeProjectedConfig(current, nextSets, current.activeConfigSetId));

    return this.getAll();
  }

  deleteSet(payload: { id: string }): AppConfig {
    const current = this.getAll();
    const target = current.configSets.find((set) => set.id === payload.id);
    if (!target) {
      throw new Error('Config set not found');
    }
    if (target.isSystem) {
      throw new Error('System config set cannot be deleted');
    }
    if (current.configSets.length <= 1) {
      throw new Error('At least one config set must be kept');
    }

    const nextSets = current.configSets
      .filter((set) => set.id !== payload.id)
      .map((set) => this.cloneConfigSet(set));

    const fallbackActive = nextSets.find((set) => set.isSystem)?.id || nextSets[0]?.id;
    const nextActiveConfigSetId =
      current.activeConfigSetId === payload.id ? fallbackActive : current.activeConfigSetId;

    this.saveConfig(this.composeProjectedConfig(current, nextSets, nextActiveConfigSetId));

    return this.getAll();
  }

  switchSet(payload: { id: string }): AppConfig {
    const current = this.getAll();
    if (!current.configSets.some((set) => set.id === payload.id)) {
      throw new Error('Config set not found');
    }

    this.saveConfig(this.composeProjectedConfig(current, current.configSets, payload.id));

    return this.getAll();
  }

  // -------------------------------------------------------------------------
  // Custom endpoint CRUD (design §3.2, §6.2)
  //
  // The only user-named credential object. Catalog providers need no CRUD — the
  // catalog already names them and `update({ apiKey })` writes their global slot.
  // -------------------------------------------------------------------------

  createCustomEndpoint(payload: {
    name: string;
    protocol: CustomProtocolType;
    baseUrl: string;
    apiKey?: string;
    defaultModel?: string;
  }): AppConfig {
    const current = this.getAll();
    if (current.customEndpoints.length >= MAX_CUSTOM_ENDPOINT_COUNT) {
      throw new Error(`Custom endpoint limit reached: max ${MAX_CUSTOM_ENDPOINT_COUNT}`);
    }
    const baseUrl = payload.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error('Endpoint base URL is required');
    }
    const protocol: CustomProtocolType = isCustomProtocol(payload.protocol)
      ? payload.protocol
      : 'anthropic';
    const canonical = canonicalBaseUrl(baseUrl) || baseUrl;
    const key = customEndpointKey(protocol, canonical);
    if (
      current.customEndpoints.some(
        (candidate) => customEndpointKey(candidate.protocol, candidate.baseUrl) === key
      )
    ) {
      throw new Error('An endpoint with this protocol and base URL already exists');
    }

    const endpoint: CustomEndpoint = {
      id: this.generateCustomEndpointId(current.customEndpoints),
      name: toNonEmptyString(payload.name) || defaultCustomEndpointName(canonical),
      protocol,
      baseUrl: canonical,
      apiKey: typeof payload.apiKey === 'string' ? payload.apiKey : '',
      updatedAt: nowISO(),
    };
    const defaultModel = toNonEmptyString(payload.defaultModel);
    if (defaultModel) endpoint.defaultModel = defaultModel;

    this.saveConfig({
      ...current,
      customEndpoints: [...current.customEndpoints, endpoint],
    });
    return this.getAll();
  }

  updateCustomEndpoint(payload: {
    id: string;
    name?: string;
    protocol?: CustomProtocolType;
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
  }): AppConfig {
    const current = this.getAll();
    const index = current.customEndpoints.findIndex((candidate) => candidate.id === payload.id);
    if (index < 0) {
      throw new Error('Custom endpoint not found');
    }
    const existing = current.customEndpoints[index];

    const protocol: CustomProtocolType = isCustomProtocol(payload.protocol)
      ? payload.protocol
      : existing.protocol;
    const rawBaseUrl = payload.baseUrl !== undefined ? payload.baseUrl.trim() : existing.baseUrl;
    if (!rawBaseUrl) {
      throw new Error('Endpoint base URL is required');
    }
    const baseUrl = canonicalBaseUrl(rawBaseUrl) || rawBaseUrl;

    // Renaming or re-pointing must not collide with another endpoint.
    const key = customEndpointKey(protocol, baseUrl);
    if (
      current.customEndpoints.some(
        (candidate) =>
          candidate.id !== payload.id &&
          customEndpointKey(candidate.protocol, candidate.baseUrl) === key
      )
    ) {
      throw new Error('An endpoint with this protocol and base URL already exists');
    }

    const next: CustomEndpoint = {
      ...existing,
      name:
        payload.name !== undefined
          ? toNonEmptyString(payload.name) || existing.name
          : existing.name,
      protocol,
      baseUrl,
      apiKey: payload.apiKey !== undefined ? payload.apiKey : existing.apiKey,
      updatedAt: nowISO(),
    };
    if (payload.defaultModel !== undefined) {
      const defaultModel = toNonEmptyString(payload.defaultModel);
      if (defaultModel) next.defaultModel = defaultModel;
      else delete next.defaultModel;
    }

    const nextEndpoints = [...current.customEndpoints];
    nextEndpoints[index] = next;
    this.saveConfig({ ...current, customEndpoints: nextEndpoints });
    return this.getAll();
  }

  /**
   * Delete a custom endpoint.
   *
   * **Refused while any config set references it** (design §3.2) — enforced here
   * in the store, not only in the UI, so an IPC caller cannot strand a set on a
   * dangling `endpointId`. The error names the sets so the UI can tell the user
   * what to change first.
   */
  deleteCustomEndpoint(payload: { id: string }): AppConfig {
    const current = this.getAll();
    const target = current.customEndpoints.find((candidate) => candidate.id === payload.id);
    if (!target) {
      throw new Error('Custom endpoint not found');
    }

    const referencing = current.configSets.filter(
      (set) => set.provider === 'custom' && set.endpointId === payload.id
    );
    if (referencing.length > 0) {
      throw new Error(
        `Endpoint is in use by config set(s): ${referencing.map((set) => set.name).join(', ')}`
      );
    }

    // Scrub the legacy `custom:*` mirrors that describe this endpoint. Without
    // this the delete appears to succeed and `deriveCustomEndpoints` resurrects it
    // (with a fresh id, and the key off the profile) on the very next read — the
    // leftover mirror of any set that once pointed here, including one since
    // switched to a catalog provider. Phase 2b removes this with `profiles`.
    const targetKey = customEndpointKey(target.protocol, target.baseUrl);
    const scrubbedSets = current.configSets.map((set) => {
      let changed = false;
      const profiles = { ...(set.profiles || {}) };
      for (const rawKey of Object.keys(profiles)) {
        if (!isProfileKey(rawKey) || !rawKey.startsWith('custom:')) continue;
        const slot = rawKey as ProviderProfileKey;
        const url = profiles[slot]?.baseUrl?.trim();
        if (!url) continue;
        const { customProtocol } = profileKeyToProvider(slot);
        if (!isCustomProtocol(customProtocol)) continue;
        if (customEndpointKey(customProtocol, url) !== targetKey) continue;
        profiles[slot] = this.normalizeProfile(slot, {
          ...profiles[slot],
          apiKey: '',
          baseUrl: this.getDefaultProfile(slot).baseUrl,
        });
        changed = true;
      }
      return changed ? { ...set, profiles } : set;
    });

    this.saveConfig({
      ...current,
      configSets: scrubbedSets,
      customEndpoints: current.customEndpoints.filter((candidate) => candidate.id !== payload.id),
    });
    return this.getAll();
  }

  /**
   * Update multiple config values
   */
  update(updates: Partial<AppConfig>): void {
    const current = this.getAll();
    let nextConfigSets = current.configSets.map((set) => this.cloneConfigSet(set));

    if (Array.isArray(updates.configSets) && updates.configSets.length > 0) {
      const normalizedSets = this.normalizeConfigSets(updates.configSets, {
        provider: current.provider,
        customProtocol: normalizeCustomProtocol(
          current.customProtocol,
          defaultProtocolForProvider(current.provider)
        ),
        activeProfileKey: current.activeProfileKey,
        profiles: this.cloneProfiles(current.profiles),
        enableThinking: current.enableThinking,
        thinkingLevel: current.thinkingLevel ?? 'off',
      });
      // A caller that rewrites a custom set's legacy `custom:*` profile URL means
      // to re-point that set. The pinned `endpointId` would otherwise win on read
      // (where it is authoritative), so the edit would vanish. Drop the pin only
      // when the incoming payload *itself* carries a contradicting URL — not when
      // the set's existing mirror merely differs, which is the normal state after
      // any CRUD change to the endpoint. Phase 2b removes this with `profiles`.
      const incomingById = new Map(
        updates.configSets
          .filter((set): set is ApiConfigSet => Boolean(set && typeof set.id === 'string'))
          .map((set) => [set.id, set])
      );
      nextConfigSets = normalizedSets.map((set) => {
        if (set.provider !== 'custom' || !set.endpointId) return set;
        const pinned = current.customEndpoints.find((endpoint) => endpoint.id === set.endpointId);
        if (!pinned) return set;
        const incoming = incomingById.get(set.id);
        const protocol = isCustomProtocol(set.customProtocol) ? set.customProtocol : 'anthropic';
        const slot = profileKeyFromProvider('custom', protocol) as ProviderProfileKey;
        const profileUrl = incoming?.profiles?.[slot]?.baseUrl?.trim();
        if (!profileUrl) return set;
        // Only a *changed* URL counts as intent to re-point. Callers routinely
        // echo the whole set back (handleSave, or any read-modify-write), and its
        // mirror legitimately differs from the endpoint after a CRUD edit —
        // treating that as a re-point would unpin the set on every save.
        const priorSet = current.configSets.find((candidate) => candidate.id === set.id);
        const priorUrl = priorSet?.profiles?.[slot]?.baseUrl?.trim();
        if (
          priorUrl &&
          customEndpointKey(protocol, profileUrl) === customEndpointKey(protocol, priorUrl)
        ) {
          return set;
        }
        if (
          customEndpointKey(protocol, profileUrl) ===
          customEndpointKey(pinned.protocol, pinned.baseUrl)
        ) {
          return set;
        }
        const repointed: ApiConfigSet = { ...set };
        delete repointed.endpointId;
        return repointed;
      });
    }

    const requestedActiveConfigSetId =
      toNonEmptyString(updates.activeConfigSetId) || current.activeConfigSetId;
    const activeConfigSetId = nextConfigSets.some((set) => set.id === requestedActiveConfigSetId)
      ? requestedActiveConfigSetId
      : nextConfigSets[0].id;

    const targetIndex = nextConfigSets.findIndex((set) => set.id === activeConfigSetId);
    const targetSet =
      targetIndex >= 0
        ? this.cloneConfigSet(nextConfigSets[targetIndex])
        : this.cloneConfigSet(nextConfigSets[0]);

    const nextProfiles = this.cloneProfiles(targetSet.profiles);
    let nextActiveProfileKey = targetSet.activeProfileKey;
    let nextProvider = targetSet.provider;
    let nextEndpointId = targetSet.endpointId;
    let nextCustomProtocol: CustomProtocolType = normalizeCustomProtocol(
      targetSet.customProtocol,
      defaultProtocolForProvider(targetSet.provider)
    );
    let nextModel = targetSet.model;
    let nextContextWindow = targetSet.contextWindow;
    let nextMaxTokens = targetSet.maxTokens;

    // Phase 2a: credential writes leave the config set. These start from the
    // current global state and are handed to composeProjectedConfig, so a write
    // is not discarded by a re-derivation from `profiles` (design §4.1).
    const nextProviderCredentials: ProviderCredentialMap = { ...current.providerCredentials };
    let nextCustomEndpoints: CustomEndpoint[] = current.customEndpoints.map((endpoint) => ({
      ...endpoint,
    }));

    // When the payload rewrites config sets, their legacy `custom:*` profiles may
    // name a gateway no endpoint covers yet. Re-derive so such a URL mints an
    // endpoint rather than resolving to an empty credential; explicitly persisted
    // entries are preserved by `deriveCustomEndpoints` itself.
    if (Array.isArray(updates.configSets) && updates.configSets.length > 0) {
      nextCustomEndpoints = this.evictStaleDerivedEndpoints(
        current.configSets,
        nextConfigSets,
        activeConfigSetId,
        nextCustomEndpoints
      );
    }

    const mutatesActiveSet =
      updates.profiles !== undefined ||
      updates.activeProfileKey !== undefined ||
      updates.provider !== undefined ||
      updates.customProtocol !== undefined ||
      updates.apiKey !== undefined ||
      updates.baseUrl !== undefined ||
      updates.model !== undefined ||
      updates.contextWindow !== undefined ||
      updates.maxTokens !== undefined ||
      updates.enableThinking !== undefined ||
      updates.thinkingLevel !== undefined;

    if (mutatesActiveSet) {
      if (updates.profiles) {
        // Phase 2a: `profiles` is accepted but **credential-inert**. The renderer
        // still sends it from handleSave until Phase 2b, and dropping it here
        // would lose a key the user just typed — so each slot is forwarded into
        // the global map rather than stored on the set. The set's own `profiles`
        // is kept in sync only as the legacy mirror the renderer reads back.
        for (const key of PROFILE_KEYS) {
          if (updates.profiles[key]) {
            nextProfiles[key] = this.normalizeProfile(key, updates.profiles[key]);
          }
        }
        // Native slots (native:<id>) aren't in PROFILE_KEYS — apply them too so
        // native credential updates sent via top-level `profiles` aren't dropped.
        for (const key of Object.keys(updates.profiles)) {
          if (isNativeProfileKey(key) && updates.profiles[key as ProviderProfileKey]) {
            const nativeKey = key as ProviderProfileKey;
            nextProfiles[nativeKey] = this.normalizeProfile(nativeKey, updates.profiles[nativeKey]);
          }
        }
        // Forwarding into the global store happens below, once provider /
        // protocol resolution has settled which slot this save is actually about.
      }

      if (isProfileKey(updates.activeProfileKey)) {
        nextActiveProfileKey = updates.activeProfileKey;
        const fromProfile = profileKeyToProvider(nextActiveProfileKey);
        nextProvider = fromProfile.provider;
        nextCustomProtocol = fromProfile.customProtocol;
      }

      if (updates.provider || updates.customProtocol) {
        const requestedProvider = isProviderType(updates.provider)
          ? updates.provider
          : nextProvider;
        const requestedProtocol =
          requestedProvider === 'custom'
            ? isCustomProtocol(updates.customProtocol)
              ? updates.customProtocol
              : nextCustomProtocol
            : defaultProtocolForProvider(requestedProvider);
        nextActiveProfileKey = profileKeyFromProvider(requestedProvider, requestedProtocol);
        const fromProfile = profileKeyToProvider(nextActiveProfileKey);
        nextProvider = fromProfile.provider;
        nextCustomProtocol = fromProfile.customProtocol;
      }

      // --- model selection -> the set ---
      if (updates.model !== undefined) {
        nextModel = updates.model?.trim() ?? '';
      }
      if (updates.contextWindow !== undefined) {
        nextContextWindow =
          typeof updates.contextWindow === 'number' && updates.contextWindow > 0
            ? updates.contextWindow
            : undefined;
      }
      if (updates.maxTokens !== undefined) {
        nextMaxTokens =
          typeof updates.maxTokens === 'number' && updates.maxTokens > 0
            ? updates.maxTokens
            : undefined;
      }

      // --- credentials -> the global map, or the referenced endpoint ---
      //
      // Order matters: forward the renderer's profile map first (scoped to the
      // active slot), then let an explicit `apiKey`/`baseUrl` in the same payload
      // win over it — those are the fields the user edited most directly.
      if (updates.profiles) {
        this.applyProfilesToCredentials(
          updates.profiles,
          nextProviderCredentials,
          nextCustomEndpoints,
          nextActiveProfileKey
        );
      }
      // A protocol change on a custom set is also a credential-location change:
      // the endpoint owns the routing protocol, so it must be written through too,
      // not only when a key or URL accompanies it.
      const changesCustomProtocol =
        nextProvider === 'custom' &&
        updates.customProtocol !== undefined &&
        isCustomProtocol(updates.customProtocol);
      if (updates.apiKey !== undefined || updates.baseUrl !== undefined || changesCustomProtocol) {
        const written = this.writeCredential({
          provider: nextProvider,
          customProtocol: nextCustomProtocol,
          ...(updates.customProtocol !== undefined && isCustomProtocol(updates.customProtocol)
            ? { explicitProtocol: updates.customProtocol }
            : {}),
          endpointId: nextEndpointId,
          apiKey: updates.apiKey,
          baseUrl: updates.baseUrl,
          providerCredentials: nextProviderCredentials,
          customEndpoints: nextCustomEndpoints,
        });
        nextCustomEndpoints = written.customEndpoints;
        nextEndpointId = written.endpointId;
      }

      // Keep the legacy mirror consistent so the renderer, which still reads
      // `profiles` until Phase 2b, sees what it just wrote.
      const mirrored = { ...nextProfiles[nextActiveProfileKey] };
      if (updates.apiKey !== undefined) mirrored.apiKey = updates.apiKey;
      if (updates.baseUrl !== undefined) mirrored.baseUrl = updates.baseUrl?.trim() ?? '';
      if (updates.model !== undefined) mirrored.model = nextModel;
      nextProfiles[nextActiveProfileKey] = this.normalizeProfile(nextActiveProfileKey, mirrored);

      const resolvedThinkingLevel: ModelThinkingLevel =
        updates.thinkingLevel !== undefined
          ? normalizeThinkingLevel(updates.thinkingLevel, targetSet.thinkingLevel ?? 'off')
          : updates.enableThinking !== undefined
            ? updates.enableThinking
              ? 'medium'
              : 'off'
            : (targetSet.thinkingLevel ?? (targetSet.enableThinking ? 'medium' : 'off'));
      const updatedSet: ApiConfigSet = {
        ...targetSet,
        provider: nextProvider,
        // `endpointId` is meaningful only for a custom set. Spreading `targetSet`
        // would otherwise carry a stale pin across a switch to a catalog
        // provider: harmless for resolution (which ignores it) but it makes the
        // set look like a referrer to `deleteCustomEndpoint`'s in-use check.
        ...(nextProvider === 'custom' && nextEndpointId ? { endpointId: nextEndpointId } : {}),
        model: nextModel,
        ...(typeof nextContextWindow === 'number' ? { contextWindow: nextContextWindow } : {}),
        ...(typeof nextMaxTokens === 'number' ? { maxTokens: nextMaxTokens } : {}),
        customProtocol: nextCustomProtocol,
        activeProfileKey: nextActiveProfileKey,
        profiles: nextProfiles,
        enableThinking: resolvedThinkingLevel !== 'off',
        thinkingLevel: resolvedThinkingLevel,
        updatedAt: nowISO(),
      };

      if (nextProvider !== 'custom') {
        // Belt-and-braces: the spread above copies `targetSet.endpointId`, so a
        // set switched to a catalog provider would still advertise a pin.
        delete updatedSet.endpointId;
      }
      // Same three-state problem for the numeric overrides: `...targetSet` copies
      // the old value, and the conditional spreads only *add* when a number is
      // present. Without an explicit delete, a clear (0 / null / undefined) can
      // never remove a limit once it has been set.
      if (updates.contextWindow !== undefined && nextContextWindow === undefined) {
        delete updatedSet.contextWindow;
      }
      if (updates.maxTokens !== undefined && nextMaxTokens === undefined) {
        delete updatedSet.maxTokens;
      }

      if (targetIndex >= 0) {
        nextConfigSets[targetIndex] = updatedSet;
      }
    }

    const projectedConfig = this.composeProjectedConfig(
      current,
      nextConfigSets,
      activeConfigSetId,
      { providerCredentials: nextProviderCredentials, customEndpoints: nextCustomEndpoints }
    );
    const mergedForSave: AppConfig = {
      ...projectedConfig,
      claudeCodePath:
        updates.claudeCodePath !== undefined ? updates.claudeCodePath : current.claudeCodePath,
      defaultWorkdir:
        updates.defaultWorkdir !== undefined ? updates.defaultWorkdir : current.defaultWorkdir,
      globalSkillsPath:
        updates.globalSkillsPath !== undefined
          ? updates.globalSkillsPath
          : current.globalSkillsPath,
      localDevPath:
        updates.localDevPath !== undefined ? updates.localDevPath : current.localDevPath,
      systemPromptFile:
        updates.systemPromptFile !== undefined
          ? updates.systemPromptFile
          : current.systemPromptFile,
      // When the legacy field is updated with a valid value, keep new fields
      // in sync. Invalid legacy values (off-whitelist) are ignored for new-field
      // sync — they normalize the legacy field to '' but leave enabled/priority
      // unchanged, so a bad IPC payload cannot toggle discovery state.
      systemPromptFileEnabled: (() => {
        if (updates.systemPromptFileEnabled !== undefined) {
          return toBoolean(updates.systemPromptFileEnabled, current.systemPromptFileEnabled);
        }
        if (
          updates.systemPromptFile !== undefined &&
          updates.systemPromptFilePriority === undefined
        ) {
          if (!isValidSystemPromptFileChoice(updates.systemPromptFile)) {
            // Invalid legacy value — leave enabled state unchanged.
            return current.systemPromptFileEnabled;
          }
          // '' → disabled; whitelisted filename → enabled.
          return updates.systemPromptFile !== '';
        }
        return current.systemPromptFileEnabled;
      })(),
      systemPromptFilePriority: (() => {
        if (updates.systemPromptFilePriority !== undefined) {
          return normalizeSystemPromptPriority(updates.systemPromptFilePriority);
        }
        if (updates.systemPromptFile !== undefined) {
          if (!isValidSystemPromptFileChoice(updates.systemPromptFile)) {
            // Invalid legacy value — leave priority unchanged.
            return current.systemPromptFilePriority;
          }
          if (updates.systemPromptFile !== '') {
            // Hoist the newly-selected valid legacy file to position 0.
            return normalizeSystemPromptPriority([updates.systemPromptFile]);
          }
        }
        return current.systemPromptFilePriority;
      })(),
      bashTrustedCommands:
        updates.bashTrustedCommands !== undefined
          ? toStringArray(updates.bashTrustedCommands)
          : current.bashTrustedCommands,
      bashDenylist:
        updates.bashDenylist !== undefined
          ? toStringArray(updates.bashDenylist)
          : current.bashDenylist,
      trustedDirectories:
        updates.trustedDirectories !== undefined
          ? sanitizeTrustedDirectories(updates.trustedDirectories)
          : current.trustedDirectories,
      enableDevLogs:
        updates.enableDevLogs !== undefined ? updates.enableDevLogs : current.enableDevLogs,
      theme: updates.theme !== undefined ? updates.theme : current.theme,
      sandboxEnabled:
        updates.sandboxEnabled !== undefined ? updates.sandboxEnabled : current.sandboxEnabled,
      memoryEnabled:
        updates.memoryEnabled !== undefined ? updates.memoryEnabled : current.memoryEnabled,
      memoryRuntime:
        updates.memoryRuntime !== undefined
          ? normalizeMemoryRuntimeConfig(
              // Deep-merge with current so partial UI updates (e.g., only embedding fields)
              // never reset unrelated keys (llm config, storageRoot, ingestionConcurrency, etc.).
              mergeMemoryRuntime(current.memoryRuntime, updates.memoryRuntime),
              current.configSchemaVersion
            )
          : current.memoryRuntime,
      isConfigured:
        updates.isConfigured !== undefined ? updates.isConfigured : current.isConfigured,
      // configSchemaVersion is internal — only settable by ensureNormalized().
      // Ignore any incoming update to prevent external callers from downgrading
      // the schema version and triggering unwanted re-migration.
      configSchemaVersion: current.configSchemaVersion,
      schedulerCatchUpPolicy:
        updates.schedulerCatchUpPolicy !== undefined
          ? updates.schedulerCatchUpPolicy
          : current.schedulerCatchUpPolicy,
      schedulerConflictPolicy:
        updates.schedulerConflictPolicy !== undefined
          ? updates.schedulerConflictPolicy
          : current.schedulerConflictPolicy,
      schedulerRunHistoryDepth:
        updates.schedulerRunHistoryDepth !== undefined
          ? updates.schedulerRunHistoryDepth
          : current.schedulerRunHistoryDepth,
      permissionTimeoutSeconds:
        updates.permissionTimeoutSeconds !== undefined
          ? normalizePermissionTimeout(updates.permissionTimeoutSeconds)
          : current.permissionTimeoutSeconds,
      mcpToolTimeoutSeconds:
        updates.mcpToolTimeoutSeconds !== undefined
          ? normalizeMcpToolTimeout(updates.mcpToolTimeoutSeconds)
          : current.mcpToolTimeoutSeconds,
      notificationsEnabled:
        updates.notificationsEnabled !== undefined
          ? toBoolean(updates.notificationsEnabled, current.notificationsEnabled)
          : current.notificationsEnabled,
      ...(() => {
        const next =
          updates.httpProxy === undefined
            ? current.httpProxy // no change
            : (typeof updates.httpProxy === 'string' ? updates.httpProxy.trim() : '') || undefined; // empty = clear
        return next ? { httpProxy: next } : {};
      })(),
      skillConflictConfig:
        updates.skillConflictConfig !== undefined
          ? normalizeSkillConflictConfig(updates.skillConflictConfig)
          : current.skillConflictConfig,
      orphanDismissals:
        updates.orphanDismissals !== undefined
          ? normalizeOrphanDismissals(updates.orphanDismissals)
          : current.orphanDismissals,
    };
    // httpProxy is optional — delete from the merged object when the user
    // clears it (empty string) so normalizeConfig sees it as absent.
    const isHttpProxyClearing =
      updates.httpProxy !== undefined &&
      (typeof updates.httpProxy !== 'string' || !updates.httpProxy.trim());
    if (isHttpProxyClearing) {
      delete mergedForSave.httpProxy;
      // Explicitly delete from the store so conf's merge-write doesn't leave
      // the stale key on disk (conf.set(object) merges; it does not delete
      // absent keys — only conf.delete(key) removes a key from the file).
      this.store.delete('httpProxy' as unknown as keyof AppConfig);
    }
    this.saveConfig(mergedForSave);
  }

  /**
   * Check if the app is configured (has API key)
   */
  isConfigured(): boolean {
    return this.hasAnyUsableCredentials(this.getAll());
  }

  private hasUsableCredentialsForProjection(projection: {
    provider: ProviderType;
    customProtocol?: CustomProtocolType;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }): boolean {
    if (projection.provider === 'ollama' && !projection.model?.trim()) {
      return false;
    }
    const apiKey = projection.apiKey?.trim();
    if (apiKey) {
      return true;
    }
    if (
      shouldAllowEmptyAnthropicApiKey({
        provider: projection.provider,
        customProtocol: projection.customProtocol,
        baseUrl: projection.baseUrl,
      })
    ) {
      return true;
    }
    if (
      shouldAllowEmptyGeminiApiKey({
        provider: projection.provider,
        customProtocol: projection.customProtocol,
        baseUrl: projection.baseUrl,
      })
    ) {
      return true;
    }
    if (
      shouldAllowEmptyOllamaApiKey({
        provider: projection.provider,
        customProtocol: projection.customProtocol,
        baseUrl: projection.baseUrl,
      })
    ) {
      return true;
    }
    const protocol: CustomProtocolType = normalizeCustomProtocol(
      projection.customProtocol,
      defaultProtocolForProvider(projection.provider)
    );
    if (!isOpenAIProvider({ provider: projection.provider, customProtocol: protocol })) {
      return false;
    }
    return (
      (projection.provider === 'ollama'
        ? resolveOllamaCredentials({
            provider: projection.provider,
            customProtocol: protocol,
            apiKey: projection.apiKey ?? '',
            baseUrl: projection.baseUrl,
          })
        : resolveOpenAICredentials({
            provider: projection.provider,
            customProtocol: protocol,
            apiKey: projection.apiKey ?? '',
            baseUrl: projection.baseUrl,
          })) !== null
    );
  }

  hasUsableCredentials(config: AppConfig = this.getAll()): boolean {
    return this.hasUsableCredentialsForActiveSet(config);
  }

  hasUsableCredentialsForActiveSet(config: AppConfig = this.getAll()): boolean {
    const normalized = this.normalizeConfig(config);
    return this.hasUsableCredentialsForProjection({
      provider: normalized.provider,
      customProtocol: normalized.customProtocol,
      apiKey: normalized.apiKey,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
    });
  }

  hasAnyUsableCredentials(config: AppConfig = this.getAll()): boolean {
    const normalized = this.normalizeConfig(config);
    return normalized.configSets.some((configSet) => {
      const projected = this.projectFromConfigSet(
        configSet,
        normalized.providerCredentials,
        normalized.customEndpoints
      );
      return this.hasUsableCredentialsForProjection({
        provider: projected.provider,
        customProtocol: projected.customProtocol,
        apiKey: projected.apiKey,
        baseUrl: projected.baseUrl,
        model: projected.model,
      });
    });
  }

  /**
   * Apply config to environment variables
   * This should be called before creating sessions
   *
   * 环境变量映射：
   * - OpenAI 直连: OPENAI_API_KEY = apiKey, OPENAI_BASE_URL 可选
   * - Anthropic 直连: ANTHROPIC_API_KEY = apiKey
   * - Custom Anthropic: ANTHROPIC_API_KEY = apiKey
   * - OpenRouter: ANTHROPIC_AUTH_TOKEN = apiKey, ANTHROPIC_API_KEY = '' (proxy mode)
   */
  applyToEnv(): void {
    const config = this.getAll();
    const activeProfile = config.profiles?.[config.activeProfileKey] || {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    };
    const projectedConfig: AppConfig = {
      ...config,
      apiKey: activeProfile.apiKey || '',
      baseUrl: activeProfile.baseUrl,
      model: activeProfile.model || '',
    };

    // Clear all API-related env vars first to ensure clean state when switching providers
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_API_MODE;
    delete process.env.OPENAI_ACCOUNT_ID;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_BASE_URL;
    delete process.env.CLAUDE_CODE_PATH;
    delete process.env.COWORK_WORKDIR;

    const useOpenAI =
      projectedConfig.provider === 'openai' ||
      projectedConfig.provider === 'ollama' ||
      (projectedConfig.provider === 'custom' && projectedConfig.customProtocol === 'openai');
    const useGemini =
      projectedConfig.provider === 'gemini' ||
      (projectedConfig.provider === 'custom' && projectedConfig.customProtocol === 'gemini');

    if (useOpenAI) {
      const resolvedOpenAI =
        projectedConfig.provider === 'ollama'
          ? resolveOllamaCredentials(projectedConfig)
          : resolveOpenAICredentials(projectedConfig);
      if (resolvedOpenAI?.apiKey) {
        process.env.OPENAI_API_KEY = resolvedOpenAI.apiKey;
        // Also set ANTHROPIC_API_KEY for custom providers routing Anthropic models
        // through an OpenAI-compatible gateway. The pi-ai SDK may look up the key
        // by the model's registry provider ("anthropic") rather than the configured
        // protocol ("openai"), causing auth failures on follow-up requests.
        if (projectedConfig.provider === 'custom') {
          process.env.ANTHROPIC_API_KEY = resolvedOpenAI.apiKey;
        }
      }
      const openAIBaseUrl = resolvedOpenAI?.baseUrl || projectedConfig.baseUrl;
      if (openAIBaseUrl) {
        process.env.OPENAI_BASE_URL = openAIBaseUrl;
      }
      if (resolvedOpenAI?.accountId) {
        process.env.OPENAI_ACCOUNT_ID = resolvedOpenAI.accountId;
      }
      if (projectedConfig.model) {
        process.env.OPENAI_MODEL = projectedConfig.model;
      }
    } else if (useGemini) {
      const trimmedApiKey = projectedConfig.apiKey?.trim();
      if (trimmedApiKey) {
        process.env.GEMINI_API_KEY = trimmedApiKey;
      }
      const normalizedGeminiBaseUrl = projectedConfig.baseUrl?.trim().replace(/\/+$/, '');
      if (normalizedGeminiBaseUrl) {
        process.env.GEMINI_BASE_URL = normalizedGeminiBaseUrl;
      }
      if (projectedConfig.model) {
        process.env.CLAUDE_MODEL = projectedConfig.model;
      }
    } else {
      const effectiveAnthropicApiKey =
        projectedConfig.apiKey?.trim() ||
        (shouldAllowEmptyAnthropicApiKey(projectedConfig) ? LOCAL_ANTHROPIC_PLACEHOLDER_KEY : '');
      if (
        projectedConfig.provider === 'anthropic' ||
        (projectedConfig.provider === 'custom' && projectedConfig.customProtocol !== 'openai')
      ) {
        const useAuthToken = shouldUseAnthropicAuthToken({
          ...projectedConfig,
          apiKey: effectiveAnthropicApiKey,
        });
        if (effectiveAnthropicApiKey) {
          if (useAuthToken) {
            process.env.ANTHROPIC_AUTH_TOKEN = effectiveAnthropicApiKey;
          } else {
            process.env.ANTHROPIC_API_KEY = effectiveAnthropicApiKey;
          }
        }
        const normalizedAnthropicBaseUrl = normalizeAnthropicBaseUrl(projectedConfig.baseUrl);
        if (normalizedAnthropicBaseUrl) {
          process.env.ANTHROPIC_BASE_URL = normalizedAnthropicBaseUrl;
        }
        if (useAuthToken) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          delete process.env.ANTHROPIC_AUTH_TOKEN;
        }
      } else {
        // OpenRouter: use ANTHROPIC_AUTH_TOKEN for proxy authentication
        if (effectiveAnthropicApiKey) {
          process.env.ANTHROPIC_AUTH_TOKEN = effectiveAnthropicApiKey;
        }
        const normalizedAnthropicBaseUrl = normalizeAnthropicBaseUrl(projectedConfig.baseUrl);
        if (normalizedAnthropicBaseUrl) {
          process.env.ANTHROPIC_BASE_URL = normalizedAnthropicBaseUrl;
        }
        // ANTHROPIC_API_KEY must be absent to prevent SDK from using it
        delete process.env.ANTHROPIC_API_KEY;
      }

      if (projectedConfig.model) {
        process.env.CLAUDE_MODEL = projectedConfig.model;
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = projectedConfig.model;
      }
    }

    // claudeCodePath is no longer used (pi-coding-agent handles model routing natively)

    if (projectedConfig.defaultWorkdir) {
      process.env.COWORK_WORKDIR = projectedConfig.defaultWorkdir;
    }

    log('[Config] Applied env vars for provider:', projectedConfig.provider, {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '✓ Set' : '(empty/unset)',
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ? '✓ Set' : '(empty/unset)',
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '(default)',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '✓ Set' : '(empty/unset)',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '(default)',
      OPENAI_MODEL: process.env.OPENAI_MODEL || '(not set)',
      OPENAI_API_MODE: process.env.OPENAI_API_MODE || '(default)',
      OPENAI_ACCOUNT_ID: process.env.OPENAI_ACCOUNT_ID || '(not set)',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? '✓ Set' : '(empty/unset)',
      GEMINI_BASE_URL: process.env.GEMINI_BASE_URL || '(default)',
    });
  }

  /**
   * Reset config to defaults
   */
  reset(): void {
    this.store.clear();
    this.ensureNormalized();
  }

  /**
   * Get the store file path (for debugging)
   */
  getPath(): string {
    return this.store.path;
  }
}

// Singleton instance
export const configStore = new ConfigStore();

/**
 * Pure function extracted from ConfigStore.migrateToV2 for testability.
 * Given the raw persisted memoryRuntime value from a v1 config, returns the
 * useEmbedding value to freeze for existing installs.
 *
 * Note: embedding.provider is intentionally NOT part of the migration output.
 * Schema-version-aware normalization in normalizeMemoryRuntimeConfig handles
 * provider fallback correctly based on configSchemaVersion, so persisting
 * 'undefined' here is both unnecessary and risky (it would delete the key).
 */
export function computeV2Migration(rawMemory: unknown): { useEmbedding: boolean } {
  const mem =
    typeof rawMemory === 'object' && rawMemory !== null
      ? (rawMemory as Partial<{ useEmbedding: boolean }>)
      : {};
  return {
    useEmbedding: typeof mem.useEmbedding === 'boolean' ? mem.useEmbedding : false,
  };
}
