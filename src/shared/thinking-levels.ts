/**
 * Canonical ordered list of thinking levels, shared by main and renderer.
 * Single source of truth for config-store validation, agent-runner clamping,
 * the Settings selector, and the ModelThinkingLevel union in renderer/types.
 *
 * Mirrors EXTENDED_THINKING_LEVELS in `@earendil-works/pi-ai/dist/models.js`;
 * order is load-bearing for the clamp below.
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type SharedModelThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Clamp a level to the nearest supported one, mirroring pi-ai's
 * `clampThinkingLevel` search order **exactly**: upward first, then downward.
 *
 * The renderer cannot import pi-ai (main-process-only dependency), so this
 * reimplements the search over an already-resolved level list. It must stay
 * byte-for-byte equivalent to pi's algorithm — if the two disagree, Settings
 * shows one level while the agent runs at another.
 *
 * Verified against `@earendil-works/pi-ai/dist/models.js:404-422` (0.80.10).
 */
export function clampToSupportedLevel(
  supported: readonly SharedModelThinkingLevel[],
  level: SharedModelThinkingLevel
): SharedModelThinkingLevel {
  if (supported.includes(level)) return level;

  const requestedIndex = THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return supported[0] ?? 'off';

  // Upward first — matches pi. Reversing these two loops silently desyncs
  // the UI from the runtime whenever a supported level exists on both sides.
  for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
    if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  return supported[0] ?? 'off';
}
