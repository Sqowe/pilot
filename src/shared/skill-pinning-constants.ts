/**
 * Shared constants for skill pinning validation.
 * Used by session-manager (write-time validation) and agent-runner (read-time sanitization).
 */

/** Maximum number of skills that can be pinned per session. */
export const MAX_PINNED_SKILLS_PER_SESSION = 10;

/** Maximum character length for a single skill ID. */
export const MAX_SKILL_ID_LENGTH = 128;

/** Regex for valid skill IDs — only safe characters allowed. */
export const SAFE_SKILL_ID_REGEX = /^[a-zA-Z0-9._-]+$/;

/** Validate a skill ID for format safety. */
export function isValidSkillId(skillId: unknown): skillId is string {
  return (
    typeof skillId === 'string' &&
    skillId.length > 0 &&
    skillId.length <= MAX_SKILL_ID_LENGTH &&
    SAFE_SKILL_ID_REGEX.test(skillId)
  );
}
