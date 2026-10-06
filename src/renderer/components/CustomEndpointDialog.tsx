import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { CustomEndpoint, CustomProtocolType } from '../types';
import { protocolLabel } from '../hooks/api-config-shared';
import {
  checkEndpointForm,
  endpointFormValues,
  type EndpointFormValues,
} from '../hooks/api-settings-view';
import type { CredentialCallResult } from '../hooks/useApiSettingsState';
import { SettingsDialogFrame, useDialogSave } from './settings/SettingsDialogFrame';

interface CustomEndpointDialogProps {
  /** The endpoint being edited; null to add a new one. */
  endpoint: CustomEndpoint | null;
  /** Every endpoint, so an address that is already taken is refused before main is asked. */
  customEndpoints: CustomEndpoint[];
  /** Names of the config sets that point at the endpoint being edited. */
  usedBy: string[];
  onSave: (values: EndpointFormValues) => Promise<CredentialCallResult>;
  onClose: () => void;
}

const PROTOCOLS: CustomProtocolType[] = ['anthropic', 'openai', 'gemini'];

/** The address a service of each protocol usually has — shown as a hint, never filled in. */
const ADDRESS_EXAMPLE: Record<CustomProtocolType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
};

const ADDRESS_HINT_KEY: Record<CustomProtocolType, string> = {
  anthropic: 'api.enterAnthropicUrl',
  openai: 'api.enterOpenAIUrl',
  gemini: 'api.enterGeminiUrl',
};

const FIELD_CLASS =
  'w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-60 transition-all';
const LABEL_CLASS = 'block text-sm font-medium text-text-primary';
const HINT_CLASS = 'text-xs leading-5 text-text-muted';

/**
 * Add or edit one custom endpoint: its name, protocol, address, key and
 * optional default model.
 *
 * An endpoint is the one credential a user names, because there can be several
 * and "Custom" alone does not say which. Nothing is written until Save, and
 * Save writes this endpoint only — no config set is named or changed, though
 * every set that points at the endpoint runs on what is saved here.
 */
export function CustomEndpointDialog({
  endpoint,
  customEndpoints,
  usedBy,
  onSave,
  onClose,
}: CustomEndpointDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<EndpointFormValues>(() =>
    endpointFormValues(endpoint, 'anthropic')
  );
  const { isSaving, error, setError, save } = useDialogSave(onClose, t('api.saveFailed'));

  const patch = (change: Partial<EndpointFormValues>) => {
    setValues((current) => ({ ...current, ...change }));
    setError('');
  };

  const handleSave = async () => {
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
    await save(() => onSave(values));
  };

  return (
    <SettingsDialogFrame
      title={t(endpoint ? 'api.providers.editEndpointTitle' : 'api.providers.addEndpointTitle')}
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
        <p className="px-3 py-2 rounded-lg bg-warning/10 text-xs leading-5 text-text-primary">
          {t('api.providers.sharedEndpointNotice', { sets: usedBy.join(', ') })}
        </p>
      )}

      <div className="space-y-1.5">
        <label htmlFor="endpoint-name-input" className={LABEL_CLASS}>
          {t('api.providers.endpointName')}
        </label>
        <input
          id="endpoint-name-input"
          type="text"
          value={values.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder={t('api.providers.endpointNamePlaceholder')}
          autoFocus
          disabled={isSaving}
          className={FIELD_CLASS}
        />
        <p className={HINT_CLASS}>{t('api.providers.endpointNameHint')}</p>
      </div>

      <div className="space-y-1.5">
        <span id="endpoint-protocol-label" className={LABEL_CLASS}>
          {t('api.protocol')}
        </span>
        <div
          role="group"
          aria-labelledby="endpoint-protocol-label"
          className="grid grid-cols-3 gap-2"
        >
          {PROTOCOLS.map((protocol) => (
            <button
              key={protocol}
              type="button"
              onClick={() => patch({ protocol })}
              disabled={isSaving}
              aria-pressed={values.protocol === protocol}
              className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                values.protocol === protocol
                  ? 'border-accent bg-accent/10 text-accent font-medium'
                  : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary'
              }`}
            >
              {protocolLabel(protocol, t)}
            </button>
          ))}
        </div>
        <p className={HINT_CLASS}>{t('api.selectProtocol')}</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="endpoint-base-url-input" className={LABEL_CLASS}>
          {t('api.baseUrl')}
        </label>
        <input
          id="endpoint-base-url-input"
          type="text"
          value={values.baseUrl}
          onChange={(e) => patch({ baseUrl: e.target.value })}
          placeholder={ADDRESS_EXAMPLE[values.protocol]}
          disabled={isSaving}
          className={FIELD_CLASS}
        />
        <p className={HINT_CLASS}>{t(ADDRESS_HINT_KEY[values.protocol])}</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="endpoint-api-key-input" className={LABEL_CLASS}>
          {t('api.apiKey')}
        </label>
        <input
          id="endpoint-api-key-input"
          type="password"
          value={values.apiKey}
          onChange={(e) => patch({ apiKey: e.target.value })}
          placeholder={t('api.enterApiKey')}
          disabled={isSaving}
          className={FIELD_CLASS}
        />
        <p className={HINT_CLASS}>{t('api.providers.endpointKeyHint')}</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="endpoint-default-model-input" className={LABEL_CLASS}>
          {t('api.providers.defaultModel')}
        </label>
        <input
          id="endpoint-default-model-input"
          type="text"
          value={values.defaultModel}
          onChange={(e) => patch({ defaultModel: e.target.value })}
          placeholder={t('api.enterModelId')}
          disabled={isSaving}
          className={FIELD_CLASS}
        />
        <p className={HINT_CLASS}>{t('api.providers.defaultModelHint')}</p>
      </div>

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
