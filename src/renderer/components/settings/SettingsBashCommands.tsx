import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal, Shield, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../store';

/**
 * Settings panel for bash command trust list and denylist.
 *
 * The engine behind these fields lives in
 * `src/main/config/permission-rules-store.ts`. See that module for the
 * authoritative-mode precedence model and quote-aware parsing details.
 *
 * Values are persisted in the main-process `configStore` so they survive
 * app restarts and are applied before the first tool call on startup.
 */
export function SettingsBashCommands() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  // Local textarea state so typing doesn't fire an IPC round-trip per keystroke.
  // We commit to the store on blur by parsing the textarea content into a list.
  const [trustedDraft, setTrustedDraft] = useState('');
  const [denylistDraft, setDenylistDraft] = useState('');

  // Reset local drafts whenever the store changes (e.g. initial load, or an
  // external update). Avoids stale drafts overwriting newer values on blur.
  useEffect(() => {
    setTrustedDraft((settings.bashTrustedCommands ?? []).join('\n'));
  }, [settings.bashTrustedCommands]);

  useEffect(() => {
    setDenylistDraft((settings.bashDenylist ?? []).join('\n'));
  }, [settings.bashDenylist]);

  const parseList = (raw: string): string[] =>
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const commitTrusted = () => {
    const next = parseList(trustedDraft);
    const current = settings.bashTrustedCommands ?? [];
    if (next.length !== current.length || next.some((v, i) => v !== current[i])) {
      updateSettings({ bashTrustedCommands: next });
    }
  };

  const commitDenylist = () => {
    const next = parseList(denylistDraft);
    const current = settings.bashDenylist ?? [];
    if (next.length !== current.length || next.some((v, i) => v !== current[i])) {
      updateSettings({ bashDenylist: next });
    }
  };

  const authoritativeMode =
    (settings.bashTrustedCommands?.length ?? 0) > 0 || (settings.bashDenylist?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      {/* Mode indicator */}
      <div
        className={`flex items-start gap-3 p-3 rounded-lg border ${
          authoritativeMode ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface'
        }`}
      >
        <Terminal className="w-4 h-4 mt-0.5 flex-shrink-0 text-text-secondary" />
        <div className="text-sm text-text-secondary">
          {authoritativeMode
            ? t(
                'bashCommands.modeAuthoritative',
                'Authoritative mode: these lists are the complete policy for bash commands. Anything not explicitly trusted will prompt for approval.'
              )
            : t(
                'bashCommands.modeInactive',
                'Not configured. The default bash rule applies to all commands. Add at least one trusted pattern or denylist entry to enable fine-grained control.'
              )}
        </div>
      </div>

      {/* Trusted commands */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-text-secondary" />
          <h4 className="text-sm font-medium text-text-primary">
            {t('bashCommands.trustedTitle', 'Trusted commands')}
          </h4>
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'bashCommands.trustedDesc',
            'One pattern per line. Prefix-matched; use `*` as a wildcard. Matching commands run without a prompt. Each sub-command in a chain (&&, ||, ;, |) is checked independently.'
          )}
        </p>
        <textarea
          value={trustedDraft}
          onChange={(e) => setTrustedDraft(e.target.value)}
          onBlur={commitTrusted}
          spellCheck={false}
          rows={6}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm font-mono text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          placeholder={'npm *\ngit status\nls *\n./build *'}
          aria-label={t('bashCommands.trustedTitle', 'Trusted commands')}
        />
      </div>

      {/* Denylist */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-warning" />
          <h4 className="text-sm font-medium text-text-primary">
            {t('bashCommands.denylistTitle', 'Denylist (force approval)')}
          </h4>
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'bashCommands.denylistDesc',
            'One pattern per line. Substring-matched. Any command containing a denylist entry always prompts, even if it also matches the trusted list.'
          )}
        </p>
        <textarea
          value={denylistDraft}
          onChange={(e) => setDenylistDraft(e.target.value)}
          onBlur={commitDenylist}
          spellCheck={false}
          rows={6}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm font-mono text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          placeholder={'rm -rf\nsudo\n--force\ncurl | sh'}
          aria-label={t('bashCommands.denylistTitle', 'Denylist (force approval)')}
        />
      </div>

      {/* Safety notice */}
      <div className="pt-4 border-t border-border">
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'bashCommands.safetyNote',
            'Shell expansions that cannot be parsed safely (command substitution, process substitution, newlines, lone background &) always prompt, even when a matching trusted pattern exists.'
          )}
        </p>
      </div>
    </div>
  );
}
