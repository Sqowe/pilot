import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { PluginInstallResultV2 } from '../../types';
import { parseGitHubPluginUrl } from '../../../shared/plugin-github-url';
import { SettingsDialogFrame, useSingleFlight } from './SettingsDialogFrame';
import { FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from './CredentialDialogParts';
import { pluginGitHubErrorMessage } from './plugin-github-messages';

interface PluginGitHubInstallDialogProps {
  onClose: () => void;
  /** Called with the result once the plugin is installed; the dialog closes itself. */
  onInstalled: (result: PluginInstallResultV2) => void;
}

/**
 * "Install from GitHub": one field for a repository link. The link is checked
 * here only to enable the button; the main process parses it again and builds
 * every URL itself.
 */
export function PluginGitHubInstallDialog({
  onClose,
  onInstalled,
}: PluginGitHubInstallDialogProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [isInstalling, setIsInstalling] = useState(false);
  const runOnce = useSingleFlight();

  const parsed = parseGitHubPluginUrl(url);
  const showInvalid = url.trim().length > 0 && !parsed;

  const submit = useCallback(() => {
    if (!parseGitHubPluginUrl(url) || !window.electronAPI) {
      return;
    }
    void runOnce(async () => {
      setIsInstalling(true);
      setError('');
      try {
        const response = await window.electronAPI.plugins.installFromGitHub(url.trim());
        if (response.ok) {
          onInstalled(response.result);
          onClose();
        } else {
          setError(pluginGitHubErrorMessage(response.error, t));
        }
      } catch (err) {
        console.error('Install from GitHub failed:', err);
        setError(t('skills.githubErrors.unknown'));
      } finally {
        setIsInstalling(false);
      }
    });
  }, [onClose, onInstalled, runOnce, t, url]);

  const hintId = 'plugin-github-url-hint';
  const errorId = 'plugin-github-url-error';
  const describedBy = [hintId, showInvalid || error ? errorId : null].filter(Boolean).join(' ');

  return (
    <SettingsDialogFrame
      title={t('skills.installFromGitHubTitle')}
      onClose={onClose}
      onSubmit={submit}
      busy={isInstalling}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={isInstalling}
            className="px-4 py-2 rounded-lg border border-border bg-surface text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={isInstalling || !parsed}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            {isInstalling && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {isInstalling ? t('skills.githubInstalling') : t('skills.pluginInstall')}
          </button>
        </>
      }
    >
      <p className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/10 text-xs leading-5 text-text-primary">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <span>{t('skills.githubTrustWarning')}</span>
      </p>

      <div className="space-y-1.5">
        <label htmlFor="plugin-github-url-input" className={LABEL_CLASS}>
          {t('skills.githubUrlLabel')}
        </label>
        <input
          id="plugin-github-url-input"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError('');
          }}
          placeholder="https://github.com/owner/repo"
          autoFocus
          disabled={isInstalling}
          aria-invalid={showInvalid || Boolean(error)}
          aria-describedby={describedBy}
          className={FIELD_CLASS}
        />
        <p id={hintId} className={HINT_CLASS}>
          {t('skills.githubUrlHint')}
        </p>
        {(showInvalid || error) && (
          <p id={errorId} role="alert" className="text-xs leading-5 text-error">
            {error || t('skills.githubErrors.invalidUrl')}
          </p>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {isInstalling ? t('skills.githubInstalling') : ''}
      </p>
    </SettingsDialogFrame>
  );
}
