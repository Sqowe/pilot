/**
 * @module main/mcp/mcp-tool-permissions
 *
 * MCP Tool Permission Engine
 *
 * Provides per-server default policies and per-tool overrides for MCP tools.
 * Integrates with the existing permission-rules-store by being consulted
 * BEFORE the generic rule engine for any tool whose name starts with `mcp__`.
 *
 * Architecture:
 *   1. Server-level default policy (allow-all, allow-reads, ask-all, deny-all)
 *   2. Per-tool overrides (sparse — only exceptions to the default)
 *   3. Workspace-level policy file (.cowork/mcp-permissions.json)
 *   4. Progressive trust tracking (approval counts across sessions)
 *
 * Resolution order (first match wins):
 *   workspace override > per-tool override > server default policy > fallback 'ask'
 */

import * as fs from 'fs';
import * as path from 'path';
import { log, logWarn } from '../utils/logger';
import type { MCPServerConfig } from './mcp-manager';
import { isToolLikelyReadOnly } from '../../shared/mcp-tool-classification';

// Re-export for convenience
export { isToolLikelyReadOnly } from '../../shared/mcp-tool-classification';

// ---------------------------------------------------------------------------
// MCP tool name parsing
// ---------------------------------------------------------------------------

/**
 * Parse an MCP tool's full prefixed name into server name and short tool name.
 * Format: mcp__<ServerName>__<toolName>
 * Returns null if the name doesn't match the MCP pattern.
 */
export function parseMcpToolName(
  fullName: string
): { serverName: string; toolName: string } | null {
  if (!fullName.startsWith('mcp__')) return null;
  const remainder = fullName.slice('mcp__'.length);
  const separatorIndex = remainder.indexOf('__');
  if (separatorIndex === -1) return null;
  return {
    serverName: remainder.slice(0, separatorIndex),
    toolName: remainder.slice(separatorIndex + '__'.length),
  };
}

// ---------------------------------------------------------------------------
// Server policy resolution
// ---------------------------------------------------------------------------

/**
 * Decide the permission for an MCP tool based on server-level policy.
 *
 * @param serverConfig - The MCP server's configuration (with policy fields)
 * @param shortToolName - The tool's short name (without mcp__Server__ prefix)
 * @param workspacePolicy - Optional workspace-level policy override
 * @param workspaceTrusted - Whether the workspace is trusted (only trusted workspaces can grant 'allow')
 * @returns 'allow' | 'deny' | 'ask' | null (null = no opinion, fall through to generic rules)
 */
export function decideMcpToolPermission(
  serverConfig: MCPServerConfig | undefined,
  shortToolName: string,
  workspacePolicy?: WorkspaceMcpPermissions | null,
  workspaceTrusted: boolean = false
): 'allow' | 'deny' | 'ask' | null {
  if (!serverConfig) return null;

  const serverName = serverConfig.name;

  // 1. Check workspace-level override (highest priority)
  // Security: untrusted workspaces can only restrict (deny/ask), never grant (allow).
  if (workspacePolicy) {
    const wsServerPolicy = workspacePolicy[serverName];
    if (wsServerPolicy) {
      // Per-tool workspace override
      const wsToolOverride = wsServerPolicy.overrides?.[shortToolName];
      if (wsToolOverride) {
        if (wsToolOverride === 'allow' && !workspaceTrusted) {
          // Untrusted workspace cannot grant allow — treat as 'ask'
          return 'ask';
        }
        return wsToolOverride;
      }
      // Workspace-level default policy for this server
      if (wsServerPolicy.defaultPolicy) {
        const decision = applyDefaultPolicy(wsServerPolicy.defaultPolicy, shortToolName);
        if (decision === 'allow' && !workspaceTrusted) {
          // Untrusted workspace cannot grant allow — treat as 'ask'
          return 'ask';
        }
        return decision;
      }
    }
  }

  // 2. Check per-tool override on the server config (user-configured, always trusted)
  if (serverConfig.toolPermissions) {
    const toolOverride = serverConfig.toolPermissions[shortToolName];
    if (toolOverride) {
      return toolOverride;
    }
  }

  // 3. Apply server-level default policy (user-configured, always trusted)
  if (serverConfig.defaultToolPolicy) {
    return applyDefaultPolicy(serverConfig.defaultToolPolicy, shortToolName);
  }

  // 4. No opinion — fall through to the generic permission rule engine
  return null;
}

/**
 * Apply a default policy to a tool, considering read-only classification.
 */
function applyDefaultPolicy(
  policy: 'allow-all' | 'allow-reads' | 'ask-all' | 'deny-all',
  shortToolName: string
): 'allow' | 'deny' | 'ask' {
  switch (policy) {
    case 'allow-all':
      return 'allow';
    case 'deny-all':
      return 'deny';
    case 'ask-all':
      return 'ask';
    case 'allow-reads':
      return isToolLikelyReadOnly(shortToolName) ? 'allow' : 'ask';
    default:
      return 'ask';
  }
}

