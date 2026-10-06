import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppConfig,
  CustomProtocolType,
  ModelThinkingLevel,
  ProviderPresets,
  ProviderType,
  ThinkingCapabilities,
} from '../types';
import { clampToSupportedLevel } from '../../shared/thinking-levels';
import {
  CONFIG_SET_LIMIT,
  FALLBACK_PROVIDER_PRESETS,
  finalModelOf,
  isElectron,
  translateApiConfigErrorMessage,
  type ModelFields,
} from './api-config-shared';
import {
  buildModelSetSavePayload,
  buildModelSetsBootstrap,
  createModelSetsState,
  hasUnsavedModelSetChanges,
  modelSetsReducer,
  type ModelSetDraft,
  type PendingConfigSetAction,
} from './model-sets-state';
import type { ApiConfigMessages } from './useApiConfigMessages';

type CreateMode = 'blank' | 'clone';

interface UseModelSetsOptions {
  initialConfig?: AppConfig | null;
  messages: ApiConfigMessages;
  /**
   * The protocol and address a draft would run with. Not part of a config set —
   * they belong to the credential — but what a model can do depends on where it
   * is served from, so the capability query needs them.
   *
   * A function of the draft, called during render, so the answer always belongs
   * to the draft being rendered. Handing the values in as state set from an
   * effect would lag one render behind and ask about the wrong place first.
   */
  runtimeFor: (draft: ModelSetDraft) => { customProtocol: CustomProtocolType; baseUrl: string };
  /**
   * Main returned a new config. Called for every successful call made here, so
   * whoever shares the screen can refresh what it holds.
   */
  onConfigPersisted?: (config: AppConfig) => void;
}

/**
 * The **model sets** half of API settings: the list of config sets, the active
 * one, and the unsaved edits to it.
 *
 * Saves the active set through `config.save` with a payload that names no
 * credential field, so saving a model can never write a key. Unsaved-change
 * tracking covers the set's own fields only. See `model-sets-state.ts`.
 */
