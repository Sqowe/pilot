/**
 * Language code mapping for EU Cellar SPARQL queries.
 *
 * EUR-Lex URLs use 2-letter codes (EN, FR, DE).
 * Cellar SPARQL authority URIs use 3-letter codes (ENG, FRA, DEU).
 */

const TWO_TO_THREE: Record<string, string> = {
  BG: 'BUL',
  CS: 'CES',
  DA: 'DAN',
  DE: 'DEU',
  EL: 'ELL',
  EN: 'ENG',
  ES: 'SPA',
  ET: 'EST',
  FI: 'FIN',
  FR: 'FRA',
  GA: 'GLE',
  HR: 'HRV',
  HU: 'HUN',
  IT: 'ITA',
  LT: 'LIT',
  LV: 'LAV',
  MT: 'MLT',
  NL: 'NLD',
  PL: 'POL',
  PT: 'POR',
  RO: 'RON',
  SK: 'SLK',
  SL: 'SLV',
  SV: 'SWE',
};

/**
 * Convert a 2-letter language code to the 3-letter Cellar authority code.
 * Returns the 3-letter code, or null if the input is not a valid EU language.
 */
export function toCellarLang(twoLetter: string): string | null {
  const upper = twoLetter.toUpperCase().trim();
  return TWO_TO_THREE[upper] ?? null;
}

/**
 * Validate that a language code is a supported EU language (2-letter).
 */
export function isValidEuLanguage(code: string): boolean {
  return code.toUpperCase().trim() in TWO_TO_THREE;
}

/**
 * Get all supported 2-letter language codes.
 */
export function supportedLanguages(): string[] {
  return Object.keys(TWO_TO_THREE);
}
