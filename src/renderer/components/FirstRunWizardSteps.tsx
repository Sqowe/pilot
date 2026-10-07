import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomEndpoint } from '../types';
import type { ProviderCatalogEntry } from '../../shared/provider-catalog';
import { droppedKeySetNames, setsUsingEndpoint } from '../hooks/api-settings-view';
import { providerDialogValues } from '../hooks/credential-dialog-view';
import type { FirstRunWizardState } from '../hooks/useFirstRunWizard';
import { useModelSetForm } from '../hooks/useModelSetForm';
import { useCustomEndpointDialog } from './CustomEndpointDialog';
import { CustomEndpointFields } from './CustomEndpointFields';
import { useProviderConfigDialog } from './ProviderConfigDialog';
import { ProviderCredentialFields } from './ProviderCredentialFields';
import { DialogError, HINT_CLASS } from './settings/CredentialDialogParts';
import { ModelPickerField } from './settings/ModelFieldsSection';
import { useSingleFlight } from './settings/SettingsDialogFrame';

// The three things the first-run wizard can have on screen under its frame.
//
// The first step is not a form of its own: it is the inside of the dialog the
// Providers tab opens for the same credential, state and fields both, so the
// key field, the address, the connection check, the ready-made setups and the
// hints are the ones Settings has. What differs is what a save leads to — the
// next step instead of a closed dialog — and that is all each step adds.

/**
 * One minimum height for both steps, so that a list opened from either step's
 * picker has room below it. The frame's body scrolls, so a list longer than
 * what is under its picker would be cut off there — and under the model field
 * of the second step there is next to nothing. It also keeps the dialog from
 * shrinking to a strip when the second step arrives (measured: 590 px for a
 * provider's key, 565 px for the model, with 41 px to spare under an open list
 * of models).
 */
export const WIZARD_STEP_CLASS = 'min-h-[26rem] space-y-4';

interface WizardProviderStepProps {
  wizard: FirstRunWizardState;
  entry: ProviderCatalogEntry;
}

/** First step, for a catalog provider: its key, and its address where it has one. */
export function WizardProviderStep({ wizard, entry }: WizardProviderStepProps) {
  const { presets, providerCatalog, credentials, sets } = wizard.settings;
  const values = providerDialogValues({
    entry,
    presets,
    catalog: providerCatalog,
    credentials,
    configSets: sets.configSets,
    activeConfigSetId: sets.activeConfigSetId,
  });
  const form = useProviderConfigDialog({
    ...values,
    onSave: (input) => wizard.saveProvider(entry, values, input),
    // What a dialog does after a save that worked is close. Here it goes on.
    onClose: wizard.advance,
  });
  wizard.submitRef.current = form.submit;

  return <ProviderCredentialFields form={form} />;
}

interface WizardEndpointStepProps {
  wizard: FirstRunWizardState;
  /** The endpoint chosen from the list; null to add one. */
  endpoint: CustomEndpoint | null;
}

/** First step, for a custom endpoint: one that exists, or one being added. */
export function WizardEndpointStep({ wizard, endpoint }: WizardEndpointStepProps) {
  const { presets, providerCatalog, credentials, sets } = wizard.settings;
  const { configSets, activeConfigSetId } = sets;
  const form = useCustomEndpointDialog({
    endpoint,
    customEndpoints: credentials.customEndpoints,
    usedBy: endpoint ? setsUsingEndpoint(endpoint.id, configSets).map((set) => set.name) : [],
    droppedKeySets: endpoint
      ? droppedKeySetNames(endpoint.id, credentials.credentialConflicts, configSets)
      : [],
    configSets,
    activeConfigSetId,
    presets,
    providerCatalog,
    // A catalog provider is an entry of the list above these fields, and the
    // hint's button chooses it there. There is no second dialog to open.
    catalogProviderAt: 'list',
    onSave: (values) => wizard.saveEndpoint(endpoint, values),
    onOpenProvider: wizard.chooseProvider,
    onClose: wizard.advance,
  });
  wizard.submitRef.current = form.submit;

  return <CustomEndpointFields form={form} />;
}

interface WizardModelStepProps {
  wizard: FirstRunWizardState;
}

/**
 * Second step: the model the active config set selects, and nothing else of a
 * config set. Its token limits and thinking level stay as they are stored;
 * both are on the Model Sets tab.
 *
 * The field, its list and — for Ollama — the models its server reports are the
 * Model Sets tab's own (`useModelSetForm`), reading the credential the first
 * step has just saved. Start saves the set through that form's Save.
 */
export function WizardModelStep({ wizard }: WizardModelStepProps) {
  const { t } = useTranslation();
  const form = useModelSetForm(wizard.settings);
  const { handleSave } = form;
  const { close } = wizard;
  const startOnce = useSingleFlight();
  wizard.submitRef.current = () => {
    void startOnce(async () => {
      if (await handleSave({ silentSuccess: true })) {
        close();
      }
    });
  };

  // The button that brought the wizard here has gone with the first step, and
  // focus with it. It is put on this step as a whole, not into its field: from
  // there Tab reaches the field, and a second Enter — the one that follows a
  // key typed and confirmed — starts nothing.
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stepRef.current?.focus();
  }, []);

  const chosenName = form.endpoint?.name ?? form.activeCatalogEntry?.name ?? form.provider;

  return (
    <div ref={stepRef} tabIndex={-1} className={`${WIZARD_STEP_CLASS} outline-none`}>
      {/* The field first: its list opens downwards, over what is said below. */}
      <div className="space-y-3">
        <ModelPickerField form={form} />
      </div>
      <DialogError message={form.error} />
      <p className="text-sm text-text-secondary">
        {t('api.provider')}: <span className="font-medium text-text-primary">{chosenName}</span>
      </p>
      <p className={HINT_CLASS}>
        {t('api.firstRun.modelIntro', { set: form.currentConfigSet?.name ?? '' })}
      </p>
    </div>
  );
}
