import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPiResourceLoader } from '../../main/claude/pi-resource-loader';
import { assembleSkillPaths } from '../../main/claude/skill-paths';

/**
 * Guards the SDK-only boundary applied to what pi loads from disk (ARCHITECTURE.md §4.1,
 * docs/design/permission-gate-tool-call-event.md §2).
 *
 * The fixture is a workspace with everything pi would pick up from a trusted project:
 * an extension that leaves a marker file when its code runs, a settings file naming a
 * package and an extension, SYSTEM.md / APPEND_SYSTEM.md, and skills in `.pi/skills` and
 * `.agents/skills`. Beside it, the places pi looks for skills on its own: the agent folder's
 * `skills` (the app's runtime skills dir) and `~/.agents/skills` under a stand-in HOME. The
 * app's own loader must take none of it and load exactly the skills the app passes — that
 * is what makes disabling a skill, for a session or globally, take effect. The first test
 * proves the fixture is one pi does load, so the others cannot pass for no reason.
 */
let root: string;
let workspace: string;
let agentDir: string;
let appSkills: string;
let appRuntime: string;
let rawBuiltins: string;
let markers: { project: string; user: string };
let previousOffline: string | undefined;
let previousHome: string | undefined;

function writeSkill(dir: string, name: string, description = name): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n`
  );
}

function writeMarkerExtension(file: string, marker: string): void {
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs';\n` +
      `export default function () { writeFileSync(${JSON.stringify(marker)}, 'ran'); }\n`
  );
}

beforeAll(() => {
  // Should this ever regress, pi must not reach npm to install the fixture's package.
  previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';

  root = mkdtempSync(join(tmpdir(), 'pi-loader-boundary-'));
  // pi reads `~/.agents/skills` from HOME; a stand-in keeps the user's own skills out.
  previousHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  writeSkill(join(root, 'home', '.agents', 'skills'), 'home-agents-skill');
  workspace = join(root, 'workspace');
  agentDir = join(root, 'agent');
  appSkills = join(root, 'app-skills');
  markers = { project: join(root, 'project-ran'), user: join(root, 'user-ran') };

  mkdirSync(join(workspace, '.pi', 'extensions'), { recursive: true });
  writeMarkerExtension(join(workspace, '.pi', 'extensions', 'probe.ts'), markers.project);
  writeFileSync(
    join(workspace, '.pi', 'settings.json'),
    JSON.stringify({ packages: ['npm:left-pad@1.3.0'], extensions: ['./extensions/probe.ts'] })
  );
  writeFileSync(join(workspace, '.pi', 'SYSTEM.md'), 'WORKSPACE SYSTEM PROMPT');
  writeFileSync(join(workspace, '.pi', 'APPEND_SYSTEM.md'), 'WORKSPACE APPENDIX');
  writeSkill(join(workspace, '.pi', 'skills'), 'workspace-pi-skill');
  writeSkill(join(workspace, '.agents', 'skills'), 'workspace-agents-skill');

  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  writeMarkerExtension(join(agentDir, 'extensions', 'user-probe.ts'), markers.user);
  // In the app the agent folder's `skills` is the runtime skills dir; a skill left out of
  // the paths the app passes (disabled for the session) must not come back through it.
  writeSkill(join(agentDir, 'skills'), 'agentdir-only-skill');

  writeSkill(appSkills, 'app-provided-skill');

  // A name clash: the runtime dir links the copy the app chose, the raw built-in folder
  // holds another one under the same name.
  appRuntime = join(root, 'app-runtime');
  rawBuiltins = join(root, 'raw-builtins');
  writeSkill(join(root, 'chosen'), 'shared', 'the copy the app chose');
  writeSkill(rawBuiltins, 'shared', 'the raw built-in copy');
  mkdirSync(appRuntime, { recursive: true });
  symlinkSync(join(root, 'chosen', 'shared'), join(appRuntime, 'shared'), 'junction');
});

afterAll(() => {
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function clearMarkers(): void {
  rmSync(markers.project, { force: true });
  rmSync(markers.user, { force: true });
}

const skillNames = (loader: DefaultResourceLoader) =>
  loader.getSkills().skills.map((skill) => skill.name);

describe('the pi resource loader takes nothing from the workspace', () => {
  it('is given a fixture that pi does load when left to its defaults', async () => {
    clearMarkers();
    const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, noContextFiles: true });
    await loader.reload();

    expect(existsSync(markers.project)).toBe(true);
    expect(skillNames(loader)).toEqual(
      expect.arrayContaining(['workspace-pi-skill', 'home-agents-skill', 'agentdir-only-skill'])
    );
    expect(loader.getSystemPrompt()).toBe('WORKSPACE SYSTEM PROMPT');
  });

  it('runs no extension code, from the workspace or the app folder', async () => {
    clearMarkers();
    const loader = await createPiResourceLoader({
      cwd: workspace,
      agentDir,
      additionalSkillPaths: [appSkills],
      appendSystemPrompt: ['APP APPENDIX'],
    });

    expect(loader.getExtensions().extensions).toEqual([]);
    expect(existsSync(markers.project)).toBe(false);
    expect(existsSync(markers.user)).toBe(false);
  });

  it('keeps the workspace out of the prompt and the skill list', async () => {
    const loader = await createPiResourceLoader({
      cwd: workspace,
      agentDir,
      additionalSkillPaths: [appSkills],
      appendSystemPrompt: ['APP APPENDIX'],
    });

    expect(loader.getSystemPrompt()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual(['APP APPENDIX']);
    const skills = skillNames(loader);
    expect(skills).not.toContain('workspace-pi-skill');
    expect(skills).not.toContain('workspace-agents-skill');
    // The skills the app hands over still load.
    expect(skills).toContain('app-provided-skill');
  });

  it('loads exactly the skills the app passes — nothing pi finds on its own', async () => {
    const loader = await createPiResourceLoader({
      cwd: workspace,
      agentDir,
      additionalSkillPaths: [appSkills],
      appendSystemPrompt: undefined,
    });

    // Not the user's `~/.agents/skills`, not the agent folder's `skills`.
    expect(skillNames(loader)).toEqual(['app-provided-skill']);
  });

  it('lets the copy the app chose win a name clash with a raw folder', async () => {
    const loader = await createPiResourceLoader({
      cwd: workspace,
      agentDir,
      additionalSkillPaths: assembleSkillPaths({
        runtimeDir: appRuntime,
        basePaths: [rawBuiltins],
        pluginPaths: [],
        sessionDisabled: [],
      }),
      appendSystemPrompt: undefined,
    });

    const shared = loader.getSkills().skills.filter((skill) => skill.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].description).toBe('the copy the app chose');
  });
});
