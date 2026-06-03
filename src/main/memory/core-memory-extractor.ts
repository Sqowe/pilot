import * as path from 'node:path';
import * as fs from 'node:fs';
import { CORE_MEMORY_UPDATE_SYSTEM_PROMPT } from './memory-prompts';
import type { MemoryLLMClientLike } from './memory-llm-client';
import type { CoreMemoryActionInput, MemoryTranscriptTurn } from './memory-types';
import { compactTranscript, extractJson } from './memory-utils';

/**
 * Load a custom extraction prompt from a file path, falling back to the built-in default.
 * Enforces a maximum file size of 32KB to prevent oversized LLM requests.
 */
function loadExtractionPrompt(customPath?: string): string {
  if (customPath && customPath.trim()) {
    try {
      const stats = fs.statSync(customPath.trim());
      // Reject files larger than 32KB
      if (stats.size > 32 * 1024) {
        return CORE_MEMORY_UPDATE_SYSTEM_PROMPT;
      }
      const content = fs.readFileSync(customPath.trim(), 'utf-8');
      if (content.trim()) return content.trim();
    } catch {
      // File doesn't exist or can't be read — fall back to default
    }
  }
  return CORE_MEMORY_UPDATE_SYSTEM_PROMPT;
}

export class CoreMemoryExtractor {
  constructor(
    private readonly llm: MemoryLLMClientLike,
    private readonly systemPrompt = CORE_MEMORY_UPDATE_SYSTEM_PROMPT,
    private readonly customPromptPathResolver?: () => string | undefined
  ) {}

  async extract(params: {
    sessionId: string;
    sessionDate?: string;
    turns: MemoryTranscriptTurn[];
    existingCorePromptBlock: string;
    sourceWorkspace?: string | null;
  }): Promise<CoreMemoryActionInput[]> {
    const conversationText = compactTranscript(params.turns);
    if (!conversationText.trim()) {
      return [];
    }

    const customPath = this.customPromptPathResolver?.();
    const effectivePrompt = customPath ? loadExtractionPrompt(customPath) : this.systemPrompt;

    const workspaceContext = params.sourceWorkspace
      ? `Source workspace: ${path.basename(params.sourceWorkspace) || 'project'}`
      : 'Source workspace: (no specific project)';

    const response = await this.llm.complete({
      systemPrompt: effectivePrompt,
      userPrompt: [
        'Existing core memory:',
        params.existingCorePromptBlock,
        '',
        `Session ID: ${params.sessionId}`,
        params.sessionDate ? `Session Date: ${params.sessionDate}` : '',
        workspaceContext,
        '',
        'Session transcript:',
        conversationText,
      ]
        .filter(Boolean)
        .join('\n'),
      temperature: 0,
      maxTokens: 16_000,
    });

    const payload = extractJson(response.text);
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const actions = (payload as { actions?: unknown }).actions;
    if (!Array.isArray(actions)) {
      return [];
    }

    const normalized = actions
      .map((action): CoreMemoryActionInput | null => {
        if (!action || typeof action !== 'object') {
          return null;
        }
        const input = action as {
          op?: unknown;
          category?: unknown;
          key?: unknown;
          value?: unknown;
        };
        const op = typeof input.op === 'string' ? input.op.toLowerCase().trim() : '';
        if (op !== 'add' && op !== 'update' && op !== 'upsert' && op !== 'delete') {
          return null;
        }
        const key = typeof input.key === 'string' ? input.key.trim() : '';
        if (!key) {
          return null;
        }
        return {
          op,
          category:
            typeof input.category === 'string'
              ? (input.category.trim() as CoreMemoryActionInput['category'])
              : undefined,
          key,
          value: typeof input.value === 'string' ? input.value.trim() : null,
        } satisfies CoreMemoryActionInput;
      })
      .filter((item): item is CoreMemoryActionInput => Boolean(item));

    return normalized;
  }
}
