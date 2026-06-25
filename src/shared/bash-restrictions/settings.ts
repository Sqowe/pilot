/**
 * @module shared/bash-restrictions/settings
 *
 * Canonical settings schema and normalizers for the bash restriction system.
 * This is the single source of truth for what a "bash restrictions settings
 * object" looks like — both the Electron app and the pi CLI extension consume
 * the same interface and the same sanitizers, so parity is guaranteed at the
 * type level.
 *
 * **Parity mechanism:** adding a new bash/permission setting means:
 *   1. Add the field + its normalizer here.
 *   2. Wire the Electron UI + store to the new field.
 *   3. The pi extension reads it automatically via `sanitizeBashRestrictionsSettings`.
 */

// ---------------------------------------------------------------------------
// Settings interface & defaults
// ---------------------------------------------------------------------------

/**
 * The complete, canonical shape of bash restriction settings.
 *
 * Field mapping to the Electron app's configStore:
 *   - `trusted`                ↔ `bashTrustedCommands`
 *   - `denied`                 ↔ `bashDenylist`
 *   - `permissionTimeoutSeconds` ↔ `permissionTimeoutSeconds`
 */
export interface BashRestrictionsSettings {
  /** Prefix patterns (with `*` wildcard). Matching commands run without a prompt. */
  trusted: string[];
  /** Substring patterns. Matching commands always prompt, even if also trusted. */
  denied: string[];
  /**
   * How long the permission dialog waits before auto-denying.
   *   - `0` = wait forever (no timeout)
   *   - positive = seconds, clamped to [10, 3600]
   * Default: 300 (5 minutes).
   */
  permissionTimeoutSeconds: number;
}

export const DEFAULT_BASH_RESTRICTIONS_SETTINGS: Readonly<BashRestrictionsSettings> = {
  trusted: [],
  denied: [],
  permissionTimeoutSeconds: 300,
};

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/**
 * Normalize an unknown value into a clean string array: drops non-string
 * entries, trims whitespace, and filters out empties.
 *
 * Exported so that the Electron main-process IPC handler, configStore, and
 * the pi extension config loader all agree on exactly what a "bash command
 * list" looks like at the trust boundary.
 */
export function sanitizeBashCommandList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Normalize a raw permission timeout value.
 *
 * Rules (mirrors the Electron app's configStore exactly):
 *   - Non-number or non-finite → `300` (default)
 *   - `<= 0` after `Math.floor` → `0` (infinite, no timeout)
 *   - `1–9` → `10` (minimum enforced)
 *   - `> 3600` → `3600` (maximum 1 hour)
 *   - Otherwise → value as-is (floored to integer)
 */
export function normalizePermissionTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) return 0; // infinite
  if (rounded < 10) return 10; // minimum 10 seconds
  if (rounded > 3600) return 3600; // maximum 1 hour
  return rounded;
}

/**
 * Sanitize and normalize a raw (untrusted) object into a canonical
 * `BashRestrictionsSettings`. Missing or malformed fields fall back to
 * `DEFAULT_BASH_RESTRICTIONS_SETTINGS`.
 *
 * Used by the pi extension config loader after reading and merging JSON
 * config files. Safe to call on any unknown input — never throws.
 */
export function sanitizeBashRestrictionsSettings(raw: unknown): BashRestrictionsSettings {
  const defaults = DEFAULT_BASH_RESTRICTIONS_SETTINGS;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaults };
  }

  const obj = raw as Record<string, unknown>;

  return {
    trusted: sanitizeBashCommandList(obj['trusted'] ?? obj['bashTrustedCommands'] ?? []),
    denied: sanitizeBashCommandList(obj['denied'] ?? obj['bashDenylist'] ?? []),
    permissionTimeoutSeconds: normalizePermissionTimeout(obj['permissionTimeoutSeconds']),
  };
}
