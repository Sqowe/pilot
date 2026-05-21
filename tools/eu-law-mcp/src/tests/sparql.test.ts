/**
 * Tests for SPARQL client utilities (unit tests, no network).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bindingValue, CDM_PREFIXES } from '../clients/sparql.js';

describe('bindingValue', () => {
  it('extracts value from a binding', () => {
    const binding = {
      title: { type: 'literal' as const, value: 'GDPR' },
      uri: { type: 'uri' as const, value: 'http://example.com/doc' },
    };
    assert.equal(bindingValue(binding, 'title'), 'GDPR');
    assert.equal(bindingValue(binding, 'uri'), 'http://example.com/doc');
  });

  it('returns undefined for missing keys', () => {
    const binding = {
      title: { type: 'literal' as const, value: 'Test' },
    };
    assert.equal(bindingValue(binding, 'missing'), undefined);
  });
});

describe('CDM_PREFIXES', () => {
  it('contains essential prefixes', () => {
    assert.ok(CDM_PREFIXES.includes('cdm:'));
    assert.ok(CDM_PREFIXES.includes('skos:'));
    assert.ok(CDM_PREFIXES.includes('xsd:'));
    assert.ok(CDM_PREFIXES.includes('owl:'));
    assert.ok(CDM_PREFIXES.includes('rdf:'));
  });

  it('uses correct CDM namespace', () => {
    assert.ok(CDM_PREFIXES.includes('http://publications.europa.eu/ontology/cdm#'));
  });
});
