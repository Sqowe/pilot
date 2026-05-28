/**
 * MCP Tools: list_gazette_issues, get_gazette_issue
 * Access the Magyar Közlöny (Hungarian Official Gazette).
 */

import { z } from 'zod';
import { listGazetteIssues, getGazetteIssue } from '../scrapers/kozlony.js';

// --- list_gazette_issues ---

export const listGazetteIssuesSchema = z.object({
  year: z
    .number()
    .int()
    .min(1998)
    .max(new Date().getFullYear() + 2)
    .optional()
    .describe('Filter by year (1998-present)'),
  month: z.number().int().min(1).max(12).optional().describe('Filter by month (1-12)'),
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1)
    .describe('Page number for pagination (default: 1)'),
});

export type ListGazetteIssuesInput = z.infer<typeof listGazetteIssuesSchema>;

export async function handleListGazetteIssues(input: ListGazetteIssuesInput) {
  // Apply runtime defaults for fields that may not be set when using schema.shape
  const page = input.page ?? 1;

  const issues = await listGazetteIssues({
    year: input.year,
    month: input.month,
    page,
  });

  if (issues.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No gazette issues found for the specified criteria.',
        },
      ],
    };
  }

  const formatted = issues
    .map((issue, i) => {
      const lines = [`${i + 1}. **${issue.title}**`];
      if (issue.date) lines.push(`   Date: ${issue.date}`);
      if (issue.viewUrl) lines.push(`   View: ${issue.viewUrl}`);
      if (issue.downloadUrl) lines.push(`   Download (PDF): ${issue.downloadUrl}`);
      return lines.join('\n');
    })
    .join('\n\n');

  return {
    content: [
      {
        type: 'text' as const,
        text: `Found ${issues.length} gazette issue(s):\n\n${formatted}`,
      },
    ],
  };
}

// --- get_gazette_issue ---

export const getGazetteIssueSchema = z.object({
  year: z
    .number()
    .int()
    .min(1998)
    .max(new Date().getFullYear() + 2)
    .describe('Year of the gazette issue'),
  issueNumber: z.number().int().positive().describe('Issue number (szám)'),
  publicationType: z
    .enum(['magyar_kozlony', 'hivatalos_ertesito', 'other'])
    .optional()
    .default('magyar_kozlony')
    .describe("Publication type (default: 'magyar_kozlony')"),
});

export type GetGazetteIssueInput = z.infer<typeof getGazetteIssueSchema>;

export async function handleGetGazetteIssue(input: GetGazetteIssueInput) {
  const pubType = input.publicationType ?? 'magyar_kozlony';
  const issue = await getGazetteIssue(input.year, input.issueNumber, pubType);

  if (!issue) {
    const typeLabel =
      pubType === 'magyar_kozlony'
        ? 'Magyar Közlöny'
        : pubType === 'hivatalos_ertesito'
          ? 'Hivatalos Értesítő'
          : pubType;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Could not find ${typeLabel} ${input.year}. évi ${input.issueNumber}. szám. Try listing issues first with list_gazette_issues.`,
        },
      ],
    };
  }

  const lines = [
    `# ${issue.title}`,
    '',
    `**Date:** ${issue.date}`,
    `**Type:** ${issue.type === 'magyar_kozlony' ? 'Magyar Közlöny' : issue.type === 'hivatalos_ertesito' ? 'Hivatalos Értesítő' : 'Other'}`,
  ];

  if (issue.viewUrl) lines.push(`**View online:** ${issue.viewUrl}`);
  if (issue.downloadUrl) lines.push(`**Download PDF:** ${issue.downloadUrl}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
  };
}
