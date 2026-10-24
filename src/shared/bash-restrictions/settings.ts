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
 *   - `trustedDirectories`     ↔ `trustedDirectories`
 *   - `permissionTimeoutSeconds` ↔ `permissionTimeoutSeconds`
 */
export interface BashRestrictionsSettings {
  /** Prefix patterns (with `*` wildcard). Matching commands run without a prompt. */
  trusted: string[];
  /** Substring patterns. Matching commands always prompt, even if also trusted. */
  denied: string[];
  /**
   * Directories the agent may write to without being asked — for visible bash
   * write targets and for the `write` / `edit` tools. Entries are kept as
   * written (`./`, `~/x`, absolute); they are resolved against the session's
   * working directory when the write zone is built. Empty = the write checks
   * are off. See docs/design/trusted-directories.md.
   */
  trustedDirectories: string[];
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
  trustedDirectories: [],
  permissionTimeoutSeconds: 300,
};

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------
// These are NOT the "no policy configured" state — that one stays
// `DEFAULT_BASH_RESTRICTIONS_SETTINGS` above, which the sanitizers and the
// standalone pi CLI extension use to mean "no gate at all". The constants
// below are what a FRESH INSTALL of the desktop app starts with: they are
// written into the config file on first launch (see the `defaults` option of
// the encrypted store) and are then owned by the user like any other value.
//
// An install that already has its own lists keeps them — the file wins over
// the store defaults, so these never overwrite a user's choice.

/**
 * Trusted-command patterns a fresh install starts with.
 *
 * `'*'` matches every command (the trusted list is a prefix match with `*` as
 * a wildcard), so the trust list does not narrow anything down: the denylist
 * and the write zone are what decide whether a command asks.
 */
export const DEFAULT_BASH_TRUSTED_COMMANDS: readonly string[] = Object.freeze(['*']);

/**
 * Denylist a fresh install starts with: patterns that always force an
 * approval prompt, even when a trusted pattern also matches.
 *
 * Matching is word-boundary based and case-insensitive; `*` is a literal
 * asterisk, not a wildcard. Multi-word entries are literal substrings —
 * `format c:` matches `format c: /q` but not `npm run format`.
 *
 * Caveat: a pattern is looked for anywhere in the sub-command, including
 * inside quotes, so `echo "install docs"` matches `install` and asks. */
export const DEFAULT_BASH_DENYLIST: readonly string[] = Object.freeze([
  // Privilege escalation.
  'sudo',
  'su',
  'doas',
  'pkexec',
  'runas',
  // Destructive file operations.
  'rm',
  'rmdir',
  'shred',
  'mkfs',
  'dd',
  'diskutil',
  'fdisk',
  'truncate',
  // Ownership and permissions.
  'chown',
  'chmod',
  'chgrp',
  // Process and system control.
  'kill',
  'killall',
  'pkill',
  'shutdown',
  'reboot',
  'systemctl',
  'launchctl',
  // Remote access.
  'ssh',
  'scp',
  'sftp',
  // Network downloads and shell execution of what was downloaded.
  // The `-c` patterns are literal two-word strings: they catch an inline
  // shell script (`sh -c "..."`, `bash -c "..."`) and leave `du -sh` and
  // `bash script.sh` alone.
  'sh -c',
  'bash -c',
  'zsh -c',
  'curl',
  'wget',
  // Installing software.
  'install',
  'uninstall',
  'apt',
  'yum',
  'dnf',
  'apk',
  // Destructive git.
  'git push',
  'git reset --hard',
  'git clean',
  'git filter-branch',
  '--force',
  '--hard',
  // Windows.
  'del',
  'format c:',
  'takeown',
  'icacls',
  'cipher',
  'Remove-Item',
  'Stop-Process',
  'taskkill',
  'reg',
]);

/**
 * Trusted directories a fresh install starts with — the places the agent may
 * write without being asked. `./` is the session's workspace; the other two
 * are the usual scratch directories.
 *
 * Entries are resolved per session (see `buildWriteZone`): `./` against the
 * session's working directory, `~` against the home directory. The file-system
 * root and the home directory itself are refused by the builder.
 */
export const DEFAULT_BASH_TRUSTED_DIRECTORIES: readonly string[] = Object.freeze([
  './',
  '/tmp',
  '~/tmp',
]);

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
 * Normalize an unknown value into a clean list of directory entries: drops
 * non-string entries, trims whitespace, filters out empties and removes exact
 * duplicates (first occurrence wins).
 *
 * Entries are NOT resolved or validated here — whether a directory is accepted
 * depends on the session's working directory and is decided when the write
 * zone is built (`buildWriteZone` in `src/shared/path-permissions`).
 */
export function sanitizeTrustedDirectories(input: unknown): string[] {
  return [...new Set(sanitizeBashCommandList(input))];
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
    trustedDirectories: sanitizeTrustedDirectories(obj['trustedDirectories'] ?? []),
    permissionTimeoutSeconds: normalizePermissionTimeout(obj['permissionTimeoutSeconds']),
  };
}
