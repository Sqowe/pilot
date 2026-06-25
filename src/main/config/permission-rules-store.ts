/**
 * @module main/config/permission-rules-store
 *
 * Main-process cache of Settings.permissionRules.
 *
 * The renderer owns the source of truth (Zustand store), but the agent
 * runner needs synchronous access in the main process when wrapping tool
 * `execute()` calls. The renderer mirrors changes via the `settings.update`
 * IPC event; see `src/main/index.ts`.
 *
 * Security note: renderer-originated settings are treated as untrusted at
 * this boundary. All rules are validated and coerced before being cached —
 * unknown / malformed values fall back to `'ask'` so the worst-case is a
 * harmless extra prompt, never an unintended auto-allow.
 */
import type { PermissionRule } from '../../renderer/types';
import {
  parseMcpToolName,
  decideMcpToolPermission,
  loadWorkspaceMcpPermissions,
  recordMcpToolApproval,
} from '../mcp/mcp-tool-permissions';
import type { MCPServerConfig } from '../mcp/mcp-manager';
import type { McpToolAnnotations } from '../mcp/mcp-tool-permissions';
import {
  decideBashPermission as _decideBashPermissionEngine,
  sanitizeBashCommandList,
  type BashCommandLists,
} from '../../shared/bash-restrictions';
// splitBashSubCommands is a pure re-export (not used locally in this file).
// sanitizeBashCommandList is imported above (used in setBashCommandLists) and re-exported below.
// Both re-exports maintain backward compatibility: tests and config-store import
// these utilities from this module; direct imports from shared/bash-restrictions
// are equivalent but would require updating every existing import path.
export { splitBashSubCommands } from '../../shared/bash-restrictions';
export { sanitizeBashCommandList };

// Mirrors the renderer defaults in src/renderer/store/index.ts
const DEFAULT_RULES: PermissionRule[] = [
  { tool: 'read', action: 'allow' },
  { tool: 'glob', action: 'allow' },
  { tool: 'grep', action: 'allow' },
  { tool: 'ls', action: 'allow' },
  { tool: 'find', action: 'allow' },
  { tool: 'write', action: 'ask' },
  { tool: 'edit', action: 'ask' },
  { tool: 'bash', action: 'ask' },
];

const VALID_ACTIONS: ReadonlySet<PermissionRule['action']> = new Set(['allow', 'deny', 'ask']);

let rules: PermissionRule[] = [...DEFAULT_RULES];

/** Session-scoped "always allow" decisions, keyed by sessionId → set of lowercase tool names. */
const alwaysAllowBySession = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// MCP server config lookup (for per-server tool permission policies)
// ---------------------------------------------------------------------------

/** Callback to look up an MCP server config by server name. Set by the agent runner. */
let mcpServerConfigLookup: ((serverName: string) => MCPServerConfig | undefined) | null = null;

/** Callback to look up MCP tool annotations by full prefixed tool name. */
let mcpToolAnnotationsLookup: ((fullToolName: string) => McpToolAnnotations | undefined) | null =
  null;

/** Per-session working directory, used to load workspace MCP permission files. */
const sessionCwdMap = new Map<string, string>();

/**
 * Register the MCP server config lookup function.
 * Called once during app initialization (from agent-runner or main/index.ts).
 */
export function setMcpServerConfigLookup(
  lookup: (serverName: string) => MCPServerConfig | undefined
): void {
  mcpServerConfigLookup = lookup;
}

/**
 * Register the MCP tool annotations lookup function.
 * Called once during app initialization (from agent-runner or main/index.ts).
 */
export function setMcpToolAnnotationsLookup(
  lookup: (fullToolName: string) => McpToolAnnotations | undefined
): void {
  mcpToolAnnotationsLookup = lookup;
}

/**
 * Set the working directory for a session (used for workspace policy lookup).
 */
export function setSessionCwd(sessionId: string, cwd: string): void {
  sessionCwdMap.set(sessionId, cwd);
}

/**
 * Clear session CWD when session is deleted.
 */
export function clearSessionCwd(sessionId: string): void {
  sessionCwdMap.delete(sessionId);
}

/**
 * Sessions running in autonomous mode (executionMode: 'auto').
 * When a session is in this set, 'ask' decisions are converted to blocks
 * instead of prompting the user. The blocked command is returned to the
 * caller for logging.
 */
const autonomousSessions = new Set<string>();

/** Callback to record blocked commands for autonomous sessions. */
let onAutonomousBlock: ((sessionId: string, toolName: string, command: string) => void) | null =
  null;

