/**
 * MCP Tool Timeout Wrapper
 *
 * Wraps MCP tool execute() functions with a configurable timeout.
 * When a tool exceeds its timeout, the wrapper:
 * 1. Aborts the underlying MCP call via AbortController
 * 2. Waits briefly for the call to settle (2s grace period)
 * 3. Returns a structured error result (isError: true) to the LLM
 *
 * This allows the LLM to decide whether to retry, skip, or try a different
 * approach — instead of aborting the entire agent.
 *
 * Timeout resolution order:
 * 1. Per-server override (MCPServerConfig.toolTimeoutSeconds)
 * 2. Global default (AppConfig.mcpToolTimeoutSeconds)
 * 3. Hardcoded fallback (240 seconds)
 */

import { configStore } from '../config/config-store';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import { logWarn } from '../utils/logger';

/** Hardcoded fallback if config is somehow missing */
const FALLBACK_TIMEOUT_MS = 240_000;

/** Grace period to wait for underlying execution to settle after abort */
const ABORT_GRACE_MS = 2000;

/**
 * Resolve the effective timeout in milliseconds for a given MCP server.
 * Returns 0 if timeout is disabled (not recommended).
 */
export function resolveToolTimeoutMs(serverName: string): number {
  // 1. Check per-server override
  const servers = mcpConfigStore.getServers();
  const serverConfig = servers.find((s) => s.name === serverName);
  if (serverConfig?.toolTimeoutSeconds && serverConfig.toolTimeoutSeconds >= 10) {
    return serverConfig.toolTimeoutSeconds * 1000;
  }

  // 2. Global default from config
  const globalTimeout = configStore.get('mcpToolTimeoutSeconds');
  if (typeof globalTimeout === 'number' && globalTimeout > 0) {
    return globalTimeout * 1000;
  }

  // 3. If global is 0 (disabled), return 0 (no timeout)
  if (globalTimeout === 0) return 0;

  // 4. Fallback
  return FALLBACK_TIMEOUT_MS;
}

/**
 * Build the timeout error message returned to the LLM when a tool times out.
 */
function buildTimeoutErrorMessage(serverName: string, timeoutMs: number): string {
  const timeoutSec = Math.round(timeoutMs / 1000);
  return (
    `Tool execution timed out after ${timeoutSec} seconds. ` +
    `The MCP server "${serverName}" did not respond in time. ` +
    `The operation was cancelled. ` +
    `You should try a different approach or retry with simpler parameters.`
  );
}

export interface ToolDefinition {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  _mcpServerName?: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx?: unknown
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
  [key: string]: unknown;
}

/**
 * Wrap MCP tool definitions with per-server timeout logic.
 * Tools whose timeout fires are aborted and return a structured error to the LLM.
 *
 * On timeout:
 * 1. The underlying execution is aborted via AbortController
 * 2. A 2s grace period allows the execution to settle/cleanup
 * 3. onToolExecutionEnd is called only after settlement (or grace expiry)
 *
 * @param tools - MCP tool definitions (must have _mcpServerName)
 * @param onToolExecutionStart - Callback when tool starts (for activity timeout pause)
 * @param onToolExecutionEnd - Callback when tool truly finishes (for activity timeout resume)
 */
export function wrapMcpToolsWithTimeout(
  tools: ToolDefinition[],
  onToolExecutionStart?: (serverName: string, toolName: string) => void,
  onToolExecutionEnd?: (serverName: string, toolName: string) => void
): ToolDefinition[] {
  return tools.map((tool) => {
    const serverName = tool._mcpServerName;
    if (!serverName) return tool; // Not an MCP tool — skip

    const originalExecute = tool.execute;

    return {
      ...tool,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: ((update: unknown) => void) | undefined,
        ctx?: unknown
      ) => {
        const timeoutMs = resolveToolTimeoutMs(serverName);

        // Notify caller that tool execution started (for activity timeout pause)
        if (onToolExecutionStart) onToolExecutionStart(serverName, tool.name);

        // Create an AbortController for timeout cancellation.
        // The merged signal fires on either caller abort OR our timeout.
        const timeoutController = new AbortController();
        const mergedSignal = signal
          ? mergeAbortSignals(signal, timeoutController.signal)
          : timeoutController.signal;

        // Track whether the underlying execution has settled
        let executionSettled = false;
        const executionPromise = originalExecute(
          toolCallId,
          params,
          mergedSignal,
          onUpdate,
          ctx
        ).finally(() => {
          executionSettled = true;
        });

        try {
          // If timeout is disabled (0), just await normally
          if (timeoutMs === 0) {
            return await executionPromise;
          }

          // Race between tool execution and timeout.
          // Timer is always cleaned up via finally to prevent dangling handles.
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              executionPromise,
              new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(new McpToolTimeoutError(tool.name, serverName, timeoutMs));
                }, timeoutMs);
              }),
            ]);
            return result;
          } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          }
        } catch (err: unknown) {
          if (err instanceof McpToolTimeoutError) {
            // Abort the underlying MCP call to stop resource consumption
            timeoutController.abort();

            // Wait for the underlying execution to settle after abort.
            // Grace period prevents onToolExecutionEnd from firing while
            // the tool is still cleaning up.
            if (!executionSettled) {
              await Promise.race([
                executionPromise.catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS)),
              ]);
            }

            logWarn(
              `[McpToolTimeout] Tool "${tool.name}" (server: ${serverName}) timed out after ${timeoutMs}ms`
            );
            return {
              content: [
                { type: 'text' as const, text: buildTimeoutErrorMessage(serverName, timeoutMs) },
              ],
              details: undefined as unknown,
              isError: true,
            };
          }
          throw err;
        } finally {
          // Notify caller that tool execution ended.
          // On normal completion: execution already settled.
          // On timeout: we waited for settlement (or grace period expired).
          // This ensures toolExecutionCount accurately reflects real lifecycle.
          if (onToolExecutionEnd) onToolExecutionEnd(serverName, tool.name);
        }
      },
    } as ToolDefinition;
  });
}

/**
 * Merge two AbortSignals into one that fires when either fires.
 */
function mergeAbortSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
  if (signal1.aborted) return signal1;
  if (signal2.aborted) return signal2;

  const controller = new AbortController();
  const onAbort = () => controller.abort();

  signal1.addEventListener('abort', onAbort, { once: true });
  signal2.addEventListener('abort', onAbort, { once: true });

  controller.signal.addEventListener(
    'abort',
    () => {
      signal1.removeEventListener('abort', onAbort);
      signal2.removeEventListener('abort', onAbort);
    },
    { once: true }
  );

  return controller.signal;
}

/**
 * Custom error class for MCP tool timeouts.
 * Used internally to distinguish timeout from other errors in the catch block.
 */
export class McpToolTimeoutError extends Error {
  public readonly toolName: string;
  public readonly serverName: string;
  public readonly timeoutMs: number;

  constructor(toolName: string, serverName: string, timeoutMs: number) {
    super(`MCP tool "${toolName}" (server: ${serverName}) timed out after ${timeoutMs}ms`);
    this.name = 'McpToolTimeoutError';
    this.toolName = toolName;
    this.serverName = serverName;
    this.timeoutMs = timeoutMs;
  }
}
