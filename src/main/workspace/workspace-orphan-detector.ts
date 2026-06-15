/**
 * @module main/workspace/workspace-orphan-detector
 *
 * Detects orphaned entries in workspace .cowork config files.
 *
 * When a user removes/uninstalls a skill or deletes an MCP server from the app,
 * references may persist in workspace profile files (.cowork/skills-profile.json,
 * .cowork/mcp-servers.json). This module detects those orphans and provides
 * cleanup capabilities.
 *
 * Detection runs once per workspace activation (CWD change or session start),
 * not on every message. It piggybacks on already-loaded data (skills, MCP configs,
 * workspace profiles) so there is no additional disk I/O.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log, logWarn } from '../utils/logger';
import { loadSkillsWorkspaceProfile } from '../skills/skills-workspace-profile';
import { loadWorkspaceMcpProfile } from '../mcp/mcp-workspace-profile';
import type {
  OrphanDetectionResult,
  WorkspaceOrphanDismissal,
} from '../../shared/workspace-orphan-types';

const COWORK_DIR = '.cowork';
const SKILLS_PROFILE_FILENAME = 'skills-profile.json';
const MCP_PROFILE_FILENAME = 'mcp-servers.json';

/** Maximum stored dismissals to prevent unbounded growth */
const MAX_DISMISSALS = 50;

// ---------------------------------------------------------------------------
// Dismissal persistence (in-memory cache, backed by configStore)
// ---------------------------------------------------------------------------

let dismissals: WorkspaceOrphanDismissal[] = [];

/**
 * Initialize dismissals from config store data.
 * Called once at app startup. Applies the same validation as the config-store normalizer.
 * Replaces in-memory state entirely (defensive against corrupt input).
 */
export function initDismissals(stored: WorkspaceOrphanDismissal[]): void {
  // Always reset to empty first — don't keep stale state on invalid input
  dismissals = [];
  if (!Array.isArray(stored)) return;

  const validated: WorkspaceOrphanDismissal[] = [];
  for (const d of stored) {
    if (!d || typeof d !== 'object') continue;
    if (typeof d.cwd !== 'string' || d.cwd.length === 0) continue;
    if (typeof d.dismissedAt !== 'number' || !Number.isFinite(d.dismissedAt)) continue;
    if (
      d.skillsProfileMtimeMs !== null &&
      (typeof d.skillsProfileMtimeMs !== 'number' || !Number.isFinite(d.skillsProfileMtimeMs))
    )
      continue;
    if (
      d.mcpProfileMtimeMs !== null &&
      (typeof d.mcpProfileMtimeMs !== 'number' || !Number.isFinite(d.mcpProfileMtimeMs))
    )
      continue;

    validated.push(d);
    if (validated.length >= MAX_DISMISSALS) break;
  }
  dismissals = validated;
}

/**
 * Get all current dismissals (for persistence to config store).
 * Returns a shallow copy to protect internal state from external mutation.
 */
export function getDismissals(): WorkspaceOrphanDismissal[] {
  return dismissals.map((d) => ({ ...d }));
}

/**
 * Record a dismissal for a workspace.
 * Captures current profile file mtimes so we can re-trigger if files change.
 */
export function recordDismissal(cwd: string): WorkspaceOrphanDismissal {
  const canonicalCwd = safeCanonicalPath(cwd);

  // Get current mtimes for both profile files
  const skillsMtime = getFileMtimeMs(path.join(canonicalCwd, COWORK_DIR, SKILLS_PROFILE_FILENAME));
  const mcpMtime = getFileMtimeMs(path.join(canonicalCwd, COWORK_DIR, MCP_PROFILE_FILENAME));

  const dismissal: WorkspaceOrphanDismissal = {
    cwd: canonicalCwd,
    dismissedAt: Date.now(),
    skillsProfileMtimeMs: skillsMtime,
    mcpProfileMtimeMs: mcpMtime,
  };

  // Replace existing dismissal for this workspace or add new one
  const existingIdx = dismissals.findIndex((d) => d.cwd === canonicalCwd);
  if (existingIdx >= 0) {
    dismissals[existingIdx] = dismissal;
  } else {
    dismissals.push(dismissal);
    // Cap stored dismissals
    if (dismissals.length > MAX_DISMISSALS) {
      // Remove oldest
      dismissals.sort((a, b) => a.dismissedAt - b.dismissedAt);
      dismissals = dismissals.slice(-MAX_DISMISSALS);
    }
  }

  return dismissal;
}

