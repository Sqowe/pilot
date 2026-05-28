/**
 * MCP Tool: eu_sparql_query
 * Execute a custom SPARQL query against the Cellar endpoint.
 * Power-user tool for advanced queries with safety constraints.
 */

import { z } from 'zod';
import { executeSparql, CDM_PREFIXES } from '../clients/sparql.js';

const MAX_RESULT_LIMIT = 1000;

export const euSparqlQuerySchema = z.object({
  query: z
    .string()
    .describe(
      'SPARQL SELECT query to execute. CDM prefixes are auto-prepended. ' +
        'A LIMIT clause is required (max 1000). ' +
        'Endpoint: https://publications.europa.eu/webapi/rdf/sparql'
    ),
  includePrefixes: z
    .boolean()
    .optional()
    .default(true)
    .describe('Auto-prepend common CDM/SKOS/DC prefixes (default: true)'),
});

export type EuSparqlQueryInput = z.infer<typeof euSparqlQuerySchema>;

/**
 * Validate that a SPARQL query is a safe, bounded SELECT query.
 * Rules:
 * 1. Must start with SELECT (after PREFIX declarations)
 * 2. Must have a LIMIT clause on the outermost query with value <= MAX_RESULT_LIMIT
 * 3. No update keywords (INSERT, DELETE, DROP, CREATE, LOAD, CLEAR, COPY, MOVE, ADD)
 * 4. No SERVICE (federated query abuse)
 * 5. No FROM / FROM NAMED (dataset clause abuse)
 * 6. No nested SELECT (subqueries can bypass outer LIMIT)
 */
function validateQuery(query: string): { valid: boolean; error?: string } {
  // Lexical pass: strip comments while respecting URIs, double-quoted and single-quoted strings
  const noComments = stripComments(query);

  // Strip PREFIX declarations
  const body = noComments.replace(/PREFIX\s+\S+\s+<[^>]+>/gi, '').trim();

  // Body must start with SELECT
  if (!body.match(/^SELECT\b/i)) {
    return { valid: false, error: 'Query must start with SELECT (after PREFIX declarations).' };
  }

  // Remove all string literals (both quote types, with escape handling) to avoid false positives
  const noStrings = stripStringLiterals(body);

  // Reject update/dangerous keywords (must not be preceded by ? which indicates a variable)
  const dangerousKeywords =
    /(?<!\?)\b(INSERT|DELETE|DROP|CREATE|LOAD|CLEAR|COPY|MOVE|ADD|SERVICE)\b/i;
  if (dangerousKeywords.test(noStrings)) {
    return {
      valid: false,
      error: 'UPDATE operations (INSERT, DELETE, DROP, CREATE) and SERVICE are not permitted.',
    };
  }

  // Reject FROM / FROM NAMED dataset clauses (must not be preceded by ? which indicates a variable)
  if (/(?<!\?)\bFROM\s+(NAMED\s+)?\S/i.test(noStrings)) {
    return { valid: false, error: 'FROM and FROM NAMED dataset clauses are not permitted.' };
  }

  // Reject nested SELECT (subqueries can bypass outer LIMIT)
  const selectCount = (noStrings.match(/\bSELECT\b/gi) || []).length;
  if (selectCount > 1) {
    return {
      valid: false,
      error: 'Nested SELECT subqueries are not permitted. Use a single top-level SELECT.',
    };
  }

  // Require LIMIT at the end of the query (outermost position)
  const limitMatch = noStrings.match(/\bLIMIT\s+(\d+)\s*(?:OFFSET\s+\d+\s*)?$/i);
  if (!limitMatch) {
    return {
      valid: false,
      error: `A LIMIT clause is required at the end of the query (max ${MAX_RESULT_LIMIT}).`,
    };
  }
  const limitValue = parseInt(limitMatch[1], 10);
  if (limitValue > MAX_RESULT_LIMIT) {
    return { valid: false, error: `LIMIT must be <= ${MAX_RESULT_LIMIT}. Got: ${limitValue}.` };
  }

  return { valid: true };
}

