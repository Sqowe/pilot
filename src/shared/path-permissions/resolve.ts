/**
 * @module shared/path-permissions/resolve
 *
 * Turns a path as written (by a tool call or in a bash command) into the real
 * absolute path it refers to, so it can be compared against the trusted
 * directories.
 *
 * Node-standalone (node:fs / node:os / node:path / node:url). NOT renderer-safe:
 * no renderer code may import this module. No electron, no pi-ai, no app config.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ResolveOptions {
  /** Override for the home directory (tests). Defaults to os.homedir(). */
  homeDir?: string;
  /** Override for the platform (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Maximum number of dangling symbolic links followed by hand before giving up. */
const MAX_LINK_HOPS = 40;

function pathApi(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** True on platforms whose default file systems ignore letter case. */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * Convert Git Bash, MSYS, Cygwin and WSL drive paths (`/c/x`, `/mnt/c/x`,
 * `/cygdrive/c/x`) to the form native Windows APIs accept (`C:\x`).
 *
 * Mirrors pi's `normalizeWindowsShellPath` (`dist/utils/paths.js`, pi 0.85.1).
 */
export function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replace(/\//g, '\\');
  return `${match[1].toUpperCase()}:\\${suffix ?? ''}`;
}

/** Mirrors pi's `normalizePath` (`dist/utils/paths.js`, pi 0.85.1). */
function normalizeLikePi(
  input: string,
  flags: { normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean },
  platform: NodeJS.Platform,
  home: string
): string {
  let normalized = input;
  if (flags.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, ' ');
  }
  if (flags.stripAtPrefix && normalized.startsWith('@')) {
    normalized = normalized.slice(1);
  }
  if (platform === 'win32') {
    normalized = normalizeWindowsShellPath(normalized);
  }
  if (normalized === '~') return home;
  if (normalized.startsWith('~/') || (platform === 'win32' && normalized.startsWith('~\\'))) {
    return pathApi(platform).join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

/**
 * Resolve the `path` argument of pi's `write` / `edit` tools exactly the way
 * pi does before it touches the file.
 *
 * This is a MIRROR of pi's `resolveToCwd(path, cwd)`
 * (`dist/core/tools/path-utils.js` → `resolvePath` in `dist/utils/paths.js`,
 * pi 0.85.1), which the package does not export. The check and the tool must
 * read the same string the same way — otherwise the check approves one path
 * while the tool writes another. `tests/path-permissions-pi-parity.test.ts`
 * pins the mirror; re-check it on every pi upgrade.
 *
 * Returns null when the path cannot be resolved (for example a malformed
 * `file://` URL); callers treat that as "cannot be determined".
 */
export function resolveToolPath(
  rawPath: string,
  cwd: string,
  options: ResolveOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const api = pathApi(platform);
  try {
    const normalized = normalizeLikePi(
      rawPath,
      { normalizeUnicodeSpaces: true, stripAtPrefix: true },
      platform,
      home
    );
    const normalizedBase = normalizeLikePi(cwd, {}, platform, home);
    return api.isAbsolute(normalized)
      ? api.resolve(normalized)
      : api.resolve(normalizedBase, normalized);
  } catch {
    return null;
  }
}

/**
 * Resolve a path taken from a bash command (a redirection target, a `tee`
 * operand, a `cd` operand) against the directory the command runs in.
 *
 * The caller has already removed quotes and expanded `~` / `$HOME`. Unlike
 * `resolveToolPath` this applies none of pi's tool-specific rewrites (`@`
 * prefix, unicode spaces, `file://`) — bash does not apply them either.
 */
export function resolveShellPath(
  word: string,
  baseDir: string,
  options: ResolveOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const normalized = platform === 'win32' ? normalizeWindowsShellPath(word) : word;
  return api.isAbsolute(normalized) ? api.resolve(normalized) : api.resolve(baseDir, normalized);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Real path of `absPath`, following symbolic links, for a target that may not
 * exist yet: resolves the longest existing ancestor and appends the rest.
 *
 * A symbolic link whose destination does not exist is followed by hand —
 * writing through such a link creates the file at the link's destination, so
 * treating the link as an ordinary missing file would report the wrong place.
 *
 * Returns null when the location cannot be established (permission error,
 * link loop). Callers treat null as "cannot be determined" and ask.
 */
export function realpathExistingPortion(absPath: string): string | null {
  let current = absPath;
  const tail: string[] = [];
  let hops = 0;

  for (;;) {
    try {
      // `.native` also returns the on-disk letter case on macOS and Windows.
      const real = realpathSync.native(current);
      return tail.length > 0 ? nodePath.join(real, ...tail.slice().reverse()) : real;
    } catch (err) {
      const code = errorCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }

    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (err) {
      const code = errorCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }

    if (isLink) {
      hops += 1;
      if (hops > MAX_LINK_HOPS) return null;
      let destination: string;
      try {
        destination = readlinkSync(current);
      } catch {
        return null;
      }
      current = nodePath.resolve(nodePath.dirname(current), destination);
      continue;
    }

    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    tail.push(nodePath.basename(current));
    current = parent;
  }
}
