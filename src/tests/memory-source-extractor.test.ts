import { describe, expect, it } from 'vitest';
import {
  extractMemorySources,
  hasMemoryToolUsage,
} from '../renderer/utils/memory-source-extractor';
import type { ContentBlock } from '../renderer/types';

function makeToolUse(name: string, id: string): ContentBlock {
  return { type: 'tool_use', id, name, input: { query: 'test' } } as ContentBlock;
}

function makeToolResult(toolUseId: string, content: string, isError = false): ContentBlock {
  return { type: 'tool_result', toolUseId, content, isError } as ContentBlock;
}

function makeStructuredToolResult(toolUseId: string, textBlocks: string[]): ContentBlock {
  // Simulate structured content (array of text blocks)
  const content = textBlocks.map((text) => ({ type: 'text', text })) as unknown;
  return { type: 'tool_result', toolUseId, content, isError: false } as ContentBlock;
}

const SEARCH_RESULT_TEXT = `Found 2 relevant result(s) from past workspace conversations:

1. [experience_chunk] "Auth flow discussion"
   id: exp_chunk::c1
   summary: We decided to use JWT tokens for auth
   session: Session about authentication

2. [experience_chunk] "DB migration plan"
   id: exp_chunk::c2
   summary: Planned migration to PostgreSQL
   keywords: postgres, migration

Use read_workspace_chat with the id to get full details on any result.`;

const READ_RESULT_TEXT = `## Auth flow discussion
type: experience_chunk
summary: We decided to use JWT tokens for authentication
session: Auth session

### Details
Detailed discussion about JWT vs session cookies`;

describe('memory-source-extractor', () => {
  describe('extractMemorySources', () => {
    it('extracts sources from search_workspace_chats results', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeToolResult('tu-1', SEARCH_RESULT_TEXT),
        { type: 'text', text: 'Based on your past conversations...' } as ContentBlock,
      ];

      const sources = extractMemorySources(blocks);

      expect(sources).toHaveLength(2);
      expect(sources[0].title).toBe('Auth flow discussion');
      expect(sources[0].summary).toBe('We decided to use JWT tokens for auth');
      expect(sources[1].title).toBe('DB migration plan');
      expect(sources[1].summary).toBe('Planned migration to PostgreSQL');
    });

    it('extracts sources from read_workspace_chat results', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('read_workspace_chat', 'tu-1'),
        makeToolResult('tu-1', READ_RESULT_TEXT),
      ];

      const sources = extractMemorySources(blocks);

      expect(sources).toHaveLength(1);
      expect(sources[0].title).toBe('Auth flow discussion');
      expect(sources[0].summary).toBe('We decided to use JWT tokens for authentication');
    });

    it('handles structured tool_result content (array of text blocks)', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeStructuredToolResult('tu-1', [SEARCH_RESULT_TEXT]),
      ];

      const sources = extractMemorySources(blocks);

      expect(sources).toHaveLength(2);
      expect(sources[0].title).toBe('Auth flow discussion');
    });

    it('deduplicates results by title', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeToolResult('tu-1', SEARCH_RESULT_TEXT),
        makeToolUse('read_workspace_chat', 'tu-2'),
        makeToolResult('tu-2', READ_RESULT_TEXT), // Same title as search result #1
      ];

      const sources = extractMemorySources(blocks);

      // "Auth flow discussion" appears in both search and read, should be deduped
      const authSources = sources.filter((s) => s.title === 'Auth flow discussion');
      expect(authSources).toHaveLength(1);
    });

    it('returns empty array when no memory tools are used', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('bash', 'tu-1'),
        makeToolResult('tu-1', 'command output'),
        { type: 'text', text: 'Hello world' } as ContentBlock,
      ];

      expect(extractMemorySources(blocks)).toHaveLength(0);
    });

    it('skips error results', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeToolResult('tu-1', 'some error', true),
      ];

      expect(extractMemorySources(blocks)).toHaveLength(0);
    });

    it('skips "no results found" responses', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeToolResult('tu-1', 'No relevant past conversations found in this workspace for: "xyz"'),
      ];

      expect(extractMemorySources(blocks)).toHaveLength(0);
    });

    it('skips "no workspace context" responses', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeToolResult('tu-1', 'Cannot search: no workspace context available.'),
      ];

      expect(extractMemorySources(blocks)).toHaveLength(0);
    });

    it('skips "encountered an error" responses', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeToolResult('tu-1', 'Memory search encountered an error.'),
      ];

      expect(extractMemorySources(blocks)).toHaveLength(0);
    });

    it('correctly pairs titles with their summaries in single pass', () => {
      const text = `Found 3 relevant result(s):

1. [experience_chunk] "First topic"
   id: c1
   summary: Summary for first

2. [experience_session] "Second topic"
   id: c2

3. [experience_chunk] "Third topic"
   id: c3
   summary: Summary for third`;

      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeToolResult('tu-1', text),
      ];

      const sources = extractMemorySources(blocks);

      expect(sources).toHaveLength(3);
      expect(sources[0]).toEqual({ title: 'First topic', summary: 'Summary for first' });
      expect(sources[1]).toEqual({ title: 'Second topic', summary: undefined });
      expect(sources[2]).toEqual({ title: 'Third topic', summary: 'Summary for third' });
    });
  });

  describe('hasMemoryToolUsage', () => {
    it('returns true when search_workspace_chats is present', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('search_workspace_chats', 'tu-1'),
        makeToolResult('tu-1', 'results'),
      ];
      expect(hasMemoryToolUsage(blocks)).toBe(true);
    });

    it('returns true when read_workspace_chat is present', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('read_workspace_chat', 'tu-1'),
        makeToolResult('tu-1', 'results'),
      ];
      expect(hasMemoryToolUsage(blocks)).toBe(true);
    });

    it('returns false when no memory tools are present', () => {
      const blocks: ContentBlock[] = [
        makeToolUse('bash', 'tu-1'),
        { type: 'text', text: 'hello' } as ContentBlock,
      ];
      expect(hasMemoryToolUsage(blocks)).toBe(false);
    });

    it('returns false for empty blocks', () => {
      expect(hasMemoryToolUsage([])).toBe(false);
    });
  });
});
