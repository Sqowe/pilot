/**
 * Centralized PATH environment management.
 *
 * Provides idempotent PATH reconciliation: tracks a "base PATH" (everything
 * except localDevPath entries) and deterministically rebuilds the full PATH
 * by prepending the current localDevPath. Supports replacement and removal
 * of localDevPath entries without leaving stale paths behind.
 */

// Use a lightweight log function that doesn't depend on Electron.
// In production, the caller (agent-runner) logs the high-level operations.
const pathEnvLog = (...args: unknown[]) => {
  try {
    // Try to use the app logger if available (production)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { log } = require('./logger');
    log(...args);
  } catch {
    // Fallback for tests or environments without Electron
    console.log('[PathEnv]', ...args);
  }
};

const delimiter = process.platform === 'win32' ? ';' : ':';

/**
 * Snapshot of the base PATH (without any localDevPath entries).
 * Set once during initial enrichment, then reused for all subsequent rebuilds.
 */
let basePath: string | null = null;

/**
 * The last-applied localDevPath value, used for diagnostics.
 */
let lastAppliedLocalDevPath = '';

/**
 * Normalize a path entry for deduplication (case-insensitive on Windows).
 */
function normalizePath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Deduplicate path entries while preserving order.
 */
function deduplicatePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const normalized = normalizePath(trimmed);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Set the base PATH snapshot. Call this once after initial PATH enrichment
 * (shell restoration + bundled dirs) but BEFORE applying localDevPath.
 *
 * If localDevPath entries are already in the PATH at this point, they will
 * be stripped from the base to avoid double-application.
 */
export function setBasePath(fullPath: string, localDevPath?: string): void {
  let parts = fullPath.split(delimiter).filter((p) => p.trim());

  // Strip any localDevPath entries from the base snapshot
  if (localDevPath?.trim()) {
    const localDirs = new Set(
      localDevPath
        .split(delimiter)
        .filter((p) => p.trim())
        .map(normalizePath)
    );
    parts = parts.filter((p) => !localDirs.has(normalizePath(p)));
  }

  basePath = deduplicatePaths(parts).join(delimiter);
  pathEnvLog(`[PathEnv] Base PATH set: ${parts.length} entries`);
}

/**
 * Apply localDevPath to process.env.PATH idempotently.
 *
 * Rebuilds PATH from scratch: localDevPath → basePath (deduplicated).
 * Safe to call multiple times — always produces a deterministic result.
 *
 * @param localDevPath - Colon/semicolon-separated directories to prepend.
 *                       Empty string or undefined removes all localDevPath entries.
 * @returns The new PATH value.
 */
export function applyLocalDevPath(localDevPath: string | undefined): string {
  const currentBase = basePath ?? process.env.PATH ?? '';
  const baseParts = currentBase.split(delimiter).filter((p) => p.trim());

  const userDirs = (localDevPath || '')
    .trim()
    .split(delimiter)
    .filter((p) => p.trim());

  // Rebuild: localDev → base, deduplicated
  const merged = deduplicatePaths([...userDirs, ...baseParts]);
  const result = merged.join(delimiter);

  process.env.PATH = result;
  lastAppliedLocalDevPath = localDevPath || '';

  pathEnvLog(
    `[PathEnv] Applied localDevPath: ${userDirs.length} user entries + ${baseParts.length} base → ${merged.length} total`
  );

  return result;
}

/**
 * Get the current effective PATH.
 */
export function getEffectivePath(): string {
  return process.env.PATH || '';
}

/**
 * Get the last-applied localDevPath value.
 */
export function getLastAppliedLocalDevPath(): string {
  return lastAppliedLocalDevPath;
}

/**
 * Check if the base PATH has been initialized.
 */
export function isBasePathSet(): boolean {
  return basePath !== null;
}

// Exported for testing
export const _internals = {
  normalizePath,
  deduplicatePaths,
  getBasePath: () => basePath,
  resetForTesting: () => {
    basePath = null;
    lastAppliedLocalDevPath = '';
  },
};
