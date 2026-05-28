/**
 * MCP Tools: get_law_text, get_law_section
 * Retrieve full text or specific sections of Hungarian legislation.
 */

import { z } from 'zod';
import { getLawBySlug, getLawByUrl, getLawByReference, getLawSection } from '../scrapers/njt.js';

// --- get_law_text ---

export const getLawTextSchema = z.object({
  year: z
    .number()
    .int()
    .min(1827)
    .max(new Date().getFullYear() + 2)
    .optional()
    .describe('Year of the legislation'),
  number: z.number().int().positive().optional().describe('Number of the legislation (Arabic)'),
  type: z.string().optional().describe("Type (e.g., 'törvény', 'Korm. rendelet')"),
  url: z.string().url().optional().describe('Direct njt.hu URL of the legislation'),
  slug: z.string().optional().describe("NJT URL slug (e.g., '2017-78-00-00.37')"),
  maxLength: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10000)
    .describe('Maximum characters to return (default: 10000). Use higher for full text.'),
});

export type GetLawTextInput = z.infer<typeof getLawTextSchema>;

const ALLOWED_HOSTS = ['njt.jog.gov.hu', 'www.njt.jog.gov.hu'];

export async function handleGetLawText(input: GetLawTextInput) {
  let law = null;

  if (input.url) {
    // Validate URL to prevent SSRF — only allow njt.hu domains
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return {
        content: [{ type: 'text' as const, text: 'Invalid URL format.' }],
      };
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `URL must be an https:// link to njt.jog.gov.hu. Received host: "${parsed.hostname}".`,
          },
        ],
      };
    }
    law = await getLawByUrl(input.url);
  } else if (input.slug) {
    law = await getLawBySlug(input.slug);
  } else if (input.year && input.number) {
    law = await getLawByReference(input.year, input.number, input.type);
  } else {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Please provide either a URL, slug, or year+number to identify the legislation.',
        },
      ],
    };
  }

  if (!law) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Could not find or retrieve the requested legislation. The law may not exist or the URL pattern may be different. Try using search_legislation first.',
        },
      ],
    };
  }

  // Truncate if needed
  let text = law.fullText;
  const maxLen = input.maxLength ?? 10000;
  let truncated = false;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen);
    truncated = true;
  }

  const header = [
    `# ${law.title}`,
    '',
    `**Full title:** ${law.fullTitle}`,
    `**URL:** ${law.url}`,
    `**Sections found:** ${law.sections.length}`,
    '',
  ].join('\n');

  const tocSection =
    law.tableOfContents.length > 0
      ? `## Table of Contents\n${law.tableOfContents.slice(0, 30).join('\n')}\n\n`
      : '';

  const footer = truncated
    ? `\n\n---\n*[Truncated at ${maxLen} characters. Use get_law_section for specific sections or increase maxLength.]*`
    : '';

  return {
    content: [
      {
        type: 'text' as const,
        text: header + tocSection + '## Text\n\n' + text + footer,
      },
    ],
  };
}

// --- get_law_section ---

export const getLawSectionSchema = z.object({
  slug: z.string().describe("NJT URL slug of the law (e.g., '2017-78-00-00.37')"),
  section: z.string().describe("Section reference (e.g., '42. §', '1. § (2)')"),
});

export type GetLawSectionInput = z.infer<typeof getLawSectionSchema>;

export async function handleGetLawSection(input: GetLawSectionInput) {
  const sectionText = await getLawSection(input.slug, input.section);

  if (!sectionText) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Could not find section "${input.section}" in the law. Make sure the slug is correct and the section reference matches the format used in the law (e.g., "42. §" or "1. § (2)").`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: `## ${input.section}\n\n${sectionText}`,
      },
    ],
  };
}
