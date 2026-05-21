/**
 * MCP Tool: search_legislation
 * Search for Hungarian laws by keyword, year, number, or type.
 */

import { z } from 'zod';
import { searchLegislation } from '../scrapers/njt.js';

export const searchLegislationSchema = z.object({
  keyword: z
    .string()
    .optional()
    .describe('Search keyword or phrase (Hungarian). Supports stemming.'),
  year: z
    .number()
    .int()
    .min(1827)
    .max(2030)
    .optional()
    .describe('Year of the legislation (e.g., 2017)'),
  number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Serial number of the legislation (Arabic number, e.g., 78 for LXXVIII)'),
  type: z.string().optional().describe("Type of legislation (e.g., 'törvény', 'Korm. rendelet')"),
  onlyInForce: z
    .boolean()
    .optional()
    .default(true)
    .describe('Only return currently in-force legislation (default: true)'),
  titleOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('Search only in titles (default: false)'),
});

export type SearchLegislationInput = z.infer<typeof searchLegislationSchema>;

export async function handleSearchLegislation(input: SearchLegislationInput) {
  const results = await searchLegislation({
    keyword: input.keyword,
    year: input.year,
    number: input.number,
    type: input.type,
    onlyInForce: input.onlyInForce,
    titleOnly: input.titleOnly,
  });

  if (results.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No legislation found matching the search criteria. Try broadening your search or using different keywords.',
        },
      ],
    };
  }

  const formatted = results
    .map((r, i) => {
      let entry = `${i + 1}. **${r.title}**`;
      if (r.url) entry += `\n   URL: ${r.url}`;
      if (r.description) entry += `\n   ${r.description}`;
      return entry;
    })
    .join('\n\n');

  return {
    content: [
      {
        type: 'text' as const,
        text: `Found ${results.length} result(s):\n\n${formatted}`,
      },
    ],
  };
}
