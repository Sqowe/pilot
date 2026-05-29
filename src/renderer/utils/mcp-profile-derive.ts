/**
 * Pure utility to derive disabled MCP server IDs from a workspace profile.
 *
 * Supports two profile modes:
 * 1. Blocklist (`disabled`) — entries are resolved against the server list by id/name
 * 2. Allowlist (`enabled`) — servers NOT in the enabled list are considered disabled
 *
 * When both `disabled` and `enabled` exist, `disabled` takes precedence (blocklist mode).
 */

export interface McpProfileInput {
  disabled?: string[];
  enabled?: string[];
}

export interface McpServerEntry {
  id: string;
  name: string;
}

/**
 * Derive the set of disabled server IDs from a workspace profile and the current server list.
 *
 * Precedence: if `disabled` key is present (even as empty array), blocklist mode wins.
 * Only falls through to allowlist mode when `disabled` is absent/undefined.
 *
 * @param profile - The raw workspace profile (or null if none exists)
 * @param servers - The current list of MCP servers (with id and name)
 * @returns Set of server IDs that should be disabled, or null if derivation
 *          cannot be completed yet (allowlist mode with no servers loaded).
 */
export function deriveDisabledServerIds(
  profile: McpProfileInput | null,
  servers: McpServerEntry[]
): Set<string> | null {
  if (!profile) {
    return new Set();
  }

  // Blocklist mode: `disabled` key present takes precedence (even if empty)
  if (Array.isArray(profile.disabled)) {
    if (profile.disabled.length === 0) {
      return new Set(); // Explicit empty = nothing disabled
    }
    const disabledSet = new Set<string>();
    for (const entry of profile.disabled) {
      const server = servers.find((s) => s.id === entry || s.name === entry);
      if (server) {
        disabledSet.add(server.id);
      } else {
        // Keep raw ID for servers not yet loaded (will match by id at runtime)
        disabledSet.add(entry);
      }
    }
    return disabledSet;
  }

  // Allowlist mode: `enabled` key present — servers NOT in the list should be disabled
  if (Array.isArray(profile.enabled)) {
    if (profile.enabled.length === 0) {
      // Empty allowlist = nothing is allowed = disable all known servers
      if (servers.length === 0) {
        // No servers known yet — but empty allowlist with no servers means nothing to disable
        return new Set();
      }
      return new Set(servers.map((s) => s.id));
    }
    if (servers.length === 0) {
      // Can't derive without a server list — signal pending to caller
      return null;
    }
    const enabledSet = new Set(profile.enabled);
    const derivedDisabled = servers
      .filter((s) => !enabledSet.has(s.id) && !enabledSet.has(s.name))
      .map((s) => s.id);
    return new Set(derivedDisabled);
  }

  return new Set();
}
