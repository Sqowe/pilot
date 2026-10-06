import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import type { ProviderCatalogEntry } from '../../shared/provider-catalog';
import type { CredentialCallResult } from '../hooks/useApiSettingsState';
import { SettingsDialogFrame, useDialogSave } from './settings/SettingsDialogFrame';

interface ProviderConfigDialogProps {
  entry: ProviderCatalogEntry;
  /** The key and address exactly as they are stored; an address never given is empty. */
  apiKey: string;
  baseUrl: string;
  /** Whether this provider has an address of its own to edit (Ollama, some native providers). */
  showsBaseUrl: boolean;
  /** The provider's usual address, shown as a hint in an empty address field. */
  baseUrlPlaceholder: string;
  needsKey: boolean;
  keyPlaceholder: string;
  /** i18n key of a provider-specific hint about where to get a key, when there is one. */
  keyHintKey?: string;
  /** Names of the config sets that use this provider. */
  usedBy: string[];
  onSave: (input: { apiKey: string; baseUrl: string }) => Promise<CredentialCallResult>;
  onClose: () => void;
}

const FIELD_CLASS =
  'w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-60 transition-all';
const LABEL_CLASS = 'block text-sm font-medium text-text-primary';
const HINT_CLASS = 'text-xs leading-5 text-text-muted';

/**
 * Enter one catalog provider's key, and its address where it has one.
 *
 * A provider has one key on this machine, shared by every config set that uses
 * it. Save writes that credential and nothing else: it names no config set, so
 * it cannot change which model a chat runs on.
 */
export function ProviderConfigDialog({
  entry,
  apiKey: savedApiKey,
  baseUrl: savedBaseUrl,
  showsBaseUrl,
  baseUrlPlaceholder,
  needsKey,
  keyPlaceholder,
  keyHintKey,
  usedBy,
  onSave,
  onClose,
}: ProviderConfigDialogProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState(savedApiKey);
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const { isSaving, error, setError, save } = useDialogSave(onClose, t('api.saveFailed'));

  const handleSave = () => save(() => onSave({ apiKey, baseUrl }));

  return (
    <SettingsDialogFrame
      title={t('api.providers.configureTitle', { name: entry.name })}
      onClose={onClose}
      busy={isSaving}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleSave();
            }}
            disabled={isSaving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            {isSaving ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      {usedBy.length > 0 && (
        <p className={HINT_CLASS}>{t('api.providers.usedBy', { sets: usedBy.join(', ') })}</p>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="provider-api-key-input" className={LABEL_CLASS}>
            {t('api.apiKey')}
          </label>
          {entry.docsUrl && (
            <a
              href={entry.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              {t('api.providerPicker.docs')}
            </a>
          )}
        </div>
        <input
          id="provider-api-key-input"
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setError('');
          }}
          placeholder={keyPlaceholder || t('api.enterApiKey')}
          autoFocus
          disabled={isSaving}
          className={FIELD_CLASS}
        />
        <p className={HINT_CLASS}>
          {t(needsKey ? 'api.apiKeyDescription' : 'api.providers.keyOptionalHint')}
        </p>
        {entry.kind === 'native' && entry.keyEnvVar && (
          <p className={HINT_CLASS}>
            {t('api.providerPicker.keyEnvHint', { envVar: entry.keyEnvVar })}
          </p>
        )}
        {keyHintKey && <p className={HINT_CLASS}>{t(keyHintKey)}</p>}
      </div>

      {showsBaseUrl && (
        <div className="space-y-1.5">
          <label htmlFor="provider-base-url-input" className={LABEL_CLASS}>
            {t('api.baseUrl')}
          </label>
          <input
            id="provider-base-url-input"
            type="text"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setError('');
            }}
            placeholder={baseUrlPlaceholder}
            disabled={isSaving}
            className={FIELD_CLASS}
          />
          <p className={HINT_CLASS}>{t('api.providers.baseUrlOptionalHint')}</p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-error/10 text-sm text-error"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
    </SettingsDialogFrame>
  );
}
