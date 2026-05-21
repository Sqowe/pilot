/**
 * MCP Tool: list_official_journal
 * List EU Official Journal issues via Cellar SPARQL.
 */

import { z } from 'zod';
import { executeSparql, bindingValue, CDM_PREFIXES } from '../clients/sparql.js';

export const listOfficialJournalSchema = z.object({
  year: z
    .number()
    .int()
    .min(1952)
    .max(new Date().getFullYear() + 5)
    .describe('Year of the Official Journal issues'),
  series: z
    .enum(['L', 'C', 'all'])
    .optional()
    .default('all')
    .describe('OJ series: L (Legislation), C (Communications), or all'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(30)
    .describe('Maximum results (default: 30)'),
});

export type ListOfficialJournalInput = z.infer<typeof listOfficialJournalSchema>;

export async function handleListOfficialJournal(input: ListOfficialJournalInput) {
  const year = input.year;
  const limit = input.limit ?? 30;

  let seriesFilter = '';
  if (input.series === 'L') {
    seriesFilter = 'FILTER(?ojclass = "L")';
  } else if (input.series === 'C') {
    seriesFilter = 'FILTER(?ojclass = "C")';
  }

  const query = `
${CDM_PREFIXES}
SELECT ?uri ?ojclass ?ojnumber ?ojyear ?workdatedoc
WHERE {
  ?uri cdm:official-journal_class ?ojclass.
  ?uri cdm:official-journal_number ?ojnumber.
  ?uri cdm:official-journal_year ?ojyear.
  ?uri cdm:work_date_document ?workdatedoc.
  ?uri rdf:type cdm:official-journal.
  FILTER(?ojyear = "${year}"^^xsd:gYear)
  ${seriesFilter}
}
ORDER BY DESC(?workdatedoc)
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
            text: `No Official Journal issues found for year ${year}.`,
          },
        ],
      };
    }

    const formatted = bindings.map((b, i) => {
      const ojClass = bindingValue(b, 'ojclass') ?? '';
      const ojNumber = bindingValue(b, 'ojnumber') ?? '';
      const date = bindingValue(b, 'workdatedoc') ?? '';
      const uri = bindingValue(b, 'uri') ?? '';

      const seriesName =
        ojClass === 'L' ? 'Legislation' : ojClass === 'C' ? 'Communications' : ojClass;
      const ojRef = `OJ ${ojClass} ${ojNumber}, ${year}`;

      let entry = `${i + 1}. **${ojRef}** (${seriesName})`;
      if (date) entry += `\n   Date: ${date}`;
      if (uri) entry += `\n   Cellar: ${uri}`;
      entry += `\n   EUR-Lex: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:${ojClass}:${year}:${ojNumber}:TOC`;
      return entry;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Found ${bindings.length} Official Journal issue(s) for ${year}:\n\n${formatted.join('\n\n')}`,
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
