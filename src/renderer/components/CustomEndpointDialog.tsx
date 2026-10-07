import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiConfigSet, CustomEndpoint, ProviderPresets, ProviderType } from '../types';
import type { ProviderCatalogEntry } from '../../shared/provider-catalog';
import {
  checkEndpointForm,
  endpointFormValues,
  endpointNeedsKey,
  type EndpointFormValues,
} from '../hooks/api-settings-view';
import {
  applySetupToEndpointForm,
  catalogEntryOfSetup,
  endpointCheckModel,
  endpointSetupIds,
} from '../hooks/credential-dialog-view';
import type { CredentialCallResult } from '../hooks/useApiSettingsState';
import { useCredentialCheck } from '../hooks/useCredentialCheck';
import { useCustomEndpointGuidance } from '../hooks/useCustomEndpointGuidance';
import { CustomEndpointFields } from './CustomEndpointFields';
import { DialogFooterButtons } from './settings/CredentialDialogParts';
import { SettingsDialogFrame, useDialogSave } from './settings/SettingsDialogFrame';

export interface CustomEndpointDialogProps {
  /** The endpoint being edited; null to add a new one. */
  endpoint: CustomEndpoint | null;
  /** Every endpoint, so an address that is already taken is refused before main is asked. */
  customEndpoints: CustomEndpoint[];
  /** Names of the config sets that point at the endpoint being edited. */
  usedBy: string[];
  /** Names of the config sets whose own key for this endpoint the conversion did not keep. */
  droppedKeySets: string[];
  /** For the model a connection check tries: one a config set already runs here. */
  configSets: ApiConfigSet[];
  activeConfigSetId: string;
  presets: ProviderPresets;
  /** To tell an address that belongs to a catalog provider, and which of the setups to list. */
  providerCatalog: ProviderCatalogEntry[];
  onSave: (values: EndpointFormValues) => Promise<CredentialCallResult>;
  /** Leave this dialog for the given catalog provider's own. */
  onOpenProvider: (provider: ProviderType) => void;
  /**
   * Where a catalog provider is to be found from here, for the wording of the
   * hint that sends an address there: its entry on the Providers tab (the
   * default), or the list these fields sit under in the first-run wizard.
   */
  catalogProviderAt?: 'tab' | 'list';
  onClose: () => void;
}

/**
 * The endpoint dialog as a form: its fields, the hints that follow what is
 * typed, the connection check, and Save.
 *
 * Apart from the dialog's frame, so that the fields can be drawn — and this
 * state read — where there is no page to draw a dialog into.
 */
