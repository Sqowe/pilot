/**
 * @module shared/path-permissions/containment
 *
 * Pure string comparison: is one path inside another. No file-system access —
 * callers that care about symbolic links resolve real paths first (see
 * `resolve.ts`).
 *
 * Relocated from `src/main/tools/path-containment.ts`, which re-exports these
 * so its importers are unchanged.
 */

export function normalizePathForContainment(pathValue: string, caseInsensitive = false): string {
  const normalized = pathValue.replace(/[\\/]+/g, '/').replace(/\/+$/, '');

  if (!normalized) {
    return pathValue.includes('/') || pathValue.includes('\\') ? '/' : '';
  }

  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function isPathWithinRoot(
  targetPath: string,
  rootPath: string,
  caseInsensitive = false
): boolean {
  const normalizedTarget = normalizePathForContainment(targetPath, caseInsensitive);
  const normalizedRoot = normalizePathForContainment(rootPath, caseInsensitive);

  if (!normalizedTarget || !normalizedRoot) {
    return false;
  }

  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix);
}
