import { useTranslation } from 'react-i18next';
import {
  Key,
  Plug,
  Server,
  Cpu,
  Loader2,
  Edit3,
  AlertCircle,
  CheckCircle,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { useApiConfigState } from '../../hooks/useApiConfigState';
import { ApiConfigSetManager } from '../ApiConfigSetManager';
import { CommonProviderSetupsCard, GuidanceInlineHint } from '../ProviderGuidance';
import ApiDiagnosticsPanel from '../ApiDiagnosticsPanel';
import { ProviderPicker } from '../ProviderPicker';
import { SearchableCombobox, type StatusDotColor } from '../SearchableCombobox';
import type { ComboboxItem } from '../SearchableCombobox';

interface ModelOptionItem {
  id: string;
  name: string;
}

// ==================== API Settings Tab ====================

export function SettingsAPI() {
  const { t } = useTranslation();
  const {
    provider,
    customProtocol,
    apiKey,
    baseUrl,
    model,
    customModel,
    useCustomModel,
    contextWindow,
    maxTokens,
    modelInputPlaceholder,
    modelInputHint,
    currentPreset,
    modelOptions,
    isSaving,
    isLoadingConfig,
    isCatalogLoading,
    error,
    successMessage,
    isRefreshingModels,
    isDiscoveringLocalOllama,
    enableThinking,
    isOllamaMode,
    requiresApiKey,
    protocolGuidanceText,
    protocolGuidanceTone,
    baseUrlGuidanceText,
    commonProviderSetups,
    configSets,
    activeConfigSetId,
    currentConfigSet,
    pendingConfigSetAction,
    pendingConfigSet,
    hasUnsavedChanges,
    isMutatingConfigSet,
    canDeleteCurrentConfigSet,
    providerCatalog,
    activeCatalogEntry,
    activeFormShape,
    setApiKey,
    setBaseUrl,
    setModel,
    setCustomModel,
    setContextWindow,
    setMaxTokens,
    toggleCustomModel,
    setEnableThinking,
    applyCommonProviderSetup,
    changeProvider,
    changeProtocol,
    requestConfigSetSwitch,
    requestCreateBlankConfigSet,
    cancelPendingConfigSetAction,
    saveAndContinuePendingConfigSetAction,
    discardAndContinuePendingConfigSetAction,
    renameConfigSet,
    deleteConfigSet,
    handleSave,
    refreshModelOptions,
    discoverLocalOllama,
    diagnosticResult,
    isDiagnosing,
    handleDiagnose,
    handleDeepDiagnose,
    shouldShowOllamaManualModelToggle,
  } = useApiConfigState();

  if (isLoadingConfig) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
        <span className="ml-2 text-text-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Derived display flags
  // ---------------------------------------------------------------------------

  // formShape flags — native providers use activeFormShape; builtins/custom fall
  // back to the legacy provider-literal checks that have always been here.
  const isNative = activeCatalogEntry?.kind === 'native';

  // Protocol selector is only for the 'custom' escape-hatch provider.
  // Native providers have a fixed routeProtocol derived from the registry;
  // exposing this selector for them would be misleading.
  const showProtocol = provider === 'custom';

  const showBaseUrl =
    activeFormShape != null
      ? activeFormShape.baseUrl
      : provider === 'custom' || provider === 'ollama';

  const showContextWindow =
    activeFormShape != null
      ? activeFormShape.contextWindow
      : provider === 'custom' || provider === 'ollama';

  // Source from the catalog entry's formShape (available for ALL providers, not
  // just native) so cloud builtins (OpenRouter/Anthropic/OpenAI/Gemini) render
  // the same searchable combobox as native providers instead of a raw OS
  // <select>. Ollama/Custom keep modelDropdown: false → native select path.
  const showModelDropdown = activeCatalogEntry?.formShape.modelDropdown ?? false;

  const showManualModelToggle =
    activeFormShape != null ? activeFormShape.manualModelToggle : shouldShowOllamaManualModelToggle;

  const showCustomSetups = provider === 'custom';

  // Provider key-status dot on the picker trigger: green when a key is set,
  // amber when the provider needs one and it's missing, none when keyless
  // (e.g. Ollama). Labelled for accessibility (§13.5).
  const providerStatusDot: StatusDotColor = apiKey.trim()
    ? 'green'
    : requiresApiKey
      ? 'amber'
      : 'none';
  const providerStatusLabel = apiKey.trim()
    ? t('api.providerPicker.keySet')
    : requiresApiKey
      ? t('api.providerPicker.keyMissing')
      : undefined;

  // Model combobox items
  const modelComboItems: ComboboxItem[] = (modelOptions as ModelOptionItem[]).map((m) => ({
    id: m.id,
    label: m.name,
  }));

  // When a provider supports manual entry but has no preset/registry models to
  // pick from (e.g. Custom with no presets, or Ollama before/without detection),
  // force manual input and disable the Preset/Custom toggle — there is nothing
  // to switch to.
  const hasModelOptions = modelOptions.length > 0;
  const forceManualModel = showManualModelToggle && !hasModelOptions;
  const effectiveManualModel = useCustomModel || forceManualModel;

  // For the manual-model toggle label: native uses same wording as custom
  const manualToggleLabel = isOllamaMode
    ? effectiveManualModel
      ? t('api.useDetectedModels')
      : t('api.manualModel')
    : effectiveManualModel
      ? t('api.usePreset')
      : t('api.custom');

  return (
    <div className="space-y-5">
      {/* Config Set Switcher */}
      <ApiConfigSetManager
        configSets={configSets}
        activeConfigSetId={activeConfigSetId}
        currentConfigSet={currentConfigSet}
        pendingConfigSetAction={pendingConfigSetAction}
        pendingConfigSet={pendingConfigSet}
        hasUnsavedChanges={hasUnsavedChanges}
        isMutatingConfigSet={isMutatingConfigSet}
        isSaving={isSaving}
        canDeleteCurrentConfigSet={canDeleteCurrentConfigSet}
        onSwitchSet={requestConfigSetSwitch}
        onRequestCreateBlankSet={requestCreateBlankConfigSet}
        onSaveCurrentSet={handleSave}
        onRenameSet={renameConfigSet}
        onDeleteSet={deleteConfigSet}
        onCancelPendingAction={cancelPendingConfigSetAction}
        onSaveAndContinuePendingAction={saveAndContinuePendingConfigSetAction}
        onDiscardAndContinuePendingAction={discardAndContinuePendingConfigSetAction}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Provider Selection                                                  */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        {/* Label row: title left, provider Docs link right-aligned (Option A). */}
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Server className="w-4 h-4" />
            {t('api.provider')}
          </label>
          {activeCatalogEntry?.docsUrl && (
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
        <p className="text-xs leading-5 text-text-muted">{t('api.providerDescription')}</p>

        {/* Single searchable provider picker (Option 2). Builtin providers
            appear as a pinned "Popular" group inside the same list, so there is
            one control and one always-visible selected state. */}
        {isCatalogLoading ? (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-background border border-border text-text-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t('common.loading')}</span>
          </div>
        ) : (
          <ProviderPicker
            catalog={providerCatalog}
            value={provider}
            onChange={changeProvider}
            statusDot={providerStatusDot}
            statusDotLabel={providerStatusLabel}
            disabled={isLoadingConfig}
          />
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* API Key                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <label
          htmlFor="api-key-input"
          className="flex items-center gap-2 text-sm font-medium text-text-primary"
        >
          <Key className="w-4 h-4" />
          {t('api.apiKey')}
        </label>
        <p className="text-xs leading-5 text-text-muted">{t('api.apiKeyDescription')}</p>
        <input
          id="api-key-input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            activeCatalogEntry?.keyPlaceholder ||
            currentPreset?.keyPlaceholder ||
            t('api.enterApiKey')
          }
          className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
        />
        {/* Native provider: show env-var hint */}
        {isNative && activeCatalogEntry?.keyEnvVar && (
          <p className="text-xs text-text-muted">
            {t('api.providerPicker.keyEnvHint', { envVar: activeCatalogEntry.keyEnvVar })}
          </p>
        )}
        {/* Builtin: show existing keyHint from presets */}
        {!isNative && currentPreset?.keyHint && (
          <p className="text-xs text-text-muted">{t(currentPreset.keyHint)}</p>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Custom Protocol (custom provider only)                             */}
      {/* ------------------------------------------------------------------ */}
      {showProtocol && (
        <div className="space-y-3 py-5 border-b border-border-muted">
          <label
            id="api-protocol-label"
            className="flex items-center gap-2 text-sm font-medium text-text-primary"
          >
            <Server className="w-4 h-4" />
            {t('api.protocol')}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(
              [
                { id: 'anthropic', label: 'Anthropic' },
                { id: 'openai', label: 'OpenAI' },
                { id: 'gemini', label: 'Gemini' },
              ] as const
            ).map((mode) => (
              <button
                key={mode.id}
                onClick={() => changeProtocol(mode.id)}
                className={`px-3 py-2 rounded-lg text-sm transition-colors border ${
                  customProtocol === mode.id
                    ? 'border-accent bg-accent/10 text-accent font-medium'
                    : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted">{t('api.selectProtocol')}</p>
          <GuidanceInlineHint text={protocolGuidanceText} tone={protocolGuidanceTone} />
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Base URL (custom + ollama only)                                    */}
      {/* ------------------------------------------------------------------ */}
      {showBaseUrl && (
        <div className="space-y-3 py-5 border-b border-border-muted">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="api-base-url-input"
              className="flex items-center gap-2 text-sm font-medium text-text-primary"
            >
              <Server className="w-4 h-4" />
              {t('api.baseUrl')}
            </label>
            {isOllamaMode && (
              <button
                type="button"
                onClick={() => {
                  void discoverLocalOllama();
                }}
                disabled={isDiscoveringLocalOllama}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-accent-muted text-accent hover:bg-accent-muted/80 disabled:opacity-50"
              >
                <Plug className="w-3 h-3" />
                {isDiscoveringLocalOllama
                  ? t('api.discoveringLocalOllama')
                  : t('api.discoverLocalOllama')}
              </button>
            )}
          </div>
          <input
            id="api-base-url-input"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              provider === 'ollama'
                ? 'http://localhost:11434/v1'
                : customProtocol === 'openai'
                  ? 'https://api.openai.com/v1'
                  : customProtocol === 'gemini'
                    ? 'https://generativelanguage.googleapis.com'
                    : currentPreset?.baseUrl || 'https://api.anthropic.com'
            }
            className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          />
          <p className="text-xs text-text-muted">
            {provider === 'ollama'
              ? t('api.enterOllamaUrl')
              : customProtocol === 'openai'
                ? t('api.enterOpenAIUrl')
                : customProtocol === 'gemini'
                  ? t('api.enterGeminiUrl')
                  : t('api.enterAnthropicUrl')}
          </p>
          {isOllamaMode && (
            <p className="text-xs text-text-muted">{t('api.discoverLocalOllamaHint')}</p>
          )}
          {provider === 'custom' && <GuidanceInlineHint text={baseUrlGuidanceText} />}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Model Selection                                                     */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="flex items-center justify-between">
          <label
            htmlFor="api-model-input"
            className="flex items-center gap-2 text-sm font-medium text-text-primary"
          >
            <Cpu className="w-4 h-4" />
            {t('api.model')}
          </label>
          <div className="flex items-center gap-2">
            {isOllamaMode && (
              <button
                type="button"
                onClick={() => {
                  void refreshModelOptions();
                }}
                disabled={isRefreshingModels}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-surface-hover text-text-secondary hover:bg-surface-active disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshingModels ? 'animate-spin' : ''}`} />
                {isRefreshingModels ? t('api.refreshingModels') : t('api.refreshModels')}
              </button>
            )}
            {showManualModelToggle && (
              <button
                type="button"
                onClick={toggleCustomModel}
                disabled={forceManualModel}
                title={forceManualModel ? t('api.noPresetsManualOnly') : undefined}
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${
                  effectiveManualModel
                    ? 'bg-accent-muted text-accent'
                    : 'border border-border-muted bg-background text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <Edit3 className="w-3 h-3" />
                {manualToggleLabel}
              </button>
            )}
          </div>
        </div>

        {effectiveManualModel ? (
          <input
            id="api-model-input"
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder={modelInputPlaceholder}
            className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          />
        ) : showModelDropdown ? (
          /* Searchable model combobox — native + registry-backed providers.
             Shown whenever the formShape says modelDropdown=true, regardless
             of whether options are populated yet (shows placeholder while loading). */
          <SearchableCombobox
            items={modelComboItems}
            value={model}
            onChange={setModel}
            placeholder={
              modelComboItems.length === 0
                ? t('api.noModelsAvailable')
                : t('api.selectModelRequired')
            }
            searchPlaceholder={t('api.providerPicker.modelSearchPlaceholder')}
            noResultsLabel={t('api.providerPicker.noResults')}
            aria-label={t('api.model')}
          />
        ) : (
          /* Legacy select for builtin cloud providers with small preset lists */
          <select
            id="api-model-input"
            value={modelOptions.length ? model : ''}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all appearance-none cursor-pointer"
          >
            {modelOptions.length ? (
              (modelOptions as ModelOptionItem[]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))
            ) : (
              <option value="" disabled>
                {t('api.noModelsAvailable')}
              </option>
            )}
          </select>
        )}

        {effectiveManualModel && <p className="text-xs text-text-muted">{modelInputHint}</p>}

        {/* Context Window & Max Tokens — only for non-registry providers */}
        {showContextWindow && (
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div>
              <label
                htmlFor="api-context-window-input"
                className="block text-xs font-medium text-text-secondary mb-1"
              >
                {t('api.contextWindow')}
              </label>
              <input
                id="api-context-window-input"
                type="number"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder={t('api.contextWindowPlaceholder')}
                min={1024}
                step={1024}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
              />
            </div>
            <div>
              <label
                htmlFor="api-max-tokens-input"
                className="block text-xs font-medium text-text-secondary mb-1"
              >
                {t('api.maxOutputTokens')}
              </label>
              <input
                id="api-max-tokens-input"
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder={t('api.maxOutputTokensPlaceholder')}
                min={256}
                step={256}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
              />
            </div>
            <p className="col-span-2 text-xs text-text-muted">{t('api.contextWindowHint')}</p>
          </div>
        )}
      </div>

      {/* Common provider setups — custom provider only */}
      {showCustomSetups && (
        <CommonProviderSetupsCard
          setups={commonProviderSetups}
          onApplySetup={applyCommonProviderSetup}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Enable Thinking Mode                                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="flex items-start gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            id="enable-thinking"
            checked={enableThinking}
            onChange={(e) => setEnableThinking(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-border text-accent focus:ring-accent"
          />
          <label htmlFor="enable-thinking" className="space-y-0.5 flex-1">
            <div className="text-text-primary font-medium">{t('api.enableThinking')}</div>
            <div>{t('api.enableThinkingHint')}</div>
            {isOllamaMode && (
              <div className="text-amber-500 dark:text-amber-400 text-xs mt-1">
                {t('api.enableThinkingOllamaHint')}
              </div>
            )}
          </label>
        </div>
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {successMessage && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-success/10 text-success text-sm">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {successMessage}
        </div>
      )}

      {/* Diagnostics Panel */}
      <ApiDiagnosticsPanel
        result={diagnosticResult}
        isRunning={isDiagnosing}
        onRunDiagnostics={handleDiagnose}
        onRunDeepDiagnostics={isOllamaMode ? handleDeepDiagnose : undefined}
        disabled={requiresApiKey && !apiKey.trim()}
      />

      {/* Save Button */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="grid grid-cols-1 gap-2">
          <button
            onClick={() => {
              void handleSave();
            }}
            disabled={isSaving || (requiresApiKey && !apiKey.trim())}
            className="w-full py-3 px-4 rounded-lg bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98] flex items-center justify-center gap-2"
          >
            {isSaving ? (
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
    </div>
  );
}
