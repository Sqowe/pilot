/**
 * MCP Workspace Profile
 *
 * Loads per-workspace MCP server preferences from {cwd}/.cowork/mcp-servers.json.
 * Follows the same pattern as prompt-loader.ts workspace overrides.
 *
 * File format:
 * {
 *   "disabled": ["server-id-1", "server-id-2"],
 *   "enabled": ["server-id-3"]
 * }
 *
 * Resolution:
 * - Servers listed in "disabled" are excluded from the session
 * - Servers listed in "enabled" are explicitly included (overrides "disabled")
 * - Servers not mentioned follow the global config
 *
 * The file uses server IDs for stable references. Server names can change
 * but IDs are immutable.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { MCPServerConfig } from './mcp-manager';
import { log, logWarn } from '../utils/logger';

export interface McpWorkspaceProfile {
  /** Server IDs to disable in this workspace (overrides global enabled state) */
  disabled?: string[];
  /** Server IDs to explicitly enable in this workspace (overrides "disabled" list) */
  enabled?: string[];
}

const PROFILE_FILENAME = 'mcp-servers.json';
const COWORK_DIR = '.cowork';

// Per-path cache with bounded size (LRU-style eviction)
const MAX_CACHE_ENTRIES = 20;
interface CacheEntry {
  profile: McpWorkspaceProfile | null;
  mtimeMs: number;
}
const profileCache = new Map<string, CacheEntry>();

/**
 * Load the workspace MCP profile from {cwd}/.cowork/mcp-servers.json.
 * Returns null if the file doesn't exist or is invalid.
 * Uses per-path mtime-based caching to avoid repeated disk reads.
 */
export function loadWorkspaceMcpProfile(cwd?: string | null): McpWorkspaceProfile | null {
  if (!cwd) return null;

  const profilePath = path.join(cwd, COWORK_DIR, PROFILE_FILENAME);

  // Check mtime for cache invalidation
  try {
    const stat = fs.statSync(profilePath);
    const cached = profileCache.get(profilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.profile;
    }

    const raw = fs.readFileSync(profilePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      logWarn('[McpWorkspaceProfile] Invalid profile format:', profilePath);
      setCacheEntry(profilePath, null, stat.mtimeMs);
      return null;
    }

    const profile = parsed as McpWorkspaceProfile;

    // Validate arrays
    if (profile.disabled && !Array.isArray(profile.disabled)) {
      logWarn('[McpWorkspaceProfile] "disabled" must be an array:', profilePath);
      profile.disabled = [];
    }
    if (profile.enabled && !Array.isArray(profile.enabled)) {
      logWarn('[McpWorkspaceProfile] "enabled" must be an array:', profilePath);
      profile.enabled = [];
    }

    setCacheEntry(profilePath, profile, stat.mtimeMs);
    log('[McpWorkspaceProfile] Loaded profile:', profilePath);
    return profile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist — normal case, no warning needed
      setCacheEntry(profilePath, null, 0);
      return null;
    }
    logWarn('[McpWorkspaceProfile] Error reading profile:', err);
    return null;
  }
}

/** Store a cache entry, evicting oldest if at capacity. */
function setCacheEntry(
  profilePath: string,
  profile: McpWorkspaceProfile | null,
  mtimeMs: number
): void {
  if (profileCache.size >= MAX_CACHE_ENTRIES && !profileCache.has(profilePath)) {
    // Evict the first (oldest) entry
    const firstKey = profileCache.keys().next().value;
    if (firstKey) profileCache.delete(firstKey);
  }
  profileCache.set(profilePath, { profile, mtimeMs });
}

/**
 * Apply workspace profile overrides to a list of enabled servers.
 * Servers in the "disabled" list are removed unless also in "enabled".
 */
export function applyWorkspaceOverrides(
  servers: MCPServerConfig[],
  cwd?: string | null
): MCPServerConfig[] {
  const profile = loadWorkspaceMcpProfile(cwd);
  if (!profile) return servers;

  const disabledSet = new Set(profile.disabled || []);
  const enabledSet = new Set(profile.enabled || []);

  return servers.filter((server) => {
    // Explicit enable overrides disable
    if (enabledSet.has(server.id) || enabledSet.has(server.name)) {
      return true;
    }
    // Check if disabled by workspace profile
    if (disabledSet.has(server.id) || disabledSet.has(server.name)) {
      return false;
    }
    // Not mentioned — keep as-is
    return true;
  });
}

/**
 * Apply session-level overrides (ephemeral, in-memory only).
 * Filters out servers that the user has toggled off in the current session.
 */
export function applySessionOverrides(
  servers: MCPServerConfig[],
  sessionDisabledServerIds?: string[] | null
): MCPServerConfig[] {
  if (!sessionDisabledServerIds || sessionDisabledServerIds.length === 0) {
    return servers;
  }
  const disabledSet = new Set(sessionDisabledServerIds);
  return servers.filter((server) => !disabledSet.has(server.id));
}

// Per-workspace write lock to serialize concurrent read-modify-write operations.
// Keyed by resolved cwd path. Each entry is a promise chain — new saves queue behind it.
const writeLocks = new Map<string, Promise<unknown>>();

/**
 * Validate that a parsed value is a valid string array for profile fields.
 * Returns a clean array of non-empty strings, or an empty array if invalid.
 */
function validateStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/**
 * Save the current MCP session state as a workspace profile.
 * Merges with existing profile to preserve `enabled` entries when only `disabled` is updated.
 * Writes {cwd}/.cowork/mcp-servers.json with the disabled/enabled arrays.
 * Creates the .cowork directory if it doesn't exist.
 * If the resulting profile is empty (no disabled, no enabled), removes the file.
 *
 * Uses per-workspace write serialization to prevent lost updates from concurrent saves.
 * Uses async fs APIs to avoid blocking the Electron event loop.
 */
