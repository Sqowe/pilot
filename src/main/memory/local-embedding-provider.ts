/**
 * @module main/memory/local-embedding-provider
 *
 * In-process local embedding provider using @huggingface/transformers (ONNX runtime).
 * No API key, no network calls per query — model is downloaded once on first use
 * and cached under the app's own storage root.
 *
 * Design notes:
 * - Singleton pipeline, lazily created on first call.
 * - Cache dir is pointed at {storageRoot}/models — not the OS-default ~/.cache/huggingface —
 *   so the download lives inside the app's own storage/cleanup story.
 * - dtype fallback: tries 'q8' first (<200MB RAM), then 'fp16', then 'fp32' to maximise
 *   platform compatibility across Electron/ONNX combos.
 * - Model revision is pinned to an immutable commit hash for supply-chain safety.
 * - All active progress listeners are notified (Set-based), so concurrent callers all
 *   receive download events.
 * - Embedding dimension is validated after each inference call.
 */
import * as fs from 'fs';
import * as path from 'path';
import { env, pipeline } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { log, logWarn } from '../utils/logger';

// Locked per design decision D1.
// Revision pinned to a known-good commit for supply-chain safety.
// Re-verify against the live model card before each release to confirm dimension,
// license, and prefix requirements remain unchanged.
export const LOCAL_EMBEDDING_MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';
/**
 * Pinned model revision (immutable commit SHA from HuggingFace Hub, verified 2026-07-02).
 * Update intentionally — do not auto-bump without re-validating embedding quality,
 * dimension output, and license. Verify with:
 *   curl -s https://huggingface.co/api/models/onnx-community/embeddinggemma-300m-ONNX | jq .sha
 */
export const LOCAL_EMBEDDING_MODEL_REVISION = '5090578d9565bb06545b4552f76e6bc2c93e4a66';

/** Native output dimension of EmbeddingGemma-300M (MRL supports 768→128; we use full 768). */
export const LOCAL_EMBEDDING_DIMENSIONS = 768;

/** dtype preference order: most compact/fast first, falling back for compatibility. */
const DTYPE_FALLBACK_ORDER = ['q8', 'fp16', 'fp32'] as const;
type DType = (typeof DTYPE_FALLBACK_ORDER)[number];

export interface LocalEmbeddingProgress {
  status: 'downloading' | 'ready' | 'error';
  /** File being downloaded (present during 'downloading'). */
  file?: string;
  /** Download progress 0–100 (present during 'downloading'). */
  progress?: number;
  /** Error message (present during 'error'). */
  message?: string;
}

// Singleton — created once on first embedLocal() call, reused for all subsequent calls.
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
// Set of active progress listeners — all subscribers receive events so concurrent
// callers (e.g., ingestion + UI) are both notified during download.
const progressListeners = new Set<(p: LocalEmbeddingProgress) => void>();

function notifyListeners(event: LocalEmbeddingProgress): void {
  for (const listener of progressListeners) {
    try {
      listener(event);
    } catch {
      // Never let a listener error break the embedding pipeline.
    }
  }
}

/**
 * Point the HuggingFace cache at the app's own storage root so the model download
 * lives alongside other app data and is easy to locate / delete.
 * Must be called before the first embedLocal() call.
 */
export function configureLocalEmbeddingCacheDir(storageRoot: string): void {
  const cacheDir = path.join(storageRoot, 'models');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    const msg = `[LocalEmbedding] Failed to create cache directory: ${cacheDir} — ${String(err)}`;
    logWarn(msg);
    notifyListeners({ status: 'error', message: msg });
    throw new Error(msg);
  }
  env.cacheDir = cacheDir;
  log('[LocalEmbedding] Cache dir set to:', cacheDir);
}

/**
 * Map the raw progress object emitted by @huggingface/transformers to our typed shape.
 */
function mapProgress(raw: Record<string, unknown>): LocalEmbeddingProgress {
  const status = raw.status as string | undefined;
  if (status === 'progress') {
    return {
      status: 'downloading',
      file: typeof raw.file === 'string' ? raw.file : undefined,
      progress: typeof raw.progress === 'number' ? Math.round(raw.progress) : undefined,
    };
  }
  if (status === 'error') {
    return {
      status: 'error',
      message: typeof raw.message === 'string' ? raw.message : 'Unknown error',
    };
  }
  if (status === 'done' || status === 'ready' || status === 'loaded') {
    return { status: 'ready' };
  }
  return { status: 'downloading' };
}

/**
 * Attempt to load the pipeline with a given dtype.
 * Returns null on failure (so the caller can try the next dtype).
 */
