import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import type {
  AppConfig,
  CustomProtocolType,
  ProviderModelInfo,
  ProviderPresets,
  ProviderType,
} from '../types';
import { getModelInputGuidance } from '../../shared/api-model-presets';
import { getCatalogEntry } from '../../shared/provider-catalog';
import {
  COMMON_PROVIDER_SETUPS,
  type CommonProviderSetup,
} from '../../shared/api-provider-guidance';
import {
  defaultModelFields,
  finalModelOf,
  formShapeFor,
  isCustomAnthropicLoopbackGateway,
  isCustomGeminiLoopbackGateway,
  isCustomOpenAiLoopbackGateway,
  isCustomProtocol,
  modelPresetFor,
  profileKeyFromProvider,
  profileKeyToProvider,
  translateApiConfigErrorMessage,
  type ModelFields,
} from './api-config-shared';
import {
  buildModelSetSavePayload,
  type ModelSetDraft,
  type PendingConfigSetAction,
} from './model-sets-state';
import {
  credentialTargetFor,
  credentialTargetKey,
  type CredentialDraft,
} from './provider-credentials-state';
import { useApiConfigMessages } from './useApiConfigMessages';
import { useApiConfigSource } from './useApiConfigSource';
import { useApiConnectivity } from './useApiConnectivity';
import { useCustomEndpointGuidance } from './useCustomEndpointGuidance';
import { useModelSets } from './useModelSets';
import { useProviderCredentials } from './useProviderCredentials';

export { getModelInputGuidance } from '../../shared/api-model-presets';
// The pure helpers moved to `api-config-shared`; they stay importable from here,
// where callers have always found them.
export {
  FALLBACK_PROVIDER_PRESETS,
  isCustomAnthropicLoopbackGateway,
  isCustomGeminiLoopbackGateway,
  isCustomOpenAiLoopbackGateway,
  mergeProviderCatalog,
  parseTokenLimitField,
  profileKeyFromProvider,
  profileKeyToProvider,
  resolveProviderProtocol,
  sanitizeCatalogEntry,
} from './api-config-shared';

interface UseApiConfigStateOptions {
  enabled?: boolean;
  initialConfig?: AppConfig | null;
  onSave?: (config: Partial<AppConfig>) => Promise<void>;
}

type CreateMode = 'blank' | 'clone';

/** The protocol a provider routes through. `custom` takes it from its endpoint. */
function protocolOf(provider: ProviderType, endpointProtocol: CustomProtocolType) {
  return provider === 'custom'
    ? endpointProtocol
    : profileKeyToProvider(profileKeyFromProvider(provider)).customProtocol;
}

function buildSetupModelState(
  setup: CommonProviderSetup,
  provider: ProviderType,
  customProtocol: CustomProtocolType,
  presets: ProviderPresets
): Pick<ModelFields, 'model' | 'customModel' | 'useCustomModel'> {
  const preset = modelPresetFor(provider, customProtocol, presets);
  const hasPresetModel = preset.models.some((item) => item.id === setup.exampleModel);
  return {
    model: hasPresetModel ? setup.exampleModel : preset.models[0]?.id || setup.exampleModel,
    customModel: hasPresetModel ? '' : setup.exampleModel,
    useCustomModel: !hasPresetModel,
  };
}

/**
 * One payload carrying both halves, for a caller that performs the save itself
 * (`onSave` — the first-run dialog, and the browser preview).
 *
 * This is the only place the two halves share a payload. Naming `apiKey` /
 * `baseUrl` / `customProtocol` here makes the store write the credential of the
 * provider the set is being moved to, which on first run is exactly what is
 * wanted: there is one provider and one set. The Settings screen does not use
 * this — it saves each half through its own call.
 */
