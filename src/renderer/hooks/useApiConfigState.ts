import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppConfig,
  ApiTestResult,
  CustomProtocolType,
  ProviderProfile,
  ProviderProfileKey,
  ProviderPresets,
  ProviderType,
} from '../types';

type LocalAuthProvider = 'codex';

interface UseApiConfigStateOptions {
  enabled?: boolean;
  initialConfig?: AppConfig | null;
  onSave?: (config: Partial<AppConfig>) => Promise<void>;
}

interface UIProviderProfile {
  apiKey: string;
  baseUrl: string;
  model: string;
  customModel: string;
  useCustomModel: boolean;
  openaiMode: 'responses' | 'chat';
}

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export const FALLBACK_PROVIDER_PRESETS: ProviderPresets = {
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
    keyHint: 'Get from openrouter.ai/keys',
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
    keyHint: 'Get from console.anthropic.com',
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
    keyHint: 'Get from platform.openai.com',
  },
  custom: {
    name: 'More Models',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: [
      { id: 'glm-4.7', name: 'GLM-4.7' },
      { id: 'glm-4-plus', name: 'GLM-4-Plus' },
      { id: 'glm-4-air', name: 'GLM-4-Air' },
    ],
    keyPlaceholder: 'sk-xxx',
    keyHint: 'Enter your API Key',
  },
};

const PROFILE_KEYS: ProviderProfileKey[] = ['openrouter', 'anthropic', 'openai', 'custom:anthropic', 'custom:openai'];

function isProfileKey(value: unknown): value is ProviderProfileKey {
  return typeof value === 'string' && PROFILE_KEYS.includes(value as ProviderProfileKey);
}

export function profileKeyFromProvider(
  provider: ProviderType,
  customProtocol: CustomProtocolType = 'anthropic'
): ProviderProfileKey {
  if (provider !== 'custom') {
    return provider;
  }
  return customProtocol === 'openai' ? 'custom:openai' : 'custom:anthropic';
}

export function profileKeyToProvider(profileKey: ProviderProfileKey): {
  provider: ProviderType;
  customProtocol: CustomProtocolType;
} {
  if (profileKey === 'custom:openai') {
    return { provider: 'custom', customProtocol: 'openai' };
  }
  if (profileKey === 'custom:anthropic') {
    return { provider: 'custom', customProtocol: 'anthropic' };
  }
  return { provider: profileKey, customProtocol: 'anthropic' };
}

function modelPresetForProfile(profileKey: ProviderProfileKey, presets: ProviderPresets) {
  if (profileKey === 'custom:openai') {
    return presets.openai;
  }
  if (profileKey === 'custom:anthropic') {
    return presets.custom;
  }
  return presets[profileKey];
}

function defaultProfileForKey(profileKey: ProviderProfileKey, presets: ProviderPresets): UIProviderProfile {
  const preset = modelPresetForProfile(profileKey, presets);
  return {
    apiKey: '',
    baseUrl: preset.baseUrl,
    model: preset.models[0]?.id || '',
    customModel: '',
    useCustomModel: false,
    openaiMode: 'responses',
  };
}

function normalizeProfile(
  profileKey: ProviderProfileKey,
  profile: Partial<ProviderProfile> | undefined,
  presets: ProviderPresets
): UIProviderProfile {
  const fallback = defaultProfileForKey(profileKey, presets);
  const modelValue = profile?.model?.trim() || fallback.model;
  const hasPresetModel = modelPresetForProfile(profileKey, presets).models.some((item) => item.id === modelValue);
  return {
    apiKey: profile?.apiKey || '',
    baseUrl: profile?.baseUrl?.trim() || fallback.baseUrl,
    model: hasPresetModel ? modelValue : fallback.model,
    customModel: hasPresetModel ? '' : modelValue,
    useCustomModel: !hasPresetModel,
    openaiMode: profile?.openaiMode === 'chat' ? 'chat' : 'responses',
  };
}

interface ConfigStateSnapshot {
  activeProfileKey: ProviderProfileKey;
  profiles: Record<ProviderProfileKey, UIProviderProfile>;
  enableThinking: boolean;
}

