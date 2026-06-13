/**
 * @module shared/mcp-tool-classification
 *
 * Shared MCP tool classification logic used by both the main process
 * (permission enforcement) and the renderer (UI display).
 *
 * IMPORTANT: This is the single source of truth for read-only vs write
 * classification. Do NOT duplicate these lists elsewhere.
 *
 * Classification strategy:
 *   1. `annotations.readOnlyHint === false` → force NOT read-only (can restrict)
 *   2. Write verbs in tool name → always NOT read-only (hard block)
 *   3. Read verbs in tool name (prefix/infix/suffix) → read-only
 *   4. Exact-match known read-only names → read-only
 *   5. Default → NOT read-only (conservative)
 *
 * Security model: MCP annotations are untrusted server hints. They can make
 * classification MORE restrictive (readOnlyHint=false blocks auto-approval)
 * but CANNOT grant auto-approval for tools that don't already pass the
 * name-based heuristic. This prevents malicious servers from marking
 * destructive tools as read-only to bypass permission prompts.
 *
 * The infix matching handles the modern MCP naming pattern where servers
 * prefix their tool names with a namespace (e.g., `openhab_list_items`,
 * `weather_get_forecast`). We detect action verbs at any underscore boundary,
 * not just at the start of the name.
 */

// ---------------------------------------------------------------------------
// MCP Tool Annotations (subset relevant to classification)
// ---------------------------------------------------------------------------

/**
 * MCP protocol ToolAnnotations (subset).
 * Mirrors the spec at modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations.
 */
export interface McpToolAnnotations {
  /** If true, the tool does not modify its environment. Default: false. */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive updates. Default: true. */
  destructiveHint?: boolean;
  /** If true, calling the tool repeatedly has no additional effect. Default: false. */
  idempotentHint?: boolean;
  /** If true, this tool may interact with an open world. Default: true. */
  openWorldHint?: boolean;
  /** Human-readable title for the tool. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Action verb lists
// ---------------------------------------------------------------------------

/**
 * Action verbs that strongly indicate a tool is read-only.
 * Matched case-insensitively against the tool's short name — both as a prefix
 * and as an infix (preceded by `_`) to handle server-namespaced tool names.
 */
export const READ_ONLY_VERBS = [
  'get',
  'list',
  'search',
  'find',
  'fetch',
  'query',
  'read',
  'describe',
  'show',
  'check',
  'count',
  'lookup',
  'browse',
  'view',
  'inspect',
  'retrieve',
];

/**
 * Full tool names (short, without prefix) known to be read-only.
 */
export const READ_ONLY_EXACT = new Set(['ping', 'status', 'health', 'version', 'whoami', 'info']);

/**
 * Action verbs that indicate a tool performs writes/mutations.
 * If a tool matches these (prefix or infix), it is NOT classified as read-only
 * even if it also matches a read verb.
 */
export const WRITE_VERBS = [
  'create',
  'update',
  'delete',
  'remove',
  'modify',
  'set',
  'put',
  'post',
  'patch',
  'write',
  'execute',
  'run',
  'send',
  'publish',
  'deploy',
  'drop',
  'insert',
  'upsert',
  'mutate',
  'trigger',
  'invoke',
  'submit',
  'approve',
  'reject',
  'cancel',
  'revoke',
  'grant',
  'assign',
  'unassign',
  'enable',
  'disable',
  'start',
  'stop',
  'restart',
  'kill',
  'terminate',
  'capture',
];

// ---------------------------------------------------------------------------
// Backward-compatible aliases (prefix arrays with trailing underscore)
// ---------------------------------------------------------------------------

/** @deprecated Use READ_ONLY_VERBS. Kept for backward compat with tests. */
export const READ_ONLY_PREFIXES = READ_ONLY_VERBS.map((v) => `${v}_`);

/** @deprecated Use WRITE_VERBS. Kept for backward compat with tests. */
export const WRITE_INDICATORS = WRITE_VERBS.map((v) => `${v}_`);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if any verb in the list matches the tool name as a prefix (`verb_...`)
 * or as an infix (`..._verb_...`).
 */
function matchesVerb(lower: string, verbs: string[]): boolean {
  for (const verb of verbs) {
    // Prefix match: tool starts with `verb_`
    if (lower.startsWith(`${verb}_`)) return true;
    // Infix match: tool contains `_verb_` at a word boundary
    if (lower.includes(`_${verb}_`)) return true;
    // Suffix match: tool ends with `_verb` (less common but valid, e.g. `items_list`)
    if (lower.endsWith(`_${verb}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main classification function
// ---------------------------------------------------------------------------

/**
 * Classify whether a tool (by its short name) is likely read-only.
 *
 * Annotations are untrusted hints from MCP servers and are handled conservatively:
 *   - `readOnlyHint: false` can force a tool to be classified as NOT read-only
 *     (conservative direction — annotations can restrict but never grant).
 *   - `readOnlyHint: true` is ONLY used as a tiebreaker when the name-based
 *     heuristic already classifies the tool as read-only. It cannot grant
 *     read-only classification for tools with unrecognized names.
 *   - Write verbs detected in the tool name ALWAYS block read-only classification,
 *     regardless of annotations.
 *
 * This follows the MCP spec guidance: "Clients MUST consider tool annotations to
 * be untrusted unless they come from trusted servers." Since we have no trust
 * mechanism yet, annotations can only restrict (deny) but never grant (allow).
 *
 * This is a heuristic — users can always override via per-tool permissions.
 */
export function isToolLikelyReadOnly(
  shortName: string,
  annotations?: McpToolAnnotations | null
): boolean {
  // Annotations can restrict: readOnlyHint=false forces NOT read-only
  if (annotations && annotations.readOnlyHint === false) {
    return false;
  }

  const lower = shortName.toLowerCase();

  // Write verbs are a hard stop — annotations cannot override them.
  if (matchesVerb(lower, WRITE_VERBS)) {
    return false;
  }

  // Check read-only verbs (prefix + infix + suffix)
  if (matchesVerb(lower, READ_ONLY_VERBS)) {
    return true;
  }

  // Check exact matches
  if (READ_ONLY_EXACT.has(lower)) {
    return true;
  }

  // Default: unknown → not read-only (conservative).
  // Note: readOnlyHint: true does NOT grant read-only for unknown tools.
  // Annotations are untrusted and cannot independently bypass permission prompts.
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
