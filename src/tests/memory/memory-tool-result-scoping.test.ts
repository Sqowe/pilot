/**
 * Tests for tool result scoping in memory ingestion.
 * Verifies that:
 * - Pinned tool results are extracted into workspace-pinned entries
 * - Non-pinned tool results are excluded from memory extraction
 * - Pinned entries don't leak across workspaces
 * - Pinned entries don't overwrite unpinned (global) entries
 * - Pinned entries from different workspaces don't merge
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CoreMemoryStore } from '../../main/memory/core-memory-store';
import {
  applyCoreMemoryActions,
  messagesToTranscriptFiltered,
  type TranscriptFilterOptions,
} from '../../main/memory/memory-utils';
import type { Message, ContentBlock } from '../../renderer/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  role: 'user' | 'assistant',
  content: ContentBlock[],
  id = `msg-${Math.random().toString(36).slice(2)}`
): Message {
  return {
    id,
    sessionId: 'test-session',
    role,
    content,
    timestamp: Date.now(),
  };
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text } as ContentBlock;
}

function toolUseBlock(
  name: string,
  input: Record<string, unknown> = {},
  id = 'tool-1'
): ContentBlock {
  return { type: 'tool_use', id, name, input } as ContentBlock;
}

function toolResultBlock(content: string, toolUseId = 'tool-1'): ContentBlock {
  return { type: 'tool_result', toolUseId, content } as ContentBlock;
}

const PINNED_PATTERNS: RegExp[] = [/^mcp__claude_cowork_memory__cowork_/];
const FILTER_OPTIONS: TranscriptFilterOptions = { pinnedToolPatterns: PINNED_PATTERNS };

// ---------------------------------------------------------------------------
// Tests: messagesToTranscriptFiltered
// ---------------------------------------------------------------------------

describe('messagesToTranscriptFiltered', () => {
  it('separates normal text from pinned tool results', () => {
    const messages: Message[] = [
      makeMessage('user', [textBlock('Tell me about this project')]),
      makeMessage('assistant', [
        toolUseBlock('mcp__claude_cowork_memory__cowork_read_memory', { workspace_path: '/foo' }),
      ]),
      makeMessage('user', [
        toolResultBlock('Project: building a messenger app for privden', 'tool-1'),
      ]),
      makeMessage('assistant', [textBlock('Based on the memory, this project is about...')]),
    ];

    const { normalTurns, pinnedTurns } = messagesToTranscriptFiltered(
      messages,
      messages,
      FILTER_OPTIONS
    );

    // Normal turns: user text only (assistant after pinned tool is tainted)
    expect(normalTurns).toHaveLength(1);
    expect(normalTurns[0].content).toBe('Tell me about this project');

    // Pinned turns: tool result content + tainted assistant response
    expect(pinnedTurns).toHaveLength(2);
    expect(pinnedTurns[0].content).toBe('Project: building a messenger app for privden');
    expect(pinnedTurns[1].content).toBe('Based on the memory, this project is about...');
  });

  it('excludes non-pinned tool results entirely', () => {
    const messages: Message[] = [
      makeMessage('user', [textBlock('Search the web for X')]),
      makeMessage('assistant', [
        toolUseBlock('mcp__firecrawl__firecrawl_search', { query: 'X' }, 'tool-2'),
      ]),
      makeMessage('user', [toolResultBlock('Found 10 results about X...', 'tool-2')]),
      makeMessage('assistant', [textBlock('Here is what I found about X from the web')]),
      makeMessage('user', [textBlock('Thanks, now something else')]),
      makeMessage('assistant', [textBlock('Sure thing')]),
    ];

    const { normalTurns, pinnedTurns } = messagesToTranscriptFiltered(
      messages,
      messages,
      FILTER_OPTIONS
    );

    // Normal: user text before tool, user text after clearing taint, assistant after clear
    expect(normalTurns).toHaveLength(3);
    expect(normalTurns[0].content).toBe('Search the web for X');
    expect(normalTurns[1].content).toBe('Thanks, now something else');
    expect(normalTurns[2].content).toBe('Sure thing');

    // Pinned: nothing (firecrawl is not pinned)
    expect(pinnedTurns).toHaveLength(0);

    // The assistant summary after non-pinned tool is excluded (not in normalTurns)
    expect(normalTurns.some((t) => t.content.includes('what I found'))).toBe(false);
  });

  it('excludes assistant response after mixed pinned and non-pinned tool results', () => {
    const messages: Message[] = [
      makeMessage('user', [textBlock('Check memory and search web')]),
      makeMessage('assistant', [
        toolUseBlock('mcp__claude_cowork_memory__cowork_read_memory', {}, 'tool-pinned'),
        toolUseBlock('mcp__firecrawl__firecrawl_search', { query: 'Y' }, 'tool-unpinned'),
      ]),
      makeMessage('user', [
        toolResultBlock('Project memory: building privden', 'tool-pinned'),
        toolResultBlock('Web results about Y: 10 items', 'tool-unpinned'),
      ]),
      makeMessage('assistant', [
        textBlock(
          'Based on your project memory and web search, here is what I found about privden and Y'
        ),
      ]),
      makeMessage('user', [textBlock('OK thanks')]),
    ];

    const { normalTurns, pinnedTurns } = messagesToTranscriptFiltered(
      messages,
      messages,
      FILTER_OPTIONS
    );

    // The pinned tool result itself goes to pinned stream
    expect(pinnedTurns.some((t) => t.content.includes('building privden'))).toBe(true);

    // The assistant response after mixed tools should be EXCLUDED (taint = excluded)
    // because non-pinned content was present — safety first
    expect(normalTurns.some((t) => t.content.includes('privden and Y'))).toBe(false);
    expect(pinnedTurns.some((t) => t.content.includes('privden and Y'))).toBe(false);

    // After taint clears with independent user message
    expect(normalTurns.some((t) => t.content.includes('OK thanks'))).toBe(true);
  });

  it('does not include tool_use inputs in pinned stream', () => {
    const messages: Message[] = [
      makeMessage('assistant', [
        toolUseBlock('mcp__claude_cowork_memory__cowork_read_memory', {
          workspace_path: '/secret',
        }),
      ]),
      makeMessage('user', [toolResultBlock('Memory content here', 'tool-1')]),
    ];

    const { pinnedTurns } = messagesToTranscriptFiltered(messages, messages, FILTER_OPTIONS);

    // Only the result, not the tool_use input
    expect(pinnedTurns).toHaveLength(1);
    expect(pinnedTurns[0].content).toBe('Memory content here');
    expect(pinnedTurns[0].content).not.toContain('/secret');
  });

  it('resolves tool_use from full messages when delta is a slice', () => {
    const fullMessages: Message[] = [
      makeMessage('assistant', [
        toolUseBlock('mcp__claude_cowork_memory__cowork_read_memory', {}, 'tool-1'),
      ]),
      makeMessage('user', [toolResultBlock('Pinned content from previous batch', 'tool-1')]),
      makeMessage('user', [textBlock('Now do something else')]),
    ];

    // Delta is only the last two messages
    const deltaMessages = fullMessages.slice(1);

    const { normalTurns, pinnedTurns } = messagesToTranscriptFiltered(
      fullMessages,
      deltaMessages,
      FILTER_OPTIONS
    );

    // Should resolve tool-1 from the full messages even though it's not in delta
    expect(pinnedTurns).toHaveLength(1);
    expect(pinnedTurns[0].content).toBe('Pinned content from previous batch');
    expect(normalTurns).toHaveLength(1);
    expect(normalTurns[0].content).toBe('Now do something else');
  });

  it('carries taint state across incremental boundaries', () => {
    // Simulate: previous batch processed the tool_use and tool_result.
    // New delta starts with the assistant summarizing the tool result.
    const fullMessages: Message[] = [
      makeMessage('user', [textBlock('Load project memory')], 'msg-1'),
      makeMessage(
        'assistant',
        [toolUseBlock('mcp__claude_cowork_memory__cowork_read_memory', {}, 'tool-1')],
        'msg-2'
      ),
      makeMessage(
        'user',
        [toolResultBlock('Project fact: building privden messenger', 'tool-1')],
        'msg-3'
      ),
      // --- previous batch ended here ---
      makeMessage(
        'assistant',
        [textBlock('According to the project memory, you are building privden messenger.')],
        'msg-4'
      ),
      makeMessage('user', [textBlock('Thanks. Now help with tests')], 'msg-5'),
      makeMessage('assistant', [textBlock('Sure, here are the tests')], 'msg-6'),
    ];

    // Delta is messages 4-6 (assistant summary + next user turn + response)
    const deltaMessages = fullMessages.slice(3);

    const { normalTurns, pinnedTurns } = messagesToTranscriptFiltered(
      fullMessages,
      deltaMessages,
      FILTER_OPTIONS
    );

    // The assistant summary should be routed to pinned (tainted from pre-delta context)
    expect(pinnedTurns).toHaveLength(1);
    expect(pinnedTurns[0].content).toContain('privden messenger');

    // User's independent message clears taint — subsequent messages go to normal
    expect(normalTurns).toHaveLength(2);
    expect(normalTurns[0].content).toBe('Thanks. Now help with tests');
    expect(normalTurns[1].content).toBe('Sure, here are the tests');
  });

  it('routes assistant response after pinned tool result into pinned stream (taint)', () => {
    const messages: Message[] = [
      makeMessage('user', [textBlock('Check the project memory')]),
      makeMessage('assistant', [
        toolUseBlock('mcp__claude_cowork_memory__cowork_read_memory', {}, 'tool-1'),
      ]),
      makeMessage('user', [
        toolResultBlock(
          'Project: building a messenger for privden. Founders: Mike + Andras.',
          'tool-1'
        ),
      ]),
      makeMessage('assistant', [
        textBlock(
          'Based on the project memory, you are building a messenger for privden with two founders.'
        ),
      ]),
      makeMessage('user', [textBlock('Now help me with something completely different')]),
      makeMessage('assistant', [textBlock('Sure, what do you need?')]),
    ];

    const { normalTurns, pinnedTurns } = messagesToTranscriptFiltered(
      messages,
      messages,
      FILTER_OPTIONS
    );

    // The assistant's summary of the tool result should be in pinned, not normal
    expect(pinnedTurns.some((t) => t.content.includes('privden'))).toBe(true);
    expect(normalTurns.some((t) => t.content.includes('privden'))).toBe(false);

    // After user sends an independent message, taint clears
    expect(normalTurns.some((t) => t.content.includes('something completely different'))).toBe(
      true
    );
    expect(normalTurns.some((t) => t.content.includes('Sure, what do you need?'))).toBe(true);
  });

  it('handles messages with mixed content blocks', () => {
    const messages: Message[] = [
      makeMessage('assistant', [
        textBlock('Let me check your project memory'),
        toolUseBlock('mcp__claude_cowork_memory__cowork_read_memory', {}, 'tool-1'),
      ]),
      makeMessage('user', [
        toolResultBlock('Project memory: likes Rust', 'tool-1'),
        textBlock('Thanks, now help me with X'),
      ]),
    ];

    const { normalTurns, pinnedTurns } = messagesToTranscriptFiltered(
      messages,
      messages,
      FILTER_OPTIONS
    );

    expect(normalTurns).toHaveLength(2);
    expect(normalTurns[0].content).toBe('Let me check your project memory');
    expect(normalTurns[1].content).toBe('Thanks, now help me with X');

    expect(pinnedTurns).toHaveLength(1);
    expect(pinnedTurns[0].content).toBe('Project memory: likes Rust');
  });
});

// ---------------------------------------------------------------------------
// Tests: applyCoreMemoryActions with workspacePinned
// ---------------------------------------------------------------------------

describe('applyCoreMemoryActions with workspacePinned', () => {
  it('namespaces pinned entries with workspace hash', () => {
    const existing = {};
    const actions = [
      {
        op: 'upsert' as const,
        category: 'interests' as const,
        key: 'project',
        value: 'privden messenger',
      },
    ];

    const { nextMemory, applied } = applyCoreMemoryActions(existing, actions, '/Users/me/tree-hu', {
      workspacePinned: true,
    });

    // The key should be namespaced
    const keys = Object.keys(nextMemory);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^interests\.project@[a-f0-9]{16}$/);
    expect(nextMemory[keys[0]].workspacePinned).toBe(true);
    expect(nextMemory[keys[0]].value).toBe('privden messenger');
    expect(applied[0].combinedKey).toBe(keys[0]);
  });

  it('does not namespace unpinned entries', () => {
    const existing = {};
    const actions = [
      { op: 'upsert' as const, category: 'preferences' as const, key: 'lang', value: 'TypeScript' },
    ];

    const { nextMemory } = applyCoreMemoryActions(existing, actions, '/workspace/a');

    expect(Object.keys(nextMemory)).toEqual(['preferences.lang']);
    expect(nextMemory['preferences.lang'].workspacePinned).toBeUndefined();
  });

  it('pinned actions do not overwrite existing unpinned entries', () => {
    const existing = {
      'interests.project': {
        value: 'user-stated global interest',
        sourceWorkspaces: ['/workspace/a', '/workspace/b'],
      },
    };
    const actions = [
      {
        op: 'upsert' as const,
        category: 'interests' as const,
        key: 'project',
        value: 'pinned tool data',
      },
    ];

    const { nextMemory } = applyCoreMemoryActions(existing, actions, '/workspace/c', {
      workspacePinned: true,
    });

    // Original unpinned entry is preserved
    expect(nextMemory['interests.project'].value).toBe('user-stated global interest');
    expect(nextMemory['interests.project'].workspacePinned).toBeUndefined();

    // Pinned entry is stored separately with namespaced key
    const pinnedKeys = Object.keys(nextMemory).filter((k) => k.includes('@'));
    expect(pinnedKeys).toHaveLength(1);
    expect(nextMemory[pinnedKeys[0]].value).toBe('pinned tool data');
    expect(nextMemory[pinnedKeys[0]].workspacePinned).toBe(true);
  });

  it('pinned entries from different workspaces do not merge', () => {
    const existing = {};
    const actions = [
      {
        op: 'upsert' as const,
        category: 'interests' as const,
        key: 'project',
        value: 'workspace A content',
      },
    ];

    const { nextMemory: afterA } = applyCoreMemoryActions(existing, actions, '/workspace/a', {
      workspacePinned: true,
    });

    const actionsB = [
      {
        op: 'upsert' as const,
        category: 'interests' as const,
        key: 'project',
        value: 'workspace B content',
      },
    ];

    const { nextMemory: afterBoth } = applyCoreMemoryActions(afterA, actionsB, '/workspace/b', {
      workspacePinned: true,
    });

    // Should have two separate pinned entries
    const pinnedKeys = Object.keys(afterBoth).filter((k) => k.includes('@'));
    expect(pinnedKeys).toHaveLength(2);

    const values = pinnedKeys.map((k) => afterBoth[k].value).sort();
    expect(values).toEqual(['workspace A content', 'workspace B content']);
  });

  it('pinned delete actions cannot delete unpinned entries', () => {
    const existing = {
      'preferences.lang': {
        value: 'TypeScript',
        sourceWorkspaces: ['/workspace/a'],
      },
    };
    const actions = [{ op: 'delete' as const, category: 'preferences' as const, key: 'lang' }];

    const { nextMemory } = applyCoreMemoryActions(existing, actions, '/workspace/b', {
      workspacePinned: true,
    });

    // Unpinned entry should survive
    expect(nextMemory['preferences.lang']).toBeDefined();
    expect(nextMemory['preferences.lang'].value).toBe('TypeScript');
  });

  it('rejects pinned actions when sourceWorkspace is null', () => {
    const existing = {};
    const actions = [
      {
        op: 'upsert' as const,
        category: 'interests' as const,
        key: 'project',
        value: 'should not be stored',
      },
    ];

    const { nextMemory, applied } = applyCoreMemoryActions(existing, actions, null, {
      workspacePinned: true,
    });

    // Nothing should be stored — no concrete workspace for pinning
    expect(Object.keys(nextMemory)).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it('preserves workspacePinned flag when applying unrelated unpinned actions', () => {
    // Start with a pinned entry
    const existing: Record<
      string,
      { value: string; sourceWorkspaces: string[]; workspacePinned?: boolean; scopeHash?: string }
    > = {
      'interests.project@abc1234567890abc': {
        value: 'privden messenger',
        sourceWorkspaces: ['/workspace/tree-hu'],
        workspacePinned: true,
        scopeHash: 'abc1234567890abc',
      },
    };

    // Apply an unrelated unpinned action
    const actions = [
      { op: 'upsert' as const, category: 'preferences' as const, key: 'lang', value: 'TypeScript' },
    ];

    const { nextMemory } = applyCoreMemoryActions(existing, actions, '/workspace/other');

    // Pinned entry must retain its workspacePinned flag
    const pinnedEntry = nextMemory['interests.project@abc1234567890abc'];
    expect(pinnedEntry).toBeDefined();
    expect(pinnedEntry.workspacePinned).toBe(true);
    expect(pinnedEntry.value).toBe('privden messenger');

    // New unpinned entry is stored normally
    expect(nextMemory['preferences.lang']).toBeDefined();
    expect(nextMemory['preferences.lang'].workspacePinned).toBeUndefined();
  });

  it('pinned entry key is stripped of @hash when read from CoreMemoryStore', () => {
    const existing = {};
    const actions = [
      { op: 'upsert' as const, category: 'interests' as const, key: 'project', value: 'privden' },
    ];

    const { applied, nextMemory } = applyCoreMemoryActions(
      existing,
      actions,
      '/workspace/tree-hu',
      { workspacePinned: true }
    );

    // The applied combinedKey has the @hash suffix (storage key)
    expect(applied[0].combinedKey).toMatch(/@[a-f0-9]{16}$/);

    // The stored entry has scopeHash metadata
    const storedEntry = nextMemory[applied[0].combinedKey];
    expect(storedEntry.scopeHash).toBeDefined();
    expect(storedEntry.workspacePinned).toBe(true);

    // When read through CoreMemoryStore.getEntries(), the key is clean
    // (tested in the CoreMemoryStore workspace-pinned filtering tests below)
  });
});

// ---------------------------------------------------------------------------
// Tests: CoreMemoryStore.getEntriesForWorkspace with workspacePinned
// ---------------------------------------------------------------------------

describe('CoreMemoryStore workspace-pinned filtering', () => {
  let filePath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mem-pin-'));
    filePath = path.join(tmpDir, 'core_memory.json');
  });

  afterEach(() => {
    const dir = path.dirname(filePath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pinned entries are only visible in their source workspace', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'interests.project@abc1234567890abc': {
          value: 'privden messenger',
          sourceWorkspaces: ['/workspace/tree-hu'],
          workspacePinned: true,
          scopeHash: 'abc1234567890abc',
        },
      })
    );

    const store = new CoreMemoryStore(filePath);

    // Visible in source workspace
    const matching = store.getEntriesForWorkspace('/workspace/tree-hu');
    expect(matching).toHaveLength(1);
    expect(matching[0].value).toBe('privden messenger');
    // User-facing key should be clean (no @hash suffix)
    expect(matching[0].key).toBe('project');
    expect(matching[0].category).toBe('interests');

    // Not visible in other workspaces
    const other = store.getEntriesForWorkspace('/workspace/gitlab');
    expect(other).toHaveLength(0);

    // Not visible with null workspace
    const nullWs = store.getEntriesForWorkspace(null);
    expect(nullWs).toHaveLength(0);
  });

  it('pinned entries with multiple workspaces are visible in each', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'skills.rust@abc1234567890abc': {
          value: 'proficient in Rust',
          sourceWorkspaces: ['/workspace/a', '/workspace/b'],
          workspacePinned: true,
          scopeHash: 'abc1234567890abc',
        },
      })
    );

    const store = new CoreMemoryStore(filePath);

    expect(store.getEntriesForWorkspace('/workspace/a')).toHaveLength(1);
    expect(store.getEntriesForWorkspace('/workspace/b')).toHaveLength(1);
    expect(store.getEntriesForWorkspace('/workspace/c')).toHaveLength(0);
  });

  it('pinned entries do NOT promote to global even with 2+ workspaces', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'interests.topic@abc1234567890abc': {
          value: 'workspace-specific topic',
          sourceWorkspaces: ['/workspace/a', '/workspace/b', '/workspace/c'],
          workspacePinned: true,
          scopeHash: 'abc1234567890abc',
        },
      })
    );

    const store = new CoreMemoryStore(filePath);

    // Should NOT be visible from an unrelated workspace
    expect(store.getEntriesForWorkspace('/workspace/d')).toHaveLength(0);
  });

  it('pinned entries with global sentinel are not visible anywhere', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'interests.something@abc1234567890abc': {
          value: 'should be unreachable',
          sourceWorkspaces: ['__global__'],
          workspacePinned: true,
          scopeHash: 'abc1234567890abc',
        },
      })
    );

    const store = new CoreMemoryStore(filePath);

    // Not visible anywhere — pinned overrides global sentinel
    expect(store.getEntriesForWorkspace(null)).toHaveLength(0);
    expect(store.getEntriesForWorkspace('/some/workspace')).toHaveLength(0);
  });

  it('unpinned entries still promote normally with 2+ workspaces', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'preferences.lang': {
          value: 'TypeScript',
          sourceWorkspaces: ['/workspace/a', '/workspace/b'],
        },
      })
    );

    const store = new CoreMemoryStore(filePath);

    // Visible from any workspace (normal global promotion)
    expect(store.getEntriesForWorkspace('/workspace/x')).toHaveLength(1);
  });
});
