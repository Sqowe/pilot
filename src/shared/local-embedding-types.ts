/**
 * Shared IPC types for local embedding progress events.
 * Single source of truth — imported by main, preload, and renderer
 * to prevent drift across process boundaries.
 */

export interface LocalEmbeddingProgress {
  status: 'downloading' | 'ready' | 'error';
  /** File being downloaded (present during 'downloading'). */
  file?: string;
  /** Download progress 0–100 (present during 'downloading'). */
  progress?: number;
  /** Error message (present during 'error'). */
  message?: string;
}
