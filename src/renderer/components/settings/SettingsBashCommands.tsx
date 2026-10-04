import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal, Shield, AlertTriangle, Clock, FolderCheck } from 'lucide-react';
import { useAppStore } from '../../store';

/**
 * Settings panel for bash command trust list and denylist, and for the
 * trusted directories (write zone).
 *
 * The engine behind these fields lives in
 * `src/main/config/permission-rules-store.ts`. See that module for the
 * authoritative-mode precedence model and quote-aware parsing details.
 * The trusted directories also govern the `write` and `edit` tools, not only
 * bash — see docs/design/trusted-directories.md.
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
  const [directoriesDraft, setDirectoriesDraft] = useState('');

  // Reset local drafts whenever the store changes (e.g. initial load, or an
  // external update). Avoids stale drafts overwriting newer values on blur.
  useEffect(() => {
    setTrustedDraft((settings.bashTrustedCommands ?? []).join('\n'));
  }, [settings.bashTrustedCommands]);

  useEffect(() => {
    setDenylistDraft((settings.bashDenylist ?? []).join('\n'));
  }, [settings.bashDenylist]);

  useEffect(() => {
    setDirectoriesDraft((settings.trustedDirectories ?? []).join('\n'));
  }, [settings.trustedDirectories]);

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

  const commitDirectories = () => {
    // Entries are stored as written; main validates them per session (an entry
    // that is too broad or cannot be resolved is not accepted there).
    const next = [...new Set(parseList(directoriesDraft))];
    const current = settings.trustedDirectories ?? [];
    if (next.length !== current.length || next.some((v, i) => v !== current[i])) {
      updateSettings({ trustedDirectories: next });
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
            'One pattern per line. Word-boundary matched — only triggers when the pattern appears as a distinct word (e.g. "rm" catches "rm -rf" but not "formats"). Any command containing a denylist match always prompts, even if it also matches the trusted list.'
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

      {/* Trusted directories (write zone) */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FolderCheck className="w-4 h-4 text-text-secondary" />
          <h4 className="text-sm font-medium text-text-primary">
            {t('bashCommands.trustedDirectoriesTitle', 'Trusted directories')}
          </h4>
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'bashCommands.trustedDirectoriesDesc',
            "One directory per line. A write inside these directories runs without a prompt; a write anywhere else asks. Applies to the write and edit tools and to the places a bash command visibly writes (output redirections, tee). `./` means the session's workspace. Leave empty to turn the check off."
          )}
        </p>
        <textarea
          value={directoriesDraft}
          onChange={(e) => setDirectoriesDraft(e.target.value)}
          onBlur={commitDirectories}
          spellCheck={false}
          rows={3}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm font-mono text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          placeholder={'./\n/tmp'}
          aria-label={t('bashCommands.trustedDirectoriesTitle', 'Trusted directories')}
        />
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'bashCommands.trustedDirectoriesNote',
            'This checks visible writes — it is not a sandbox: what a program writes on its own cannot be seen. The file-system root and the home directory are not accepted as entries. A bash command must still pass the lists above.'
          )}
        </p>
      </div>

      {/* Safety notice */}
      <div className="pt-4 border-t border-border">
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'bashCommands.safetyNote',
            'Shell syntax that cannot be read safely (command substitution, process substitution, subshells, lone background &) always prompts, even when a matching trusted pattern exists. A line break separates commands like `;` — each one is checked on its own.'
          )}
        </p>
      </div>

      {/* Permission Timeout */}
      <div className="pt-4 border-t border-border space-y-2">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-text-secondary" />
          <h4 className="text-sm font-medium text-text-primary">
            {t('bashCommands.permissionTimeoutTitle', 'Permission dialog timeout')}
          </h4>
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'bashCommands.permissionTimeoutDesc',
            'How long to wait for your response before auto-denying a permission request. Set to 0 for no timeout (wait forever).'
          )}
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={(settings.permissionTimeoutSeconds ?? 300) === 0}
              onChange={(e) => {
                updateSettings({
                  permissionTimeoutSeconds: e.target.checked ? 0 : 300,
                });
              }}
              className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
            />
            <span className="text-sm text-text-secondary">
              {t('bashCommands.permissionTimeoutInfinite', 'No timeout (wait forever)')}
            </span>
          </label>
        </div>
        {(settings.permissionTimeoutSeconds ?? 300) !== 0 && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={10}
              max={3600}
              step={10}
              value={settings.permissionTimeoutSeconds ?? 300}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 10 && val <= 3600) {
                  updateSettings({ permissionTimeoutSeconds: val });
                }
              }}
              className="w-24 px-3 py-1.5 rounded-lg border border-border bg-surface text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              aria-label={t('bashCommands.permissionTimeoutTitle', 'Permission dialog timeout')}
            />
            <span className="text-sm text-text-secondary">
              {t('bashCommands.permissionTimeoutUnit', 'seconds')}
            </span>
            <span className="text-xs text-text-muted">
              ({Math.floor((settings.permissionTimeoutSeconds ?? 300) / 60)}
              {t('bashCommands.permissionTimeoutMinLabel', ' min')})
            </span>
          </div>
        )}
      </div>

      {/* MCP Tool Execution Timeout */}
      <div className="pt-4 border-t border-border space-y-2">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-text-secondary" />
          <h4 className="text-sm font-medium text-text-primary">
            {t('bashCommands.mcpToolTimeoutTitle', 'MCP tool execution timeout')}
          </h4>
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'bashCommands.mcpToolTimeoutDesc',
            'Maximum time to wait for an MCP tool to respond. On timeout, the AI receives an error and can retry or try a different approach. Set to 0 to disable (not recommended).'
          )}
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={(settings.mcpToolTimeoutSeconds ?? 240) === 0}
              onChange={(e) => {
                updateSettings({
                  mcpToolTimeoutSeconds: e.target.checked ? 0 : 240,
                });
              }}
              className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
            />
            <span className="text-sm text-text-secondary">
              {t('bashCommands.mcpToolTimeoutDisabled', 'No timeout (not recommended)')}
            </span>
          </label>
        </div>
        {(settings.mcpToolTimeoutSeconds ?? 240) !== 0 && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={10}
              max={600}
              step={10}
              value={settings.mcpToolTimeoutSeconds ?? 240}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 10 && val <= 600) {
                  updateSettings({ mcpToolTimeoutSeconds: val });
                }
              }}
              className="w-24 px-3 py-1.5 rounded-lg border border-border bg-surface text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              aria-label={t('bashCommands.mcpToolTimeoutTitle', 'MCP tool execution timeout')}
            />
            <span className="text-sm text-text-secondary">
              {t('bashCommands.mcpToolTimeoutUnit', 'seconds')}
            </span>
            <span className="text-xs text-text-muted">
              ({Math.floor((settings.mcpToolTimeoutSeconds ?? 240) / 60)}
              {t('bashCommands.mcpToolTimeoutMinLabel', ' min')})
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
