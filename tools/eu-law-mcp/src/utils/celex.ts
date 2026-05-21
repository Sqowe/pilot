/**
 * CELEX number utilities.
 *
 * CELEX is the unique identifier for EU legal documents.
 * Format: {sector}{year}{type}{number}
 *
 * Sectors:
 *   1 = Treaties
 *   2 = International agreements
 *   3 = Legislation (regulations, directives, decisions)
 *   4 = Complementary legislation
 *   5 = Preparatory acts (COM, JOIN, SEC, SWD)
 *   6 = Case-law
 *   7 = National transposition measures
 *   8 = References to national case-law
 *   9 = Parliamentary questions
 *   0 = Consolidated texts
 *   C = Other documents published in OJ C
 *   E = EFTA documents
 *
 * Examples:
 *   32024R1689 = Regulation (EU) 2024/1689 (AI Act)
 *   32016R0679 = Regulation (EU) 2016/679 (GDPR)
 *   32000L0031 = Directive 2000/31/EC (e-Commerce)
 *   62019CJ0311 = CJEU Case C-311/19 (Schrems II)
 */

export interface CelexComponents {
  sector: string;
  year: string;
  type: string;
  number: string;
}

/**
 * Parse a CELEX number into its components.
 */
export function parseCelex(celex: string): CelexComponents | null {
  // Pattern: sector(1 char) + year(4 digits) + type(1-2 chars) + number(variable)
  const match = celex.match(/^([0-9CEce])(\d{4})([A-Za-z]{1,2})(\d+.*)$/);
  if (!match) return null;

  return {
    sector: match[1].toUpperCase(),
    year: match[2],
    type: match[3].toUpperCase(),
    number: match[4],
  };
}

/**
 * Build EUR-Lex URLs from a CELEX number.
 */
export function buildEurLexUrls(celex: string, language = 'EN') {
  const base = 'https://eur-lex.europa.eu/legal-content';
  return {
    html: `${base}/${language}/TXT/HTML/?uri=CELEX:${celex}`,
    pdf: `${base}/${language}/TXT/PDF/?uri=CELEX:${celex}`,
    page: `${base}/${language}/TXT/?uri=CELEX:${celex}`,
    allFormats: `${base}/${language}/ALL/?uri=CELEX:${celex}`,
  };
}

/**
 * Describe the document type from CELEX type code.
 */
export function describeType(type: string): string {
  const types: Record<string, string> = {
    R: 'Regulation',
    L: 'Directive',
    D: 'Decision',
    F: 'Decision (ECSC)',
    H: 'Recommendation',
    A: 'Opinion',
    O: 'Other act',
    X: 'Other document',
    G: 'Resolution',
    B: 'Budget',
    K: 'ECSC Recommendation',
    J: 'Non-opposition to notified concentration',
    M: 'Non-opposition to notified State aid',
    Q: 'Institutional arrangement',
    S: 'EFTA Surveillance Authority Decision',
    E: 'EEA Joint Committee Decision',
    CJ: 'Judgment of the Court of Justice',
    TJ: 'Judgment of the General Court',
    FJ: 'Judgment of the Civil Service Tribunal',
    CC: 'Opinion of the Court of Justice',
    CO: 'Order of the Court of Justice',
    TO: 'Order of the General Court',
    TA: 'Opinion of Advocate General',
    PC: 'Proposal for a Regulation',
    DC: 'Proposal for a Directive',
    SC: 'Staff Working Document',
  };
  return types[type] ?? `Type ${type}`;
}

/**
 * Describe the sector from CELEX sector code.
 */
export function describeSector(sector: string): string {
  const sectors: Record<string, string> = {
    '1': 'Treaties',
    '2': 'International agreements',
    '3': 'Legislation',
    '4': 'Complementary legislation',
    '5': 'Preparatory acts',
    '6': 'Case-law',
    '7': 'National transposition',
    '8': 'National case-law references',
    '9': 'Parliamentary questions',
    '0': 'Consolidated texts',
    C: 'OJ C documents',
    E: 'EFTA documents',
  };
  return sectors[sector] ?? `Sector ${sector}`;
}
