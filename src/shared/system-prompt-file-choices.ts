/**
 * @module shared/system-prompt-file-choices
 *
 * Single source of truth for workspace-instructions file discovery.
 * Imported from both the Electron main process (`workspace-system-prompt`
 * loader, config-store normalizer, `settings.update` IPC handler) and the
 * renderer (`SettingsGeneral` UI, `Settings` type).
 *
 * Keeping the whitelist in `shared/` guarantees the UI can't offer values the
 * backend rejects, and the backend can't accept values the UI can't produce.
 *
 * Migration note: `SYSTEM_PROMPT_FILE_CHOICES` and `isValidSystemPromptFileChoice`
 * are kept for backward-compatibility (config-store migration path, existing
 * callers). They will be removed after the migration window closes.
 */

// ---------------------------------------------------------------------------
// Legacy single-choice API (kept for migration; will be removed)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Priority-list API (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Non-empty candidate filenames, in the default discovery priority order (D4).
 * Only the order is user-configurable; this set is fixed.
 */
export const DEFAULT_SYSTEM_PROMPT_PRIORITY = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cowork/instructions.md',
  'memory.md',
  'instructions.md',
] as const;

export type SystemPromptFileName = (typeof DEFAULT_SYSTEM_PROMPT_PRIORITY)[number];

const ALLOWED_FILENAMES = new Set<string>(DEFAULT_SYSTEM_PROMPT_PRIORITY);

/**
 * Returns true when `v` is a non-empty array of unique, whitelisted filenames.
 * Subsets are valid for UI input (e.g. a user re-ordering a partial list),
 * but note that the **persisted form is always a full permutation** —
 * `normalizeSystemPromptPriority` expands any subset to include all candidates.
 * Use this validator for incoming/untrusted data; use `normalizeSystemPromptPriority`
 * before persisting to guarantee the full-permutation invariant.
 */
export function isValidSystemPromptPriority(v: unknown): v is SystemPromptFileName[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string' || !ALLOWED_FILENAMES.has(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

/**
 * Normalise any stored/incoming priority list:
 * 1. Drop entries that are not whitelisted or are duplicates.
 * 2. Append any whitelist members the user hasn't explicitly ordered yet,
 *    preserving their relative default order at the bottom.
 *
 * The result is always a full permutation of `DEFAULT_SYSTEM_PROMPT_PRIORITY`,
 * so a corrupted or partial config can never silently drop a candidate.
 */
export function normalizeSystemPromptPriority(v: unknown): SystemPromptFileName[] {
  const seen = new Set<string>();
  const out: SystemPromptFileName[] = [];

  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string' && ALLOWED_FILENAMES.has(item) && !seen.has(item)) {
        seen.add(item);
        out.push(item as SystemPromptFileName);
      }
    }
  }

  // Backfill any whitelist members not yet in the user's list.
  for (const candidate of DEFAULT_SYSTEM_PROMPT_PRIORITY) {
    if (!seen.has(candidate)) {
      out.push(candidate);
    }
  }

  return out;
}
