import { useTranslation } from 'react-i18next';
import { ExternalLink, Plug } from 'lucide-react';
import type { ProviderConfigDialogForm } from './ProviderConfigDialog';
import {
  CredentialCheckSection,
  DialogError,
  DialogNoteLine,
  DroppedKeyNotice,
  FIELD_CLASS,
  HINT_CLASS,
  LABEL_CLASS,
} from './settings/CredentialDialogParts';

interface ProviderCredentialFieldsProps {
  form: ProviderConfigDialogForm;
}

/**
 * Everything inside the provider dialog: the key, the address where the
 * provider has one — with the search for a local server on Ollama's — and the
 * connection check.
 */
export function ProviderCredentialFields({ form }: ProviderCredentialFieldsProps) {
  const { t } = useTranslation();
  const { entry, isSaving, isSearchingOllama } = form;
  // A search writes what it finds into the address field, and a result is
  // dropped as soon as the address it ran against changes. So a search is not
  // offered while a check is out, as a check is not while a search is: started
  // then, it would cancel the check the user is waiting for without a word.
  const isChecking = form.check.isChecking;

  return (
    <>
      {form.usedBy.length > 0 && (
        <p className={HINT_CLASS}>{t('api.providers.usedBy', { sets: form.usedBy.join(', ') })}</p>
      )}
      <DroppedKeyNotice sets={form.droppedKeySets} where="dialog" />

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
          value={form.apiKey}
          onChange={(e) => form.setApiKey(e.target.value)}
          placeholder={form.keyPlaceholder || t('api.enterApiKey')}
          autoFocus
          disabled={isSaving}
          className={FIELD_CLASS}
        />
        <p className={HINT_CLASS}>
          {t(form.needsKey ? 'api.apiKeyDescription' : 'api.providers.keyOptionalHint')}
        </p>
        {entry.kind === 'native' && entry.keyEnvVar && (
          <p className={HINT_CLASS}>
            {t('api.providerPicker.keyEnvHint', { envVar: entry.keyEnvVar })}
          </p>
        )}
        {form.keyHintKey && <p className={HINT_CLASS}>{t(form.keyHintKey)}</p>}
      </div>

      {form.showsBaseUrl && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="provider-base-url-input" className={LABEL_CLASS}>
              {t('api.baseUrl')}
            </label>
            {form.canSearchOllama && (
              <button
                type="button"
                onClick={() => {
                  if (!isSearchingOllama) void form.searchOllama();
                }}
                disabled={isSaving || isChecking}
                // Busy, not `disabled`, while its own search is out: a disabled
                // button cannot hold focus, and this is the one just pressed.
                aria-disabled={isSearchingOllama || undefined}
                className={`flex items-center gap-1 px-2 py-1 rounded-md bg-accent-muted text-xs text-accent hover:bg-accent-muted/80 disabled:opacity-50 transition-colors ${
                  isSearchingOllama ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <Plug className="w-3 h-3" />
                {isSearchingOllama ? t('api.discoveringLocalOllama') : t('api.discoverLocalOllama')}
              </button>
            )}
          </div>
          <input
            id="provider-base-url-input"
            type="text"
            value={form.baseUrl}
            onChange={(e) => form.setBaseUrl(e.target.value)}
            placeholder={form.baseUrlPlaceholder}
            // Held still while a search is out: what it finds is written here.
            disabled={isSaving || isSearchingOllama}
            className={FIELD_CLASS}
          />
          <p className={HINT_CLASS}>{t('api.providers.baseUrlOptionalHint')}</p>
          {form.canSearchOllama && (
            <p className={HINT_CLASS}>{t('api.providers.ollamaSearchHint')}</p>
          )}
          <DialogNoteLine note={form.searchNote} />
        </div>
      )}

      <CredentialCheckSection
        check={form.check}
        model={form.checkModel}
        onRun={form.runCheck}
        disabled={isSaving || isSearchingOllama}
      />

      <DialogError message={form.error} />
    </>
  );
}
