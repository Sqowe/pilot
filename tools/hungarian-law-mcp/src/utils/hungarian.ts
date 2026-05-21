/**
 * Hungarian-specific utilities: Roman numeral conversion, law ID parsing, etc.
 */

const ROMAN_VALUES: [string, number][] = [
  ['M', 1000],
  ['CM', 900],
  ['D', 500],
  ['CD', 400],
  ['C', 100],
  ['XC', 90],
  ['L', 50],
  ['XL', 40],
  ['X', 10],
  ['IX', 9],
  ['V', 5],
  ['IV', 4],
  ['I', 1],
];

/** Strict regex for valid Roman numerals (1-3999). */
const VALID_ROMAN_REGEX = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i;

/**
 * Validate whether a string is a valid Roman numeral.
 */
export function isValidRoman(roman: string): boolean {
  if (!roman || roman.length === 0) return false;
  return VALID_ROMAN_REGEX.test(roman.toUpperCase());
}

export function romanToArabic(roman: string): number | null {
  if (!isValidRoman(roman)) return null;

  let result = 0;
  let remaining = roman.toUpperCase();

  for (const [numeral, value] of ROMAN_VALUES) {
    while (remaining.startsWith(numeral)) {
      result += value;
      remaining = remaining.slice(numeral.length);
    }
  }

  // Final safety: if there are leftover characters, it's invalid
  if (remaining.length > 0) return null;

  return result;
}

export function arabicToRoman(num: number): string {
  let result = '';
  let remaining = num;

  for (const [numeral, value] of ROMAN_VALUES) {
    while (remaining >= value) {
      result += numeral;
      remaining -= value;
    }
  }

  return result;
}

/**
 * Parse a Hungarian law reference like "2017. évi LXXVIII. törvény"
 * into its components.
 */
export interface LawReference {
  year: number;
  number: number; // Arabic number derived from Roman numeral for törvény
  romanNumber?: string; // Original Roman numeral if applicable
  serialNumber?: number; // For numbered decrees like "191/2009"
  type: string; // e.g., "törvény", "Korm. rendelet"
}

/**
 * Build the njt.hu URL slug for a law.
 * The URL pattern is: /jogszabaly/{year}-{number}-{type_codes}
 *
 * For törvény (acts): year-romanAsArabic-00-00
 * For Korm. rendelet: year-serial-20-22
 */
export function buildNjtSlug(year: number, number: number, type?: string): string {
  // Simple heuristic: if type contains "rendelet", use decree pattern
  if (type && type.toLowerCase().includes('rendelet')) {
    return `${year}-${number}-20-22`;
  }
  // Default: törvény pattern
  return `${year}-${number}-00-00`;
}

/**
 * Parse a law reference string into components.
 * Handles formats like:
 *   "2017. évi LXXVIII. törvény"
 *   "191/2009. (IX. 15.) Korm. rendelet"
 */
export function parseLawReference(ref: string): LawReference | null {
  // Pattern 1: "YYYY. évi ROMAN. törvény"
  const actPattern = /(\d{4})\.\s*évi\s+([IVXLCDM]+)\.\s*(.+)/i;
  const actMatch = ref.match(actPattern);
  if (actMatch) {
    const year = parseInt(actMatch[1], 10);
    const romanNumber = actMatch[2];
    const number = romanToArabic(romanNumber);
    if (number === null) return null; // Invalid Roman numeral
    const type = actMatch[3].trim();
    return { year, number, romanNumber, type };
  }

  // Pattern 2: "NUMBER/YYYY. (...) TYPE"
  const decreePattern = /(\d+)\/(\d{4})\.\s*(?:\([^)]*\)\s*)?(.+)/;
  const decreeMatch = ref.match(decreePattern);
  if (decreeMatch) {
    const serialNumber = parseInt(decreeMatch[1], 10);
    const year = parseInt(decreeMatch[2], 10);
    const type = decreeMatch[3].trim();
    return { year, number: serialNumber, serialNumber, type };
  }

  return null;
}