export function buildApiConfigSnapshot(config: AppConfig | null | undefined, presets: ProviderPresets): ConfigStateSnapshot {
  const provider = config?.provider || 'openrouter';
  const customProtocol: CustomProtocolType = config?.customProtocol === 'openai' ? 'openai' : 'anthropic';
  const derivedProfileKey = profileKeyFromProvider(provider, customProtocol);
  const activeProfileKey = isProfileKey(config?.activeProfileKey) ? config.activeProfileKey : derivedProfileKey;

  const profiles = {} as Record<ProviderProfileKey, UIProviderProfile>;
  for (const key of PROFILE_KEYS) {
    profiles[key] = normalizeProfile(key, config?.profiles?.[key], presets);
  }

  const hasProfilesFromConfig = Boolean(config?.profiles && Object.keys(config.profiles).length > 0);
  if (!hasProfilesFromConfig) {
    profiles[activeProfileKey] = normalizeProfile(
      activeProfileKey,
      {
        apiKey: config?.apiKey || '',
        baseUrl: config?.baseUrl,
        model: config?.model,
        openaiMode: config?.openaiMode,
      },
      presets
    );
  }

  return {
    activeProfileKey,
    profiles,
    enableThinking: Boolean(config?.enableThinking),
  };
}

function toPersistedProfiles(
  profiles: Record<ProviderProfileKey, UIProviderProfile>
): Partial<Record<ProviderProfileKey, ProviderProfile>> {
  const persisted: Partial<Record<ProviderProfileKey, ProviderProfile>> = {};
  for (const key of PROFILE_KEYS) {
    const profile = profiles[key];
    const finalModel = profile.useCustomModel
      ? (profile.customModel.trim() || profile.model)
      : profile.model;
    persisted[key] = {
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl.trim() || undefined,
      model: finalModel,
      openaiMode: profile.openaiMode,
    };
  }
  return persisted;
}

