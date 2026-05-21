/**
 * HTTP utilities for EU law APIs.
 * Serialized rate limiting, timeouts via AbortController, and retries.
 */

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'EULawMCP/1.0 (MCP Server; +https://github.com/open-cowork)',
  Accept: 'application/json, application/sparql-results+json',
};

const MIN_REQUEST_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Serialized rate limiter using a promise queue.
 * Guarantees minimum spacing between requests even under concurrency.
 */
let requestQueue: Promise<void> = Promise.resolve();

function enqueueRateLimit(): Promise<void> {
  const previous = requestQueue;
  let resolve: () => void;
  requestQueue = new Promise<void>((r) => {
    resolve = r;
  });

  return previous.then(
    () =>
      new Promise<void>((done) => {
        setTimeout(() => {
          resolve!();
          done();
        }, MIN_REQUEST_INTERVAL_MS);
      })
  );
}

/**
 * Fetch with timeout using AbortController.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      redirect: 'follow',
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Normalize and merge headers safely, handling all HeadersInit forms.
 */
function mergeHeaders(defaults: Record<string, string>, custom?: HeadersInit): Headers {
  const merged = new Headers(defaults);
  if (custom) {
    const customHeaders = new Headers(custom);
    for (const [key, value] of customHeaders.entries()) {
      merged.set(key, value);
    }
  }
  return merged;
}

/**
 * Check if an HTTP error is retriable (transient).
 */
function isRetriable(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  await enqueueRateLimit();

  const headers = mergeHeaders(DEFAULT_HEADERS, options?.headers);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        if (!isRetriable(response.status)) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        throw new Error(`HTTP ${response.status} (retriable): ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error as Error;
      const msg = lastError.message;
      // Don't retry non-retriable HTTP errors
      if (msg.includes('HTTP') && !msg.includes('retriable')) {
        throw lastError;
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError ?? new Error('Failed to fetch after retries');
}

export async function fetchText(url: string, options?: RequestInit): Promise<string> {
  await enqueueRateLimit();

  const headers = mergeHeaders(
    { ...DEFAULT_HEADERS, Accept: 'text/html, application/xhtml+xml, text/plain' },
    options?.headers
  );

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        if (!isRetriable(response.status)) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        throw new Error(`HTTP ${response.status} (retriable): ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error as Error;
      const msg = lastError.message;
      if (msg.includes('HTTP') && !msg.includes('retriable')) {
        throw lastError;
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError ?? new Error('Failed to fetch after retries');
}
