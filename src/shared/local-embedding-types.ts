/**
 * Shared IPC types for local embedding progress events.
 * Single source of truth — imported by main, preload, and renderer
 * to prevent drift across process boundaries.
 */

/**
 * Whether a piece of text is being embedded as a search *query* or as a stored
 * *document*. Provider-neutral (mirrors sentence-transformers encode_query /
 * encode_document). Only the local EmbeddingGemma provider currently maps this to
 * a model-specific prefix; remote providers ignore it.
 */
export type EmbeddingKind = 'query' | 'document';

/**
 * Version of *how* embeddings are computed. Bump whenever a change makes new
 * vectors incomparable with previously-stored ones at the same dimension (e.g. a
 * prompt/prefix, pooling, or normalization change) so stale indexes can be
 * detected and a rebuild offered.
 *
 * History:
 *   1 — initial local provider: raw text, no task prefix.
 *   2 — EmbeddingGemma query/document task prefixes applied.
 */
export const EMBEDDING_FORMAT_VERSION = 2;

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
