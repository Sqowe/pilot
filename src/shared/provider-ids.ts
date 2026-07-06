/**
 * @module shared/provider-ids
 *
 * Shared utilities for provider id and profile key normalization/validation.
 * Imported by both main process (config-store) and renderer (useApiConfigState)
 * to ensure identical behavior at all persistence boundaries.
 */

// ---------------------------------------------------------------------------
// Dangerous object prototype keys — must be rejected as provider ids to
// prevent prototype-chain surprises when provider ids are used as object keys.
// ---------------------------------------------------------------------------
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Normalize a provider id value from persisted config:
 * - Trims whitespace
 * - Rejects non-strings, empty strings, 'local' (reserved for embedding), and
 *   dangerous object prototype keys (__proto__, constructor, prototype)
 *
 * Returns the canonical trimmed id, or undefined if invalid.
 */
export function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'local') return undefined; // reserved for EmbeddingProviderType
  if (DANGEROUS_KEYS.has(trimmed)) return undefined;
  return trimmed;
}

/**
 * Type guard for any valid provider id (builtin or native).
 * Uses normalizeProviderId so all restrictions are applied consistently.
 */
export function isValidProviderId(value: unknown): value is string {
  return normalizeProviderId(value) !== undefined;
}

/** The 6 builtin provider ids. */
export const BUILTIN_PROVIDER_ID_LIST = [
  'openrouter',
  'anthropic',
  'custom',
  'openai',
  'gemini',
  'ollama',
] as const;

export type BuiltinProviderIdTuple = typeof BUILTIN_PROVIDER_ID_LIST;

/** Type guard for the 6 legacy builtin provider ids (trims before checking). */
export function isBuiltinProviderId(value: unknown): boolean {
  const normalized = normalizeProviderId(value);
  if (!normalized) return false;
  return (BUILTIN_PROVIDER_ID_LIST as readonly string[]).includes(normalized);
}

/** The 8 builtin profile keys. */
export const BUILTIN_PROFILE_KEY_LIST = [
  'openrouter',
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'custom:anthropic',
  'custom:openai',
  'custom:gemini',
] as const;

/**
 * Type guard for valid profile keys — strict canonical form required:
 * - Builtin: one of the 8 fixed keys
 * - Native: `native:<canonical-provider-id>` where the suffix must already be
 *   in canonical form (trimmed, not 'local', not a dangerous key). Non-canonical
 *   forms like `native: zai ` are rejected to prevent duplicate credential slots.
 */
export function isValidProfileKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if ((BUILTIN_PROFILE_KEY_LIST as readonly string[]).includes(value)) return true;
  if (value.startsWith('native:')) {
    const suffix = value.slice('native:'.length);
    const canonical = normalizeProviderId(suffix);
    // Strict: suffix must already equal its canonical form (no surrounding whitespace)
    return canonical !== undefined && canonical === suffix;
  }
  return false;
}

/**
 * Returns true if the profile key is a native provider slot (`native:*`).
 * Use this to gate logic that should behave differently for native vs builtin providers.
 */
export function isNativeProfileKey(value: string): boolean {
  if (!value.startsWith('native:')) return false;
  const suffix = value.slice('native:'.length);
  const canonical = normalizeProviderId(suffix);
  return canonical !== undefined && canonical === suffix;
}

/**
 * Derive the canonical profile key for a provider id + optional custom protocol.
 * Canonicalizes the provider id before key generation.
 */
export function deriveProfileKey(
  providerId: string,
  customProtocol?: 'anthropic' | 'openai' | 'gemini'
): string {
  const canonical = normalizeProviderId(providerId) ?? 'openrouter';
  if (canonical === 'custom') {
    if (customProtocol === 'openai') return 'custom:openai';
    if (customProtocol === 'gemini') return 'custom:gemini';
    return 'custom:anthropic';
  }
  if ((BUILTIN_PROVIDER_ID_LIST as readonly string[]).includes(canonical)) {
    return canonical;
  }
  return `native:${canonical}`;
}

/**
 * Recover the provider id and routing protocol from a profile key.
 * Handles corrupted/edge-case `native:*` keys defensively.
 */
export function profileKeyToProviderInfo(profileKey: string): {
  provider: string;
  customProtocol: 'anthropic' | 'openai' | 'gemini';
} {
  if (profileKey === 'ollama') return { provider: 'ollama', customProtocol: 'openai' };
  if (profileKey === 'custom:openai') return { provider: 'custom', customProtocol: 'openai' };
  if (profileKey === 'custom:gemini') return { provider: 'custom', customProtocol: 'gemini' };
  if (profileKey === 'custom:anthropic') return { provider: 'custom', customProtocol: 'anthropic' };
  if (profileKey === 'openai') return { provider: 'openai', customProtocol: 'openai' };
  if (profileKey === 'gemini') return { provider: 'gemini', customProtocol: 'gemini' };
  if (profileKey.startsWith('native:')) {
    const suffix = normalizeProviderId(profileKey.slice('native:'.length));
    // Defensive: corrupted suffix falls back to openrouter
    if (!suffix) return { provider: 'openrouter', customProtocol: 'anthropic' };
    return { provider: suffix, customProtocol: 'anthropic' };
  }
  // Remaining builtin keys (openrouter, anthropic)
  return { provider: profileKey, customProtocol: 'anthropic' };
}
