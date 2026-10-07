import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { useApiSettingsState } from '../hooks/useApiSettingsState';
import { useFirstRunWizard, type FirstRunWizardState } from '../hooks/useFirstRunWizard';
import {
  WIZARD_STEP_CLASS,
  WizardEndpointStep,
  WizardModelStep,
  WizardProviderStep,
} from './FirstRunWizardSteps';
import { ProviderChoicePicker } from './ProviderChoicePicker';
import { HINT_CLASS, LABEL_CLASS } from './settings/CredentialDialogParts';
import { SettingsDialogFrame } from './settings/SettingsDialogFrame';

interface FirstRunWizardBodyProps {
  wizard: FirstRunWizardState;
}

/**
 * Everything inside the wizard's frame: the list to choose from and the
 * credential of what is chosen, then the model.
 *
 * Apart from the frame, which is drawn into the page body — so that this can
 * be drawn where there is no page.
 */
export function FirstRunWizardBody({ wizard }: FirstRunWizardBodyProps) {
  const { t } = useTranslation();
  const { target, choiceId } = wizard;

  if (wizard.isLoading) {
    return (
      <div role="status" className="flex min-h-[26rem] items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
        <span className="ml-2 text-text-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  if (wizard.step === 'model') {
    return <WizardModelStep wizard={wizard} />;
  }

  return (
    <div className={WIZARD_STEP_CLASS}>
      <p className={HINT_CLASS}>{t('api.firstRunSubtitle')}</p>
      <div className="space-y-1.5">
        <span className={LABEL_CLASS}>{t('api.provider')}</span>
        <ProviderChoicePicker
          choices={wizard.choices}
          value={choiceId}
          onChange={wizard.choose}
          disabled={wizard.busy}
        />
      </div>

      {/* Keyed by the choice: each entry has a credential of its own, and what
          was typed for one must not show up under another. */}
      {target?.kind === 'provider' && (
        <WizardProviderStep key={choiceId} wizard={wizard} entry={target.entry} />
      )}
      {target?.kind === 'endpoint' && (
        <WizardEndpointStep key={choiceId} wizard={wizard} endpoint={target.endpoint} />
      )}
      {target?.kind === 'new-endpoint' && (
        <WizardEndpointStep key={choiceId} wizard={wizard} endpoint={null} />
      )}
    </div>
  );
}

/**
 * Whether a click is the second of a double click.
 *
 * The two steps put their buttons in the same two places. A double click on
 * Continue would otherwise land its second half on Start, and save a model the
 * user has not been shown; one on Back would land on Cancel.
 */
export function isRepeatedClick(event: Pick<MouseEvent, 'detail'>): boolean {
  return event.detail > 1;
}

const SECONDARY_BUTTON_CLASS =
  'flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50 transition-colors';

interface FirstRunWizardFooterProps {
  wizard: FirstRunWizardState;
}

/**
 * The two buttons of the step on screen. The right-hand one is the frame's
 * submit button in both steps, so Enter in a field does what a click on it
 * does.
 *
 * While its own save is on its way that button is busy, not `disabled`: a
 * disabled button cannot hold focus, and when the save is refused this is the
 * button the user is still on. It is `disabled` only when there is nothing to
 * send at all.
 */
export function FirstRunWizardFooter({ wizard }: FirstRunWizardFooterProps) {
  const { t } = useTranslation();
  const { step, busy } = wizard;
  const nothingToSend = wizard.isLoading || (step === 'credential' && !wizard.target);

  const ignoreRepeatedClick = (event: MouseEvent) => {
    if (isRepeatedClick(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div className="contents" onClickCapture={ignoreRepeatedClick}>
      {step === 'credential' ? (
        <button
          key="cancel"
          type="button"
          onClick={wizard.close}
          disabled={busy}
          className={SECONDARY_BUTTON_CLASS}
        >
          {t('common.cancel')}
        </button>
      ) : (
        <button
          key="back"
          type="button"
          onClick={wizard.goBack}
          disabled={busy}
          className={SECONDARY_BUTTON_CLASS}
        >
          <ArrowLeft className="w-4 h-4" />
          {t('api.firstRun.back')}
        </button>
      )}
      <button
        // A button of its own for each step, so the one that was pressed is
        // never the one that sends the next step.
        key={step}
        type="submit"
        disabled={nothingToSend}
        aria-disabled={busy || undefined}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors ${
          busy ? 'opacity-50 cursor-not-allowed' : ''
        }`}
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {busy
          ? t('common.saving')
          : t(step === 'credential' ? 'api.firstRun.continue' : 'api.getStarted')}
        {!busy && step === 'credential' && <ArrowRight className="w-4 h-4" />}
      </button>
    </div>
  );
}

export interface FirstRunWizardProps {
  onClose: () => void;
}

/**
 * The first-run wizard: set up one provider, then choose a model (design §6.5).
 *
 * Opened when nothing is set up to start a chat with. It teaches the model the
 * Settings tabs then keep: a key belongs to a provider, a model to a config
 * set. Its fields are the tabs' own, and so are the calls that save them —
 * see `useFirstRunWizard`.
 */
export function FirstRunWizard({ onClose }: FirstRunWizardProps) {
  const { t } = useTranslation();
  // Asked from main afresh each time the wizard opens, as the Settings tabs do.
  const settings = useApiSettingsState();
  const wizard = useFirstRunWizard(settings, onClose);

  return (
    <SettingsDialogFrame
      title={t(
        wizard.step === 'credential' ? 'api.firstRun.stepProvider' : 'api.firstRun.stepModel'
      )}
      onClose={onClose}
      onSubmit={wizard.submit}
      busy={wizard.busy}
      footer={<FirstRunWizardFooter wizard={wizard} />}
    >
      <FirstRunWizardBody wizard={wizard} />
    </SettingsDialogFrame>
  );
}
