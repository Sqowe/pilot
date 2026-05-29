import { useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

export interface ExportOptions {
  includeToolCalls: boolean;
  includeThinking: boolean;
  includeTimestamps: boolean;
  includeTokenUsage: boolean;
  imageHandling: 'skip' | 'placeholder';
}

const DEFAULT_OPTIONS: ExportOptions = {
  includeToolCalls: false,
  includeThinking: false,
  includeTimestamps: false,
  includeTokenUsage: false,
  imageHandling: 'placeholder',
};

interface ExportOptionsDialogProps {
  messageCount: number;
  onExport: (options: ExportOptions) => void;
  onCancel: () => void;
}

export const ExportOptionsDialog = memo(function ExportOptionsDialog({
  messageCount,
  onExport,
  onCancel,
}: ExportOptionsDialogProps) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_OPTIONS);

  const toggle = (key: keyof Omit<ExportOptions, 'imageHandling'>) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div className="relative bg-background border border-border-muted rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-[15px] font-semibold text-text-primary">{t('export.dialogTitle')}</h3>
          <button
            onClick={onCancel}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Message count */}
        <p className="text-[13px] text-text-secondary mb-4">
          {t('export.messageCount', { count: messageCount })}
        </p>

        {/* Options */}
        <div className="space-y-3 mb-6">
          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={options.includeToolCalls}
              onChange={() => toggle('includeToolCalls')}
              className="w-4 h-4 rounded border-border-muted accent-accent"
            />
            <span className="text-[13px] text-text-primary group-hover:text-accent transition-colors">
              {t('export.includeToolCalls')}
            </span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={options.includeThinking}
              onChange={() => toggle('includeThinking')}
              className="w-4 h-4 rounded border-border-muted accent-accent"
            />
            <span className="text-[13px] text-text-primary group-hover:text-accent transition-colors">
              {t('export.includeThinking')}
            </span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={options.includeTimestamps}
              onChange={() => toggle('includeTimestamps')}
              className="w-4 h-4 rounded border-border-muted accent-accent"
            />
            <span className="text-[13px] text-text-primary group-hover:text-accent transition-colors">
              {t('export.includeTimestamps')}
            </span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={options.includeTokenUsage}
              onChange={() => toggle('includeTokenUsage')}
              className="w-4 h-4 rounded border-border-muted accent-accent"
            />
            <span className="text-[13px] text-text-primary group-hover:text-accent transition-colors">
              {t('export.includeTokenUsage')}
            </span>
          </label>

          {/* Image handling */}
          <div className="pt-2 border-t border-border-muted">
            <p className="text-[12px] text-text-muted mb-2">{t('export.imageHandling')}</p>
            <div className="flex gap-2">
              {(['placeholder', 'skip'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setOptions((prev) => ({ ...prev, imageHandling: mode }))}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                    options.imageHandling === mode
                      ? 'bg-accent/10 text-accent border border-accent/30'
                      : 'bg-surface-muted text-text-secondary hover:bg-surface-hover border border-transparent'
                  }`}
                >
                  {t(`export.image_${mode}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => onExport(options)}
            className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-accent text-background hover:bg-accent-hover transition-colors"
          >
            {t('export.exportButton')}
          </button>
        </div>
      </div>
    </div>
  );
});
