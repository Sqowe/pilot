/**
 * Scraper for magyarkozlony.hu (Magyar Közlöny — Hungarian Official Gazette)
 * Handles listing gazette issues and retrieving PDF links.
 */

import * as cheerio from 'cheerio';
import { fetchHtml } from '../utils/http.js';
import { Cache } from '../utils/cache.js';

const KOZLONY_BASE = 'https://www.magyarkozlony.hu';

/** Hungarian month names for date parsing. */
const HUNGARIAN_MONTHS = [
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
] as const;

/** Regex that matches only real Hungarian dates like "2026. május 19." */
const HUNGARIAN_DATE_REGEX = new RegExp(
  `(\\d{4})\\.\\s*(${HUNGARIAN_MONTHS.join('|')})\\s*(\\d{1,2})\\.`,
  'u'
);

// Cache gazette listings for 15 minutes
const listingCache = new Cache<GazetteIssue[]>(15);

export interface GazetteIssue {
  title: string;
  date: string;
  viewUrl?: string;
  downloadUrl?: string;
  type: 'magyar_kozlony' | 'hivatalos_ertesito' | 'other';
  year?: number;
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

  if (queryParams.length > 0) {
    url += '?' + queryParams.join('&');
  }

  const html = await fetchHtml(url);
  const issues = parseGazetteList(html, params.year, params.month);
  listingCache.set(cacheKey, issues);
  return issues;
}

/**
 * Fetch a page of gazette issues (unfiltered) and return both raw and filtered results.
 * Single fetch per page — avoids double network traffic.
 */
async function fetchGazettePage(
  page: number,
  year?: number,
  type?: GazetteIssue['type']
): Promise<{ raw: GazetteIssue[]; filtered: GazetteIssue[] }> {
  const rawCacheKey = `gazette-raw-page-${page}`;
  let raw = listingCache.get(rawCacheKey);

  if (!raw) {
    let url = KOZLONY_BASE;
    if (page > 1) {
      url += `?page=${page}`;
    }
    const html = await fetchHtml(url);
    raw = parseGazetteList(html); // no filters
    listingCache.set(rawCacheKey, raw);
  }

  // Apply year + type filter in-memory from the raw results
  const filtered = raw.filter((i) => {
    if (year && i.year !== year) return false;
    if (type && i.type !== type) return false;
    return true;
  });

  return { raw, filtered };
}

/**
 * Parse the gazette listing page.
 */
export function parseGazetteList(
  html: string,
  filterYear?: number,
  filterMonth?: number
): GazetteIssue[] {
  const $ = cheerio.load(html);
  const issues: GazetteIssue[] = [];
  const issueMap = new Map<string, number>(); // dedupKey → index in issues array

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
    const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
    const issueNumber = numberMatch ? parseInt(numberMatch[1], 10) : undefined;

    // Apply year filter — skip entries with unknown year when filter is set
    if (filterYear && (!year || year !== filterYear)) return;

    // Determine if this is a view or download link
    const isDownload = href.includes('/letoltes');
    const isView = href.includes('/megtekintes');

    const fullUrl = href.startsWith('http') ? href : `${KOZLONY_BASE}${href}`;

    // Find the date - look for a sibling span/time element first, then fall back to parent text
    // Use strict regex with explicit Hungarian month names to avoid matching "évi" from titles
    let date = '';
    const $siblings = $el.siblings('span, time');
    if ($siblings.length > 0) {
      $siblings.each((_, sib) => {
        if (date) return; // already found
        const sibText = $(sib).text().trim();
        const sibMatch = sibText.match(HUNGARIAN_DATE_REGEX);
        if (sibMatch) {
          date = sibMatch[0];
        }
      });
    }
    if (!date) {
      // Fallback: search parent text but with strict month-name regex
      const parentText = $el.parent().text();
      const dateMatch = parentText.match(HUNGARIAN_DATE_REGEX);
      if (dateMatch) {
        date = dateMatch[0];
      }
    }

    // Avoid duplicates — use canonical fields (type + year + issueNumber) when available,
    // fall back to normalized title when identifiers are missing.
    const dedupKey =
      year && issueNumber
        ? `${type}|${year}|${issueNumber}`
        : `title:${title.replace(/\s+/g, ' ').trim()}|${type}`;
    const existingIdx = issueMap.get(dedupKey);
    if (existingIdx !== undefined) {
      const existing = issues[existingIdx];
      if (isDownload && !existing.downloadUrl) {
        existing.downloadUrl = fullUrl;
      }
      if (isView && !existing.viewUrl) {
        existing.viewUrl = fullUrl;
      }
      // Backfill missing metadata from later duplicate entries
      if (!existing.date && date) {
        existing.date = date;
      }
      if (!existing.year && year) {
        existing.year = year;
      }
      if (!existing.issueNumber && issueNumber) {
        existing.issueNumber = issueNumber;
      }
    } else {
      issueMap.set(dedupKey, issues.length);
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

  // Apply month filter on dates — exclude entries with unknown dates
  if (filterMonth) {
    // Fail fast for invalid month values
    if (filterMonth < 1 || filterMonth > 12 || !Number.isInteger(filterMonth)) {
      return [];
    }
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
    return issues.filter((i) => i.date && i.date.includes(monthName));
  }

  return issues;
}

/**
 * Get details about a specific gazette issue by year and number.
 * Iterates through pages until the issue is found or no more raw results exist.
 * Uses single fetch per page (no double network traffic).
 */
export async function getGazetteIssue(
  year: number,
  issueNumber: number,
  type: GazetteIssue['type'] = 'magyar_kozlony',
  maxPages: number = 10
): Promise<GazetteIssue | null> {
  for (let page = 1; page <= maxPages; page++) {
    const { raw, filtered } = await fetchGazettePage(page, year, type);
    const found = filtered.find((i) => i.issueNumber === issueNumber);
    if (found) return found;

    // Terminate when raw page has no entries (end of available pages)
    if (raw.length === 0) break;
  }
  return null;
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