export async function saveWorkspaceMcpProfile(
  cwd: string,
  profile: McpWorkspaceProfile
): Promise<{ success: boolean; error?: string }> {
  if (!cwd) {
    return { success: false, error: 'No working directory specified' };
  }

  // Serialize writes per workspace to prevent read-modify-write races.
  const lockKey = path.resolve(cwd);
  const previousLock = writeLocks.get(lockKey) || Promise.resolve();
  const currentWrite = previousLock
    .then(() => doSave(cwd, profile))
    .catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logWarn('[McpWorkspaceProfile] Error saving profile:', err);
      return { success: false as const, error: errorMessage };
    });
  writeLocks.set(lockKey, currentWrite);

  // Clean up lock entry when queue drains (avoid unbounded map growth)
  currentWrite.finally(() => {
    if (writeLocks.get(lockKey) === currentWrite) {
      writeLocks.delete(lockKey);
    }
  });

  return currentWrite;
}

/** Maximum entries per field to prevent abuse from non-IPC callers. */
const MAX_PROFILE_ENTRIES = 100;
const MAX_PROFILE_ID_LENGTH = 256;

/**
 * Normalize and validate a profile field (disabled or enabled).
 * Trims entries, removes empty/oversized strings, deduplicates.
 * Returns undefined if the input is undefined (meaning "don't change").
 */
function normalizeProfileField(field: string[] | undefined): string[] | undefined {
  if (field === undefined) return undefined;
  if (!Array.isArray(field)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of field) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PROFILE_ID_LENGTH) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_PROFILE_ENTRIES) break;
  }
  return result;
}

/** Internal save implementation — called under the per-workspace lock. */
async function doSave(
  cwd: string,
  profile: McpWorkspaceProfile
): Promise<{ success: boolean; error?: string }> {
  const coworkDir = path.join(cwd, COWORK_DIR);
  const profilePath = path.join(coworkDir, PROFILE_FILENAME);

  // Normalize incoming profile fields for defense in depth
  // (IPC validates disabled, but this function is exported and may be called directly).
  const normalizedDisabled = normalizeProfileField(profile.disabled);
  const normalizedEnabled = normalizeProfileField(profile.enabled);

  // Merge with existing profile to avoid destroying `enabled` entries
  // when only `disabled` is being updated (and vice versa).
  let existingProfile: McpWorkspaceProfile = {};
  try {
    const raw = await fs.promises.readFile(profilePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      // Validate existing profile shape — drop invalid fields
      const obj = parsed as Record<string, unknown>;
      existingProfile = {
        disabled: validateStringArray(obj.disabled),
        enabled: validateStringArray(obj.enabled),
      };
    } else {
      logWarn('[McpWorkspaceProfile] Existing profile is not an object, starting fresh');
    }
  } catch (readErr: unknown) {
    const code = (readErr as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // File doesn't exist — normal case, start fresh
    } else if (readErr instanceof SyntaxError) {
      // Invalid JSON — log and start fresh
      logWarn(
        '[McpWorkspaceProfile] Existing profile has invalid JSON, starting fresh:',
        profilePath
      );
    } else {
      // Transient I/O error, permission issue, etc. — fail safe, do not overwrite
      const errorMessage = readErr instanceof Error ? readErr.message : String(readErr);
      logWarn('[McpWorkspaceProfile] Cannot read existing profile, aborting save:', readErr);
      return { success: false, error: `Failed to read existing profile: ${errorMessage}` };
    }
  }

  // Apply incoming fields over existing (undefined means "don't change")
  const mergedProfile: McpWorkspaceProfile = { ...existingProfile };
  if (normalizedDisabled !== undefined) {
    mergedProfile.disabled = normalizedDisabled;
  }
  if (normalizedEnabled !== undefined) {
    mergedProfile.enabled = normalizedEnabled;
  }

  // Clean up empty arrays
  const cleanProfile: McpWorkspaceProfile = {};
  if (mergedProfile.disabled && mergedProfile.disabled.length > 0) {
    cleanProfile.disabled = mergedProfile.disabled;
  }
  if (mergedProfile.enabled && mergedProfile.enabled.length > 0) {
    cleanProfile.enabled = mergedProfile.enabled;
  }

  // If profile is empty, remove the file instead of writing an empty object
  const isEmpty = !cleanProfile.disabled && !cleanProfile.enabled;
  if (isEmpty) {
    try {
      await fs.promises.unlink(profilePath);
      log('[McpWorkspaceProfile] Removed empty profile:', profilePath);
    } catch (unlinkErr: unknown) {
      // File didn't exist — that's fine
      if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw unlinkErr;
      }
    }
  } else {
    // Ensure .cowork directory exists
    await fs.promises.mkdir(coworkDir, { recursive: true });

    // Atomic write: write to a unique temp file then rename to avoid corruption
    // if the process crashes mid-write.
    const tmpPath = profilePath + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(cleanProfile, null, 2) + '\n', 'utf-8');
      await fs.promises.rename(tmpPath, profilePath);
    } catch (writeErr) {
      // Clean up temp file on failure
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw writeErr;
    }
    log('[McpWorkspaceProfile] Saved profile:', profilePath);
  }

  // Invalidate cache so next read picks up the change
  invalidateWorkspaceProfileCache(cwd);

  return { success: true };
}

/**
 * Invalidate the workspace profile cache.
 * Call when the working directory changes or profiles are edited.
 */
export function invalidateWorkspaceProfileCache(cwd?: string | null): void {
  if (cwd) {
    const profilePath = path.join(cwd, COWORK_DIR, PROFILE_FILENAME);
    profileCache.delete(profilePath);
  } else {
    profileCache.clear();
  }
}
