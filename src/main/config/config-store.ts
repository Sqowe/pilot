import fs from 'node:fs';
import Store from 'electron-store';
import { log } from '../utils/logger';
import { isOpenAIProvider, resolveOpenAICredentials, shouldUseAnthropicAuthToken } from './auth-utils';

/**
 * Application configuration schema
 */
export type ProviderType = 'openrouter' | 'anthropic' | 'custom' | 'openai';
export type CustomProtocolType = 'anthropic' | 'openai';
export type ProviderProfileKey = 'openrouter' | 'anthropic' | 'openai' | 'custom:anthropic' | 'custom:openai';

export interface ProviderProfile {
  apiKey: string;
  baseUrl?: string;
  model: string;
  openaiMode?: 'responses' | 'chat';
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

  // OpenAI API mode
  openaiMode: 'responses' | 'chat';

  // Active profile
  activeProfileKey: ProviderProfileKey;
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;
  
  // Optional: Claude Code CLI path override
  claudeCodePath?: string;
  
  // Optional: Default working directory
  defaultWorkdir?: string;
  
  // Developer logs
  enableDevLogs: boolean;
  
  // Sandbox mode (WSL/Lima isolation)
  sandboxEnabled: boolean;
  
  // Enable thinking mode (show thinking steps)
  enableThinking: boolean;
  
  // First run flag
  isConfigured: boolean;
}

const defaultConfig: AppConfig = {
  provider: 'openrouter',
  apiKey: '',
  baseUrl: 'https://openrouter.ai/api',
  customProtocol: 'anthropic',
  model: 'anthropic/claude-sonnet-4.5',
  openaiMode: 'responses',
  activeProfileKey: 'openrouter',
  profiles: {
    openrouter: {
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api',
      model: 'anthropic/claude-sonnet-4.5',
      openaiMode: 'responses',
    },
    anthropic: {
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      openaiMode: 'responses',
    },
    openai: {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      openaiMode: 'responses',
    },
    'custom:anthropic': {
      apiKey: '',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-4.7',
      openaiMode: 'responses',
    },
    'custom:openai': {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      openaiMode: 'responses',
    },
  },
  claudeCodePath: '',
  defaultWorkdir: '',
  enableDevLogs: true,
  sandboxEnabled: false,
  enableThinking: false,
  isConfigured: false,
};

// Provider presets
export const PROVIDER_PRESETS = {
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    models: [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
      { id: 'moonshotai/kimi-k2-0905', name: 'Kimi K2' },
      { id: 'z-ai/glm-4.7', name: 'GLM-4.7' },
    ],
    keyPlaceholder: 'sk-or-v1-...',
    keyHint: '从 openrouter.ai/keys 获取',
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' },
      { id: 'claude-opus-4-5', name: 'claude-opus-4-5' },
      { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5' },
    ],
    keyPlaceholder: 'sk-ant-...',
    keyHint: '从 console.anthropic.com 获取',
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5.2', name: 'gpt-5.2' },
      { id: 'gpt-5.2-codex', name: 'gpt-5.2-codex' },
      { id: 'gpt-5.2-mini', name: 'gpt-5.2-mini' },
    ],
    keyPlaceholder: 'sk-...',
    keyHint: '从 platform.openai.com 获取',
  },
  custom: {
    name: '更多模型',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: [
      { id: 'glm-4.7', name: 'GLM-4.7' },
      { id: 'glm-4-plus', name: 'GLM-4-Plus' },
      { id: 'glm-4-air', name: 'GLM-4-Air' },
    ],
    keyPlaceholder: 'sk-xxx',
    keyHint: '输入你的 API Key',
  },
};

const PROFILE_KEYS: ProviderProfileKey[] = ['openrouter', 'anthropic', 'openai', 'custom:anthropic', 'custom:openai'];

function isProfileKey(value: unknown): value is ProviderProfileKey {
  return typeof value === 'string' && PROFILE_KEYS.includes(value as ProviderProfileKey);
}

function profileKeyFromProvider(provider: ProviderType, customProtocol: CustomProtocolType = 'anthropic'): ProviderProfileKey {
  if (provider !== 'custom') {
    return provider;
  }
  return customProtocol === 'openai' ? 'custom:openai' : 'custom:anthropic';
}

