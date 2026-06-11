/**
 * Shared types for skill conflict resolution and workspace profiles.
 *
 * Used by:
 * - config-store (persistence)
 * - skill-conflict-detector (resolution logic)
 * - skills-workspace-profile (workspace-level skill state)
 * - agent-runner (filtering)
 * - renderer (UI display)
 * - preload (IPC bridge)
 */
import { isValidSkillId } from './skill-pinning-constants';

// ---------------------------------------------------------------------------
// Skill Source & Conflict Resolution
// ---------------------------------------------------------------------------

/** Where a skill was loaded from (priority: project > configured > user > plugin > builtin). */
export type SkillSource = 'builtin' | 'user' | 'project' | 'configured' | 'plugin';

/** Global policy for resolving name collisions between custom and built-in skills. */
export type ConflictPolicy = 'custom-wins' | 'builtin-wins' | 'ask';

/** Represents a detected conflict: same skill name exists in multiple sources. */
export interface SkillConflict {
  /** Skill directory name (the conflicting identifier). */
  skillName: string;
  /** All sources where this skill name was found. */
  sources: Array<{ source: SkillSource; path: string }>;
  /** Which source is currently active (winning). */
  activeSource: SkillSource;
  /** Whether the user has acknowledged this conflict (for 'ask' policy). */
  acknowledged: boolean;
}

/** Persisted config for skill conflict resolution (stored in electron-store). */
export interface SkillConflictConfig {
  /** Global policy when custom and built-in share a name. */
  conflictPolicy: ConflictPolicy;

  /** Skills explicitly disabled by the user (skill directory names). */
  disabledSkills: string[];

  /** Per-skill source override (skill name → preferred source). */
  sourceOverrides: Record<string, SkillSource>;

  /** Conflicts that have been acknowledged (won't re-notify). */
  acknowledgedConflicts: string[];
}

/** Default config applied on first install or missing config (frozen, immutable). */
export const DEFAULT_SKILL_CONFLICT_CONFIG: Readonly<SkillConflictConfig> = Object.freeze({
  conflictPolicy: 'custom-wins' as const,
  disabledSkills: Object.freeze([] as string[]) as unknown as string[],
  sourceOverrides: Object.freeze({} as Record<string, SkillSource>) as unknown as Record<
    string,
    SkillSource
  >,
  acknowledgedConflicts: Object.freeze([] as string[]) as unknown as string[],
});

/** Create a fresh mutable copy of the default config (avoids shared reference mutation). */
export function createDefaultSkillConflictConfig(): SkillConflictConfig {
  return {
    conflictPolicy: 'custom-wins',
    disabledSkills: [],
    sourceOverrides: {},
    acknowledgedConflicts: [],
  };
}

// ---------------------------------------------------------------------------
// Workspace Skill Profiles
// ---------------------------------------------------------------------------

/**
 * Workspace-level skill profile stored at `<project>/.cowork/skills-profile.json`.
 * Controls which skills are pre-pinned and which are disabled for a workspace.
 */
export interface SkillsWorkspaceProfile {
  /** Skill IDs to pre-pin on session creation (injected as directives). */
  pinned?: string[];

  /** Skill IDs to exclude from the session (not loaded into agent). */
  disabled?: string[];
}

// ---------------------------------------------------------------------------
// Validation helpers (re-exported for convenience)
// ---------------------------------------------------------------------------

/** Validate conflict policy value. */
export function isValidConflictPolicy(value: unknown): value is ConflictPolicy {
  return value === 'custom-wins' || value === 'builtin-wins' || value === 'ask';
}

/** Validate skill source value. */
export function isValidSkillSource(value: unknown): value is SkillSource {
  return (
    value === 'builtin' ||
    value === 'user' ||
    value === 'project' ||
    value === 'configured' ||
    value === 'plugin'
  );
}

/**
 * Normalize a raw skill conflict config from storage.
 * Returns a valid SkillConflictConfig, filling in defaults for missing/invalid fields.
 * Validates skill IDs, deduplicates arrays, and enforces size limits.
 */
export function normalizeSkillConflictConfig(raw: unknown): SkillConflictConfig {
  if (!raw || typeof raw !== 'object') {
    return createDefaultSkillConflictConfig();
  }

  const obj = raw as Record<string, unknown>;
  const MAX_ENTRIES = 200;

  // Filter, validate, dedup, and cap disabledSkills
  const rawDisabled = Array.isArray(obj.disabledSkills)
    ? [
        ...new Set(
          obj.disabledSkills.filter(
            (item): item is string => typeof item === 'string' && isValidSkillId(item)
          )
        ),
      ].slice(0, MAX_ENTRIES)
    : [];

  // Filter, validate, dedup, and cap acknowledgedConflicts
  const rawAcknowledged = Array.isArray(obj.acknowledgedConflicts)
    ? [
        ...new Set(
          obj.acknowledgedConflicts.filter(
            (item): item is string => typeof item === 'string' && isValidSkillId(item)
          )
        ),
      ].slice(0, MAX_ENTRIES)
    : [];

  // Filter and validate sourceOverrides (keys must be valid skill IDs, values valid sources)
  let sourceOverrides: Record<string, SkillSource> = {};
  if (obj.sourceOverrides && typeof obj.sourceOverrides === 'object') {
    const entries = Object.entries(obj.sourceOverrides as Record<string, unknown>)
      .filter(([key, v]) => isValidSkillId(key) && isValidSkillSource(v))
      .slice(0, MAX_ENTRIES);
    sourceOverrides = Object.fromEntries(entries) as Record<string, SkillSource>;
  }

  return {
    conflictPolicy: isValidConflictPolicy(obj.conflictPolicy) ? obj.conflictPolicy : 'custom-wins',
    disabledSkills: rawDisabled,
    sourceOverrides,
    acknowledgedConflicts: rawAcknowledged,
  };
}