export function buildCombinedSavePayload(input: {
  setDraft: ModelSetDraft;
  credentialDraft: CredentialDraft;
  customProtocol: CustomProtocolType;
  presetBaseUrl: string;
  activeConfigSetId: string;
}): Partial<AppConfig> {
  const { setDraft, credentialDraft, customProtocol, presetBaseUrl, activeConfigSetId } = input;
  const resolvedBaseUrl =
    setDraft.provider === 'custom' || setDraft.provider === 'ollama'
      ? credentialDraft.baseUrl.trim()
      : (presetBaseUrl || credentialDraft.baseUrl).trim();
  return {
    ...buildModelSetSavePayload(setDraft, activeConfigSetId),
    apiKey: credentialDraft.apiKey.trim(),
    baseUrl: resolvedBaseUrl || undefined,
    customProtocol,
  };
}

/**
 * State of the API-settings form as the current screens use it: one provider
 * picker, one key field, one model field, one Save.
 *
 * A thin layer over the two halves that actually own the state —
 * `useProviderCredentials` (keys, base URLs, custom endpoints) and
 * `useModelSets` (config sets and the model each one selects). Each half tracks
 * its own unsaved changes and saves through its own call; this layer only
 * presents them as the single form that exists today, and its Save runs one
 * after the other. Design: docs/design/provider-credentials-and-model-sets.md
 * §6.4.
 */
