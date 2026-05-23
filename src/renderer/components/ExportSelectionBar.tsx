import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, CheckSquare, Download } from 'lucide-react';

interface ExportSelectionBarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onExport: () => void;
  onCancel: () => void;
}

export const ExportSelectionBar = memo(function ExportSelectionBar({
  selectedCount,
  totalCount,
  onSelectAll,
  onExport,
  onCancel,
}: ExportSelectionBarProps) {
  const { t } = useTranslation();

  return (
    <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 animate-fade-in">
      <div className="flex items-center gap-3 px-5 py-3 rounded-2xl bg-background/95 border border-border-muted shadow-lg backdrop-blur-md">
        {/* Count */}
        <span className="text-[13px] text-text-secondary whitespace-nowrap">
          {t('export.selectedCount', { count: selectedCount })}
        </span>

        {/* Select All */}
        <button
          onClick={onSelectAll}
          disabled={selectedCount === totalCount}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <CheckSquare className="w-3.5 h-3.5" />
          {t('export.selectAll')}
        </button>

        {/* Divider */}
        <div className="w-px h-5 bg-border-muted" />

        {/* Export */}
        <button
          onClick={onExport}
          disabled={selectedCount === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-medium bg-accent text-background hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download className="w-3.5 h-3.5" />
          {t('export.exportButton')}
        </button>

        {/* Cancel */}
        <button
          onClick={onCancel}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
          title={t('common.cancel')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
});
