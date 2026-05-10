/**
 * @module main/claude/read-loop-guard
 *
 * Prevents models from exhausting the context window by repeatedly reading
 * the same file in chunks without making progress. When a file has been read
 * more than MAX_READS_PER_FILE times within a single session, the guard
 * blocks further reads and returns a reason string that teaches the model
 * to use `bash` with grep/sed instead.
 *
 * Design decisions:
 *   - Tracking is per-session (Map created per installPermissionHook call).
 *   - Absolute paths are stored as-is (after collapsing `../` segments).
 *   - Relative paths are only tracked if a cwd is provided at check-time;
 *     otherwise they are skipped (no tracking = no false positives).
 *   - The threshold is intentionally generous (default 4) — allows an
 *     initial read + 3 follow-ups before blocking.
 *   - The block reason is phrased as actionable guidance for the model,
 *     not just an error message.
 *   - The guard has a bounded size (MAX_TRACKED_FILES) to prevent
 *     unbounded memory growth in long-lived sessions.
 */

import * as path from 'path';

/**
 * Default maximum number of times the `read` tool may be called on the
 * same file path within a single session before the guard blocks it.
 */
export const DEFAULT_MAX_READS_PER_FILE = 4;

/**
 * Maximum number of distinct file paths tracked before the oldest entries
 * are evicted. Prevents unbounded memory growth in long sessions.
 */
export const MAX_TRACKED_FILES = 200;

/**
 * Result of checking whether a read should be allowed.
 */
export interface ReadGuardResult {
  /** Whether the read should be blocked. */
  blocked: boolean;
  /** Human-readable reason (included in the tool-call block response). */
  reason?: string;
  /** How many times this file has now been read (including this attempt). */
  count: number;
}

/**
 * A per-session guard that tracks how many times each file path has been
 * read and blocks excessive repeated reads.
 *
 * Uses insertion-order iteration of Map for LRU eviction when the
 * tracked file count exceeds MAX_TRACKED_FILES.
 */
export class ReadLoopGuard {
  private readonly counts = new Map<string, number>();
  private readonly maxReads: number;
  private readonly maxTracked: number;

  constructor(
    maxReads: number = DEFAULT_MAX_READS_PER_FILE,
    maxTracked: number = MAX_TRACKED_FILES
  ) {
    this.maxReads = Math.max(1, Math.floor(maxReads));
    this.maxTracked = Math.max(1, Math.floor(maxTracked));
  }

  /**
   * Record a read attempt for the given file path and return whether it
   * should be blocked.
   *
   * @param filePath - The raw file path from the tool input (will be normalized).
   * @param cwd - Optional working directory for resolving relative paths.
   *              Passed at call-time (not captured at construction) so it
   *              stays correct across session reuse with different cwds.
   * @returns ReadGuardResult indicating whether to block and why.
   */
  check(filePath: string, cwd?: string): ReadGuardResult {
    const normalized = this.normalizePath(filePath, cwd);
    if (normalized === null) {
      // Cannot normalize (relative path without cwd) — skip tracking
      return { blocked: false, count: 0 };
    }

    const prev = this.counts.get(normalized) ?? 0;
    const count = prev + 1;

    // LRU eviction: delete and re-insert to move to end of iteration order
    this.counts.delete(normalized);
    this.counts.set(normalized, count);

    // Evict oldest entries if we exceed the cap
    while (this.counts.size > this.maxTracked) {
      const oldest = this.counts.keys().next().value;
      if (oldest !== undefined) {
        this.counts.delete(oldest);
      } else {
        break;
      }
    }

    if (count > this.maxReads) {
      const shortName = path.basename(filePath);
      return {
        blocked: true,
        reason:
          `File "${shortName}" has been read ${count} times in this session (limit: ${this.maxReads}). ` +
          `Reading the same file repeatedly wastes context tokens. ` +
          `Use the 'bash' tool with grep, sed, or tail to search for specific content. ` +
          `For example: grep -n "keyword" "${filePath}" or tail -n 200 "${filePath}"`,
        count,
      };
    }

    return { blocked: false, count };
  }

  /**
   * Get the current read count for a file without incrementing.
   */
  getCount(filePath: string, cwd?: string): number {
    const normalized = this.normalizePath(filePath, cwd);
    if (normalized === null) return 0;
    return this.counts.get(normalized) ?? 0;
  }

  /**
   * Reset the counter for a specific file (e.g., after a user message
   * indicates a new intent).
   */
  resetFile(filePath: string, cwd?: string): void {
    const normalized = this.normalizePath(filePath, cwd);
    if (normalized !== null) {
      this.counts.delete(normalized);
    }
  }

  /**
   * Reset all counters (e.g., on session dispose or between agent runs).
   */
  resetAll(): void {
    this.counts.clear();
  }

  /**
   * Number of distinct files currently tracked.
   */
  get trackedFileCount(): number {
    return this.counts.size;
  }

  /**
   * Normalize a file path for consistent counting.
   *
   * - Absolute paths: collapsed via path.normalize() (resolves `../` etc.)
   * - Relative paths + cwd provided: resolved against cwd
   * - Relative paths + no cwd: returns null (cannot safely normalize)
   *
   * We do NOT lowercase paths — macOS supports case-sensitive volumes.
   */
  private normalizePath(filePath: string, cwd?: string): string | null {
    if (!filePath) return null;

    const isAbsolute = path.isAbsolute(filePath);

    if (isAbsolute) {
      return path.normalize(filePath);
    }

    // Relative path — only resolve if cwd is available
    if (cwd) {
      return path.resolve(cwd, filePath);
    }

    // Cannot safely normalize a relative path without cwd
    return null;
  }
}

/**
 * Extract the file path from a `read` tool's input arguments.
 * The pi-coding-agent SDK uses `file_path` as the parameter name.
 * We also check `path` and `filePath` for robustness.
 */
export function extractReadFilePath(input: Record<string, unknown>): string | null {
  // pi-coding-agent's built-in read tool uses `file_path`
  const candidates = [input.file_path, input.path, input.filePath];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}
