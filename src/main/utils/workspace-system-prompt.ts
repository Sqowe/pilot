/**
 * @module main/utils/workspace-system-prompt
 *
 * Loads an optional workspace-level instructions file and returns its text
 * plus a lightweight fingerprint for session-cache invalidation.
 *
 * The user picks a filename from a short whitelist in Settings → General
 * (e.g. CLAUDE.md, AGENTS.md, memory.md). When the chosen file exists at the
 * session's working directory root, its contents are appended to the default
 * Cowork system prompt so the model treats them as last-word project
 * instructions. When no choice is made, or the file is absent, the loader
 * returns null and callers keep the default prompt.
 *
 * The returned `fingerprint` is a sha256 of `${realPath}\0${mtimeMs}\0${size}`.
 * It changes whenever the file is edited, replaced, or the chosen filename
 * changes — cheap to compute and enough for cache invalidation without reading
 * the file twice.
 *
 * Safety:
 * - Only whitelisted filenames are accepted (no arbitrary paths).
 * - The resolved real path must stay within the working directory root
 *   (blocks `..` escape and symlink-based escape).
 * - Contents larger than MAX_BYTES are truncated with a trailing marker.
 * - Any I/O or decoding error falls back to null — the default prompt wins.
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
   * Stable fingerprint of the loaded file: sha256(realPath + mtimeMs + size).
   * Used to invalidate cached pi sessions when the file changes.
   */
  fingerprint: string;
}

/**
 * Try to load the workspace system-prompt file.
 *
 * Returns the trimmed file contents plus a fingerprint on success, or null
 * when:
 *  - no choice is configured
 *  - choice is not in the whitelist
 *  - cwd is missing or not a directory
 *  - file does not exist, is not a regular file, or is unreadable
 *  - resolved path escapes cwd
 */
export async function loadWorkspaceSystemPrompt(
  cwd: string | undefined,
  rawChoice: unknown
): Promise<WorkspaceInstructions | null> {
  if (!isValidSystemPromptFileChoice(rawChoice) || rawChoice === '') {
    return null;
  }
  const choice: string = rawChoice;

  if (!cwd || typeof cwd !== 'string') {
    return null;
  }

  const absoluteCwd = path.resolve(cwd);
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
      // Fingerprint from content (not mtime/size) so filesystems with coarse
      // mtime resolution still detect same-size edits landing inside one
      // timestamp tick. Includes realPath so selecting a different file with
      // identical contents also invalidates — cheap belt-and-braces.
      const fingerprint = createHash('sha256')
        .update(`${realCandidate}\0${finalText}`)
        .digest('hex');
      log(
        '[WorkspaceSystemPrompt] Loaded workspace instructions:',
        choice,
        `(${bytesRead} bytes${truncated ? ', truncated' : ''})`
      );
      return { text: finalText, fingerprint };
    } finally {
      await handle.close();
    }
  } catch (error) {
    logWarn('[WorkspaceSystemPrompt] Failed to load', choice, error);
    return null;
  }
}
