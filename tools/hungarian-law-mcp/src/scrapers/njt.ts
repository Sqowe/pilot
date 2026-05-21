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
 * Supports direct URL lookup by year/number/type, keyword search, and fallback patterns.
 * All declared filters (year, number, type, onlyInForce, titleOnly) are applied consistently.
 */
export async function searchLegislation(params: {
  keyword?: string;
  year?: number;
  number?: number;
  type?: string;
  onlyInForce?: boolean;
  titleOnly?: boolean;
}): Promise<SearchResult[]> {
  let results: SearchResult[] = [];

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
        results = [
          {
            title,
            url,
            year: params.year,
            number: params.number.toString(),
            // Do not assume inForce — we cannot determine status from a direct URL lookup
          },
        ];
      }
    } catch {
      // Fall through to search
    }
  }

  // For keyword search, scrape the search results page (requires session cookies)
  if (results.length === 0 && params.keyword) {
    // Fetch session cookies only when needed for keyword search
    let cookies: string[] = [];
    try {
      const { cookies: sessionCookies } = await fetchWithCookies(NJT_BASE);
      cookies = sessionCookies;
    } catch {
      // Cookie bootstrap failed — continue without cookies
    }

    const searchUrl = `${NJT_BASE}/search?keyword=${encodeURIComponent(params.keyword)}${params.onlyInForce ? '&onlyInForce=true' : ''}${params.year ? `&year=${params.year}` : ''}${params.type ? `&type=${encodeURIComponent(params.type)}` : ''}${params.titleOnly ? '&titleOnly=true' : ''}`;
    try {
      const html = await fetchHtml(searchUrl, {
        headers: {
          Cookie: parseCookiesForRequest(cookies),
          Referer: NJT_BASE,
        },
      });
      results = parseSearchResults(html);
    } catch {
      // If the search URL doesn't work directly, try alternative approach
    }
  }

  // Fallback: construct direct URL if we have year and number
  if (results.length === 0 && params.year && params.number) {
    const typeCodes = params.type
      ? [
          buildNjtSlug(params.year, params.number, params.type).replace(
            `${params.year}-${params.number}-`,
            ''
          ),
        ]
      : ['00-00', '20-22', '10-00', '20-65'];
    for (const code of typeCodes) {
      const slug = `${params.year}-${params.number}-${code}`;
      const url = `${NJT_BASE}/jogszabaly/${slug}`;
      try {
        const html = await fetchHtml(url);
        const $ = cheerio.load(html);
        const title = $('title').text().replace(' - Nemzeti Jogszabálytár', '').trim();
        if (title && !title.includes('404') && !title.includes('Hiba') && title.length > 5) {
          results = [{ title, url, year: params.year, number: params.number.toString() }];
          break;
        }
      } catch {
        continue;
      }
    }
  }

  // Post-filter results to honor all declared filters consistently
  return filterSearchResults(results, params);
}

/**
 * Apply all search filters to results strictly.
 * When a filter is set and the result lacks the corresponding metadata,
 * the result is treated as non-matching (excluded).
 */
export function filterSearchResults(
  results: SearchResult[],
  params: {
    year?: number;
    number?: number;
    type?: string;
    onlyInForce?: boolean;
    titleOnly?: boolean;
    keyword?: string;
  }
): SearchResult[] {
  const filtered: SearchResult[] = [];

  for (const r of results) {
    // Enrich result metadata from URL/title if missing
    const enriched = enrichResultMetadata(r);

    if (params.year) {
      if (!enriched.year || enriched.year !== params.year) continue;
    }
    if (params.number) {
      if (!enriched.number || enriched.number !== params.number.toString()) continue;
    }
    if (params.type) {
      // Strict: if type cannot be determined, exclude the result
      if (!enriched.type) continue;
      if (!enriched.type.toLowerCase().includes(params.type.toLowerCase())) continue;
    }
    if (params.onlyInForce) {
      // Non-strict: exclude results explicitly known to NOT be in force.
      if (enriched.inForce === false) continue;
    }
    if (params.titleOnly && params.keyword) {
      if (!enriched.title.toLowerCase().includes(params.keyword.toLowerCase())) continue;
    }

    // Return the enriched object so downstream consumers have consistent metadata
    filtered.push(enriched);
  }

  return filtered;
}

/**
 * Try to extract year/number/type from a search result's URL or title when not already set.
 */
