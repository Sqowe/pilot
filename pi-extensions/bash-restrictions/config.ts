/**
 * @module pi-extensions/bash-restrictions/config
 *
 * Config loader for the pi bash-restrictions extension.
 *
 * Reads two optional JSON files and merges them into a canonical
 * BashRestrictionsSettings object (CONFIG_DIR_NAME defaults to ".pi" but
 * follows rebranded pi distributions):
 *
 *   Global:  <homeDir>/<CONFIG_DIR_NAME>/agent/bash-restrictions.json
 *   Project: <cwd>/<CONFIG_DIR_NAME>/bash-restrictions.json   (trusted projects only)
 *
 * The project file is honored only when the caller reports the project as
 * trusted (see `projectTrusted`), so an untrusted project cannot loosen the gate.
 *
 * Merge rules (§7 of docs/design/pi-bash-restrictions-extension.md):
 *   - trusted / denied  → global ∪ project (union, deduped, global-first order)
 *   - permissionTimeoutSeconds → project value if the key is explicitly present
 *                                in the project file; otherwise global value if
 *                                present; otherwise the shared default (300).
 *
 * Missing or malformed files are silently ignored and treated as absent.
 * The final merged object is passed through sanitizeBashRestrictionsSettings so
 * all values are validated and clamped to the canonical shape.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Namespace import (not a named import): CONFIG_DIR_NAME was added in pi SDK
// 0.79; a static named import would resolve to undefined on older SDKs (and can
// throw under strict ESM). Reading it off the namespace lets us fall back safely.
import * as piSdk from '@earendil-works/pi-coding-agent';
import {
  sanitizeBashCommandList,
  sanitizeBashRestrictionsSettings,
  DEFAULT_BASH_RESTRICTIONS_SETTINGS,
  type BashRestrictionsSettings,
} from '../../src/shared/bash-restrictions';

/**
 * pi's config directory name. Defaults to ".pi" but rebranded pi distributions
 * may use a different name (pi exposes this as CONFIG_DIR_NAME from SDK 0.79+).
 * Falls back to ".pi" when the running SDK doesn't provide it.
 */
const CONFIG_DIR: string =
  typeof (piSdk as { CONFIG_DIR_NAME?: unknown }).CONFIG_DIR_NAME === 'string' &&
  (piSdk as { CONFIG_DIR_NAME: string }).CONFIG_DIR_NAME.trim()
    ? (piSdk as { CONFIG_DIR_NAME: string }).CONFIG_DIR_NAME
    : '.pi';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON file and return its content as a plain object.
 * Returns null when the file is missing, unreadable, not valid JSON, or
 * not a plain object (e.g. arrays, primitives).
 */
function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    // ENOENT (file not found) is the common expected case — silently ignore.
    // Other errors (EACCES, EPERM, SyntaxError, etc.) are also silently tolerated
    // to preserve the "never throws" contract. To add observability in the future,
    // check (err as NodeJS.ErrnoException).code !== 'ENOENT' and emit a debug log.
    void err;
    return null;
  }
}

/** Return true when `obj` is non-null and owns the given key. */
function hasOwn(obj: Record<string, unknown> | null, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------------------------------------------------------------------------
// Path resolution (exported so tests can verify the expected paths)
// ---------------------------------------------------------------------------

/**
 * Absolute path to the global bash-restrictions config file.
 *
 * @param homeDir - Override for the home directory (defaults to os.homedir()).
 *                  Pass a temp directory in tests to avoid touching the real home.
 *                  Passing undefined or omitting uses os.homedir().
 */
export function resolveGlobalConfigPath(homeDir?: string): string {
  // CONFIG_DIR (default ".pi") honors rebranded pi distributions; mirrors
  // pi's own getAgentDir() = join(homedir(), CONFIG_DIR_NAME, "agent").
  return join(homeDir ?? homedir(), CONFIG_DIR, 'agent', 'bash-restrictions.json');
}

/**
 * Absolute path to the project-scoped bash-restrictions config file.
 *
 * @param cwd - The project's working directory (pass process.cwd() in production).
 */
export function resolveProjectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, 'bash-restrictions.json');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Load, merge, and normalize bash-restrictions settings.
 *
 * @param cwd     - Project working directory; used to find the project config.
 * @param options - Optional overrides.
 *   - homeDir        - Override the home directory for the global config path
 *                      (primarily for testing).
 *   - projectTrusted - Whether to honor the project-local config file. Defaults
 *                      to `true` for direct callers/tests; the extension passes
 *                      `ctx.isProjectTrusted()`. When `false`, the project file
 *                      is ignored so an untrusted project cannot widen `trusted`
 *                      (or otherwise loosen the gate) — only global config applies.
 *
 * @returns A fully normalized BashRestrictionsSettings object. Never throws.
 */
export function loadBashRestrictionsSettings(
  cwd: string,
  options?: { homeDir?: string; projectTrusted?: boolean }
): BashRestrictionsSettings {
  // Treat an empty / whitespace-only homeDir as "not provided" so callers cannot
  // accidentally redirect the global config to the current working directory.
  const effectiveHomeDir = options?.homeDir?.trim() || undefined;
  const projectTrusted = options?.projectTrusted ?? true;
  const globalRaw = readJsonFile(resolveGlobalConfigPath(effectiveHomeDir));
  // Skip the project file entirely for untrusted projects (fail-closed).
  const projectRaw = projectTrusted ? readJsonFile(resolveProjectConfigPath(cwd)) : null;

  // Union-merge lists: global ∪ project, deduped (Set preserves insertion order,
  // so global entries come first, then project-only additions).
  const mergedTrusted = [
    ...new Set([
      ...sanitizeBashCommandList(globalRaw?.['trusted']),
      ...sanitizeBashCommandList(projectRaw?.['trusted']),
    ]),
  ];
  const mergedDenied = [
    ...new Set([
      ...sanitizeBashCommandList(globalRaw?.['denied']),
      ...sanitizeBashCommandList(projectRaw?.['denied']),
    ]),
  ];

  // permissionTimeoutSeconds priority: project (if key present) > global (if key
  // present) > shared default. Using hasOwn so that an explicit project value of 0
  // (infinite) is not confused with "not set".
  const rawTimeout = hasOwn(projectRaw, 'permissionTimeoutSeconds')
    ? projectRaw!['permissionTimeoutSeconds']
    : hasOwn(globalRaw, 'permissionTimeoutSeconds')
      ? globalRaw!['permissionTimeoutSeconds']
      : DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds;

  return sanitizeBashRestrictionsSettings({
    trusted: mergedTrusted,
    denied: mergedDenied,
    permissionTimeoutSeconds: rawTimeout,
  });
}
