import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import type { DialogNote } from '../../hooks/credential-dialog-view';
import type { CredentialCheck } from '../../hooks/useCredentialCheck';
import ApiDiagnosticsPanel from '../ApiDiagnosticsPanel';

export const FIELD_CLASS =
  'w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-60 transition-all';
export const LABEL_CLASS = 'block text-sm font-medium text-text-primary';
export const HINT_CLASS = 'text-xs leading-5 text-text-muted';

interface DroppedKeyNoticeProps {
  /** Names of the config sets whose own key was not kept; nothing is drawn when empty. */
  sets: string[];
  /** In a dialog the way to settle it is the Save button below; on a row it is to open the entry. */
  where: 'row' | 'dialog';
}

/**
 * Says that the conversion to one key per provider dropped a key: which config
 * sets had a different one, and how to settle it.
 *
 * The conversion is silent by design, so this is the only place a user learns
 * that a set which used to work may now be running on another key. It goes
 * away once this credential is saved again — keeping the key or replacing it.
 */
export function DroppedKeyNotice({ sets, where }: DroppedKeyNoticeProps) {
  const { t } = useTranslation();
  if (sets.length === 0) {
    return null;
  }
  return (
    <p className="flex items-start gap-2 text-xs leading-5 text-warning">
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span>
        {t(where === 'dialog' ? 'api.providers.droppedKeyInDialog' : 'api.providers.droppedKey', {
          sets: sets.join(', '),
        })}
      </span>
    </p>
  );
}

const NOTE_CLASS: Record<DialogNote['tone'], string> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
};

/** One line about something the dialog just did, in the colour of how it went. */
export function DialogNoteLine({ note }: { note: DialogNote | null }) {
  const { t } = useTranslation();
  if (!note) {
    return null;
  }
  const Icon = note.tone === 'success' ? CheckCircle : AlertTriangle;
  return (
    <p
      role={note.tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 text-xs leading-5 ${NOTE_CLASS[note.tone]}`}
    >
      <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span>{t(note.key, note.values)}</span>
    </p>
  );
}

/** Why the dialog could not do what was asked, next to the fields it is about. */
export function DialogError({ message }: { message: string }) {
  if (!message) {
    return null;
  }
  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-error/10 text-sm text-error"
    >
      <AlertCircle className="w-4 h-4 flex-shrink-0" />
      {message}
    </div>
  );
}

interface DialogFooterButtonsProps {
  isSaving: boolean;
  onCancel: () => void;
}

/**
 * Cancel and Save. Save is the dialog's submit button, so Enter in a field does
 * what a click on it does — and nothing while it is disabled.
 */
export function DialogFooterButtons({ isSaving, onCancel }: DialogFooterButtonsProps) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        onClick={onCancel}
        disabled={isSaving}
        className="px-4 py-2 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50 transition-colors"
      >
        {t('common.cancel')}
      </button>
      <button
        type="submit"
        disabled={isSaving}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
      >
        {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
        {isSaving ? t('common.saving') : t('common.save')}
      </button>
    </>
  );
}

interface CredentialCheckSectionProps {
  check: CredentialCheck;
  /** The model the check tries; '' when it stops short of one. */
  model: string;
  onRun: () => void;
  disabled: boolean;
  /** A plainer reading of a failed model step, when there is one. */
  failureHint?: string;
}

/**
 * The connection check inside a credential dialog: the same five steps as on
 * the Model Sets tab, run against what is typed in the dialog rather than what
 * is saved.
 *
 * It says beforehand what it will try. With a model it ends in one short
 * request, which is the only step that proves a key on every service; without
 * one it can only reach the service and ask for its model list, and it says
 * that this is not proof.
 */
export function CredentialCheckSection({
  check,
  model,
  onRun,
  disabled,
  failureHint,
}: CredentialCheckSectionProps) {
  const { t } = useTranslation();
  const { result, isChecking } = check;
  const passed = Boolean(result?.overallOk && !result.skippedReason) && !isChecking;

  return (
    <div className="space-y-2 pt-3 border-t border-border-muted">
      <p className="text-sm font-medium text-text-primary">{t('api.providers.check.title')}</p>
      <p className={HINT_CLASS}>
        {model ? t('api.providers.check.withModel', { model }) : t('api.providers.check.noModel')}
      </p>
      <ApiDiagnosticsPanel
        result={result}
        isRunning={isChecking}
        onRunDiagnostics={onRun}
        disabled={disabled}
      />
      {failureHint && <p className="text-xs leading-5 text-text-primary">{failureHint}</p>}
      {passed && (
        <p role="status" className={`${HINT_CLASS} text-text-primary`}>
          {t(model ? 'api.providers.check.passedNotSaved' : 'api.providers.check.reachedNotSaved')}
        </p>
      )}
    </div>
  );
}
