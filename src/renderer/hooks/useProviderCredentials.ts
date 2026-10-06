import { useCallback, useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig, CustomProtocolType, ProviderPresets } from '../types';
import { customEndpointKey } from '../../shared/custom-endpoint-key';
import { isCustomProtocol, translateApiConfigErrorMessage } from './api-config-shared';
import {
  createProviderCredentialsState,
  credentialTargetKey,
  dirtyCredentialTargets,
  hydrateCredentialDraft,
  planCredentialSave,
  providerCredentialsReducer,
  selectCredentialDraft,
  withEndpointProtocol,
  type CredentialDraft,
  type CredentialTarget,
} from './provider-credentials-state';
import type { ApiConfigMessages } from './useApiConfigMessages';

interface UseProviderCredentialsOptions {
  initialConfig?: AppConfig | null;
  presets: ProviderPresets;
  messages: ApiConfigMessages;
  /**
   * Main returned a new config. Called after every credential that was saved,
   * so whoever shares the screen can refresh what it holds.
   */
  onConfigPersisted?: (config: AppConfig) => void;
}

export interface CredentialSaveResult {
  /** False when a call failed; the reason is on the error line. */
  ok: boolean;
  /** The config main holds after the last call that succeeded, if any did. */
  config: AppConfig | null;
  /**
   * Endpoints whose identity changed in the save, keyed by the target that was
   * edited (`credentialTargetKey`): a not-yet-created one that now exists, or
   * one whose new address belongs to another endpoint. A config set pointing at
   * the edited target has to be pointed at this id instead.
   */
  resolvedEndpointIds: Record<string, string>;
}

/**
 * The **provider credentials** half of API settings: each catalog provider's
 * key and base URL, the custom endpoints, and the unsaved edits to them.
 *
 * Saves each edited credential through its own call —
 * `config.setProviderCredential` for a catalog provider, the endpoint CRUD
 * calls for a custom endpoint — none of which names or changes a config set.
 * See `provider-credentials-state.ts`.
 */
export function useProviderCredentials(options: UseProviderCredentialsOptions) {
  const { t } = useTranslation();
  const { initialConfig, presets, messages, onConfigPersisted } = options;
  const { showErrorKey, showErrorText } = messages;

  const [state, dispatch] = useReducer(providerCredentialsReducer, undefined, () =>
    createProviderCredentialsState(initialConfig)
  );

  /**
   * Take persisted state from main. `reset` drops every unsaved edit; `rebase`
   * keeps them, for a change made by the other half of the screen.
   */
  const applyPersistedConfig = useCallback(
    (
      config: AppConfig | null | undefined,
      mode: 'reset' | 'rebase',
      lastCustomProtocol?: CustomProtocolType
    ) => {
      dispatch({
        type: 'APPLY_PERSISTED',
        providerCredentials: config?.providerCredentials ?? {},
        customEndpoints: config?.customEndpoints ?? [],
        mode,
        ...(isCustomProtocol(lastCustomProtocol) ? { lastCustomProtocol } : {}),
      });
    },
    []
  );

  /** A credential's current value: its unsaved edit, or what is persisted. */
  const selectDraft = useCallback(
    (target: CredentialTarget): CredentialDraft => selectCredentialDraft(state, target, presets),
    [state, presets]
  );

  const patchDraft = useCallback(
    (target: CredentialTarget, patch: Partial<CredentialDraft>) => {
      dispatch({
        type: 'PATCH_DRAFT',
        targetKey: credentialTargetKey(target),
        baseline: hydrateCredentialDraft(state, target, presets),
        patch,
      });
    },
    [state, presets]
  );

  /** Change the protocol of an endpoint, existing or not yet created. */
  const setEndpointProtocol = useCallback(
    (target: CredentialTarget, protocol: CustomProtocolType) => {
      dispatch({ type: 'SET_LAST_CUSTOM_PROTOCOL', payload: protocol });
      if (target.kind === 'slot') return;
      const current = selectCredentialDraft(state, target, presets);
      dispatch({
        type: 'PATCH_DRAFT',
        targetKey: credentialTargetKey(target),
        baseline: hydrateCredentialDraft(state, target, presets),
        patch: withEndpointProtocol(current, protocol, presets),
      });
    },
    [state, presets]
  );

  const dirtyTargets = dirtyCredentialTargets(state, presets);

  /**
   * Save every edited credential, one call each. Stops at the first failure;
   * what was saved before it stays saved, and what was not stays an unsaved
   * edit.
   */
  const saveCredentials = useCallback(
    async (saveOptions?: { newEndpointDefaultModel?: string }): Promise<CredentialSaveResult> => {
      const steps = planCredentialSave(state, presets, saveOptions);
      const resolvedEndpointIds: Record<string, string> = {};
      if (steps.length === 0) {
        return { ok: true, config: null, resolvedEndpointIds };
      }

      let latest: AppConfig | null = null;
      dispatch({ type: 'SET_IS_SAVING', payload: true });
      try {
        for (const step of steps) {
          let config: AppConfig | null = null;
          if (step.kind === 'provider') {
            config = (await window.electronAPI.config.setProviderCredential(step.payload)).config;
          } else if (step.kind === 'update-endpoint') {
            config = (await window.electronAPI.config.updateCustomEndpoint(step.payload)).config;
          } else if (step.kind === 'create-endpoint') {
            config = (await window.electronAPI.config.createCustomEndpoint(step.payload)).config;
            const createdKey = customEndpointKey(step.payload.protocol, step.payload.baseUrl);
            const created = config.customEndpoints.find(
              (endpoint) => customEndpointKey(endpoint.protocol, endpoint.baseUrl) === createdKey
            );
            if (!created) {
              // Main created the endpoint, but it cannot be found in what came
              // back. Carrying on would save the config set pointing at nothing,
              // so stop here and say so. The edit is kept: on the next attempt
              // the address matches the endpoint that now exists and is reused.
              applyPersistedConfig(config, 'rebase');
              onConfigPersisted?.(config);
              showErrorKey('api.saveFailed');
              return { ok: false, config, resolvedEndpointIds };
            }
            resolvedEndpointIds[step.targetKey] = created.id;
          } else {
            resolvedEndpointIds[step.targetKey] = step.endpointId;
            if (step.payload) {
              config = (await window.electronAPI.config.updateCustomEndpoint(step.payload)).config;
            }
          }

          dispatch({ type: 'DISCARD_DRAFT', targetKey: step.targetKey });
          if (config) {
            latest = config;
            // Rebase, not reset: the other edits are still waiting their turn.
            applyPersistedConfig(config, 'rebase');
            onConfigPersisted?.(config);
          }
        }
        return { ok: true, config: latest, resolvedEndpointIds };
      } catch (saveError) {
        if (saveError instanceof Error) {
          showErrorText(translateApiConfigErrorMessage(saveError.message, t));
        } else {
          showErrorKey('api.saveFailed');
        }
        return { ok: false, config: latest, resolvedEndpointIds };
      } finally {
        dispatch({ type: 'SET_IS_SAVING', payload: false });
      }
    },
    [applyPersistedConfig, onConfigPersisted, presets, showErrorKey, showErrorText, state, t]
  );

  return {
    providerCredentials: state.providerCredentials,
    customEndpoints: state.customEndpoints,
    lastCustomProtocol: state.lastCustomProtocol,
    isSaving: state.isSaving,
    dirtyTargets,
    hasUnsavedChanges: dirtyTargets.length > 0,
    applyPersistedConfig,
    selectDraft,
    patchDraft,
    setEndpointProtocol,
    saveCredentials,
  };
}
