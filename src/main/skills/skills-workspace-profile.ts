/**
 * Skills Workspace Profile
 *
 * Loads per-workspace skill preferences from {cwd}/.cowork/skills-profile.json.
 * Mirrors the pattern of mcp-workspace-profile.ts.
 *
 * File format:
 * {
 *   "pinned": ["semantic-index", "firecrawl"],
 *   "disabled": ["xlsx", "pptx", "docx"]
 * }
 *
 * Resolution:
 * - Skills listed in "pinned" are pre-pinned on session creation
 * - Skills listed in "disabled" are excluded from the session
 * - A skill in both → pinned wins (explicit include overrides disable)
 * - Skills not in either → available (normal state)
 *
 * The file is optional — missing file = all skills available, none pinned.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log, logWarn } from '../utils/logger';
import { isValidSkillId } from '../../shared/skill-pinning-constants';
import type { SkillsWorkspaceProfile } from '../../shared/skill-conflict-types';

const PROFILE_FILENAME = 'skills-profile.json';
const COWORK_DIR = '.cowork';

// Per-path cache with bounded size
const MAX_CACHE_ENTRIES = 20;
interface CacheEntry {
  profile: SkillsWorkspaceProfile | null;
  mtimeMs: number;
}
const profileCache = new Map<string, CacheEntry>();

function setCacheEntry(key: string, profile: SkillsWorkspaceProfile | null, mtimeMs: number): void {
  // Evict oldest entry if cache is full
  if (profileCache.size >= MAX_CACHE_ENTRIES && !profileCache.has(key)) {
    const firstKey = profileCache.keys().next().value;
    if (firstKey) profileCache.delete(firstKey);
  }
  profileCache.set(key, { profile, mtimeMs });
}

/**
 * Load the workspace skills profile from {cwd}/.cowork/skills-profile.json.
 * Returns null if the file doesn't exist or is invalid.
 * Uses per-path mtime-based caching to avoid repeated disk reads.
 *
 * Security: rejects symlinks, verifies path stays within cwd, enforces size limit.
 */
export function loadSkillsWorkspaceProfile(cwd?: string | null): SkillsWorkspaceProfile | null {
  if (!cwd) return null;

  const profilePath = path.join(cwd, COWORK_DIR, PROFILE_FILENAME);

  try {
    // Use lstatSync to detect symlinks (doesn't follow them)
    const lstat = fs.lstatSync(profilePath);

    // Reject symlinks and non-regular files
    if (!lstat.isFile()) {
      logWarn('[SkillsWorkspaceProfile] Profile is not a regular file (rejected):', profilePath);
      setCacheEntry(profilePath, null, 0);
      return null;
    }

    // Enforce file size limit (64KB)
    const MAX_PROFILE_SIZE = 64 * 1024;
    if (lstat.size > MAX_PROFILE_SIZE) {
      logWarn(`[SkillsWorkspaceProfile] Profile too large (${lstat.size} bytes):`, profilePath);
      setCacheEntry(profilePath, null, lstat.mtimeMs);
      return null;
    }

    // Check mtime cache
    const cached = profileCache.get(profilePath);
    if (cached && cached.mtimeMs === lstat.mtimeMs) {
      return cached.profile;
    }

    // Verify realpath stays within workspace boundary
    const resolvedProfile = fs.realpathSync(profilePath);
    const resolvedCwd = fs.realpathSync(cwd);
    const rel = path.relative(resolvedCwd, resolvedProfile);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      logWarn('[SkillsWorkspaceProfile] Profile escapes workspace boundary:', profilePath);
      setCacheEntry(profilePath, null, lstat.mtimeMs);
      return null;
    }

    const raw = fs.readFileSync(profilePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      logWarn('[SkillsWorkspaceProfile] Invalid profile format:', profilePath);
      setCacheEntry(profilePath, null, lstat.mtimeMs);
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const profile: SkillsWorkspaceProfile = {};
    const MAX_ENTRIES = 200;

    // Validate, deduplicate, and cap pinned array
    if (Array.isArray(obj.pinned)) {
      profile.pinned = [
        ...new Set(
          obj.pinned.filter(
            (item): item is string => typeof item === 'string' && isValidSkillId(item)
          )
        ),
      ].slice(0, MAX_ENTRIES);
    }

    // Validate, deduplicate, and cap disabled array
    if (Array.isArray(obj.disabled)) {
      profile.disabled = [
        ...new Set(
          obj.disabled.filter(
            (item): item is string => typeof item === 'string' && isValidSkillId(item)
          )
        ),
      ].slice(0, MAX_ENTRIES);
    }

    setCacheEntry(profilePath, profile, lstat.mtimeMs);
    log('[SkillsWorkspaceProfile] Loaded profile:', profilePath);
    return profile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist — normal case, no warning needed
      setCacheEntry(profilePath, null, 0);
      return null;
    }
    // Cache parse/read failures to avoid re-reading on every call
    logWarn('[SkillsWorkspaceProfile] Error reading profile:', err);
    try {
      const failStat = fs.lstatSync(profilePath);
      setCacheEntry(profilePath, null, failStat.mtimeMs);
    } catch {
      setCacheEntry(profilePath, null, 0);
    }
    return null;
  }
}

/**
 * Invalidate the workspace profile cache. Primarily used in tests.
 */
export function invalidateSkillsWorkspaceProfileCache(): void {
  profileCache.clear();
}
