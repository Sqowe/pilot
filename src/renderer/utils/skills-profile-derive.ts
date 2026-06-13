/**
 * Pure utility to derive "dirty" state for skills workspace profiles.
 *
 * Compares the current session state (pinned + disabled sets) against
 * the loaded workspace profile to determine whether the 💾 save button
 * should be visible (i.e., session differs from persisted profile).
 */

import type { SkillsWorkspaceProfile } from '../../shared/skill-conflict-types';

/**
 * Determine whether the current session skill state differs from
 * the workspace profile on disk.
 *
 * Normalizes pinned by excluding disabled IDs (Pin + Remove = invalid),
 * matching the normalization applied before saving.
 *
 * @param sessionPinned - Currently pinned skill IDs in the session
 * @param sessionDisabled - Currently disabled skill IDs in the session
 * @param profile - The loaded workspace profile (null = no profile on disk)
 * @returns true if session state differs from workspace profile (save button should show)
 */
export function isSkillsProfileDirty(
  sessionPinned: Set<string>,
  sessionDisabled: Set<string>,
  profile: SkillsWorkspaceProfile | null
): boolean {
  const profilePinned = new Set(profile?.pinned ?? []);
  const profileDisabled = new Set(profile?.disabled ?? []);

  // Normalize: exclude disabled from pinned (Pin + Remove = invalid invariant)
  const effectivePinned = new Set(
    Array.from(sessionPinned).filter((id) => !sessionDisabled.has(id))
  );

  // Compare pinned sets
  if (!setsEqual(effectivePinned, profilePinned)) {
    return true;
  }

  // Compare disabled sets
  if (!setsEqual(sessionDisabled, profileDisabled)) {
    return true;
  }

  return false;
}

/**
 * Check if two sets contain exactly the same elements.
 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
