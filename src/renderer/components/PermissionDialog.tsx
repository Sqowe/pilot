import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../hooks/useIPC';
import type { PermissionRequest } from '../types';
import { Shield, X, Check, AlertTriangle, MessageSquare } from 'lucide-react';

interface PermissionDialogProps {
  permission: PermissionRequest;
}

export function PermissionDialog({ permission }: PermissionDialogProps) {
  const { t } = useTranslation();
  const { respondToPermission } = useIPC();
  const [pendingAlwaysAllow, setPendingAlwaysAllow] = useState(false);
  const [showSuggestionInput, setShowSuggestionInput] = useState(false);
  const [suggestion, setSuggestion] = useState('');

  /**
   * What triggered the prompt, in the user's language. The main-process gate
   * sends a structured reason (bash lists, trusted directories); the wording
   * lives here so it can be localized.
   */
  const getReasonText = (): string | null => {
    const reason = permission.reason;
    if (!reason) return null;
    const firstLine = (text: string): string => {
      const line = text.split('\n')[0];
      return line.length > 120 ? `${line.slice(0, 120)}…` : line;
    };
    switch (reason.kind) {
      case 'unsupported-syntax':
        return t('permission.reasons.unsupported-syntax', { detail: reason.detail });
      case 'denied':
        return t('permission.reasons.denied', { pattern: reason.pattern });
      case 'not-trusted':
        return t('permission.reasons.not-trusted', { subCommand: firstLine(reason.subCommand) });
      case 'empty':
        return t('permission.reasons.empty');
      case 'write-outside':
        return t('permission.reasons.write-outside', { path: reason.path });
      case 'write-protected':
        return t('permission.reasons.write-protected', { path: reason.path });
      case 'write-undetermined':
        return t('permission.reasons.write-undetermined', { detail: reason.detail });
      default:
        return null;
    }
  };
  const reasonText = getReasonText();

  const getToolDescription = (toolName: string): string => {
    const key = `permission.toolDescriptions.${toolName}`;
    const translated = t(key);
    // If translation exists (not the same as key), return it
    if (translated !== key) {
      return translated;
    }
    // Otherwise fallback to default message
    return t('permission.useTool', { toolName });
  };

  const isHighRisk = [
    'bash',
    'write',
    'edit',
    'execute_command',
    'write_file',
    'edit_file',
  ].includes(permission.toolName);

  const handleDenyWithSuggestion = () => {
    if (suggestion.trim()) {
      respondToPermission(permission.toolUseId, 'deny_with_suggestion', suggestion.trim());
    } else {
      respondToPermission(permission.toolUseId, 'deny');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
      <div className="card w-full max-w-md p-6 m-4 shadow-elevated animate-slide-up">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isHighRisk ? 'bg-warning/10' : 'bg-accent-muted'
            }`}
          >
            {isHighRisk ? (
              <AlertTriangle className="w-6 h-6 text-warning" />
            ) : (
              <Shield className="w-6 h-6 text-accent" />
            )}
          </div>

          <div className="flex-1">
            <h2 className="text-lg font-semibold text-text-primary">
              {t('permission.permissionRequired')}
            </h2>
            <p className="text-sm text-text-secondary mt-1">
              {getToolDescription(permission.toolName)}
            </p>
          </div>
        </div>

        {/* Tool Details */}
        <div className="mt-4 p-4 bg-surface-muted rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-text-primary">{t('permission.tool')}</span>
            <span className="font-mono text-accent text-sm">{permission.toolName}</span>
          </div>

          <div className="text-sm text-text-secondary">
            <span className="font-medium text-text-primary">{t('permission.input')}</span>
            <pre className="mt-1 text-xs code-block max-h-32 overflow-auto">
              {JSON.stringify(permission.input, null, 2)}
            </pre>
          </div>

          {reasonText && (
            <div className="mt-3 text-sm text-text-secondary">
              <span className="font-medium text-text-primary">{t('permission.reasonLabel')}</span>{' '}
              <span className="break-words">{reasonText}</span>
            </div>
          )}
        </div>

        {/* Warning */}
        {isHighRisk && (
          <div className="mt-4 p-3 bg-warning/10 border border-warning/20 rounded-xl">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
              <p className="text-sm text-warning">{t('permission.warning')}</p>
            </div>
          </div>
        )}

        {/* Suggestion Input */}
        {showSuggestionInput && (
          <div className="mt-4 p-3 bg-surface-muted border border-border rounded-xl">
            <label className="text-sm font-medium text-text-primary block mb-2">
              {t('permission.suggestionLabel', {
                defaultValue: 'Suggest an alternative approach:',
              })}
            </label>
            <textarea
              value={suggestion}
              onChange={(e) => setSuggestion(e.target.value)}
              placeholder={t('permission.suggestionPlaceholder', {
                defaultValue:
                  'e.g., "Use the pdf skill instead" or "Read with pdfplumber, not pypdf"',
              })}
              className="w-full p-2 text-sm rounded-lg border border-border bg-background text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-accent"
              rows={3}
              autoFocus
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => {
                  setShowSuggestionInput(false);
                  setSuggestion('');
                }}
                className="flex-1 btn btn-ghost text-sm"
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                onClick={handleDenyWithSuggestion}
                className="flex-1 btn btn-secondary text-sm"
              >
                <X className="w-3 h-3" />
                {t('permission.denyWithSuggestion', { defaultValue: 'Deny & Send' })}
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        {!showSuggestionInput && (
          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={() => respondToPermission(permission.toolUseId, 'deny')}
              className="flex-1 btn btn-secondary"
            >
              <X className="w-4 h-4" />
              {t('permission.deny')}
            </button>

            <button
              onClick={() => respondToPermission(permission.toolUseId, 'allow')}
              className="flex-1 btn btn-primary"
            >
              <Check className="w-4 h-4" />
              {t('permission.allow')}
            </button>
          </div>
        )}

        {/* Deny & Suggest + Always Allow options */}
        {!showSuggestionInput && (
          <>
            <button
              onClick={() => {
                setPendingAlwaysAllow(false);
                setShowSuggestionInput(true);
              }}
              className="w-full mt-2 btn btn-ghost text-sm"
            >
              <MessageSquare className="w-3.5 h-3.5 mr-1" />
              {t('permission.denySuggest', { defaultValue: 'Deny & Suggest Alternative' })}
            </button>

            {/* Always Allow option */}
            {!pendingAlwaysAllow ? (
              <button
                onClick={() => {
                  const dangerousTools = ['bash', 'write', 'edit', 'execute_command'];
                  const isDangerous = dangerousTools.some((tool) =>
                    permission.toolName?.toLowerCase().includes(tool)
                  );
                  if (isDangerous) {
                    setPendingAlwaysAllow(true);
                  } else {
                    respondToPermission(permission.toolUseId, 'allow_always');
                  }
                }}
                className="w-full mt-1 btn btn-ghost text-sm"
              >
                {t('permission.alwaysAllow')}
              </button>
            ) : (
              <div className="mt-2 p-3 bg-warning/10 border border-warning/20 rounded-xl">
                <p className="text-sm text-warning mb-2">
                  {`Are you sure you want to always allow "${permission.toolName}"? This tool can modify your system.`}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPendingAlwaysAllow(false)}
                    className="flex-1 btn btn-secondary text-sm"
                  >
                    {t('permission.deny')}
                  </button>
                  <button
                    onClick={() => {
                      setPendingAlwaysAllow(false);
                      respondToPermission(permission.toolUseId, 'allow_always');
                    }}
                    className="flex-1 btn btn-primary text-sm"
                  >
                    {t('permission.alwaysAllow')}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
