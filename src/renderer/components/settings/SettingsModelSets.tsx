import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  ExternalLink,
  Loader2,
  Server,
  TriangleAlert,
} from 'lucide-react';
import { isCustomProtocol, protocolLabel } from '../../hooks/api-config-shared';
import { useModelSetForm } from '../../hooks/useModelSetForm';
import { useAppStore } from '../../store';
import { ApiConfigSetManager } from '../ApiConfigSetManager';
import ApiDiagnosticsPanel from '../ApiDiagnosticsPanel';
import { ProviderChoicePicker } from '../ProviderChoicePicker';
import type { StatusDotColor } from '../SearchableCombobox';
import { useApiSettings } from './ApiSettingsContext';
import { ModelFieldsSection } from './ModelFieldsSection';

// ==================== Model Sets Tab ====================

/**
 * Where a config set is edited: which provider or custom endpoint it runs on
 * and which model it selects.
 *
 * A config set holds no credential. The provider chooser picks among the
 * credentials that exist — entered on the Providers tab — and Save sends the
 * set's own fields only, so a model change can never carry a key along.
 */
export function SettingsModelSets() {
  const { t } = useTranslation();
  const settings = useApiSettings();
  const form = useModelSetForm(settings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  if (settings.isLoadingConfig) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
        <span className="ml-2 text-text-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  const { provider, endpoint, apiKey, requiresApiKey, activeCatalogEntry, isOllamaMode } = form;
  const hasKey = Boolean(apiKey.trim());
  const keyMissing = requiresApiKey && !hasKey;
  const endpointMissing = provider === 'custom' && !endpoint;

  // The chosen entry as the open set would run with it: green with a key,
  // amber when it needs one and has none, nothing for a keyless provider.
  const statusDot: StatusDotColor = hasKey ? 'green' : requiresApiKey ? 'amber' : 'none';
  const statusDotLabel = hasKey
    ? t('api.providerPicker.keySet')
    : requiresApiKey
      ? t('api.providerPicker.keyMissing')
      : undefined;

  return (
    <div className="space-y-5">
      <ApiConfigSetManager
        configSets={form.configSets}
        activeConfigSetId={form.activeConfigSetId}
        currentConfigSet={form.currentConfigSet}
        pendingConfigSetAction={form.pendingConfigSetAction}
        pendingConfigSet={form.pendingConfigSet}
        hasUnsavedChanges={form.hasUnsavedChanges}
        isMutatingConfigSet={form.isMutatingConfigSet}
        isSaving={form.isSaving}
        canDeleteCurrentConfigSet={form.canDeleteCurrentConfigSet}
        onSwitchSet={form.requestConfigSetSwitch}
        onRequestCreateBlankSet={form.requestCreateBlankConfigSet}
        onSaveCurrentSet={form.handleSave}
        onRenameSet={form.renameConfigSet}
        onDeleteSet={form.deleteConfigSet}
        onCancelPendingAction={form.cancelPendingConfigSetAction}
        onSaveAndContinuePendingAction={form.saveAndContinuePendingConfigSetAction}
        onDiscardAndContinuePendingAction={form.discardAndContinuePendingConfigSetAction}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Provider or custom endpoint                                         */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Server className="w-4 h-4" />
            {t('api.provider')}
          </span>
          {activeCatalogEntry?.docsUrl && provider !== 'custom' && (
            <a
              href={activeCatalogEntry.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              {t('api.providerPicker.docs')}
            </a>
          )}
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {t('api.modelSets.providerDescription')}
        </p>

        {settings.isCatalogLoading ? (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-background border border-border text-text-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t('common.loading')}</span>
          </div>
        ) : (
          <ProviderChoicePicker
            choices={form.providerChoices}
            value={form.providerChoice}
            onChange={form.changeProviderChoice}
            statusDot={endpointMissing ? 'amber' : statusDot}
            statusDotLabel={endpointMissing ? t('api.modelSets.noEndpoint') : statusDotLabel}
            disabled={form.isLocked}
          />
        )}

        {endpoint && (
          <p className="truncate text-xs text-text-muted select-text">
            {isCustomProtocol(endpoint.protocol)
              ? protocolLabel(endpoint.protocol, t)
              : endpoint.protocol}
            {' · '}
            {endpoint.baseUrl}
          </p>
        )}
        {(endpointMissing || keyMissing) && (
          <p className="flex items-start gap-2 text-xs leading-5 text-warning">
            <TriangleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            {t(endpointMissing ? 'api.modelSets.endpointMissing' : 'api.modelSets.keyMissing')}
          </p>
        )}

        <button
          type="button"
          onClick={() => setSettingsTab('providers')}
          className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
        >
          {t('api.modelSets.manageProviders')}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      <ModelFieldsSection form={form} />

      {form.error && (
        <div
          role="alert"
          className="flex items-center gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {form.error}
        </div>
      )}
      {form.successMessage && (
        <div
          role="status"
          className="flex items-center gap-2 px-4 py-3 rounded-lg bg-success/10 text-success text-sm"
        >
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {form.successMessage}
        </div>
      )}

      {/* Runs against the credential as it is saved and the model as it is on screen. */}
      <ApiDiagnosticsPanel
        result={form.diagnosticResult}
        isRunning={form.isDiagnosing}
        onRunDiagnostics={form.handleDiagnose}
        onRunDeepDiagnostics={isOllamaMode ? form.handleDeepDiagnose : undefined}
        disabled={endpointMissing || keyMissing}
      />

      <div className="space-y-3 py-5 border-b border-border-muted">
        <button
          type="button"
          onClick={() => {
            void form.handleSave();
          }}
          disabled={form.isSaving}
          className="w-full py-3 px-4 rounded-lg bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98] flex items-center justify-center gap-2"
        >
          {form.isSaving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('common.saving')}
            </>
          ) : (
            <>
              <CheckCircle className="w-4 h-4" />
              {t('api.saveSettings')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
