import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  PluginGitHubFailure,
  buildArchiveUrl,
  buildCommitApiUrl,
  downloadGitHubArchive,
  isCommitSha,
  resolveCommitSha,
  toPluginGitHubError,
} from '../src/main/skills/plugin-github-source';

const SHA = 'e85f3cbc2e4a79bf33b2a12e9bdd9087d414735b';
const LOCATION = { owner: 'coreyhaines31', repo: 'marketingskills' };

function respond(status: number, body: BodyInit | null = '', headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

/** A fake fetch answering by URL; records every call. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function expectFailure(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(PluginGitHubFailure);
  await promise.catch((error: PluginGitHubFailure) => expect(error.code).toBe(code));
}

describe('URL building', () => {
  it('builds the commit API URL for HEAD, a tag and a branch with a slash', () => {
    expect(buildCommitApiUrl(LOCATION)).toBe(
      'https://api.github.com/repos/coreyhaines31/marketingskills/commits/HEAD'
    );
    expect(buildCommitApiUrl({ ...LOCATION, ref: 'v2.13.0' })).toMatch(/\/commits\/v2\.13\.0$/);
    expect(buildCommitApiUrl({ ...LOCATION, ref: 'feature/add x' })).toMatch(
      /\/commits\/feature\/add%20x$/
    );
  });

  it('builds the codeload archive URL', () => {
    expect(buildArchiveUrl(LOCATION, SHA)).toBe(
      `https://codeload.github.com/coreyhaines31/marketingskills/zip/${SHA}`
    );
  });

  it('isCommitSha', () => {
    expect(isCommitSha(SHA)).toBe(true);
    expect(isCommitSha(SHA.toUpperCase())).toBe(false);
    expect(isCommitSha(SHA.slice(1))).toBe(false);
    expect(isCommitSha(undefined)).toBe(false);
  });
});

describe('resolveCommitSha', () => {
  const url = buildCommitApiUrl(LOCATION);

  it('returns the commit and asks for the sha media type with a User-Agent', async () => {
    const { fn, calls } = fakeFetch({ [url]: () => respond(200, `${SHA}\n`) });
    await expect(resolveCommitSha(LOCATION, { fetchFn: fn })).resolves.toBe(SHA);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.github.sha');
    expect(headers['User-Agent']).toBeTruthy();
    expect(calls[0].init?.redirect).toBe('manual');
  });

  it('maps 404 to repoNotFound and 422 to refNotFound', async () => {
    await expectFailure(
      resolveCommitSha(LOCATION, { fetchFn: fakeFetch({ [url]: () => respond(404) }).fn }),
      'repoNotFound'
    );
    const refLocation = { ...LOCATION, ref: 'nope' };
    await expectFailure(
      resolveCommitSha(refLocation, {
        fetchFn: fakeFetch({ [buildCommitApiUrl(refLocation)]: () => respond(422) }).fn,
      }),
      'refNotFound'
    );
  });

  it('returns null on rate limit, server error, bad body or network failure', async () => {
    for (const route of [
      () => respond(403, 'rate limited'),
      () => respond(500),
      () => respond(200, 'not a sha'),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      await expect(
        resolveCommitSha(LOCATION, { fetchFn: fakeFetch({ [url]: route }).fn })
      ).resolves.toBeNull();
    }
  });

  it('does not follow a redirect off GitHub', async () => {
    const { fn, calls } = fakeFetch({
      [url]: () => respond(302, null, { location: 'https://evil.example/sha' }),
    });
    await expect(resolveCommitSha(LOCATION, { fetchFn: fn })).resolves.toBeNull();
    expect(calls.map((c) => c.url)).toEqual([url]);
  });
});

describe('downloadGitHubArchive', () => {
  let dir = '';
  let target = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gh-source-'));
    target = path.join(dir, 'a.zip');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('follows a redirect between GitHub hosts and writes the body', async () => {
    const start = 'https://codeload.github.com/coreyhaines31/marketingskills/zip/HEAD';
    const final = `https://codeload.github.com/coreyhaines31/marketingskills/zip/${SHA}`;
    const { fn, calls } = fakeFetch({
      [start]: () => respond(302, null, { location: final }),
      [final]: () => respond(200, 'zip-bytes'),
    });
    await downloadGitHubArchive(LOCATION, 'HEAD', target, { fetchFn: fn });
    expect(fs.readFileSync(target, 'utf8')).toBe('zip-bytes');
    expect(calls.map((c) => c.url)).toEqual([start, final]);
  });

  it('refuses a redirect to another host or to http', async () => {
    const start = buildArchiveUrl(LOCATION, SHA);
    for (const location of ['https://evil.example/x.zip', 'http://codeload.github.com/x.zip']) {
      const { fn, calls } = fakeFetch({ [start]: () => respond(301, null, { location }) });
      await expectFailure(
        downloadGitHubArchive(LOCATION, SHA, target, { fetchFn: fn }),
        'downloadFailed'
      );
      expect(calls).toHaveLength(1);
    }
  });

  it('stops after three redirects', async () => {
    const start = buildArchiveUrl(LOCATION, SHA);
    const { fn, calls } = fakeFetch({ [start]: () => respond(302, null, { location: start }) });
    await expectFailure(
      downloadGitHubArchive(LOCATION, SHA, target, { fetchFn: fn }),
      'downloadFailed'
    );
    expect(calls).toHaveLength(4);
  });

  it('maps 404 to refNotFound when a ref was given, repoNotFound otherwise', async () => {
    const withRef = { ...LOCATION, ref: 'gone' };
    await expectFailure(
      downloadGitHubArchive(withRef, 'gone', target, {
        fetchFn: fakeFetch({ [buildArchiveUrl(LOCATION, 'gone')]: () => respond(404) }).fn,
      }),
      'refNotFound'
    );
    await expectFailure(
      downloadGitHubArchive(LOCATION, 'HEAD', target, {
        fetchFn: fakeFetch({ [buildArchiveUrl(LOCATION, 'HEAD')]: () => respond(404) }).fn,
      }),
      'repoNotFound'
    );
  });

  it('refuses an announced size above the limit before reading', async () => {
    const url = buildArchiveUrl(LOCATION, SHA);
    const { fn } = fakeFetch({
      [url]: () => respond(200, 'x', { 'content-length': '1000' }),
    });
    await expectFailure(
      downloadGitHubArchive(LOCATION, SHA, target, { fetchFn: fn, maxBytes: 10 }),
      'tooLarge'
    );
  });

  it('stops reading once more bytes arrive than allowed', async () => {
    const url = buildArchiveUrl(LOCATION, SHA);
    const { fn } = fakeFetch({ [url]: () => respond(200, 'x'.repeat(50)) });
    await expectFailure(
      downloadGitHubArchive(LOCATION, SHA, target, { fetchFn: fn, maxBytes: 10 }),
      'tooLarge'
    );
  });

  it('maps a network error to downloadFailed', async () => {
    const url = buildArchiveUrl(LOCATION, SHA);
    const { fn } = fakeFetch({
      [url]: () => {
        throw new TypeError('fetch failed');
      },
    });
    await expectFailure(
      downloadGitHubArchive(LOCATION, SHA, target, { fetchFn: fn }),
      'downloadFailed'
    );
  });
});

describe('toPluginGitHubError', () => {
  it('keeps code and details of a PluginGitHubFailure and hides anything else', () => {
    expect(toPluginGitHubError(new PluginGitHubFailure('multiplePlugins', 'a, b'))).toEqual({
      code: 'multiplePlugins',
      details: 'a, b',
    });
    expect(toPluginGitHubError(new PluginGitHubFailure('tooLarge'))).toEqual({ code: 'tooLarge' });
    expect(toPluginGitHubError(new Error('/Users/me/secret/path'))).toEqual({ code: 'unknown' });
  });
});