// ---------------------------------------------------------------------------
// Workspace policy file (.cowork/mcp-permissions.json)
// ---------------------------------------------------------------------------

/**
 * Workspace-level MCP permission policy.
 * File format: { "ServerName": { "defaultPolicy": "...", "overrides": { "tool": "..." } } }
 */
export interface WorkspaceMcpPermissions {
  [serverName: string]: {
    defaultPolicy?: 'allow-all' | 'allow-reads' | 'ask-all' | 'deny-all';
    overrides?: Record<string, 'allow' | 'ask' | 'deny'>;
  };
}

/** Cache entry for workspace policy file. */
interface WorkspacePolicyCache {
  mtime: number;
  size: number;
  policy: WorkspaceMcpPermissions | null;
  /** Timestamp of last check (for negative-cache TTL). */
  lastCheckedAt: number;
}

const workspacePolicyCache = new Map<string, WorkspacePolicyCache>();

/** Negative-cache TTL: don't re-stat missing files more than once per 10 seconds. */
const NEGATIVE_CACHE_TTL_MS = 10_000;

/** Positive-cache TTL: don't re-stat existing files more than once per 5 seconds. */
const POSITIVE_CACHE_TTL_MS = 5_000;

/** Valid values for defaultPolicy and tool override actions. */
const VALID_DEFAULT_POLICIES = new Set(['allow-all', 'allow-reads', 'ask-all', 'deny-all']);
const VALID_TOOL_ACTIONS = new Set(['allow', 'ask', 'deny']);

/**
 * Validate and sanitize a parsed workspace policy object.
 * Drops invalid entries and normalizes unknown values to safe defaults.
 * Returns null if the entire object is invalid.
 */
function sanitizeWorkspacePolicy(raw: Record<string, unknown>): WorkspaceMcpPermissions | null {
  const result: WorkspaceMcpPermissions = {};
  let hasValidEntry = false;

  for (const [serverName, serverEntry] of Object.entries(raw)) {
    if (!serverEntry || typeof serverEntry !== 'object' || Array.isArray(serverEntry)) {
      continue; // Skip invalid server entries
    }

    const entry = serverEntry as Record<string, unknown>;
    const sanitized: WorkspaceMcpPermissions[string] = {};

    // Validate defaultPolicy
    if (entry.defaultPolicy && typeof entry.defaultPolicy === 'string') {
      if (VALID_DEFAULT_POLICIES.has(entry.defaultPolicy)) {
        sanitized.defaultPolicy = entry.defaultPolicy as
          | 'allow-all'
          | 'allow-reads'
          | 'ask-all'
          | 'deny-all';
      }
      // Invalid defaultPolicy values are silently dropped (safe default: no policy)
    }

    // Validate overrides
    if (entry.overrides && typeof entry.overrides === 'object' && !Array.isArray(entry.overrides)) {
      const validOverrides: Record<string, 'allow' | 'ask' | 'deny'> = {};
      for (const [toolName, action] of Object.entries(entry.overrides as Record<string, unknown>)) {
        if (typeof action === 'string' && VALID_TOOL_ACTIONS.has(action)) {
          validOverrides[toolName] = action as 'allow' | 'ask' | 'deny';
        }
        // Invalid action values are silently dropped
      }
      if (Object.keys(validOverrides).length > 0) {
        sanitized.overrides = validOverrides;
      }
    }

    // Only include server entry if it has at least one valid field
    if (sanitized.defaultPolicy || sanitized.overrides) {
      result[serverName] = sanitized;
      hasValidEntry = true;
    }
  }

  return hasValidEntry ? result : null;
}

/**
 * Load workspace MCP permissions from {cwd}/.cowork/mcp-permissions.json.
 * Uses mtime-based caching to avoid repeated disk reads.
 * Uses negative-cache with TTL to avoid repeated statSync for missing files.
 * Returns null if the file doesn't exist or is invalid.
 */
