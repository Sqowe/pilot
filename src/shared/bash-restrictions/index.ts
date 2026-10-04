/**
 * @module shared/bash-restrictions
 *
 * Public API for the bash restriction shared module.
 * Import from here rather than from the individual sub-modules.
 *
 * Stable symbols consumed by the Electron main process and the pi CLI extension:
 *   Engine    : decideBashPermission, explainBashPermission, splitBashSubCommands,
 *               containsUnsupportedShellSyntax, matchesTrustedPrefix, matchesDenylistPattern
 *   Settings  : DEFAULT_BASH_RESTRICTIONS_SETTINGS, sanitizeBashCommandList,
 *               sanitizeTrustedDirectories, normalizePermissionTimeout,
 *               sanitizeBashRestrictionsSettings
 *   Types     : BashDecision, BashCommandLists, BashAskReason, BashDecisionDetail,
 *               BashRestrictionsSettings
 *
 * This barrel stays free of file-system imports. The trusted-directories check
 * for bash (`checkBashWriteZone`, `decideBashWithZone`, `describeBashReason`)
 * resolves real paths, so it is NOT re-exported here — import it from
 * `./write-zone` directly, in the main process and the pi extension only.
 */
export type { BashAskReason, BashCommandLists, BashDecision, BashDecisionDetail } from './engine';
export {
  splitBashSubCommands,
  containsUnsupportedShellSyntax,
  matchesTrustedPrefix,
  matchesDenylistPattern,
  decideBashPermission,
  explainBashPermission,
} from './engine';

export type { BashRestrictionsSettings } from './settings';
export {
  DEFAULT_BASH_RESTRICTIONS_SETTINGS,
  sanitizeBashCommandList,
  sanitizeTrustedDirectories,
  normalizePermissionTimeout,
  sanitizeBashRestrictionsSettings,
} from './settings';
