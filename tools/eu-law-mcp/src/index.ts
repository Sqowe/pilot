#!/usr/bin/env node
/**
 * EU Law MCP Server
 *
 * Provides access to EU legislation, case-law, and official documents via:
 * - Cellar SPARQL endpoint (open, no auth)
 * - EUR-Lex document retrieval (direct URL patterns)
 *
 * Transport: stdio
 *
 * Tools:
 *   - search_eu_legislation: Search EU laws by keyword, year, type
 *   - get_eu_document: Retrieve full text of an EU legal document
 *   - get_eu_document_metadata: Get metadata for a document via SPARQL
 *   - search_eu_caselaw: Search CJEU case-law
 *   - list_official_journal: List Official Journal issues
 *   - eu_sparql_query: Execute custom SPARQL queries
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  searchEuLegislationSchema,
  handleSearchEuLegislation,
  type SearchEuLegislationInput,
} from './tools/search.js';
import {
  getEuDocumentSchema,
  handleGetEuDocument,
  getEuDocumentMetadataSchema,
  handleGetEuDocumentMetadata,
  type GetEuDocumentInput,
  type GetEuDocumentMetadataInput,
} from './tools/getDocument.js';
import {
  searchEuCaselawSchema,
  handleSearchEuCaselaw,
  type SearchEuCaselawInput,
} from './tools/caselaw.js';
import {
  listOfficialJournalSchema,
  handleListOfficialJournal,
  type ListOfficialJournalInput,
} from './tools/officialJournal.js';
import {
  euSparqlQuerySchema,
  handleEuSparqlQuery,
  type EuSparqlQueryInput,
} from './tools/sparqlQuery.js';

const server = new McpServer({
  name: 'eu-law',
  version: '1.0.0',
});

// --- Tool: search_eu_legislation ---
server.tool(
  'search_eu_legislation',
  'Search EU legislation (regulations, directives, decisions) via the Cellar SPARQL endpoint. ' +
    'Filter by keyword, year, type, and in-force status. Returns CELEX numbers, titles, and EUR-Lex links. ' +
    'No authentication required.',
  searchEuLegislationSchema.shape,
  async (input) => handleSearchEuLegislation(input as SearchEuLegislationInput)
);

// --- Tool: get_eu_document ---
server.tool(
  'get_eu_document',
  'Retrieve the full text of an EU legal document from EUR-Lex by CELEX number. ' +
    'Supports all 24 EU languages. Returns plain text extracted from the HTML version. ' +
    "Examples: '32024R1689' (AI Act), '32016R0679' (GDPR), '32000L0031' (e-Commerce Directive).",
  getEuDocumentSchema.shape,
  async (input) => handleGetEuDocument(input as GetEuDocumentInput)
);

// --- Tool: get_eu_document_metadata ---
server.tool(
  'get_eu_document_metadata',
  'Get structured metadata for an EU document: title, date, in-force status, author, ' +
    'EuroVoc subjects, and links. Uses the Cellar SPARQL endpoint.',
  getEuDocumentMetadataSchema.shape,
  async (input) => handleGetEuDocumentMetadata(input as GetEuDocumentMetadataInput)
);

// --- Tool: search_eu_caselaw ---
server.tool(
  'search_eu_caselaw',
  'Search EU Court of Justice (CJEU) case-law. Filter by keyword, year, or ECLI identifier. ' +
    'Returns case titles, ECLI numbers, dates, and EUR-Lex links.',
  searchEuCaselawSchema.shape,
  async (input) => handleSearchEuCaselaw(input as SearchEuCaselawInput)
);

// --- Tool: list_official_journal ---
server.tool(
  'list_official_journal',
  'List issues of the Official Journal of the European Union for a given year. ' +
    'Filter by series: L (Legislation) or C (Communications). ' +
    'Returns issue numbers, dates, and EUR-Lex links.',
  listOfficialJournalSchema.shape,
  async (input) => handleListOfficialJournal(input as ListOfficialJournalInput)
);

// --- Tool: eu_sparql_query ---
server.tool(
  'eu_sparql_query',
  'Execute a custom SPARQL SELECT query against the EU Cellar knowledge graph. ' +
    'Open endpoint, no auth needed. CDM prefixes are auto-prepended. ' +
    'Use for advanced queries: legislation metadata, EuroVoc subjects, court cases, OJ issues. ' +
    'Endpoint: https://publications.europa.eu/webapi/rdf/sparql',
  euSparqlQuerySchema.shape,
  async (input) => handleEuSparqlQuery(input as EuSparqlQueryInput)
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('EU Law MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
