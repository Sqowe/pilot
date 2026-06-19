/**
 * @module shared/bash-restrictions
 *
 * Public API for the bash restriction shared module.
 * Import from here rather than from the individual sub-modules.
 */
export type { BashDecision, BashCommandLists } from './engine';
export {
  splitBashSubCommands,
  containsUnsupportedShellSyntax,
  matchesTrustedPrefix,
  matchesDenylistPattern,
  decideBashPermission,
} from './engine';

export type { BashRestrictionsSettings } from './settings';
export {
  DEFAULT_BASH_RESTRICTIONS_SETTINGS,
  sanitizeBashCommandList,
  normalizePermissionTimeout,
  sanitizeBashRestrictionsSettings,
} from './settings';
