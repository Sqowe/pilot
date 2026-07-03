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
import { sanitizeBashCommandList } from './permission-rules-store';
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
 * Application configuration schema
 */
export type ProviderType = 'openrouter' | 'anthropic' | 'custom' | 'openai' | 'gemini' | 'ollama';
/**
 * Superset of ProviderType that additionally allows 'local' for the embedding sub-config only.
 * The 'local' value must never appear on the main LLM config or any ApiConfigSet provider field.
 */
export type EmbeddingProviderType = ProviderType | 'local';
export type CustomProtocolType = 'anthropic' | 'openai' | 'gemini';
export type AppTheme = 'dark' | 'light' | 'system';
export type ProviderProfileKey =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'custom:anthropic'
  | 'custom:openai'
  | 'custom:gemini';
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

export interface ApiConfigSet {
  id: ConfigSetId;
  name: string;
  isSystem?: boolean;
  provider: ProviderType;
  customProtocol: CustomProtocolType;
  activeProfileKey: ProviderProfileKey;
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;
  enableThinking: boolean;
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
  customProtocol: 'anthropic',
  activeProfileKey: 'openrouter',
  profiles: defaultProfiles,
  enableThinking: false,
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

const PROFILE_KEYS: ProviderProfileKey[] = [
  'openrouter',
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'custom:anthropic',
  'custom:openai',
  'custom:gemini',
];
const VALID_THEMES: AppTheme[] = ['dark', 'light', 'system'];

function isProviderType(value: unknown): value is ProviderType {
  return (
    value === 'openrouter' ||
    value === 'anthropic' ||
    value === 'custom' ||
    value === 'openai' ||
    value === 'gemini' ||
    value === 'ollama'
  );
}

function isCustomProtocol(value: unknown): value is CustomProtocolType {
  return value === 'anthropic' || value === 'openai' || value === 'gemini';
}

function isProfileKey(value: unknown): value is ProviderProfileKey {
  return typeof value === 'string' && PROFILE_KEYS.includes(value as ProviderProfileKey);
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
    provider: isProviderType(rawProvider) ? rawProvider : fallback.provider,
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
  if (provider !== 'custom') {
    return provider;
  }
  if (customProtocol === 'openai') {
    return 'custom:openai';
  }
  if (customProtocol === 'gemini') {
    return 'custom:gemini';
  }
  return 'custom:anthropic';
}

function profileKeyToProvider(profileKey: ProviderProfileKey): {
  provider: ProviderType;
  customProtocol: CustomProtocolType;
} {
  if (profileKey === 'custom:openai') {
    return { provider: 'custom', customProtocol: 'openai' };
  }
  if (profileKey === 'custom:gemini') {
    return { provider: 'custom', customProtocol: 'gemini' };
  }
  if (profileKey === 'custom:anthropic') {
    return { provider: 'custom', customProtocol: 'anthropic' };
  }
  if (profileKey === 'openai') {
    return { provider: 'openai', customProtocol: 'openai' };
  }
  if (profileKey === 'gemini') {
    return { provider: 'gemini', customProtocol: 'gemini' };
  }
  if (profileKey === 'ollama') {
    return { provider: 'ollama', customProtocol: 'openai' };
  }
  return { provider: profileKey, customProtocol: 'anthropic' };
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
      baseUrl,
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
    return cloned;
  }

  private normalizeLegacyProjection(raw: Partial<AppConfig>): {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    enableThinking: boolean;
  } {
    const provider = isProviderType(raw.provider) ? raw.provider : defaultConfig.provider;
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

    return {
      provider,
      customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: toBoolean(raw.enableThinking, defaultConfig.enableThinking),
    };
  }

  private projectFromConfigSet(configSet: ApiConfigSet): {
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
  } {
    const profiles = this.cloneProfiles(configSet.profiles);
    const activeProfileKey = isProfileKey(configSet.activeProfileKey)
      ? configSet.activeProfileKey
      : profileKeyFromProvider(configSet.provider, configSet.customProtocol);
    const activeProfile = profiles[activeProfileKey] || this.getDefaultProfile(activeProfileKey);

    return {
      provider: configSet.provider,
      customProtocol: configSet.customProtocol,
      activeProfileKey,
      profiles,
      apiKey: activeProfile.apiKey,
      baseUrl: activeProfile.baseUrl,
      model: activeProfile.model,
      contextWindow: activeProfile.contextWindow,
      maxTokens: activeProfile.maxTokens,
      enableThinking: toBoolean(configSet.enableThinking, false),
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
      isSystem?: boolean;
    }
  ): ApiConfigSet {
    const provider = isProviderType(rawSet?.provider) ? rawSet.provider : fallback.provider;
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

    return {
      id,
      name,
      isSystem: toBoolean(rawSet?.isSystem, Boolean(fallback.isSystem)),
      provider,
      customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: toBoolean(rawSet?.enableThinking, fallback.enableThinking),
      updatedAt,
    };
  }