/**
 * Check if a previous dismissal should be honored (files haven't changed).
 * Returns true if detection should be skipped.
 *
 * Uses strict mtime equality: if the file's mtime differs from what was recorded
 * at dismissal time (in either direction), the dismissal is invalidated.
 */
export function isDismissed(cwd: string): boolean {
  const canonicalCwd = safeCanonicalPath(cwd);
  const dismissal = dismissals.find((d) => d.cwd === canonicalCwd);
  if (!dismissal) return false;

  // Re-trigger if either profile file has been modified since dismissal
  const currentSkillsMtime = getFileMtimeMs(
    path.join(canonicalCwd, COWORK_DIR, SKILLS_PROFILE_FILENAME)
  );
  const currentMcpMtime = getFileMtimeMs(path.join(canonicalCwd, COWORK_DIR, MCP_PROFILE_FILENAME));

  // If file was created since dismissal (was null, now has mtime)
  if (dismissal.skillsProfileMtimeMs === null && currentSkillsMtime !== null) return false;
  if (dismissal.mcpProfileMtimeMs === null && currentMcpMtime !== null) return false;

  // If file was deleted since dismissal (had mtime, now null)
  if (dismissal.skillsProfileMtimeMs !== null && currentSkillsMtime === null) return false;
  if (dismissal.mcpProfileMtimeMs !== null && currentMcpMtime === null) return false;

  // If file mtime differs from recorded (strict equality — catches checkouts, restores, etc.)
  if (
    currentSkillsMtime !== null &&
    dismissal.skillsProfileMtimeMs !== null &&
    currentSkillsMtime !== dismissal.skillsProfileMtimeMs
  ) {
    return false;
  }
  if (
    currentMcpMtime !== null &&
    dismissal.mcpProfileMtimeMs !== null &&
    currentMcpMtime !== dismissal.mcpProfileMtimeMs
  ) {
    return false;
  }

  // Files haven't changed — honor the dismissal
  return true;
}

/**
 * Clear dismissal for a workspace (e.g., after successful cleanup).
 */
