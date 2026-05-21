/**
 * Tests for CELEX number utilities.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCelex, buildEurLexUrls, describeType, describeSector } from '../utils/celex.js';

describe('parseCelex', () => {
  it('parses a regulation CELEX', () => {
    const result = parseCelex('32024R1689');
    assert.ok(result);
    assert.equal(result.sector, '3');
    assert.equal(result.year, '2024');
    assert.equal(result.type, 'R');
    assert.equal(result.number, '1689');
  });

  it('parses a directive CELEX', () => {
    const result = parseCelex('32000L0031');
    assert.ok(result);
    assert.equal(result.sector, '3');
    assert.equal(result.year, '2000');
    assert.equal(result.type, 'L');
    assert.equal(result.number, '0031');
  });

  it('parses GDPR CELEX', () => {
    const result = parseCelex('32016R0679');
    assert.ok(result);
    assert.equal(result.sector, '3');
    assert.equal(result.year, '2016');
    assert.equal(result.type, 'R');
    assert.equal(result.number, '0679');
  });

  it('parses case-law CELEX', () => {
    const result = parseCelex('62019CJ0311');
    assert.ok(result);
    assert.equal(result.sector, '6');
    assert.equal(result.year, '2019');
    assert.equal(result.type, 'CJ');
    assert.equal(result.number, '0311');
  });

  it('returns null for invalid input', () => {
    assert.equal(parseCelex(''), null);
    assert.equal(parseCelex('not-a-celex'), null);
    assert.equal(parseCelex('XYZ'), null);
  });
});

describe('buildEurLexUrls', () => {
  it('builds correct URLs for a regulation', () => {
    const urls = buildEurLexUrls('32016R0679', 'EN');
    assert.equal(
      urls.html,
      'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679'
    );
    assert.equal(
      urls.pdf,
      'https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32016R0679'
    );
    assert.equal(urls.page, 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679');
  });

  it('respects language parameter', () => {
    const urls = buildEurLexUrls('32016R0679', 'HU');
    assert.ok(urls.html.includes('/HU/'));
    assert.ok(urls.pdf.includes('/HU/'));
  });
});

describe('describeType', () => {
  it('describes known types', () => {
    assert.equal(describeType('R'), 'Regulation');
    assert.equal(describeType('L'), 'Directive');
    assert.equal(describeType('D'), 'Decision');
    assert.equal(describeType('CJ'), 'Judgment of the Court of Justice');
  });

  it('returns fallback for unknown types', () => {
    assert.equal(describeType('ZZ'), 'Type ZZ');
  });
});

describe('describeSector', () => {
  it('describes known sectors', () => {
    assert.equal(describeSector('3'), 'Legislation');
    assert.equal(describeSector('6'), 'Case-law');
    assert.equal(describeSector('5'), 'Preparatory acts');
  });

  it('returns fallback for unknown sectors', () => {
    assert.equal(describeSector('Z'), 'Sector Z');
  });
});
