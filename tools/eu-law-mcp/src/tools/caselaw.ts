/**
 * MCP Tool: search_eu_caselaw
 * Search EU Court of Justice case-law via Cellar SPARQL.
 */

import { z } from 'zod';
import { executeSparql, bindingValue, CDM_PREFIXES } from '../clients/sparql.js';
import { sanitizeKeyword, isValidEcli } from '../utils/sanitize.js';

export const searchEuCaselawSchema = z.object({
  keyword: z.string().optional().describe('Search keyword in case title'),
  year: z
    .number()
    .int()
    .min(1952)
    .max(new Date().getFullYear() + 5)
    .optional()
    .describe('Year of the judgment'),
  ecli: z.string().optional().describe("ECLI identifier (e.g., 'ECLI:EU:C:2020:559')"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum results (default: 20)'),
});

export type SearchEuCaselawInput = z.infer<typeof searchEuCaselawSchema>;

export async function handleSearchEuCaselaw(input: SearchEuCaselawInput) {
  const limit = input.limit ?? 20;

  // Validate ECLI if provided
  const ecli = input.ecli?.trim();
  if (ecli && !isValidEcli(ecli)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Invalid ECLI format "${input.ecli}". Expected format: ECLI:{country}:{court}:{year}:{number} (e.g., ECLI:EU:C:2020:559).`,
        },
      ],
    };
  }

  let filters = '';
  if (input.keyword) {
    const escaped = sanitizeKeyword(input.keyword);
    filters += `FILTER(CONTAINS(LCASE(?title), LCASE("${escaped}")))`;
  }
  if (input.year) {
    filters += `\nFILTER(?dateDoc >= "${input.year}-01-01"^^xsd:date && ?dateDoc < "${input.year + 1}-01-01"^^xsd:date)`;
  }
  if (ecli) {
    filters += `\nFILTER(?ecli = "${ecli}")`;
  }

  const query = `
${CDM_PREFIXES}
SELECT DISTINCT ?work ?ecli ?title ?dateDoc ?celex
WHERE {
  ?work a ?class.
  FILTER(?class IN (
    cdm:case-law,
    cdm:document_cjeu
  ))
  ?work cdm:date_creation_legacy ?dateDoc.
  OPTIONAL { ?work cdm:case-law_ecli ?ecli. }
  OPTIONAL { ?work cdm:work_id_document ?celex. }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work.
    ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG>.
    ?expr cdm:expression_title ?title.
  }
  ${filters}
}
ORDER BY DESC(?dateDoc)
LIMIT ${limit}
  `.trim();

  try {
    const result = await executeSparql(query);
    const bindings = result.results.bindings;

    if (bindings.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No EU case-law found matching the criteria.',
          },
        ],
      };
    }

    const formatted = bindings.map((b, i) => {
      const ecli = bindingValue(b, 'ecli') ?? '';
      const title = bindingValue(b, 'title') ?? 'Untitled';
      const date = bindingValue(b, 'dateDoc') ?? '';
      const celex = bindingValue(b, 'celex') ?? '';

      let entry = `${i + 1}. **${title}**`;
      if (ecli) entry += `\n   ECLI: ${ecli}`;
      if (celex) entry += ` | CELEX: ${celex}`;
      if (date) entry += `\n   Date: ${date}`;
      if (celex) {
        entry += `\n   URL: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`;
      }
      return entry;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Found ${bindings.length} case(s):\n\n${formatted.join('\n\n')}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `SPARQL query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
}