function profileKeyToProvider(profileKey: ProviderProfileKey): { provider: ProviderType; customProtocol: CustomProtocolType } {
  if (profileKey === 'custom:openai') {
    return { provider: 'custom', customProtocol: 'openai' };
  }
  if (profileKey === 'custom:anthropic') {
    return { provider: 'custom', customProtocol: 'anthropic' };
  }
  return { provider: profileKey, customProtocol: 'anthropic' };
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export class ConfigStore {
  private store: Store<AppConfig>;

  constructor() {
    const storeOptions: any = {
      name: 'config',
      defaults: defaultConfig,
      // Encrypt the API key for basic security
      encryptionKey: 'open-cowork-config-v1',
    };
    
    // Add projectName for non-Electron environments (e.g., MCP servers)
    // This is required by the underlying 'conf' package
    if (typeof process !== 'undefined' && !process.versions.electron) {
      storeOptions.projectName = 'open-cowork';
    }
    
    this.store = new Store<AppConfig>(storeOptions);
    this.ensureNormalized();
  }

  private ensureNormalized(): void {
    const normalized = this.normalizeConfig(this.store.store as Partial<AppConfig>);
    this.store.set(normalized as unknown as Record<string, unknown>);
  }

  private getDefaultProfile(profileKey: ProviderProfileKey): ProviderProfile {
    const presetKey = profileKey === 'custom:openai' ? 'openai' : (profileKey.startsWith('custom:') ? 'custom' : profileKey);
    const preset = PROVIDER_PRESETS[presetKey as keyof typeof PROVIDER_PRESETS];
    return {
      apiKey: '',
      baseUrl: preset?.baseUrl || '',
      model: preset?.models?.[0]?.id || '',
      openaiMode: 'responses',
    };
  }

  private normalizeProfile(profileKey: ProviderProfileKey, profile: Partial<ProviderProfile> | undefined): ProviderProfile {
    const fallback = this.getDefaultProfile(profileKey);
    const model = typeof profile?.model === 'string' && profile.model.trim()
      ? profile.model
      : fallback.model;
    const baseUrl = typeof profile?.baseUrl === 'string' && profile.baseUrl.trim()
      ? profile.baseUrl.trim()
      : fallback.baseUrl;
    return {
      apiKey: typeof profile?.apiKey === 'string' ? profile.apiKey : '',
      baseUrl,
      model,
      openaiMode: profile?.openaiMode === 'chat' ? 'chat' : 'responses',
    };
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

  private normalizeConfig(rawConfig: Partial<AppConfig> | undefined): AppConfig {
    const raw = rawConfig || {};
    const provider = raw.provider || defaultConfig.provider;
    const customProtocol: CustomProtocolType = raw.customProtocol === 'openai' ? 'openai' : 'anthropic';
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
      if (typeof rawProfile.baseUrl === 'string' && rawProfile.baseUrl.trim() && rawProfile.baseUrl.trim() !== fallback.baseUrl) {
        return true;
      }
      if (typeof rawProfile.model === 'string' && rawProfile.model.trim() && rawProfile.model.trim() !== fallback.model) {
        return true;
      }
      return rawProfile.openaiMode === 'chat';
    });
    const shouldUseLegacyProjection = !hasAnyRawProfiles || !hasProfileUserData;

    let activeProfileKey: ProviderProfileKey = shouldUseLegacyProjection
      ? derivedProfileKey
      : (isProfileKey(raw.activeProfileKey) ? raw.activeProfileKey : derivedProfileKey);

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
        openaiMode: raw.openaiMode,
      });
      activeProfileKey = derivedProfileKey;
    } else if (!hasAnyRawProfiles) {
      profiles[activeProfileKey] = this.normalizeProfile(activeProfileKey, {
        apiKey: '',
        baseUrl: undefined,
        model: undefined,
        openaiMode: raw.openaiMode,
      });
    }

    if (!profiles[activeProfileKey]) {
      activeProfileKey = derivedProfileKey;
    }

    const activeProfile = profiles[activeProfileKey] || this.getDefaultProfile(activeProfileKey);
    const activeMeta = profileKeyToProvider(activeProfileKey);

    return {
      provider: activeMeta.provider,
      customProtocol: activeMeta.customProtocol,
      apiKey: activeProfile.apiKey,
      baseUrl: activeProfile.baseUrl,
      model: activeProfile.model,
      openaiMode: activeProfile.openaiMode === 'chat' ? 'chat' : 'responses',
      activeProfileKey,
      profiles,
      claudeCodePath: typeof raw.claudeCodePath === 'string' ? raw.claudeCodePath : defaultConfig.claudeCodePath,
      defaultWorkdir: typeof raw.defaultWorkdir === 'string' ? raw.defaultWorkdir : defaultConfig.defaultWorkdir,
      enableDevLogs: toBoolean(raw.enableDevLogs, defaultConfig.enableDevLogs),
      sandboxEnabled: toBoolean(raw.sandboxEnabled, defaultConfig.sandboxEnabled),
      enableThinking: toBoolean(raw.enableThinking, defaultConfig.enableThinking),
      isConfigured: toBoolean(raw.isConfigured, defaultConfig.isConfigured),
    };
  }

  private saveConfig(config: AppConfig): void {
    const normalized = this.normalizeConfig(config);
    this.store.set(normalized as unknown as Record<string, unknown>);
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
    return this.getAll()[key];
  }

  /**
   * Set a specific config value
   */
  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.update({ [key]: value } as Partial<AppConfig>);
  }

  /**
   * Update multiple config values
   */
  update(updates: Partial<AppConfig>): void {
    const current = this.getAll();
    const nextProfiles = this.cloneProfiles(current.profiles);
    let nextActiveProfileKey = current.activeProfileKey;
    let nextProvider = current.provider;
    let nextCustomProtocol: CustomProtocolType = current.customProtocol === 'openai' ? 'openai' : 'anthropic';

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
      const requestedProvider = updates.provider || nextProvider;
      const requestedProtocol = requestedProvider === 'custom'
        ? (updates.customProtocol || nextCustomProtocol)
        : 'anthropic';
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
      nextActiveProfile.baseUrl = baseUrl || this.getDefaultProfile(nextActiveProfileKey).baseUrl;
    }
    if (updates.model !== undefined) {
      const model = updates.model?.trim();
      nextActiveProfile.model = model || this.getDefaultProfile(nextActiveProfileKey).model;
    }
    if (updates.openaiMode !== undefined) {
      nextActiveProfile.openaiMode = updates.openaiMode === 'chat' ? 'chat' : 'responses';
    }
    nextProfiles[nextActiveProfileKey] = this.normalizeProfile(nextActiveProfileKey, nextActiveProfile);

    const projected = nextProfiles[nextActiveProfileKey];
    this.saveConfig({
      provider: nextProvider,
      customProtocol: nextCustomProtocol,
      apiKey: projected.apiKey,
      baseUrl: projected.baseUrl,
      model: projected.model,
      openaiMode: projected.openaiMode === 'chat' ? 'chat' : 'responses',
      activeProfileKey: nextActiveProfileKey,
      profiles: nextProfiles,
      claudeCodePath: updates.claudeCodePath !== undefined ? updates.claudeCodePath : current.claudeCodePath,
      defaultWorkdir: updates.defaultWorkdir !== undefined ? updates.defaultWorkdir : current.defaultWorkdir,
      enableDevLogs: updates.enableDevLogs !== undefined ? updates.enableDevLogs : current.enableDevLogs,
      sandboxEnabled: updates.sandboxEnabled !== undefined ? updates.sandboxEnabled : current.sandboxEnabled,
      enableThinking: updates.enableThinking !== undefined ? updates.enableThinking : current.enableThinking,
      isConfigured: updates.isConfigured !== undefined ? updates.isConfigured : current.isConfigured,
    });
  }

  /**
   * Check if the app is configured (has API key)
   */
  isConfigured(): boolean {
    if (!this.store.get('isConfigured')) {
      return false;
    }
    return this.hasUsableCredentials(this.getAll());
  }

  hasUsableCredentials(config: AppConfig = this.getAll()): boolean {
    const activeProfile = config.profiles?.[config.activeProfileKey];
    const activeApiKey = activeProfile?.apiKey ?? config.apiKey;
    const activeBaseUrl = activeProfile?.baseUrl ?? config.baseUrl;
    if (activeApiKey?.trim()) {
      return true;
    }
    if (!isOpenAIProvider(config)) {
      return false;
    }
    return resolveOpenAICredentials({
      provider: config.provider,
      customProtocol: config.customProtocol,
      apiKey: activeApiKey,
      baseUrl: activeBaseUrl,
    }) !== null;
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
      openaiMode: config.openaiMode,
    };
    const projectedConfig: AppConfig = {
      ...config,
      apiKey: activeProfile.apiKey || '',
      baseUrl: activeProfile.baseUrl,
      model: activeProfile.model || '',
      openaiMode: activeProfile.openaiMode === 'chat' ? 'chat' : 'responses',
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
    delete process.env.OPENAI_CODEX_OAUTH;
    
    const useOpenAI =
      projectedConfig.provider === 'openai' ||
      (projectedConfig.provider === 'custom' && projectedConfig.customProtocol === 'openai');

    if (useOpenAI) {
      const resolvedOpenAI = resolveOpenAICredentials(projectedConfig);
      if (resolvedOpenAI?.apiKey) {
        process.env.OPENAI_API_KEY = resolvedOpenAI.apiKey;
      }
      const openAIBaseUrl = resolvedOpenAI?.baseUrl || projectedConfig.baseUrl;
      if (openAIBaseUrl) {
        process.env.OPENAI_BASE_URL = openAIBaseUrl;
      }
      if (resolvedOpenAI?.accountId) {
        process.env.OPENAI_ACCOUNT_ID = resolvedOpenAI.accountId;
      }
      process.env.OPENAI_CODEX_OAUTH = resolvedOpenAI?.useCodexOAuth ? '1' : '0';
      if (projectedConfig.model) {
        process.env.OPENAI_MODEL = projectedConfig.model;
      }
      process.env.OPENAI_API_MODE = 'responses';
    } else {
      if (projectedConfig.provider === 'anthropic' || (projectedConfig.provider === 'custom' && projectedConfig.customProtocol !== 'openai')) {
        const useAuthToken = shouldUseAnthropicAuthToken(projectedConfig);
        if (projectedConfig.apiKey) {
          if (useAuthToken) {
            process.env.ANTHROPIC_AUTH_TOKEN = projectedConfig.apiKey;
          } else {
            process.env.ANTHROPIC_API_KEY = projectedConfig.apiKey;
          }
        }
        if (projectedConfig.baseUrl) {
          process.env.ANTHROPIC_BASE_URL = projectedConfig.baseUrl;
        }
        if (useAuthToken) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          delete process.env.ANTHROPIC_AUTH_TOKEN;
        }
      } else {
        // OpenRouter: use ANTHROPIC_AUTH_TOKEN for proxy authentication
        if (projectedConfig.apiKey) {
          process.env.ANTHROPIC_AUTH_TOKEN = projectedConfig.apiKey;
        }
        if (projectedConfig.baseUrl) {
          process.env.ANTHROPIC_BASE_URL = projectedConfig.baseUrl;
        }
        // ANTHROPIC_API_KEY must be empty to prevent SDK from using it
        process.env.ANTHROPIC_API_KEY = '';
      }

      if (projectedConfig.model) {
        process.env.CLAUDE_MODEL = projectedConfig.model;
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = projectedConfig.model;
      }
    }
    
    // Only set CLAUDE_CODE_PATH if the configured path actually exists
    // This allows auto-detection to work when the configured path is invalid
    if (projectedConfig.claudeCodePath) {
      if (fs.existsSync(projectedConfig.claudeCodePath)) {
        process.env.CLAUDE_CODE_PATH = projectedConfig.claudeCodePath;
        log('[Config] Using configured Claude Code path:', projectedConfig.claudeCodePath);
      } else {
        log('[Config] Configured Claude Code path not found, will use auto-detection:', projectedConfig.claudeCodePath);
        // Don't set the env var, let auto-detection find it
      }
    }
    
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
      OPENAI_CODEX_OAUTH: process.env.OPENAI_CODEX_OAUTH || '(not set)',
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