export function loadWorkspaceMcpPermissions(cwd: string): WorkspaceMcpPermissions | null {
  const filePath = path.join(cwd, '.cowork', 'mcp-permissions.json');

  // Fast path: negative-cache check (file was absent recently)
  const cached = workspacePolicyCache.get(filePath);
  if (cached && cached.mtime === 0 && cached.policy === null) {
    // File was absent last time we checked — skip statSync if within TTL
    if (Date.now() - cached.lastCheckedAt < NEGATIVE_CACHE_TTL_MS) {
      return null;
    }
  }

  // Fast path: positive-cache check (file exists and was recently validated)
  if (cached && cached.mtime > 0 && Date.now() - cached.lastCheckedAt < POSITIVE_CACHE_TTL_MS) {
    return cached.policy;
  }

  try {
    const stat = fs.statSync(filePath);

    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
      return cached.policy;
    }

    let parsed: unknown;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      parsed = JSON.parse(content);
    } catch (parseErr) {
      // Invalid JSON — cache the failure with current mtime/size so we don't
      // re-read and re-parse on every permission check until the file changes.
      logWarn(`[McpToolPermissions] Failed to parse workspace policy file: ${filePath}`);
      workspacePolicyCache.set(filePath, {
        mtime: stat.mtimeMs,
        size: stat.size,
        policy: null,
        lastCheckedAt: Date.now(),
      });
      return null;
    }

    // Basic structure validation
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logWarn(`[McpToolPermissions] Invalid workspace policy file structure: ${filePath}`);
      workspacePolicyCache.set(filePath, {
        mtime: stat.mtimeMs,
        size: stat.size,
        policy: null,
        lastCheckedAt: Date.now(),
      });
      return null;
    }

    // Deep validation: sanitize each server entry, reject invalid values
    const policy = sanitizeWorkspacePolicy(parsed as Record<string, unknown>);
    if (!policy) {
      logWarn(`[McpToolPermissions] Workspace policy file has no valid entries: ${filePath}`);
    }
    workspacePolicyCache.set(filePath, {
      mtime: stat.mtimeMs,
      size: stat.size,
      policy,
      lastCheckedAt: Date.now(),
    });
    log(`[McpToolPermissions] Loaded workspace policy from: ${filePath}`);
    return policy;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist — cache the absence with timestamp for TTL
      workspacePolicyCache.set(filePath, {
        mtime: 0,
        size: 0,
        policy: null,
        lastCheckedAt: Date.now(),
      });
      return null;
    }
    logWarn(`[McpToolPermissions] Error reading workspace policy: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Progressive Trust Tracking
// ---------------------------------------------------------------------------

/**
 * Tracks how many times each MCP tool has been manually approved.
 * When a tool crosses the suggestion threshold, the system can recommend
 * promoting it to 'allow' in the server's toolPermissions.
 *
 * Stored in-memory for now; could be persisted to electron-store in the future.
 */
interface ToolApprovalRecord {
  count: number;
  lastApprovedAt: number;
}

const approvalCounts = new Map<string, ToolApprovalRecord>();

/** Threshold: after this many approvals, suggest auto-allowing the tool. */
const SUGGESTION_THRESHOLD = 5;

/**
 * Record that a user manually approved an MCP tool.
 * @param fullToolName - The full prefixed tool name (mcp__Server__tool)
 */
export function recordMcpToolApproval(fullToolName: string): void {
  const existing = approvalCounts.get(fullToolName);
  if (existing) {
    existing.count += 1;
    existing.lastApprovedAt = Date.now();
  } else {
    approvalCounts.set(fullToolName, { count: 1, lastApprovedAt: Date.now() });
  }
}

/**
 * Check if a tool has been approved enough times to suggest auto-allowing.
 * Returns the approval count if it meets the threshold, null otherwise.
 */
export function getToolPromotionSuggestion(fullToolName: string): number | null {
  const record = approvalCounts.get(fullToolName);
  if (!record || record.count < SUGGESTION_THRESHOLD) return null;
  return record.count;
}

/**
 * Get all tools that have crossed the suggestion threshold.
 * Useful for showing a batch "promote these tools?" UI.
 */
export function getAllPromotionSuggestions(): Array<{
  fullToolName: string;
  serverName: string;
  toolName: string;
  approvalCount: number;
}> {
  const suggestions: Array<{
    fullToolName: string;
    serverName: string;
    toolName: string;
    approvalCount: number;
  }> = [];

  for (const [fullName, record] of approvalCounts) {
    if (record.count >= SUGGESTION_THRESHOLD) {
      const parsed = parseMcpToolName(fullName);
      if (parsed) {
        suggestions.push({
          fullToolName: fullName,
          serverName: parsed.serverName,
          toolName: parsed.toolName,
          approvalCount: record.count,
        });
      }
    }
  }

  return suggestions;
}

/**
 * Clear the approval count for a tool (e.g., after user promotes it or dismisses the suggestion).
 */
export function clearToolApprovalCount(fullToolName: string): void {
  approvalCounts.delete(fullToolName);
}

/**
 * Get the current approval count for a tool (for UI display).
 */
export function getToolApprovalCount(fullToolName: string): number {
  return approvalCounts.get(fullToolName)?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Test utilities (exported for test use only)
// ---------------------------------------------------------------------------

/**
 * Clear the workspace policy cache. Used in tests to ensure fresh reads.
 * @internal
 */
export function _clearWorkspacePolicyCache(): void {
  workspacePolicyCache.clear();
}
