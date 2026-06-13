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
// These lists layer on top of the generic rule engine above and give the user
// precise per-command control over the bash tool:
//
//   - bashTrustedCommands: prefix patterns (with '*' wildcard). A match on a
//     sub-command means "auto-allow this piece".
//   - bashDenylist: substring patterns. A match anywhere in a sub-command
//     forces 'ask' regardless of trust — denylist always wins.
//
// The full command is split into sub-commands on shell operators (&&, ||, ;,
// |) so that chained commands are evaluated piece by piece — a compound like
// `npm install && rm -rf node_modules` is never auto-allowed by `npm *`.
//
// Precedence: when EITHER list is non-empty, bash lists are authoritative
// and the generic rule engine is not consulted for bash commands. Empty
// lists mean "not opted in" — the generic engine decides, preserving
// today's behaviour for users who haven't configured list control.
//
// Startup race: the main-process cache is hydrated from the renderer via
// `settings.update` IPC (see useIPC.ts bootstrap). Between main-process
// launch and the first hydration message, both lists are empty, so a bash
// call in that window is evaluated by the generic rule engine. This matches
// the pre-existing pattern for `permissionRules` and is a shared limitation;
// a follow-up could migrate both to main-process persistence.

let bashTrustedCommands: string[] = [];
let bashDenylist: string[] = [];

/**
 * Normalize an unknown value into a clean string array: drops non-string
 * entries, trims whitespace, and filters out empties. Exported so that the
 * main-process IPC handler, `configStore`, and this module all agree on
 * exactly what a "bash command list" looks like at the trust boundary.
 */
export function sanitizeBashCommandList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

// Kept as an internal alias so the rest of this file reads naturally.
const sanitizeStringList = sanitizeBashCommandList;

/**
 * Update one or both bash command lists. Passing `undefined` for either
 * argument leaves that list unchanged, so callers with partial updates can
 * send just the field they care about without clobbering the other list.
 */
export function setBashCommandLists(trusted: unknown, denied: unknown): void {
  if (trusted !== undefined) {
    bashTrustedCommands = sanitizeStringList(trusted);
  }
  if (denied !== undefined) {
    bashDenylist = sanitizeStringList(denied);
  }
}

export function getBashCommandLists(): { trusted: string[]; denied: string[] } {
  return { trusted: [...bashTrustedCommands], denied: [...bashDenylist] };
}

/**
 * Split a shell command on unquoted operators `&&`, `||`, `;`, `|`.
 * Quoted substrings (single or double) are preserved intact so operators
 * inside quotes do not split the command.
 */
