/**
 * SPARQL client for the EU Publications Office Cellar endpoint.
 * Open endpoint — no authentication required.
 *
 * Endpoint: https://publications.europa.eu/webapi/rdf/sparql
 */

import { fetchJson } from '../utils/http.js';
import { Cache } from '../utils/cache.js';

const SPARQL_ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';

// Cache SPARQL results for 30 minutes
const queryCache = new Cache<SparqlResult>(30);

export interface SparqlBinding {
  type: 'uri' | 'literal' | 'typed-literal' | 'bnode';
  value: string;
  'xml:lang'?: string;
  datatype?: string;
}

export interface SparqlResult {
  head: { vars: string[] };
  results: {
    bindings: Array<Record<string, SparqlBinding>>;
  };
}

/**
 * Execute a SPARQL SELECT query against the Cellar endpoint.
 */
export async function executeSparql(query: string): Promise<SparqlResult> {
  const cacheKey = query.trim();
  const cached = queryCache.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    query,
    format: 'application/sparql-results+json',
  });

  const result = await fetchJson<SparqlResult>(`${SPARQL_ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/sparql-results+json',
    },
  });

  queryCache.set(cacheKey, result);
  return result;
}

/**
 * Helper: extract a simple string value from a binding.
 */
export function bindingValue(
  binding: Record<string, SparqlBinding>,
  key: string
): string | undefined {
  return binding[key]?.value;
}

/**
 * Common CDM (Common Data Model) prefixes used in EU SPARQL queries.
 */
export const CDM_PREFIXES = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX purl: <http://purl.org/dc/elements/1.1/>
`.trim();