export function clearDismissal(cwd: string): void {
  const canonicalCwd = safeCanonicalPath(cwd);
  dismissals = dismissals.filter((d) => d.cwd !== canonicalCwd);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect orphaned entries in workspace config files.
 *
 * Compares entries in .cowork/skills-profile.json and .cowork/mcp-servers.json
 * against the currently installed skills and configured MCP servers.
 *
 * @param cwd - Workspace root directory
 * @param installedSkillIds - Set of all currently known skill IDs (from skillsManager.getAllSkills())
 * @param configuredServerNames - Set of all configured MCP server names (from mcpConfigStore.getServers())
 * @returns Detection result, or null if no orphans found or detection should be skipped
 */
export function detectWorkspaceOrphans(
  cwd: string,
  installedSkillIds: Set<string>,
  configuredServerNames: Set<string>
): OrphanDetectionResult | null {
  if (!cwd) return null;

  // Check dismissal state
  if (isDismissed(cwd)) {
    log('[OrphanDetector] Skipping detection for dismissed workspace:', cwd);
    return null;
  }

  // Load workspace profiles (already mtime-cached, no extra disk I/O)
  const skillsProfile = loadSkillsWorkspaceProfile(cwd);
  const mcpProfile = loadWorkspaceMcpProfile(cwd);

  // No workspace configs → nothing to check
  if (!skillsProfile && !mcpProfile) return null;

  // Compute orphaned skills
  const orphanedSkills = {
    inPinned: (skillsProfile?.pinned || []).filter((id) => !installedSkillIds.has(id)),
    inDisabled: (skillsProfile?.disabled || []).filter((id) => !installedSkillIds.has(id)),
  };

  // Compute orphaned MCP servers
  const orphanedMcpServers = {
    inDisabled: (mcpProfile?.disabled || []).filter((name) => !configuredServerNames.has(name)),
    inEnabled: (mcpProfile?.enabled || []).filter((name) => !configuredServerNames.has(name)),
  };

  const totalOrphans =
    orphanedSkills.inPinned.length +
    orphanedSkills.inDisabled.length +
    orphanedMcpServers.inDisabled.length +
    orphanedMcpServers.inEnabled.length;

  if (totalOrphans === 0) return null;

  log(
    `[OrphanDetector] Found ${totalOrphans} orphaned entries in workspace:`,
    cwd,
    `(skills: ${orphanedSkills.inPinned.length + orphanedSkills.inDisabled.length},`,
    `mcp: ${orphanedMcpServers.inDisabled.length + orphanedMcpServers.inEnabled.length})`
  );

  return {
    orphanedSkills,
    orphanedMcpServers,
    totalOrphans,
    cwd,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove orphaned entries from workspace profile files.
 *
 * Only removes entries that are verified as orphaned (not in installed/configured sets).
 * Requested IDs that are NOT orphaned are silently ignored (defense against bad payloads).
 *
 * @param cwd - Workspace root directory
 * @param skillIds - Specific skill IDs to remove (empty array = don't touch skills)
 * @param mcpServerNames - Specific MCP server names to remove (empty array = don't touch MCP)
 * @param installedSkillIds - Current installed skills (used to verify orphan status)
 * @param configuredServerNames - Current MCP servers (used to verify orphan status)
 * @returns Cleanup result
 */
export async function cleanupOrphans(
  cwd: string,
  skillIds: string[],
  mcpServerNames: string[],
  installedSkillIds: Set<string>,
  configuredServerNames: Set<string>
): Promise<{ success: boolean; error?: string; removed: { skills: number; mcp: number } }> {
  let skillsRemoved = 0;
  let mcpRemoved = 0;

  try {
    // Clean skills profile (only if skillIds were explicitly provided)
    if (skillIds.length > 0) {
      const skillsProfile = loadSkillsWorkspaceProfile(cwd);
      if (skillsProfile) {
        // Only remove IDs that are actually orphaned (not in installed set)
        const verifiedOrphanSkills = new Set(skillIds.filter((id) => !installedSkillIds.has(id)));

        if (verifiedOrphanSkills.size > 0) {
          const updatedProfile = {
            pinned: (skillsProfile.pinned || []).filter((id) => !verifiedOrphanSkills.has(id)),
            disabled: (skillsProfile.disabled || []).filter((id) => !verifiedOrphanSkills.has(id)),
          };

          // Count actual removals
          const originalCount =
            (skillsProfile.pinned?.length || 0) + (skillsProfile.disabled?.length || 0);
          const updatedCount =
            (updatedProfile.pinned?.length || 0) + (updatedProfile.disabled?.length || 0);
          skillsRemoved = originalCount - updatedCount;

          // Only write if entries were actually removed
          if (skillsRemoved > 0) {
            await writeSkillsProfile(cwd, updatedProfile);
          }
        }
      }
    }

    // Clean MCP profile (only if mcpServerNames were explicitly provided)
    if (mcpServerNames.length > 0) {
      const mcpProfile = loadWorkspaceMcpProfile(cwd);
      if (mcpProfile) {
        // Only remove names that are actually orphaned (not in configured set)
        const verifiedOrphanMcp = new Set(
          mcpServerNames.filter((name) => !configuredServerNames.has(name))
        );

        if (verifiedOrphanMcp.size > 0) {
          const updatedProfile = {
            disabled: (mcpProfile.disabled || []).filter((name) => !verifiedOrphanMcp.has(name)),
            enabled: (mcpProfile.enabled || []).filter((name) => !verifiedOrphanMcp.has(name)),
          };

          // Count actual removals
          const originalCount =
            (mcpProfile.disabled?.length || 0) + (mcpProfile.enabled?.length || 0);
          const updatedCount =
            (updatedProfile.disabled?.length || 0) + (updatedProfile.enabled?.length || 0);
          mcpRemoved = originalCount - updatedCount;

          // Only write if entries were actually removed
          if (mcpRemoved > 0) {
            await writeMcpProfile(cwd, updatedProfile);
          }
        }
      }
    }

    // Clear any existing dismissal since we've resolved the issue
    if (skillsRemoved > 0 || mcpRemoved > 0) {
      clearDismissal(cwd);
    }

    log(
      `[OrphanDetector] Cleanup complete: removed ${skillsRemoved} skill(s), ${mcpRemoved} MCP server(s)`
    );

    return { success: true, removed: { skills: skillsRemoved, mcp: mcpRemoved } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn('[OrphanDetector] Cleanup failed:', err);
    return { success: false, error: message, removed: { skills: skillsRemoved, mcp: mcpRemoved } };
  }
}

// ---------------------------------------------------------------------------
// File write helpers (reuse existing save patterns with security checks)
// ---------------------------------------------------------------------------

async function writeSkillsProfile(
  cwd: string,
  profile: { pinned?: string[]; disabled?: string[] }
): Promise<void> {
  const coworkDir = path.join(cwd, COWORK_DIR);
  const profilePath = path.join(coworkDir, SKILLS_PROFILE_FILENAME);

  // If both arrays are empty, remove the file
  const isEmpty =
    (!profile.pinned || profile.pinned.length === 0) &&
    (!profile.disabled || profile.disabled.length === 0);

  // Security: validate .cowork directory (shared for both delete and write paths)
  if (fs.existsSync(coworkDir)) {
    const coworkStat = fs.lstatSync(coworkDir);
    if (coworkStat.isSymbolicLink() || !coworkStat.isDirectory()) {
      throw new Error('.cowork is not a real directory (rejected for security)');
    }
    // Verify realpath remains within workspace
    const realCoworkDir = fs.realpathSync(coworkDir);
    const realCwd = fs.realpathSync(cwd);
    const rel = path.relative(realCwd, realCoworkDir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('.cowork realpath escapes workspace boundary');
    }
  }

  // Security: validate profile file if it exists
  if (fs.existsSync(profilePath)) {
    const fileStat = fs.lstatSync(profilePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error('skills-profile.json is not a regular file (rejected for security)');
    }
  }

  if (isEmpty) {
    // Before deleting, check if the file has unknown fields worth preserving
    if (fs.existsSync(profilePath)) {
      try {
        const raw = await fs.promises.readFile(profilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          // Remove the managed fields to see if anything else remains
          const { pinned: _p, disabled: _d, ...rest } = obj;
          if (Object.keys(rest).length > 0) {
            // Unknown fields exist — write back without pinned/disabled but keep the rest
            await fs.promises.writeFile(profilePath, JSON.stringify(rest, null, 2) + '\n', 'utf-8');
            log(
              '[OrphanDetector] Stripped empty pinned/disabled but preserved metadata:',
              profilePath
            );
            const { invalidateSkillsWorkspaceProfileCache } =
              await import('../skills/skills-workspace-profile');
            invalidateSkillsWorkspaceProfileCache();
            return;
          }
        }
      } catch {
        // Can't read/parse — safe to delete
      }
      await fs.promises.unlink(profilePath);
      log('[OrphanDetector] Removed empty skills profile:', profilePath);
    }
  } else {
    // Preserve unknown fields from the existing profile to avoid data loss
    let existingData: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(profilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingData = parsed as Record<string, unknown>;
      }
    } catch {
      // File doesn't exist or can't be parsed — start fresh
    }

    const cleanProfile: Record<string, unknown> = { ...existingData };
    // Replace only the managed fields
    if (profile.pinned && profile.pinned.length > 0) {
      cleanProfile.pinned = profile.pinned;
    } else {
      delete cleanProfile.pinned;
    }
    if (profile.disabled && profile.disabled.length > 0) {
      cleanProfile.disabled = profile.disabled;
    } else {
      delete cleanProfile.disabled;
    }

    await fs.promises.mkdir(coworkDir, { recursive: true });

    // Re-verify .cowork after mkdir
    const coworkLstat = fs.lstatSync(coworkDir);
    if (coworkLstat.isSymbolicLink() || !coworkLstat.isDirectory()) {
      throw new Error('.cowork is not a real directory after creation');
    }
    const realCoworkDir = fs.realpathSync(coworkDir);
    const realCwd = fs.realpathSync(cwd);
    const rel = path.relative(realCwd, realCoworkDir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('.cowork realpath escapes workspace boundary');
    }

    // Atomic write
    const { randomUUID } = await import('crypto');
    const tmpPath = path.join(realCoworkDir, `.skills-profile.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(cleanProfile, null, 2) + '\n', 'utf-8');
      await fs.promises.rename(tmpPath, path.join(realCoworkDir, SKILLS_PROFILE_FILENAME));
    } catch (writeErr) {
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw writeErr;
    }
    log('[OrphanDetector] Updated skills profile:', profilePath);
  }

  // Invalidate cache
  const { invalidateSkillsWorkspaceProfileCache } =
    await import('../skills/skills-workspace-profile');
  invalidateSkillsWorkspaceProfileCache();
}

async function writeMcpProfile(
  cwd: string,
  profile: { disabled?: string[]; enabled?: string[] }
): Promise<void> {
  // Delegate to the existing save function which handles all security checks,
  // atomic writes, cache invalidation, and empty-profile deletion.
  const { saveWorkspaceMcpProfile } = await import('../mcp/mcp-workspace-profile');
  const result = await saveWorkspaceMcpProfile(cwd, profile);
  if (!result.success) {
    throw new Error(result.error || 'Failed to save MCP workspace profile');
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function getFileMtimeMs(filePath: string): number | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) return null;
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

function safeCanonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
