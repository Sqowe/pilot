import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => testRoot,
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => {
      if (name === 'userData') return path.join(testRoot, 'userData');
      if (name === 'home') return path.join(testRoot, 'home');
      return testRoot;
    },
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// A watcher that reports nothing on its own, so only the fallback poll can notice a change.
const watcherHandlers = new Map<string, (arg?: unknown) => void>();
vi.mock('chokidar', () => {
  const watcher = {
    on(event: string, handler: (arg?: unknown) => void) {
      watcherHandlers.set(event, handler);
      return watcher;
    },
    close: () => Promise.resolve(),
  };
  return { default: { watch: () => watcher } };
});

import { SkillsManager } from '../src/main/skills/skills-manager';
import type { DatabaseInstance } from '../src/main/db/database';

function createDbMock(): DatabaseInstance {
  return { prepare: vi.fn(() => ({ run: vi.fn() })) } as unknown as DatabaseInstance;
}

function writeSkill(rootPath: string, name: string): string {
  const skillRoot = path.join(rootPath, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\nUse ${name}.`,
    'utf8'
  );
  return skillRoot;
}

describe('SkillsManager fallback poll of the skills folder', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-skills-polling-test-'));
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'home'), { recursive: true });
    watcherHandlers.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('notices a change in a linked skill after the watcher fails on a looping link', () => {
    // The runtime skills dir holds links to skill folders kept elsewhere (~/.claude/skills),
    // and one of them contains a link to itself, which made the real watcher fail with ELOOP.
    const storagePath = path.join(testRoot, 'userData', 'claude', 'skills');
    fs.mkdirSync(storagePath, { recursive: true });
    const realRoot = path.join(testRoot, 'home', 'real-skills');
    const linkedSkill = writeSkill(realRoot, 'linked');
    const loopingSkill = writeSkill(realRoot, 'looping');
    fs.symlinkSync('looping', path.join(loopingSkill, 'looping'));
    fs.symlinkSync(linkedSkill, path.join(storagePath, 'linked'), 'dir');
    fs.symlinkSync(loopingSkill, path.join(storagePath, 'looping'), 'dir');
    fs.symlinkSync('self', path.join(storagePath, 'self'));

    const manager = new SkillsManager(createDbMock(), {
      getConfiguredGlobalSkillsPath: () => storagePath,
      watchStorage: true,
    });
    const reasons: string[] = [];
    manager.onStorageChanged((event) => reasons.push(event.reason));

    watcherHandlers.get('error')?.(new Error('ELOOP: too many symbolic links encountered'));
    expect(reasons).toEqual(['watcher_error']);

    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(linkedSkill, 'SKILL.md'), later, later);
    vi.advanceTimersByTime(3000);

    expect(reasons).toEqual(['watcher_error', 'updated']);
  });
});
