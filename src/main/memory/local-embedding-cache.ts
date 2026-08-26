/**
 * @module main/memory/local-embedding-cache
 *
 * Lightweight filesystem helpers for the local embedding model cache.
 * This module intentionally does NOT import @huggingface/transformers so it
 * can be used in IPC handlers (isLocalModelDownloaded, removeLocalModelCache)
 * without pulling the heavy ML dependency into the main process startup path.
 *
 * The pipeline reset callback is injected by local-embedding-provider.ts so
 * this module stays dependency-free.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Locked model ID — must stay in sync with local-embedding-provider.ts. */
export const LOCAL_EMBEDDING_MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';

/**
 * Resolves and validates the model cache directory for a given storageRoot.
 * Rejects empty/whitespace roots (would resolve to process.cwd() via path.resolve,
 * which could target non-app directories on deletion).
 * Relative paths are resolved to absolute via path.resolve — callers should always
 * pass an absolute path; relative support is a fallback for legacy configs.
 */
export function resolveModelCacheDir(storageRoot: string): string {
  if (!storageRoot || !storageRoot.trim()) {
    throw new Error('[LocalEmbedding] storageRoot must not be empty or whitespace');
  }
  // Resolve to absolute (handles legacy relative configs without breaking them)
  const normalized = path.resolve(storageRoot.trim());
  // cacheDir is always a direct child of normalized — no traversal possible here.
  // The authoritative containment guard is the realpath check in removeLocalModelCache.
  const cacheDir = path.join(normalized, 'models');
  return cacheDir;
}

/**
 * Returns true if the local model has already been downloaded to the cache dir.
 * Checks for the presence of the model directory — does not validate file integrity.
 */
export function isLocalModelDownloaded(storageRoot: string): boolean {
  try {
    const cacheDir = resolveModelCacheDir(storageRoot);
    // HuggingFace Hub caches under models/models--<org>--<repo>/
    const modelSlug = LOCAL_EMBEDDING_MODEL_ID.replace('/', '--');
    const modelDir = path.join(cacheDir, `models--${modelSlug}`);
    return fs.existsSync(modelDir);
  } catch {
    return false;
  }
}

/**
 * Deletes only the specific model directory for the local embedding model.
 * Returns true if the directory existed and was deleted, false if it did not exist.
 * Throws on permission/IO errors or invalid storageRoot.
 *
 * Deletes only `<storageRoot>/models/models--<model-slug>/` rather than the
 * entire `models/` directory, so other cached models (if any) are unaffected.
 *
 * Re-validates via realpath immediately before deletion to reduce TOCTOU risk.
 *
 * @param onDeleted - Optional callback invoked after successful deletion (used by
 *   local-embedding-provider to reset the singleton pipeline).
 */
export async function removeLocalModelCache(
  storageRoot: string,
  onDeleted?: () => void
): Promise<boolean> {
  const normalizedRoot = path.resolve(storageRoot.trim());

  // Safety guard: validate BEFORE any filesystem probes.
  // Reject filesystem/drive roots and very-short paths that would make the
  // containment check ineffective (e.g., '/' contains everything).
  // Require at least 2 path segments (e.g., /home/user, C:\Users\user).
  if (!storageRoot || !storageRoot.trim()) {
    throw new Error('[LocalEmbedding] storageRoot must not be empty or whitespace');
  }
  const rootSegments = normalizedRoot.split(path.sep).filter(Boolean);
  if (rootSegments.length < 2) {
    throw new Error(
      `[LocalEmbedding] storageRoot is too close to filesystem root and is not allowed for deletion: ${normalizedRoot}`
    );
  }

  const cacheDir = path.join(normalizedRoot, 'models');
  const modelSlug = LOCAL_EMBEDDING_MODEL_ID.replace('/', '--');
  const modelDir = path.join(cacheDir, `models--${modelSlug}`);

  // Check existence — only swallow ENOENT; rethrow permission/IO errors.
  try {
    await fs.promises.access(modelDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw e;
  }

  // Use the same normalized root as resolveModelCacheDir (trimmed + resolved to absolute)
  // so realpath containment check is consistent with the path used to build modelDir.
  let realStorageRoot: string;
  try {
    realStorageRoot = await fs.promises.realpath(normalizedRoot);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // storageRoot doesn't exist — model cache can't exist either.
    if (code === 'ENOENT') return false;
    throw e;
  }

  // Resolve the cacheDir too so containment is validated against realCacheDir,
  // not just realStorageRoot. This prevents a storageRoot='/' from making
  // the containment check trivially pass for any path on the filesystem.
  let realCacheDir: string;
  try {
    realCacheDir = await fs.promises.realpath(cacheDir);
  } catch {
    // cacheDir doesn't exist — model can't be there
    realCacheDir = path.join(realStorageRoot, 'models');
  }

  let realModelDir: string;
  try {
    realModelDir = await fs.promises.realpath(modelDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw e;
  }

  // Validate within realCacheDir (not just realStorageRoot) to prevent symlink
  // escapes that stay within storageRoot but target unrelated model directories.
  const relToCache = path.relative(realCacheDir, realModelDir);
  if (relToCache.startsWith('..') || path.isAbsolute(relToCache)) {
    throw new Error(
      `[LocalEmbedding] Model dir resolves outside cache dir after symlink resolution: ${realModelDir}`
    );
  }

  // Delete without force: treat ENOENT from rm() as already-removed (race/TOCTOU case).
  // Other errors (EPERM, EBUSY, etc.) are propagated to the caller.
  try {
    await fs.promises.rm(realModelDir, { recursive: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Directory disappeared between realpath() and rm() — desired state achieved.
      onDeleted?.();
      return true;
    }
    throw e;
  }
  // Notify caller (e.g., reset pipeline singleton) after successful deletion.
  onDeleted?.();
  return true;
}
