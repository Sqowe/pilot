import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';

let testRoot = '';

vi.mock('electron', () => {
  const electron = {
    app: {
      getName: () => 'open-cowork-test',
      getVersion: () => '0.0.0-test',
      getPath: (name: string) => (name === 'userData' ? path.join(testRoot, 'userData') : testRoot),
    },
  };
  return { ...electron, default: electron };
});

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const SHA_1 = '1111111111111111111111111111111111111111';
const SHA_2 = '2222222222222222222222222222222222222222';
const OWNER = 'acme';
const REPO = 'tools';

type Entry = { name: string; content: string } | { name: string; symlinkTo: string };

/** A codeload-style zip: everything under `<repo>-<sha>/`, the commit id as the archive comment. */
async function buildRepoZip(sha: string, entries: Entry[]): Promise<Buffer> {
  const file = path.join(testRoot, `zip-${sha}-${Math.random().toString(36).slice(2)}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(file);
    const archive = archiver('zip', { zlib: { level: 0 }, comment: sha });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    const top = `${REPO}-${sha}/`;
    for (const entry of entries) {
      if ('symlinkTo' in entry) {
        archive.symlink(top + entry.name, entry.symlinkTo);
      } else {
        archive.append(Buffer.from(entry.content), { name: top + entry.name });
      }
    }
    archive.finalize();
  });
  return fs.readFileSync(file);
}

function skill(name: string, description = `${name} skill`): Entry {
  return {
    name: `skills/${name}/SKILL.md`,
    content: `---\nname: ${name}\ndescription: ${description}\n---\n`,
  };
}

function manifest(prefix: string, body: Record<string, unknown>): Entry {
  return { name: `${prefix}.claude-plugin/plugin.json`, content: JSON.stringify(body) };
}

interface FakeGitHub {
  fetchFn: typeof fetch;
  calls: string[];
  /** What HEAD (or a ref) resolves to; null = the API is rate-limited. */
  setHead(sha: string | null): void;
  setArchive(refOrSha: string, zip: Buffer): void;
}

function fakeGitHub(): FakeGitHub {
  const calls: string[] = [];
  let head: string | null = SHA_1;
  const archives = new Map<string, Buffer>();
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const api = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/);
    if (api) {
      if (api[1] !== OWNER || api[2] !== REPO) return new Response('', { status: 404 });
      if (head === null) return new Response('rate limited', { status: 403 });
      return new Response(head, { status: 200 });
    }
    const zip = url.match(/^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/zip\/(.+)$/);
    if (zip) {
      const body = archives.get(decodeURIComponent(zip[3]));
      return body
        ? new Response(new Uint8Array(body), { status: 200 })
        : new Response('', { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  return {
    fetchFn,
    calls,
    setHead: (sha) => {
      head = sha;
    },
    setArchive: (refOrSha, zip) => {
      archives.set(refOrSha, zip);
    },
  };
}

async function createService(github: FakeGitHub) {
  const { PluginRuntimeService } = await import('../src/main/skills/plugin-runtime-service');
  type Ctor = ConstructorParameters<typeof PluginRuntimeService>;
  // The catalog and the CLI are never reached on the GitHub path.
  return new PluginRuntimeService({} as Ctor[0], vi.fn() as unknown as Ctor[1], github.fetchFn);
}

async function expectCode(promise: Promise<unknown>, code: string, details?: string) {
  const error = await promise.then(
    () => null,
    (e: { code?: string; details?: string }) => e
  );
  expect(error?.code).toBe(code);
  if (details !== undefined) expect(error?.details).toBe(details);
}

function tempLeftovers(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('sqowe-plugin-github-'));
}

describe('PluginRuntimeService — install from GitHub', () => {
  let github: FakeGitHub;
  let tempBefore: Set<string>;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-plugin-github-'));
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    vi.resetModules();
    github = fakeGitHub();
    tempBefore = new Set(tempLeftovers());
  });

  afterEach(() => {
    // Every install, failed or not, removes its temp folder.
    expect(tempLeftovers().filter((f) => !tempBefore.has(f))).toEqual([]);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('installs a repository like marketingskills: plugin.json + marketplace.json + a link', async () => {
    github.setArchive(
      SHA_1,
      await buildRepoZip(SHA_1, [
        manifest('', { name: 'marketing-skills', version: '2.13.0', skills: './skills' }),
        {
          name: '.claude-plugin/marketplace.json',
          content: JSON.stringify({
            name: 'm',
            plugins: [{ name: 'marketing-skills', source: './' }],
          }),
        },
        skill('cro'),
        skill('marketing-loops', 'A loop that orchestrates the other skills'),
        { name: 'AGENTS.md', content: '# for agents' },
        { name: 'CLAUDE.md', symlinkTo: 'AGENTS.md' },
      ])
    );
    const service = await createService(github);
    const result = await service.installFromGitHub('https://github.com/acme/tools.git');

    expect(result.plugin.pluginId).toBe('marketing-skills');
    expect(result.installedSkills).toEqual(['cro', 'marketing-loops']);
    expect(result.plugin.orchestratorSkill).toBe('marketing-loops');
    expect(result.skippedSymlinks).toEqual(['CLAUDE.md']);
    expect(result.plugin.source).toEqual({
      type: 'github',
      owner: OWNER,
      repo: REPO,
      commitSha: SHA_1,
    });
    expect(result.plugin.componentsEnabled).toMatchObject({
      skills: true,
      hooks: false,
      mcp: false,
    });
    expect(() => fs.lstatSync(path.join(result.plugin.sourcePath, 'CLAUDE.md'))).toThrow();
    expect(fs.existsSync(path.join(result.plugin.runtimePath, 'skills', 'cro', 'SKILL.md'))).toBe(
      true
    );
    // The archive is fetched by the commit the API named.
    expect(github.calls[1]).toBe(`https://codeload.github.com/acme/tools/zip/${SHA_1}`);
  });

  it('installs the single plugin of a marketplace from its relative folder', async () => {
    github.setArchive(
      SHA_1,
      await buildRepoZip(SHA_1, [
        {
          name: '.claude-plugin/marketplace.json',
          content: JSON.stringify({
            name: 'm',
            plugins: [{ name: 'formatter', source: './plugins/formatter' }],
          }),
        },
        {
          name: 'plugins/formatter/skills/fmt/SKILL.md',
          content: '---\nname: fmt\ndescription: d\n---\n',
        },
      ])
    );
    const service = await createService(github);
    const result = await service.installFromGitHub('acme/tools');

    // No plugin.json: the marketplace entry gives the name, not the temp folder.
    expect(result.plugin.name).toBe('formatter');
    expect(result.plugin.source?.path).toBe('plugins/formatter');
    expect(result.installedSkills).toEqual(['fmt']);
  });

  it('resolves a bare marketplace source under metadata.pluginRoot', async () => {
    github.setArchive(
      SHA_1,
      await buildRepoZip(SHA_1, [
        {
          name: '.claude-plugin/marketplace.json',
          content: JSON.stringify({
            name: 'm',
            metadata: { pluginRoot: './plugins' },
            plugins: [{ name: 'fmt', source: 'formatter' }],
          }),
        },
        manifest('plugins/formatter/', { name: 'formatter' }),
        {
          name: 'plugins/formatter/skills/fmt/SKILL.md',
          content: '---\nname: fmt\ndescription: d\n---\n',
        },
      ])
    );
    const service = await createService(github);
    const result = await service.installFromGitHub('acme/tools');
    expect(result.plugin.name).toBe('formatter');
    expect(result.plugin.source?.path).toBe('plugins/formatter');
  });

  it('installs the folder a /tree/<ref>/<folder> link names, recording the ref', async () => {
    github.setArchive(
      SHA_1,
      await buildRepoZip(SHA_1, [
        manifest('plugins/one/', { name: 'one' }),
        { name: 'plugins/one/skills/a/SKILL.md', content: '---\nname: a\ndescription: d\n---\n' },
      ])
    );
    const service = await createService(github);
    const result = await service.installFromGitHub(
      'https://github.com/acme/tools/tree/v1/plugins/one'
    );
    expect(result.plugin.source).toEqual({
      type: 'github',
      owner: OWNER,
      repo: REPO,
      ref: 'v1',
      path: 'plugins/one',
      commitSha: SHA_1,
    });
    expect(github.calls[0]).toBe('https://api.github.com/repos/acme/tools/commits/v1');
  });

  it('installs a repository that only has a skills folder, named after the repo', async () => {
    github.setArchive(SHA_1, await buildRepoZip(SHA_1, [skill('alpha')]));
    const service = await createService(github);
    const result = await service.installFromGitHub('acme/tools');
    expect(result.plugin.name).toBe(REPO);
    expect(result.warnings).toContain(
      'plugin.json not found, generated runtime manifest with defaults'
    );
  });

  it('downloads by ref and takes the commit from the archive comment when the API is rate-limited', async () => {
    github.setHead(null);
    github.setArchive('HEAD', await buildRepoZip(SHA_2, [manifest('', { name: 'p' }), skill('a')]));
    const service = await createService(github);
    const result = await service.installFromGitHub('acme/tools');
    expect(github.calls[1]).toBe('https://codeload.github.com/acme/tools/zip/HEAD');
    expect(result.plugin.source?.commitSha).toBe(SHA_2);
  });

  it('refuses a marketplace with several plugins, naming them', async () => {
    github.setArchive(
      SHA_1,
      await buildRepoZip(SHA_1, [
        {
          name: '.claude-plugin/marketplace.json',
          content: JSON.stringify({
            name: 'm',
            plugins: [
              { name: 'a', source: './a' },
              { name: 'b', source: './b' },
            ],
          }),
        },
      ])
    );
    const service = await createService(github);
    await expectCode(service.installFromGitHub('acme/tools'), 'multiplePlugins', 'a, b');
    expect(service.listInstalled()).toEqual([]);
  });

  it.each([
    [{ source: 'github', repo: 'x/y' }, 'unsupportedSource', 'github'],
    ['../outside', 'unsupportedSource', '../outside'],
    ['./a/../../outside', 'unsupportedSource', './a/../../outside'],
    ['/etc', 'unsupportedSource', '/etc'],
    ['./missing', 'noPlugin', 'missing'],
  ])('refuses marketplace source %j', async (source, code, details) => {
    github.setArchive(
      SHA_1,
      await buildRepoZip(SHA_1, [
        {
          name: '.claude-plugin/marketplace.json',
          content: JSON.stringify({ name: 'm', plugins: [{ name: 'x', source }] }),
        },
      ])
    );
    const service = await createService(github);
    await expectCode(service.installFromGitHub('acme/tools'), code, details);
  });

  it('refuses a marketplace source that is a link leading out of the repository', async () => {
    github.setArchive(
      SHA_1,
      await buildRepoZip(SHA_1, [
        {
          name: '.claude-plugin/marketplace.json',
          content: JSON.stringify({ name: 'm', plugins: [{ name: 'x', source: './escape' }] }),
        },
        { name: 'escape', symlinkTo: '/etc' },
      ])
    );
    const service = await createService(github);
    // The link is never created, so the folder does not exist.
    await expectCode(service.installFromGitHub('acme/tools'), 'noPlugin', 'escape');
  });

  it('reports a missing folder, an empty repository and a bad link', async () => {
    github.setArchive(SHA_1, await buildRepoZip(SHA_1, [{ name: 'README.md', content: 'hi' }]));
    const service = await createService(github);
    await expectCode(
      service.installFromGitHub('https://github.com/acme/tools/tree/main/nope'),
      'pathNotFound',
      'nope'
    );
    await expectCode(service.installFromGitHub('acme/tools'), 'noPlugin');
    await expectCode(service.installFromGitHub('https://gitlab.com/acme/tools'), 'invalidUrl');
    await expectCode(service.installFromGitHub('other/repo'), 'repoNotFound');
  });

  it('reports a download that is not a zip as archiveInvalid', async () => {
    github.setArchive(SHA_1, Buffer.from('<html>not a zip</html>'));
    const service = await createService(github);
    await expectCode(service.installFromGitHub('acme/tools'), 'archiveInvalid');
  });
});

