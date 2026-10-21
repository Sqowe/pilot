/**
 * @module main/claude/session-mcp-tools
 *
 * Which MCP tools a chat's agent has, kept in step with the MCP switches: "off this session",
 * the workspace profile, and the servers enabled in the settings.
 *
 * pi takes the tools when a session is created, and the runner keeps that session for the
 * chat's later messages. Before this module, a server turned off in an open chat stayed
 * callable there, and one turned on did not appear, until the session happened to be
 * recreated. pi's public `setActiveToolsByName()` takes a registered tool out of — or back
 * into — what the model is offered from its next step, and tells the model with a
 * `toolsRemoved` / `toolsAdded` system message at the end of the conversation (earlier
 * messages stay as they were, so a provider's prompt cache still holds); a call to a
 * deactivated tool comes back as "Tool … not found" and runs nothing (probe on pi 1.3.0,
 * 2026-10-21). A tool the session never registered cannot be added that way — the session
 * is recreated.
 */
import * as mcpDescriptionGenerator from '../mcp/mcp-description-generator';
import type { MCPServerConfig } from '../mcp/mcp-manager';

/** Every MCP tool the app bridges is named `mcp__<server>__<tool>` (mcp-manager.ts). */
export const MCP_TOOL_PREFIX = 'mcp__';

export type CachedSessionMcpPlan =
  /** The session already offers exactly the wanted MCP tools. */
  | { kind: 'keep' }
  /** Offer these tools from the next step — the session has them all registered. */
  | { kind: 'set-active'; activeToolNames: string[] }
  /** The session never registered these tools; only a new session can offer them. */
  | { kind: 'recreate'; missing: string[] };

/**
 * What to do with a cached session so that its agent is offered exactly `wantedMcp` among the
 * MCP tools. Tools that are not MCP tools (the built-ins, the memory tools) stay as they are.
 */
export function planCachedSessionMcpTools(input: {
  /** Every tool the session has registered (`getAllTools()`). */
  registered: readonly string[];
  /** The tools the session offers now (`getActiveToolNames()`). */
  active: readonly string[];
  /** The MCP tools of the servers enabled for this chat. */
  wantedMcp: readonly string[];
}): CachedSessionMcpPlan {
  const registered = new Set(input.registered);
  const missing = input.wantedMcp.filter((name) => !registered.has(name));
  if (missing.length > 0) return { kind: 'recreate', missing };

  const activeToolNames = [
    ...input.active.filter((name) => !name.startsWith(MCP_TOOL_PREFIX)),
    ...input.wantedMcp,
  ];
  const current = new Set(input.active);
  const next = new Set(activeToolNames);
  const unchanged = current.size === next.size && [...next].every((name) => current.has(name));
  return unchanged ? { kind: 'keep' } : { kind: 'set-active', activeToolNames };
}

/**
 * The "MCP Server Directory" section of the system prompt: the connected servers among those
 * enabled for this chat, with their descriptions, so the model can route a task to a server.
 * `servers` must already have the workspace and session switches applied — the directory
 * used to list every server enabled in the settings, including ones switched off for the chat.
 *
 * Server names and descriptions are sanitized at render time to prevent prompt injection from
 * untrusted MCP metadata.
 */
export function buildMcpServerDirectory(
  servers: ReadonlyArray<Pick<MCPServerConfig, 'id' | 'name' | 'description'>>,
  statuses: ReadonlyArray<{ id: string; connected: boolean; toolCount: number }>
): string {
  const { sanitizeDescription, sanitizeServerName } = mcpDescriptionGenerator;
  const connected = statuses.filter((s) => s.connected);
  if (connected.length === 0) return '';

  const lines: string[] = [];
  for (const server of connected) {
    const config = servers.find((s) => s.id === server.id);
    if (!config) continue;
    const name = sanitizeServerName(config.name);
    const description = sanitizeDescription(config.description || `(${server.toolCount} tools)`);
    lines.push(`- ${name}: ${description}`);
  }

  if (lines.length === 0) return '';

  return [
    '<mcp_server_directory>',
    'Available MCP servers and their capabilities:',
    ...lines,
    "Use the appropriate server's tools based on the task domain.",
    '</mcp_server_directory>',
  ].join('\n');
}
