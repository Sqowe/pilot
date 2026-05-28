import { Type } from 'typebox';
import type { MemoryService } from './memory-service';
import type { MemoryToolDefinition, MemorySearchResult, MemoryReadResult } from './memory-types';
import { normalizeWorkspaceKey } from './memory-utils';
import { logError } from '../utils/logger';

/**
 * Format a search result for the model — concise but informative.
 */
function formatChatSearchResult(result: MemorySearchResult, index: number): string {
  const lines = [
    `${index + 1}. [${result.kind}] "${result.title}"`,
    `   id: ${result.id}`,
    `   summary: ${result.summary}`,
  ];
  if (result.contentPreview) {
    lines.push(`   preview: ${result.contentPreview}`);
  }
  if (result.sourceSessionTitle) {
    lines.push(`   session: ${result.sourceSessionTitle}`);
  }
  if (result.keywords?.length) {
    lines.push(`   keywords: ${result.keywords.slice(0, 8).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Format a detailed read result for the model.
 * Output is bounded to prevent excessive context window consumption.
 */
function formatChatReadResult(result: MemoryReadResult): string {
  const MAX_DETAILS_CHARS = 2000;
  const MAX_RAW_TEXT_CHARS = 3000;

  const lines = [`## ${result.title}`, `type: ${result.kind}`, `summary: ${result.summary}`];
  if (result.sourceSessionTitle) {
    lines.push(`session: ${result.sourceSessionTitle}`);
  }
  if (result.keywords?.length) {
    lines.push(`keywords: ${result.keywords.join(', ')}`);
  }
  if (result.details) {
    const bounded =
      result.details.length > MAX_DETAILS_CHARS
        ? result.details.slice(0, MAX_DETAILS_CHARS) + '\n[...truncated]'
        : result.details;
    lines.push(`\n### Details\n${bounded}`);
  }
  if (result.rawText) {
    const bounded =
      result.rawText.length > MAX_RAW_TEXT_CHARS
        ? result.rawText.slice(0, MAX_RAW_TEXT_CHARS) + '\n[...truncated]'
        : result.rawText;
    lines.push(`\n### Conversation Excerpt\n${bounded}`);
  }
  if (result.rawSession?.length) {
    const transcript = result.rawSession
      .slice(0, 20) // Cap at 20 turns to avoid token explosion
      .map((turn) => `${turn.role}: ${turn.content.slice(0, 500)}`)
      .join('\n\n');
    lines.push(`\n### Session Transcript (first 20 turns)\n${transcript}`);
  }
  return lines.join('\n');
}

/**
 * Validate that a read result belongs to the expected workspace.
 * Returns true if the result is safe to return for the given workspace.
 * Strict workspace-only policy: only experience entries from the same workspace are allowed.
 */
function isResultInWorkspace(result: MemoryReadResult, currentWorkspace: string | null): boolean {
  if (!currentWorkspace) {
    return false;
  }
  // Strict workspace-only policy: these tools only serve workspace experience memory.
  // Core memory is already passively injected into the prompt — no need to expose it
  // through workspace-scoped tools, which would create a policy mismatch.
  if (result.kind === 'core') {
    return false;
  }
  // Experience entries must match the current workspace.
  // Normalize the stored workspace key to handle formatting differences
  // (trailing slashes, case, path separators) that may exist in older entries.
  const resultWorkspace = normalizeWorkspaceKey(
    result.sourceWorkspace || result.workspaceKey || null
  );
  return resultWorkspace === currentWorkspace;
}

/**
 * Creates workspace-scoped chat search tools that the model can invoke on-demand
 * to retrieve context from past conversations in the current workspace.
 *
 * These complement the passive core memory injection — core memory (preferences,
 * conventions) is always injected into the prompt, while experience memory
 * (specific past conversations) is retrieved on-demand via these tools.
 *
 * Security:
 * - Tools enforce strict workspace isolation (experience memory only, no core).
 * - If no workspace context is available (no cwd), tools refuse to operate.
 * - Read operations validate workspace ownership of results.
 * - Both search and read are wrapped in try/catch for graceful failure.
 */
export function createWorkspaceChatSearchTools(
  memoryService: MemoryService,
  sessionCwd?: string
): MemoryToolDefinition[] {
  const currentWorkspace = normalizeWorkspaceKey(sessionCwd ?? null);

  const searchTool: MemoryToolDefinition = {
    name: 'search_workspace_chats',
    label: 'search_workspace_chats',
    description: [
      'Search past conversations from this workspace for relevant context.',
      'Use this when the user references something discussed before,',
      'when you need context about prior decisions, implementations, or discussions,',
      'or when the current question might benefit from knowledge accumulated in past sessions.',
      'Results are scoped to the current project workspace.',
      'Returns summaries — use read_workspace_chat to get full details on a specific result.',
    ].join(' '),
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description:
          'Natural language search query describing what you want to find from past conversations.',
      }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 15,
          description: 'Max results to return (default: 8).',
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const { query, limit } = params as { query: string; limit?: number };

      // Security: refuse to search without workspace context to prevent
      // accidental exposure of memories from unrelated workspaces.
      if (!currentWorkspace) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'Cannot search past conversations: no workspace context available. ' +
                'Please select a project folder for this chat session to enable workspace-scoped memory search.',
            },
          ],
          details: undefined as unknown,
        };
      }

      try {
        const rawResults = memoryService.search({
          query,
          scope: 'workspace',
          sourceWorkspace: currentWorkspace,
          limit: limit || 8,
        });

        // Defense in depth: post-filter results to enforce workspace ownership
        // even if the search layer returns mixed-workspace data due to bugs or
        // stale metadata. Strict workspace-only: exclude core entries too.
        const results = rawResults.filter((r) => {
          if (r.kind === 'core') return false;
          const resultWorkspace = normalizeWorkspaceKey(
            r.sourceWorkspace || r.workspaceKey || null
          );
          return resultWorkspace === currentWorkspace;
        });

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No relevant past conversations found in this workspace for: "${query}"`,
              },
            ],
            details: undefined as unknown,
          };
        }

        const formatted = [
          `Found ${results.length} relevant result(s) from past workspace conversations:`,
          '',
          ...results.map((r, i) => formatChatSearchResult(r, i)),
          '',
          'Use read_workspace_chat with the id to get full details on any result.',
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text: formatted }],
          details: undefined as unknown,
        };
      } catch (error) {
        logError('[search_workspace_chats] Search failed:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'Memory search encountered an error. The search could not be completed. ' +
                'You can try again or proceed without past conversation context.',
            },
          ],
          details: undefined as unknown,
        };
      }
    },
  };

  const readTool: MemoryToolDefinition = {
    name: 'read_workspace_chat',
    label: 'read_workspace_chat',
    description:
      'Read full details of a past conversation result returned by search_workspace_chats. ' +
      'Returns the complete chunk text, session transcript excerpt, or detailed memory entry.',
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        description: 'The id from a search_workspace_chats result.',
      }),
    }),
    async execute(_toolCallId, params) {
      const { id } = params as { id: string };

      // Security: refuse to read without workspace context
      if (!currentWorkspace) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Cannot read past conversation details: no workspace context available.',
            },
          ],
          details: undefined as unknown,
        };
      }

      try {
        const result = memoryService.read(id);

        if (!result) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Memory item not found for id: "${id}". It may have been deleted or the id is invalid.`,
              },
            ],
            details: undefined as unknown,
          };
        }

        // Security: validate workspace ownership — reject reads for entries
        // that belong to a different workspace to prevent cross-workspace leakage.
        if (!isResultInWorkspace(result, currentWorkspace)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Memory item "${id}" does not belong to the current workspace. Access denied.`,
              },
            ],
            details: undefined as unknown,
          };
        }

        return {
          content: [{ type: 'text' as const, text: formatChatReadResult(result) }],
          details: undefined as unknown,
        };
      } catch (error) {
        logError('[read_workspace_chat] Read failed:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'Memory read encountered an error. The item could not be retrieved. ' +
                'You can try searching again or proceed without this context.',
            },
          ],
          details: undefined as unknown,
        };
      }
    },
  };

  return [searchTool, readTool];
}
