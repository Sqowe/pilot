/**
 * @module main/skills/builtin-skills-path
 *
 * Single source of truth for the directory holding the skills shipped with the app.
 *
 * Source lives at `<project>/resources/skills`; electron-builder copies it to
 * `<Resources>/skills` via each platform's `extraResources` (see electron-builder.yml).
 * The directory cannot appear or move while the app runs, so the lookup is cached.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { log, logWarn } from '../utils/logger';

let cached: string | null = null;

/**
 * Absolute path to the built-in skills directory, or '' when it is missing.
 */
export function getBuiltinSkillsPath(): string {
  if (cached !== null) return cached;

  const candidate = app.isPackaged
    ? path.join(process.resourcesPath || '', 'skills')
    : // Development: app.getAppPath() is the project root
      path.join(app.getAppPath(), 'resources', 'skills');

  if (fs.existsSync(candidate)) {
    log('[builtin-skills] Found built-in skills at:', candidate);
    cached = candidate;
  } else {
    logWarn('[builtin-skills] No built-in skills directory at:', candidate);
    cached = '';
  }

  return cached;
}
