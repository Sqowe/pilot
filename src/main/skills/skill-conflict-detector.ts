/**
 * @module main/skills/skill-conflict-detector
 *
 * Detects and resolves name conflicts between skill sources.
 * A conflict exists when the same skill directory name appears in multiple sources
 * (built-in, user's ~/.claude/skills, configured global path, or project-level).
 *
 * Resolution priority (when "custom-wins"):
 *   project > configured > user > builtin
 *
 * Dependencies: config-store (skillConflictConfig), skill-pinning-constants
 */
import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../utils/logger';
import { isValidSkillId } from '../../shared/skill-pinning-constants';
import type {
  SkillConflictConfig,
  SkillSource,
  SkillConflict,
  ConflictPolicy,
} from '../../shared/skill-conflict-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single skill source entry discovered during scanning. */
export interface SkillSourceEntry {
  source: SkillSource;
  path: string;
}

/** Map of skill name → all sources where it exists. */
export type SkillSourceMap = Map<string, SkillSourceEntry[]>;

/** Result of resolving a single skill's conflict. */
export interface SkillResolution {
  skillName: string;
  winner: SkillSourceEntry;
  /** The policy that determined the winner: global policy, explicit override, or fallback. */
  policy: ConflictPolicy | 'override';
  hasConflict: boolean;
  allSources: SkillSourceEntry[];
}

// ---------------------------------------------------------------------------
// Source priority (higher index = higher priority when "custom-wins")
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY: Record<SkillSource, number> = {
  builtin: 0,
  user: 1,
  configured: 2,
  project: 3,
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan a directory and return all valid skill subdirectory names.
 * Returns an array of { name, fullPath } for each directory containing SKILL.md.
 */
function scanSkillDir(dirPath: string): Array<{ name: string; fullPath: string }> {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const results: Array<{ name: string; fullPath: string }> = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isValidSkillId(entry.name)) continue;
      const skillPath = path.join(dirPath, entry.name);
      // Only count it as a skill if SKILL.md exists
      const skillMd = path.join(skillPath, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        results.push({ name: entry.name, fullPath: skillPath });
      }
    }
  } catch (err) {
    logWarn('[SkillConflictDetector] Error scanning directory:', dirPath, err);
  }
  return results;
}

/**
 * Discover all skill sources from the known directories.
 *
 * @param builtinDir - App-bundled skills (resources/skills, see builtin-skills-path)
 * @param userDir - User's ~/.claude/skills
 * @param configuredDir - User-configured global skills path
 * @param projectDir - Project-level skills (e.g., <cwd>/.skills)
 */
export function discoverAllSkillSources(
  builtinDir: string,
  userDir: string,
  configuredDir?: string,
  projectDir?: string
): SkillSourceMap {
  const sourceMap: SkillSourceMap = new Map();

  const addEntries = (dir: string, source: SkillSource) => {
    for (const { name, fullPath } of scanSkillDir(dir)) {
      if (!sourceMap.has(name)) {
        sourceMap.set(name, []);
      }
      sourceMap.get(name)!.push({ source, path: fullPath });
    }
  };

  addEntries(builtinDir, 'builtin');
  addEntries(userDir, 'user');
  if (configuredDir && configuredDir !== userDir) {
    addEntries(configuredDir, 'configured');
  }
  if (projectDir) {
    addEntries(projectDir, 'project');
  }

  return sourceMap;
}

// ---------------------------------------------------------------------------
// Conflict Detection
// ---------------------------------------------------------------------------

/**
 * Detect conflicts from a source map. A conflict exists when a skill name
 * appears in more than one source. Disabled skills are excluded.
 * Non-builtin conflicts (user vs configured) under 'ask' policy are also excluded
 * since the runtime resolves them deterministically without user input.
 */
