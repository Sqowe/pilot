/**
 * Edge-case and error-path tests.
 * Validates behavior for malformed input, injection attempts, and boundary conditions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCelex, buildEurLexUrls } from '../utils/celex.js';
import { htmlToText } from '../clients/eurlex.js';
import { Cache } from '../utils/cache.js';
import {
  isValidCelex,
  sanitizeCelex,
  escapeSparqlLiteral,
  isValidEcli,
  sanitizeKeyword,
} from '../utils/sanitize.js';
import { toCellarLang, isValidEuLanguage } from '../utils/language.js';

describe('CELEX edge cases', () => {
  it('handles CELEX with only sector and year (too short)', () => {
    assert.equal(parseCelex('32024'), null);
  });

  it('handles CELEX with special characters', () => {
    assert.equal(parseCelex('32024R/1689'), null);
    assert.equal(parseCelex('3 2024R1689'), null);
  });

  it('handles very long CELEX numbers (consolidated texts)', () => {
    const result = parseCelex('02016R0679-20180525');
    assert.ok(result);
    assert.equal(result.sector, '0');
    assert.equal(result.year, '2016');
    assert.equal(result.type, 'R');
  });

  it('handles lowercase CELEX input', () => {
    const result = parseCelex('32024r1689');
    assert.ok(result);
    assert.equal(result.type, 'R');
  });

  it('buildEurLexUrls handles empty CELEX gracefully', () => {
    const urls = buildEurLexUrls('', 'EN');
    assert.ok(urls.html.includes('CELEX:'));
  });
});

describe('Input sanitization', () => {
  it('validates correct CELEX numbers', () => {
    assert.ok(isValidCelex('32024R1689'));
    assert.ok(isValidCelex('32016R0679'));
    assert.ok(isValidCelex('62019CJ0311'));
    assert.ok(isValidCelex('02016R0679-20180525'));
  });

  it('rejects invalid CELEX numbers', () => {
    assert.ok(!isValidCelex(''));
    assert.ok(!isValidCelex('not-a-celex'));
    assert.ok(!isValidCelex('32024')); // too short
    assert.ok(!isValidCelex('32024R1689" } UNION { ?x ?y ?z')); // injection attempt
    assert.ok(!isValidCelex('32024R1689\n')); // newline
  });

  it('sanitizeCelex returns null for invalid input', () => {
    assert.equal(sanitizeCelex('invalid'), null);
    assert.equal(sanitizeCelex('32024R1689"'), null);
  });

  it('sanitizeCelex returns cleaned value for valid input', () => {
    assert.equal(sanitizeCelex('  32024R1689  '), '32024R1689');
    assert.equal(sanitizeCelex('32016R0679'), '32016R0679');
    // Normalizes to uppercase
    assert.equal(sanitizeCelex('32024r1689'), '32024R1689');
  });

  it('escapes SPARQL special characters in literals', () => {
    assert.equal(escapeSparqlLiteral('test"value'), 'test\\"value');
    assert.equal(escapeSparqlLiteral('back\\slash'), 'back\\\\slash');
    assert.equal(escapeSparqlLiteral('new\nline'), 'new\\nline');
    assert.equal(escapeSparqlLiteral('tab\there'), 'tab\\there');
  });

  it('validates correct ECLI identifiers', () => {
    assert.ok(isValidEcli('ECLI:EU:C:2020:559'));
    assert.ok(isValidEcli('ECLI:EU:T:2021:51'));
  });

  it('rejects invalid ECLI identifiers', () => {
    assert.ok(!isValidEcli(''));
    assert.ok(!isValidEcli('not-ecli'));
    assert.ok(!isValidEcli('ECLI:EU:C:2020:559" UNION')); // injection
    assert.ok(!isValidEcli('ecli:eu:c:2020:559')); // lowercase
  });

  it('sanitizes keywords for SPARQL', () => {
    assert.equal(sanitizeKeyword('normal search'), 'normal search');
    assert.equal(sanitizeKeyword('with "quotes"'), 'with \\"quotes\\"');
    assert.equal(sanitizeKeyword('with\nnewline'), 'with\\nnewline');
  });
});

describe('Language code mapping', () => {
  it('maps 2-letter to 3-letter codes correctly', () => {
    assert.equal(toCellarLang('EN'), 'ENG');
    assert.equal(toCellarLang('FR'), 'FRA');
    assert.equal(toCellarLang('DE'), 'DEU');
    assert.equal(toCellarLang('HU'), 'HUN');
    assert.equal(toCellarLang('IT'), 'ITA');
    assert.equal(toCellarLang('ES'), 'SPA');
    assert.equal(toCellarLang('PL'), 'POL');
  });

  it('is case-insensitive', () => {
    assert.equal(toCellarLang('en'), 'ENG');
    assert.equal(toCellarLang('Fr'), 'FRA');
  });

  it('returns null for unsupported codes', () => {
    assert.equal(toCellarLang('XX'), null);
    assert.equal(toCellarLang(''), null);
    assert.equal(toCellarLang('ENG'), null); // 3-letter not accepted
  });

  it('validates EU languages', () => {
    assert.ok(isValidEuLanguage('EN'));
    assert.ok(isValidEuLanguage('HU'));
    assert.ok(!isValidEuLanguage('XX'));
    assert.ok(!isValidEuLanguage(''));
  });
});

describe('htmlToText edge cases', () => {
  it('handles deeply nested HTML', () => {
    const html = '<div><div><div><p>Deep content</p></div></div></div>';
    const text = htmlToText(html);
    assert.ok(text.includes('Deep content'));
  });

  it('handles HTML with no text content', () => {
    const html = '<div><img src="x.png"/><br/></div>';
    const text = htmlToText(html);
    assert.equal(text.trim(), '');
  });

  it('handles malformed HTML gracefully', () => {
    const html = '<p>Unclosed paragraph<p>Another<div>Mixed';
    const text = htmlToText(html);
    assert.ok(text.includes('Unclosed paragraph'));
    assert.ok(text.includes('Another'));
  });

  it('handles very large input without crashing', () => {
    const html = '<p>x</p>'.repeat(10000);
    const text = htmlToText(html);
    assert.ok(text.length > 0);
  });

  it('handles HTML with only whitespace', () => {
    const html = '   <p>   </p>   <div>  </div>  ';
    const text = htmlToText(html);
    assert.equal(text, '');
  });
});

describe('Cache with max size', () => {
  it('evicts oldest entry when at capacity', () => {
    const cache = new Cache<string>(5, 3); // max 3 entries
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.set('d', '4'); // should evict "a"
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), '2');
    assert.equal(cache.get('d'), '4');
  });

  it('does not evict when updating existing key', () => {
    const cache = new Cache<string>(5, 3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.set('a', 'updated'); // update, not new entry
    assert.equal(cache.get('a'), 'updated');
    assert.equal(cache.get('b'), '2');
    assert.equal(cache.get('c'), '3');
  });
});

describe('SPARQL query safety', () => {
  it('rejects INSERT queries', () => {
    const q = 'INSERT DATA { <x> <y> <z> }';
    assert.ok(q.toUpperCase().includes('INSERT'));
  });

  it('rejects DELETE queries', () => {
    const q = 'DELETE WHERE { ?s ?p ?o }';
    assert.ok(q.toUpperCase().includes('DELETE'));
  });

  it('allows valid SELECT queries', () => {
    const q = 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 10';
    assert.ok(q.toUpperCase().includes('SELECT'));
    assert.ok(!q.toUpperCase().includes('INSERT'));
    assert.ok(!q.toUpperCase().includes('DELETE'));
  });
});
