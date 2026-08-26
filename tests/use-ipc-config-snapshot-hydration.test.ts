import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const useIPCPath = path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts');

describe('useIPC config snapshot hydration', () => {
  // Regression: AppConfig-backed settings persisted on disk by the main process
  // were not being rehydrated into the renderer settings slice on reboot,
  // so the Settings UI appeared to reset. applyConfigSnapshot must copy those
  // fields from config into settings.
  it('rehydrates systemPromptFileEnabled from the persisted config snapshot', () => {
    const source = fs.readFileSync(useIPCPath, 'utf8');

    expect(source).toContain('const applyConfigSnapshot');
    expect(source).toContain('systemPromptFileEnabled: config.systemPromptFileEnabled');
  });

  it('rehydrates systemPromptFilePriority from the persisted config snapshot', () => {
    const source = fs.readFileSync(useIPCPath, 'utf8');

    expect(source).toContain('systemPromptFilePriority: config.systemPromptFilePriority');
  });

  it('rehydrates globalSkillsPath from the persisted config snapshot', () => {
    const source = fs.readFileSync(useIPCPath, 'utf8');

    expect(source).toContain("globalSkillsPath: config.globalSkillsPath ?? '',");
  });

  it('still hydrates theme from the persisted config snapshot', () => {
    const source = fs.readFileSync(useIPCPath, 'utf8');

    expect(source).toContain("theme: config.theme || 'light',");
  });

  it('hydrates all fields in a single setSettings call to avoid redundant renders', () => {
    const source = fs.readFileSync(useIPCPath, 'utf8');

    // Confirm the fields live in one setSettings block inside applyConfigSnapshot.
    const snapshotFnStart = source.indexOf('const applyConfigSnapshot');
    expect(snapshotFnStart).toBeGreaterThan(-1);
    const snapshotFnEnd = source.indexOf('};', snapshotFnStart);
    const snapshotFnBody = source.slice(snapshotFnStart, snapshotFnEnd);

    expect(snapshotFnBody).toContain('store.setSettings({');
    expect(snapshotFnBody).toContain("theme: config.theme || 'light',");
    expect(snapshotFnBody).toContain('systemPromptFileEnabled: config.systemPromptFileEnabled');
    expect(snapshotFnBody).toContain('systemPromptFilePriority: config.systemPromptFilePriority');
    expect(snapshotFnBody).toContain("globalSkillsPath: config.globalSkillsPath ?? '',");
  });
});
