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
 * Conflict Resolution policy. Raw source folders and plugin folders come after it.
 *
 * Disabled skills — for the session and in the app's settings — are filtered out here, not
 * only removed from the runtime dir: the raw folders still hold them, and the runtime dir
 * itself is not reliably clean (SkillsManager re-links `~/.claude/skills` entries into it on
 * every listing, and a copied user skill is never deleted from it).
 *
 * Every folder is expanded into its skill entries, so the list — and the cached session's
 * `skillsSignature` built from it — changes whenever a skill is added, removed or disabled.
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
  /** Skills disabled in the app's settings (`skillConflictConfig.disabledSkills`). */
  globallyDisabled: ReadonlyArray<string>;
}

function statOf(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
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
 * once and only if it exists, every one expanded into its entries minus the disabled ones.
 *
 * The expansion takes what pi's own walk takes from a folder's top level
 * (`loadSkillsFromDirInternal` in pi-coding-agent/dist/core/skills.js): directories and
 * links to directories, plus `.md` files; entries starting with `.` and `node_modules` are
 * skipped. An ignore file at a folder's own root no longer applies to its entries — none of
 * the app's folders has one.
 */
export function assembleSkillPaths(input: SkillPathsInput): string[] {
  const merged = new Set<string>();
  for (const candidate of [input.runtimeDir, ...input.basePaths, ...input.pluginPaths]) {
    if (candidate && fs.existsSync(candidate)) merged.add(candidate);
  }

  const disabledNames = disabledNamesOf([...input.sessionDisabled, ...input.globallyDisabled]);
  const expanded: string[] = [];
  for (const skillPath of merged) {
    // A single skill directory (has SKILL.md itself) — keep or drop it by its name.
    if (fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
      if (!disabledNames.has(path.basename(skillPath))) expanded.push(skillPath);
      continue;
    }
    // A folder of skills — list its entries, minus the disabled ones.
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillPath, { withFileTypes: true });
    } catch {
      // Unreadable: keep the folder as it is rather than lose its skills.
      expanded.push(skillPath);
      continue;
    }
    // Sorted: readdir order is up to the file system, and the list is a cache signature.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const childPath = path.join(skillPath, entry.name);
      // Dirent reports a symlink as a link, not a directory — follow it.
      const stats = entry.isSymbolicLink() ? statOf(childPath) : null;
      const isDirectory = entry.isDirectory() || stats?.isDirectory() === true;
      const isMarkdown = (entry.isFile() || stats?.isFile() === true) && entry.name.endsWith('.md');
      const name = isMarkdown ? entry.name.slice(0, -'.md'.length) : entry.name;
      if ((isDirectory || isMarkdown) && !disabledNames.has(name)) expanded.push(childPath);
    }
  }
  return expanded;
}
