/**
 * @module shared/workspace-instructions-status
 *
 * Shared type for workspace instructions status, used by both the main process
 * (IPC handler) and the renderer (ContextPanel badge component).
 */

export interface WorkspaceInstructionsStatus {
  /**
   * The first candidate in the configured priority list (stable, user-visible).
   * Represents what the user has configured, not necessarily what was loaded.
   * Populated even when disabled so the UI can show what would be used.
   * Empty string only when no priority list exists (fresh install, no config).
   */
  configuredFile: string;
  /**
   * The candidate filename that actually won the priority-list resolution
   * (e.g. 'CLAUDE.md'). Populated with the winning filename when `loaded`
   * is true; empty string otherwise. May differ from `configuredFile` when
   * the first priority candidate is absent and a lower-priority one wins.
   */
  resolvedFile: string;
  /** Whether the file was found and loaded successfully. */
  loaded: boolean;
  /** File size in bytes (only present when loaded). */
  sizeBytes?: number;
  /** Whether the file was truncated to fit the 64 KB limit. */
  truncated?: boolean;
  /** First 8 chars of the content fingerprint (only present when loaded). */
  fingerprintShort?: string;
  /** Error message if something went wrong (file missing, unreadable, etc). */
  error?: string;
}
