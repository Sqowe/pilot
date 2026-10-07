import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomEndpoint, ProviderType } from '../types';
import type { ProviderCatalogEntry } from '../../shared/provider-catalog';
import {
  buildCreateEndpointPayload,
  buildProviderCredentialPayload,
  buildUpdateEndpointPayload,
  createdEndpointId,
  endpointNeedsKey,
  providerChoiceId,
  type EndpointFormValues,
} from './api-settings-view';
import {
  buildWizardChoices,
  initialWizardChoice,
  keyIsMissing,
  pointsAt,
  resolveWizardTarget,
  startModelFields,
  targetPointer,
  type SavedWizardTarget,
  type WizardStep,
} from './first-run-wizard-view';
import type { ApiSettingsState, CredentialCallResult } from './useApiSettingsState';

/** What the wizard's submit does while no step is on screen to answer it. */
const NO_SUBMIT = () => {};

/**
 * The first-run wizard: a credential first, then the model (design §6.5).
 *
 * It is the two halves the Settings tabs edit, taken one after the other, and
 * it saves each through the call the tabs use:
 *
 * - **Continue** saves the credential — a catalog provider's key, or a custom
 *   endpoint — and nothing else. The active config set is moved to it in this
 *   wizard's unsaved state only.
 * - **Start** saves the config set: provider, endpoint and model in one call
 *   that names no credential.
 *
 * So a wizard closed between the two leaves a saved key and an untouched config
 * set, never a config set that points at something half entered.
 *
 * `settings` is the state the two tabs share, in a copy of the wizard's own:
 * it is opened from outside Settings.
 */
export function useFirstRunWizard(settings: ApiSettingsState, onClose: () => void) {
  const { t } = useTranslation();
  const { presets, providerCatalog, credentials, sets, messages } = settings;
  const { saveProviderCredential, createEndpoint, updateEndpoint } = settings;
  const { draft, configSets, changeProvider } = sets;
  const { clearError } = messages;

  const [step, setStep] = useState<WizardStep>('credential');
  // What the user chose in the list; null until they have. Until then the first
  // step shows what the active config set points at — which is only known once
  // the config has loaded, so it is read while rendering, not kept as state.
  const [chosen, setChosen] = useState<string | null>(null);
  const [isSavingCredential, setIsSavingCredential] = useState(false);

  // The step on screen owns its fields, so it is the one that knows what a
  // submit means. It puts that here while it renders. Reset on every pass: with
  // no step on screen, a submit must not reach one that has just left it.
  const submitRef = useRef<() => void>(NO_SUBMIT);
  submitRef.current = NO_SUBMIT;
  const submit = useCallback(() => submitRef.current(), []);

  const choices = useMemo(
    () => buildWizardChoices({ catalog: providerCatalog, credentials, configSets }),
    [providerCatalog, credentials, configSets]
  );
  const choiceId = chosen ?? initialWizardChoice(draft, credentials.customEndpoints);
  const target = resolveWizardTarget(choiceId, providerCatalog, credentials.customEndpoints);

  /**
   * Move the active config set — its unsaved state, nothing stored — to what
   * the first step has just saved. A set already there keeps its model.
   */
  const pointSetAt = useCallback(
    (saved: SavedWizardTarget) => {
      const pointer = targetPointer(saved);
      if (!pointsAt(draft, saved)) {
        changeProvider(pointer.provider, pointer.endpointId, startModelFields(saved, presets));
      }
      setChosen(providerChoiceId(pointer.provider, pointer.endpointId));
    },
    [changeProvider, draft, presets]
  );

  /** Continue, for a catalog provider: save its key, and its address where it has one. */
  const saveProvider = useCallback(
    async (
      entry: ProviderCatalogEntry,
      shape: { showsBaseUrl: boolean; needsKey: boolean },
      input: { apiKey: string; baseUrl: string }
    ): Promise<CredentialCallResult> => {
      if (keyIsMissing(shape.needsKey, input.apiKey)) {
        return { ok: false, error: t('api.testError.missing_key') };
      }
      setIsSavingCredential(true);
      try {
        const result = await saveProviderCredential(
          buildProviderCredentialPayload({
            provider: entry.id,
            ...input,
            showsBaseUrl: shape.showsBaseUrl,
          })
        );
        if (result.ok) {
          pointSetAt({ kind: 'provider', entry });
        }
        return result;
      } finally {
        setIsSavingCredential(false);
      }
    },
    [pointSetAt, saveProviderCredential, t]
  );

  /** Continue, for a custom endpoint: create it, or save the one being edited. */
  const saveEndpoint = useCallback(
    async (
      endpoint: CustomEndpoint | null,
      values: EndpointFormValues
    ): Promise<CredentialCallResult> => {
      if (keyIsMissing(endpointNeedsKey(values), values.apiKey)) {
        return { ok: false, error: t('api.testError.missing_key') };
      }
      setIsSavingCredential(true);
      try {
        const result = endpoint
          ? await updateEndpoint(buildUpdateEndpointPayload(endpoint.id, values))
          : await createEndpoint(buildCreateEndpointPayload(values));
        if (!result.ok) {
          return result;
        }
        const savedId =
          endpoint?.id ??
          createdEndpointId(credentials.customEndpoints, result.config.customEndpoints);
        const saved = result.config.customEndpoints.find((candidate) => candidate.id === savedId);
        if (!saved) {
          // Saved, but which endpoint it became cannot be told. Going on would
          // end in a config set that points at nothing.
          return { ok: false, error: t('api.saveFailed') };
        }
        pointSetAt({ kind: 'endpoint', endpoint: saved });
        return result;
      } finally {
        setIsSavingCredential(false);
      }
    },
    [createEndpoint, credentials.customEndpoints, pointSetAt, t, updateEndpoint]
  );

  const choose = useCallback((choice: string) => setChosen(choice), []);
  /** Leave an endpoint being typed for the catalog provider its address belongs to. */
  const chooseProvider = useCallback(
    (provider: ProviderType) => setChosen(providerChoiceId(provider, '')),
    []
  );
  const advance = useCallback(() => setStep('model'), []);
  const goBack = useCallback(() => {
    // What the second step said about a model has nothing to say about a key.
    clearError();
    setStep('credential');
  }, [clearError]);

  return {
    settings,
    isLoading: settings.isLoadingConfig || settings.isCatalogLoading,
    step,
    choices,
    choiceId,
    target,
    /** A save is on its way: nothing can be changed, closed or sent a second time. */
    busy: isSavingCredential || sets.isSaving || sets.isMutatingConfigSet,
    submitRef,
    submit,
    choose,
    chooseProvider,
    saveProvider,
    saveEndpoint,
    advance,
    goBack,
    close: onClose,
  };
}

export type FirstRunWizardState = ReturnType<typeof useFirstRunWizard>;
