/**
 * Scraper for njt.jog.gov.hu (Nemzeti Jogszabálytár)
 * Handles search, law text retrieval, and structured parsing.
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { fetchHtml, fetchWithCookies } from '../utils/http.js';
import { Cache } from '../utils/cache.js';
import { buildNjtSlug } from '../utils/hungarian.js';

const NJT_BASE = 'https://njt.jog.gov.hu';

// Cache law pages for 60 minutes (laws don't change often)
const lawCache = new Cache<string>(60);

export interface SearchResult {
  title: string;
  url: string;
  description?: string;
  year?: number;
  number?: string;
  type?: string;
  inForce?: boolean;
}

export interface LawSection {
  id: string; // e.g., "1. §", "2. § (1)"
  title?: string;
  content: string;
}

export interface LawDocument {
  title: string;
  fullTitle: string;
  url: string;
  sections: LawSection[];
  tableOfContents: string[];
  fullText: string;
}

/**
 * Search for legislation on njt.hu.
 * Uses the search form with POST request.
 */
export async function searchLegislation(params: {
  keyword?: string;
  year?: number;
  number?: number;
  type?: string;
  onlyInForce?: boolean;
  titleOnly?: boolean;
}): Promise<SearchResult[]> {
  // First, get the search page to extract any CSRF token or session
  const { html: _searchPage, cookies } = await fetchWithCookies(NJT_BASE);

  // Build form data for the search
  const formData = new URLSearchParams();

  if (params.year) {
    formData.set('year', params.year.toString());
  }
  if (params.number) {
    formData.set('number', params.number.toString());
  }
  if (params.keyword) {
    formData.set('keyword', params.keyword);
  }
  if (params.onlyInForce) {
    formData.set('onlyInForce', 'true');
  }
  if (params.titleOnly) {
    formData.set('titleOnly', 'true');
  }

  // Try direct URL-based search approach
  // njt.hu supports URL-based navigation for simple lookups
  if (params.year && params.number && !params.keyword) {
    const slug = buildNjtSlug(params.year, params.number, params.type);
    const url = `${NJT_BASE}/jogszabaly/${slug}`;
    try {
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);
      const title = $('title').text().replace(' - Nemzeti Jogszabálytár', '').trim();
      if (title && !title.includes('404') && !title.includes('Hiba')) {
        return [
          {
            title,
            url,
            year: params.year,
            number: params.number.toString(),
            inForce: true,
          },
        ];
      }
    } catch {
      // Fall through to search
    }
  }

  // For keyword search, scrape the search results page
  // The njt.hu search uses a specific URL pattern for results
  if (params.keyword) {
    const searchUrl = `${NJT_BASE}/search?keyword=${encodeURIComponent(params.keyword)}${params.onlyInForce ? '&onlyInForce=true' : ''}${params.year ? `&year=${params.year}` : ''}`;
    try {
      const html = await fetchHtml(searchUrl, {
        headers: {
          Cookie: cookies.join('; '),
          Referer: NJT_BASE,
        },
      });
      return parseSearchResults(html);
    } catch {
      // If the search URL doesn't work directly, try alternative approach
    }
  }

  // Fallback: construct direct URL if we have year and number
  if (params.year && params.number) {
    // Try common type codes
    const typeCodes = ['00-00', '20-22', '10-00', '20-65'];
    for (const code of typeCodes) {
      const slug = `${params.year}-${params.number}-${code}`;
      const url = `${NJT_BASE}/jogszabaly/${slug}`;
      try {
        const html = await fetchHtml(url);
        const $ = cheerio.load(html);
        const title = $('title').text().replace(' - Nemzeti Jogszabálytár', '').trim();
        if (title && !title.includes('404') && !title.includes('Hiba') && title.length > 5) {
          return [{ title, url, year: params.year, number: params.number.toString() }];
        }
      } catch {
        continue;
      }
    }
  }

  return [];
}

/**
 * Parse search results HTML into structured data.
 */
function parseSearchResults(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  // Look for result items - the exact selectors depend on the page structure
  $("a[href*='/jogszabaly/']").each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const title = $el.text().trim();

    if (href && title && title.length > 3) {
      const url = href.startsWith('http') ? href : `${NJT_BASE}${href}`;
      results.push({ title, url });
    }
  });

  return results;
}

/**
 * Get the full text of a law by its njt.hu URL slug.
 */
export async function getLawBySlug(slug: string): Promise<LawDocument | null> {
  const url = `${NJT_BASE}/jogszabaly/${slug}`;
  return getLawByUrl(url);
}

/**
 * Get the full text of a law by its full URL.
 */
