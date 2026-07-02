/**
 * @module main/utils/workspace-system-prompt
 *
 * Loads workspace-level instructions by scanning a priority-ordered list of
 * candidate filenames and returning the first one that exists and is readable.
 *
 * The user configures an ordered list of candidates (e.g. ['CLAUDE.md',
 * 'AGENTS.md', ...]). At session start the loader tries each in order and
 * injects the first winner as last-word guidance. If none exist, or the
 * feature is disabled, the loader returns null and callers use the default
 * system prompt unchanged.
 *
 * Per-candidate hardening (all preserved from the original single-file loader):
 * - Only whitelisted filenames are accepted (no arbitrary paths).
 * - The resolved real path must stay within the working directory root
 *   (blocks `..` escape and symlink-based escape).
 * - An empty or whitespace-only file is treated as absent (loop continues).
 * - Contents larger than MAX_BYTES are truncated with a trailing marker.
 * - Any I/O or decoding error skips the candidate; a bad entry never blocks
 *   a lower-priority valid file.
 * - A sha256 fingerprint of `${realPath}\0${text}` is returned for
 *   session-cache invalidation. Same bytes → same fingerprint → no churn.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { log, logWarn } from './logger';
import { isPathWithinRoot } from '../tools/path-containment';
import {
  SYSTEM_PROMPT_FILE_CHOICES,
  isValidSystemPromptFileChoice,
  type SystemPromptFileChoice,
} from '../../shared/system-prompt-file-choices';

export { SYSTEM_PROMPT_FILE_CHOICES, isValidSystemPromptFileChoice, type SystemPromptFileChoice };

/** 64 KB is plenty for project-level guidance and keeps token usage sane. */
export const MAX_BYTES = 64 * 1024;

const TRUNCATION_MARKER = '\n\n[... truncated: workspace instructions exceed 64 KB ...]';