export function useApiConfigState(options: UseApiConfigStateOptions = {}) {
  const { t } = useTranslation();
  const { enabled = true, initialConfig, onSave } = options;

  const [presets, setPresets] = useState<ProviderPresets>(FALLBACK_PROVIDER_PRESETS);
  const [profiles, setProfiles] = useState<Record<ProviderProfileKey, UIProviderProfile>>(() => {
    const snapshot = buildApiConfigSnapshot(initialConfig, FALLBACK_PROVIDER_PRESETS);
    return snapshot.profiles;
  });
  const [activeProfileKey, setActiveProfileKey] = useState<ProviderProfileKey>(() => {
    const snapshot = buildApiConfigSnapshot(initialConfig, FALLBACK_PROVIDER_PRESETS);
    return snapshot.activeProfileKey;
  });
  const [lastCustomProtocol, setLastCustomProtocol] = useState<CustomProtocolType>('anthropic');
  const [enableThinking, setEnableThinking] = useState(Boolean(initialConfig?.enableThinking));
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [testResult, setTestResult] = useState<ApiTestResult | null>(null);
  const [useLiveTest, setUseLiveTest] = useState(false);
  const [isImportingAuth, setIsImportingAuth] = useState<LocalAuthProvider | null>(null);

  const providerMeta = useMemo(() => profileKeyToProvider(activeProfileKey), [activeProfileKey]);
  const provider = providerMeta.provider;
  const customProtocol = providerMeta.customProtocol;
  const currentProfile = profiles[activeProfileKey] || defaultProfileForKey(activeProfileKey, presets);
  const currentPreset = provider === 'custom' ? presets.custom : presets[provider];
  const modelPreset = modelPresetForProfile(activeProfileKey, presets);
  const modelOptions = modelPreset.models;

  const apiKey = currentProfile.apiKey;
  const baseUrl = currentProfile.baseUrl;
  const model = currentProfile.model;
  const customModel = currentProfile.customModel;
  const useCustomModel = currentProfile.useCustomModel;
  const openaiMode = currentProfile.openaiMode;

  const isOpenAIMode = provider === 'openai' || (provider === 'custom' && customProtocol === 'openai');
  const requiresApiKey = !isOpenAIMode;
  const showsCompatibilityProbeHint = provider === 'openrouter' || (provider === 'custom' && customProtocol === 'anthropic');

  const updateActiveProfile = useCallback((updater: (prev: UIProviderProfile) => UIProviderProfile) => {
    setProfiles((prev) => ({
      ...prev,
      [activeProfileKey]: updater(prev[activeProfileKey] || defaultProfileForKey(activeProfileKey, presets)),
    }));
  }, [activeProfileKey, presets]);

  const changeProvider = useCallback((newProvider: ProviderType) => {
    const nextProfileKey = profileKeyFromProvider(
      newProvider,
      newProvider === 'custom' ? lastCustomProtocol : 'anthropic'
    );
    setActiveProfileKey(nextProfileKey);
  }, [lastCustomProtocol]);

  const changeProtocol = useCallback((newProtocol: CustomProtocolType) => {
    setLastCustomProtocol(newProtocol);
    setActiveProfileKey(profileKeyFromProvider('custom', newProtocol));
  }, []);

  const setApiKey = useCallback((value: string) => {
    updateActiveProfile((prev) => ({ ...prev, apiKey: value }));
  }, [updateActiveProfile]);

  const setBaseUrl = useCallback((value: string) => {
    updateActiveProfile((prev) => ({ ...prev, baseUrl: value }));
  }, [updateActiveProfile]);

  const setModel = useCallback((value: string) => {
    updateActiveProfile((prev) => ({ ...prev, model: value, useCustomModel: false }));
  }, [updateActiveProfile]);

  const setCustomModel = useCallback((value: string) => {
    updateActiveProfile((prev) => ({ ...prev, customModel: value, useCustomModel: true }));
  }, [updateActiveProfile]);

  const toggleCustomModel = useCallback(() => {
    updateActiveProfile((prev) => {
      if (!prev.useCustomModel) {
        return {
          ...prev,
          useCustomModel: true,
          customModel: prev.customModel || prev.model,
        };
      }
      return {
        ...prev,
        useCustomModel: false,
      };
    });
  }, [updateActiveProfile]);

  const setOpenaiMode = useCallback((value: 'responses' | 'chat') => {
    updateActiveProfile((prev) => ({ ...prev, openaiMode: value }));
  }, [updateActiveProfile]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    async function load() {
      setIsLoadingConfig(true);
      try {
        const loadedPresets = isElectron
          ? await window.electronAPI.config.getPresets()
          : FALLBACK_PROVIDER_PRESETS;
        const config = initialConfig || (isElectron ? await window.electronAPI.config.get() : null);
        if (cancelled) {
          return;
        }
        const snapshot = buildApiConfigSnapshot(config, loadedPresets);
        setPresets(loadedPresets);
        setProfiles(snapshot.profiles);
        setActiveProfileKey(snapshot.activeProfileKey);
        setEnableThinking(snapshot.enableThinking);
        const activeMeta = profileKeyToProvider(snapshot.activeProfileKey);
        if (activeMeta.provider === 'custom') {
          setLastCustomProtocol(activeMeta.customProtocol);
        } else {
          setLastCustomProtocol(config?.customProtocol === 'openai' ? 'openai' : 'anthropic');
        }
      } catch (loadError) {
        if (!cancelled) {
          console.error('Failed to load API config:', loadError);
          const snapshot = buildApiConfigSnapshot(initialConfig, FALLBACK_PROVIDER_PRESETS);
          setPresets(FALLBACK_PROVIDER_PRESETS);
          setProfiles(snapshot.profiles);
          setActiveProfileKey(snapshot.activeProfileKey);
          setEnableThinking(snapshot.enableThinking);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingConfig(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, initialConfig]);

  useEffect(() => {
    setError('');
    setTestResult(null);
  }, [activeProfileKey, apiKey, baseUrl, model, customModel, useCustomModel]);

  useEffect(() => {
    if (isOpenAIMode) {
      setOpenaiMode('responses');
    }
  }, [isOpenAIMode, setOpenaiMode]);

  const resolveLocalAuthProvider = useCallback((): LocalAuthProvider | null => {
    if (isOpenAIMode) {
      return 'codex';
    }
    return null;
  }, [isOpenAIMode]);

  const handleImportLocalAuth = useCallback(async () => {
    if (!window.electronAPI?.auth) {
      setError('Current environment does not support local auth import');
      return;
    }

    const authProvider = resolveLocalAuthProvider();
    if (!authProvider) {
      setError('Current provider does not support Codex local auth import');
      return;
    }

    setIsImportingAuth(authProvider);
    setError('');
    try {
      const imported = await window.electronAPI.auth.importToken(authProvider);
      if (!imported?.token) {
        setError('No local Codex login found. Please run: codex auth login');
        return;
      }
      setApiKey(imported.token);
      setSuccessMessage('Imported token from local Codex login');
      setTimeout(() => setSuccessMessage(''), 2500);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Failed to import local auth token');
    } finally {
      setIsImportingAuth(null);
    }
  }, [resolveLocalAuthProvider, setApiKey]);

  const handleTest = useCallback(async () => {
    if (!isOpenAIMode && !apiKey.trim()) {
      setError(t('api.testError.missing_key'));
      return;
    }

    const finalModel = useCustomModel ? customModel.trim() : model;
    if (!finalModel) {
      setError(t('api.selectModelRequired'));
      return;
    }

    setError('');
    setIsTesting(true);
    setTestResult(null);
    try {
      const resolvedBaseUrl = provider === 'custom'
        ? baseUrl.trim()
        : (currentPreset.baseUrl || baseUrl).trim();

      const result = await window.electronAPI.config.test({
        provider,
        apiKey: apiKey.trim(),
        baseUrl: resolvedBaseUrl || undefined,
        customProtocol,
        model: finalModel,
        useLiveRequest: useLiveTest,
      });
      setTestResult(result);
    } catch (testError) {
      setTestResult({
        ok: false,
        errorType: 'unknown',
        details: testError instanceof Error ? testError.message : String(testError),
      });
    } finally {
      setIsTesting(false);
    }
  }, [
    apiKey,
    baseUrl,
    currentPreset.baseUrl,
    customModel,
    customProtocol,
    isOpenAIMode,
    model,
    provider,
    t,
    useCustomModel,
    useLiveTest,
  ]);

  const handleSave = useCallback(async () => {
    if (!isOpenAIMode && !apiKey.trim()) {
      setError(t('api.testError.missing_key'));
      return;
    }

    const finalModel = useCustomModel ? customModel.trim() : model;
    if (!finalModel) {
      setError(t('api.selectModelRequired'));
      return;
    }

    setError('');
    setIsSaving(true);
    try {
      const resolvedBaseUrl = provider === 'custom'
        ? baseUrl.trim()
        : (currentPreset.baseUrl || baseUrl).trim();
      const resolvedOpenaiMode = isOpenAIMode ? 'responses' : openaiMode;
      const persistedProfiles = toPersistedProfiles(profiles);

      const payload: Partial<AppConfig> = {
        provider,
        apiKey: apiKey.trim(),
        baseUrl: resolvedBaseUrl || undefined,
        customProtocol,
        model: finalModel,
        openaiMode: resolvedOpenaiMode,
        activeProfileKey,
        profiles: persistedProfiles,
        enableThinking,
      };

      if (onSave) {
        await onSave(payload);
      } else {
        await window.electronAPI.config.save(payload);
      }
      setSuccessMessage(t('common.saved'));
      setTimeout(() => setSuccessMessage(''), 2000);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('api.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [
    activeProfileKey,
    apiKey,
    baseUrl,
    currentPreset.baseUrl,
    customModel,
    customProtocol,
    enableThinking,
    isOpenAIMode,
    model,
    onSave,
    openaiMode,
    profiles,
    provider,
    t,
    useCustomModel,
  ]);

  return {
    isLoadingConfig,
    presets,
    provider,
    customProtocol,
    modelOptions,
    currentPreset,
    apiKey,
    baseUrl,
    model,
    customModel,
    useCustomModel,
    openaiMode,
    enableThinking,
    isSaving,
    isTesting,
    error,
    successMessage,
    testResult,
    useLiveTest,
    isImportingAuth,
    isOpenAIMode,
    requiresApiKey,
    showsCompatibilityProbeHint,
    setApiKey,
    setBaseUrl,
    setModel,
    setCustomModel,
    toggleCustomModel,
    setUseLiveTest,
    setEnableThinking,
    changeProvider,
    changeProtocol,
    handleSave,
    handleTest,
    handleImportLocalAuth,
    resolveLocalAuthProvider,
    setError,
    setSuccessMessage,
  };
}
