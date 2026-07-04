/**
 * Pure validation for the Custom-mode embedding "model override" field.
 * Extracted from SettingsMemory.tsx so it can be unit-tested without a DOM.
 */

/** A problem detected with a Custom-mode embedding model override value. */
export type EmbeddingModelIssue = 'chat' | 'prefix' | null;

/**
 * Heuristic validation for the Custom-mode embedding model override.
 *
 * The remote embedding path only handles *prefix-free* models correctly
 * (OpenAI text-embedding-*, BGE). This catches two mistakes:
 *  - 'chat'   — a chat/completion/reasoning model in the embedding field. It will
 *               fail outright (the /embeddings endpoint rejects it). Blocking.
 *  - 'prefix' — an embedding model that needs query/document prefixes we don't
 *               apply (E5 → query:/passage:, Nomic → search_query:/search_document:).
 *               It works but under-performs. Non-blocking warning.
 *
 * Returns null for empty, known-good (OpenAI/BGE and other *-embedding-* models),
 * or unrecognized-but-plausible values — we don't nag on models we can't classify.
 */
export function classifyEmbeddingModel(model: string): EmbeddingModelIssue {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  // Known-good, prefix-free embedding models — always clean.
  if (m.includes('text-embedding') || m.includes('bge')) return null;
  // Prefix-needing embedding models — checked before the generic 'embed' allowlist
  // because e.g. "nomic-embed-text" contains "embed" but still needs prefixes.
  if (/(^|[-/_])e5([-/_]|$)/.test(m) || m.includes('nomic')) return 'prefix';
  // Other embedding models (gemini-embedding-*, voyage, jina-embeddings, …) — clean.
  if (m.includes('embed')) return null;
  // Obvious chat / completion / reasoning models — cannot produce embeddings.
  const chatPatterns = [
    /gpt/,
    /chatgpt/,
    /claude/,
    /gemini/,
    /llama/,
    /mistral/,
    /mixtral/,
    /qwen/,
    /deepseek/,
    /grok/,
    /\bcommand-/,
    /^o[1-9]([-.]|$)/,
  ];
  if (chatPatterns.some((re) => re.test(m))) return 'chat';
  return null;
}