export interface WorkspaceInstructions {
  /** Trimmed, possibly-truncated file contents to append to the system prompt. */
  text: string;
  /**
   * Stable fingerprint of the loaded file: sha256(realPath + text).
   * Used to invalidate cached pi sessions when the file changes.
   */
  fingerprint: string;
  /**
   * The candidate filename that won (relative name, e.g. 'CLAUDE.md').
   * Populated by the priority-list resolver; empty string when loaded via
   * the legacy single-choice path.
   */
  resolvedFile: string;
  /**
   * Whether the file exceeded MAX_BYTES and was truncated. Computed exactly
   * from the raw byte count (before trim), so callers don't have to re-derive
   * it from the returned text length — which is unreliable because trimming
   * can shrink a genuinely-truncated payload back below MAX_BYTES.
   */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Call-site helper — centralized config normalization
// ---------------------------------------------------------------------------

/**
 * Normalize workspace-instructions config from the store into the canonical
 * `{ enabled, priority }` shape that `loadWorkspaceSystemPrompt` expects.
 *
 * Handles:
 * - Strict boolean coercion for `enabled` (only `true` enables; any other
 *   value, including truthy non-booleans like "false" or 1, is treated as
 *   disabled).
 * - Non-string / non-array filtering for `priority`.
 * - Legacy fallback: when the new keys are absent (pre-migration on-disk
 *   read before `ensureNormalized` has run), falls back to reading
 *   `systemPromptFile` so existing users never lose workspace instructions
 *   across an upgrade even on first launch.
 */
export function resolveWorkspaceInstructionsConfig(store: {
  get(key: 'systemPromptFileEnabled'): unknown;
  get(key: 'systemPromptFilePriority'): unknown;
  get(key: 'systemPromptFile'): unknown;
}): { enabled: boolean; priority: string[] } {
  const rawEnabled = store.get('systemPromptFileEnabled');
  const rawPriority = store.get('systemPromptFilePriority');
  const rawLegacy = store.get('systemPromptFile');

  const hasNew = typeof rawEnabled === 'boolean' || Array.isArray(rawPriority);

  if (hasNew) {
    // New fields present. Precedence rules:
    // - explicit boolean false  → always disabled (even if priority is non-empty)
    // - explicit boolean true   → always enabled
    // - null/undefined enabled  → infer from priority (non-empty → enabled)
    // - any other non-boolean   → treat as absent (same as null/undefined)
    // This ensures new config always wins over legacy and non-boolean values
    // from corrupt/migrating state don't unexpectedly enable instructions.
    const priority = Array.isArray(rawPriority)
      ? rawPriority.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    let enabled: boolean;
    if (typeof rawEnabled === 'boolean') {
      enabled = rawEnabled;
    } else if (rawEnabled == null) {
      // Key absent or explicitly null/undefined → infer from priority.
      enabled = priority.length > 0;
    } else {
      // Non-boolean, non-null value (e.g. "false", 1) → treat as disabled.
      // Corrupt/typed-wrong values should not silently enable instructions.
      enabled = false;
    }
    return { enabled, priority };
  }

  // Legacy fallback: new keys absent (pre-migration first launch).
  // Infer enabled from whether a specific file was selected.
  if (
    typeof rawLegacy === 'string' &&
    rawLegacy !== '' &&
    isValidSystemPromptFileChoice(rawLegacy)
  ) {
    return { enabled: true, priority: [rawLegacy] };
  }

  // Legacy was '' (None) or absent — disabled.
  return { enabled: false, priority: [] };
}

// ---------------------------------------------------------------------------
// Internal single-candidate loader (extracted from the original function body)
// ---------------------------------------------------------------------------

/**
 * Try to load one candidate file from `cwd`.
 * Returns the trimmed text + fingerprint on success, or null when:
 *  - `choice` is not in the whitelist
 *  - file does not exist, is not a regular file, or is unreadable
 *  - resolved path escapes cwd
 *  - file is empty or whitespace-only
 */
async function tryLoadOne(
  absoluteCwd: string,
  choice: string
): Promise<Omit<WorkspaceInstructions, 'resolvedFile'> | null> {
  if (!isValidSystemPromptFileChoice(choice) || choice === '') {
    return null;
  }

  const candidate = path.resolve(absoluteCwd, choice);

  // Containment check against the raw resolved path first — catches `..` traversal.
  if (!isPathWithinRoot(candidate, absoluteCwd, process.platform === 'win32')) {
    logWarn(
      '[WorkspaceSystemPrompt] Rejected choice that resolves outside cwd:',
      choice,
      '->',
      candidate
    );
    return null;
  }

  try {
    // Resolve symlinks and re-check containment so symlinks pointing outside cwd are rejected.
    const realCwd = await fs.promises.realpath(absoluteCwd);
    let realCandidate: string;
    try {
      realCandidate = await fs.promises.realpath(candidate);
    } catch {
      // File doesn't exist — silent fallback.
      return null;
    }

    if (!isPathWithinRoot(realCandidate, realCwd, process.platform === 'win32')) {
      logWarn(
        '[WorkspaceSystemPrompt] Rejected symlink that escapes cwd:',
        choice,
        '->',
        realCandidate
      );
      return null;
    }

    const stat = await fs.promises.stat(realCandidate);
    if (!stat.isFile()) {
      return null;
    }

    // Read up to MAX_BYTES + 1 so we can detect oversize without loading huge files.
    const handle = await fs.promises.open(realCandidate, 'r');
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES + 1, 0);
      const truncated = bytesRead > MAX_BYTES;
      const sliceLength = truncated ? MAX_BYTES : bytesRead;
      const text = buffer.slice(0, sliceLength).toString('utf8').trim();
      if (!text) {
        return null;
      }
      const finalText = truncated ? `${text}${TRUNCATION_MARKER}` : text;
      const fingerprint = createHash('sha256')
        .update(`${realCandidate}\0${finalText}`)
        .digest('hex');
      log(
        '[WorkspaceSystemPrompt] Loaded workspace instructions:',
        choice,
        `(${bytesRead} bytes${truncated ? ', truncated' : ''})`
      );
      return { text: finalText, fingerprint, truncated };
    } finally {
      await handle.close();
    }
  } catch (error) {
    logWarn('[WorkspaceSystemPrompt] Failed to load', choice, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — priority-list resolver
// ---------------------------------------------------------------------------

/**
 * Resolve workspace instructions from an ordered priority list.
 *
 * Iterates `priority` in order and returns the first candidate that exists,
 * is safely within `cwd`, and has non-empty content. Per-candidate hardening
 * (path containment, symlink escape, isFile, 64 KB cap, content fingerprint)
 * is applied to every entry; a candidate that fails any check is skipped so a
 * bad entry never blocks a lower-priority valid file.
 *
 * Returns null when:
 *  - `enabled` is false
 *  - `cwd` is absent or not a string
 *  - no candidate in `priority` resolves successfully
 */
export async function loadWorkspaceSystemPrompt(
  cwd: string | undefined,
  priority: readonly string[],
  enabled: boolean
): Promise<WorkspaceInstructions | null>;

/**
 * @deprecated Use the three-argument priority-list form.
 * Legacy single-choice form kept for the migration window (Phase 5 will
 * remove the last callers).  Behaves identically to the original loader:
 * returns null when `rawChoice` is empty/invalid, otherwise tries to load
 * that one file.
 */
export async function loadWorkspaceSystemPrompt(
  cwd: string | undefined,
  rawChoice: unknown
): Promise<WorkspaceInstructions | null>;

export async function loadWorkspaceSystemPrompt(
  cwd: string | undefined,
  priorityOrChoice: readonly string[] | unknown,
  enabled?: boolean
): Promise<WorkspaceInstructions | null> {
  if (!cwd || typeof cwd !== 'string') return null;
  const absoluteCwd = path.resolve(cwd);

  // Verify cwd is an existing directory before attempting any candidate loads.
  try {
    const cwdStat = await fs.promises.stat(absoluteCwd);
    if (!cwdStat.isDirectory()) return null;
  } catch {
    return null;
  }

  // Priority-list form (three-arg or array second arg).
  if (Array.isArray(priorityOrChoice)) {
    if (!enabled) return null;
    for (const choice of priorityOrChoice) {
      // Skip non-string and blank entries defensively — corrupt config must not throw.
      if (typeof choice !== 'string') continue;
      const normalized = choice.trim();
      if (!normalized) continue;
      const result = await tryLoadOne(absoluteCwd, normalized);
      if (result) return { ...result, resolvedFile: normalized };
    }
    return null;
  }

  // Legacy single-choice form.
  const rawChoice = priorityOrChoice;
  if (!isValidSystemPromptFileChoice(rawChoice) || rawChoice === '') return null;
  const result = await tryLoadOne(absoluteCwd, rawChoice as string);
  return result ? { ...result, resolvedFile: '' } : null;
}

// ---------------------------------------------------------------------------
// Pure status helper — shared by IPC handler and tests
// ---------------------------------------------------------------------------

/**
 * Compute the full WorkspaceInstructionsStatus for the given config store and
 * working directory. Extracted from the IPC handler so tests can exercise the
 * real logic without duplicating it.
 *
 * Contract:
 * - `configuredFile` = first entry in the resolved priority list.
 *   Populated even when disabled so the UI can show what would be used.
 *   Empty string only when no priority list exists (fresh install, no config).
 * - `resolvedFile`   = the candidate that actually won; empty string when not loaded.
 */
export async function computeWorkspaceInstructionsStatus(
  store: Parameters<typeof resolveWorkspaceInstructionsConfig>[0],
  cwd: string | undefined
): Promise<import('../../shared/workspace-instructions-status').WorkspaceInstructionsStatus> {
  const { enabled, priority } = resolveWorkspaceInstructionsConfig(store);
  const configuredFile = priority.length > 0 ? priority[0] : '';

  if (!enabled) {
    return { configuredFile, resolvedFile: '', loaded: false };
  }

  const result = await loadWorkspaceSystemPrompt(cwd, priority, true);
  if (result) {
    const sizeBytes = Buffer.byteLength(result.text, 'utf8');
    return {
      configuredFile,
      resolvedFile: result.resolvedFile,
      loaded: true,
      sizeBytes,
      truncated: result.truncated,
      fingerprintShort: result.fingerprint.slice(0, 8),
    };
  }
  return {
    configuredFile,
    resolvedFile: '',
    loaded: false,
    error: `No workspace instructions file found (searched: ${
      priority.length ? priority.join(', ') : '(none)'
    })`,
  };
}
