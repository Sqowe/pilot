import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';

export function SettingsGeneral() {
  const { i18n, t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const appConfig = useAppStore((s) => s.appConfig);
  const currentLang = i18n.language.startsWith('zh')
    ? 'zh'
    : i18n.language.startsWith('ru')
      ? 'ru'
      : i18n.language.startsWith('hu')
        ? 'hu'
        : 'en';
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

  const notificationsEnabled = appConfig?.notificationsEnabled ?? true;

  // HTTP proxy state — draft/committed pattern matching localDevPath in SettingsSkills
  const [httpProxyDraft, setHttpProxyDraft] = useState(appConfig?.httpProxy ?? '');
  const [httpProxyCommitted, setHttpProxyCommitted] = useState(appConfig?.httpProxy ?? '');
  const [httpProxySaving, setHttpProxySaving] = useState(false);
  const [httpProxyError, setHttpProxyError] = useState<string | null>(null);
  const [httpProxySaved, setHttpProxySaved] = useState(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up the transient "saved" indicator timeout on unmount
  useEffect(
    () => () => {
      if (savedTimeoutRef.current !== null) clearTimeout(savedTimeoutRef.current);
    },
    []
  );

  // Sync draft from appConfig on mount / config reload
  useEffect(() => {
    const v = appConfig?.httpProxy ?? '';
    setHttpProxyDraft(v);
    setHttpProxyCommitted(v);
  }, [appConfig?.httpProxy]);

  const handleSaveHttpProxy = async () => {
    if (httpProxySaving) return; // prevent concurrent saves
    setHttpProxySaving(true);
    setHttpProxyError(null);
    setHttpProxySaved(false);
    const trimmed = httpProxyDraft.trim();
    // Validate non-empty URLs: must parse and use http or https scheme
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setHttpProxyError(t('general.httpProxyInvalidScheme'));
          setHttpProxySaving(false);
          return;
        }
        if (parsed.username || parsed.password) {
          setHttpProxyError(t('general.httpProxyNoCredentials'));
          setHttpProxySaving(false);
          return;
        }
      } catch {
        setHttpProxyError(t('general.httpProxyInvalidUrl'));
        setHttpProxySaving(false);
        return;
      }
    }
    try {
      await window.electronAPI.config.save({ httpProxy: trimmed });
      setHttpProxyCommitted(trimmed);
      setHttpProxySaved(true);
      if (savedTimeoutRef.current !== null) clearTimeout(savedTimeoutRef.current);
      const savedTimeoutId = setTimeout(() => setHttpProxySaved(false), 2000);
      savedTimeoutRef.current = savedTimeoutId;
    } catch (err) {
      setHttpProxyError(err instanceof Error ? err.message : t('general.httpProxySaveFailed'));
    } finally {
      setHttpProxySaving(false);
    }
  };

  const languages = [
    { code: 'en', nativeName: 'English' },
    { code: 'zh', nativeName: '中文' },
    { code: 'ru', nativeName: 'Русский' },
    { code: 'hu', nativeName: 'Magyar' },
  ];

  const themeOptions = [
    { value: 'light' as const, label: t('general.themeLight') },
    { value: 'dark' as const, label: t('general.themeDark') },
    { value: 'system' as const, label: t('general.themeSystem', 'System') },
  ];

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

      {/* Notifications */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.notifications')}</h4>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={notificationsEnabled}
            onChange={(e) => updateSettings({ notificationsEnabled: e.target.checked })}
            className="w-4 h-4 rounded border-border text-accent focus:ring-accent/50"
          />
          <div>
            <span className="text-sm text-text-primary">{t('general.notificationsEnabled')}</span>
            <p className="text-xs text-text-muted mt-0.5">{t('general.notificationsHint')}</p>
          </div>
        </label>
      </div>

      {/* HTTP Proxy */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.httpProxy')}</h4>
        <p className="text-xs text-text-muted">{t('general.httpProxyHint')}</p>
        <div className="flex gap-2">
          <input
            type="url"
            value={httpProxyDraft}
            onChange={(e) => {
              setHttpProxyDraft(e.target.value);
              setHttpProxySaved(false);
              setHttpProxyError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !httpProxySaving && httpProxyDraft !== httpProxyCommitted)
                handleSaveHttpProxy();
            }}
            placeholder="http://proxy.example.com:8080"
            className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
            aria-label={t('general.httpProxy')}
          />
          <button
            onClick={handleSaveHttpProxy}
            disabled={httpProxySaving || httpProxyDraft === httpProxyCommitted}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text-secondary hover:text-text-primary hover:border-accent/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label={t('general.httpProxySave')}
          >
            {httpProxySaving
              ? t('general.httpProxySaving')
              : httpProxySaved
                ? t('general.httpProxySaved')
                : t('general.httpProxySave')}
          </button>
        </div>
        {httpProxyError && <p className="text-xs text-red-500">{httpProxyError}</p>}
        {httpProxySaved && (
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {t('general.httpProxySaved')}
          </p>
        )}
      </div>

      {/* About */}
      {appVer && (
        <div className="pt-4 border-t border-border">
          <p className="text-xs text-text-muted">Sqowe Pilot v{appVer}</p>
        </div>
      )}
    </div>
  );
}