/**
 * Sanitize an untrusted rules payload from IPC. Drops entries with empty
 * tool names, coerces invalid `action` values to `'ask'`, and preserves
 * optional string `pattern` fields. Returns null for non-array input.
 */
function sanitizeRules(input: unknown): PermissionRule[] | null {
  if (!Array.isArray(input)) return null;
  const out: PermissionRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<PermissionRule>;
    const tool = typeof r.tool === 'string' ? r.tool.trim() : '';
    if (!tool) continue;

    const pattern = typeof r.pattern === 'string' ? r.pattern : undefined;
    const rawAction = typeof r.action === 'string' ? r.action : '';
    const action: PermissionRule['action'] = VALID_ACTIONS.has(
      rawAction as PermissionRule['action']
    )
      ? (rawAction as PermissionRule['action'])
      : 'ask'; // Conservative fallback for unknown / malformed actions

    out.push({ tool, pattern, action });
  }
  return out;
}

export function setPermissionRules(next: unknown): void {
  const sanitized = sanitizeRules(next);
  rules = sanitized && sanitized.length > 0 ? sanitized : [...DEFAULT_RULES];
}

export function getPermissionRules(): PermissionRule[] {
  // Return a shallow copy so external callers can't mutate the internal cache.
  return rules.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Bash-specific trust list and denylist
// ---------------------------------------------------------------------------
// State mirrored from the renderer via `settings.update` IPC. Decision logic
// lives in `src/shared/bash-restrictions/engine.ts`; see that module for the
// full policy model, shell-syntax rules, and per-pattern matching semantics.
//
// Startup race: between launch and first hydration, both lists are empty so
// a bash call falls through to the generic rule engine — same pattern as
// `permissionRules`. A follow-up could migrate both to main-process
// persistence.

let bashTrustedCommands: string[] = [];
let bashDenylist: string[] = [];

/**
 * Update one or both bash command lists. Passing `undefined` for either
 * argument leaves that list unchanged, so callers with partial updates can
 * send just the field they care about without clobbering the other list.
 */
export function setBashCommandLists(trusted: unknown, denied: unknown): void {
  if (trusted !== undefined) {
    bashTrustedCommands = sanitizeBashCommandList(trusted);
  }
  if (denied !== undefined) {
    bashDenylist = sanitizeBashCommandList(denied);
  }
}

export function getBashCommandLists(): { trusted: string[]; denied: string[] } {
  return { trusted: [...bashTrustedCommands], denied: [...bashDenylist] };
}

/**
 * Decide a bash command using the current module-level trust/deny lists.
 *
 * Thin 1-arg wrapper around the shared engine's `decideBashPermission` so
 * existing callers (store, tests) require no changes. Lists are injected
 * from module state; full policy semantics live in
 * `src/shared/bash-restrictions/engine.ts`.
 */
export function decideBashPermission(command: string): 'allow' | 'ask' | null {
  // Enforce short-circuit semantics explicitly at the store boundary, independent
  // of shared engine internals, so this module's public contract stays stable.
  if (!command) return null;
  if (bashTrustedCommands.length === 0 && bashDenylist.length === 0) return null;
  // Typed explicitly so a property-name mismatch with BashCommandLists fails at compile time.
  // Defensive spread copies prevent the engine from accidentally mutating module state.
  // (The current shared engine is pure and does not mutate its inputs, but the copies
  // guard against future engine changes and make the intent explicit.)
  const lists: BashCommandLists = {
    trusted: [...bashTrustedCommands],
    denied: [...bashDenylist],
  };
  // Authoritative mode is active (at least one list is non-empty). Apply ?? 'ask' so that any
  // future engine change that returns null for a non-empty command fails-closed here rather
  // than falling through to generic rules unexpectedly.
  return _decideBashPermissionEngine(command, lists) ?? 'ask';
}

/**
 * Decide how a given tool call should be handled.
 *
 * Matching order:
 *   1. Session-scoped "always allow" memory
 *   2. First rule whose `tool` matches (case-insensitive) AND whose
 *      optional `pattern` (glob-ish: `*` = any substring) matches the
 *      stringified input
 *   3. Default: 'ask' for unknown tools (conservative)
 *
 * Defence-in-depth: even though `setPermissionRules` sanitizes input, we
 * re-validate the matched rule's action here so a malformed rule that
 * somehow bypasses sanitation still falls back to `'ask'` rather than
 * letting an unknown value propagate into the execution path.
 */
export function decidePermission(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>
): 'allow' | 'deny' | 'ask' {
  const lowered = toolName.toLowerCase();

  // Bash commands get a dedicated trust/deny evaluation BEFORE the session-
  // scoped "always allow" memory. The session memory is keyed by tool name
  // only, so without this ordering a single "Allow always" click on any
  // bash command would silently override the user's denylist and trust list
  // for the rest of the session — making authoritative mode a no-op once
  // the user ever approved a bash call. Consulting the list engine first
  // ensures the denylist is honoured and only commands that fall through
  // to the generic engine (null decision) can be blanket-allowed for the
  // session.
  if (lowered === 'bash') {
    const rawCmd = input.command;
    const cmd = typeof rawCmd === 'string' ? rawCmd : '';
    const bashDecision = decideBashPermission(cmd);
    if (bashDecision) return bashDecision;
  }

  // --- MCP tool permission engine (per-server policies) ---
  // Consulted BEFORE session-scoped "always allow" so that server-level
  // deny policies cannot be overridden by a stale session memory entry.
  // However, if the MCP policy resolves to 'ask', we still check session
  // memory — otherwise previously remembered approvals would be ignored.
  let mcpDecision: 'allow' | 'deny' | 'ask' | null = null;
  const mcpParsed = parseMcpToolName(toolName);
  if (mcpParsed && mcpServerConfigLookup) {
    const serverConfig = mcpServerConfigLookup(mcpParsed.serverName);
    const cwd = sessionCwdMap.get(sessionId);
    const workspacePolicy = cwd ? loadWorkspaceMcpPermissions(cwd) : null;
    // Workspace policies from .cowork/mcp-permissions.json are untrusted by default.
    // They can restrict (deny/ask) but cannot grant (allow) unless workspace is trusted.
    // TODO: integrate with workspace trust system when available.
    const workspaceTrusted = false;
    // Look up server-provided annotations (readOnlyHint, etc.) for enhanced classification
    const annotations = mcpToolAnnotationsLookup ? mcpToolAnnotationsLookup(toolName) : undefined;
    mcpDecision = decideMcpToolPermission(
      serverConfig,
      mcpParsed.toolName,
      workspacePolicy,
      workspaceTrusted,
      annotations
    );
    // 'deny' and 'allow' are authoritative — short-circuit immediately.
    // 'ask' falls through to session memory check below.
    if (mcpDecision === 'deny' || mcpDecision === 'allow') return mcpDecision;
  }

  const session = alwaysAllowBySession.get(sessionId);
  if (session?.has(lowered)) return 'allow';

  // If MCP policy said 'ask', honour it (don't fall through to generic rules
  // which might have a blanket allow for the mcp__ prefixed name).
  if (mcpDecision === 'ask') return 'ask';

  const inputStr = safeStringify(input);

  for (const rule of rules) {
    if (rule.tool.toLowerCase() !== lowered) continue;
    if (rule.pattern && !matchesPattern(rule.pattern, inputStr)) continue;
    return VALID_ACTIONS.has(rule.action) ? rule.action : 'ask';
  }
  return 'ask';
}

export function rememberAlwaysAllow(sessionId: string, toolName: string): void {
  const set = alwaysAllowBySession.get(sessionId) ?? new Set<string>();
  set.add(toolName.toLowerCase());
  alwaysAllowBySession.set(sessionId, set);

  // Track MCP tool approvals for progressive trust suggestions
  if (toolName.startsWith('mcp__')) {
    recordMcpToolApproval(toolName);
  }
}

export function forgetSessionPermissions(sessionId: string): void {
  alwaysAllowBySession.delete(sessionId);
  autonomousSessions.delete(sessionId);
  sessionCwdMap.delete(sessionId);
}

// --- Autonomous session management ---

/**
 * Mark a session as running in autonomous mode.
 * When 'ask' decisions occur for this session, they will be blocked
 * instead of prompting the user.
 */
export function markSessionAutonomous(sessionId: string): void {
  autonomousSessions.add(sessionId);
}

/**
 * Check if a session is in autonomous mode.
 */
export function isSessionAutonomous(sessionId: string): boolean {
  return autonomousSessions.has(sessionId);
}

/**
 * Set the callback for when an autonomous session has a command blocked.
 */
export function setAutonomousBlockCallback(
  callback: ((sessionId: string, toolName: string, command: string) => void) | null
): void {
  onAutonomousBlock = callback;
}

/**
 * Get the autonomous block callback (used by the permission hook).
 */
export function getAutonomousBlockCallback():
  | ((sessionId: string, toolName: string, command: string) => void)
  | null {
  return onAutonomousBlock;
}

function safeStringify(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s ?? '';
  } catch {
    return '';
  }
}

function matchesPattern(pattern: string, haystack: string): boolean {
  // Escape regex metacharacters except '*', then convert '*' → '.*'
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i').test(haystack);
}
