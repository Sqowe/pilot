import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig, ProviderModelInfo } from '../types';
import { getModelInputGuidance } from '../../shared/api-model-presets';
import { getCatalogEntry } from '../../shared/provider-catalog';
import {
  defaultModelFields,
  finalModelOf,
  formShapeFor,
  modelPresetFor,
  protocolOf,
} from './api-config-shared';
import {
  buildProviderChoices,
  endpointNeedsKey,
  parseProviderChoice,
  persistedCredentialFor,
  providerChoiceId,
  providerNeedsKey,
} from './api-settings-view';
import type { PendingConfigSetAction } from './model-sets-state';
import { useApiConnectivity } from './useApiConnectivity';
import type { ApiSettingsState } from './useApiSettingsState';

/**
 * The address belongs to the credential, which this tab does not edit. Only
 * Ollama discovery ever writes one, and that runs where the address is edited.
 */
const ignoreAddress = () => {};

/**
 * The **Model Sets** tab as a form: which provider or custom endpoint the open
 * config set uses, its model, limits and thinking level — and nothing a
 * credential stores.
 *
 * Reads the credential behind the chosen provider as it is persisted, to show
 * where the set would run and to test it, and never writes one. Save sends the
 * set's own fields only (design §6.4).
 */
export function useModelSetForm(settings: ApiSettingsState) {
  const { t } = useTranslation();
  const { presets, providerCatalog, credentials, sets, messages, takeConfig } = settings;
  const { clearSuccessMessage, showErrorKey, showSuccessKey } = messages;
  const { draft, configSets, activeConfigSetId, pendingConfigSetAction } = sets;

  // ---- where the set would run ---------------------------------------------

  const provider = draft.provider;
  // An unsaved choice can outlive its endpoint: one that no saved set uses may
  // be deleted on the other tab. The set then points at nothing.
  const endpoint =
    provider === 'custom'
      ? credentials.customEndpoints.find((candidate) => candidate.id === draft.endpointId)
      : undefined;
  const endpointId = endpoint?.id ?? '';
  const credential = persistedCredentialFor(provider, endpointId, credentials, presets);
  const customProtocol = protocolOf(provider, credential.protocol);
  const { apiKey, baseUrl } = credential;
  const requiresApiKey =
    provider === 'custom'
      ? !endpoint || endpointNeedsKey(endpoint)
      : providerNeedsKey(provider, providerCatalog);

  const providerChoices = useMemo(
    () =>
      buildProviderChoices({
        catalog: providerCatalog,
        credentials,
        configSets,
        current: { provider, endpointId },
      }),
    [providerCatalog, credentials, configSets, provider, endpointId]
  );
  const providerChoice = providerChoiceId(provider, endpointId);

  const changeProviderOnSets = sets.changeProvider;
  const changeProviderChoice = useCallback(
    (choiceId: string) => {
      const choice = parseProviderChoice(choiceId);
      if (!choice) {
        return;
      }
      const chosenEndpoint = credentials.customEndpoints.find(
        (candidate) => candidate.id === choice.endpointId
      );
      if (choice.provider === 'custom' && !chosenEndpoint) {
        // "No endpoint" is a state a set can be in, not something to move it to.
        return;
      }
      const protocol = protocolOf(choice.provider, chosenEndpoint?.protocol ?? 'anthropic');
      changeProviderOnSets(
        choice.provider,
        chosenEndpoint?.id ?? '',
        defaultModelFields(choice.provider, protocol, presets, chosenEndpoint?.defaultModel)
      );
    },
    [changeProviderOnSets, credentials.customEndpoints, presets]
  );

  // ---- model ---------------------------------------------------------------

  const { model, customModel, useCustomModel, contextWindow, maxTokens } = draft;
  const finalModel = finalModelOf(draft);
  const currentPreset = modelPresetFor(provider, customProtocol, presets);
  const activeCatalogEntry = useMemo(
    () => getCatalogEntry(providerCatalog, provider),
    [providerCatalog, provider]
  );
  // Only native providers use the catalog entry's form shape. Builtins and
  // custom keep the provider-literal checks the form has always had.
  const activeFormShape = useMemo(
    () => formShapeFor(providerCatalog, provider),
    [providerCatalog, provider]
  );

  const hasUnsavedChanges = sets.hasUnsavedChanges;
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
    resetKey: `${activeConfigSetId}::${endpointId}`,
    messages,
    setBaseUrl: ignoreAddress,
    updateModelFields: sets.updateModelFields,
  });
  const { discoveredOllamaModels } = connectivity;

  // - ollama: the models its server reports;
  // - custom: none — an endpoint serves whatever its owner configured, so the
  //   model is typed;
  // - otherwise the registry list from the catalog, or the preset list until
  //   the catalog has loaded.
  const catalogModelOptions: ProviderModelInfo[] =
    activeCatalogEntry && Array.isArray(activeCatalogEntry.modelOptions)
      ? (activeCatalogEntry.modelOptions as ProviderModelInfo[])
      : [];
  const modelOptions: ProviderModelInfo[] =
    provider === 'ollama'
      ? discoveredOllamaModels || []
      : provider === 'custom'
        ? []
        : catalogModelOptions.length > 0
          ? catalogModelOptions
          : currentPreset.models;
  const modelInputGuidance = getModelInputGuidance(provider, customProtocol);
  const shouldShowOllamaManualModelToggle =
    provider !== 'ollama' || useCustomModel || Boolean(messages.error) || modelOptions.length === 0;

  // ---- saving --------------------------------------------------------------

  // One timer for the success line, so a newer "saved" is not cut short by an
  // older one's timer, and none is left running once the tab is gone.
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
      }
    },
    []
  );

  const saveSet = sets.saveSet;
  const handleSave = useCallback(
    async (saveOptions?: { silentSuccess?: boolean }) => {
      if (!finalModel) {
        showErrorKey('api.selectModelRequired');
        return false;
      }
      // A custom set runs on an endpoint; with none it resolves to nothing.
      if (provider === 'custom' && !endpointId) {
        showErrorKey('api.modelSets.endpointRequired');
        return false;
      }

      const savedConfig = await saveSet(presets);
      if (!savedConfig) {
        return false;
      }
      takeConfig(savedConfig);

      if (!saveOptions?.silentSuccess) {
        showSuccessKey('common.saved');
        if (successTimerRef.current) {
          clearTimeout(successTimerRef.current);
        }
        successTimerRef.current = setTimeout(() => clearSuccessMessage(), 2000);
      }
      return true;
    },
    [
      clearSuccessMessage,
      endpointId,
      finalModel,
      presets,
      provider,
      saveSet,
      showErrorKey,
      showSuccessKey,
      takeConfig,
    ]
  );

  // ---- config sets ---------------------------------------------------------

  const adoptConfig = useCallback(
    (config: AppConfig | null): boolean => {
      if (!config) {
        return false;
      }
      takeConfig(config);
      return true;
    },
    [takeConfig]
  );

  const switchSetOnSets = sets.switchConfigSet;
  const switchConfigSet = useCallback(
    // Reached only with nothing unsaved, or after the user chose to discard.
    async (setId: string) => adoptConfig(await switchSetOnSets(presets, setId)),
    [adoptConfig, presets, switchSetOnSets]
  );

  const setPendingConfigSetAction = sets.setPendingConfigSetAction;
  const requestConfigSetSwitch = useCallback(
    async (setId: string) => {
      if (!setId || setId === activeConfigSetId) {
        return;
      }
      if (hasUnsavedChanges) {
        const action: PendingConfigSetAction = { type: 'switch', targetSetId: setId };
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

  const createSetOnSets = sets.createConfigSet;
  const requestCreateBlankConfigSet = useCallback(async () => {
    if (hasUnsavedChanges) {
      const saved = await handleSave({ silentSuccess: true });
      if (!saved) {
        return;
      }
    }
    adoptConfig(
      await createSetOnSets(presets, { name: t('api.newSetDefaultName'), mode: 'blank' })
    );
  }, [adoptConfig, createSetOnSets, handleSave, hasUnsavedChanges, presets, t]);

  const renameSetOnSets = sets.renameConfigSet;
  const renameConfigSet = useCallback(
    async (id: string, name: string) => adoptConfig(await renameSetOnSets(presets, id, name)),
    [adoptConfig, presets, renameSetOnSets]
  );

  const deleteSetOnSets = sets.deleteConfigSet;
  const deleteConfigSet = useCallback(
    async (id: string) => adoptConfig(await deleteSetOnSets(presets, id)),
    [adoptConfig, deleteSetOnSets, presets]
  );

  return {
    provider,
    endpoint,
    customProtocol,
    apiKey,
    baseUrl,
    requiresApiKey,
    providerChoices,
    providerChoice,
    changeProviderChoice,
    activeCatalogEntry,
    activeFormShape,
    currentPreset,
    modelOptions,
    model,
    customModel,
    useCustomModel,
    contextWindow,
    maxTokens,
    modelInputPlaceholder: modelInputGuidance.placeholder,
    modelInputHint: modelInputGuidance.hint,
    // The provider itself, not "keyless with an address": what these controls
    // do — refresh and discovery — only ever runs for Ollama.
    isOllamaMode: provider === 'ollama',
    shouldShowOllamaManualModelToggle,
    effectiveThinkingLevel: sets.effectiveThinkingLevel,
    thinkingCapabilities: sets.thinkingCapabilities,
    setModel: sets.setModel,
    setCustomModel: sets.setCustomModel,
    toggleCustomModel: sets.toggleCustomModel,
    setContextWindow: sets.setContextWindow,
    setMaxTokens: sets.setMaxTokens,
    setThinkingLevel: sets.setThinkingLevel,
    isRefreshingModels: connectivity.isRefreshingModels,
    refreshModelOptions: connectivity.refreshModelOptions,
    diagnosticResult: connectivity.diagnosticResult,
    isDiagnosing: connectivity.isDiagnosing,
    handleDiagnose: connectivity.handleDiagnose,
    handleDeepDiagnose: connectivity.handleDeepDiagnose,
    configSets,
    activeConfigSetId,
    currentConfigSet: sets.currentConfigSet,
    pendingConfigSetAction,
    pendingConfigSet: sets.pendingConfigSet,
    hasUnsavedChanges,
    isSaving: sets.isSaving,
    isMutatingConfigSet: sets.isMutatingConfigSet,
    // While a call that changes a config set is on its way, what comes back
    // replaces what is on screen. An edit made in that moment would be shown
    // and then silently lost, so the fields hold still until it has returned.
    isLocked: sets.isSaving || sets.isMutatingConfigSet,
    canDeleteCurrentConfigSet: sets.canDeleteCurrentConfigSet,
    error: messages.error,
    successMessage: messages.successMessage,
    handleSave,
    requestConfigSetSwitch,
    requestCreateBlankConfigSet,
    cancelPendingConfigSetAction,
    saveAndContinuePendingConfigSetAction,
    discardAndContinuePendingConfigSetAction,
    renameConfigSet,
    deleteConfigSet,
  };
}
