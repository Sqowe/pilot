/**
 * @module shared/workspace-instructions-status
 *
 * Shared type for workspace instructions status, used by both the main process
 * (IPC handler) and the renderer (ContextPanel badge component).
 */

export interface WorkspaceInstructionsStatus {
  /** Which file is configured (empty string = none selected). */
  configuredFile: string;
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
