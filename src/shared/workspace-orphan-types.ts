/**
 * @module shared/workspace-orphan-types
 *
 * Shared types for workspace orphan detection and cleanup.
 * Used by both main process and renderer.
 */

/**
 * Result of orphan detection for a workspace's .cowork config files.
 */
export interface OrphanDetectionResult {
  /** Orphaned skill IDs found in skills-profile.json */
  orphanedSkills: {
    /** Skill IDs in "pinned" that don't exist in installed skills */
    inPinned: string[];
    /** Skill IDs in "disabled" that don't exist in installed skills */
    inDisabled: string[];
  };
  /** Orphaned server names found in mcp-servers.json */
  orphanedMcpServers: {
    /** Server names in "disabled" that don't exist in configured servers */
    inDisabled: string[];
    /** Server names in "enabled" that don't exist in configured servers */
    inEnabled: string[];
  };
  /** Total count of orphaned entries */
  totalOrphans: number;
  /** The workspace CWD this detection applies to */
  cwd: string;
}

/**
 * Per-workspace dismissal record stored in electron-store.
 * Tracks when the user dismissed the orphan notification so we don't nag.
 * Re-triggers if profile files change after dismissal.
 */
export interface WorkspaceOrphanDismissal {
  /** Workspace CWD path (canonicalized) */
  cwd: string;
  /** Timestamp (ms) when user dismissed */
  dismissedAt: number;
  /** skills-profile.json mtime at dismissal (null if file didn't exist) */
  skillsProfileMtimeMs: number | null;
  /** mcp-servers.json mtime at dismissal (null if file didn't exist) */
  mcpProfileMtimeMs: number | null;
}

/**
 * Payload for the workspace.cleanupOrphans IPC call.
 */
export interface OrphanCleanupPayload {
  /** Workspace CWD */
  cwd: string;
  /** Skill IDs to remove from skills-profile.json (empty array = don't touch skills) */
  skillIds: string[];
  /** MCP server names to remove from mcp-servers.json (empty array = don't touch MCP) */
  mcpServerNames: string[];
}

/**
 * Result of cleanup operation.
 */
export interface OrphanCleanupResult {
  success: boolean;
  error?: string;
  removed?: {
    skills: number;
    mcp: number;
  };
}