function enrichResultMetadata(result: SearchResult): SearchResult {
  if (result.year && result.number && result.type) return result;

  const enriched = { ...result };

  // Try to parse from URL slug: /jogszabaly/{year}-{number}-{type_codes}
  const slugMatch = result.url.match(/\/jogszabaly\/(\d{4})-(\d+)-(\d{2}-\d{2})/);
  if (slugMatch) {
    if (!enriched.year) enriched.year = parseInt(slugMatch[1], 10);
    if (!enriched.number) enriched.number = slugMatch[2];
    // Infer type from URL type codes
    if (!enriched.type) {
      const typeCode = slugMatch[3];
      if (typeCode === '00-00') enriched.type = 'törvény';
      else if (typeCode === '20-22') enriched.type = 'Korm. rendelet';
      else if (typeCode === '10-00') enriched.type = 'törvényerejű rendelet';
    }
  }

  // Try to parse from title: "YYYY. évi ..." pattern
  if (!enriched.year) {
    const yearMatch = result.title.match(/(\d{4})\.\s*évi/);
    if (yearMatch) enriched.year = parseInt(yearMatch[1], 10);
  }

  // Try to extract type from title
  if (!enriched.type) {
    const titleLower = result.title.toLowerCase();
    if (titleLower.includes('törvény')) enriched.type = 'törvény';
    else if (titleLower.includes('korm. rendelet') || titleLower.includes('kormányrendelet'))
      enriched.type = 'Korm. rendelet';
    else if (titleLower.includes('rendelet')) enriched.type = 'rendelet';
    else if (titleLower.includes('határozat')) enriched.type = 'határozat';
  }

  return enriched;
}

/**
 * Parse Set-Cookie header strings into a Cookie request header value.
 * Extracts only the name=value pair from each Set-Cookie (strips attributes like Path, HttpOnly, etc.)
 */
function parseCookiesForRequest(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((cookie) => cookie.split(';')[0].trim())
    .filter((pair) => pair.includes('='))
    .join('; ');
}

/**
 * Parse search results HTML into structured data.
 */
export function parseSearchResults(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  // Look for result items — deduplicate by URL to avoid navigation artifacts
  $("a[href*='/jogszabaly/']").each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const title = $el.text().trim();

    if (href && title && title.length > 3) {
      const url = href.startsWith('http') ? href : `${NJT_BASE}${href}`;
      if (seenUrls.has(url)) return;
      seenUrls.add(url);
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

/** Allowed hosts for NJT law page fetching (defense-in-depth). */
const NJT_ALLOWED_HOSTS = new Set(['njt.jog.gov.hu', 'www.njt.jog.gov.hu']);

/**
 * Validate that a URL is a valid NJT law page URL.
 * Defense-in-depth: validates at scraper boundary even though HTTP utility also validates.
 */
function validateNjtUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      NJT_ALLOWED_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith('/jogszabaly/')
    );
  } catch {
    return false;
  }
}

/**
 * Get the full text of a law by its full URL.
 */
export async function getLawByUrl(url: string): Promise<LawDocument | null> {
  // Defense-in-depth: validate URL at scraper boundary
  if (!validateNjtUrl(url)) {
    return null;
  }

  // Check cache
  const cached = lawCache.get(url);
  if (cached) {
    return parseLawPage(cached, url);
  }

  try {
    const html = await fetchHtml(url);
    lawCache.set(url, html);
    return parseLawPage(html, url);
  } catch {
    return null;
  }
}

/**
 * Get a law by year and number, trying common type patterns.
 * When type is explicitly provided, only that type is tried (no fallback to other types).
 */
