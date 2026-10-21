/**
 * @module main/skills/retired-builtin-skills
 *
 * Built-in skills the app no longer ships, and the clean-up of what earlier versions left
 * of them in the runtime skills dir (`<userData>/claude/skills`).
 *
 * Each built-in used to be linked into that dir, or copied where a link could not be made
 * (Windows without developer mode). A copy would keep loading as if the skill were still
 * shipped, and so would a link while the build it points into is still on disk. The
 * runner's built-in sync walks the bundled folder only, so it never sees these entries; this
 * module removes them by name.
 */
import * as fs from 'fs';
import * as path from 'path';
import { log, logWarn } from '../utils/logger';

export const RETIRED_BUILTIN_SKILLS: readonly string[] = [
  // Manual memory through Python scripts writing markdown files; the in-app memory
  // (MemoryExtension) replaced it. Removed 2026-10-21.
  'cowork-memory',
];

/** Written into a runtime copy of a built-in by the runner's built-in sync. */
const BUILTIN_HASH_STAMP = '.builtin-hash';
/** Marks a runtime copy the user protected from updates. */
const USER_MODIFIED_MARKER = '.user-modified';

/** Whether a link points, alive, at a skill directly inside one of the given folders. */
function isLiveLinkInto(linkPath: string, folders: readonly string[]): boolean {
  if (!fs.existsSync(linkPath)) return false;
  const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  return folders.some((folder) => path.dirname(target) === path.resolve(folder));
}

/**
 * Remove the runtime-dir entries of retired built-ins: a link, unless it is a live link into
 * one of `userSkillSources` (`~/.claude/skills`, the configured folder) — that is the user's
 * own skill of the same name, linked by the sync — and a copy the app made (it carries the
 * built-in hash stamp). A live link elsewhere is removed too: it points into an older app
 * build that is still on disk (the installed app seen from a development build, or the
 * previous version's folder a Windows update keeps). Left alone: a copy the user protected
 * from updates, and a directory the app did not make. Returns the paths removed.
 */
export function removeRetiredBuiltinSkills(
  runtimeDir: string,
  userSkillSources: readonly string[],
  retired: readonly string[] = RETIRED_BUILTIN_SKILLS
): string[] {
  const removed: string[] = [];
  for (const name of retired) {
    const entryPath = path.join(runtimeDir, name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch {
      continue; // Not there.
    }
    try {
      if (stats.isSymbolicLink()) {
        if (isLiveLinkInto(entryPath, userSkillSources)) continue; // The user's own skill.
        fs.unlinkSync(entryPath);
      } else if (stats.isDirectory()) {
        if (!fs.existsSync(path.join(entryPath, BUILTIN_HASH_STAMP))) continue;
        if (fs.existsSync(path.join(entryPath, USER_MODIFIED_MARKER))) {
          logWarn(
            `[Skills] Keeping the protected copy of retired built-in skill "${name}": ${entryPath}`
          );
          continue;
        }
        fs.rmSync(entryPath, { recursive: true, force: true });
      } else {
        continue;
      }
      removed.push(entryPath);
      log(`[Skills] Removed retired built-in skill: ${entryPath}`);
    } catch (err) {
      logWarn(`[Skills] Could not remove retired built-in skill ${entryPath}:`, err);
    }
  }
  return removed;
}
