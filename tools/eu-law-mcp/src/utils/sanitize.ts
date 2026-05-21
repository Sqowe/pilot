/**
 * Input sanitization utilities for SPARQL query construction.
 * Prevents injection by validating and escaping user inputs.
 */

/**
 * Validate a CELEX number against the expected format.
 * CELEX: sector(1) + year(4) + type(1-2 letters) + number(digits, possibly with dash+digits suffix)
 * Only allows: digits, uppercase/lowercase letters for type, and dash-digit suffixes.
 */
const CELEX_PATTERN = /^[0-9CEce]\d{4}[A-Za-z]{1,2}\d[\dA-Za-z]*(-\d+)*$/;

export function isValidCelex(celex: string): boolean {
  const trimmed = celex.trim();
  // Reject if trimming changed length (had leading/trailing whitespace/newlines)
  if (trimmed !== celex || trimmed.length === 0) return false;
  return CELEX_PATTERN.test(trimmed);
}

/**
 * Validate and sanitize a CELEX number.
 * Returns the sanitized, uppercase-normalized CELEX or null if invalid.
 */
export function sanitizeCelex(celex: string): string | null {
  const trimmed = celex.trim();
  if (!CELEX_PATTERN.test(trimmed)) return null;
  // Normalize: sector stays as-is, type letters to uppercase
  return trimmed.toUpperCase();
}

/**
 * Escape a string for safe use inside a SPARQL literal ("...").
 * Escapes backslashes, double quotes, newlines, carriage returns, and tabs.
 */
export function escapeSparqlLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Validate an ECLI identifier format.
 * ECLI format: ECLI:{country}:{court}:{year}:{number}
 * Example: ECLI:EU:C:2020:559
 */
const ECLI_PATTERN = /^ECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:\d+$/;

export function isValidEcli(ecli: string): boolean {
  return ECLI_PATTERN.test(ecli.trim());
}

/**
 * Sanitize a keyword for use in SPARQL FILTER(CONTAINS(...)).
 * Escapes SPARQL-special characters in the literal.
 */
export function sanitizeKeyword(keyword: string): string {
  return escapeSparqlLiteral(keyword.trim());
}
