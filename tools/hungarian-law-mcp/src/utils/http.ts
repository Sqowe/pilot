/**
 * HTTP utility with rate limiting and retries for scraping Hungarian law sites.
 */

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'HungarianLawMCP/1.0 (MCP Server; +https://github.com/open-cowork)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.5',
};

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

export async function fetchHtml(url: string, options?: RequestInit): Promise<string> {
  await rateLimit();

  const mergedHeaders = {
    ...DEFAULT_HEADERS,
    ...(options?.headers as Record<string, string>),
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: mergedHeaders,
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error as Error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError ?? new Error('Failed to fetch after retries');
}

export async function fetchWithCookies(
  url: string,
  options?: RequestInit
): Promise<{ html: string; cookies: string[] }> {
  await rateLimit();

  const mergedHeaders = {
    ...DEFAULT_HEADERS,
    ...(options?.headers as Record<string, string>),
  };

  const response = await fetch(url, {
    ...options,
    headers: mergedHeaders,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const cookies = response.headers.getSetCookie?.() ?? [];
  const html = await response.text();

  return { html, cookies };
}
