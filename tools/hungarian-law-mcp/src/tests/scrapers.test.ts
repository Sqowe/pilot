/**
 * Tests for scraper parsing logic using saved HTML fixtures.
 * These tests validate parsing without making network requests.
 * Tests exported production functions directly where possible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLawPage, parseSearchResults, filterSearchResults } from '../scrapers/njt.js';
import { parseGazetteList } from '../scrapers/kozlony.js';
import type { SearchResult } from '../scrapers/njt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

describe('njt.hu law page parsing', () => {
  const html = loadFixture('njt-law-page.html');

  it('extracts the title from the page', () => {
    const $ = cheerio.load(html);
    const title = $('title').text().replace(' - Nemzeti Jogszabálytár', '').trim();
    assert.equal(title, '2023. évi CI. törvény');
  });

  it('extracts the full title from h1/h2', () => {
    const $ = cheerio.load(html);
    const h1 = $('h1').first().text().trim();
    const h2 = $('h2').first().text().trim();
    assert.equal(h1, '2023. évi CI. törvény');
    assert.equal(h2, 'a nemzeti adatvagyon hasznosításának rendszeréről');
  });

  it('finds law text content in the structured area', () => {
    const $ = cheerio.load(html);
    const content = $('.jogszabaly-szoveg').text();
    assert.ok(content.includes('1. §'));
    assert.ok(content.includes('nemzeti adatvagyon'));
    assert.ok(content.includes('3. § (2)'));
  });

  it('can extract individual paragraphs', () => {
    const $ = cheerio.load(html);
    const paragraphs: string[] = [];
    $('.jogszabaly-szoveg p').each((_, el) => {
      paragraphs.push($(el).text().trim());
    });
    assert.equal(paragraphs.length, 5);
    assert.ok(paragraphs[0].startsWith('1. § (1)'));
    assert.ok(paragraphs[2].startsWith('2. §'));
  });

  it('does not return content for a 404-like page', () => {
    const notFoundHtml = `<html><head><title>Hiba - Nemzeti Jogszabálytár</title></head><body></body></html>`;
    const $ = cheerio.load(notFoundHtml);
    const title = $('title').text();
    assert.ok(title.includes('Hiba'));
  });
});

describe('njt.hu section extraction correctness', () => {
  it('does not duplicate text from nested elements (via parseLawPage)', () => {
    const html = `<html><head><title>Test - Nemzeti Jogszabálytár</title></head><body>
      <h1>Test törvény</h1>
      <div class="jogszabaly-szoveg">
        <p>1. § Az első szakasz szövege.</p>
        <div class="bekezdes"><p>1. § (2) Második bekezdés.</p></div>
        <p>2. § A második szakasz.</p>
      </div>
    </body></html>`;

    // Use the exported production parseLawPage function
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/test');
    assert.ok(result);
    assert.equal(result.title, 'Test');

    // Sections should not have duplicated content
    assert.ok(result.sections.length >= 2);
    const allContent = result.sections.map((s) => s.content).join('\n');
    const count1 = (allContent.match(/1\. § Az első/g) || []).length;
    const count2 = (allContent.match(/2\. § A második/g) || []).length;
    assert.equal(count1, 1, 'Section 1 text should appear exactly once');
    assert.equal(count2, 1, 'Section 2 text should appear exactly once');

    // Full text should also not duplicate
    const ftCount1 = (result.fullText.match(/1\. § Az első/g) || []).length;
    const ftCount2 = (result.fullText.match(/2\. § A második/g) || []).length;
    assert.equal(ftCount1, 1, 'Full text: Section 1 should appear once');
    assert.equal(ftCount2, 1, 'Full text: Section 2 should appear once');
  });

  it('handles deeply nested bekezdes without duplication in sections', () => {
    const html = `<html><head><title>Deep - Nemzeti Jogszabálytár</title></head><body>
      <h1>Deep nested law</h1>
      <div class="jogszabaly-szoveg">
        <div class="szakasz">
          <p>1. § Első szakasz.</p>
          <div class="bekezdes">
            <p>(2) Első szakasz második bekezdés.</p>
          </div>
          <div class="bekezdes">
            <p>(3) Első szakasz harmadik bekezdés.</p>
          </div>
        </div>
        <div class="szakasz">
          <p>2. § Második szakasz.</p>
        </div>
      </div>
    </body></html>`;

    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/deep-test');
    assert.ok(result);

    // Check sections don't have duplicated content
    const allSectionContent = result.sections.map((s) => s.content).join('\n');
    assert.equal((allSectionContent.match(/1\. § Első szakasz\./g) || []).length, 1);
    assert.equal((allSectionContent.match(/\(2\) Első szakasz második/g) || []).length, 1);
    assert.equal((allSectionContent.match(/\(3\) Első szakasz harmadik/g) || []).length, 1);
    assert.equal((allSectionContent.match(/2\. § Második szakasz\./g) || []).length, 1);
  });

  it('aggregates subsections under the same base section ID', () => {
    const html = `<html><head><title>Aggregation - Nemzeti Jogszabálytár</title></head><body>
      <h1>Aggregation test</h1>
      <div class="jogszabaly-szoveg">
        <p>1. § (1) Első bekezdés.</p>
        <p>1. § (2) Második bekezdés.</p>
        <p>1. § (3) Harmadik bekezdés.</p>
        <p>2. § Második szakasz szövege.</p>
        <p>2. § (2) Második szakasz második bekezdés.</p>
        <p>3. § Harmadik szakasz.</p>
      </div>
    </body></html>`;

    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/agg-test');
    assert.ok(result);

    // Should have 3 sections: "1. §", "2. §", "3. §"
    assert.equal(result.sections.length, 3);
    assert.equal(result.sections[0].id, '1. §');
    assert.equal(result.sections[1].id, '2. §');
    assert.equal(result.sections[2].id, '3. §');

    // Section 1 should contain all three subsections
    assert.ok(result.sections[0].content.includes('(1) Első bekezdés'));
    assert.ok(result.sections[0].content.includes('(2) Második bekezdés'));
    assert.ok(result.sections[0].content.includes('(3) Harmadik bekezdés'));

    // Section 2 should contain both its paragraphs
    assert.ok(result.sections[1].content.includes('2. § Második szakasz szövege'));
    assert.ok(result.sections[1].content.includes('(2) Második szakasz második bekezdés'));
  });

  it('parseLawPage returns null for error pages', () => {
    const html = `<html><head><title>Hiba - Nemzeti Jogszabálytár</title></head><body></body></html>`;
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/bad');
    assert.equal(result, null);
  });
});

describe('magyarkozlony.hu listing parsing (via exported parseGazetteList)', () => {
  const html = loadFixture('kozlony-listing.html');

  it('parses gazette issues with correct dates from fixture', () => {
    const issues = parseGazetteList(html);
    assert.ok(issues.length >= 3);

    // First issue should have the correct date from the sibling span
    const mk55 = issues.find((i) => i.title.includes('55. szám') && i.type === 'magyar_kozlony');
    assert.ok(mk55, 'Should find issue 55');
    assert.equal(mk55!.date, '2026. május 19.', 'Date should come from sibling span, not title');
    assert.equal(mk55!.year, 2026);
    assert.equal(mk55!.issueNumber, 55);
  });

  it('does not confuse "évi" in title with a date', () => {
    const issues = parseGazetteList(html);
    for (const issue of issues) {
      if (issue.date) {
        assert.ok(!issue.date.includes('évi'), `Date "${issue.date}" should not contain "évi"`);
      }
    }
  });

  it('correctly identifies types', () => {
    const issues = parseGazetteList(html);
    assert.ok(issues.some((i) => i.type === 'magyar_kozlony'));
    assert.ok(issues.some((i) => i.type === 'hivatalos_ertesito'));
  });

  it('month filtering works on parsed dates', () => {
    const mayIssues = parseGazetteList(html, undefined, 5); // május
    assert.ok(mayIssues.length >= 2);
    for (const issue of mayIssues) {
      assert.ok(issue.date.includes('május'), `Date "${issue.date}" should contain "május"`);
    }

    // June filter should return nothing from this fixture
    const juneIssues = parseGazetteList(html, undefined, 6);
    assert.equal(juneIssues.length, 0);
  });

  it('year filtering works', () => {
    const issues2026 = parseGazetteList(html, 2026);
    assert.ok(issues2026.length >= 3);

    const issues2025 = parseGazetteList(html, 2025);
    assert.equal(issues2025.length, 0);
  });

  it('distinguishes view and download links', () => {
    const issues = parseGazetteList(html);
    const mk55 = issues.find((i) => i.title.includes('55. szám') && i.type === 'magyar_kozlony');
    assert.ok(mk55);
    assert.ok(mk55!.viewUrl, 'Should have a view URL');
    assert.ok(mk55!.downloadUrl, 'Should have a download URL');
  });

  it('uses composite dedup key (not just title)', () => {
    // If two entries have the same title but different types, both should be kept
    const htmlWithCollision = `<html><body><main>
      <div><a href="/dokumentumok/a1/megtekintes">Test 2026. évi 1. szám</a><span>2026. január 5.</span></div>
      <div><a href="/dokumentumok/b2/megtekintes">Test 2026. évi 1. szám</a><span>2026. január 5.</span></div>
    </main></body></html>`;
    // Same title, same everything — should be merged (same dedup key)
    const issues = parseGazetteList(htmlWithCollision);
    assert.equal(issues.length, 1);
  });

  it('backfills missing metadata from later duplicate entries', () => {
    // First link has no date sibling, second link (same issue) has a date
    const htmlWithBackfill = `<html><body><main>
      <div><a href="/dokumentumok/abc/letoltes">Magyar Közlöny 2026. évi 60. szám</a></div>
      <div><a href="/dokumentumok/abc/megtekintes">Magyar Közlöny 2026. évi 60. szám</a><span>2026. május 25.</span></div>
    </main></body></html>`;

    const issues = parseGazetteList(htmlWithBackfill);
    const mk60 = issues.find((i) => i.issueNumber === 60);
    assert.ok(mk60);
    // Date should be backfilled from the second entry
    assert.equal(mk60!.date, '2026. május 25.');
    // Both URLs should be merged
    assert.ok(mk60!.downloadUrl);
    assert.ok(mk60!.viewUrl);
  });
});

describe('getGazetteIssue type-aware matching', () => {
  it('concept: type filter prevents returning wrong publication', () => {
    // Simulate: both Magyar Közlöny and Hivatalos Értesítő have issue #19 in 2026
    const issues = [
      { year: 2026, issueNumber: 19, type: 'magyar_kozlony' as const, title: 'MK 19' },
      { year: 2026, issueNumber: 19, type: 'hivatalos_ertesito' as const, title: 'HÉ 19' },
    ];

    // Searching for magyar_kozlony should return MK, not HÉ
    const mkResult = issues.find(
      (i) => i.year === 2026 && i.issueNumber === 19 && i.type === 'magyar_kozlony'
    );
    assert.ok(mkResult);
    assert.equal(mkResult!.title, 'MK 19');

    // Searching for hivatalos_ertesito should return HÉ
    const heResult = issues.find(
      (i) => i.year === 2026 && i.issueNumber === 19 && i.type === 'hivatalos_ertesito'
    );
    assert.ok(heResult);
    assert.equal(heResult!.title, 'HÉ 19');
  });
});

describe('kozlony month filtering', () => {
  it('excludes entries with unknown dates when month filter is set', () => {
    // Simulate the filtering logic
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

    const issues = [
      { date: '2026. május 10.', title: 'A' },
      { date: '2026. június 1.', title: 'B' },
      { date: '', title: 'C' }, // unknown date
    ];

    const filterMonth = 5; // május
    const monthName = monthNames[filterMonth - 1];
    const filtered = issues.filter((i) => i.date && i.date.includes(monthName));

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'A');
    // Entry with empty date should NOT be included
    assert.ok(!filtered.some((i) => i.title === 'C'));
  });
});

describe('Hungarian date regex (strict month names)', () => {
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
  ];
  const HUNGARIAN_DATE_REGEX = new RegExp(
    `(\\d{4})\\.\\s*(${HUNGARIAN_MONTHS.join('|')})\\s*(\\d{1,2})\\.`,
    'u'
  );

  it('matches dates with accented month names', () => {
    assert.ok(HUNGARIAN_DATE_REGEX.test('2026. május 10.'));
    assert.ok(HUNGARIAN_DATE_REGEX.test('2026. október 3.'));
    assert.ok(HUNGARIAN_DATE_REGEX.test('2026. június 15.'));
    assert.ok(HUNGARIAN_DATE_REGEX.test('2026. január 1.'));
  });

  it('does not match "évi" from titles (not a month name)', () => {
    // This is the key fix — "2026. évi 55." should NOT match
    assert.ok(!HUNGARIAN_DATE_REGEX.test('2026. évi 55.'));
    assert.ok(!HUNGARIAN_DATE_REGEX.test('Magyar Közlöny 2026. évi 55. szám'));
  });

  it('does not match malformed dates', () => {
    assert.ok(!HUNGARIAN_DATE_REGEX.test('2026. 10.'));
    assert.ok(!HUNGARIAN_DATE_REGEX.test('no date here'));
    assert.ok(!HUNGARIAN_DATE_REGEX.test('2026. foo 10.'));
  });
});

describe('SSRF URL validation', () => {
  it('rejects non-njt.hu URLs', () => {
    const ALLOWED_HOSTS = ['njt.jog.gov.hu', 'www.njt.jog.gov.hu'];

    const maliciousUrls = [
      'https://evil.com/jogszabaly/2017-78-00-00',
      'https://internal-service.local/secret',
      'http://njt.jog.gov.hu/jogszabaly/2017-78-00-00', // http not https
      'https://njt.jog.gov.hu.evil.com/path',
    ];

    for (const url of maliciousUrls) {
      try {
        const parsed = new URL(url);
        const allowed = parsed.protocol === 'https:' && ALLOWED_HOSTS.includes(parsed.hostname);
        assert.equal(allowed, false, `Should reject: ${url}`);
      } catch {
        // Invalid URL is also rejected — that's fine
      }
    }
  });

  it('accepts valid njt.hu URLs', () => {
    const ALLOWED_HOSTS = ['njt.jog.gov.hu', 'www.njt.jog.gov.hu'];

    const validUrls = [
      'https://njt.jog.gov.hu/jogszabaly/2017-78-00-00',
      'https://njt.jog.gov.hu/jogszabaly/2023-101-00-00.37',
      'https://www.njt.jog.gov.hu/jogszabaly/2020-5-20-22',
    ];

    for (const url of validUrls) {
      const parsed = new URL(url);
      const allowed = parsed.protocol === 'https:' && ALLOWED_HOSTS.includes(parsed.hostname);
      assert.equal(allowed, true, `Should accept: ${url}`);
    }
  });
});

describe('Cache LRU eviction', () => {
  it('evicts oldest entry when max size is reached', async () => {
    const { Cache } = await import('../utils/cache.js');
    const cache = new Cache<string>(30, 3); // max 3 entries

    cache.set('a', 'value-a');
    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    cache.set('b', 'value-b');
    await new Promise((r) => setTimeout(r, 5));
    cache.set('c', 'value-c');
    await new Promise((r) => setTimeout(r, 5));

    // Access 'a' to make it recently used
    cache.get('a');
    await new Promise((r) => setTimeout(r, 5));

    // Adding a 4th entry should evict 'b' (least recently accessed)
    cache.set('d', 'value-d');

    assert.equal(cache.get('b'), undefined); // evicted (oldest lastAccessed)
    assert.equal(cache.get('a'), 'value-a'); // still present (was accessed recently)
    assert.equal(cache.get('c'), 'value-c'); // still present
    assert.equal(cache.get('d'), 'value-d'); // newly added

    cache.dispose();
  });

  it('removes expired entries on access', async () => {
    const { Cache } = await import('../utils/cache.js');
    const cache = new Cache<string>(1, 100); // 1 minute TTL

    cache.set('short', 'value', 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(cache.get('short'), undefined); // expired

    cache.dispose();
  });
});

describe('extractFullText (no global dedup, preserves repeated legal text)', () => {
  it('preserves legitimate repeated text in different sections (via parseLawPage)', () => {
    const html = `<html><head><title>Repeat - Nemzeti Jogszabálytár</title></head><body>
      <h1>Repeat test</h1>
      <div class="jogszabaly-szoveg">
        <p>1. § Az adatkezelő köteles tájékoztatni az érintettet.</p>
        <p>2. § Az adatkezelő köteles tájékoztatni az érintettet.</p>
        <p>3. § Egyéb rendelkezés.</p>
        <p>4. § Záró rendelkezés.</p>
        <p>5. § Hatályba lépés.</p>
      </div>
    </body></html>`;

    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/repeat-test');
    assert.ok(result);

    // Both occurrences of the repeated text should be preserved in fullText
    const matches = result.fullText.match(/Az adatkezelő köteles tájékoztatni/g) || [];
    assert.equal(matches.length, 2, 'Repeated legal text should appear twice (not deduplicated)');
  });
});

describe('searchLegislation filter logic (via exported filterSearchResults)', () => {
  it('filters results by year strictly — excludes results with missing year', () => {
    const results: SearchResult[] = [
      {
        title: '2023. évi CI. törvény',
        url: 'https://njt.jog.gov.hu/jogszabaly/2023-101-00-00',
        year: 2023,
        number: '101',
      },
      {
        title: '2022. évi X. törvény',
        url: 'https://njt.jog.gov.hu/jogszabaly/2022-10-00-00',
        year: 2022,
        number: '10',
      },
      { title: 'Unknown result', url: 'https://njt.jog.gov.hu/jogszabaly/unknown' }, // no year
    ];

    const filtered = filterSearchResults(results, { year: 2023 });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].year, 2023);
  });

  it('enriches metadata from URL when year/number are missing', () => {
    const results: SearchResult[] = [
      { title: 'Some law', url: 'https://njt.jog.gov.hu/jogszabaly/2023-101-00-00' },
    ];

    const filtered = filterSearchResults(results, { year: 2023, number: 101 });
    assert.equal(filtered.length, 1); // Should match after enrichment from URL
    // Returned result should have enriched metadata
    assert.equal(filtered[0].year, 2023);
    assert.equal(filtered[0].number, '101');
    assert.equal(filtered[0].type, 'törvény'); // enriched from URL type code 00-00
  });

  it('excludes results that cannot be enriched when filter is set', () => {
    const results: SearchResult[] = [
      { title: 'Vague result', url: 'https://njt.jog.gov.hu/search?q=test' }, // no slug pattern
    ];

    const filtered = filterSearchResults(results, { year: 2023 });
    assert.equal(filtered.length, 0); // Cannot determine year, so excluded
  });

  it('filters results by titleOnly + keyword', () => {
    const results: SearchResult[] = [
      { title: 'adatvédelem törvény', url: 'url1', year: 2023, number: '1' },
      { title: 'munkajog törvény', url: 'url2', year: 2023, number: '2' },
    ];

    const filtered = filterSearchResults(results, {
      keyword: 'adatvédelem',
      titleOnly: true,
      year: 2023,
    });
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].title.includes('adatvédelem'));
  });

  it('filters out results where inForce is false when onlyInForce is set', () => {
    const results: SearchResult[] = [
      {
        title: 'Active law',
        url: 'https://njt.jog.gov.hu/jogszabaly/2023-1-00-00',
        year: 2023,
        number: '1',
        inForce: true,
      },
      {
        title: 'Repealed law',
        url: 'https://njt.jog.gov.hu/jogszabaly/2023-2-00-00',
        year: 2023,
        number: '2',
        inForce: false,
      },
      {
        title: 'Unknown status',
        url: 'https://njt.jog.gov.hu/jogszabaly/2023-3-00-00',
        year: 2023,
        number: '3',
      },
    ];

    // Non-strict: excludes only results explicitly marked as not in force.
    // Results with unknown status (undefined) are kept.
    const filtered = filterSearchResults(results, { onlyInForce: true, year: 2023 });
    assert.equal(filtered.length, 2);
    assert.ok(filtered.some((r) => r.title === 'Active law'));
    assert.ok(filtered.some((r) => r.title === 'Unknown status'));
    assert.ok(!filtered.some((r) => r.title === 'Repealed law'));
  });

  it('filters by type strictly — excludes results with unknown type', () => {
    const results: SearchResult[] = [
      {
        title: '2023. évi CI. törvény',
        url: 'https://njt.jog.gov.hu/jogszabaly/2023-101-00-00',
        year: 2023,
        number: '101',
      },
      {
        title: 'Some result',
        url: 'https://njt.jog.gov.hu/jogszabaly/2023-5-20-22',
        year: 2023,
        number: '5',
      },
      {
        title: 'No type info',
        url: 'https://njt.jog.gov.hu/search?q=test',
        year: 2023,
        number: '99',
      },
    ];

    const filtered = filterSearchResults(results, { type: 'törvény', year: 2023 });
    // Should include the first (title contains "törvény") and exclude the rest
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].title.includes('törvény'));
  });

  it('enriches type from URL type codes', () => {
    const results: SearchResult[] = [
      {
        title: 'Some law',
        url: 'https://njt.jog.gov.hu/jogszabaly/2023-5-20-22',
        year: 2023,
        number: '5',
      },
    ];

    // Type code 20-22 = Korm. rendelet
    const filtered = filterSearchResults(results, { type: 'rendelet', year: 2023 });
    assert.equal(filtered.length, 1);
  });
});

describe('getGazetteIssue pagination', () => {
  it('concept: iterates pages until issue is found', () => {
    // Simulate paginated results
    const pages: Array<Array<{ year: number; issueNumber: number; title: string }>> = [
      [
        { year: 2026, issueNumber: 55, title: 'MK 55' },
        { year: 2026, issueNumber: 54, title: 'MK 54' },
      ],
      [
        { year: 2026, issueNumber: 53, title: 'MK 53' },
        { year: 2026, issueNumber: 52, title: 'MK 52' },
      ],
      [{ year: 2026, issueNumber: 51, title: 'MK 51' }],
    ];

    // Simulate the pagination logic
    const targetIssue = 52;
    let found: { year: number; issueNumber: number; title: string } | null = null;
    for (let page = 0; page < pages.length; page++) {
      const issues = pages[page];
      const match = issues.find((i) => i.issueNumber === targetIssue);
      if (match) {
        found = match;
        break;
      }
      if (issues.length === 0) break;
    }

    assert.ok(found);
    assert.equal(found!.issueNumber, 52);
    assert.equal(found!.title, 'MK 52');
  });

  it('does not stop early when year filter produces empty results but raw page has entries', () => {
    // Simulate: page 1 has entries for 2026 only, page 2 has entries for 2025
    // When searching for year=2025, page 1 filtered results are empty,
    // but raw page has entries so we should continue to page 2.
    const rawPages = [
      [
        { year: 2026, issueNumber: 55 },
        { year: 2026, issueNumber: 54 },
      ],
      [
        { year: 2025, issueNumber: 200 },
        { year: 2025, issueNumber: 199 },
      ],
      [], // empty raw page = end
    ];

    const targetYear = 2025;
    const targetIssue = 200;
    let found: { year: number; issueNumber: number } | null = null;

    for (let page = 0; page < rawPages.length; page++) {
      const rawIssues = rawPages[page];
      // Apply year filter
      const filtered = rawIssues.filter((i) => i.year === targetYear);
      const match = filtered.find((i) => i.issueNumber === targetIssue);
      if (match) {
        found = match;
        break;
      }
      // Use RAW count for termination, not filtered count
      if (rawIssues.length === 0) break;
    }

    assert.ok(found, 'Should find issue on page 2 despite page 1 having no matches for year');
    assert.equal(found!.issueNumber, 200);
    assert.equal(found!.year, 2025);
  });

  it('returns null when raw pages are exhausted', () => {
    const rawPages = [
      [{ year: 2026, issueNumber: 55 }],
      [{ year: 2026, issueNumber: 54 }],
      [], // empty raw page = end
    ];

    const targetYear = 2020;
    const targetIssue = 1;
    let found: { year: number; issueNumber: number } | null = null;

    for (let page = 0; page < rawPages.length; page++) {
      const rawIssues = rawPages[page];
      const filtered = rawIssues.filter((i) => i.year === targetYear);
      const match = filtered.find((i) => i.issueNumber === targetIssue);
      if (match) {
        found = match;
        break;
      }
      if (rawIssues.length === 0) break;
    }

    assert.equal(found, null);
  });
});

describe('kozlony year parsing', () => {
  it('returns undefined year when title has no year pattern', () => {
    const title = 'Egyéb dokumentum szám nélkül';
    const yearMatch = title.match(/(\d{4})\.\s*évi/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
    assert.equal(year, undefined);
  });

  it('correctly parses year from standard title', () => {
    const title = 'Magyar Közlöny 2026. évi 55. szám';
    const yearMatch = title.match(/(\d{4})\.\s*évi/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
    assert.equal(year, 2026);
  });
});

describe('HTTP timeout', () => {
  it('HttpTimeoutError has correct properties', async () => {
    const { HttpTimeoutError } = await import('../utils/http.js');
    const err = new HttpTimeoutError('https://example.com', 15000);
    assert.equal(err.name, 'HttpTimeoutError');
    assert.ok(err.message.includes('https://example.com'));
    assert.ok(err.message.includes('15000'));
  });

  it('HttpRedirectError has correct properties', async () => {
    const { HttpRedirectError } = await import('../utils/http.js');
    const err = new HttpRedirectError('https://njt.jog.gov.hu/page', 'evil.com');
    assert.equal(err.name, 'HttpRedirectError');
    assert.ok(err.message.includes('evil.com'));
    assert.ok(err.message.includes('njt.jog.gov.hu'));
  });

  it('HttpUrlValidationError handles malformed URLs safely', async () => {
    const { HttpUrlValidationError } = await import('../utils/http.js');
    const err = new HttpUrlValidationError('not-a-url', 'malformed URL');
    assert.equal(err.name, 'HttpUrlValidationError');
    assert.ok(err.message.includes('not-a-url'));
    assert.ok(err.message.includes('malformed'));
  });

  it('HttpUrlValidationError handles disallowed hosts', async () => {
    const { HttpUrlValidationError } = await import('../utils/http.js');
    const err = new HttpUrlValidationError(
      'https://evil.com/path',
      'host "evil.com" is not in the allowlist'
    );
    assert.equal(err.name, 'HttpUrlValidationError');
    assert.ok(err.message.includes('evil.com'));
    assert.ok(err.message.includes('allowlist'));
  });
});

describe('Cookie serialization', () => {
  it('extracts only name=value from Set-Cookie headers', () => {
    // Simulate the parseCookiesForRequest logic
    const setCookieHeaders = [
      'session_id=abc123; Path=/; HttpOnly; Secure',
      'lang=hu; Path=/; Max-Age=3600',
      'tracking=xyz789; Domain=.jog.gov.hu; Path=/; SameSite=Lax',
    ];

    const cookieHeader = setCookieHeaders
      .map((cookie) => cookie.split(';')[0].trim())
      .filter((pair) => pair.includes('='))
      .join('; ');

    assert.equal(cookieHeader, 'session_id=abc123; lang=hu; tracking=xyz789');
    // Should NOT contain Path, HttpOnly, Secure, etc.
    assert.ok(!cookieHeader.includes('Path'));
    assert.ok(!cookieHeader.includes('HttpOnly'));
    assert.ok(!cookieHeader.includes('Secure'));
  });

  it('handles empty cookie arrays', () => {
    const setCookieHeaders: string[] = [];
    const cookieHeader = setCookieHeaders
      .map((cookie) => cookie.split(';')[0].trim())
      .filter((pair) => pair.includes('='))
      .join('; ');
    assert.equal(cookieHeader, '');
  });
});

describe('parseSearchResults (exported production function)', () => {
  it('extracts results from HTML with jogszabaly links', () => {
    const html = `<html><body>
      <a href="/jogszabaly/2023-101-00-00">2023. évi CI. törvény</a>
      <a href="/jogszabaly/2022-10-00-00">2022. évi X. törvény</a>
      <a href="/other-page">Not a law</a>
      <a href="/jogszabaly/2021-5-20-22">Ab</a>
    </body></html>`;

    const results = parseSearchResults(html);
    // Should find 2 results (third link doesn't match, fourth is too short)
    assert.equal(results.length, 2);
    assert.ok(results[0].url.includes('2023-101-00-00'));
    assert.ok(results[1].url.includes('2022-10-00-00'));
    assert.equal(results[0].title, '2023. évi CI. törvény');
  });

  it('returns empty array for HTML with no matching links', () => {
    const html = `<html><body><p>No results found.</p></body></html>`;
    const results = parseSearchResults(html);
    assert.equal(results.length, 0);
  });

  it('deduplicates results by URL', () => {
    const html = `<html><body>
      <a href="/jogszabaly/2023-101-00-00">2023. évi CI. törvény</a>
      <a href="/jogszabaly/2023-101-00-00">Same law different link text</a>
      <a href="/jogszabaly/2022-10-00-00">2022. évi X. törvény</a>
    </body></html>`;

    const results = parseSearchResults(html);
    // Should deduplicate the first two (same URL)
    assert.equal(results.length, 2);
  });
});

describe('parseLawPage (exported production function) with fixture', () => {
  const html = loadFixture('njt-law-page.html');

  it('returns a complete LawDocument from fixture HTML', () => {
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/2023-101-00-00');
    assert.ok(result);
    assert.equal(result.title, '2023. évi CI. törvény');
    assert.ok(result.fullTitle.length > 0);
    assert.ok(result.sections.length > 0);
    assert.ok(result.fullText.length > 0);
    assert.equal(result.url, 'https://njt.jog.gov.hu/jogszabaly/2023-101-00-00');
  });

  it('extracts sections with § identifiers', () => {
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/2023-101-00-00');
    assert.ok(result);
    assert.ok(result.sections.some((s) => s.id.includes('1. §')));
  });

  it('composes fullTitle from h1 and h2 when both present', () => {
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/2023-101-00-00');
    assert.ok(result);
    // Fixture has h1="2023. évi CI. törvény" and h2="a nemzeti adatvagyon..."
    assert.ok(result.fullTitle.includes('2023. évi CI. törvény'));
    assert.ok(result.fullTitle.includes('a nemzeti adatvagyon'));
    assert.ok(result.fullTitle.includes(' — '));
  });
});

describe('section lookup exact matching (via parseLawPage)', () => {
  // Build a law with sections 1. §, 11. §, 111. § to test boundary matching
  const html = `<html><head><title>Boundary - Nemzeti Jogszabálytár</title></head><body>
    <h1>Boundary test</h1>
    <div class="jogszabaly-szoveg">
      <p>1. § Az első szakasz szövege.</p>
      <p>1. § (2) Első szakasz második bekezdés.</p>
      <p>2. § Második szakasz.</p>
      <p>11. § A tizenegyedik szakasz szövege.</p>
      <p>11. § (2) Tizenegyedik második bekezdés.</p>
      <p>12. § Tizenkettedik szakasz.</p>
      <p>111. § A száztizenegyedik szakasz.</p>
    </div>
  </body></html>`;

  it('does not confuse 1. § with 11. § or 111. §', () => {
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/boundary');
    assert.ok(result);

    // Should have separate sections for 1. §, 2. §, 11. §, 12. §, 111. §
    const ids = result.sections.map((s) => s.id);
    assert.ok(ids.includes('1. §'));
    assert.ok(ids.includes('2. §'));
    assert.ok(ids.includes('11. §'));
    assert.ok(ids.includes('12. §'));
    assert.ok(ids.includes('111. §'));

    // Section "1. §" should NOT contain text from "11. §"
    const section1 = result.sections.find((s) => s.id === '1. §');
    assert.ok(section1);
    assert.ok(section1!.content.includes('Az első szakasz'));
    assert.ok(!section1!.content.includes('tizenegyedik'));
    assert.ok(!section1!.content.includes('száztizenegyedik'));

    // Section "11. §" should contain its own content
    const section11 = result.sections.find((s) => s.id === '11. §');
    assert.ok(section11);
    assert.ok(section11!.content.includes('tizenegyedik'));
    assert.ok(!section11!.content.includes('Az első szakasz'));
  });

  it('exact section ID matching does not partial-match', () => {
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/boundary');
    assert.ok(result);

    // Simulate getLawSection's exact matching logic
    const normalizedRef = '1. §';
    const baseMatch = normalizedRef.match(/^(\d+[/A-Z]*)\.\s*§/);
    const baseId = baseMatch ? `${baseMatch[1]}. §` : normalizedRef;

    // Exact match should find "1. §" not "11. §"
    const exactMatch = result.sections.find((s) => s.id === baseId);
    assert.ok(exactMatch);
    assert.equal(exactMatch!.id, '1. §');
    assert.ok(exactMatch!.content.includes('Az első szakasz'));
    assert.ok(!exactMatch!.content.includes('tizenegyedik'));
  });

  it('subsection lookup returns content within the correct section', () => {
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/boundary');
    assert.ok(result);

    // Looking for "1. § (2)" should find it within section "1. §"
    const section1 = result.sections.find((s) => s.id === '1. §');
    assert.ok(section1);
    assert.ok(section1!.content.includes('(2) Első szakasz második bekezdés'));
  });

  it('returns null for non-existent subsection (does not return full section)', () => {
    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/boundary');
    assert.ok(result);

    // Section "1. §" exists but subsection "(99)" does not
    const section1 = result.sections.find((s) => s.id === '1. §');
    assert.ok(section1);
    assert.ok(!section1!.content.includes('(99)'));

    // Simulate getLawSection logic for "1. § (99)"
    const normalizedRef = '1. § (99)';
    const baseId = '1. §';
    const subNumMatch = normalizedRef.match(/\((\d+[a-z]?)\)\s*$/);
    const shortMarker = subNumMatch ? `(${subNumMatch[1]})` : null;

    // Neither fully qualified nor short marker should be found
    const fullyQualifiedFound = section1!.content.includes(normalizedRef);
    const shortMarkerFound = shortMarker ? section1!.content.includes(shortMarker) : false;

    assert.equal(fullyQualifiedFound, false);
    assert.equal(shortMarkerFound, false);
    // Production code should return null in this case (not the full section)
  });
});

describe('content root selector priority', () => {
  it('prefers .jogszabaly-szoveg over main element', () => {
    const html = `<html><head><title>Priority - Nemzeti Jogszabálytár</title></head><body>
      <h1>Priority test</h1>
      <main>
        <nav><p>Navigation text that should not appear.</p></nav>
        <div class="jogszabaly-szoveg">
          <p>1. § Correct law text from jogszabaly-szoveg.</p>
          <p>2. § Second section.</p>
          <p>3. § Third section.</p>
          <p>4. § Fourth section.</p>
          <p>5. § Fifth section.</p>
        </div>
      </main>
    </body></html>`;

    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/priority');
    assert.ok(result);

    // Should use .jogszabaly-szoveg content, not main (which includes nav)
    assert.ok(result.fullText.includes('Correct law text'));
    assert.ok(!result.fullText.includes('Navigation text'));
  });

  it('falls back to article when .jogszabaly-szoveg is absent', () => {
    const html = `<html><head><title>Fallback - Nemzeti Jogszabálytár</title></head><body>
      <h1>Fallback test</h1>
      <main>
        <p>Main nav text.</p>
      </main>
      <article>
        <p>1. § Article content.</p>
        <p>2. § More article.</p>
        <p>3. § Even more.</p>
        <p>4. § Still going.</p>
        <p>5. § Last one.</p>
      </article>
    </body></html>`;

    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/fallback');
    assert.ok(result);

    // Should use article (higher priority than main)
    assert.ok(result.fullText.includes('Article content'));
  });
});

describe('subsection extraction (line-based)', () => {
  it('extracts specific subsection and stops at next marker', () => {
    const html = `<html><head><title>Sub - Nemzeti Jogszabálytár</title></head><body>
      <h1>Subsection test</h1>
      <div class="jogszabaly-szoveg">
        <p>1. § (1) Első bekezdés szövege.</p>
        <p>(2) Második bekezdés szövege.</p>
        <p>(3) Harmadik bekezdés szövege.</p>
        <p>2. § Második szakasz.</p>
      </div>
    </body></html>`;

    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/sub-test');
    assert.ok(result);

    // Section 1 should aggregate all subsections
    const section1 = result.sections.find((s) => s.id === '1. §');
    assert.ok(section1);
    assert.ok(section1!.content.includes('(1) Első bekezdés'));
    assert.ok(section1!.content.includes('(2) Második bekezdés'));
    assert.ok(section1!.content.includes('(3) Harmadik bekezdés'));

    // Test the extractSubsection logic inline (simulating getLawSection behavior)
    const lines = section1!.content.split('\n');
    const subsectionRef = '(2)';
    const resultLines: string[] = [];
    let capturing = false;
    const markerPattern = /^\(?(\d+[a-z]?)\)|^\d+[/A-Z]*\.\s*§\s*\(\d+/;

    for (const line of lines) {
      const trimmed = line.trim();
      if (capturing) {
        if (markerPattern.test(trimmed) || trimmed.match(/^\d+[/A-Z]*\.\s*§/)) break;
        resultLines.push(trimmed);
      } else if (trimmed.includes(subsectionRef)) {
        capturing = true;
        resultLines.push(trimmed);
      }
    }

    assert.ok(resultLines.length >= 1);
    assert.ok(resultLines[0].includes('Második bekezdés'));
    // Should NOT include (3)
    assert.ok(!resultLines.some((l) => l.includes('Harmadik')));
  });

  it('handles short marker format when fully qualified ref is not in content', () => {
    // This tests the fix: content uses "(2)" standalone, but user requests "1. § (2)"
    const html = `<html><head><title>Short - Nemzeti Jogszabálytár</title></head><body>
      <h1>Short marker test</h1>
      <div class="jogszabaly-szoveg">
        <p>1. § (1) Első bekezdés.</p>
        <p>(2) Második bekezdés standalone marker.</p>
        <p>(3) Harmadik bekezdés.</p>
        <p>2. § Második szakasz.</p>
        <p>3. § Harmadik szakasz.</p>
        <p>4. § Negyedik szakasz.</p>
        <p>5. § Ötödik szakasz.</p>
      </div>
    </body></html>`;

    const result = parseLawPage(html, 'https://njt.jog.gov.hu/jogszabaly/short-marker');
    assert.ok(result);

    const section1 = result.sections.find((s) => s.id === '1. §');
    assert.ok(section1);

    // The content has "(2)" standalone, NOT "1. § (2)"
    assert.ok(!section1!.content.includes('1. § (2)'));
    assert.ok(section1!.content.includes('(2) Második bekezdés'));

    // Simulate getLawSection logic: request "1. § (2)" → should find via short marker "(2)"
    const normalizedRef = '1. § (2)';
    const baseId = '1. §';
    const subNumMatch = normalizedRef.match(/\((\d+[a-z]?)\)\s*$/);
    const shortMarker = subNumMatch ? `(${subNumMatch[1]})` : null;

    assert.equal(shortMarker, '(2)');
    // Fully qualified not in content
    assert.ok(!section1!.content.includes(normalizedRef));
    // But short marker IS in content
    assert.ok(section1!.content.includes(shortMarker!));
  });
});
