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

/**
 * Coarse runtime state of the in-process local embedding pipeline.
 * Separate from LocalEmbeddingProgress (a transient event stream) — this is a
 * persistent snapshot the Settings UI can poll at any time to render a stable
 * "download failed, running lexical-only" banner even if it missed the events.
 */
export interface LocalModelRuntimeStatus {
  /** idle: never attempted. loading: pipeline initialising. ready: usable. error: last attempt failed (in backoff). */
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** Last error message (present when state === 'error'). */
  error?: string;
  /** Epoch ms of the last failure (present when state === 'error'). */
  failedAt?: number;
  /** Epoch ms when the next automatic download retry is allowed (present when state === 'error'). */
  retryAfter?: number;
}

/** Combined status returned to the renderer: filesystem cache presence + runtime state. */
export interface LocalModelStatus extends LocalModelRuntimeStatus {
  /** True when the model files exist in the cache dir on disk. */
  downloaded: boolean;
}
