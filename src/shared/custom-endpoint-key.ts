/**
 * Identity of a custom endpoint: protocol + base URL.
 *
 * Shared by the main process (config-store, which owns `customEndpoints`) and
 * the renderer (which has to recognise "this URL is already an endpoint" before
 * asking main to create one). Both must agree on what counts as the same
 * endpoint, so the comparison lives in one place.
 */

/** The routing protocols a custom endpoint can speak. */
export type CustomEndpointProtocol = 'anthropic' | 'openai' | 'gemini';

/**
 * Canonical form of a base URL for *comparison*: lowercased host, no trailing
 * slash. Slash and case noise must never be mistaken for user intent — that
 * would read a default URL as a customization, or one gateway as two.
 */
export function canonicalBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hostname = parsed.hostname.toLowerCase();
    // toString() canonicalizes the path, so a trailing slash is already
    // normalized away here; the catch branch below handles it explicitly.
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    // Not a parseable URL — compare the trimmed string rather than dropping it.
    // A malformed base URL is still the user's data.
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Canonical key for deduplicating custom endpoints: protocol + canonical base
 * URL. Two config sets pointing at the same gateway with the same protocol
 * share one endpoint entry, not two.
 */
export function customEndpointKey(protocol: CustomEndpointProtocol, baseUrl: string): string {
  return `${protocol}::${canonicalBaseUrl(baseUrl)}`;
}

/**
 * Default display name for an endpoint: the base URL's host (with port when
 * present), falling back to the raw string. The host is the only name the data
 * itself offers; the user can rename afterwards.
 */
export function defaultCustomEndpointName(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return 'Custom endpoint';
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed;
  }
}
