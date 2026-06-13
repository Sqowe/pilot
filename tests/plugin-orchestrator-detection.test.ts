import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testRoot = '';

vi.mock('electron', () => {
  const electron = {
    app: {
      getName: () => 'open-cowork-test',
      getVersion: () => '0.0.0-test',
      getPath: (name: string) => {
        if (name === 'userData') return path.join(testRoot, 'userData');
        if (name === 'temp') return path.join(testRoot, 'temp');
        if (name === 'home') return path.join(testRoot, 'home');
        return testRoot;
      },
    },
  };
  return { ...electron, default: electron };
});

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function createPluginWithSkill(
  root: string,
  pluginName: string,
  skillName: string,
  skillMdContent: string
): string {
  const pluginRoot = path.join(root, pluginName);
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
    'utf8'
  );
  fs.mkdirSync(path.join(pluginRoot, 'skills', skillName), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'skills', skillName, 'SKILL.md'), skillMdContent, 'utf8');
  return pluginRoot;
}

async function createRuntimeService() {
  const { PluginRuntimeService } = await import('../src/main/skills/plugin-runtime-service');
  const fakeCatalogService = {
    listAnthropicPlugins: vi.fn(),
    downloadPlugin: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return new PluginRuntimeService(fakeCatalogService);
}

describe('Orchestrator Detection', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-orchestrator-test-'));
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'temp'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'home'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('detects orchestrator from description containing "orchestrates"', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'biz-plugin',
      'main-skill',
      '---\nname: main-skill\ndescription: Orchestrates the full business planning workflow\n---\n# Main Skill\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'biz-plugin'));

    expect(result.plugin.orchestratorSkill).toBe('main-skill');
  });

  it('detects orchestrator from description containing "coordinates"', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'coord-plugin',
      'coordinator',
      '---\nname: coordinator\ndescription: Coordinates all sub-skills in the bundle\n---\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'coord-plugin'));

    expect(result.plugin.orchestratorSkill).toBe('coordinator');
  });

  it('detects orchestrator from description containing "delegates to"', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'deleg-plugin',
      'delegator',
      '---\nname: delegator\ndescription: Entry point that delegates to specialized skills\n---\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'deleg-plugin'));

    expect(result.plugin.orchestratorSkill).toBe('delegator');
  });

  it('returns null when no skill has orchestrator keywords', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'plain-plugin',
      'helper',
      '---\nname: helper\ndescription: A simple helper skill that does one thing\n---\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'plain-plugin'));

    expect(result.plugin.orchestratorSkill).toBeNull();
  });

  it('handles plugin with no skills directory', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    const pluginRoot = path.join(fixturesRoot, 'no-skills');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'no-skills', version: '1.0.0' }),
      'utf8'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(pluginRoot);

    expect(result.plugin.orchestratorSkill).toBeNull();
  });

  it('handles skill with missing SKILL.md gracefully', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    const pluginRoot = path.join(fixturesRoot, 'missing-md');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'missing-md', version: '1.0.0' }),
      'utf8'
    );
    // Create skill dir but no SKILL.md
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'orphan'), { recursive: true });

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(pluginRoot);

    expect(result.plugin.orchestratorSkill).toBeNull();
  });

  it('handles malformed SKILL.md without frontmatter', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'no-fm-plugin',
      'no-frontmatter',
      '# No frontmatter here\nJust markdown content.\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'no-fm-plugin'));

    expect(result.plugin.orchestratorSkill).toBeNull();
  });

  it('parses multiline folded description with > indicator', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'multiline-plugin',
      'multi-orch',
      '---\nname: multi-orch\ndescription: >\n  This skill orchestrates\n  the entire workflow\n---\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'multiline-plugin'));

    expect(result.plugin.orchestratorSkill).toBe('multi-orch');
  });

  it('parses quoted description', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'quoted-plugin',
      'quoted-orch',
      '---\nname: quoted-orch\ndescription: "Orchestrates all business plan skills"\n---\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'quoted-plugin'));

    expect(result.plugin.orchestratorSkill).toBe('quoted-orch');
  });

  it('backfillOrchestrators skips already-scanned plugins', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'backfill-test',
      'orch-skill',
      '---\nname: orch-skill\ndescription: Orchestrates things\n---\n'
    );

    const service = await createRuntimeService();
    // Install first — this scans and sets orchestratorSkill
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'backfill-test'));
    expect(result.plugin.orchestratorSkill).toBe('orch-skill');

    // Backfill should not re-scan already-scanned plugins
    service.backfillOrchestrators();

    // Verify plugin still has orchestrator
    const installed = service.listInstalled();
    const plugin = installed.find((p) => p.pluginId === result.plugin.pluginId);
    expect(plugin?.orchestratorSkill).toBe('orch-skill');
  });

  it('backfillOrchestrators persists null for plugins without orchestrator', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'no-orch-backfill',
      'plain',
      '---\nname: plain\ndescription: A simple utility skill\n---\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'no-orch-backfill'));
    // Freshly installed — orchestratorSkill should be null (scanned, not found)
    expect(result.plugin.orchestratorSkill).toBeNull();

    // Backfill should not rescan (already scanned with null result)
    service.backfillOrchestrators();
    const installed = service.listInstalled();
    const plugin = installed.find((p) => p.pluginId === result.plugin.pluginId);
    expect(plugin?.orchestratorSkill).toBeNull();
  });

  it('backfillOrchestrators discovers orchestrator for legacy plugin records', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'legacy-plugin',
      'entry-point',
      '---\nname: entry-point\ndescription: Orchestrates the entire workflow\n---\n'
    );

    const service = await createRuntimeService();
    // Install the plugin — this sets orchestratorSkill via new code path
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'legacy-plugin'));
    expect(result.plugin.orchestratorSkill).toBe('entry-point');

    // Simulate a legacy record by directly manipulating the registry store
    // (as if the plugin was installed before the orchestrator feature existed)
    const { pluginRegistryStore } = await import('../src/main/skills/plugin-registry-store');
    const stored = pluginRegistryStore.get(result.plugin.pluginId);
    if (stored) {
      // Remove orchestratorSkill to simulate legacy state
      delete (stored as Record<string, unknown>).orchestratorSkill;
      pluginRegistryStore.save(stored);
    }

    // Verify it's actually undefined now
    const beforeBackfill = pluginRegistryStore.get(result.plugin.pluginId);
    expect(beforeBackfill?.orchestratorSkill).toBeUndefined();

    // Run backfill — should discover the orchestrator
    service.backfillOrchestrators();

    const afterBackfill = pluginRegistryStore.get(result.plugin.pluginId);
    expect(afterBackfill?.orchestratorSkill).toBe('entry-point');
  });

  it('backfillOrchestrators does not crash on inaccessible plugin source path', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'will-break',
      'skill',
      '---\nname: skill\ndescription: A skill\n---\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'will-break'));

    // Simulate legacy state
    const { pluginRegistryStore } = await import('../src/main/skills/plugin-registry-store');
    const stored = pluginRegistryStore.get(result.plugin.pluginId);
    if (stored) {
      delete (stored as Record<string, unknown>).orchestratorSkill;
      pluginRegistryStore.save(stored);
    }

    // Replace the skills directory with a file (not a directory) to cause statSync
    // to succeed but isDirectory() to return false — simulating a corrupted state
    // that the code handles gracefully
    const skillsDir = path.join(stored!.sourcePath, 'skills');
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.writeFileSync(skillsDir, 'not a directory', 'utf8');

    // Should not throw — returns null (skills path exists but is not a directory)
    expect(() => service.backfillOrchestrators()).not.toThrow();

    // orchestratorSkill should be null (scan succeeded: skills is not a dir)
    const afterBackfill = pluginRegistryStore.get(result.plugin.pluginId);
    expect(afterBackfill?.orchestratorSkill).toBeNull();
  });

  it('backfillOrchestrators returns undefined for non-existent source path', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginWithSkill(
      fixturesRoot,
      'gone-plugin',
      'skill',
      '---\nname: skill\ndescription: A skill\n---\n'
    );

    const service = await createRuntimeService();
    const result = await service.installFromDirectory(path.join(fixturesRoot, 'gone-plugin'));

    // Simulate legacy state + point to non-existent path
    const { pluginRegistryStore } = await import('../src/main/skills/plugin-registry-store');
    const stored = pluginRegistryStore.get(result.plugin.pluginId);
    if (stored) {
      delete (stored as Record<string, unknown>).orchestratorSkill;
      stored.sourcePath = '/non/existent/path';
      pluginRegistryStore.save(stored);
    }

    // Non-existent plugin root → undefined (scan failure), not persisted
    service.backfillOrchestrators();

    const afterBackfill = pluginRegistryStore.get(result.plugin.pluginId);
    expect(afterBackfill?.orchestratorSkill).toBeUndefined();
  });
});