describe('PluginRuntimeService — update from GitHub', () => {
  let github: FakeGitHub;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-plugin-github-'));
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    vi.resetModules();
    github = fakeGitHub();
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  async function installV1(service: Awaited<ReturnType<typeof createService>>) {
    github.setArchive(
      SHA_1,
      await buildRepoZip(SHA_1, [
        manifest('', { name: 'tools-plugin', version: '1.0.0' }),
        skill('a'),
        { name: 'agents/reviewer.md', content: '# reviewer' },
        { name: 'hooks/hooks.json', content: '{"hooks":{}}' },
      ])
    );
    return service.installFromGitHub('acme/tools');
  }

  it('says up to date without downloading when the commit has not changed', async () => {
    const service = await createService(github);
    await installV1(service);
    const callsBefore = github.calls.length;

    const result = await service.updateFromGitHub('tools-plugin');
    expect(result.status).toBe('upToDate');
    expect(github.calls.slice(callsBefore)).toEqual([
      'https://api.github.com/repos/acme/tools/commits/HEAD',
    ]);
  });

  it('says up to date from the archive comment when the API is rate-limited', async () => {
    const service = await createService(github);
    await installV1(service);
    github.setHead(null);
    github.setArchive(
      'HEAD',
      await buildRepoZip(SHA_1, [manifest('', { name: 'tools-plugin' }), skill('a')])
    );
    const result = await service.updateFromGitHub('tools-plugin');
    expect(result.status).toBe('upToDate');
  });

  it('installs the new commit and keeps the install date and the user switches', async () => {
    const service = await createService(github);
    const installed = await installV1(service);
    await service.setComponentEnabled('tools-plugin', 'agents', false);
    await service.setComponentEnabled('tools-plugin', 'hooks', true);

    github.setHead(SHA_2);
    github.setArchive(
      SHA_2,
      await buildRepoZip(SHA_2, [
        manifest('', { name: 'tools-plugin', version: '2.0.0' }),
        skill('a'),
        skill('b'),
        { name: 'agents/reviewer.md', content: '# reviewer' },
        { name: 'hooks/hooks.json', content: '{"hooks":{}}' },
        // New in this commit: must start off, like at install.
        { name: '.mcp.json', content: '{"mcpServers":{}}' },
      ])
    );

    const result = await service.updateFromGitHub('tools-plugin');
    if (result.status !== 'updated') throw new Error('expected an update');
    expect(result.previousCommitSha).toBe(SHA_1);
    expect(result.plugin.version).toBe('2.0.0');
    expect(result.plugin.source?.commitSha).toBe(SHA_2);
    expect(result.installedSkills).toEqual(['a', 'b']);
    expect(result.plugin.installedAt).toBe(installed.plugin.installedAt);
    expect(result.plugin.componentsEnabled).toEqual({
      skills: true,
      commands: false,
      agents: false,
      hooks: true,
      mcp: false,
    });
    expect(fs.existsSync(path.join(result.plugin.runtimePath, 'skills', 'b', 'SKILL.md'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(result.plugin.runtimePath, 'agents'))).toBe(false);
  });

  it('keeps a plugin the user switched off switched off', async () => {
    const service = await createService(github);
    await installV1(service);
    await service.setEnabled('tools-plugin', false);
    github.setHead(SHA_2);
    github.setArchive(
      SHA_2,
      await buildRepoZip(SHA_2, [manifest('', { name: 'tools-plugin' }), skill('a')])
    );
    const result = await service.updateFromGitHub('tools-plugin');
    if (result.status !== 'updated') throw new Error('expected an update');
    expect(result.plugin.enabled).toBe(false);
    expect(fs.existsSync(result.plugin.runtimePath)).toBe(false);
  });

  it('refuses an update that renames the plugin and leaves the installed files alone', async () => {
    const service = await createService(github);
    const installed = await installV1(service);
    github.setHead(SHA_2);
    github.setArchive(
      SHA_2,
      await buildRepoZip(SHA_2, [manifest('', { name: 'renamed' }), skill('a')])
    );

    await expectCode(service.updateFromGitHub('tools-plugin'), 'pluginRenamed', 'renamed');
    const still = service.listInstalled().find((p) => p.pluginId === 'tools-plugin');
    expect(still?.source?.commitSha).toBe(SHA_1);
    expect(fs.existsSync(path.join(installed.plugin.sourcePath, 'skills', 'a', 'SKILL.md'))).toBe(
      true
    );
  });

  it('refuses plugins that are unknown or did not come from GitHub', async () => {
    const service = await createService(github);
    await expectCode(service.updateFromGitHub('nope'), 'pluginNotFound');

    const local = path.join(testRoot, 'local-plugin');
    fs.mkdirSync(path.join(local, 'skills', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(local, 'skills', 'a', 'SKILL.md'),
      '---\nname: a\ndescription: d\n---\n'
    );
    await service.installFromDirectory(local);
    await expectCode(service.updateFromGitHub('local-plugin'), 'notFromGitHub');
  });

  it('refuses a stored source that was tampered with', async () => {
    const service = await createService(github);
    await installV1(service);
    const { pluginRegistryStore } = await import('../src/main/skills/plugin-registry-store');
    const stored = pluginRegistryStore.get('tools-plugin')!;
    pluginRegistryStore.save({ ...stored, source: { ...stored.source!, path: '../../etc' } });
    await expectCode(service.updateFromGitHub('tools-plugin'), 'notFromGitHub');
    expect(github.calls.filter((c) => c.includes('/commits/')).length).toBe(1);
  });
});