  private makeDefaultConfigSetFromLegacy(legacy: {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    enableThinking: boolean;
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
  }): boolean {
    if (
      legacy.provider !== defaultConfig.provider ||
      legacy.customProtocol !== (defaultConfig.customProtocol || 'anthropic') ||
      legacy.activeProfileKey !== defaultConfig.activeProfileKey ||
      legacy.enableThinking !== defaultConfig.enableThinking
    ) {
      return true;
    }

    const activeProfile = legacy.profiles[legacy.activeProfileKey];
    const fallbackActive = this.getDefaultProfile(legacy.activeProfileKey);
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

    const projected = this.projectFromConfigSet(onlySet);
    const legacyActive = legacy.profiles[legacy.activeProfileKey];
    return !(
      projected.provider === legacy.provider &&
      projected.customProtocol === legacy.customProtocol &&
      projected.activeProfileKey === legacy.activeProfileKey &&
      projected.enableThinking === legacy.enableThinking &&
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
    const configSets = this.shouldPreferLegacyConfigSetProjection(normalizedFromRaw, legacy)
      ? [this.makeDefaultConfigSetFromLegacy(legacy)]
      : normalizedFromRaw;

    const requestedActiveSetId = toNonEmptyString(raw.activeConfigSetId);
    const activeConfigSetId = configSets.some((set) => set.id === requestedActiveSetId)
      ? (requestedActiveSetId as string)
      : configSets[0].id;

    const activeConfigSet = configSets.find((set) => set.id === activeConfigSetId) || configSets[0];
    const projected = this.projectFromConfigSet(activeConfigSet);

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

  private composeProjectedConfig(
    base: AppConfig,
    nextConfigSets: ApiConfigSet[],
    requestedActiveConfigSetId: string
  ): AppConfig {
    const activeConfigSet =
      nextConfigSets.find((set) => set.id === requestedActiveConfigSetId) || nextConfigSets[0];
    const projected = this.projectFromConfigSet(activeConfigSet);
    return {
      ...base,
      provider: projected.provider,
      customProtocol: projected.customProtocol,
      apiKey: projected.apiKey,
      baseUrl: projected.baseUrl,
      model: projected.model,
      activeProfileKey: projected.activeProfileKey,
      profiles: projected.profiles,
      enableThinking: projected.enableThinking,
      activeConfigSetId: activeConfigSet.id,
      configSets: nextConfigSets,
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
      customProtocol: payload.customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: false,
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
      });
      nextConfigSets = normalizedSets;
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
    let nextCustomProtocol: CustomProtocolType = normalizeCustomProtocol(
      targetSet.customProtocol,
      defaultProtocolForProvider(targetSet.provider)
    );

    const mutatesActiveSet =
      updates.profiles !== undefined ||
      updates.activeProfileKey !== undefined ||
      updates.provider !== undefined ||
      updates.customProtocol !== undefined ||
      updates.apiKey !== undefined ||
      updates.baseUrl !== undefined ||
      updates.model !== undefined ||
      updates.enableThinking !== undefined;

    if (mutatesActiveSet) {
      if (updates.profiles) {
        for (const key of PROFILE_KEYS) {
          if (updates.profiles[key]) {
            nextProfiles[key] = this.normalizeProfile(key, updates.profiles[key]);
          }
        }
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

      const nextActiveProfile = {
        ...nextProfiles[nextActiveProfileKey],
      };
      if (updates.apiKey !== undefined) {
        nextActiveProfile.apiKey = updates.apiKey;
      }
      if (updates.baseUrl !== undefined) {
        const baseUrl = updates.baseUrl?.trim();
        nextActiveProfile.baseUrl = baseUrl ?? '';
      }
      if (updates.model !== undefined) {
        const model = updates.model?.trim();
        nextActiveProfile.model = model ?? '';
      }
      nextProfiles[nextActiveProfileKey] = this.normalizeProfile(
        nextActiveProfileKey,
        nextActiveProfile
      );

      const updatedSet: ApiConfigSet = {
        ...targetSet,
        provider: nextProvider,
        customProtocol: nextCustomProtocol,
        activeProfileKey: nextActiveProfileKey,
        profiles: nextProfiles,
        enableThinking:
          updates.enableThinking !== undefined ? updates.enableThinking : targetSet.enableThinking,
        updatedAt: nowISO(),
      };

      if (targetIndex >= 0) {
        nextConfigSets[targetIndex] = updatedSet;
      }
    }

    const projectedConfig = this.composeProjectedConfig(current, nextConfigSets, activeConfigSetId);
    this.saveConfig({
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
      skillConflictConfig:
        updates.skillConflictConfig !== undefined
          ? normalizeSkillConflictConfig(updates.skillConflictConfig)
          : current.skillConflictConfig,
      orphanDismissals:
        updates.orphanDismissals !== undefined
          ? normalizeOrphanDismissals(updates.orphanDismissals)
          : current.orphanDismissals,
    });
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
      const projected = this.projectFromConfigSet(configSet);
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