/**
 * Strip single-line comments (#) from SPARQL while respecting:
 * - URIs: <...> (# inside is part of the URI fragment)
 * - Double-quoted strings: "..." (with \" escapes)
 * - Single-quoted strings: '...' (with \' escapes)
 */
function stripComments(query: string): string {
  const lines = query.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    let cleaned = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];

      // URI: <...>
      if (ch === '<') {
        const end = line.indexOf('>', i + 1);
        if (end !== -1) {
          cleaned += line.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }

      // Double-quoted string: "..."
      if (ch === '"') {
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\' && j + 1 < line.length) {
            j += 2; // skip escaped char
          } else if (line[j] === '"') {
            break;
          } else {
            j++;
          }
        }
        cleaned += line.slice(i, j + 1);
        i = j + 1;
        continue;
      }

      // Single-quoted string: '...'
      if (ch === "'") {
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\' && j + 1 < line.length) {
            j += 2; // skip escaped char
          } else if (line[j] === "'") {
            break;
          } else {
            j++;
          }
        }
        cleaned += line.slice(i, j + 1);
        i = j + 1;
        continue;
      }

      // Comment: # outside strings/URIs — rest of line is comment
      if (ch === '#') {
        break;
      }

      cleaned += ch;
      i++;
    }
    result.push(cleaned);
  }

  return result.join('\n');
}

/**
 * Remove all string literals (single and double quoted, with escape handling)
 * from a SPARQL query body, replacing them with empty strings.
 */
function stripStringLiterals(body: string): string {
  let result = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];

    if (ch === '"') {
      // Skip double-quoted string
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === '\\' && j + 1 < body.length) {
          j += 2;
        } else if (body[j] === '"') {
          break;
        } else {
          j++;
        }
      }
      result += '""';
      i = j + 1;
      continue;
    }

    if (ch === "'") {
      // Skip single-quoted string
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === '\\' && j + 1 < body.length) {
          j += 2;
        } else if (body[j] === "'") {
          break;
        } else {
          j++;
        }
      }
      result += "''";
      i = j + 1;
      continue;
    }

    result += ch;
    i++;
  }
  return result;
}

/**
 * Escape markdown metacharacters in a table cell value.
 */
function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
}

export async function handleEuSparqlQuery(input: EuSparqlQueryInput) {
  let query = input.query.trim();

  // Prepend prefixes if requested and not already present
  if (input.includePrefixes !== false && !query.match(/^PREFIX\b/i)) {
    query = `${CDM_PREFIXES}\n${query}`;
  }

  const validation = validateQuery(query);
  if (!validation.valid) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Query rejected: ${validation.error}\n\nOnly bounded SELECT queries are allowed (no UPDATE, SERVICE, FROM clauses). Include a LIMIT clause (max ${MAX_RESULT_LIMIT}).`,
        },
      ],
    };
  }

  try {
    const result = await executeSparql(query);
    const vars = result.head.vars;
    const bindings = result.results.bindings;

    if (bindings.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Query returned 0 results.',
          },
        ],
      };
    }

    // Format as a markdown table (cap at 100 rows for output size)
    const displayBindings = bindings.slice(0, 100);
    const header = `| ${vars.map(escapeMarkdownCell).join(' | ')} |`;
    const separator = `| ${vars.map(() => '---').join(' | ')} |`;
    const rows = displayBindings.map((b) => {
      const cells = vars.map((v) => {
        let val = b[v]?.value ?? '';
        if (val.length > 80) {
          val = val.slice(0, 77) + '...';
        }
        return escapeMarkdownCell(val);
      });
      return `| ${cells.join(' | ')} |`;
    });

    const table = [header, separator, ...rows].join('\n');
    const footer =
      bindings.length > 100
        ? `\n\n*Showing first 100 of ${bindings.length} results.*`
        : `\n\n*${bindings.length} result(s).*`;

    return {
      content: [
        {
          type: 'text' as const,
          text: table + footer,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `SPARQL query failed: ${error instanceof Error ? error.message : 'Unknown error'}\n\nEndpoint: https://publications.europa.eu/webapi/rdf/sparql\nTip: Test your query at https://op.europa.eu/en/advanced-sparql-query-editor`,
        },
      ],
    };
  }
}
