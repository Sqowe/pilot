import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import {
  SYSTEM_PROMPT_FILE_CHOICES,
  type SystemPromptFileChoice,
} from '../../../shared/system-prompt-file-choices';

/**
 * Settings panel for system prompt configuration.
 *
 * Controls how the AI assistant's system prompt is assembled:
 * - Workspace instructions file selection (per-project instructions appended to the prompt)
 */
export function SettingsPrompt() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const systemPromptFile: SystemPromptFileChoice = settings.systemPromptFile ?? '';
  const onSystemPromptFileChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as SystemPromptFileChoice;
    if ((SYSTEM_PROMPT_FILE_CHOICES as readonly string[]).includes(next)) {
      updateSettings({ systemPromptFile: next });
    }
  };

  return (
    <div className="space-y-6">
      {/* Workspace instructions file */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-text-primary">
          {t('prompt.workspaceInstructionsTitle', 'Workspace instructions file')}
        </h4>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            'prompt.workspaceInstructionsDesc',
            'When this file exists at the session working directory, its contents are appended to the system prompt as project-level instructions. Missing file falls back to the default.'
          )}
        </p>
        <select
          value={systemPromptFile}
          onChange={onSystemPromptFileChange}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          aria-label={t('prompt.workspaceInstructionsTitle', 'Workspace instructions file')}
        >
          {SYSTEM_PROMPT_FILE_CHOICES.map((opt) => (
            <option key={opt || 'none'} value={opt}>
              {opt === '' ? t('prompt.workspaceInstructionsNone', 'None (use default)') : opt}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
