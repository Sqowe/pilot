/**
 * @module shared/system-prompt-file-choices
 *
 * Single source of truth for the "Workspace instructions file" dropdown in
 * Settings → General. Imported from both the Electron main process
 * (`workspace-system-prompt` loader, config-store normalizer, `settings.update`
 * IPC handler) and the renderer (`SettingsGeneral` UI, `Settings` type).
 *
 * Keeping the whitelist in `shared/` guarantees the UI can't offer values the
 * backend rejects, and the backend can't accept values the UI can't produce.
 */

export const SYSTEM_PROMPT_FILE_CHOICES = [
  '',
  'CLAUDE.md',
  'AGENTS.md',
  '.cowork/instructions.md',
  'memory.md',
  'instructions.md',
] as const;

export type SystemPromptFileChoice = (typeof SYSTEM_PROMPT_FILE_CHOICES)[number];

export function isValidSystemPromptFileChoice(value: unknown): value is SystemPromptFileChoice {
  return (
    typeof value === 'string' && (SYSTEM_PROMPT_FILE_CHOICES as readonly string[]).includes(value)
  );
}
