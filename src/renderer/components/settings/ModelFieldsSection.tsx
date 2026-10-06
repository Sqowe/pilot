import { useTranslation } from 'react-i18next';
import { Cpu, Edit3, RefreshCw } from 'lucide-react';
import type { useModelSetForm } from '../../hooks/useModelSetForm';
import { SearchableCombobox, type ComboboxItem } from '../SearchableCombobox';

interface ModelFieldsSectionProps {
  form: ReturnType<typeof useModelSetForm>;
}

const INPUT_CLASS =
  'w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-60 disabled:cursor-not-allowed transition-all';
const LIMIT_INPUT_CLASS =
  'w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-60 disabled:cursor-not-allowed transition-all';

/**
 * The model of a config set: the model itself (picked or typed), the two token
 * limits where the provider has them, and the thinking level.
 *
 * Which fields show is read from the provider's catalog entry (`formShape`),
 * with the provider-literal checks kept as the fallback for builtins.
 *
 * Every field is off while the set is being saved or switched (`isLocked`):
 * what main returns replaces what is here.
 */
export function ModelFieldsSection({ form }: ModelFieldsSectionProps) {
  const { t } = useTranslation();
  const {
    provider,
    activeCatalogEntry,
    activeFormShape,
    modelOptions,
    model,
    customModel,
    useCustomModel,
    contextWindow,
    maxTokens,
    modelInputPlaceholder,
    modelInputHint,
    isOllamaMode,
    shouldShowOllamaManualModelToggle,
    isRefreshingModels,
    isLocked,
    thinkingCapabilities,
    effectiveThinkingLevel,
    setModel,
    setCustomModel,
    toggleCustomModel,
    setContextWindow,
    setMaxTokens,
    setThinkingLevel,
    refreshModelOptions,
  } = form;

  const showContextWindow =
    activeFormShape != null
      ? activeFormShape.contextWindow
      : provider === 'custom' || provider === 'ollama';

  // From the catalog entry's formShape (present for every provider, not only
  // native ones) so cloud builtins get the same searchable list as native
  // providers. Ollama and custom keep `modelDropdown: false`.
  const showModelDropdown = activeCatalogEntry?.formShape.modelDropdown ?? false;

  const showManualModelToggle =
    activeFormShape != null ? activeFormShape.manualModelToggle : shouldShowOllamaManualModelToggle;

  const modelComboItems: ComboboxItem[] = modelOptions.map((option) => ({
    id: option.id,
    label: option.name,
  }));

  // A provider that allows a typed model but has nothing to pick from (a custom
  // endpoint, or Ollama before its server has answered) is typed-only: the
  // toggle has nothing to switch to.
  const forceManualModel = showManualModelToggle && modelOptions.length === 0;
  const effectiveManualModel = useCustomModel || forceManualModel;

  const manualToggleLabel = isOllamaMode
    ? effectiveManualModel
      ? t('api.useDetectedModels')
      : t('api.manualModel')
    : effectiveManualModel
      ? t('api.usePreset')
      : t('api.custom');

  return (
    <>
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
                disabled={isRefreshingModels || isLocked}
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
                disabled={forceManualModel || isLocked}
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
            disabled={isLocked}
            className={INPUT_CLASS}
          />
        ) : showModelDropdown ? (
          // Shown whenever the provider has a registry list, populated or not:
          // the placeholder stands in while it loads.
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
            disabled={isLocked}
            aria-label={t('api.model')}
          />
        ) : (
          <select
            id="api-model-input"
            value={modelOptions.length ? model : ''}
            onChange={(e) => setModel(e.target.value)}
            disabled={isLocked}
            className={`${INPUT_CLASS} appearance-none cursor-pointer`}
          >
            {modelOptions.length ? (
              modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
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
                disabled={isLocked}
                className={LIMIT_INPUT_CLASS}
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
                disabled={isLocked}
                className={LIMIT_INPUT_CLASS}
              />
            </div>
            <p className="col-span-2 text-xs text-text-muted">{t('api.contextWindowHint')}</p>
          </div>
        )}
      </div>

      <div className="space-y-2 py-5 border-b border-border-muted">
        <div className="text-xs font-medium text-text-primary">{t('api.thinkingLevel')}</div>
        <div className="text-xs text-text-muted mb-2">
          {thinkingCapabilities.supportsThinking
            ? t('api.thinkingLevelHint')
            : t('api.thinkingLevelUnsupportedHint')}
        </div>
        {thinkingCapabilities.supportsThinking && (
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('api.thinkingLevel')}>
            {/* `levels` arrives canonically ordered and always contains 'off'. */}
            {thinkingCapabilities.levels.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setThinkingLevel(level)}
                disabled={isLocked}
                aria-pressed={effectiveThinkingLevel === level}
                className={[
                  'px-3 py-1 rounded text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 disabled:cursor-not-allowed',
                  effectiveThinkingLevel === level
                    ? 'bg-accent text-white'
                    : 'bg-bg-tertiary text-text-muted hover:bg-bg-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {t(`api.thinkingLevelOption.${level}`, { defaultValue: level })}
              </button>
            ))}
          </div>
        )}
        {isOllamaMode && (
          <div className="text-amber-500 dark:text-amber-400 text-xs mt-1">
            {t('api.thinkingLevelOllamaHint')}
          </div>
        )}
      </div>
    </>
  );
}
