/**
 * @module shared/token-usage
 *
 * TokenUsage type shared between the main process and the renderer.
 * Kept in shared/ so main-process utilities (token-usage-utils.ts) can
 * import it without creating a cross-layer dependency on renderer/types.
 */

export interface TokenUsage {
  input: number;
  output: number;
  /** Prompt-cache read tokens (tokens served from cache). */
  cacheRead?: number;
  /** Prompt-cache write tokens (tokens written to cache). */
  cacheWrite?: number;
}
