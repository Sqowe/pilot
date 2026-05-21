/**
 * MCP Tool: search_eu_legislation
 * Search EU legislation via Cellar SPARQL endpoint.
 */

import { z } from 'zod';
import { executeSparql, bindingValue, CDM_PREFIXES } from '../clients/sparql.js';
import { buildEurLexUrls, parseCelex, describeType } from '../utils/celex.js';
import { toCellarLang } from '../utils/language.js';
import { sanitizeKeyword } from '../utils/sanitize.js';

export const searchEuLegislationSchema = z.object({
  keyword: z.string().optional().describe('Search keyword in document title (any EU language)'),
  year: z
    .number()
    .int()
    .min(1952)
    .max(new Date().getFullYear() + 5)
    .optional()
    .describe('Year of the legislation'),
  type: z
    .enum(['regulation', 'directive', 'decision', 'recommendation', 'opinion', 'all'])
    .optional()
    .default('all')
    .describe('Type of legal act'),
  inForce: z.boolean().optional().default(false).describe('Only return acts currently in force'),
  language: z
    .string()
    .optional()
    .default('EN')
    .describe('Language code for titles (EN, FR, DE, HU, etc.)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Maximum results to return (default: 20, max: 50)'),
});

export type SearchEuLegislationInput = z.infer<typeof searchEuLegislationSchema>;

const TYPE_FILTERS: Record<string, string> = {
  regulation: `
    ?work cdm:resource_legal_type <http://publications.europa.eu/resource/authority/resource-type/REG>.`,
  directive: `
    ?work cdm:resource_legal_type <http://publications.europa.eu/resource/authority/resource-type/DIR>.`,
  decision: `
    ?work cdm:resource_legal_type <http://publications.europa.eu/resource/authority/resource-type/DEC>.`,
  recommendation: `
    ?work cdm:resource_legal_type <http://publications.europa.eu/resource/authority/resource-type/RECO>.`,
  opinion: `
    ?work cdm:resource_legal_type <http://publications.europa.eu/resource/authority/resource-type/OPIN>.`,
  all: '',
};

export async function handleSearchEuLegislation(input: SearchEuLegislationInput) {
  const langInput = (input.language ?? 'EN').toUpperCase();
  const cellarLang = toCellarLang(langInput);
  if (!cellarLang) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Unsupported language code "${langInput}". Use a 2-letter EU language code (EN, FR, DE, HU, etc.).`,
        },
      ],
    };
  }

  const limit = input.limit ?? 20;
  const typeFilter = TYPE_FILTERS[input.type ?? 'all'] ?? '';

  let filters = '';
  if (input.keyword) {
    const escaped = sanitizeKeyword(input.keyword);
    filters += `FILTER(CONTAINS(LCASE(?title), LCASE("${escaped}")))`;
  }
  if (input.year) {
    filters += `\nFILTER(?year = "${input.year}"^^xsd:gYear)`;
  }
  if (input.inForce) {
    filters += `\n?work cdm:resource_legal_in-force "true"^^xsd:boolean.`;
  }

  const query = `
${CDM_PREFIXES}
SELECT DISTINCT ?work ?celex ?title ?year ?type ?dateDocument
WHERE {
  ?work a cdm:legislation_secondary.
  ?work cdm:work_id_document ?celex.
  ?work cdm:resource_legal_year ?year.
  OPTIONAL { ?work cdm:resource_legal_type ?type. }
  OPTIONAL { ?work cdm:work_date_document ?dateDocument. }
  ?expr cdm:expression_belongs_to_work ?work.
  ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/${cellarLang}>.
  ?expr cdm:expression_title ?title.
  ${filters}
  ${typeFilter}
}
ORDER BY DESC(?dateDocument)
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
            text: 'No EU legislation found matching the search criteria. Try broader keywords or different filters.',
          },
        ],
      };
    }

    const formatted = bindings.map((b, i) => {
      const celex = bindingValue(b, 'celex') ?? '';
      const title = bindingValue(b, 'title') ?? 'Untitled';
      const year = bindingValue(b, 'year') ?? '';
      const date = bindingValue(b, 'dateDocument') ?? '';
      const parsed = parseCelex(celex);
      const typeDesc = parsed ? describeType(parsed.type) : '';
      const urls = celex ? buildEurLexUrls(celex, langInput) : null;

      let entry = `${i + 1}. **${title}**`;
      entry += `\n   CELEX: ${celex}`;
      if (typeDesc) entry += ` | Type: ${typeDesc}`;
      if (year) entry += ` | Year: ${year}`;
      if (date) entry += ` | Date: ${date}`;
      if (urls) entry += `\n   URL: ${urls.page}`;
      return entry;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Found ${bindings.length} EU legislative act(s):\n\n${formatted.join('\n\n')}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `SPARQL query failed: ${error instanceof Error ? error.message : 'Unknown error'}. The Cellar endpoint may be temporarily unavailable.`,
        },
      ],
    };
  }
}
