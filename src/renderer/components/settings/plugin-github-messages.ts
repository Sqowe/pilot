import type { TFunction } from 'i18next';
import {
  PLUGIN_GITHUB_ERROR_CODES,
  type PluginGitHubError,
  type PluginGitHubErrorCode,
} from '../../../shared/plugin-github-url';
import type { InstalledPlugin } from '../../types';

/** The i18n key for each error code of the GitHub install and update calls. */
export function pluginGitHubErrorKey(code: PluginGitHubErrorCode): string {
  return `skills.githubErrors.${code}`;
}

/**
 * A user-facing message for a GitHub install/update failure (AI_FRONTEND.md
 * §12). An unknown code — a newer main process — falls back to the generic one.
 */
export function pluginGitHubErrorMessage(error: PluginGitHubError, t: TFunction): string {
  const code = (PLUGIN_GITHUB_ERROR_CODES as readonly string[]).includes(error.code)
    ? error.code
    : 'unknown';
  return t(pluginGitHubErrorKey(code), { details: error.details ?? '' });
}

/** The first seven characters of a commit id, as GitHub shows it. */
export function shortCommitSha(sha: string | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

/** `owner/repo · ref · abc1234` for a plugin installed from GitHub; null otherwise. */
export function describePluginGitHubSource(plugin: InstalledPlugin): string | null {
  const source = plugin.source;
  if (!source || source.type !== 'github') {
    return null;
  }
  const parts = [`${source.owner}/${source.repo}`];
  if (source.path) parts[0] += `/${source.path}`;
  if (source.ref) parts.push(source.ref);
  const sha = shortCommitSha(source.commitSha);
  if (sha) parts.push(sha);
  return parts.join(' · ');
}
