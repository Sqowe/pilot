/**
 * @module main/claude/skill-paths
 *
 * Assembles the skill paths handed to pi. Since pi's own skill discovery is off
 * (`noSkills`, see pi-resource-loader.ts), this list is the only way a skill reaches a
 * session, so it decides what the agent sees.
 *
 * Order matters: pi keeps the first skill of a given name and drops later ones. The
 * runtime skills dir (`<userData>/claude/skills`) goes first — it holds the set the app
 * already resolved: built-ins, `~/.claude/skills` and the configured path, merged by the
 * Conflict Resolution policy, with globally disabled skills removed. Raw source folders and
 * plugin folders come after it.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Source prefixes a disabled skill ID may carry in the UI (e.g. `builtin-pdf`). */
const KNOWN_SKILL_ID_PREFIXES = ['builtin-', 'global-', 'configured-', 'project-'];

export interface SkillPathsInput {
  /** The runtime skills dir; always first. */
  runtimeDir: string;
  /** Further skill folders, in order (built-in, configured, …). */
  basePaths: ReadonlyArray<string | undefined | null>;
  /** Skill folders of enabled plugins. */
  pluginPaths: ReadonlyArray<string>;
  /** Skills disabled for this session — bare names or prefixed IDs. */
  sessionDisabled: ReadonlyArray<string>;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Bare directory names for the disabled IDs, prefixes stripped. */
function disabledNamesOf(ids: ReadonlyArray<string>): Set<string> {
  const names = new Set<string>();
  for (const id of ids) {
    names.add(id);
    const prefix = KNOWN_SKILL_ID_PREFIXES.find((p) => id.startsWith(p));
    if (prefix) names.add(id.substring(prefix.length));
  }
  return names;
}

/**
 * The skill paths for pi: runtime dir first, then the base and plugin folders, each listed
 * once and only if it exists. With session-disabled skills, every folder is expanded into
 * its skill directories minus the disabled ones — following symlinks, which is what the
 * runtime dir is mostly made of.
 */
export function assembleSkillPaths(input: SkillPathsInput): string[] {
  const merged = new Set<string>();
  for (const candidate of [input.runtimeDir, ...input.basePaths, ...input.pluginPaths]) {
    if (candidate && fs.existsSync(candidate)) merged.add(candidate);
  }

  if (input.sessionDisabled.length === 0) {
    return Array.from(merged);
  }

  const disabledNames = disabledNamesOf(input.sessionDisabled);
  const expanded: string[] = [];
  for (const skillPath of merged) {
    // A single skill directory (has SKILL.md itself) — keep or drop it by its name.
    if (fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
      if (!disabledNames.has(path.basename(skillPath))) expanded.push(skillPath);
      continue;
    }
    // A folder of skills — list its skill directories, minus the disabled ones.
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillPath, { withFileTypes: true });
    } catch {
      // Unreadable: keep the folder as it is rather than lose its skills.
      expanded.push(skillPath);
      continue;
    }
    for (const entry of entries) {
      if (disabledNames.has(entry.name)) continue;
      const childPath = path.join(skillPath, entry.name);
      // Dirent reports a symlink as a link, not a directory — follow it.
      const isSkillDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(childPath));
      if (isSkillDir) expanded.push(childPath);
    }
  }
  return expanded;
}
