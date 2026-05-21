/**
 * MCP Tools: get_eu_document, get_eu_document_metadata
 * Retrieve EU legal documents by CELEX number.
 */

import { z } from 'zod';
import { getDocumentText } from '../clients/eurlex.js';
import { buildEurLexUrls, parseCelex, describeType, describeSector } from '../utils/celex.js';
import { executeSparql, bindingValue, CDM_PREFIXES } from '../clients/sparql.js';
import { toCellarLang, isValidEuLanguage } from '../utils/language.js';
import { sanitizeCelex } from '../utils/sanitize.js';

// --- get_eu_document ---

export const getEuDocumentSchema = z.object({
  celex: z.string().describe("CELEX number (e.g., '32024R1689' for AI Act, '32016R0679' for GDPR)"),
  language: z.string().optional().default('EN').describe('Language code (EN, FR, DE, HU, etc.)'),
  maxLength: z
    .number()
    .int()
    .positive()
    .max(100000)
    .optional()
    .default(15000)
    .describe('Maximum characters to return (default: 15000, max: 100000)'),
});

export type GetEuDocumentInput = z.infer<typeof getEuDocumentSchema>;

export async function handleGetEuDocument(input: GetEuDocumentInput) {
  const celex = sanitizeCelex(input.celex);
  if (!celex) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Invalid CELEX number "${input.celex}". Expected format: sector(1 digit) + year(4 digits) + type(1-2 letters) + number. Examples: 32024R1689, 32016R0679, 62019CJ0311.`,
        },
      ],
    };
  }

  const langInput = (input.language ?? 'EN').toUpperCase();
  const maxLength = Math.min(input.maxLength ?? 15000, 100000);

  if (!isValidEuLanguage(langInput)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Unsupported language code "${langInput}". Use a 2-letter EU language code (EN, FR, DE, HU, etc.).`,
        },
      ],
    };
  }

  const components = parseCelex(celex);
  const urls = buildEurLexUrls(celex, langInput);

  const result = await getDocumentText(celex, langInput, maxLength);

  if (!result) {
    return {
      content: [
        {
          type: 'text' as const,
          text: [
            `Could not retrieve document CELEX ${celex} in language ${langInput}.`,
            '',
            'Possible reasons:',
            '- The CELEX number may be incorrect',
            '- The document may not be available in the requested language',
            '- The EUR-Lex service may be temporarily unavailable',
            '',
            `Try browsing: ${urls.page}`,
          ].join('\n'),
        },
      ],
    };
  }

  const header = [
    `# CELEX ${celex}`,
    '',
    components
      ? `**Sector:** ${describeSector(components.sector)} | **Type:** ${describeType(components.type)} | **Year:** ${components.year}`
      : '',
    `**Language:** ${langInput}`,
    `**URL:** ${result.url}`,
    `**PDF:** ${urls.pdf}`,
    '',
    '---',
    '',
  ].join('\n');

  const footer = result.truncated
    ? `\n\n---\n*[Truncated at ${maxLength} characters. Increase maxLength for more, or use the PDF link for the full document.]*`
    : '';

  return {
    content: [
      {
        type: 'text' as const,
        text: header + result.text + footer,
      },
    ],
  };
}

// --- get_eu_document_metadata ---

export const getEuDocumentMetadataSchema = z.object({
  celex: z.string().describe('CELEX number of the document'),
  language: z
    .string()
    .optional()
    .default('EN')
    .describe('Language for title/summary (EN, FR, DE, HU, etc.)'),
});

export type GetEuDocumentMetadataInput = z.infer<typeof getEuDocumentMetadataSchema>;

export async function handleGetEuDocumentMetadata(input: GetEuDocumentMetadataInput) {
  const celex = sanitizeCelex(input.celex);
  if (!celex) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Invalid CELEX number "${input.celex}". Expected format: sector + year + type + number (e.g., 32024R1689).`,
        },
      ],
    };
  }

  const langInput = (input.language ?? 'EN').toUpperCase();
  const cellarLang = toCellarLang(langInput);
  if (!cellarLang) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Unsupported language code "${langInput}". Use a 2-letter EU language code.`,
        },
      ],
    };
  }

  const langLower = langInput.toLowerCase();

  const query = `
${CDM_PREFIXES}
SELECT DISTINCT ?title ?dateDocument ?dateForce ?inForce ?author ?subject ?celex
WHERE {
  ?work owl:sameAs <http://publications.europa.eu/resource/celex/${celex}>.
  ?work cdm:work_id_document ?celex.
  OPTIONAL { ?work cdm:work_date_document ?dateDocument. }
  OPTIONAL { ?work cdm:resource_legal_date_entry-into-force ?dateForce. }
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForce. }
  OPTIONAL { ?work cdm:work_created_by_agent ?author. }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work.
    ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/${cellarLang}>.
    ?expr cdm:expression_title ?title.
  }
  OPTIONAL {
    ?work cdm:work_is_about_concept_eurovoc ?subjectUri.
    ?subjectUri skos:prefLabel ?subject.
    FILTER(lang(?subject) = "${langLower}")
  }
}
LIMIT 50
  `.trim();

  try {
    const result = await executeSparql(query);
    const bindings = result.results.bindings;

    if (bindings.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No metadata found for CELEX ${celex}. The document may not exist in Cellar.`,
          },
        ],
      };
    }

    const first = bindings[0];
    const title = bindingValue(first, 'title') ?? 'Title not available';
    const dateDocument = bindingValue(first, 'dateDocument') ?? 'Unknown';
    const dateForce = bindingValue(first, 'dateForce');
    const inForce = bindingValue(first, 'inForce');
    const author = bindingValue(first, 'author');

    const subjects = [
      ...new Set(bindings.map((b) => bindingValue(b, 'subject')).filter((s): s is string => !!s)),
    ];

    const components = parseCelex(celex);
    const urls = buildEurLexUrls(celex, langInput);

    const lines = [
      `# ${title}`,
      '',
      `**CELEX:** ${celex}`,
      components ? `**Sector:** ${describeSector(components.sector)}` : '',
      components ? `**Type:** ${describeType(components.type)}` : '',
      `**Date:** ${dateDocument}`,
      dateForce ? `**Entry into force:** ${dateForce}` : '',
      inForce !== undefined ? `**In force:** ${inForce}` : '',
      author ? `**Author:** ${author.split('/').pop()}` : '',
      subjects.length > 0 ? `**Subjects:** ${subjects.join(', ')}` : '',
      '',
      `**Links:**`,
      `- EUR-Lex page: ${urls.page}`,
      `- HTML: ${urls.html}`,
      `- PDF: ${urls.pdf}`,
    ].filter(Boolean);

    return {
      content: [
        {
          type: 'text' as const,
          text: lines.join('\n'),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Failed to retrieve metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
}
