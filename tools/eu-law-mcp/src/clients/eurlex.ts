/**
 * EUR-Lex document retrieval client.
 * Uses direct URL patterns to fetch document content — no auth needed.
 */

import { fetchText } from '../utils/http.js';
import { buildEurLexUrls } from '../utils/celex.js';
import { Cache } from '../utils/cache.js';

// Cache document text for 60 minutes, max 100 entries (HTML can be large)
const docCache = new Cache<string>(60, 100);

/**
 * Fetch the HTML text of an EU legal document by CELEX number.
 * Validates response based on HTTP status and content structure.
 */
export async function fetchDocumentHtml(celex: string, language = 'EN'): Promise<string | null> {
  const cacheKey = `${celex}-${language}`;
  const cached = docCache.get(cacheKey);
  if (cached) return cached;

  const urls = buildEurLexUrls(celex, language);

  try {
    const html = await fetchText(urls.html);

    // Structural validation: EUR-Lex documents contain a TexteOnly or doc-content div
    // Also check for known error indicators
    const hasContent =
      html.includes('TexteOnly') ||
      html.includes('doc-content') ||
      html.includes('eli-main-title') ||
      html.includes('<article');

    const isError =
      html.includes('No document found') ||
      html.includes('Aucun document trouvé') ||
      html.includes('Kein Dokument gefunden') ||
      html.includes('class="error"') ||
      html.includes('HTTP Status 404');

    if (isError || !hasContent) {
      return null;
    }

    docCache.set(cacheKey, html);
    return html;
  } catch {
    return null;
  }
}

/**
 * Extract plain text from EUR-Lex HTML content.
 * Simple extraction without cheerio — strips tags and normalizes whitespace.
 */
export function htmlToText(html: string): string {
  // Remove script/style blocks
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Convert common block elements to newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th)[^>]*>/gi, '\n');

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");

  // Normalize whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  text = text.trim();

  return text;
}

/**
 * Get document text content by CELEX number.
 */
export async function getDocumentText(
  celex: string,
  language = 'EN',
  maxLength = 15000
): Promise<{ text: string; url: string; truncated: boolean } | null> {
  const html = await fetchDocumentHtml(celex, language);
  if (!html) return null;

  const urls = buildEurLexUrls(celex, language);
  let text = htmlToText(html);
  let truncated = false;

  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    truncated = true;
  }

  return { text, url: urls.page, truncated };
}
