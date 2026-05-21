#!/usr/bin/env node
/**
 * Hungarian Law MCP Server
 *
 * Provides access to Hungarian legislation via njt.hu (Nemzeti Jogszabálytár)
 * and the official gazette via magyarkozlony.hu (Magyar Közlöny).
 *
 * Transport: stdio
 *
 * Tools:
 *   - search_legislation: Search for Hungarian laws
 *   - get_law_text: Retrieve full text of a law
 *   - get_law_section: Get a specific section of a law
 *   - list_gazette_issues: List Magyar Közlöny issues
 *   - get_gazette_issue: Get details of a specific gazette issue
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  searchLegislationSchema,
  handleSearchLegislation,
  type SearchLegislationInput,
} from './tools/search.js';
import {
  getLawTextSchema,
  handleGetLawText,
  getLawSectionSchema,
  handleGetLawSection,
  type GetLawTextInput,
  type GetLawSectionInput,
} from './tools/getLaw.js';
import {
  listGazetteIssuesSchema,
  handleListGazetteIssues,
  getGazetteIssueSchema,
  handleGetGazetteIssue,
  type ListGazetteIssuesInput,
  type GetGazetteIssueInput,
} from './tools/gazette.js';

const server = new McpServer({
  name: 'hungarian-law',
  version: '1.0.0',
});

// --- Tool: search_legislation ---
server.tool(
  'search_legislation',
  'Search for Hungarian legislation (laws, decrees, regulations) on njt.hu. ' +
    'Supports keyword search (with Hungarian stemming), filtering by year, number, and type. ' +
    'Returns matching laws with titles and URLs.',
  searchLegislationSchema.shape,
  async (input) => handleSearchLegislation(input as SearchLegislationInput)
);

// --- Tool: get_law_text ---
server.tool(
  'get_law_text',
  'Retrieve the full text of a Hungarian law from njt.hu. ' +
    "Identify the law by URL, slug (e.g., '2017-78-00-00.37'), or year+number. " +
    'Returns structured text with title, table of contents, and full content. ' +
    'Use maxLength to control output size.',
  getLawTextSchema.shape,
  async (input) => handleGetLawText(input as GetLawTextInput)
);

// --- Tool: get_law_section ---
server.tool(
  'get_law_section',
  'Get a specific section (§) of a Hungarian law. ' +
    "Provide the law's NJT slug and the section reference (e.g., '42. §' or '1. § (2)'). " +
    'Useful for retrieving specific paragraphs without downloading the entire law.',
  getLawSectionSchema.shape,
  async (input) => handleGetLawSection(input as GetLawSectionInput)
);

// --- Tool: list_gazette_issues ---
server.tool(
  'list_gazette_issues',
  'List issues of the Magyar Közlöny (Hungarian Official Gazette) and Hivatalos Értesítő. ' +
    'Filter by year and month. Returns issue titles, dates, and PDF download links. ' +
    'The gazette contains newly published laws and official documents.',
  listGazetteIssuesSchema.shape,
  async (input) => handleListGazetteIssues(input as ListGazetteIssuesInput)
);

// --- Tool: get_gazette_issue ---
server.tool(
  'get_gazette_issue',
  'Get details of a specific Magyar Közlöny issue by year and issue number. ' +
    'Returns the title, date, view URL, and PDF download link.',
  getGazetteIssueSchema.shape,
  async (input) => handleGetGazetteIssue(input as GetGazetteIssueInput)
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Hungarian Law MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
