import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApiTestResult,
  CustomProtocolType,
  DiagnosticResult,
  ProviderModelInfo,
  ProviderType,
} from '../types';
import { isLoopbackBaseUrl } from '../../shared/network/loopback';
import { DEFAULT_OLLAMA_BASE_URL, normalizeOllamaBaseUrl } from '../../shared/ollama-base-url';
import {
  isElectron,
  normalizeDiscoveredOllamaModels,
  withoutDiscoveredModel,
  type ModelFields,
} from './api-config-shared';
import type { ApiConfigMessages } from './useApiConfigMessages';

interface UseApiConnectivityOptions {
  provider: ProviderType;
  customProtocol: CustomProtocolType;
  apiKey: string;
  baseUrl: string;
  /** The model id the form currently stands for; '' when none is chosen. */
  finalModel: string;
  /** The provider's usual address, used when the form has none of its own. */
  presetBaseUrl: string;
  /** The provider's built-in model list — models that exist on any server. */
  presetModels: ProviderModelInfo[];
  requiresApiKey: boolean;
  hasUnsavedChanges: boolean;
  /** Changes when the form is showing something else, so stale results are dropped. */
  resetKey: string;
  messages: ApiConfigMessages;
  setBaseUrl: (value: string) => void;
  updateModelFields: (updater: (previous: ModelFields) => ModelFields) => void;
}

/**
 * Everything on the API-settings form that talks to a provider rather than to
 * the config store: the connection test, the diagnostics run, and — for Ollama
 * — finding the local server and listing its models.
 *
 * Works from the values the form is showing, saved or not, so a key can be
 * tried before it is kept.
 */