export function useModelSets(options: UseModelSetsOptions) {
  const { t } = useTranslation();
  const { initialConfig, messages, runtimeFor, onConfigPersisted } = options;
  const { clearError, clearSuccessMessage, showErrorKey, showErrorText, showSuccessKey } = messages;

  const [state, dispatch] = useReducer(modelSetsReducer, undefined, () =>
    createModelSetsState(initialConfig, FALLBACK_PROVIDER_PRESETS)
  );
  const { configSets, activeConfigSetId, draft, pendingConfigSetAction, thinkingCapabilities } =
    state;

  const currentConfigSet = useMemo(
    () => configSets.find((set) => set.id === activeConfigSetId) || null,
    [configSets, activeConfigSetId]
  );
  const pendingConfigSet = useMemo(
    () =>
      pendingConfigSetAction?.type === 'switch'
        ? configSets.find((set) => set.id === pendingConfigSetAction.targetSetId) || null
        : null,
    [configSets, pendingConfigSetAction]
  );
  const hasUnsavedChanges = hasUnsavedModelSetChanges(state);

  /**
   * Take persisted state from main. `reset` replaces the draft with it; `rebase`
   * keeps the draft and only refreshes the list — for a change that left the
   * active set's own content alone, where dropping the user's edits would be a
   * silent loss.
   */
  const applyPersistedConfig = useCallback(
    (
      config: AppConfig | null | undefined,
      presets: ProviderPresets,
      mode: 'reset' | 'rebase' = 'reset'
    ) => {
      const bootstrap = buildModelSetsBootstrap(config, presets);
      if (mode === 'rebase') {
        dispatch({
          type: 'REBASE_PERSISTED',
          configSets: bootstrap.configSets,
          activeConfigSetId: bootstrap.activeConfigSetId,
        });
        return;
      }
      dispatch({ type: 'APPLY_PERSISTED', ...bootstrap });
    },
    []
  );

  // ---- thinking capabilities --------------------------------------------

  // Debounced custom model string — avoids high-frequency IPC while the user types.
  // Only kicks in when useCustomModel is true; the picked model triggers immediately.
  //
  // The debounce is for keystrokes in one field. When a different set is loaded,
  // or the form moves to another provider, the field holds another model
  // altogether — not a later keystroke of the old one — so the settled value is
  // tagged with what it was typed for and ignored once that no longer matches.
  // Otherwise the first query after a switch would ask about the previous set's
  // model on the new set's provider.
  const customModelScope = `${state.savedSignature}::${draft.provider}::${draft.endpointId}`;
  const [settledCustomModel, setSettledCustomModel] = useState({
    scope: customModelScope,
    value: draft.customModel,
  });
  const debouncedCustomModel =
    settledCustomModel.scope === customModelScope ? settledCustomModel.value : draft.customModel;
  useEffect(() => {
    if (!draft.useCustomModel) return;
    const timer = setTimeout(
      () => setSettledCustomModel({ scope: customModelScope, value: draft.customModel }),
      250
    );
    return () => clearTimeout(timer);
  }, [draft.customModel, draft.useCustomModel, customModelScope]);

  const capabilityModel = draft.useCustomModel
    ? debouncedCustomModel.trim() || draft.model
    : draft.model;
  const capabilityProvider = draft.provider;
  const { customProtocol: capabilityProtocol, baseUrl: capabilityBaseUrl } = runtimeFor(draft);

  // Load thinking capabilities whenever provider/model/protocol/baseUrl changes.
  // Re-queries main via IPC (pure, no network, instant from registry).
  useEffect(() => {
    if (!isElectron) return;
    if (!capabilityModel) {
      // No model resolved yet (config still loading, or the field is empty) —
      // capabilities are unknown, so leave the stored level alone.
      dispatch({ type: 'CLEAR_THINKING_CAPABILITIES' });
      return;
    }
    let cancelled = false;
    window.electronAPI.config
      .getThinkingLevels({
        provider: capabilityProvider,
        model: capabilityModel,
        customProtocol: capabilityProtocol,
        baseUrl: capabilityBaseUrl || undefined,
      })
      .then((caps: ThinkingCapabilities) => {
        if (!cancelled) dispatch({ type: 'SET_THINKING_CAPABILITIES', payload: caps });
      })
      .catch(() => {
        // Query failed — we learned nothing about the model, so don't downgrade
        // the user's stored level on the strength of a transient IPC error.
        if (!cancelled) dispatch({ type: 'CLEAR_THINKING_CAPABILITIES' });
      });
    return () => {
      cancelled = true;
    };
  }, [capabilityProvider, capabilityModel, capabilityProtocol, capabilityBaseUrl]);

  // Level to render as active. The stored `thinkingLevel` is the user's intent and
  // is kept verbatim; what the current model can actually honour is derived here so
  // the highlighted segment matches what agent-runner will send. Purely presentational
  // — it never feeds the draft signature or the save payload.
  const effectiveThinkingLevel = useMemo<ModelThinkingLevel>(
    () =>
      thinkingCapabilities.supportsThinking
        ? clampToSupportedLevel(thinkingCapabilities.levels, draft.thinkingLevel)
        : 'off',
    [thinkingCapabilities, draft.thinkingLevel]
  );

  // ---- edits to the draft ------------------------------------------------

  const updateModelFields = useCallback((updater: (previous: ModelFields) => ModelFields) => {
    dispatch({ type: 'UPDATE_MODEL_FIELDS', updater });
  }, []);

  const changeProvider = useCallback(
    (provider: ProviderType, endpointId: string, defaults: ModelFields) => {
      dispatch({ type: 'CHANGE_PROVIDER', provider, endpointId, defaults });
    },
    []
  );

  const setModel = useCallback(
    (value: string) => {
      updateModelFields((prev) => ({ ...prev, model: value, useCustomModel: false }));
    },
    [updateModelFields]
  );

  const setCustomModel = useCallback(
    (value: string) => {
      updateModelFields((prev) => ({ ...prev, customModel: value, useCustomModel: true }));
    },
    [updateModelFields]
  );

  const setContextWindow = useCallback(
    (value: string) => {
      updateModelFields((prev) => ({ ...prev, contextWindow: value }));
    },
    [updateModelFields]
  );

  const setMaxTokens = useCallback(
    (value: string) => {
      updateModelFields((prev) => ({ ...prev, maxTokens: value }));
    },
    [updateModelFields]
  );

  const toggleCustomModel = useCallback(() => {
    updateModelFields((prev) => {
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
  }, [updateModelFields]);

  const setThinkingLevel = useCallback((value: ModelThinkingLevel) => {
    dispatch({ type: 'SET_THINKING_LEVEL', payload: value });
  }, []);

  /** Treat the draft as saved without a round trip — for a save done elsewhere. */
  const markSaved = useCallback(() => {
    dispatch({ type: 'MARK_SAVED' });
  }, []);

  const setPendingConfigSetAction = useCallback((action: PendingConfigSetAction | null) => {
    dispatch({ type: 'SET_PENDING_CONFIG_SET_ACTION', payload: action });
  }, []);

  // ---- calls to main -----------------------------------------------------

  const reportFailure = useCallback(
    (failure: unknown) => {
      if (failure instanceof Error) {
        showErrorText(translateApiConfigErrorMessage(failure.message, t));
      } else {
        showErrorKey('api.saveFailed');
      }
    },
    [showErrorKey, showErrorText, t]
  );

  /**
   * Save the active config set. Returns the config main now holds, or null when
   * nothing was saved (the reason is on the error line).
   *
   * `endpointId` overrides the draft's — for an endpoint that was created in the
   * same step and has not reached the draft yet.
   */
  const saveSet = useCallback(
    async (
      presets: ProviderPresets,
      overrides?: { endpointId?: string }
    ): Promise<AppConfig | null> => {
      if (!finalModelOf(draft)) {
        showErrorKey('api.selectModelRequired');
        return null;
      }

      clearError();
      dispatch({ type: 'SET_IS_SAVING', payload: true });
      try {
        const payload = buildModelSetSavePayload(
          overrides?.endpointId !== undefined
            ? { ...draft, endpointId: overrides.endpointId }
            : draft,
          activeConfigSetId
        );
        const result = await window.electronAPI.config.save(payload);
        // `config.save` can reject without throwing (main validates httpProxy),
        // and that branch carries no `config`. Surface the reason rather than
        // reading an absent field and reporting success.
        if (!result.success) {
          showErrorText(translateApiConfigErrorMessage(result.error, t));
          return null;
        }
        applyPersistedConfig(result.config, presets);
        onConfigPersisted?.(result.config);
        return result.config;
      } catch (saveError) {
        reportFailure(saveError);
        return null;
      } finally {
        dispatch({ type: 'SET_IS_SAVING', payload: false });
      }
    },
    [
      activeConfigSetId,
      applyPersistedConfig,
      clearError,
      draft,
      onConfigPersisted,
      reportFailure,
      showErrorKey,
      showErrorText,
      t,
    ]
  );

  /** Run one config-set call, apply what it returns, and report the outcome. */
  const mutateConfigSets = useCallback(
    async (
      presets: ProviderPresets,
      call: () => Promise<{ config: AppConfig }>,
      outcome: { successKey?: string; mode?: 'reset' | 'rebase' }
    ): Promise<AppConfig | null> => {
      if (!isElectron) {
        return null;
      }
      dispatch({ type: 'SET_IS_MUTATING_CONFIG_SET', payload: true });
      clearError();
      try {
        const result = await call();
        applyPersistedConfig(result.config, presets, outcome.mode);
        onConfigPersisted?.(result.config);
        if (outcome.successKey) {
          showSuccessKey(outcome.successKey);
          setTimeout(() => clearSuccessMessage(), 1500);
        }
        return result.config;
      } catch (mutationError) {
        reportFailure(mutationError);
        return null;
      } finally {
        dispatch({ type: 'SET_IS_MUTATING_CONFIG_SET', payload: false });
      }
    },
    [
      applyPersistedConfig,
      clearError,
      clearSuccessMessage,
      onConfigPersisted,
      reportFailure,
      showSuccessKey,
    ]
  );

  const switchConfigSet = useCallback(
    (presets: ProviderPresets, setId: string, switchOptions?: { silentSuccess?: boolean }) =>
      mutateConfigSets(presets, () => window.electronAPI.config.switchSet({ id: setId }), {
        successKey: switchOptions?.silentSuccess ? undefined : 'api.configSetSwitched',
      }),
    [mutateConfigSets]
  );

  const createConfigSet = useCallback(
    async (presets: ProviderPresets, payload: { name: string; mode: CreateMode }) => {
      if (configSets.length >= CONFIG_SET_LIMIT) {
        showErrorKey('api.configSetLimitReached', { count: CONFIG_SET_LIMIT });
        return null;
      }
      const trimmed = payload.name.trim();
      if (!trimmed) {
        showErrorKey('api.configSetNameRequired');
        return null;
      }
      return mutateConfigSets(
        presets,
        () =>
          window.electronAPI.config.createSet({
            name: trimmed,
            mode: payload.mode,
            fromSetId: payload.mode === 'clone' ? activeConfigSetId : undefined,
          }),
        { successKey: 'api.configSetCreated' }
      );
    },
    [activeConfigSetId, configSets.length, mutateConfigSets, showErrorKey]
  );

  const renameConfigSet = useCallback(
    async (presets: ProviderPresets, id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        showErrorKey('api.configSetNameRequired');
        return null;
      }
      // A rename changes no set's content, so the draft is kept: resetting it
      // would throw away edits the user never asked to discard.
      return mutateConfigSets(
        presets,
        () => window.electronAPI.config.renameSet({ id, name: trimmed }),
        { successKey: 'api.configSetRenamed', mode: 'rebase' }
      );
    },
    [mutateConfigSets, showErrorKey]
  );

  const deleteConfigSet = useCallback(
    (presets: ProviderPresets, id: string) =>
      mutateConfigSets(presets, () => window.electronAPI.config.deleteSet({ id }), {
        successKey: 'api.configSetDeleted',
        // Deleting another set leaves the active one, and its draft, alone.
        mode: id === activeConfigSetId ? 'reset' : 'rebase',
      }),
    [activeConfigSetId, mutateConfigSets]
  );

  const canDeleteCurrentConfigSet = Boolean(
    currentConfigSet && !currentConfigSet.isSystem && configSets.length > 1
  );

  return {
    configSets,
    activeConfigSetId,
    currentConfigSet,
    pendingConfigSetAction,
    pendingConfigSet,
    draft,
    thinkingCapabilities,
    effectiveThinkingLevel,
    hasUnsavedChanges,
    isSaving: state.isSaving,
    isMutatingConfigSet: state.isMutatingConfigSet,
    canDeleteCurrentConfigSet,
    configSetLimit: CONFIG_SET_LIMIT,
    applyPersistedConfig,
    changeProvider,
    updateModelFields,
    setModel,
    setCustomModel,
    toggleCustomModel,
    setContextWindow,
    setMaxTokens,
    setThinkingLevel,
    markSaved,
    setPendingConfigSetAction,
    saveSet,
    switchConfigSet,
    createConfigSet,
    renameConfigSet,
    deleteConfigSet,
  };
}
