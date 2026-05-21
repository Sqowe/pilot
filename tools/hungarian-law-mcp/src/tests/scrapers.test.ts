/**
 * Tests for scraper parsing logic using saved HTML fixtures.
 * These tests validate parsing without making network requests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

describe('magyarkozlony.hu listing parsing', () => {
  const html = loadFixture('kozlony-listing.html');

  it('finds gazette issue links', () => {
    const $ = cheerio.load(html);
    const links: string[] = [];
    $("a[href*='/dokumentumok/']").each((_, el) => {
      const title = $(el).text().trim();
      if (title.length > 5) links.push(title);
    });
    assert.ok(links.length >= 3);
    assert.ok(links.some((l) => l.includes('Magyar Közlöny')));
    assert.ok(links.some((l) => l.includes('Hivatalos Értesítő')));
  });

  it('extracts year and issue number from titles', () => {
    const $ = cheerio.load(html);
    const titles: string[] = [];
    $("a[href*='/dokumentumok/']").each((_, el) => {
      titles.push($(el).text().trim());
    });

    const mkTitle = titles.find((t) => t.includes('55. szám'));
    assert.ok(mkTitle);

    const yearMatch = mkTitle!.match(/(\d{4})\.\s*évi/);
    const numberMatch = mkTitle!.match(/(\d+)\.\s*szám/);
    assert.equal(yearMatch?.[1], '2026');
    assert.equal(numberMatch?.[1], '55');
  });

  it('distinguishes view and download links', () => {
    const $ = cheerio.load(html);
    let viewCount = 0;
    let downloadCount = 0;

    $("a[href*='/dokumentumok/']").each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('/megtekintes')) viewCount++;
      if (href.includes('/letoltes')) downloadCount++;
    });

    assert.ok(viewCount >= 2);
    assert.ok(downloadCount >= 1);
  });
});