export async function getLawByReference(
  year: number,
  number: number,
  type?: string
): Promise<LawDocument | null> {
  // If type is specified, only try the specific pattern — no fallback to other types
  if (type) {
    const slug = buildNjtSlug(year, number, type);
    return getLawBySlug(slug);
  }

  // No type specified — try common patterns
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
export function parseLawPage(html: string, url: string): LawDocument | null {
  const $ = cheerio.load(html);

  // Extract title from the page
  const pageTitle = $('title').text().replace(' - Nemzeti Jogszabálytár', '').trim();
  if (!pageTitle || pageTitle.includes('404') || pageTitle.includes('Hiba')) {
    return null;
  }

  // Extract the full title — compose from h1 (legal reference) and h2 (descriptive title)
  const h1Text = $('h1').first().text().trim();
  const h2Text = $('h2').first().text().trim();
  let fullTitle: string;
  if (h1Text && h2Text) {
    fullTitle = `${h1Text} — ${h2Text}`;
  } else {
    fullTitle = h1Text || h2Text || pageTitle;
  }

  // Extract table of contents
  const tableOfContents: string[] = [];
  $('.tartalomjegyzek li, .toc li, nav li').each((_, el) => {
    const text = $(el).text().trim();
    if (text) tableOfContents.push(text);
  });

  // Extract sections (paragraphs/§)
  const sections: LawSection[] = [];
  let currentSection: LawSection | null = null;

  // Select content container in explicit priority order (most specific first).
  // Avoid grouped selector + .first() which returns document-order, not priority-order.
  const contentSelectors = ['.jogszabaly-szoveg', '.law-text', 'article', '#content', 'main'];
  let contentHtml: cheerio.Cheerio<AnyNode> | null = null;
  for (const selector of contentSelectors) {
    const el = $(selector).first();
    if (el.length) {
      contentHtml = el;
      break;
    }
  }
  if (!contentHtml) {
    contentHtml = $('body');
  }

  // Walk through only leaf-level text nodes to avoid duplication from container elements.
  contentHtml.find('p, h1, h2, h3, h4, h5, h6, li, span.szakasz').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (!text) return;

    // Detect section headers (§ signs) — match the base section number
    const sectionMatch = text.match(/^(\d+[/A-Z]*)\.\s*§/);
    if (sectionMatch || $el.hasClass('szakasz')) {
      const baseId = sectionMatch ? `${sectionMatch[1]}. §` : text.slice(0, 20);

      // If this paragraph belongs to the same base section, append to it
      if (currentSection && currentSection.id === baseId) {
        currentSection.content += '\n' + text;
      } else {
        // New section — push the previous one and start fresh
        if (currentSection) {
          sections.push(currentSection);
        }
        currentSection = { id: baseId, content: text };
      }
    } else if (currentSection) {
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
 * Uses leaf-node strategy to avoid text duplication from nested containers.
 */
function extractFullText($: cheerio.CheerioAPI, container: cheerio.Cheerio<AnyNode>): string {
  const lines: string[] = [];

  container.find('p, h1, h2, h3, h4, h5, h6, li, span.szakasz').each((_, el) => {
    const $el = $(el);
    const tagName = (el as unknown as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const text = $el.text().trim();

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

  // Extract the base section number for exact matching (e.g., "1. §" from "1. § (2)")
  const baseMatch = normalizedRef.match(/^(\d+[/A-Z]*)\.\s*§/);
  const baseId = baseMatch ? `${baseMatch[1]}. §` : normalizedRef;

  // Step 1: Exact ID match (canonical comparison)
  for (const section of law.sections) {
    if (section.id === baseId) {
      // If a specific subsection is requested (e.g., "1. § (2)"), extract it
      if (normalizedRef !== baseId) {
        // Extract the subsection number marker (e.g., "(2)" from "1. § (2)")
        const subNumMatch = normalizedRef.match(/\((\d+[a-z]?)\)\s*$/);
        const shortMarker = subNumMatch ? `(${subNumMatch[1]})` : null;

        // Try fully qualified reference first, then short marker
        if (section.content.includes(normalizedRef)) {
          return extractSubsection(section.content, normalizedRef);
        } else if (shortMarker && section.content.includes(shortMarker)) {
          return extractSubsection(section.content, shortMarker);
        }
        // Subsection not found within the section — return null, not the full section
        return null;
      }
      // Base section requested (no subsection) — return full content
      return section.content;
    }
  }

  // Step 2: Fuzzy fallback — only if exact match failed, search by content prefix
  for (const section of law.sections) {
    if (section.content.startsWith(normalizedRef)) {
      return section.content;
    }
  }

  // Step 3: Fallback — search in full text with anchored pattern
  const fullText = law.fullText;
  const refEscaped = normalizedRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refPattern = new RegExp(`${refEscaped}[\\s\\S]*?(?=\\d+[/A-Z]*\\.\\s*§|$)`, 'i');
  const match = fullText.match(refPattern);
  return match ? match[0].trim() : null;
}

/**
 * Extract a specific subsection from section content using line-based parsing.
 * Stops at the next subsection marker (e.g., "(3)", "(4)") or end of content.
 */
function extractSubsection(sectionContent: string, subsectionRef: string): string {
  const lines = sectionContent.split('\n');
  const resultLines: string[] = [];
  let capturing = false;

  // Pattern to detect subsection markers like "(2)", "(3)", "(3a)", "1. § (2)", etc.
  const subsectionMarkerPattern = /^\(?(\d+[a-z]?)\)|^\d+[/A-Z]*\.\s*§\s*\(\d+/;

  for (const line of lines) {
    const trimmed = line.trim();

    if (capturing) {
      // Stop if we hit the next subsection marker or a new section marker
      if (subsectionMarkerPattern.test(trimmed) || trimmed.match(/^\d+[/A-Z]*\.\s*§/)) {
        break;
      }
      resultLines.push(trimmed);
    } else if (trimmed.includes(subsectionRef)) {
      capturing = true;
      resultLines.push(trimmed);
    }
  }

  return resultLines.length > 0 ? resultLines.join('\n') : sectionContent;
}
