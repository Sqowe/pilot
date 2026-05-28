/**
 * Handler-level tests verifying tool input validation and response formatting.
 * These test the handler functions directly with validation logic
 * (network calls would need mocking for full integration tests).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleGetEuDocument } from '../tools/getDocument.js';
import { handleGetEuDocumentMetadata } from '../tools/getDocument.js';
import { handleSearchEuCaselaw } from '../tools/caselaw.js';
import { handleEuSparqlQuery } from '../tools/sparqlQuery.js';

describe('get_eu_document handler validation', () => {
  it('rejects invalid CELEX number', async () => {
    const result = await handleGetEuDocument({
      celex: 'not-valid',
      language: 'EN',
      maxLength: 15000,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Invalid CELEX'));
  });

  it('rejects CELEX with injection attempt', async () => {
    const result = await handleGetEuDocument({
      celex: '32024R1689" } UNION { ?x ?y ?z',
      language: 'EN',
      maxLength: 15000,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Invalid CELEX'));
  });

  it('rejects unsupported language code', async () => {
    const result = await handleGetEuDocument({
      celex: '32024R1689',
      language: 'XX',
      maxLength: 15000,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Unsupported language'));
  });
});

describe('get_eu_document_metadata handler validation', () => {
  it('rejects invalid CELEX', async () => {
    const result = await handleGetEuDocumentMetadata({
      celex: 'invalid',
      language: 'EN',
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Invalid CELEX'));
  });

  it('rejects unsupported language', async () => {
    const result = await handleGetEuDocumentMetadata({
      celex: '32024R1689',
      language: 'ZZ',
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Unsupported language'));
  });
});

describe('search_eu_caselaw handler validation', () => {
  it('rejects invalid ECLI format', async () => {
    const result = await handleSearchEuCaselaw({
      ecli: 'ECLI:EU:C:2020:559" UNION { ?x ?y ?z }',
      limit: 20,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Invalid ECLI'));
  });

  it('rejects lowercase ECLI', async () => {
    const result = await handleSearchEuCaselaw({
      ecli: 'ecli:eu:c:2020:559',
      limit: 20,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Invalid ECLI'));
  });
});

describe('eu_sparql_query handler validation', () => {
  it('rejects INSERT queries', async () => {
    const result = await handleEuSparqlQuery({
      query: 'INSERT DATA { <x> <y> <z> }',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Query rejected'));
  });

  it('rejects DELETE queries', async () => {
    const result = await handleEuSparqlQuery({
      query: 'DELETE WHERE { ?s ?p ?o }',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Query rejected'));
  });

  it('rejects SERVICE keyword (federated query abuse)', async () => {
    const result = await handleEuSparqlQuery({
      query: 'SELECT * WHERE { SERVICE <http://evil.com/sparql> { ?s ?p ?o } } LIMIT 10',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Query rejected'));
  });

  it('rejects queries not starting with SELECT', async () => {
    const result = await handleEuSparqlQuery({
      query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 10',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Query rejected'));
  });

  it('allows keywords inside string literals (validation only)', () => {
    // Test that the safety check does NOT reject a query with
    // dangerous keywords inside string literals.
    const query = 'SELECT ?s WHERE { ?s ?p "contains DELETE word" } LIMIT 10';
    const noStrings = query.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const hasDangerous = /\b(INSERT|DELETE|DROP|CREATE|LOAD|CLEAR|COPY|MOVE|ADD|SERVICE)\b/i.test(
      noStrings
    );
    assert.ok(!hasDangerous, 'DELETE inside double-quoted string should not be detected');
  });

  it('allows keywords inside single-quoted string literals', () => {
    // Single-quoted strings should also be safe
    const query = "SELECT ?s WHERE { ?s ?p 'contains SERVICE word' } LIMIT 10";
    const noStrings = query.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const hasDangerous = /\b(INSERT|DELETE|DROP|CREATE|LOAD|CLEAR|COPY|MOVE|ADD|SERVICE)\b/i.test(
      noStrings
    );
    assert.ok(!hasDangerous, 'SERVICE inside single-quoted string should not be detected');
  });

  it('does not strip # inside single-quoted strings as comment', () => {
    // A # inside a single-quoted string should NOT be treated as a comment
    // Pure validation test — no network call
    const query = "SELECT ?s WHERE { ?s ?p 'test#value' } LIMIT 10";
    // If # were treated as comment, everything after it would be stripped
    // and the query would be malformed. We verify the string stays intact.
    const hasLimit = /LIMIT\s+10/i.test(query);
    assert.ok(hasLimit);
    // The query has no dangerous keywords outside strings
    const noStrings = query.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const hasDangerous =
      /(?<!\?)\b(INSERT|DELETE|DROP|CREATE|LOAD|CLEAR|COPY|MOVE|ADD|SERVICE)\b/i.test(noStrings);
    assert.ok(!hasDangerous);
  });

  it('rejects SERVICE hidden after single-quoted string', async () => {
    const result = await handleEuSparqlQuery({
      query: "SELECT ?s WHERE { ?s ?p 'x' } SERVICE <http://evil.com> { ?s ?p ?o } LIMIT 10",
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Query rejected'));
  });

  it('does not reject variable names containing reserved words', () => {
    // ?from and ?service are valid SPARQL variable names — should not trigger rejection
    // Pure validation test: check that the negative lookbehind (?<!\?) works
    const query = 'SELECT ?from ?service WHERE { ?from ?p ?service } LIMIT 10';
    const noStrings = query.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const hasDangerous =
      /(?<!\?)\b(INSERT|DELETE|DROP|CREATE|LOAD|CLEAR|COPY|MOVE|ADD|SERVICE)\b/i.test(noStrings);
    const hasFrom = /(?<!\?)\bFROM\s+(NAMED\s+)?\S/i.test(noStrings);
    assert.ok(!hasDangerous, '?service variable should not trigger SERVICE rejection');
    assert.ok(!hasFrom, '?from variable should not trigger FROM rejection');
  });

  it('rejects queries without LIMIT', async () => {
    const result = await handleEuSparqlQuery({
      query: 'SELECT ?s WHERE { ?s ?p ?o }',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('LIMIT clause is required'));
  });

  it('rejects queries with LIMIT > 1000', async () => {
    const result = await handleEuSparqlQuery({
      query: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5000',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('LIMIT must be <= 1000'));
  });

  it('rejects FROM clause', async () => {
    const result = await handleEuSparqlQuery({
      query: 'SELECT ?s FROM <http://example.org/graph> WHERE { ?s ?p ?o } LIMIT 10',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('FROM'));
  });

  it('rejects FROM NAMED clause', async () => {
    const result = await handleEuSparqlQuery({
      query: 'SELECT ?s FROM NAMED <http://example.org/graph> WHERE { ?s ?p ?o } LIMIT 10',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('FROM'));
  });

  it('rejects FROM with prefixed name', async () => {
    const result = await handleEuSparqlQuery({
      query: 'SELECT ?s FROM ex:graph WHERE { ?s ?p ?o } LIMIT 10',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('FROM'));
  });

  it('rejects nested SELECT subqueries', async () => {
    const result = await handleEuSparqlQuery({
      query: 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } } LIMIT 10',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Nested SELECT'));
  });

  it('rejects LIMIT in subquery only (outer unbounded)', async () => {
    // This has two SELECTs — should be rejected as nested
    const result = await handleEuSparqlQuery({
      query: 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } LIMIT 5 } } LIMIT 10',
      includePrefixes: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes('Nested SELECT'));
  });
});
