/**
 * @module renderer/utils/schedule-helpers
 *
 * Shared utility functions for scheduler v2 UI logic.
 * Extracted for testability and reuse across components.
 */

/**
 * Parse a budget field string into a validated positive integer (or null).
 * @param value - The raw string input from the form
 * @param multiplier - Multiplier to apply (e.g., 60000 for minutes→ms)
 * @returns The validated integer value, or null if empty/invalid
 */
export function parseBudgetField(value: string, multiplier: number): number | null {
  if (!value.trim()) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const result = Math.round(num * multiplier);
  if (result <= 0 || result > Number.MAX_SAFE_INTEGER) return null;
  return result;
}

/**
 * Resolve a configSetId against available config sets.
 * Returns the configSetId if valid, or null if not found (caller must handle).
 * Special case: 'default' is always considered valid (it's the system fallback).
 */
export function resolveConfigSetId(
  configSetId: string,
  configSets: Array<{ id: string }>
): string | null {
  // 'default' is always valid — it's the system config set
  if (configSetId === 'default') return 'default';
  // If configSets is empty (not loaded yet), allow the current selection
  if (configSets.length === 0) return configSetId;
  // Validate against available sets
  if (configSets.some((s) => s.id === configSetId)) {
    return configSetId;
  }
  return null;
}