export function splitBashSubCommands(command: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (quote) {
      buf += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        // Consume escaped next char verbatim inside double quotes.
        buf += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      i += 1;
      continue;
    }

    // Two-char operators first so `&&` / `||` don't get eaten by the `|` branch.
    if (ch === '&' && command[i + 1] === '&') {
      parts.push(buf);
      buf = '';
      i += 2;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      parts.push(buf);
      buf = '';
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|') {
      parts.push(buf);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Check whether `command` starts with `pattern`, where `*` is a wildcard for
 * any character sequence. Anchored at the start of the command; matching is
 * case-insensitive to stay consistent with the rest of the rule engine.
 */
function matchesTrustedPrefix(pattern: string, command: string): boolean {
  // Escape regex metacharacters by inserting a literal backslash in front of
  // each matched char, then turn user-facing `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped, 'i').test(command);
}

/**
 * Match a denylist pattern against a sub-command using word-boundary
 * semantics. The pattern matches only when it appears as a distinct "word"
 * in the command — i.e. not surrounded by alphanumeric or underscore
 * characters on either side.
 *
 * This prevents false positives like `rm` matching inside `formats` or
 * `markdown`, while still catching `rm -rf`, `sudo rm`, `(rm ...)`,
 * `/usr/bin/rm`, etc.
 *
 * For patterns that start with `-` (like `--force`), the boundary is
 * checked only on the left side (must NOT be preceded by a word character)
 * since flags naturally run into their values without a word boundary on
 * the right (e.g. `--force-with-lease` should still match `--force`).
 *
 * Case-insensitive to stay consistent with the rest of the rule engine.
 */
function matchesDenylistPattern(pattern: string, command: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Use negative lookaround for word characters (letters, digits, underscore).
  // This ensures the pattern is treated as a distinct token regardless of
  // what delimiter surrounds it (space, /, (, ;, quotes, start/end, etc.).
  const leftBoundary = '(?<![A-Za-z0-9_])';
  const rightBoundary = pattern.startsWith('-') ? '' : '(?![A-Za-z0-9_])';
  const re = new RegExp(leftBoundary + escaped + rightBoundary, 'i');
  return re.test(command);
}

/**
 * Shell metacharacters the simple splitter below cannot safely parse. If any
 * of these appear in an *evaluating* context we fail closed — returning null
 * from `decideBashPermission` so the caller falls through to the default
 * rule (normally `ask`). Specifically:
 *   - newline separators (`\n`, `\r`) — chain commands without `;`
 *   - single `&` background operator (distinct from `&&` handled below,
 *     and from the file-descriptor redirection forms `N>&`, `N<&`, `&>`,
 *     `&>>`, which this check recognizes and allows — they don't spawn a
 *     subshell or chain a second command, they just duplicate FDs)
 *   - backticks and `$(...)` command substitution — a trusted outer command
 *     could still execute an untrusted inner payload. Bash expands these
 *     inside double quotes too, so we keep scanning for them while the
 *     scanner is in double-quote mode; only single quotes are fully inert.
 *   - process substitution `<(...)` / `>(...)` — bash forks a subshell for
 *     the inner command; detect outside quotes (inside quotes they are
 *     literal).
 *   - unclosed quotes — parsing is ambiguous; refuse to decide
 *
 * This check runs before splitting so compound strings like
 * `npm install\nrm -rf /`, `echo $(rm -rf /)`, `echo "$(rm -rf /)"`, and
 * `cat <(rm -rf /)` can never be auto-allowed. Redirection forms that
 * look like `2>&1`, `1>&2`, `2>&-`, `&> file`, `&>> file` are safe and
 * treated as regular tokens.
 */
function containsUnsupportedShellSyntax(command: string): boolean {
  let quote: '"' | "'" | null = null;
  let i = 0;

  /**
   * True when the `&` at position `i` is part of a file-descriptor
   * redirection, not the background operator. Handles both leading and
   * trailing forms:
   *   - `&>` / `&>>` — "redirect both stdout and stderr to file" shorthand
   *   - `N>&...` / `N<&...` — duplicate/close FD (N optional, defaults to 1
   *     for `>&` and 0 for `<&`)
   * Examples: `cmd 2>&1`, `cmd 1>&2`, `cmd 2>&-`, `cmd &> file`, `cmd &>> file`.
   */
  const isRedirectionAmp = (pos: number): boolean => {
    // `&>` or `&>>` at this position — shorthand for "both fds to file".
    if (command[pos + 1] === '>') return true;
    // `>&` or `<&` immediately preceding — FD duplicate/close. Optionally
    // allow a digit before the `>`/`<` (e.g. `2>&1`). The digit is a
    // single character in POSIX; bash accepts multi-digit but the
    // behaviour is the same — any-length digit run preceding the
    // operator still indicates a redirection.
    let p = pos - 1;
    if (command[p] === '>' || command[p] === '<') return true;
    // Skip a possible digit run (rare: `{fd}>&N` brace form is not
    // handled here — that would require parsing the `{fd}` token and
    // isn't worth the complexity since it's very rarely generated by
    // LLMs or users).
    while (p >= 0 && command[p] >= '0' && command[p] <= '9') p -= 1;
    // Having skipped digits, the prior char should be `>` or `<`.
    return command[p] === '>' || command[p] === '<';
  };

  while (i < command.length) {
    const ch = command[i];

    // Single quotes are fully inert — only look for the matching `'`.
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }

    // Double quotes are NOT inert: bash still expands `$(` and backticks
    // inside them, so we keep the danger checks on while in this state.
    // Handle `\"` and `\\` escape pairs so a literal backslash followed by
    // a special char doesn't confuse the scanner.
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        i += 2;
        continue;
      }
      if (ch === '`') return true;
      if (ch === '$' && command[i + 1] === '(') return true;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    // Outside any quote.
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') return true;
    if (ch === '`') return true;
    if (ch === '$' && command[i + 1] === '(') return true;
    // Process substitution: `<(cmd)` and `>(cmd)` fork a subshell for cmd.
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') return true;
    // Skip `&&` and `||` as paired operators so the lone-`&` / lone-`|`
    // detection below does not misfire on the second char of the pair.
    if (ch === '&' && command[i + 1] === '&') {
      i += 2;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      i += 2;
      continue;
    }
    if (ch === '&') {
      if (isRedirectionAmp(i)) {
        i += 1;
        continue;
      }
      return true;
    }
    i += 1;
  }
  // Unclosed quote — ambiguous parse, refuse to auto-decide.
  return quote !== null;
}

/**
 * Decide a bash command using the trust/deny lists.
 *
 * Policy model: **if either list is non-empty, the bash lists are
 * authoritative.** That is, once the user has opted in to list-based
 * bash control, the generic permission rule engine is not consulted for
 * bash commands — every command is either explicitly trusted (`allow`),
 * explicitly denied (`ask`), or implicitly requires approval (`ask`). This
 * prevents a generic `{ tool: 'bash', action: 'allow' }` rule from silently
 * overriding a carefully-configured trust list.
 *
 *   - 'ask'   if any sub-command matches a denylist substring; OR the
 *             command uses shell syntax we can't safely parse; OR the
 *             command isn't covered by the trust list (implicit ask).
 *   - 'allow' if every sub-command matches a trusted prefix AND none matched
 *             the denylist.
 *   - null    only when both lists are empty (user hasn't opted in) or
 *             when the command string is empty. Callers fall through to the
 *             generic rule engine in those cases, preserving today's
 *             behaviour for users who haven't configured bash control.
 */
export function decideBashPermission(command: string): 'allow' | 'ask' | null {
  if (!command) return null;
  if (bashTrustedCommands.length === 0 && bashDenylist.length === 0) return null;

  // Fail closed on shell syntax the splitter below cannot handle safely.
  // Both the denylist path and the "no denylist match" path yield `ask`
  // here — we never let unsupported syntax reach the generic rules, which
  // could be configured to allow bash and would then auto-execute payloads
  // like `echo $(rm -rf /)`.
  if (containsUnsupportedShellSyntax(command)) {
    return 'ask';
  }

  const subs = splitBashSubCommands(command);
  // An otherwise-empty command after splitting (e.g. `   ;   `) is treated
  // the same as an unrecognized command: authoritative mode still applies,
  // so we require manual approval rather than falling through.
  if (subs.length === 0) return 'ask';

  let allTrusted = true;
  for (const sub of subs) {
    if (bashDenylist.some((p) => matchesDenylistPattern(p, sub))) {
      return 'ask';
    }
    if (!bashTrustedCommands.some((p) => matchesTrustedPrefix(p, sub))) {
      allTrusted = false;
    }
  }
  // Authoritative mode: untrusted commands are an implicit `ask` rather
  // than a null fall-through. Without this, a generic `bash: allow` rule
  // would override the list-based policy the user explicitly configured.
  return allTrusted ? 'allow' : 'ask';
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
