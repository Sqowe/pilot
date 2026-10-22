/**
 * @module main/skills/plugin-github-source
 *
 * The network half of "Install from GitHub": asks GitHub which commit a ref
 * points at and downloads that commit as a zip archive. Every URL is built here
 * from a parsed {@link GitHubPluginLocation}; nothing the renderer sends is
 * fetched as given. Only HTTPS to three GitHub hosts, redirects followed by
 * hand and only between them, a size cap and timeouts.
 *
 * No token is sent, so only public repositories work; the commit lookup uses
 * the unauthenticated API (60 requests an hour per address) and is optional —
 * when it fails, the archive is downloaded by ref and its comment names the
 * commit.
 *
 * Design: docs/design/plugin-github-install.md
 */
import * as fs from 'node:fs';
import type {
  GitHubPluginLocation,
  PluginGitHubError,
  PluginGitHubErrorCode,
} from '../../shared/plugin-github-url';
import { log, logWarn } from '../utils/logger';

/** Thrown inside the GitHub install path; the IPC handler turns it into `{ ok: false, error }`. */
export class PluginGitHubFailure extends Error {
  readonly code: PluginGitHubErrorCode;
  readonly details?: string;

  constructor(code: PluginGitHubErrorCode, details?: string, cause?: unknown) {
    super(details ? `${code}: ${details}` : code, cause === undefined ? undefined : { cause });
    this.name = 'PluginGitHubFailure';
    this.code = code;
    this.details = details;
  }
}

export const MAX_GITHUB_ARCHIVE_BYTES = 100 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'sqowe-pilot-plugin-installer';
const ALLOWED_HOSTS = new Set(['api.github.com', 'codeload.github.com', 'github.com']);
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface GitHubFetchOptions {
  fetchFn: typeof fetch;
  /** Overridable for tests. */
  maxBytes?: number;
}

export function isCommitSha(value: string | undefined | null): value is string {
  return typeof value === 'string' && COMMIT_SHA_PATTERN.test(value);
}

/**
 * What the renderer is told about a failure: a code it can translate, and the
 * plain detail only for the failures whose detail is meant to be read.
 */
export function toPluginGitHubError(error: unknown): PluginGitHubError {
  if (error instanceof PluginGitHubFailure) {
    return error.details ? { code: error.code, details: error.details } : { code: error.code };
  }
  return { code: 'unknown' };
}

/** Keeps the `/` of a ref such as `feature/x`, encodes everything else. */
function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function repoPath(location: Pick<GitHubPluginLocation, 'owner' | 'repo'>): string {
  return `${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`;
}

export function buildCommitApiUrl(location: GitHubPluginLocation): string {
  return `https://api.github.com/repos/${repoPath(location)}/commits/${encodeRef(location.ref ?? 'HEAD')}`;
}

export function buildArchiveUrl(
  location: Pick<GitHubPluginLocation, 'owner' | 'repo'>,
  refOrSha: string
): string {
  return `https://codeload.github.com/${repoPath(location)}/zip/${encodeRef(refOrSha)}`;
}

function assertAllowedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginGitHubFailure('downloadFailed', 'invalid redirect');
  }
  if (
    parsed.protocol !== 'https:' ||
    !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new PluginGitHubFailure('downloadFailed', `refused redirect to ${parsed.hostname}`);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing left to release.
  }
}

/** `fetch` that follows up to three redirects itself, each to an allowed GitHub host. */
async function fetchFromGitHub(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(current);
    const response = await fetchFn(current, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      await discardBody(response);
      if (!location) {
        throw new PluginGitHubFailure('downloadFailed', 'redirect without a location');
      }
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new PluginGitHubFailure('downloadFailed', 'too many redirects');
}

/**
 * The commit `location.ref` (or the default branch) points at, or null when
 * GitHub could not say — rate limit, outage, no network. Throws only for
 * answers that settle the matter: no such repository, no such ref.
 */
export async function resolveCommitSha(
  location: GitHubPluginLocation,
  options: GitHubFetchOptions
): Promise<string | null> {
  const url = buildCommitApiUrl(location);
  let response: Response;
  try {
    response = await fetchFromGitHub(
      url,
      {
        headers: { Accept: 'application/vnd.github.sha', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
      options.fetchFn
    );
  } catch (error) {
    logWarn(`[PluginGitHub] Commit lookup failed for ${url}; downloading by ref instead`, error);
    return null;
  }

  if (response.status === 404) {
    await discardBody(response);
    throw new PluginGitHubFailure('repoNotFound', `${location.owner}/${location.repo}`);
  }
  if (response.status === 422) {
    await discardBody(response);
    throw new PluginGitHubFailure('refNotFound', location.ref ?? 'HEAD');
  }
  if (response.status === 409) {
    // GitHub answers 409 for a repository without any commit.
    await discardBody(response);
    throw new PluginGitHubFailure('noPlugin', 'empty repository');
  }
  if (!response.ok) {
    await discardBody(response);
    logWarn(`[PluginGitHub] Commit lookup answered ${response.status} for ${url}`);
    return null;
  }

  const body = (await response.text()).trim();
  if (!isCommitSha(body)) {
    logWarn(`[PluginGitHub] Commit lookup gave no commit id for ${url}`);
    return null;
  }
  return body;
}

/**
 * Download `refOrSha` of the repository as a zip into `targetFile`.
 * Refuses more than {@link MAX_GITHUB_ARCHIVE_BYTES}, by the announced length
 * and by the bytes actually received.
 */
export async function downloadGitHubArchive(
  location: GitHubPluginLocation,
  refOrSha: string,
  targetFile: string,
  options: GitHubFetchOptions
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_GITHUB_ARCHIVE_BYTES;
  const url = buildArchiveUrl(location, refOrSha);
  log(`[PluginGitHub] Downloading ${url}`);

  let response: Response;
  try {
    response = await fetchFromGitHub(
      url,
      {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      },
      options.fetchFn
    );
  } catch (error) {
    if (error instanceof PluginGitHubFailure) throw error;
    throw new PluginGitHubFailure('downloadFailed', undefined, error);
  }

  if (response.status === 404) {
    await discardBody(response);
    throw location.ref
      ? new PluginGitHubFailure('refNotFound', location.ref)
      : new PluginGitHubFailure('repoNotFound', `${location.owner}/${location.repo}`);
  }
  if (!response.ok || !response.body) {
    await discardBody(response);
    throw new PluginGitHubFailure('downloadFailed', `HTTP ${response.status}`);
  }

  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) {
    await discardBody(response);
    throw new PluginGitHubFailure('tooLarge', String(maxBytes));
  }

  const handle = await fs.promises.open(targetFile, 'w');
  try {
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PluginGitHubFailure('tooLarge', String(maxBytes));
      }
      await handle.write(value);
    }
    log(`[PluginGitHub] Downloaded ${received} bytes from ${url}`);
  } catch (error) {
    if (error instanceof PluginGitHubFailure) throw error;
    throw new PluginGitHubFailure('downloadFailed', undefined, error);
  } finally {
    await handle.close();
  }
}