export function useApiConnectivity(options: UseApiConnectivityOptions) {
  const {
    provider,
    customProtocol,
    apiKey,
    baseUrl,
    finalModel,
    presetBaseUrl,
    presetModels,
    requiresApiKey,
    hasUnsavedChanges,
    resetKey,
    messages,
    setBaseUrl,
    updateModelFields,
  } = options;
  const { clearError, clearSuccessMessage, showErrorKey, showErrorText, showSuccessKey } = messages;

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ApiTestResult | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<DiagnosticResult | null>(null);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [isDiscoveringLocalOllama, setIsDiscoveringLocalOllama] = useState(false);
  // undefined = never asked; [] = asked and the server has none (or is gone).
  const [discoveredOllamaModels, setDiscoveredOllamaModels] = useState<
    ProviderModelInfo[] | undefined
  >(undefined);

  const ollamaRefreshRequestIdRef = useRef(0);
  const ollamaDiscoverRequestIdRef = useRef(0);
  const latestOllamaTargetRef = useRef<{ baseUrl: string; provider: ProviderType }>({
    baseUrl: '',
    provider: 'openrouter',
  });

  // A result describes the values it was run against. Once any of them changes
  // it describes something else, so it goes — and so does any request still on
  // its way: the generation it was started under is over, and its answer is
  // dropped when it arrives rather than shown against a form it no longer fits.
  const resultGenerationRef = useRef(0);
  useEffect(() => {
    resultGenerationRef.current += 1;
    clearError();
    setTestResult(null);
    setDiagnosticResult(null);
    setIsTesting(false);
    setIsDiagnosing(false);
  }, [resetKey, provider, customProtocol, apiKey, baseUrl, finalModel, clearError]);

  useEffect(() => {
    latestOllamaTargetRef.current = { baseUrl: baseUrl.trim(), provider };
  }, [baseUrl, provider]);

  /** True when an Ollama answer arrived for an address the form has since left. */
  const isStaleOllamaAnswer = useCallback((requestedBaseUrl: string) => {
    const latestTarget = latestOllamaTargetRef.current;
    return latestTarget.provider !== 'ollama' || latestTarget.baseUrl !== requestedBaseUrl;
  }, []);

  // The Ollama address the discovered list — and a model picked from it —
  // belongs to. null until the form has shown Ollama at all.
  const ollamaModelsUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (provider !== 'ollama') {
      return;
    }
    const currentUrl = baseUrl.trim();
    const previousUrl = ollamaModelsUrlRef.current;
    ollamaModelsUrlRef.current = currentUrl;
    // Only a *change* of address makes the list stale. Running on every pass
    // (mount, presets arriving, the address discovery itself just set) would
    // throw away a list that is still right, and the model picked from it.
    if (previousUrl === null || previousUrl === currentUrl) {
      return;
    }
    setDiscoveredOllamaModels(undefined);
    // Clear a model that came from the old server's list, so the next discovery
    // chooses one this server actually has.
    updateModelFields((current) => withoutDiscoveredModel(current, presetModels));
  }, [baseUrl, provider, presetModels, updateModelFields]);

  const resolveBaseUrl = useCallback(
    () =>
      provider === 'custom' || provider === 'ollama'
        ? baseUrl.trim()
        : (baseUrl.trim() || presetBaseUrl || '').trim(),
    [baseUrl, presetBaseUrl, provider]
  );

  const handleTest = useCallback(async () => {
    if (requiresApiKey && !apiKey.trim()) {
      showErrorKey('api.testError.missing_key');
      return;
    }

    if (!finalModel) {
      showErrorKey('api.selectModelRequired');
      return;
    }

    // Same rule as Save: Ollama and a custom endpoint are defined by their
    // address, so there is nothing to test without one.
    if ((provider === 'ollama' || provider === 'custom') && !baseUrl.trim()) {
      showErrorKey('api.testError.missing_base_url');
      return;
    }

    clearError();
    setIsTesting(true);
    setTestResult(null);
    const generation = resultGenerationRef.current;
    const isCurrent = () => generation === resultGenerationRef.current;
    try {
      const result = await window.electronAPI.config.test({
        provider,
        apiKey: apiKey.trim(),
        baseUrl: resolveBaseUrl() || undefined,
        customProtocol,
        model: finalModel,
      });
      if (!isCurrent()) {
        return;
      }
      setTestResult(result);
      if (result.ok && hasUnsavedChanges) {
        showSuccessKey('api.testSuccessNeedSave');
        setTimeout(() => clearSuccessMessage(), 2500);
      }
    } catch (testError) {
      if (!isCurrent()) {
        return;
      }
      setTestResult({
        ok: false,
        errorType: 'unknown',
        details: testError instanceof Error ? testError.message : String(testError),
      });
    } finally {
      // The reset that ended this generation already cleared the flag; a newer
      // request may have raised it again since.
      if (isCurrent()) {
        setIsTesting(false);
      }
    }
  }, [
    apiKey,
    baseUrl,
    customProtocol,
    finalModel,
    provider,
    requiresApiKey,
    hasUnsavedChanges,
    resolveBaseUrl,
    clearError,
    clearSuccessMessage,
    showErrorKey,
    showSuccessKey,
  ]);

  const handleDiagnose = useCallback(
    async (verificationLevel: 'fast' | 'deep' = 'fast') => {
      if (requiresApiKey && !apiKey.trim()) {
        showErrorKey('api.testError.missing_key');
        return;
      }

      clearError();
      setIsDiagnosing(true);
      setDiagnosticResult(null);
      setTestResult(null);
      const generation = resultGenerationRef.current;
      const isCurrent = () => generation === resultGenerationRef.current;
      try {
        const result = await window.electronAPI.config.diagnose({
          provider,
          apiKey: apiKey.trim(),
          baseUrl: resolveBaseUrl() || undefined,
          customProtocol,
          model: finalModel || undefined,
          verificationLevel,
        });
        if (isCurrent()) {
          setDiagnosticResult(result);
        }
      } catch (err) {
        if (isCurrent()) {
          showErrorText((err as Error).message || 'Diagnosis failed');
        }
      } finally {
        if (isCurrent()) {
          setIsDiagnosing(false);
        }
      }
    },
    [
      requiresApiKey,
      apiKey,
      provider,
      customProtocol,
      finalModel,
      resolveBaseUrl,
      clearError,
      showErrorKey,
      showErrorText,
    ]
  );

  const handleDeepDiagnose = useCallback(async () => {
    await handleDiagnose('deep');
  }, [handleDiagnose]);

  /** Pick a discovered model when the form has none, or one this server lacks. */
  const selectDiscoveredModel = useCallback(
    (models: ProviderModelInfo[], autoSelectModelId: string | undefined) => {
      updateModelFields((current) => {
        const explicitManualModel = current.useCustomModel ? current.customModel.trim() : '';
        const currentModel = explicitManualModel || current.model.trim();
        const hasDiscoveredMatch = models.some((item) => item.id === currentModel);
        const shouldAutoSelectModel =
          Boolean(autoSelectModelId) &&
          !explicitManualModel &&
          (!currentModel || !hasDiscoveredMatch);

        return {
          ...current,
          model: shouldAutoSelectModel ? autoSelectModelId! : current.model,
          useCustomModel: shouldAutoSelectModel ? false : current.useCustomModel,
        };
      });
    },
    [updateModelFields]
  );

  const refreshModelOptions = useCallback(async () => {
    if (!isElectron || provider !== 'ollama') {
      return [];
    }

    const requestedBaseUrl = baseUrl.trim();
    const requestId = ++ollamaRefreshRequestIdRef.current;

    setIsRefreshingModels(true);
    clearError();
    try {
      const models = await window.electronAPI.config.listModels({
        provider,
        apiKey: apiKey.trim(),
        baseUrl: requestedBaseUrl || undefined,
      });

      if (
        requestId !== ollamaRefreshRequestIdRef.current ||
        isStaleOllamaAnswer(requestedBaseUrl)
      ) {
        return models;
      }

      setDiscoveredOllamaModels(models);
      selectDiscoveredModel(models, models[0]?.id);
      return models;
    } catch (refreshError) {
      if (
        requestId !== ollamaRefreshRequestIdRef.current ||
        isStaleOllamaAnswer(requestedBaseUrl)
      ) {
        return [];
      }
      setDiscoveredOllamaModels([]);
      if (refreshError instanceof Error) {
        showErrorText(refreshError.message);
      } else {
        showErrorKey('api.refreshModelsFailed');
      }
      return [];
    } finally {
      if (requestId === ollamaRefreshRequestIdRef.current) {
        setIsRefreshingModels(false);
      }
    }
  }, [
    apiKey,
    baseUrl,
    provider,
    clearError,
    isStaleOllamaAnswer,
    selectDiscoveredModel,
    showErrorKey,
    showErrorText,
  ]);

  // Auto-refresh model list when Ollama baseUrl changes (debounced).
  // Only fires for URLs that look plausible (start with http(s):// and have a host).
  useEffect(() => {
    if (provider !== 'ollama') return;
    const trimmed = baseUrl.trim();
    if (!trimmed || !/^https?:\/\/.{3,}/i.test(trimmed)) return;
    const timer = setTimeout(() => {
      void refreshModelOptions();
    }, 800);
    return () => clearTimeout(timer);
  }, [provider, baseUrl, refreshModelOptions]);

  const discoverLocalOllama = useCallback(
    async (discoverOptions?: { silent?: boolean }) => {
      if (!isElectron || provider !== 'ollama') {
        return null;
      }

      const requestedBaseUrl = baseUrl.trim();
      const shouldClearDiscoveredModels = !requestedBaseUrl || isLoopbackBaseUrl(requestedBaseUrl);
      const requestId = ++ollamaDiscoverRequestIdRef.current;
      setIsDiscoveringLocalOllama(true);
      if (!discoverOptions?.silent) {
        clearError();
      }

      try {
        const result = await window.electronAPI.config.discoverLocal({
          baseUrl: requestedBaseUrl || undefined,
        });
        if (
          requestId !== ollamaDiscoverRequestIdRef.current ||
          isStaleOllamaAnswer(requestedBaseUrl)
        ) {
          return result;
        }
        if (!result.available) {
          if (shouldClearDiscoveredModels) {
            setDiscoveredOllamaModels([]);
          }
          if (!discoverOptions?.silent) {
            showErrorKey('api.localOllamaNotFound');
          }
          return result;
        }

        const models = normalizeDiscoveredOllamaModels(result.models);
        const discoveredUrl = normalizeOllamaBaseUrl(result.baseUrl) || DEFAULT_OLLAMA_BASE_URL;
        // The list below is for this address. Recording that before the address
        // is set keeps the address-change reset from reading discovery's own
        // write as the user moving to another server, and undoing it.
        ollamaModelsUrlRef.current = discoveredUrl;
        // The address goes to the credential, the model to the config set —
        // discovery is the one place that fills both.
        setBaseUrl(discoveredUrl);
        selectDiscoveredModel(models, models[0]?.id);
        setDiscoveredOllamaModels(models);

        if (!discoverOptions?.silent) {
          if (result.status === 'service_available') {
            showErrorKey('api.localOllamaNoModels');
          } else {
            showSuccessKey('api.localOllamaDiscovered', { count: models.length });
            setTimeout(() => clearSuccessMessage(), 2500);
          }
        }
        return result;
      } catch (discoveryError) {
        if (
          requestId !== ollamaDiscoverRequestIdRef.current ||
          isStaleOllamaAnswer(requestedBaseUrl)
        ) {
          return null;
        }
        if (shouldClearDiscoveredModels) {
          setDiscoveredOllamaModels([]);
        }
        if (!discoverOptions?.silent) {
          if (discoveryError instanceof Error) {
            showErrorText(discoveryError.message);
          } else {
            showErrorKey('api.localOllamaNotFound');
          }
        }
        return null;
      } finally {
        if (requestId === ollamaDiscoverRequestIdRef.current) {
          setIsDiscoveringLocalOllama(false);
        }
      }
    },
    [
      baseUrl,
      clearError,
      clearSuccessMessage,
      isStaleOllamaAnswer,
      provider,
      selectDiscoveredModel,
      setBaseUrl,
      showErrorKey,
      showErrorText,
      showSuccessKey,
    ]
  );

  return {
    isTesting,
    testResult,
    handleTest,
    isDiagnosing,
    diagnosticResult,
    handleDiagnose,
    handleDeepDiagnose,
    isRefreshingModels,
    refreshModelOptions,
    isDiscoveringLocalOllama,
    discoverLocalOllama,
    discoveredOllamaModels,
  };
}
