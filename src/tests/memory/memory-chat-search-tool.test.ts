import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceChatSearchTools } from '../../main/memory/memory-chat-search-tool';
import type { MemoryService } from '../../main/memory/memory-service';
import type { MemoryReadResult, MemorySearchResult } from '../../main/memory/memory-types';

function createMockMemoryService(overrides?: Partial<MemoryService>): MemoryService {
  return {
    search: vi.fn().mockReturnValue([]),
    read: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as MemoryService;
}

function makeSearchResult(overrides?: Partial<MemorySearchResult>): MemorySearchResult {
  return {
    id: 'exp_chunk::chunk-1',
    recordId: 'chunk-1',
    kind: 'experience_chunk',
    title: 'Test chunk',
    summary: 'A test summary',
    contentPreview: 'preview text',
    score: 0.8,
    createdAt: Date.now(),
    sourceWorkspace: '/Users/test/project-a',
    sourceSessionId: 'session-1',
    sourceSessionTitle: 'Test session',
    ...overrides,
  };
}

function makeReadResult(overrides?: Partial<MemoryReadResult>): MemoryReadResult {
  return {
    ...makeSearchResult(),
    rawText: 'user: hello\nassistant: hi there',
    details: 'Detailed information about the chunk',
    ...overrides,
  };
}

describe('memory-chat-search-tool workspace isolation', () => {
  describe('search_workspace_chats', () => {
    it('refuses to search when no workspace context is available', async () => {
      const service = createMockMemoryService();
      const tools = createWorkspaceChatSearchTools(service, undefined);
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      const result = await searchTool.execute(
        'call-1',
        { query: 'test' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('no workspace context available');
      expect(service.search).not.toHaveBeenCalled();
    });

    it('always uses workspace scope when workspace is available', async () => {
      const service = createMockMemoryService({
        search: vi.fn().mockReturnValue([makeSearchResult()]),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      await searchTool.execute(
        'call-1',
        { query: 'auth flow' },
        undefined,
        undefined,
        undefined as never
      );

      expect(service.search).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'workspace',
          sourceWorkspace: '/Users/test/project-a',
        })
      );
    });

    it('never searches with scope "all"', async () => {
      const service = createMockMemoryService();
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      await searchTool.execute(
        'call-1',
        { query: 'anything' },
        undefined,
        undefined,
        undefined as never
      );

      if ((service.search as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const callArgs = (service.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(callArgs.scope).not.toBe('all');
      }
    });

    it('returns formatted results for valid workspace search', async () => {
      const service = createMockMemoryService({
        search: vi
          .fn()
          .mockReturnValue([
            makeSearchResult({ id: 'exp_chunk::c1', title: 'Auth discussion' }),
            makeSearchResult({ id: 'exp_chunk::c2', title: 'DB migration' }),
          ]),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      const result = await searchTool.execute(
        'call-1',
        { query: 'auth' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('Found 2 relevant result(s)');
      expect(text).toContain('Auth discussion');
      expect(text).toContain('DB migration');
    });

    it('returns empty message when no results found', async () => {
      const service = createMockMemoryService({ search: vi.fn().mockReturnValue([]) });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      const result = await searchTool.execute(
        'call-1',
        { query: 'nonexistent' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('No relevant past conversations found');
    });
  });

  describe('read_workspace_chat', () => {
    it('refuses to read when no workspace context is available', async () => {
      const service = createMockMemoryService();
      const tools = createWorkspaceChatSearchTools(service, undefined);
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'exp_chunk::c1' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('no workspace context available');
      expect(service.read).not.toHaveBeenCalled();
    });

    it('denies access to entries from a different workspace', async () => {
      const service = createMockMemoryService({
        read: vi
          .fn()
          .mockReturnValue(makeReadResult({ sourceWorkspace: '/Users/test/OTHER-project' })),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'exp_chunk::c1' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('does not belong to the current workspace');
      expect(text).toContain('Access denied');
    });

    it('allows reading entries from the same workspace', async () => {
      const service = createMockMemoryService({
        read: vi.fn().mockReturnValue(
          makeReadResult({
            sourceWorkspace: '/Users/test/project-a',
            title: 'Auth flow decision',
            details: 'We decided to use JWT',
          })
        ),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'exp_chunk::c1' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('Auth flow decision');
      expect(text).toContain('We decided to use JWT');
      expect(text).not.toContain('Access denied');
    });

    it('denies access to core memory entries (strict workspace-only policy)', async () => {
      const service = createMockMemoryService({
        read: vi.fn().mockReturnValue(
          makeReadResult({
            kind: 'core',
            sourceWorkspace: null,
            title: 'User prefers TypeScript',
          })
        ),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'core::pref' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      // Core memory is passively injected — workspace tools should not serve it
      expect(text).toContain('Access denied');
    });

    it('returns not-found for invalid ids', async () => {
      const service = createMockMemoryService({ read: vi.fn().mockReturnValue(null) });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'bogus-id' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('Memory item not found');
    });
  });

  describe('output bounding', () => {
    it('truncates large details fields', async () => {
      const largeDetails = 'x'.repeat(5000);
      const service = createMockMemoryService({
        read: vi.fn().mockReturnValue(
          makeReadResult({
            sourceWorkspace: '/Users/test/project-a',
            details: largeDetails,
          })
        ),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'exp_chunk::c1' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('[...truncated]');
      expect(text.length).toBeLessThan(largeDetails.length);
    });

    it('truncates large rawText fields', async () => {
      const largeRawText = 'y'.repeat(6000);
      const service = createMockMemoryService({
        read: vi.fn().mockReturnValue(
          makeReadResult({
            sourceWorkspace: '/Users/test/project-a',
            rawText: largeRawText,
          })
        ),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'exp_chunk::c1' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('[...truncated]');
      expect(text.length).toBeLessThan(largeRawText.length);
    });
  });

  describe('response-level workspace isolation (defense in depth)', () => {
    it('filters out foreign-workspace results from search output', async () => {
      const service = createMockMemoryService({
        search: vi.fn().mockReturnValue([
          makeSearchResult({
            id: 'c1',
            title: 'Same workspace',
            sourceWorkspace: '/Users/test/project-a',
          }),
          makeSearchResult({
            id: 'c2',
            title: 'Foreign workspace',
            sourceWorkspace: '/Users/test/OTHER-project',
          }),
          makeSearchResult({
            id: 'c3',
            title: 'Also same',
            sourceWorkspace: '/Users/test/project-a',
          }),
        ]),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      const result = await searchTool.execute(
        'call-1',
        { query: 'test' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('Same workspace');
      expect(text).toContain('Also same');
      expect(text).not.toContain('Foreign workspace');
      expect(text).toContain('Found 2 relevant result(s)');
    });

    it('handles workspace normalization differences (trailing slash)', async () => {
      // Stored with trailing slash, session cwd without
      const service = createMockMemoryService({
        read: vi
          .fn()
          .mockReturnValue(makeReadResult({ sourceWorkspace: '/Users/test/project-a/' })),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'exp_chunk::c1' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      // normalizeWorkspaceKey uses path.resolve which strips trailing slashes
      expect(text).not.toContain('Access denied');
    });

    it('returns empty when all search results are from foreign workspaces', async () => {
      const service = createMockMemoryService({
        search: vi
          .fn()
          .mockReturnValue([
            makeSearchResult({ sourceWorkspace: '/Users/test/OTHER' }),
            makeSearchResult({ sourceWorkspace: '/Users/test/ANOTHER' }),
          ]),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      const result = await searchTool.execute(
        'call-1',
        { query: 'test' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('No relevant past conversations found');
    });

    it('filters out core entries from search results (strict workspace-only)', async () => {
      const service = createMockMemoryService({
        search: vi.fn().mockReturnValue([
          makeSearchResult({ id: 'c1', kind: 'core', title: 'Core pref', sourceWorkspace: null }),
          makeSearchResult({
            id: 'c2',
            kind: 'experience_chunk',
            title: 'Workspace chunk',
            sourceWorkspace: '/Users/test/project-a',
          }),
        ]),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      const result = await searchTool.execute(
        'call-1',
        { query: 'test' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).not.toContain('Core pref');
      expect(text).toContain('Workspace chunk');
      expect(text).toContain('Found 1 relevant result(s)');
    });
  });

  describe('error handling (graceful failure)', () => {
    it('returns safe error message when search throws', async () => {
      const service = createMockMemoryService({
        search: vi.fn().mockImplementation(() => {
          throw new Error('Corrupt index file');
        }),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      const result = await searchTool.execute(
        'call-1',
        { query: 'test' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('encountered an error');
      expect(text).not.toContain('Corrupt index file'); // No internal details leaked
    });

    it('returns safe error message when read throws', async () => {
      const service = createMockMemoryService({
        read: vi.fn().mockImplementation(() => {
          throw new Error('JSON parse failure');
        }),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const readTool = tools.find((t) => t.name === 'read_workspace_chat')!;

      const result = await readTool.execute(
        'call-1',
        { id: 'exp_chunk::c1' },
        undefined,
        undefined,
        undefined as never
      );
      const text = (result.content as Array<{ text: string }>)[0].text;

      expect(text).toContain('encountered an error');
      expect(text).not.toContain('JSON parse failure'); // No internal details leaked
    });

    it('does not throw from execute even on unexpected errors', async () => {
      const service = createMockMemoryService({
        search: vi.fn().mockImplementation(() => {
          throw new TypeError('Cannot read properties of null');
        }),
      });
      const tools = createWorkspaceChatSearchTools(service, '/Users/test/project-a');
      const searchTool = tools.find((t) => t.name === 'search_workspace_chats')!;

      // Should not throw — returns graceful error response
      await expect(
        searchTool.execute('call-1', { query: 'test' }, undefined, undefined, undefined as never)
      ).resolves.toBeDefined();
    });
  });
});
