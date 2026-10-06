import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { CustomProtocolType } from '../types';
import { protocolLabel } from '../hooks/api-config-shared';
import type { CustomEndpointDialogForm } from './CustomEndpointDialog';
import { CommonProviderSetupsCard, GuidanceInlineHint } from './ProviderGuidance';
import {
  CredentialCheckSection,
  DialogError,
  DroppedKeyNotice,
  FIELD_CLASS,
  HINT_CLASS,
  LABEL_CLASS,
} from './settings/CredentialDialogParts';

interface CustomEndpointFieldsProps {
  form: CustomEndpointDialogForm;
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

/**
 * Everything inside the endpoint dialog: the ready-made setups a new endpoint
 * can be filled from, the five fields with the hints that follow what is typed
 * into them, and the connection check.
 */
export function CustomEndpointFields({ form }: CustomEndpointFieldsProps) {
  const { t } = useTranslation();
  const { values, patch, isSaving } = form;

  return (
    <>
      {form.usedBy.length > 0 && (
        <p className="px-3 py-2 rounded-lg bg-warning/10 text-xs leading-5 text-text-primary">
          {t('api.providers.sharedEndpointNotice', { sets: form.usedBy.join(', ') })}
        </p>
      )}
      <DroppedKeyNotice sets={form.droppedKeySets} where="dialog" />

      {/* A way to fill in a new endpoint, not to re-point one that sets already run on. */}
      {form.isNew && (
        <CommonProviderSetupsCard
          setups={form.setups}
          onApplySetup={form.applySetup}
          layout="list"
          disabled={isSaving}
        />
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
        <GuidanceInlineHint text={form.protocolHint} tone={form.protocolHintTone} />
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
        <GuidanceInlineHint text={form.addressHint} />
        {form.catalogProviderName && (
          <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <div className="space-y-1.5">
              <p className="leading-5">
                {t('api.providers.catalogProviderHint', { provider: form.catalogProviderName })}
              </p>
              <button
                type="button"
                onClick={form.openCatalogProvider}
                disabled={isSaving}
                className="rounded-lg border border-warning/40 px-2.5 py-1 font-medium text-text-primary hover:bg-warning/10 disabled:opacity-50 transition-colors"
              >
                {t('api.providers.openCatalogProvider', { provider: form.catalogProviderName })}
              </button>
            </div>
          </div>
        )}
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

      <CredentialCheckSection
        check={form.check}
        model={form.checkModel}
        onRun={form.runCheck}
        disabled={isSaving}
        failureHint={form.checkFailureHint}
      />

      <DialogError message={form.error} />
    </>
  );
}