export function useCustomEndpointDialog(props: CustomEndpointDialogProps) {
  const {
    endpoint,
    customEndpoints,
    usedBy,
    droppedKeySets,
    configSets,
    activeConfigSetId,
    presets,
    providerCatalog,
    onSave,
    onOpenProvider,
    onClose,
  } = props;
  const { t } = useTranslation();
  const [values, setValues] = useState<EndpointFormValues>(() =>
    endpointFormValues(endpoint, 'anthropic')
  );
  const {
    isSaving,
    error: saveError,
    setError,
    save,
  } = useDialogSave(onClose, t('api.saveFailed'));

  const patch = useCallback(
    (change: Partial<EndpointFormValues>) => {
      setValues((current) => ({ ...current, ...change }));
      setError('');
    },
    [setError]
  );
  const setBaseUrl = useCallback((baseUrl: string) => patch({ baseUrl }), [patch]);

  const checkModel = endpointCheckModel({
    defaultModel: values.defaultModel,
    endpointId: endpoint?.id ?? null,
    configSets,
    activeConfigSetId,
  });
  const check = useCredentialCheck({
    provider: 'custom',
    customProtocol: values.protocol,
    apiKey: values.apiKey,
    baseUrl: values.baseUrl,
    model: checkModel,
    // An endpoint has no usual address to fall back on: it is its address.
    presetBaseUrl: '',
    requiresApiKey: endpointNeedsKey({ baseUrl: values.baseUrl }),
    setBaseUrl,
  });

  // The check's last step reports what a model answered. Two of those answers
  // usually mean the wrong protocol, and the guidance says so in plain words.
  const failedModelStep = check.result?.steps.find(
    (step) => step.name === 'model' && step.status === 'fail'
  );
  const guidance = useCustomEndpointGuidance({
    provider: 'custom',
    customProtocol: values.protocol,
    baseUrl: values.baseUrl,
    presets,
    testDetails: failedModelStep?.error,
  });

  // The address is that of a service the catalog lists by name. It has an entry
  // of its own on the tab, and that is where it belongs.
  const catalogEntry = catalogEntryOfSetup(guidance.detectedProviderSetup, providerCatalog);
  const catalogProvider = catalogEntry?.id ?? null;
  const catalogProviderName = catalogEntry?.name ?? '';

  const { commonProviderSetups } = guidance;
  const setups = useMemo(() => {
    const ids = endpointSetupIds(providerCatalog);
    return commonProviderSetups.filter((setup) => ids.has(setup.id));
  }, [commonProviderSetups, providerCatalog]);

  const applySetup = useCallback(
    (setupId: string) => {
      setValues((current) => applySetupToEndpointForm(current, setupId));
      setError('');
    },
    [setError]
  );

  const submit = () => {
    const problem = checkEndpointForm(values, customEndpoints, endpoint?.id ?? null);
    if (problem) {
      setError(
        t(
          problem === 'duplicate'
            ? 'api.providers.errors.duplicate'
            : 'api.providers.errors.baseUrlRequired'
        )
      );
      return;
    }
    void save(() => onSave(values));
  };

  const runCheck = () => {
    // An endpoint is its address: without one there is nothing to reach.
    if (!values.baseUrl.trim()) {
      setError(t('api.providers.errors.baseUrlRequired'));
      return;
    }
    setError('');
    void check.runCheck();
  };

  return {
    isNew: endpoint === null,
    values,
    patch,
    isSaving,
    error: saveError || check.error,
    usedBy,
    droppedKeySets,
    // With a catalog provider recognised, the hints about which protocol and
    // address suit the service give way to the one that matters.
    protocolHint: catalogProvider ? '' : guidance.protocolGuidanceText,
    protocolHintTone: guidance.protocolGuidanceTone,
    addressHint: catalogProvider ? '' : guidance.baseUrlGuidanceText,
    catalogProviderName,
    catalogProviderAt: props.catalogProviderAt ?? 'tab',
    openCatalogProvider: () => {
      if (catalogProvider) {
        onOpenProvider(catalogProvider);
      }
    },
    setups,
    applySetup,
    check,
    checkModel,
    runCheck,
    checkFailureHint: catalogProvider ? '' : guidance.friendlyTestDetails,
    submit,
  };
}

export type CustomEndpointDialogForm = ReturnType<typeof useCustomEndpointDialog>;

/**
 * Add or edit one custom endpoint: its name, protocol, address, key and
 * optional default model.
 *
 * An endpoint is the one credential a user names, because there can be several
 * and "Custom" alone does not say which. Nothing is written until Save, and
 * Save writes this endpoint only — no config set is named or changed, though
 * every set that points at the endpoint runs on what is saved here.
 */
export function CustomEndpointDialog(props: CustomEndpointDialogProps) {
  const { t } = useTranslation();
  const form = useCustomEndpointDialog(props);

  return (
    <SettingsDialogFrame
      title={t(
        props.endpoint ? 'api.providers.editEndpointTitle' : 'api.providers.addEndpointTitle'
      )}
      onClose={props.onClose}
      onSubmit={form.submit}
      busy={form.isSaving}
      footer={<DialogFooterButtons isSaving={form.isSaving} onCancel={props.onClose} />}
    >
      <CustomEndpointFields form={form} />
    </SettingsDialogFrame>
  );
}