export async function getLawByUrl(url: string): Promise<LawDocument | null> {
  // Check cache
  const cached = lawCache.get(url);
  if (cached) {
    return parseLawPage(cached, url);
  }

  try {
    const html = await fetchHtml(url);
    lawCache.set(url, html);
    return parseLawPage(html, url);
  } catch (error) {
    return null;
  }
}

/**
 * Get a law by year and number, trying common type patterns.
 */
export async function getLawByReference(
  year: number,
  number: number,
  type?: string
): Promise<LawDocument | null> {
  // If type is specified, try the specific pattern first
  if (type) {
    const slug = buildNjtSlug(year, number, type);
    const result = await getLawBySlug(slug);
    if (result) return result;
  }

  // Try common patterns
  const patterns = [
    `${year}-${number}-00-00`, // törvény
    `${year}-${number}-00-00.0`, // törvény with version
    `${year}-${number}-20-22`, // Korm. rendelet
    `${year}-${number}-10-00`, // törvényerejű rendelet
  ];

  for (const slug of patterns) {
    const result = await getLawBySlug(slug);
    if (result) return result;
  }

  return null;
}

/**
 * Parse a law page HTML into a structured document.
 */
function parseLawPage(html: string, url: string): LawDocument | null {
  const $ = cheerio.load(html);

  // Extract title from the page
  const pageTitle = $('title').text().replace(' - Nemzeti Jogszabálytár', '').trim();
  if (!pageTitle || pageTitle.includes('404') || pageTitle.includes('Hiba')) {
    return null;
  }

  // Extract the full title (usually in an h1 or h2)
  const fullTitle = $('h1').first().text().trim() || $('h2').first().text().trim() || pageTitle;

  // Extract table of contents
  const tableOfContents: string[] = [];
  $('.tartalomjegyzek li, .toc li, nav li').each((_, el) => {
    const text = $(el).text().trim();
    if (text) tableOfContents.push(text);
  });

  // Extract sections (paragraphs/§)
  const sections: LawSection[] = [];
  let currentSection: LawSection | null = null;

  // The law text is typically in the main content area
  // njt.hu uses specific class names for law structure
  const contentArea = $('.jogszabaly-szoveg, .law-text, main, #content, article').first();
  const contentHtml = contentArea.length ? contentArea : $('body');

  // Walk through the content and extract sections
  contentHtml.find('*').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();

    // Detect section headers (§ signs)
    if (text.match(/^\d+[/A-Z]*\.\s*§/) || $el.hasClass('szakasz')) {
      if (currentSection) {
        sections.push(currentSection);
      }
      const sectionId = text.match(/^(\d+[/A-Z]*\.\s*§)/)?.[1] || text.slice(0, 20);
      currentSection = { id: sectionId, content: text };
    } else if (currentSection && text && !$el.find('*').length) {
      // Append to current section if it's a leaf text node
      currentSection.content += '\n' + text;
    }
  });

  if (currentSection) {
    sections.push(currentSection);
  }

  // Get full text as markdown-like format
  const fullText = extractFullText($, contentHtml);

  return {
    title: pageTitle,
    fullTitle,
    url,
    sections,
    tableOfContents,
    fullText,
  };
}

/**
 * Extract the full text of the law in a readable format.
 */
function extractFullText($: cheerio.CheerioAPI, container: cheerio.Cheerio<AnyNode>): string {
  const lines: string[] = [];

  container.find('p, h1, h2, h3, h4, h5, h6, li, div.szakasz, div.bekezdes').each((_, el) => {
    const $el = $(el);
    const tagName = (el as unknown as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const text = $el.clone().children('script, style').remove().end().text().trim();

    if (!text) return;

    // Format based on element type
    if (tagName.startsWith('h')) {
      const level = parseInt(tagName[1], 10);
      lines.push('');
      lines.push('#'.repeat(level) + ' ' + text);
      lines.push('');
    } else {
      lines.push(text);
    }
  });

  // If we got very little from structured parsing, fall back to raw text
  if (lines.filter((l) => l.trim()).length < 5) {
    return container.text().replace(/\s+/g, ' ').trim();
  }

  return lines.join('\n');
}

/**
 * Get a specific section of a law.
 */
export async function getLawSection(slug: string, sectionRef: string): Promise<string | null> {
  const law = await getLawBySlug(slug);
  if (!law) return null;

  // Normalize the section reference
  const normalizedRef = sectionRef.replace(/\s+/g, ' ').trim();

  // Search in sections
  for (const section of law.sections) {
    if (section.id.includes(normalizedRef) || section.content.startsWith(normalizedRef)) {
      return section.content;
    }
  }

  // Fallback: search in full text
  const fullText = law.fullText;
  const refPattern = new RegExp(
    `${normalizedRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\d+[/A-Z]*\\.\\s*§|$)`,
    'i'
  );
  const match = fullText.match(refPattern);
  return match ? match[0].trim() : null;
}
