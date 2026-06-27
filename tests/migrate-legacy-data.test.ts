import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { migrateLegacyData, isForkInstall } from '../src/main/migration/migrate-legacy-data';

const VERSION = '1.0.0';

describe('migrateLegacyData', () => {
  let root: string;
  let newDir: string;
  let legacyDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqowe-migrate-'));
    newDir = path.join(root, 'sqowe-pilot');
    legacyDir = path.join(root, 'open-cowork');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeForkLegacy(): void {
    fs.mkdirSync(path.join(legacyDir, 'prompts'), { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'prompts', 'identity.md'),
      'You are Sqowe Pilot (Open Cowork fork) — a desktop AI assistant.',
      'utf-8'
    );
    fs.writeFileSync(path.join(legacyDir, 'config.json'), '{"apiKey":"secret"}', 'utf-8');
  }

  function readBrand(dir: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(dir, '.brand'), 'utf-8'));
  }

  it('copies fork data and writes .brand when legacy is present and new is empty', () => {
    makeForkLegacy();
    fs.mkdirSync(path.join(legacyDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'memory', 'core.json'), 'CORE', 'utf-8');
    // logs/ and *cache* must be skipped
    fs.mkdirSync(path.join(legacyDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'logs', 'app.log'), 'noise', 'utf-8');
    fs.mkdirSync(path.join(legacyDir, 'http-cache'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'http-cache', 'blob'), 'noise', 'utf-8');

    const result = migrateLegacyData({ newDir, legacyDir, version: VERSION });

    expect(result.outcome).toBe('migrated');
    expect(result.filesCopied).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8')).toBe('{"apiKey":"secret"}');
    expect(fs.readFileSync(path.join(newDir, 'memory', 'core.json'), 'utf-8')).toBe('CORE');
    expect(fs.existsSync(path.join(newDir, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(newDir, 'http-cache'))).toBe(false);

    const brand = readBrand(newDir);
    expect(brand.product).toBe('sqowe-pilot');
    expect(brand.migratedFrom).toBe('open-cowork');
    expect(brand.version).toBe(VERSION);
  });

  it('skips a pristine upstream legacy install (no fingerprint) and writes no .brand', () => {
    fs.mkdirSync(path.join(legacyDir, 'prompts'), { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'prompts', 'identity.md'),
      'You are an Open Cowork assistant.',
      'utf-8'
    );
    fs.writeFileSync(path.join(legacyDir, 'config.json'), '{"apiKey":"upstream"}', 'utf-8');

    const result = migrateLegacyData({ newDir, legacyDir, version: VERSION });

    expect(result.outcome).toBe('skipped-not-fork');
    expect(result.filesCopied).toBe(0);
    expect(fs.existsSync(path.join(newDir, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(newDir, '.brand'))).toBe(false);
  });

  it('is a no-op when the new dir is already branded', () => {
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(
      path.join(newDir, '.brand'),
      JSON.stringify({ product: 'sqowe-pilot' }),
      'utf-8'
    );
    makeForkLegacy();

    const result = migrateLegacyData({ newDir, legacyDir, version: VERSION });

    expect(result.outcome).toBe('already-branded');
    expect(result.filesCopied).toBe(0);
    // legacy data must not have been copied
    expect(fs.existsSync(path.join(newDir, 'config.json'))).toBe(false);
  });

  it('stamps .brand without copying for a fresh sqowe install (config in new dir, no legacy)', () => {
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'config.json'), '{"apiKey":"fresh"}', 'utf-8');

    const result = migrateLegacyData({ newDir, legacyDir, version: VERSION });

    expect(result.outcome).toBe('fresh-install-stamped');
    expect(result.filesCopied).toBe(0);
    expect(readBrand(newDir).migratedFrom).toBeNull();
    // existing config must be preserved untouched
    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8')).toBe('{"apiKey":"fresh"}');
  });

  it('stamps .brand on a clean machine with no legacy directory', () => {
    const result = migrateLegacyData({ newDir, legacyDir, version: VERSION });

    expect(result.outcome).toBe('clean-machine-stamped');
    expect(result.filesCopied).toBe(0);
    expect(readBrand(newDir).migratedFrom).toBeNull();
  });

  it('never overwrites a file that already exists in the new dir', () => {
    makeForkLegacy();
    fs.mkdirSync(path.join(legacyDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'memory', 'core.json'), 'OLD', 'utf-8');
    // Pre-existing file in the new dir (but no config.json / .brand, so a copy runs)
    fs.mkdirSync(path.join(newDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(newDir, 'memory', 'core.json'), 'NEW', 'utf-8');

    const result = migrateLegacyData({ newDir, legacyDir, version: VERSION });

    expect(result.outcome).toBe('migrated');
    expect(fs.readFileSync(path.join(newDir, 'memory', 'core.json'), 'utf-8')).toBe('NEW');
    // a file that did not exist yet is still copied
    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf-8')).toBe('{"apiKey":"secret"}');
  });
});

describe('isForkInstall', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqowe-fork-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects the Sqowe identity fingerprint', () => {
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompts', 'identity.md'), 'You are Sqowe Pilot.', 'utf-8');
    expect(isForkInstall(dir)).toBe(true);
  });

  it('detects a forward-compatible .brand marker', () => {
    fs.writeFileSync(path.join(dir, '.brand'), '{}', 'utf-8');
    expect(isForkInstall(dir)).toBe(true);
  });

  it('returns false for a pristine upstream install', () => {
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompts', 'identity.md'), 'Open Cowork assistant.', 'utf-8');
    expect(isForkInstall(dir)).toBe(false);
  });
});
