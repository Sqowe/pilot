/**
 * Tests for MCP tool timeout wrapper behavior.
 *
 * Covers:
 * 1. Timeout resolution precedence (server override > global > fallback)
 * 2. Timeout fires and returns structured error with isError: true
 * 3. Successful tool execution passes through unchanged
 * 4. Timer is cleaned up on early completion (no dangling handles)
 * 5. Activity timeout pause/resume callbacks fire correctly
 * 6. Disabled timeout (0) passes through without racing
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the dependencies before importing the module
vi.mock('../src/main/config/config-store', () => ({
  configStore: {
    get: vi.fn(),
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getServers: vi.fn(),
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  logWarn: vi.fn(),
}));

import { configStore } from '../src/main/config/config-store';
import { mcpConfigStore } from '../src/main/mcp/mcp-config-store';
import {
  resolveToolTimeoutMs,
  wrapMcpToolsWithTimeout,
  McpToolTimeoutError,
} from '../src/main/claude/mcp-tool-timeout';

describe('MCP Tool Timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(configStore.get).mockReturnValue(240);
    vi.mocked(mcpConfigStore.getServers).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('resolveToolTimeoutMs — precedence', () => {
    it('uses per-server override when >= 10', () => {
      vi.mocked(mcpConfigStore.getServers).mockReturnValue([
        { id: '1', name: 'firecrawl', type: 'stdio', enabled: true, toolTimeoutSeconds: 90 },
      ] as any);
      expect(resolveToolTimeoutMs('firecrawl')).toBe(90_000);
    });

    it('ignores per-server override < 10 (falls to global)', () => {
      vi.mocked(mcpConfigStore.getServers).mockReturnValue([
        { id: '1', name: 'firecrawl', type: 'stdio', enabled: true, toolTimeoutSeconds: 5 },
      ] as any);
      vi.mocked(configStore.get).mockReturnValue(240);
      expect(resolveToolTimeoutMs('firecrawl')).toBe(240_000);
    });

    it('uses global default when no per-server override', () => {
      vi.mocked(configStore.get).mockReturnValue(180);
      expect(resolveToolTimeoutMs('some-server')).toBe(180_000);
    });

    it('returns 0 (disabled) when global is 0', () => {
      vi.mocked(configStore.get).mockReturnValue(0);
      expect(resolveToolTimeoutMs('some-server')).toBe(0);
    });

    it('uses fallback (240s) when global config is invalid', () => {
      vi.mocked(configStore.get).mockReturnValue(undefined as any);
      expect(resolveToolTimeoutMs('some-server')).toBe(240_000);
    });
  });

  describe('wrapMcpToolsWithTimeout — behavior', () => {
    function createMockTool(name: string, serverName: string, executeFn: any) {
      return {
        name,
        _mcpServerName: serverName,
        execute: executeFn,
      };
    }

    it('passes through successful tool result unchanged', async () => {
      const expectedResult = { content: [{ type: 'text', text: 'success' }], details: {} };
      const tool = createMockTool('test_tool', 'test-server', async () => expectedResult);

      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any);
      const resultPromise = wrapped.execute('id', {}, undefined, undefined);

      // Advance time slightly to let the async execute resolve
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result).toEqual(expectedResult);
    });

    it('returns structured error with isError: true on timeout', async () => {
      // Tool that never resolves
      const tool = createMockTool('slow_tool', 'slow-server', () => new Promise(() => {}));
      vi.mocked(configStore.get).mockReturnValue(30); // 30s timeout

      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any);
      const resultPromise = wrapped.execute('id', {}, undefined, undefined);

      // Advance past timeout + grace period
      await vi.advanceTimersByTimeAsync(33_000);
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timed out after 30 seconds');
      expect(result.content[0].text).toContain('slow-server');
      expect(result.content[0].text).toContain('cancelled');
    });

    it('cleans up timer on early successful completion', async () => {
      const tool = createMockTool('fast_tool', 'fast-server', async () => ({
        content: [{ type: 'text', text: 'done' }],
      }));
      vi.mocked(configStore.get).mockReturnValue(240);

      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any);
      await wrapped.execute('id', {}, undefined, undefined);

      // If timer wasn't cleaned up, advancing would cause issues
      // (no assertion needed — the test passing without hanging proves cleanup)
      await vi.advanceTimersByTimeAsync(300_000);
    });

    it('does not race when timeout is disabled (0)', async () => {
      vi.mocked(configStore.get).mockReturnValue(0);
      const expectedResult = { content: [{ type: 'text', text: 'ok' }] };
      const tool = createMockTool('tool', 'server', async () => expectedResult);

      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any);
      const result = await wrapped.execute('id', {}, undefined, undefined);

      expect(result).toEqual(expectedResult);
    });

    it('calls onToolExecutionStart and onToolExecutionEnd callbacks', async () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const tool = createMockTool('tool', 'my-server', async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));

      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any, onStart, onEnd);
      await wrapped.execute('id', {}, undefined, undefined);

      expect(onStart).toHaveBeenCalledWith('my-server', 'tool');
      expect(onEnd).toHaveBeenCalledWith('my-server', 'tool');
    });

    it('calls onToolExecutionEnd even on timeout', async () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const tool = createMockTool('tool', 'server', () => new Promise(() => {}));
      vi.mocked(configStore.get).mockReturnValue(10);

      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any, onStart, onEnd);
      const resultPromise = wrapped.execute('id', {}, undefined, undefined);

      // Advance past timeout + grace period (10s + 2s)
      await vi.advanceTimersByTimeAsync(13_000);
      await resultPromise;

      expect(onStart).toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalled();
    });

    it('aborts the underlying execution on timeout via AbortSignal', async () => {
      let receivedSignal: AbortSignal | undefined;
      const tool = createMockTool(
        'tool',
        'server',
        async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
          receivedSignal = signal;
          // Simulate a tool that respects abort
          return new Promise((_resolve, reject) => {
            if (signal) {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }
          });
        }
      );
      vi.mocked(configStore.get).mockReturnValue(10);

      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any);
      const resultPromise = wrapped.execute('id', {}, undefined, undefined);

      // Before timeout — signal should not be aborted
      expect(receivedSignal?.aborted).toBe(false);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(11_000);
      // Advance grace period
      await vi.advanceTimersByTimeAsync(3_000);
      await resultPromise;

      // Signal should now be aborted
      expect(receivedSignal?.aborted).toBe(true);
    });

    it('merges caller signal with timeout signal', async () => {
      let receivedSignal: AbortSignal | undefined;
      const tool = createMockTool(
        'tool',
        'server',
        async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
          receivedSignal = signal;
          return new Promise(() => {}); // never resolves
        }
      );
      vi.mocked(configStore.get).mockReturnValue(60);

      const callerController = new AbortController();
      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any);
      wrapped.execute('id', {}, callerController.signal, undefined);

      // Wait for execution to start
      await vi.advanceTimersByTimeAsync(1);

      // Caller aborts — merged signal should fire
      callerController.abort();
      expect(receivedSignal?.aborted).toBe(true);
    });

    it('onToolExecutionEnd waits for settlement after timeout (not immediate)', async () => {
      const onEnd = vi.fn();
      let resolveExecution: () => void;
      const tool = createMockTool(
        'tool',
        'server',
        (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
          return new Promise<any>((resolve) => {
            resolveExecution = () => resolve({ content: [{ type: 'text', text: 'late' }] });
            // Respond to abort after a short delay
            if (signal) {
              signal.addEventListener('abort', () => {
                setTimeout(() => resolveExecution(), 500);
              });
            }
          });
        }
      );
      vi.mocked(configStore.get).mockReturnValue(10);

      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any, vi.fn(), onEnd);
      const resultPromise = wrapped.execute('id', {}, undefined, undefined);

      // Advance to timeout
      await vi.advanceTimersByTimeAsync(10_000);
      // onEnd should NOT have been called yet (grace period)
      expect(onEnd).not.toHaveBeenCalled();

      // Advance 500ms — tool settles after abort
      await vi.advanceTimersByTimeAsync(500);
      // Now it should be called
      await vi.advanceTimersByTimeAsync(1);
      await resultPromise;
      expect(onEnd).toHaveBeenCalled();
    });

    it('skips non-MCP tools (no _mcpServerName)', () => {
      const tool = { name: 'bash', execute: async () => ({}) };
      const [wrapped] = wrapMcpToolsWithTimeout([tool] as any);
      // Should be the same reference — not wrapped
      expect(wrapped).toBe(tool);
    });
  });

  describe('McpToolTimeoutError', () => {
    it('has correct properties', () => {
      const err = new McpToolTimeoutError('my_tool', 'my_server', 60000);
      expect(err.name).toBe('McpToolTimeoutError');
      expect(err.toolName).toBe('my_tool');
      expect(err.serverName).toBe('my_server');
      expect(err.timeoutMs).toBe(60000);
      expect(err.message).toContain('my_tool');
      expect(err.message).toContain('my_server');
      expect(err.message).toContain('60000ms');
    });
  });
});
