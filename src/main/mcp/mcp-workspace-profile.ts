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
