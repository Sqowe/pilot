import type {
  AppliedCoreMemoryAction,
  CoreMemoryActionInput,
  CoreMemoryEntry,
} from './memory-types';
import {
  applyCoreMemoryActions,
  coreMemoryToPromptBlock,
  GLOBAL_WORKSPACE_SENTINEL,
  loadJsonFile,
  normalizeWorkspaceKey,
  parseCoreCombinedKey,
  saveJsonFile,
} from './memory-utils';

/**
 * Rich entry format stored on disk (v2).
 * Legacy format (v1) is a plain Record<string, string> — migrated on load.
 */
interface CoreMemoryFileEntry {
  value: string;
  sourceWorkspaces: string[];
  workspacePinned?: boolean;
  /** Workspace hash that scopes this pinned entry. Used to disambiguate pinned entries
   *  from different workspaces that share the same logical key. */
  scopeHash?: string;
}

type CoreMemoryFileFormat = Record<string, string | CoreMemoryFileEntry>;

/**
 * Normalize, deduplicate, and validate a sourceWorkspaces array.
 * Removes non-strings, trims, normalizes paths, and deduplicates.
 */
function sanitizeSourceWorkspaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const trimmed = item.trim();
    // Preserve sentinel values as-is
    if (trimmed === GLOBAL_WORKSPACE_SENTINEL) {
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
      continue;
    }
    const normalized = normalizeWorkspaceKey(trimmed);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export class CoreMemoryStore {
  private readonly memory: Record<string, CoreMemoryFileEntry>;

  constructor(
    private readonly filePath: string,
    private readonly maxItems = 24
  ) {
    const raw = loadJsonFile<CoreMemoryFileFormat>(filePath, {});
    const normalized: Record<string, CoreMemoryFileEntry> = {};
    for (const [key, stored] of Object.entries(raw)) {
      if (!key.trim()) continue;
      if (typeof stored === 'string') {
        // Legacy v1 format: plain string value, no workspace info
        normalized[key.trim()] = { value: stored.trim(), sourceWorkspaces: [] };
      } else if (stored && typeof stored === 'object' && typeof stored.value === 'string') {
        // v2 format: {value, sourceWorkspaces, workspacePinned?, scopeHash?}
        const rawScopeHash = typeof stored.scopeHash === 'string' ? stored.scopeHash : '';
        // Only accept valid hex hashes (16 chars) to prevent injection
        const validScopeHash = /^[a-f0-9]{16}$/.test(rawScopeHash) ? rawScopeHash : undefined;
        normalized[key.trim()] = {
          value: stored.value.trim(),
          sourceWorkspaces: sanitizeSourceWorkspaces(stored.sourceWorkspaces),
          ...(stored.workspacePinned === true ? { workspacePinned: true } : {}),
          ...(validScopeHash ? { scopeHash: validScopeHash } : {}),
        };
      }
    }
    this.memory = normalized;
  }

  getPath(): string {
    return this.filePath;
  }

  getRaw(): Record<string, string> {
    // Return legacy-compatible format for external consumers (UI, etc.)
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(this.memory)) {
      result[key] = entry.value;
    }
    return result;
  }

  getEntries(): CoreMemoryEntry[] {
    return Object.entries(this.memory).map(([storageKey, entry]) => {
      // For pinned entries with scopeHash, the storage key has @hash suffix for uniqueness.
      // Strip it using safe string operations (no regex) for the user-facing key.
      let logicalKey = storageKey;
      if (entry.scopeHash && storageKey.endsWith(`@${entry.scopeHash}`)) {
        logicalKey = storageKey.slice(0, -(entry.scopeHash.length + 1));
      }
      const parsed = parseCoreCombinedKey(logicalKey);
      return {
        ...parsed,
        combinedKey: storageKey, // Keep storage key for internal operations (delete, update)
        value: entry.value,
        sourceWorkspaces: entry.sourceWorkspaces,
        ...(entry.workspacePinned ? { workspacePinned: true } : {}),
        ...(entry.scopeHash ? { scopeHash: entry.scopeHash } : {}),
      };
    });
  }

  /**
   * Get entries filtered for a specific workspace context.
   * Returns entries that are either:
   * - Confirmed across 2+ workspaces (truly global) AND not workspace-pinned
   * - From the current workspace (single-workspace match)
   * - Tagged with the global sentinel (from no-workspace sessions)
   *
   * Excludes:
   * - Legacy entries with no workspace info (unverified — need re-confirmation)
   * - Single-workspace entries that don't match the current workspace
   * - Workspace-pinned entries that don't match the current workspace
   */
  getEntriesForWorkspace(currentWorkspace: string | null): CoreMemoryEntry[] {
    const normalizedCurrent = currentWorkspace ? normalizeWorkspaceKey(currentWorkspace) : null;
    return this.getEntries().filter((entry) => {
      const workspaces = entry.sourceWorkspaces || [];
      // Legacy entries with no workspace info — exclude until re-confirmed
      if (workspaces.length === 0) return false;

      // Workspace-pinned entries: only show in their source workspace(s),
      // even if tagged with the global sentinel.
      if (entry.workspacePinned) {
        if (!normalizedCurrent) return false;
        // Only match concrete workspace paths, not the global sentinel
        return workspaces.some(
          (ws) => ws !== GLOBAL_WORKSPACE_SENTINEL && ws === normalizedCurrent
        );
      }

      // Entries from no-workspace sessions (global sentinel) — always include
      if (workspaces.includes(GLOBAL_WORKSPACE_SENTINEL)) return true;
      // Confirmed across 2+ workspaces — truly global
      if (workspaces.length >= 2) return true;
      // Single workspace — only include if it matches current
      if (normalizedCurrent && workspaces.includes(normalizedCurrent)) return true;
      // Single workspace, doesn't match current — exclude
      return false;
    });
  }

  applyActions(
    actions: CoreMemoryActionInput[],
    sourceWorkspace?: string | null,
    options?: { workspacePinned?: boolean }
  ): AppliedCoreMemoryAction[] {
    const { nextMemory, applied } = applyCoreMemoryActions(
      this.memory,
      actions,
      sourceWorkspace || null,
      options
    );
    const appliedKeys = new Set(
      applied
        .filter((action) => action.op !== 'delete')
        .map((action) => action.combinedKey)
        .filter((key) => Object.prototype.hasOwnProperty.call(nextMemory, key))
    );
    const orderedKeys = [
      ...appliedKeys,
      ...Object.keys(nextMemory).filter((key) => !appliedKeys.has(key)),
    ].slice(0, this.maxItems);
    for (const key of Object.keys(this.memory)) {
      delete this.memory[key];
    }
    for (const key of orderedKeys) {
      this.memory[key] = nextMemory[key];
    }
    this.save();
    return applied;
  }

  clear(): void {
    for (const key of Object.keys(this.memory)) {
      delete this.memory[key];
    }
    this.save();
  }

  toPromptBlock(): string {
    return coreMemoryToPromptBlock(this.memory);
  }

  save(): void {
    saveJsonFile(this.filePath, this.memory);
  }
}
