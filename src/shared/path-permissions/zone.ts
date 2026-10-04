/**
 * @module shared/path-permissions/zone
 *
 * The write zone: the set of directories the agent may write to without being
 * asked (`trustedDirectories`), resolved to real paths, plus the files that
 * always ask. See docs/design/trusted-directories.md.
 *
 * Node-standalone; NOT renderer-safe (uses the fs-aware resolver).
 */
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { isPathWithinRoot, normalizePathForContainment } from './containment';
import {
  isCaseInsensitivePlatform,
  normalizeWindowsShellPath,
  realpathExistingPortion,
  type ResolveOptions,
} from './resolve';

/** Why a configured directory was not accepted. */
export type RejectedDirectoryReason =
  /** A project-file entry that resolves outside the project. */
  | 'outside-project'
  /** The file-system root, the home directory, or a directory containing it. */
  | 'too-broad'
  /** A relative entry while the session's working directory is unknown. */
  | 'needs-working-directory'
  /** The location could not be established (permission error, link loop). */
  | 'unresolvable';

export interface RejectedDirectory {
  entry: string;
  reason: RejectedDirectoryReason;
}

export interface WriteZone {
  /**
   * True when the list was written non-empty — even if every entry was then
   * rejected. A rejected entry must never switch the checks off: with no
   * accepted directory left, every write is outside and asks.
   */
  enabled: boolean;
  /** Real absolute paths of the accepted directories. */
  roots: string[];
  /** Real absolute paths of files that always ask, even inside a root. */
  protectedFiles: string[];
  /** Entries that were not accepted, for a one-time warning. */
  rejected: RejectedDirectory[];
  /** Whether paths are compared ignoring letter case (Windows, macOS). */
  caseInsensitive: boolean;
}

export const DISABLED_WRITE_ZONE: Readonly<WriteZone> = Object.freeze({
  enabled: false,
  roots: [],
  protectedFiles: [],
  rejected: [],
  caseInsensitive: false,
});

export interface BuildWriteZoneInput extends ResolveOptions {
  /** Entries that may name any directory: the global config file, or the app's settings. */
  entries: readonly string[];
  /** Entries from a project config file — accepted only inside `projectDir`. */
  projectEntries?: readonly string[];
  /** The session's working directory; relative entries resolve against it. */
  cwd: string | undefined;
  /** Directory that project entries must stay inside. Defaults to `cwd`. */
  projectDir?: string;
  /** Files that always ask (the gate's own settings files). */
  protectedFiles?: readonly string[];
}

export type PathZone = 'inside' | 'outside' | 'protected';

function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  return (
    normalizePathForContainment(a, caseInsensitive) ===
    normalizePathForContainment(b, caseInsensitive)
  );
}

function expandHome(entry: string, home: string, platform: NodeJS.Platform): string {
  if (entry === '~') return home;
  if (entry.startsWith('~/') || (platform === 'win32' && entry.startsWith('~\\'))) {
    return nodePath.join(home, entry.slice(2));
  }
  return entry;
}

/**
 * Resolve the configured directory list into a write zone.
 *
 * Rejections (the entry is dropped, the zone stays enabled):
 *   - a project entry whose real path is outside the project;
 *   - an entry that is the file-system root, the home directory, or a directory
 *     containing the home directory — also when it got there through `./`;
 *   - a relative entry while the working directory is unknown;
 *   - an entry whose location cannot be established.
 */
export function buildWriteZone(input: BuildWriteZoneInput): WriteZone {
  const platform = input.platform ?? process.platform;
  const caseInsensitive = isCaseInsensitivePlatform(platform);
  const home = input.homeDir ?? homedir();
  const realHome = realpathExistingPortion(home) ?? home;

  const entries = input.entries.filter((e) => typeof e === 'string' && e.trim());
  const projectEntries = (input.projectEntries ?? []).filter(
    (e) => typeof e === 'string' && e.trim()
  );

  const enabled = entries.length + projectEntries.length > 0;
  if (!enabled) return { ...DISABLED_WRITE_ZONE, caseInsensitive };

  const projectDir = input.projectDir ?? input.cwd;
  const realProjectDir = projectDir ? realpathExistingPortion(projectDir) : null;

  const roots: string[] = [];
  const rejected: RejectedDirectory[] = [];

  const accept = (rawEntry: string, mustBeInsideProject: boolean): void => {
    const entry = rawEntry.trim();
    let candidate = expandHome(entry, home, platform);
    if (platform === 'win32') candidate = normalizeWindowsShellPath(candidate);

    if (!nodePath.isAbsolute(candidate)) {
      if (!input.cwd) {
        rejected.push({ entry, reason: 'needs-working-directory' });
        return;
      }
      candidate = nodePath.resolve(input.cwd, candidate);
    } else {
      candidate = nodePath.resolve(candidate);
    }

    const real = realpathExistingPortion(candidate);
    if (!real) {
      rejected.push({ entry, reason: 'unresolvable' });
      return;
    }

    const isFileSystemRoot = nodePath.parse(real).root === real;
    if (isFileSystemRoot || isPathWithinRoot(realHome, real, caseInsensitive)) {
      rejected.push({ entry, reason: 'too-broad' });
      return;
    }

    if (
      mustBeInsideProject &&
      (!realProjectDir || !isPathWithinRoot(real, realProjectDir, caseInsensitive))
    ) {
      rejected.push({ entry, reason: 'outside-project' });
      return;
    }

    if (!roots.some((r) => samePath(r, real, caseInsensitive))) roots.push(real);
  };

  for (const entry of entries) accept(entry, false);
  for (const entry of projectEntries) accept(entry, true);

  const protectedFiles: string[] = [];
  for (const file of input.protectedFiles ?? []) {
    if (typeof file !== 'string' || !file) continue;
    const absolute = nodePath.resolve(file);
    protectedFiles.push(realpathExistingPortion(absolute) ?? absolute);
  }

  return { enabled, roots, protectedFiles, rejected, caseInsensitive };
}

/** Classify a real absolute path against the zone. */
export function classifyRealPath(realPath: string, zone: WriteZone): PathZone {
  if (zone.protectedFiles.some((f) => samePath(f, realPath, zone.caseInsensitive))) {
    return 'protected';
  }
  return zone.roots.some((root) => isPathWithinRoot(realPath, root, zone.caseInsensitive))
    ? 'inside'
    : 'outside';
}

/**
 * Resolve an absolute path to its real location and classify it. `zone` is
 * null when the location cannot be established — the caller asks.
 */
export function classifyAbsolutePath(
  absPath: string,
  zone: WriteZone
): { zone: PathZone | null; realPath: string | null } {
  const realPath = realpathExistingPortion(absPath);
  if (!realPath) return { zone: null, realPath: null };
  return { zone: classifyRealPath(realPath, zone), realPath };
}

/** One-line text for a rejected entry, for warnings shown to the user. */
export function describeRejectedDirectory(rejected: RejectedDirectory): string {
  switch (rejected.reason) {
    case 'outside-project':
      return `"${rejected.entry}" is outside the project; a project file may only list directories inside it`;
    case 'too-broad':
      return `"${rejected.entry}" is the file-system root or contains the home directory`;
    case 'needs-working-directory':
      return `"${rejected.entry}" is relative and the working directory is unknown`;
    default:
      return `"${rejected.entry}" could not be resolved`;
  }
}