export function useApiConfigState(options: UseApiConfigStateOptions = {}) {
  const { t } = useTranslation();
  const { enabled = true, initialConfig, onSave } = options;
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const setIsConfigured = useAppStore((s) => s.setIsConfigured);

  // Presets, catalog and config arrive together from one loader. It is created
  // before the two halves (they need the presets) and reports to them through a
  // ref, because the handler that applies a loaded config is defined after them.
  const applyLoadedStateRef = useRef<
    (config: AppConfig | null | undefined, presets: ProviderPresets) => void
  >(() => {});
  const handleLoaded = useCallback(
    (config: AppConfig | null | undefined, loadedPresets: ProviderPresets) =>
      applyLoadedStateRef.current(config, loadedPresets),
    []
  );
  const { presets, providerCatalog, isCatalogLoading, isLoadingConfig } = useApiConfigSource({
    enabled,
    initialConfig,
    onLoaded: handleLoaded,
  });
  const [isSavingExternally, setIsSavingExternally] = useState(false);
  const [lastSaveCompletedAt, setLastSaveCompletedAt] = useState(0);
  // The credential edits an `onSave` caller has already saved. They stay edits
  // here until the caller's new config arrives, so this is what stops the form
  // from still reading as changed in between.
  const [externallySavedCredentials, setExternallySavedCredentials] = useState('');

  const messages = useApiConfigMessages();
  const {
    error,
    successMessage,
    clearError,
    clearSuccessMessage,
    showErrorKey,
    showErrorText,
    showSuccessKey,
    showSuccessText,
  } = messages;

  const credentials = useProviderCredentials({ initialConfig, presets, messages });

  // ---- what the form is showing ------------------------------------------
  //
  // The provider and model come from the config-set half; the key, base URL and
  // (for a custom endpoint) protocol from the credential that provider uses.

  const selectCredentialDraft = credentials.selectDraft;
  // What a model can do depends on where it is served from, so the config-set
  // half asks where a given draft would run: the protocol and address of the
  // credential its provider uses.
  const runtimeFor = useCallback(
    (setDraft: ModelSetDraft) => {
      const credential = selectCredentialDraft(
        credentialTargetFor(setDraft.provider, setDraft.endpointId)
      );
      return {
        customProtocol: protocolOf(setDraft.provider, credential.protocol),
        baseUrl: credential.baseUrl,
      };
    },
    [selectCredentialDraft]
  );
  const sets = useModelSets({ initialConfig, messages, runtimeFor });
  const { draft, configSets, activeConfigSetId, currentConfigSet, pendingConfigSetAction } = sets;

  const provider = draft.provider;
  const credentialTarget = useMemo(
    () => credentialTargetFor(provider, draft.endpointId),
    [provider, draft.endpointId]
  );
  const credentialDraft = selectCredentialDraft(credentialTarget);
  const customProtocol = protocolOf(provider, credentialDraft.protocol);
  const apiKey = credentialDraft.apiKey;
  const baseUrl = credentialDraft.baseUrl;
  const { model, customModel, useCustomModel, contextWindow, maxTokens, thinkingLevel } = draft;
  const enableThinking = thinkingLevel !== 'off';

  const currentPreset = modelPresetFor(provider, customProtocol, presets);

  // Catalog entry for the active provider — drives formShape, modelOptions, and
  // requiresApiKey/isOllamaMode for native providers.
  const activeCatalogEntry = useMemo(
    () => getCatalogEntry(providerCatalog, provider),
    [providerCatalog, provider]
  );
  // Form shape: only native providers use the catalog entry's formShape.
  // Builtins and custom keep legacy provider-literal checks below.
  const activeFormShape = useMemo(
    () => formShapeFor(providerCatalog, provider),
    [providerCatalog, provider]
  );

  const patchCredentialDraft = credentials.patchDraft;
  const setApiKey = useCallback(
    (value: string) => patchCredentialDraft(credentialTarget, { apiKey: value }),
    [patchCredentialDraft, credentialTarget]
  );
  const setBaseUrl = useCallback(
    (value: string) => patchCredentialDraft(credentialTarget, { baseUrl: value }),
    [patchCredentialDraft, credentialTarget]
  );

  // For native providers, formShape.apiKey === false means key is optional.
  // Use strict comparison to guard against undefined/partial catalog entries
  // (so a missing apiKey field never accidentally grants allowEmptyApiKey).
  // For builtins/custom the existing loopback-gateway logic applies.
  const allowEmptyApiKey =
    (activeFormShape !== null
      ? activeFormShape.apiKey === false // native: strict check only
      : provider === 'ollama') ||
    (provider === 'custom' &&
      ((customProtocol === 'anthropic' && isCustomAnthropicLoopbackGateway(baseUrl)) ||
        (customProtocol === 'openai' && isCustomOpenAiLoopbackGateway(baseUrl)) ||
        (customProtocol === 'gemini' && isCustomGeminiLoopbackGateway(baseUrl))));
  const requiresApiKey = !allowEmptyApiKey;

  // ---- unsaved changes ----------------------------------------------------

  const credentialsSignature = useMemo(
    () => JSON.stringify(credentials.dirtyTargets.map(({ targetKey, draft: d }) => [targetKey, d])),
    [credentials.dirtyTargets]
  );
  const hasUnsavedCredentialChanges =
    credentials.hasUnsavedChanges && credentialsSignature !== externallySavedCredentials;
  const hasUnsavedChanges = sets.hasUnsavedChanges || hasUnsavedCredentialChanges;

  // ---- connection test, diagnostics, Ollama discovery ----------------------

  const finalModel = finalModelOf(draft);
  const connectivity = useApiConnectivity({
    provider,
    customProtocol,
    apiKey,
    baseUrl,
    finalModel,
    presetBaseUrl: currentPreset.baseUrl,
    presetModels: currentPreset.models,
    requiresApiKey,
    hasUnsavedChanges,
    resetKey: `${activeConfigSetId}::${draft.endpointId}`,
    messages,
    setBaseUrl,
    updateModelFields: sets.updateModelFields,
  });
  const { testResult, discoveredOllamaModels } = connectivity;

  // Model options:
  // - ollama: discovered models from local endpoint detection
  // - any catalog entry with registry modelOptions (native + enriched builtins
  //   like OpenRouter/Anthropic/OpenAI/Gemini): use the live registry list
  // - otherwise (custom, or before the IPC catalog resolves): preset list
  const catalogModelOptions: ProviderModelInfo[] =
    activeCatalogEntry && Array.isArray(activeCatalogEntry.modelOptions)
      ? (activeCatalogEntry.modelOptions as ProviderModelInfo[])
      : [];
  const modelOptions: ProviderModelInfo[] =
    provider === 'ollama'
      ? discoveredOllamaModels || []
      : provider === 'custom'
        ? // Custom is bring-your-own-endpoint: the available models depend on the
          // user's endpoint, not a preset, so there are no model options — the
          // field is manual-entry only and the Preset/Custom toggle is disabled.
          []
        : catalogModelOptions.length > 0
          ? catalogModelOptions
          : currentPreset.models;
  const modelInputGuidance = getModelInputGuidance(provider, customProtocol);
  const shouldShowOllamaManualModelToggle =
    provider !== 'ollama' || useCustomModel || Boolean(error) || modelOptions.length === 0;

  const guidance = useCustomEndpointGuidance({
    provider,
    customProtocol,
    baseUrl,
    presets,
    testDetails: testResult?.details,
  });

  // ---- loading ------------------------------------------------------------

  const applySetsConfig = sets.applyPersistedConfig;
  const applyCredentialsConfig = credentials.applyPersistedConfig;

  /** Replace everything the form holds with what main has. Drops unsaved edits. */
  const applyLoadedState = useCallback(
    (config: AppConfig | null | undefined, loadedPresets: ProviderPresets) => {
      applySetsConfig(config, loadedPresets, 'reset');
      applyCredentialsConfig(
        config,
        'reset',
        isCustomProtocol(config?.customProtocol) ? config.customProtocol : 'anthropic'
      );
      setExternallySavedCredentials('');
    },
    [applyCredentialsConfig, applySetsConfig]
  );

  const publishConfig = useCallback(
    (config: AppConfig) => {
      setAppConfig(config);
      setIsConfigured(Boolean(config.isConfigured));
    },
    [setAppConfig, setIsConfigured]
  );

  // Assigned during render, not in an effect: the loader's own effect runs
  // before any effect declared here, and when nothing in a load has to be
  // awaited (the browser preview) it reports within that same pass — to a ref an
  // effect would not have filled yet, dropping the config.
  applyLoadedStateRef.current = applyLoadedState;

  useEffect(() => {
    if (!enabled) {
      setLastSaveCompletedAt(0);
    }
  }, [enabled]);

  // ---- provider, protocol, common setups -----------------------------------

  /**
   * The endpoint the form shows when it is on the custom provider: the one the
   * saved set points at, or none — a blank endpoint to fill in. An existing
   * endpoint is never picked on the user's behalf: it may be shared with other
   * sets, and typing a new address into it would move all of them.
   */
  const savedEndpointId =
    currentConfigSet?.provider === 'custom' &&
    credentials.customEndpoints.some((endpoint) => endpoint.id === currentConfigSet.endpointId)
      ? (currentConfigSet.endpointId ?? '')
      : '';

  const changeProviderOnSets = sets.changeProvider;
  const moveFormToProvider = useCallback(
    (newProvider: ProviderType): { endpointId: string; customProtocol: CustomProtocolType } => {
      const endpointId = newProvider === 'custom' ? savedEndpointId : '';
      const endpoint = credentials.customEndpoints.find((candidate) => candidate.id === endpointId);
      const nextProtocol = protocolOf(
        newProvider,
        endpoint?.protocol ?? credentials.lastCustomProtocol
      );
      changeProviderOnSets(
        newProvider,
        endpointId,
        defaultModelFields(newProvider, nextProtocol, presets, endpoint?.defaultModel)
      );
      return { endpointId, customProtocol: nextProtocol };
    },
    [
      changeProviderOnSets,
      credentials.customEndpoints,
      credentials.lastCustomProtocol,
      presets,
      savedEndpointId,
    ]
  );

  const changeProvider = useCallback(
    (newProvider: ProviderType) => {
      moveFormToProvider(newProvider);
    },
    [moveFormToProvider]
  );

  const setEndpointProtocol = credentials.setEndpointProtocol;
  const changeProtocol = useCallback(
    (newProtocol: CustomProtocolType) => {
      // The protocol is a property of the endpoint, so this edits the credential
      // the form is on. For a catalog provider there is nothing to change beyond
      // remembering the choice for the next custom endpoint.
      setEndpointProtocol(credentialTarget, newProtocol);
    },
    [credentialTarget, setEndpointProtocol]
  );

  const updateModelFields = sets.updateModelFields;
  const applyCommonProviderSetup = useCallback(
    (setupId: string) => {
      const setup = COMMON_PROVIDER_SETUPS.find((item) => item.id === setupId);
      if (!setup) {
        return;
      }

      const nextProvider = setup.applyProvider;
      // Already on this provider: keep the endpoint the form is showing.
      const endpointId =
        nextProvider === provider ? draft.endpointId : moveFormToProvider(nextProvider).endpointId;
      const target = credentialTargetFor(nextProvider, endpointId);
      const nextProtocol = protocolOf(nextProvider, setup.recommendedProtocol);
      if (nextProvider === 'custom') {
        setEndpointProtocol(target, setup.recommendedProtocol);
      }
      patchCredentialDraft(target, { baseUrl: setup.recommendedBaseUrl });
      updateModelFields((current) => ({
        ...current,
        ...buildSetupModelState(setup, nextProvider, nextProtocol, presets),
      }));
    },
    [
      draft.endpointId,
      moveFormToProvider,
      patchCredentialDraft,
      presets,
      provider,
      setEndpointProtocol,
      updateModelFields,
    ]
  );

  // ---- saving -------------------------------------------------------------

  const saveCredentials = credentials.saveCredentials;
  const saveSet = sets.saveSet;
  const markSetSaved = sets.markSaved;

  const handleSave = useCallback(
    async (saveOptions?: { silentSuccess?: boolean }) => {
      if (requiresApiKey && !apiKey.trim()) {
        showErrorKey('api.testError.missing_key');
        return false;
      }

      if (!finalModel) {
        showErrorKey('api.selectModelRequired');
        return false;
      }

      // A custom endpoint is defined by its address, so there is nothing to
      // save without one.
      if ((provider === 'ollama' || provider === 'custom') && !baseUrl.trim()) {
        showErrorKey('api.testError.missing_base_url');
        return false;
      }

      clearError();
      try {
        if (onSave) {
          setIsSavingExternally(true);
          await onSave(
            buildCombinedSavePayload({
              setDraft: draft,
              credentialDraft,
              customProtocol,
              presetBaseUrl: currentPreset.baseUrl,
              activeConfigSetId,
            })
          );
          markSetSaved();
          setExternallySavedCredentials(credentialsSignature);
        } else {
          // Credentials first: a custom endpoint created here is what the set
          // then has to point at. Each half goes through its own call, so a
          // failure in one leaves the other exactly as it was.
          const credentialResult = await saveCredentials({
            newEndpointDefaultModel: provider === 'custom' ? finalModel : undefined,
          });
          if (credentialResult.config) {
            applySetsConfig(credentialResult.config, presets, 'rebase');
            publishConfig(credentialResult.config);
          }
          if (!credentialResult.ok) {
            return false;
          }

          const resolvedEndpointId =
            credentialResult.resolvedEndpointIds[credentialTargetKey(credentialTarget)];
          const savedConfig = await saveSet(
            presets,
            provider === 'custom' && resolvedEndpointId
              ? { endpointId: resolvedEndpointId }
              : undefined
          );
          if (!savedConfig) {
            return false;
          }
          applyCredentialsConfig(savedConfig, 'rebase');
          publishConfig(savedConfig);
        }

        if (!saveOptions?.silentSuccess) {
          showSuccessKey('common.saved');
          setLastSaveCompletedAt(Date.now());
          setTimeout(() => clearSuccessMessage(), 2000);
        }
        return true;
      } catch (saveError) {
        if (saveError instanceof Error) {
          showErrorText(translateApiConfigErrorMessage(saveError.message, t));
        } else {
          showErrorKey('api.saveFailed');
        }
        return false;
      } finally {
        setIsSavingExternally(false);
      }
    },
    [
      activeConfigSetId,
      apiKey,
      applyCredentialsConfig,
      applySetsConfig,
      baseUrl,
      clearError,
      clearSuccessMessage,
      credentialDraft,
      credentialTarget,
      credentialsSignature,
      currentPreset.baseUrl,
      customProtocol,
      draft,
      finalModel,
      markSetSaved,
      onSave,
      presets,
      provider,
      publishConfig,
      requiresApiKey,
      saveCredentials,
      saveSet,
      showErrorKey,
      showErrorText,
      showSuccessKey,
      t,
    ]
  );

  // ---- config sets ---------------------------------------------------------

  /** A config-set call replaced the active set's content: take everything main returned. */
  const adoptConfig = useCallback(
    (config: AppConfig | null, credentialMode: 'reset' | 'rebase'): boolean => {
      if (!config) {
        return false;
      }
      applyCredentialsConfig(config, credentialMode);
      if (credentialMode === 'reset') {
        setExternallySavedCredentials('');
      }
      publishConfig(config);
      return true;
    },
    [applyCredentialsConfig, publishConfig]
  );

  const switchSetOnSets = sets.switchConfigSet;
  const switchConfigSet = useCallback(
    async (setId: string, switchOptions?: { silentSuccess?: boolean }) =>
      // Reached only with nothing unsaved, or after the user chose to discard.
      adoptConfig(await switchSetOnSets(presets, setId, switchOptions), 'reset'),
    [adoptConfig, presets, switchSetOnSets]
  );

  const createSetOnSets = sets.createConfigSet;
  const createConfigSet = useCallback(
    async (payload: { name: string; mode: CreateMode }) =>
      adoptConfig(await createSetOnSets(presets, payload), 'reset'),
    [adoptConfig, createSetOnSets, presets]
  );

  const createBlankConfigSet = useCallback(async () => {
    await createConfigSet({
      name: t('api.newSetDefaultName'),
      mode: 'blank',
    });
  }, [createConfigSet, t]);

  const setPendingConfigSetAction = sets.setPendingConfigSetAction;
  const requestConfigSetSwitch = useCallback(
    async (setId: string) => {
      if (!setId || setId === activeConfigSetId) {
        return;
      }

      const action: PendingConfigSetAction = { type: 'switch', targetSetId: setId };
      if (hasUnsavedChanges) {
        setPendingConfigSetAction(action);
        return;
      }

      await switchConfigSet(setId);
    },
    [activeConfigSetId, hasUnsavedChanges, setPendingConfigSetAction, switchConfigSet]
  );

  const cancelPendingConfigSetAction = useCallback(() => {
    setPendingConfigSetAction(null);
  }, [setPendingConfigSetAction]);

  const saveAndContinuePendingConfigSetAction = useCallback(async () => {
    if (!pendingConfigSetAction) {
      return;
    }
    const action = pendingConfigSetAction;
    const saved = await handleSave({ silentSuccess: true });
    if (!saved) {
      return;
    }
    setPendingConfigSetAction(null);
    await switchConfigSet(action.targetSetId);
  }, [handleSave, pendingConfigSetAction, setPendingConfigSetAction, switchConfigSet]);

  const discardAndContinuePendingConfigSetAction = useCallback(async () => {
    if (!pendingConfigSetAction) {
      return;
    }
    const action = pendingConfigSetAction;
    setPendingConfigSetAction(null);
    await switchConfigSet(action.targetSetId);
  }, [pendingConfigSetAction, setPendingConfigSetAction, switchConfigSet]);

  const requestCreateBlankConfigSet = useCallback(async () => {
    if (hasUnsavedChanges) {
      const saved = await handleSave({ silentSuccess: true });
      if (!saved) {
        return;
      }
    }
    await createBlankConfigSet();
  }, [createBlankConfigSet, handleSave, hasUnsavedChanges]);

  const renameSetOnSets = sets.renameConfigSet;
  const renameConfigSet = useCallback(
    async (id: string, name: string) =>
      // A rename changes no set's content and no credential, so unsaved edits
      // on either half are kept.
      adoptConfig(await renameSetOnSets(presets, id, name), 'rebase'),
    [adoptConfig, presets, renameSetOnSets]
  );

  const deleteSetOnSets = sets.deleteConfigSet;
  const deleteConfigSet = useCallback(
    async (id: string) =>
      adoptConfig(
        await deleteSetOnSets(presets, id),
        // Deleting the open set puts another one on the form.
        id === activeConfigSetId ? 'reset' : 'rebase'
      ),
    [activeConfigSetId, adoptConfig, deleteSetOnSets, presets]
  );

  return {
    isLoadingConfig,
    isCatalogLoading,
    presets,
    providerCatalog,
    activeCatalogEntry,
    activeFormShape,
    provider,
    customProtocol,
    modelOptions,
    currentPreset,
    apiKey,
    baseUrl,
    model,
    customModel,
    useCustomModel,
    contextWindow,
    maxTokens,
    modelInputPlaceholder: modelInputGuidance.placeholder,
    modelInputHint: modelInputGuidance.hint,
    enableThinking,
    thinkingLevel,
    effectiveThinkingLevel: sets.effectiveThinkingLevel,
    thinkingCapabilities: sets.thinkingCapabilities,
    isSaving: sets.isSaving || credentials.isSaving || isSavingExternally,
    isTesting: connectivity.isTesting,
    isRefreshingModels: connectivity.isRefreshingModels,
    isDiscoveringLocalOllama: connectivity.isDiscoveringLocalOllama,
    error,
    successMessage,
    lastSaveCompletedAt,
    testResult,
    friendlyTestDetails: guidance.friendlyTestDetails,
    diagnosticResult: connectivity.diagnosticResult,
    isDiagnosing: connectivity.isDiagnosing,
    handleDiagnose: connectivity.handleDiagnose,
    handleDeepDiagnose: connectivity.handleDeepDiagnose,
    isOllamaMode: activeFormShape
      ? activeFormShape.baseUrl === true && activeFormShape.apiKey === false
      : provider === 'ollama',
    shouldShowOllamaManualModelToggle,
    requiresApiKey,
    detectedProviderSetup: guidance.detectedProviderSetup,
    protocolGuidanceText: guidance.protocolGuidanceText,
    protocolGuidanceTone: guidance.protocolGuidanceTone,
    baseUrlGuidanceText: guidance.baseUrlGuidanceText,
    commonProviderSetups: guidance.commonProviderSetups,
    configSets,
    activeConfigSetId,
    currentConfigSet,
    pendingConfigSetAction,
    pendingConfigSet: sets.pendingConfigSet,
    hasUnsavedChanges,
    isMutatingConfigSet: sets.isMutatingConfigSet,
    canDeleteCurrentConfigSet: sets.canDeleteCurrentConfigSet,
    configSetLimit: sets.configSetLimit,
    setApiKey,
    setBaseUrl,
    setModel: sets.setModel,
    setCustomModel: sets.setCustomModel,
    setContextWindow: sets.setContextWindow,
    setMaxTokens: sets.setMaxTokens,
    toggleCustomModel: sets.toggleCustomModel,
    setThinkingLevel: sets.setThinkingLevel,
    applyCommonProviderSetup,
    changeProvider,
    changeProtocol,
    requestConfigSetSwitch,
    requestCreateBlankConfigSet,
    cancelPendingConfigSetAction,
    saveAndContinuePendingConfigSetAction,
    discardAndContinuePendingConfigSetAction,
    createConfigSet,
    renameConfigSet,
    deleteConfigSet,
    handleSave,
    handleTest: connectivity.handleTest,
    refreshModelOptions: connectivity.refreshModelOptions,
    discoverLocalOllama: connectivity.discoverLocalOllama,
    setError: showErrorText,
    setSuccessMessage: showSuccessText,
  };
}
