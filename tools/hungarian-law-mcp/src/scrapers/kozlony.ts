/**
 * Scraper for magyarkozlony.hu (Magyar Közlöny — Hungarian Official Gazette)
 * Handles listing gazette issues and retrieving PDF links.
 */

import * as cheerio from 'cheerio';
import { fetchHtml } from '../utils/http.js';
import { Cache } from '../utils/cache.js';

const KOZLONY_BASE = 'https://www.magyarkozlony.hu';

// Cache gazette listings for 15 minutes
const listingCache = new Cache<GazetteIssue[]>(15);

export interface GazetteIssue {
  title: string;
  date: string;
  viewUrl?: string;
  downloadUrl?: string;
  type: 'magyar_kozlony' | 'hivatalos_ertesito' | 'other';
  year: number;
  issueNumber?: number;
}

/**
 * List gazette issues, optionally filtered by year and month.
 */
export async function listGazetteIssues(params: {
  year?: number;
  month?: number;
  page?: number;
}): Promise<GazetteIssue[]> {
  const cacheKey = `gazette-${params.year ?? 'all'}-${params.month ?? 'all'}-${params.page ?? 1}`;
  const cached = listingCache.get(cacheKey);
  if (cached) return cached;

  // Build URL with filters
  let url = KOZLONY_BASE;
  const queryParams: string[] = [];

  if (params.page && params.page > 1) {
    queryParams.push(`page=${params.page}`);
  }

  // The site uses form-based filtering, but we can try URL params
  if (queryParams.length > 0) {
    url += '?' + queryParams.join('&');
  }

  try {
    const html = await fetchHtml(url);
    const issues = parseGazetteList(html, params.year, params.month);
    listingCache.set(cacheKey, issues);
    return issues;
  } catch (error) {
    return [];
  }
}

/**
 * Parse the gazette listing page.
 */
function parseGazetteList(html: string, filterYear?: number, filterMonth?: number): GazetteIssue[] {
  const $ = cheerio.load(html);
  const issues: GazetteIssue[] = [];

  // Find gazette issue links
  $("a[href*='/dokumentumok/']").each((_, el) => {
    const $el = $(el);
    const title = $el.text().trim();
    const href = $el.attr('href') || '';

    if (!title || title.length < 5) return;

    // Determine type
    let type: GazetteIssue['type'] = 'other';
    if (title.includes('Magyar Közlöny')) {
      type = 'magyar_kozlony';
    } else if (title.includes('Hivatalos Értesítő')) {
      type = 'hivatalos_ertesito';
    }

    // Extract year and issue number from title
    // Pattern: "Magyar Közlöny 2026. évi 55. szám"
    const yearMatch = title.match(/(\d{4})\.\s*évi/);
    const numberMatch = title.match(/(\d+)\.\s*szám/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
    const issueNumber = numberMatch ? parseInt(numberMatch[1], 10) : undefined;

    // Apply filters
    if (filterYear && year !== filterYear) return;

    // Determine if this is a view or download link
    const isDownload = href.includes('/letoltes');
    const isView = href.includes('/megtekintes');

    const fullUrl = href.startsWith('http') ? href : `${KOZLONY_BASE}${href}`;

    // Find the date - usually in a sibling or parent element
    const parentText = $el.parent().text();
    const dateMatch = parentText.match(/(\d{4})\.\s*\w+\s*(\d{1,2})\./);
    const date = dateMatch ? `${dateMatch[0]}` : '';

    // Avoid duplicates - only add if we haven't seen this title
    const existing = issues.find((i) => i.title === title);
    if (existing) {
      if (isDownload && !existing.downloadUrl) {
        existing.downloadUrl = fullUrl;
      }
      if (isView && !existing.viewUrl) {
        existing.viewUrl = fullUrl;
      }
    } else {
      issues.push({
        title,
        date,
        viewUrl: isView ? fullUrl : undefined,
        downloadUrl: isDownload ? fullUrl : undefined,
        type,
        year,
        issueNumber,
      });
    }
  });

  // Apply month filter on dates
  if (filterMonth) {
    const monthNames = [
      'január',
      'február',
      'március',
      'április',
      'május',
      'június',
      'július',
      'augusztus',
      'szeptember',
      'október',
      'november',
      'december',
    ];
    const monthName = monthNames[filterMonth - 1];
    return issues.filter((i) => i.date.includes(monthName) || !i.date);
  }

  return issues;
}

/**
 * Get details about a specific gazette issue by year and number.
 */
export async function getGazetteIssue(
  year: number,
  issueNumber: number
): Promise<GazetteIssue | null> {
  const issues = await listGazetteIssues({ year });
  return issues.find((i) => i.year === year && i.issueNumber === issueNumber) ?? null;
}

/**
 * Get the help/about page content for the gazette site.
 */
export async function getGazetteHelp(): Promise<string> {
  try {
    const html = await fetchHtml(`${KOZLONY_BASE}/segitseg`);
    const $ = cheerio.load(html);
    // Extract main content
    const content = $('main, .content, article, #content').first().text().trim();
    return content || $('body').text().slice(0, 2000).trim();
  } catch {
    return 'Unable to fetch gazette help page.';
  }
}
