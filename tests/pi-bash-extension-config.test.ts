import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BASH_RESTRICTIONS_SETTINGS } from '../src/shared/bash-restrictions';
import {
  loadBashRestrictionsSettings,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
} from '../pi-extensions/bash-restrictions/config';

/**
 * Unit tests for the pi bash-restrictions extension config loader.
 *
 * Each test gets a fresh pair of temp directories so tests are fully isolated
 * and never touch the real ~/.pi directory. The optional `homeDir` parameter on
 * loadBashRestrictionsSettings redirects global config reads to the temp home.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpProject: string;

beforeEach(() => {
  // mkdtempSync creates unique directories atomically — no collision risk under
  // parallel test execution.
  tmpHome = mkdtempSync(join(tmpdir(), 'pi-cfg-home-'));
  tmpProject = mkdtempSync(join(tmpdir(), 'pi-cfg-proj-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
});

/** Write content to the global config file (creates parent dirs). */
function writeGlobal(content: unknown): void {
  const dir = join(tmpHome, '.pi', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bash-restrictions.json'), JSON.stringify(content));
}

/** Write content to the project config file (creates parent dir). */
function writeProject(content: unknown): void {
  const dir = join(tmpProject, '.pi');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bash-restrictions.json'), JSON.stringify(content));
}

/** Write raw bytes to the global config (for malformed-JSON tests). */
function writeGlobalRaw(bytes: string): void {
  const dir = join(tmpHome, '.pi', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bash-restrictions.json'), bytes);
}

/** Write raw bytes to the project config (for malformed-JSON tests). */
function writeProjectRaw(bytes: string): void {
  const dir = join(tmpProject, '.pi');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bash-restrictions.json'), bytes);
}

/** Run the loader against the temp home + temp project. */
function load() {
  return loadBashRestrictionsSettings(tmpProject, { homeDir: tmpHome });
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('path resolution', () => {
  it('resolveGlobalConfigPath uses the provided homeDir', () => {
    const home = join('/', 'custom', 'home');
    expect(resolveGlobalConfigPath(home)).toBe(
      join(home, '.pi', 'agent', 'bash-restrictions.json')
    );
  });

  it('resolveProjectConfigPath appends .pi/bash-restrictions.json to cwd', () => {
    const cwd = join('/', 'my', 'project');
    expect(resolveProjectConfigPath(cwd)).toBe(join(cwd, '.pi', 'bash-restrictions.json'));
  });
});

// ---------------------------------------------------------------------------
// Absent files → defaults
// ---------------------------------------------------------------------------

describe('absent files', () => {
  it('returns DEFAULT_BASH_RESTRICTIONS_SETTINGS when both files are absent', () => {
    expect(load()).toEqual(DEFAULT_BASH_RESTRICTIONS_SETTINGS);
  });

  it('returns defaults when only the .pi directories do not exist', () => {
    // tmpHome and tmpProject exist but have no .pi sub-directories
    const result = load();
    expect(result.trusted).toEqual([]);
    expect(result.denied).toEqual([]);
    expect(result.permissionTimeoutSeconds).toBe(
      DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds
    );
  });

  it('does not throw when called without the options argument (uses real homedir)', () => {
    // Production call path — no homeDir override. The real ~/.pi/agent/... file
    // probably does not exist in CI, so we just assert no throw + valid shape.
    expect(() => loadBashRestrictionsSettings(tmpProject)).not.toThrow();
    const result = loadBashRestrictionsSettings(tmpProject);
    expect(Array.isArray(result.trusted)).toBe(true);
    expect(Array.isArray(result.denied)).toBe(true);
    expect(typeof result.permissionTimeoutSeconds).toBe('number');
  });

  it('does not throw when homeDir is whitespace-only (falls back to real homedir)', () => {
    // Whitespace homeDir is treated as unset; loader must not crash.
    expect(() => loadBashRestrictionsSettings(tmpProject, { homeDir: '   ' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON → tolerated
// ---------------------------------------------------------------------------

describe('malformed JSON', () => {
  it('tolerates malformed global JSON and returns defaults', () => {
    writeGlobalRaw('{ not valid json }');
    expect(load()).toEqual(DEFAULT_BASH_RESTRICTIONS_SETTINGS);
  });

  it('tolerates malformed project JSON and returns defaults', () => {
    writeProjectRaw('not json at all');
    expect(load()).toEqual(DEFAULT_BASH_RESTRICTIONS_SETTINGS);
  });

  it('uses global settings when project JSON is malformed', () => {
    writeGlobal({ trusted: ['npm *'], denied: ['rm'] });
    writeProjectRaw('///bad');
    const result = load();
    expect(result.trusted).toEqual(['npm *']);
    expect(result.denied).toEqual(['rm']);
  });

  it('uses project settings when global JSON is malformed', () => {
    writeGlobalRaw('{ bad }');
    writeProject({ trusted: ['git *'], denied: ['sudo'] });
    const result = load();
    expect(result.trusted).toEqual(['git *']);
    expect(result.denied).toEqual(['sudo']);
  });

  it('treats a JSON array at the root as malformed (not a settings object)', () => {
    writeGlobalRaw('["not", "an", "object"]');
    expect(load()).toEqual(DEFAULT_BASH_RESTRICTIONS_SETTINGS);
  });

  it('treats a JSON string at the root as malformed', () => {
    writeProjectRaw('"just a string"');
    expect(load()).toEqual(DEFAULT_BASH_RESTRICTIONS_SETTINGS);
  });
});

// ---------------------------------------------------------------------------
// Global-only config
// ---------------------------------------------------------------------------

describe('global-only config', () => {
  it('returns global settings when only the global file exists', () => {
    writeGlobal({ trusted: ['ls *', 'cat *'], denied: ['rm', 'sudo'] });
    const result = load();
    expect(result.trusted).toEqual(['ls *', 'cat *']);
    expect(result.denied).toEqual(['rm', 'sudo']);
  });

  it('uses global permissionTimeoutSeconds when only global file exists', () => {
    writeGlobal({ permissionTimeoutSeconds: 600 });
    expect(load().permissionTimeoutSeconds).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// Project-only config
// ---------------------------------------------------------------------------

describe('project-only config', () => {
  it('returns project settings when only the project file exists', () => {
    writeProject({ trusted: ['npm *'], denied: ['--force'] });
    const result = load();
    expect(result.trusted).toEqual(['npm *']);
    expect(result.denied).toEqual(['--force']);
  });

  it('uses project permissionTimeoutSeconds when only project file exists', () => {
    writeProject({ permissionTimeoutSeconds: 120 });
    expect(load().permissionTimeoutSeconds).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// List union (trusted + denied)
// ---------------------------------------------------------------------------

describe('list union (trusted + denied)', () => {
  it('unions trusted lists — global entries appear first', () => {
    writeGlobal({ trusted: ['ls *', 'cat *'] });
    writeProject({ trusted: ['npm *', 'cat *'] }); // 'cat *' duplicated
    expect(load().trusted).toEqual(['ls *', 'cat *', 'npm *']);
  });

  it('unions denied lists — global entries appear first', () => {
    writeGlobal({ denied: ['rm', 'sudo'] });
    writeProject({ denied: ['sudo', '--force'] }); // 'sudo' duplicated
    expect(load().denied).toEqual(['rm', 'sudo', '--force']);
  });

  it('deduplicates identical entries appearing in both files', () => {
    writeGlobal({ trusted: ['npm *', 'git *'] });
    writeProject({ trusted: ['npm *', 'git *'] }); // fully identical
    expect(load().trusted).toEqual(['npm *', 'git *']);
  });

  it('produces empty lists when neither config contains list entries', () => {
    writeGlobal({ permissionTimeoutSeconds: 120 });
    writeProject({ permissionTimeoutSeconds: 60 });
    const result = load();
    expect(result.trusted).toEqual([]);
    expect(result.denied).toEqual([]);
  });

  it('keeps global-only trusted entries when project has none', () => {
    writeGlobal({ trusted: ['ls *'] });
    writeProject({ denied: ['rm'] });
    expect(load().trusted).toEqual(['ls *']);
    expect(load().denied).toEqual(['rm']);
  });
});

// ---------------------------------------------------------------------------
// permissionTimeoutSeconds merge
// ---------------------------------------------------------------------------

describe('permissionTimeoutSeconds merge', () => {
  it('project value overrides global when both are present', () => {
    writeGlobal({ permissionTimeoutSeconds: 600 });
    writeProject({ permissionTimeoutSeconds: 120 });
    expect(load().permissionTimeoutSeconds).toBe(120);
  });

  it('uses global value when project file exists but omits the field', () => {
    writeGlobal({ permissionTimeoutSeconds: 600 });
    writeProject({ trusted: ['npm *'] }); // no permissionTimeoutSeconds key
    expect(load().permissionTimeoutSeconds).toBe(600);
  });

  it('uses shared default when neither file sets the field', () => {
    writeGlobal({ trusted: ['ls *'] });
    writeProject({ trusted: ['npm *'] });
    expect(load().permissionTimeoutSeconds).toBe(
      DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds
    );
  });

  it('project value of 0 (infinite) is honored and overrides global', () => {
    writeGlobal({ permissionTimeoutSeconds: 300 });
    writeProject({ permissionTimeoutSeconds: 0 }); // explicit 0 must win
    expect(load().permissionTimeoutSeconds).toBe(0);
  });

  it('global value of 0 (infinite) is honored when project omits the field', () => {
    writeGlobal({ permissionTimeoutSeconds: 0 });
    writeProject({ trusted: ['git *'] });
    expect(load().permissionTimeoutSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('normalization', () => {
  it('clamps an out-of-range global timeout to the maximum (3600)', () => {
    writeGlobal({ permissionTimeoutSeconds: 9999 });
    expect(load().permissionTimeoutSeconds).toBe(3600);
  });

  it('clamps an out-of-range project timeout to the minimum (10)', () => {
    writeProject({ permissionTimeoutSeconds: 3 });
    expect(load().permissionTimeoutSeconds).toBe(10);
  });

  it('falls back to default for a non-numeric timeout', () => {
    writeProject({ permissionTimeoutSeconds: 'forever' });
    expect(load().permissionTimeoutSeconds).toBe(
      DEFAULT_BASH_RESTRICTIONS_SETTINGS.permissionTimeoutSeconds
    );
  });

  it('strips non-string entries from trusted/denied lists', () => {
    writeGlobal({ trusted: ['npm *', 42, null, 'git *'], denied: [true, 'rm'] });
    const result = load();
    expect(result.trusted).toEqual(['npm *', 'git *']);
    expect(result.denied).toEqual(['rm']);
  });

  it('strips whitespace-only and empty entries from lists', () => {
    writeGlobal({ trusted: ['  ', 'npm *', '', '\t'] });
    expect(load().trusted).toEqual(['npm *']);
  });

  it('trims leading/trailing whitespace from list entries', () => {
    writeGlobal({ trusted: ['  npm *  ', '  git *  '] });
    expect(load().trusted).toEqual(['npm *', 'git *']);
  });
});

// ---------------------------------------------------------------------------
// Canonical shape
// ---------------------------------------------------------------------------

describe('canonical shape', () => {
  it('always returns an object with all three required fields', () => {
    const result = load();
    expect(result).toHaveProperty('trusted');
    expect(result).toHaveProperty('denied');
    expect(result).toHaveProperty('permissionTimeoutSeconds');
  });

  it('trusted and denied are always arrays', () => {
    const result = load();
    expect(Array.isArray(result.trusted)).toBe(true);
    expect(Array.isArray(result.denied)).toBe(true);
  });

  it('permissionTimeoutSeconds is always a finite number', () => {
    const result = load();
    expect(typeof result.permissionTimeoutSeconds).toBe('number');
    expect(Number.isFinite(result.permissionTimeoutSeconds)).toBe(true);
  });

  it('extra unknown fields in the config file are ignored', () => {
    writeGlobal({ trusted: ['ls *'], unknownFutureField: 'ignored', anotherExtra: 123 });
    const result = load();
    expect(result).not.toHaveProperty('unknownFutureField');
    expect(result).not.toHaveProperty('anotherExtra');
    expect(result.trusted).toEqual(['ls *']);
  });
});