async function tryLoadPipeline(dtype: DType): Promise<FeatureExtractionPipeline | null> {
  try {
    log('[LocalEmbedding] Trying dtype:', dtype);
    const pipe = await (pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL_ID, {
      dtype,
      revision: LOCAL_EMBEDDING_MODEL_REVISION,
      progress_callback: (raw: Record<string, unknown>) => notifyListeners(mapProgress(raw)),
    }) as Promise<FeatureExtractionPipeline>);
    log('[LocalEmbedding] Pipeline loaded successfully with dtype:', dtype);
    return pipe;
  } catch (err) {
    logWarn(`[LocalEmbedding] dtype '${dtype}' failed:`, err);
    return null;
  }
}

function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    log('[LocalEmbedding] Initialising pipeline, model:', LOCAL_EMBEDDING_MODEL_ID);
    pipelinePromise = (async () => {
      for (const dtype of DTYPE_FALLBACK_ORDER) {
        const pipe = await tryLoadPipeline(dtype);
        if (pipe) return pipe;
      }
      const err = new Error(
        `[LocalEmbedding] Failed to load pipeline with all dtypes: ${DTYPE_FALLBACK_ORDER.join(', ')}`
      );
      notifyListeners({ status: 'error', message: err.message });
      throw err;
    })();

    pipelinePromise.catch((err) => {
      logWarn('[LocalEmbedding] Pipeline init failed, will retry on next call:', err);
      pipelinePromise = null;
    });
  }
  return pipelinePromise;
}

/**
 * Embed a single text string using the local ONNX model.
 * First call downloads the model (~180MB on q8); subsequent calls are fast (< 100ms).
 *
 * @param text - Input text to embed (should already be trimmed by the caller).
 * @param onProgress - Optional callback called during first-use model download.
 *   All concurrent callers receive progress events — not just the first one.
 * @returns Float32 embedding vector of length LOCAL_EMBEDDING_DIMENSIONS.
 * @throws If pipeline fails to load on all dtypes, or if the model returns an
 *   unexpected embedding dimension.
 */
export async function embedLocal(
  text: string,
  onProgress?: (p: LocalEmbeddingProgress) => void
): Promise<number[]> {
  // Register listener before awaiting so concurrent callers all receive events,
  // including in-flight download progress from the already-initialising pipeline.
  if (onProgress) {
    progressListeners.add(onProgress);
  }
  try {
    const extractor = await getPipeline();
    // mean pooling + L2 normalisation — standard for retrieval / cosine-similarity scoring.
    const output = await extractor(text, { pooling: 'mean', normalize: true });

    // Robustly extract a flat number[] from whatever transformers.js returns.
    // Versions/backends vary: output may be a Tensor with .data (Float32Array/number[]),
    // a plain number[], or a nested number[][]. Handle all known shapes.
    let embedding: number[];
    const rawData: unknown = output?.data ?? output;
    if (rawData instanceof Float32Array || rawData instanceof Float64Array) {
      embedding = Array.from(rawData);
    } else if (Array.isArray(rawData)) {
      // Flatten one level of nesting (e.g., [[...]] from some pooling outputs)
      const first = rawData[0];
      if (Array.isArray(first) || first instanceof Float32Array || first instanceof Float64Array) {
        embedding = Array.from(first as number[] | Float32Array | Float64Array);
      } else {
        embedding = rawData as number[];
      }
    } else {
      const msg =
        `[LocalEmbedding] Unrecognized output shape from pipeline. ` +
        `type=${typeof rawData}, keys=${rawData !== null && typeof rawData === 'object' ? Object.keys(rawData as object).join(',') : 'n/a'}`;
      notifyListeners({ status: 'error', message: msg });
      throw new Error(msg);
    }

    // Validate dimension — catches model updates or config drift before they
    // silently corrupt downstream similarity calculations.
    if (embedding.length !== LOCAL_EMBEDDING_DIMENSIONS) {
      const msg =
        `[LocalEmbedding] Unexpected embedding dimension: got ${embedding.length}, ` +
        `expected ${LOCAL_EMBEDDING_DIMENSIONS}. Check model card for EmbeddingGemma-300M.`;
      notifyListeners({ status: 'error', message: msg });
      throw new Error(msg);
    }

    return embedding;
  } catch (err) {
    // Emit error to all listeners so UI can reflect failure state.
    const message = err instanceof Error ? err.message : String(err);
    notifyListeners({ status: 'error', message });
    throw err;
  } finally {
    // Deregister after call completes (success or failure).
    if (onProgress) {
      progressListeners.delete(onProgress);
    }
  }
}

/**
 * Reset the singleton pipeline — primarily for testing.
 * Also called when the model cache is deleted so the next embedLocal() re-downloads.
 */
export function resetLocalEmbeddingPipeline(): void {
  pipelinePromise = null;
  progressListeners.clear();
}
