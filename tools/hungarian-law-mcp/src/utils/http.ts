/**
 * HTTP utility with rate limiting, retries, timeouts, and redirect-safe fetching.
 */

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'HungarianLawMCP/1.0 (MCP Server; +https://github.com/open-cowork)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.5',
};

const DEFAULT_TIMEOUT_MS = 15_000; // 15 seconds per attempt
const MAX_REDIRECTS = 5;

/** Hosts that are allowed for redirect targets (SSRF protection). */
const ALLOWED_REDIRECT_HOSTS = new Set([
  'njt.jog.gov.hu',
  'www.njt.jog.gov.hu',
  'www.magyarkozlony.hu',
  'magyarkozlony.hu',
]);

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1000; // 1 second between requests

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'HttpTimeoutError';
  }
}

export class HttpRedirectError extends Error {
  constructor(url: string, targetHost: string) {
    super(`Redirect to disallowed host "${targetHost}" from ${url}`);
    this.name = 'HttpRedirectError';
  }
}

export class HttpUrlValidationError extends Error {
  constructor(url: string, reason: string) {
    super(`Invalid URL "${url}": ${reason}`);
    this.name = 'HttpUrlValidationError';
  }
}

/**
 * Validate a URL and return a consistent error if invalid or disallowed.
 * Parses URL once to avoid double-parsing and potential throw in error path.
 */
function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpUrlValidationError(url, 'malformed URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new HttpUrlValidationError(url, `protocol must be https, got ${parsed.protocol}`);
  }
  if (!ALLOWED_REDIRECT_HOSTS.has(parsed.hostname)) {
    throw new HttpUrlValidationError(url, `host "${parsed.hostname}" is not in the allowlist`);
  }
}

/**
 * Follow redirects manually, validating each hop against the allowlist.
 */
async function fetchWithRedirectValidation(
  url: string,
  options: RequestInit & { signal?: AbortSignal }
): Promise<Response> {
  let currentUrl = url;

  for (let hops = 0; hops < MAX_REDIRECTS; hops++) {
    const response = await fetch(currentUrl, {
      ...options,
      redirect: 'manual',
    });

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect ${status} without Location header from ${currentUrl}`);
      }

      // Resolve relative redirects
      const resolvedUrl = new URL(location, currentUrl).toString();

      // Validate redirect target host — throw HttpRedirectError for disallowed redirect targets
      let parsedRedirect: URL;
      try {
        parsedRedirect = new URL(resolvedUrl);
      } catch {
        throw new HttpRedirectError(currentUrl, resolvedUrl);
      }
      if (
        parsedRedirect.protocol !== 'https:' ||
        !ALLOWED_REDIRECT_HOSTS.has(parsedRedirect.hostname)
      ) {
        throw new HttpRedirectError(currentUrl, parsedRedirect.hostname);
      }

      currentUrl = resolvedUrl;
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
}

export async function fetchHtml(
  url: string,
  options?: RequestInit & { timeoutMs?: number; skipHostValidation?: boolean }
): Promise<string> {
  await rateLimit();

  // Validate initial URL against allowlist (unless explicitly skipped for internal use)
  if (!options?.skipHostValidation) {
    validateUrl(url);
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mergedHeaders = {
    ...DEFAULT_HEADERS,
    ...(options?.headers as Record<string, string>),
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchWithRedirectValidation(url, {
        ...options,
        headers: mergedHeaders,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        lastError = new HttpTimeoutError(url, timeoutMs);
      } else {
        lastError = error as Error;
      }
      // Don't retry on validation/redirect failures (SSRF)
      if (lastError instanceof HttpRedirectError || lastError instanceof HttpUrlValidationError) {
        throw lastError;
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('Failed to fetch after retries');
}

export async function fetchWithCookies(
  url: string,
  options?: RequestInit & { timeoutMs?: number; skipHostValidation?: boolean }
): Promise<{ html: string; cookies: string[] }> {
  await rateLimit();

  // Validate initial URL against allowlist
  if (!options?.skipHostValidation) {
    validateUrl(url);
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const mergedHeaders = {
    ...DEFAULT_HEADERS,
    ...(options?.headers as Record<string, string>),
  };

  try {
    const response = await fetchWithRedirectValidation(url, {
      ...options,
      headers: mergedHeaders,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const cookies = response.headers.getSetCookie?.() ?? [];
    const html = await response.text();

    return { html, cookies };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new HttpTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
