/**
 * @module shared/plugin-github-url
 *
 * Parses the GitHub link a user pastes into "Install from GitHub" and names the
 * error codes the install and update calls return. Pure and renderer-safe
 * (AI_MAIN_PROCESS.md §12): the dialog validates as the user types, and the
 * main process parses the same text again, because the renderer is untrusted.
 *
 * Design: docs/design/plugin-github-install.md
 */

/** Where a plugin lives on GitHub. */
export interface GitHubPluginLocation {
  owner: string;
  repo: string;
  /** Branch, tag or commit as given; undefined = the repository's default branch. */
  ref?: string;
  /** Folder inside the repository, forward slashes, no leading or trailing slash. */
  path?: string;
}

/** Every way an install or update from GitHub can fail, as the renderer sees it. */
export const PLUGIN_GITHUB_ERROR_CODES = [
  'invalidUrl',
  'repoNotFound',
  'refNotFound',
  'pathNotFound',
  'noPlugin',
  'multiplePlugins',
  'unsupportedSource',
  'tooLarge',
  'downloadFailed',
  'archiveInvalid',
  'pluginNotFound',
  'notFromGitHub',
  'pluginRenamed',
  'unknown',
] as const;

export type PluginGitHubErrorCode = (typeof PLUGIN_GITHUB_ERROR_CODES)[number];

export interface PluginGitHubError {
  code: PluginGitHubErrorCode;
  /** Plain detail for the message, e.g. the plugin names of a marketplace. Never a stack. */
  details?: string;
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REF_PATTERN = /^[A-Za-z0-9._+/-]{1,255}$/;
/** 1–255 characters, none of them a backslash or a control character. */
function isValidSegmentText(segment: string): boolean {
  if (segment.length === 0 || segment.length > 255) return false;
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return false;
  }
  return true;
}
const SHORTHAND_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;
const SCP_PATTERN = /^git@github\.com:([^/\s]+)\/([^/\s]+?)\/?$/i;
/** Longest link accepted, so a pasted wall of text is refused before any parsing. */
const MAX_INPUT_LENGTH = 2048;

function isValidOwner(owner: string): boolean {
  return OWNER_PATTERN.test(owner);
}

/** A GitHub user or organisation name. */
export function isValidGitHubOwner(owner: string): boolean {
  return typeof owner === 'string' && isValidOwner(owner);
}

/** A GitHub repository name, without `.git`. */
export function isValidGitHubRepoName(repo: string): boolean {
  return typeof repo === 'string' && normalizeRepo(repo) === repo;
}

function normalizeRepo(raw: string): string | null {
  const repo = raw.replace(/\.git$/i, '');
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    return null;
  }
  return repo;
}

/** A ref GitHub could hold and that cannot steer a URL or a command line. */
export function isValidGitRef(ref: string): boolean {
  return (
    typeof ref === 'string' &&
    REF_PATTERN.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.startsWith('/') &&
    !ref.startsWith('-') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.lock')
  );
}

/**
 * A folder inside a repository: forward slashes, no `.`/`..` segment, no
 * backslash or control character. Returns the joined form, or null.
 */
export function normalizeRepoSubpath(segments: string[]): string | null {
  const cleaned = segments.filter((segment) => segment.length > 0);
  if (cleaned.length === 0) {
    return null;
  }
  for (const segment of cleaned) {
    if (segment === '.' || segment === '..' || !isValidSegmentText(segment)) {
      return null;
    }
  }
  return cleaned.join('/');
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function fromUrl(text: string): GitHubPluginLocation | null {
  // `new URL` resolves `.`/`..` segments (also `%2e%2e`) before the path can be
  // read, which would quietly turn `tree/main/../x` into ref `x`. Such a link
  // is refused instead of being re-pointed.
  const rawPath = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
  for (const raw of rawPath.split('/')) {
    const decoded = safeDecode(raw);
    if (decoded === null || decoded === '.' || decoded === '..') return null;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password || url.port) return null;

  const segments: string[] = [];
  for (const raw of url.pathname.split('/')) {
    if (!raw) continue;
    const decoded = safeDecode(raw);
    if (decoded === null) return null;
    segments.push(decoded);
  }
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = normalizeRepo(segments[1]);
  if (!isValidOwner(owner) || !repo) return null;

  const rest = segments.slice(2);
  if (rest.length === 0) {
    return { owner, repo };
  }
  if (rest[0] !== 'tree' || rest.length < 2) {
    // /blob/…, /releases, /issues — not a folder of the repository.
    return null;
  }

  const ref = rest[1];
  if (!isValidGitRef(ref)) return null;
  if (rest.length === 2) {
    return { owner, repo, ref };
  }
  const subpath = normalizeRepoSubpath(rest.slice(2));
  if (!subpath) return null;
  return { owner, repo, ref, path: subpath };
}

/**
 * Parse a GitHub link to a plugin. Accepted:
 * `https://github.com/owner/repo`, with `.git`, `/tree/<ref>` or
 * `/tree/<ref>/<folder>`; the same without a scheme; `git@github.com:owner/repo.git`;
 * and `owner/repo`. Anything else — another host, a file link, a link with
 * credentials — gives null.
 *
 * A branch whose name holds a `/` cannot be told from a folder in a
 * `/tree/…` link; the first segment is taken as the ref.
 */
export function parseGitHubPluginUrl(input: string): GitHubPluginLocation | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > MAX_INPUT_LENGTH || /\s/.test(text)) return null;

  const scp = text.match(SCP_PATTERN);
  if (scp) {
    const repo = normalizeRepo(scp[2]);
    return isValidOwner(scp[1]) && repo ? { owner: scp[1], repo } : null;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return fromUrl(text);
  }

  if (/^(?:www\.)?github\.com\//i.test(text)) {
    return fromUrl(`https://${text}`);
  }

  const shorthand = text.match(SHORTHAND_PATTERN);
  if (shorthand) {
    const repo = normalizeRepo(shorthand[2]);
    return isValidOwner(shorthand[1]) && repo ? { owner: shorthand[1], repo } : null;
  }

  return null;
}

/** `owner/repo`, the short label shown next to an installed plugin. */
export function formatGitHubRepo(location: Pick<GitHubPluginLocation, 'owner' | 'repo'>): string {
  return `${location.owner}/${location.repo}`;
}
