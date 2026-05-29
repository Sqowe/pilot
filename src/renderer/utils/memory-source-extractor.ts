/**
 * Extracts memory source information from assistant message content blocks.
 * Detects when search_workspace_chats / read_workspace_chat tools were used
 * and parses the results to build a list of referenced past conversations.
 */
import type { ContentBlock, ToolUseContent, ToolResultContent } from '../types';
import type { MemorySource } from '../types';

const MEMORY_SEARCH_TOOL = 'search_workspace_chats';
const MEMORY_READ_TOOL = 'read_workspace_chat';

/**
 * Normalize tool_result content to a plain string.
 * Handles both string content and structured content (array of text blocks).
 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    // Handle array of content blocks: [{ type: 'text', text: '...' }, ...]
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text: unknown }).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    return String((content as { text: unknown }).text);
  }
  return '';
}

/**
 * Parse search results from a tool_result content string.
 * Uses a single-pass per-result block parser to correctly pair titles with summaries.
 */
function parseSearchResults(resultText: string): MemorySource[] {
  const sources: MemorySource[] = [];
  const lines = resultText.split('\n');

  let currentTitle: string | null = null;
  let currentSummary: string | null = null;

  for (const line of lines) {
    // Match result title: `1. [experience_chunk] "Title here"`
    const titleMatch = line.match(/^\d+\.\s+\[[\w_]+\]\s+"([^"]+)"/);
    if (titleMatch) {
      // Flush previous result if any
      if (currentTitle) {
        sources.push({
          title: currentTitle,
          summary: currentSummary?.slice(0, 80) || undefined,
        });
      }
      currentTitle = titleMatch[1];
      currentSummary = null;
      continue;
    }

    // Match summary line (belongs to current result)
    const summaryMatch = line.match(/^\s+summary:\s+(.+)/);
    if (summaryMatch && currentTitle) {
      currentSummary = summaryMatch[1];
    }
  }

  // Flush last result
  if (currentTitle) {
    sources.push({
      title: currentTitle,
      summary: currentSummary?.slice(0, 80) || undefined,
    });
  }

  return sources;
}

/**
 * Parse a read result to extract the title.
 */
function parseReadResult(resultText: string): MemorySource | null {
  // Match: ## Title
  const titleMatch = resultText.match(/^##\s+(.+)$/m);
  const summaryMatch = resultText.match(/^summary:\s+(.+)$/m);
  if (titleMatch) {
    return {
      title: titleMatch[1],
      summary: summaryMatch?.[1]?.slice(0, 80) || undefined,
    };
  }
  return null;
}

/**
 * Extract memory sources from a message's content blocks.
 * Returns an array of MemorySource objects representing past conversations
 * that were referenced via the workspace chat search tools.
 */
export function extractMemorySources(contentBlocks: ContentBlock[]): MemorySource[] {
  const sources: MemorySource[] = [];
  const seenTitles = new Set<string>();

  // Find all search_workspace_chats and read_workspace_chat tool uses
  const toolUses = contentBlocks.filter(
    (b) =>
      b.type === 'tool_use' &&
      ((b as ToolUseContent).name === MEMORY_SEARCH_TOOL ||
        (b as ToolUseContent).name === MEMORY_READ_TOOL)
  ) as ToolUseContent[];

  if (toolUses.length === 0) {
    return [];
  }

  // Find matching tool_results for each tool_use
  for (const toolUse of toolUses) {
    const result = contentBlocks.find(
      (b) => b.type === 'tool_result' && (b as ToolResultContent).toolUseId === toolUse.id
    ) as ToolResultContent | undefined;

    if (!result || result.isError) continue;

    const resultText = normalizeToolResultContent(result.content);
    if (!resultText) continue;
    if (resultText.includes('No relevant past conversations found')) continue;
    if (resultText.includes('no workspace context available')) continue;
    if (resultText.includes('encountered an error')) continue;

    if (toolUse.name === MEMORY_SEARCH_TOOL) {
      const parsed = parseSearchResults(resultText);
      for (const source of parsed) {
        if (!seenTitles.has(source.title)) {
          seenTitles.add(source.title);
          sources.push(source);
        }
      }
    } else if (toolUse.name === MEMORY_READ_TOOL) {
      const parsed = parseReadResult(resultText);
      if (parsed && !seenTitles.has(parsed.title)) {
        seenTitles.add(parsed.title);
        sources.push(parsed);
      }
    }
  }

  return sources;
}

/**
 * Check if any content blocks contain memory tool usage.
 * Quick check without full parsing — useful for conditional rendering.
 */
export function hasMemoryToolUsage(contentBlocks: ContentBlock[]): boolean {
  return contentBlocks.some(
    (b) =>
      b.type === 'tool_use' &&
      ((b as ToolUseContent).name === MEMORY_SEARCH_TOOL ||
        (b as ToolUseContent).name === MEMORY_READ_TOOL)
  );
}
