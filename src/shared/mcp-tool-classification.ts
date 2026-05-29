/**
 * @module shared/mcp-tool-classification
 *
 * Shared MCP tool classification logic used by both the main process
 * (permission enforcement) and the renderer (UI display).
 *
 * IMPORTANT: This is the single source of truth for read-only vs write
 * classification. Do NOT duplicate these lists elsewhere.
 */

/**
 * Prefixes that strongly indicate a tool is read-only.
 * Matched case-insensitively against the tool's short name.
 */
export const READ_ONLY_PREFIXES = [
  'get_',
  'list_',
  'search_',
  'find_',
  'fetch_',
  'query_',
  'read_',
  'describe_',
  'show_',
  'check_',
  'count_',
  'lookup_',
  'browse_',
  'view_',
  'inspect_',
  'retrieve_',
];

/**
 * Full tool names (short, without prefix) known to be read-only.
 */
export const READ_ONLY_EXACT = new Set(['ping', 'status', 'health', 'version', 'whoami', 'info']);

/**
 * Prefixes that indicate a tool performs writes/mutations.
 * If a tool matches these, it is NOT classified as read-only even if
 * it also matches a read prefix.
 */
export const WRITE_INDICATORS = [
  'create_',
  'update_',
  'delete_',
  'remove_',
  'modify_',
  'set_',
  'put_',
  'post_',
  'patch_',
  'write_',
  'execute_',
  'run_',
  'send_',
  'publish_',
  'deploy_',
  'drop_',
  'insert_',
  'upsert_',
  'mutate_',
  'trigger_',
  'invoke_',
  'submit_',
  'approve_',
  'reject_',
  'cancel_',
  'revoke_',
  'grant_',
  'assign_',
  'unassign_',
  'enable_',
  'disable_',
  'start_',
  'stop_',
  'restart_',
  'kill_',
  'terminate_',
  'capture_',
];

/**
 * Classify whether a tool (by its short name) is likely read-only.
 * This is a heuristic — users can always override via per-tool permissions.
 */
export function isToolLikelyReadOnly(shortName: string): boolean {
  const lower = shortName.toLowerCase();

  // Write indicators take priority
  if (WRITE_INDICATORS.some((prefix) => lower.startsWith(prefix))) {
    return false;
  }

  // Check read-only prefixes
  if (READ_ONLY_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }

  // Check exact matches
  if (READ_ONLY_EXACT.has(lower)) {
    return true;
  }

  // Default: unknown → not read-only (conservative)
  return false;
}

/**
 * Extract the short tool name from a full MCP prefixed name.
 * Format: mcp__<ServerName>__<toolName> → toolName
 * If not an MCP name, returns the input unchanged.
 */
export function getToolShortName(fullName: string): string {
  const parts = fullName.split('__');
  return parts.length > 2 ? parts.slice(2).join('__') : parts[parts.length - 1];
}

/**
 * Canonicalize an MCP server name for use in tool prefixes.
 * This is the single source of truth for how server names are transformed
 * into the key used in `mcp__<ServerKey>__<toolName>` tool names.
 *
 * Rules:
 * - Collapse whitespace to single underscore
 * - Collapse ALL runs of underscores (any length) to a single underscore
 *   to guarantee the server key never contains `__`, which is the MCP
 *   tool-name delimiter.
 *
 * IMPORTANT: This function MUST be used both when generating MCP tool names
 * (in mcp-manager.ts) and when resolving server configs from tool names
 * (in permission-rules-store.ts / agent-runner.ts).
 */
export function canonicalizeMcpServerName(serverName: string): string {
  return serverName
    .replace(/\s+/g, '_') // Collapse whitespace to single underscore
    .replace(/_+/g, '_'); // Collapse ALL runs of underscores to single (delimiter-safe)
}
