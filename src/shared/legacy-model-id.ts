/**
 * Spellings of a model id that older versions stored and the pi-ai registry
 * does not list as written:
 *
 * - `gemini/gemini-*` — pi-ai's google provider uses the bare id.
 * - `anthropic/claude-sonnet-4-5` on OpenRouter — the registry spells the
 *   version with a dot (`4.5`).
 *
 * Shared by the main process, which applies it to every config set it
 * normalizes, and the renderer, which applies it when a stored model is loaded
 * into the form. Both must agree, or the form shows one id while a chat runs on
 * another — and nothing reads as unsaved, because the form compares against
 * what it loaded.
 *
 * Idempotent.
 */
export function normalizeLegacyModelId(provider: string, model: string): string {
  const trimmed = model.trim();
  const withoutGeminiPrefix = trimmed.startsWith('gemini/')
    ? trimmed.slice('gemini/'.length)
    : trimmed;
  if (provider === 'openrouter') {
    // One or two digits only: a dated id (`…-4-20250514`) is not a version
    // written with a dash, and must be left as typed.
    return withoutGeminiPrefix.replace(
      /^(anthropic\/claude-(?:sonnet|opus|haiku)-\d+)-(\d{1,2})(?!\d)/,
      '$1.$2'
    );
  }
  return withoutGeminiPrefix;
}