export function detectConflicts(
  sourceMap: SkillSourceMap,
  config: SkillConflictConfig
): SkillConflict[] {
  const conflicts: SkillConflict[] = [];

  for (const [skillName, sources] of sourceMap) {
    if (sources.length <= 1) continue;
    // Skip disabled skills — they shouldn't show conflict notifications
    if (config.disabledSkills.includes(skillName)) continue;

    // For 'ask' policy: only report conflicts involving built-in sources,
    // since user-vs-configured conflicts are resolved deterministically by priority
    if (config.conflictPolicy === 'ask') {
      const hasBuiltin = sources.some((s) => s.source === 'builtin');
      if (!hasBuiltin) continue;
    }

    const resolution = resolveConflict(skillName, sources, config);
    conflicts.push({
      skillName,
      sources,
      activeSource: resolution.winner.source,
      acknowledged: config.acknowledgedConflicts.includes(skillName),
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Conflict Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which source wins for a given skill.
 *
 * IMPORTANT: Callers must pre-filter disabled skills before calling this function.
 * Disabled skill handling is not performed here to keep the function focused on
 * multi-source conflict resolution.
 *
 * Resolution order:
 * 1. Per-skill sourceOverride → use that source
 * 2. Global conflictPolicy:
 *    - custom-wins: highest priority non-builtin source wins
 *    - builtin-wins: builtin wins if present
 *    - ask + not acknowledged: builtin wins (pending user decision)
 *    - ask + acknowledged: use source from acknowledgedConflicts (stored as override)
 */
export function resolveConflict(
  skillName: string,
  sources: SkillSourceEntry[],
  config: SkillConflictConfig
): SkillResolution {
  // Check per-skill source override first (highest precedence)
  const override = config.sourceOverrides[skillName];
  if (override) {
    const overrideEntry = sources.find((s) => s.source === override);
    if (overrideEntry) {
      return {
        skillName,
        winner: overrideEntry,
        policy: 'override',
        hasConflict: sources.length > 1,
        allSources: sources,
      };
    }
    // Override points to a source that no longer exists — fall through to policy
  }

  // Single source → no conflict to resolve
  if (sources.length === 1) {
    return {
      skillName,
      winner: sources[0],
      policy: config.conflictPolicy,
      hasConflict: false,
      allSources: sources,
    };
  }

  // Apply global policy
  switch (config.conflictPolicy) {
    case 'custom-wins': {
      // Pick the highest-priority source (project > configured > user > builtin)
      const sorted = [...sources].sort(
        (a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]
      );
      return {
        skillName,
        winner: sorted[0],
        policy: 'custom-wins',
        hasConflict: true,
        allSources: sources,
      };
    }

    case 'builtin-wins': {
      // Prefer built-in if it exists, otherwise fall back to lowest-priority custom
      const builtin = sources.find((s) => s.source === 'builtin');
      if (builtin) {
        return {
          skillName,
          winner: builtin,
          policy: 'builtin-wins',
          hasConflict: true,
          allSources: sources,
        };
      }
      // No built-in in this conflict — pick highest priority custom source
      const sorted = [...sources].sort(
        (a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]
      );
      return {
        skillName,
        winner: sorted[0],
        policy: 'builtin-wins',
        hasConflict: true,
        allSources: sources,
      };
    }

    case 'ask': {
      // If user hasn't acknowledged this conflict yet:
      // - Builtin conflicts: default to builtin (pending user decision)
      // - Non-builtin conflicts (user vs configured): use priority (configured > user)
      //   since these don't require user intervention (matches runtime sync behavior)
      if (!config.acknowledgedConflicts.includes(skillName)) {
        const builtin = sources.find((s) => s.source === 'builtin');
        if (builtin) {
          return {
            skillName,
            winner: builtin,
            policy: 'ask',
            hasConflict: true,
            allSources: sources,
          };
        }
        // No built-in — use priority-based resolution (same as custom-wins)
        const sorted = [...sources].sort(
          (a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]
        );
        return {
          skillName,
          winner: sorted[0],
          policy: 'ask',
          hasConflict: true,
          allSources: sources,
        };
      }
      // Acknowledged: the sourceOverride should have been set via acknowledgeConflict.
      // If somehow missing, fall through to custom-wins behavior.
      const sorted = [...sources].sort(
        (a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]
      );
      return {
        skillName,
        winner: sorted[0],
        policy: 'ask',
        hasConflict: true,
        allSources: sources,
      };
    }

    default: {
      // Unknown policy — safe fallback to builtin
      const builtin = sources.find((s) => s.source === 'builtin');
      return {
        skillName,
        winner: builtin || sources[0],
        policy: config.conflictPolicy,
        hasConflict: sources.length > 1,
        allSources: sources,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Sync Helper: Resolve all skills and determine what to sync to runtime dir
// ---------------------------------------------------------------------------

/** Describes the action to take for a single skill in the runtime directory. */
export interface SyncAction {
  skillName: string;
  action: 'symlink' | 'skip' | 'remove-builtin-and-symlink';
  sourcePath: string;
  reason: string;
}

/**
 * Given the full source map and config, determine the sync actions needed.
 * This replaces the ad-hoc logic in syncUserSkillsToAppDir.
 *
 * @returns Array of actions to perform to bring the runtime dir in sync.
 */
export function computeSyncActions(
  sourceMap: SkillSourceMap,
  config: SkillConflictConfig,
  runtimeDir: string
): SyncAction[] {
  const actions: SyncAction[] = [];

  for (const [skillName, sources] of sourceMap) {
    // Skip disabled skills
    if (config.disabledSkills.includes(skillName)) {
      actions.push({
        skillName,
        action: 'skip',
        sourcePath: '',
        reason: 'disabled by user',
      });
      continue;
    }

    // For single-source skills, only non-builtins need action
    // (builtins are already synced by the hash-based flow)
    if (sources.length === 1) {
      const entry = sources[0];
      if (entry.source === 'builtin') {
        // Already handled by the built-in sync loop
        continue;
      }
      // Non-builtin single source needs to be linked
      const targetPath = path.join(runtimeDir, skillName);
      const targetExists = fs.existsSync(targetPath);
      if (targetExists) {
        try {
          const stat = fs.lstatSync(targetPath);
          if (!stat.isSymbolicLink()) {
            // Built-in directory occupies this slot — need to remove it
            actions.push({
              skillName,
              action: 'remove-builtin-and-symlink',
              sourcePath: entry.path,
              reason: `non-builtin source wins (no conflict, source: ${entry.source})`,
            });
            continue;
          }
        } catch {
          // Can't stat — skip
          continue;
        }
      }
      actions.push({
        skillName,
        action: 'symlink',
        sourcePath: entry.path,
        reason: `single source: ${entry.source}`,
      });
      continue;
    }

    // Multi-source: resolve the conflict
    const resolution = resolveConflict(skillName, sources, config);
    const winner = resolution.winner;

    if (winner.source === 'builtin') {
      // Built-in wins — no action needed (already synced by hash flow)
      continue;
    }

    // A non-builtin source won — need to ensure it's in runtime dir
    const targetPath = path.join(runtimeDir, skillName);
    const targetExists = fs.existsSync(targetPath);
    if (targetExists) {
      try {
        const stat = fs.lstatSync(targetPath);
        if (!stat.isSymbolicLink()) {
          // Built-in occupies slot, need to replace
          actions.push({
            skillName,
            action: 'remove-builtin-and-symlink',
            sourcePath: winner.path,
            reason: `conflict resolved: ${winner.source} wins (policy: ${resolution.policy})`,
          });
          continue;
        }
      } catch {
        continue;
      }
    }

    actions.push({
      skillName,
      action: 'symlink',
      sourcePath: winner.path,
      reason: `conflict resolved: ${winner.source} wins (policy: ${resolution.policy})`,
    });
  }

  return actions;
}

/**
 * Detect new (unacknowledged) conflicts that should be reported to the user.
 * Only returns conflicts that haven't been acknowledged yet.
 */
export function getNewConflicts(
  sourceMap: SkillSourceMap,
  config: SkillConflictConfig
): SkillConflict[] {
  const conflicts = detectConflicts(sourceMap, config);
  return conflicts.filter((c) => !c.acknowledged);
}
