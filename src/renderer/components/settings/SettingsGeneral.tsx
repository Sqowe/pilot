import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import {
  SYSTEM_PROMPT_FILE_CHOICES,
  type SystemPromptFileChoice,
} from '../../../shared/system-prompt-file-choices';

export function SettingsGeneral() {
  const { i18n, t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const currentLang = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const [appVer, setAppVer] = useState('');
  useEffect(() => {
    try {
      const v = window.electronAPI?.getVersion?.();
      if (v instanceof Promise) v.then(setAppVer);
      else if (v) setAppVer(v);
    } catch {
      /* ignore */
    }
  }, []);

  const languages = [
    { code: 'en', nativeName: 'English' },
    { code: 'zh', nativeName: '中文' },
  ];

  const themeOptions = [
    { value: 'light' as const, label: t('general.themeLight') },
    { value: 'dark' as const, label: t('general.themeDark') },
    { value: 'system' as const, label: t('general.themeSystem', 'System') },
  ];

  const systemPromptFile: SystemPromptFileChoice = settings.systemPromptFile ?? '';
  const onSystemPromptFileChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as SystemPromptFileChoice;
    if ((SYSTEM_PROMPT_FILE_CHOICES as readonly string[]).includes(next)) {
      updateSettings({ systemPromptFile: next });
    }
  };

  return (
    <div className="space-y-6">
      {/* Theme */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.appearance')}</h4>
        <div className="flex gap-2">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateSettings({ theme: opt.value })}
              className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all ${
                settings.theme === opt.value
                  ? 'border-accent bg-accent/5 text-text-primary'
                  : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Language */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.language')}</h4>
        <div className="flex gap-2">
          {languages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all ${
                currentLang === lang.code
                  ? 'border-accent bg-accent/5 text-text-primary'
                  : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
              }`}
            >
              {lang.nativeName}
            </button>
          ))}
        </div>
      </div>

      {/* Workspace instructions file */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-text-primary">
          {t('general.systemPromptFile', 'Workspace instructions file')}
        </h4>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'general.systemPromptFileDesc',
            'When this file exists at the session working directory, its contents are appended to the system prompt as project-level instructions. Missing file falls back to the default.'
          )}
        </p>
        <select
          value={systemPromptFile}
          onChange={onSystemPromptFileChange}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          aria-label={t('general.systemPromptFile', 'Workspace instructions file')}
        >
          {SYSTEM_PROMPT_FILE_CHOICES.map((opt) => (
            <option key={opt || 'none'} value={opt}>
              {opt === '' ? t('general.systemPromptFileNone', 'None (use default)') : opt}
            </option>
          ))}
        </select>
      </div>

      {/* About */}
      {appVer && (
        <div className="pt-4 border-t border-border">
          <p className="text-xs text-text-muted">Open Cowork v{appVer}</p>
        </div>
      )}
    </div>
  );
}
