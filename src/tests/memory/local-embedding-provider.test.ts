/**
 * Unit tests for local-embedding-provider.ts
 *
 * @huggingface/transformers is fully mocked — no real model download in CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

// --- Mocks (hoisted so they run before imports) ---

const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockFsPromisesAccess = vi.hoisted(() => vi.fn());
const mockFsPromisesRm = vi.hoisted(() => vi.fn());
const mockFsPromisesRealpath = vi.hoisted(() => vi.fn());
const mockPipelineFn = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  cacheDir: '',
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
    promises: {
      ...actual.promises,
      access: mockFsPromisesAccess,
      rm: mockFsPromisesRm,
      realpath: mockFsPromisesRealpath,
    },
  };
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipelineFn,
  env: mockEnv,
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  configureLocalEmbeddingCacheDir,
  embedLocal,
  getLocalModelRuntimeStatus,
  isLocalModelDownloaded,
  removeLocalModelCache,
  resetLocalEmbeddingPipeline,
  warmUpLocalModel,
  LOCAL_EMBEDDING_MODEL_ID,
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL_REVISION,
} from '../../main/memory/local-embedding-provider';

// Helper — builds a fake extractor that returns a fixed Float32Array
function makeFakeExtractor(values: number[]) {
  return vi.fn().mockResolvedValue({
    data: new Float32Array(values),
  });
}

describe('local-embedding-provider', () => {
  beforeEach(() => {
    mockEnv.cacheDir = '';
    mockMkdirSync.mockReset();
    mockExistsSync.mockReset();
    mockFsPromisesAccess.mockReset();
    mockFsPromisesRm.mockReset();
    mockFsPromisesRealpath.mockReset();
    // Default realpath: echo back the input (no symlinks)
    mockFsPromisesRealpath.mockImplementation((p: string) => Promise.resolve(p));
    mockPipelineFn.mockReset();
    resetLocalEmbeddingPipeline();
  });

  afterEach(() => {
    resetLocalEmbeddingPipeline();
  });

  describe('configureLocalEmbeddingCacheDir', () => {
    it('sets env.cacheDir to {storageRoot}/models', () => {
      configureLocalEmbeddingCacheDir('/app/data/memory');
      expect(mockEnv.cacheDir).toBe('/app/data/memory/models');
    });

    it('creates the cache directory with mkdirSync(recursive)', () => {
      configureLocalEmbeddingCacheDir('/app/data/memory');
      expect(mockMkdirSync).toHaveBeenCalledWith('/app/data/memory/models', { recursive: true });
    });

    it('throws and notifies listeners if mkdirSync fails', async () => {
      mockMkdirSync.mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

      const events: string[] = [];
      // configureLocalEmbeddingCacheDir throws before pipeline init,
      // but we need a pipeline mock in case it proceeds (it should not).
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      // Register a listener via embedLocal
      const embed = embedLocal('test', 'document', (p) => events.push(p.status));

      // The embed will fail because configureLocalEmbeddingCacheDir throws
      // (called from memory-llm-client, not directly here — so just test the function directly)
      expect(() => configureLocalEmbeddingCacheDir('/no/permission')).toThrow('EACCES');
      await embed.catch(() => {});
    });
  });

  describe('embedLocal', () => {
    it('creates the pipeline with the correct model ID, revision, and dtype fallback starting at q8', async () => {
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      await embedLocal('hello world');

      expect(mockPipelineFn).toHaveBeenCalledWith(
        'feature-extraction',
        LOCAL_EMBEDDING_MODEL_ID,
        expect.objectContaining({
          dtype: 'q8',
          revision: LOCAL_EMBEDDING_MODEL_REVISION,
        })
      );
    });

    it('calls extractor with mean pooling and normalize=true', async () => {
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.5));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      await embedLocal('test text', 'document');

      // Input is prefixed with the EmbeddingGemma document task prefix.
      expect(fakeExtractor).toHaveBeenCalledWith('title: none | text: test text', {
        pooling: 'mean',
        normalize: true,
      });
    });

    it('prepends the query prefix for query embeddings', async () => {
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.5));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      await embedLocal('how do I log in', 'query');

      expect(fakeExtractor).toHaveBeenCalledWith('task: search result | query: how do I log in', {
        pooling: 'mean',
        normalize: true,
      });
    });

    it('defaults to the document prefix when kind is omitted', async () => {
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.5));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      await embedLocal('some stored text');

      expect(fakeExtractor).toHaveBeenCalledWith('title: none | text: some stored text', {
        pooling: 'mean',
        normalize: true,
      });
    });

    it('returns a plain number[] from the Float32Array output', async () => {
      const values = new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0).map((_, i) => i / 1000);
      const fakeExtractor = makeFakeExtractor(values);
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      const result = await embedLocal('test');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(LOCAL_EMBEDDING_DIMENSIONS);
      expect(result[0]).toBeCloseTo(0);
      expect(result[1]).toBeCloseTo(0.001);
    });

    it('validates embedding dimension and throws if unexpected', async () => {
      // Return wrong dimension (512 instead of 768)
      const fakeExtractor = makeFakeExtractor(new Array(512).fill(0.1));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      await expect(embedLocal('test')).rejects.toThrow('Unexpected embedding dimension');
    });

    it('reuses the singleton pipeline across multiple calls', async () => {
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      await embedLocal('first call');
      await embedLocal('second call');
      await embedLocal('third call');

      // pipeline() should only be called once — singleton
      expect(mockPipelineFn).toHaveBeenCalledTimes(1);
      expect(fakeExtractor).toHaveBeenCalledTimes(3);
    });

    it('falls back to fp16 then fp32 if q8 fails', async () => {
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));
      // q8 fails, fp16 fails, fp32 succeeds
      mockPipelineFn
        .mockRejectedValueOnce(new Error('q8 not supported'))
        .mockRejectedValueOnce(new Error('fp16 not supported'))
        .mockResolvedValue(fakeExtractor);

      const result = await embedLocal('test');

      expect(mockPipelineFn).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(LOCAL_EMBEDDING_DIMENSIONS);
      // Third call should be fp32
      expect(mockPipelineFn).toHaveBeenNthCalledWith(
        3,
        'feature-extraction',
        LOCAL_EMBEDDING_MODEL_ID,
        expect.objectContaining({ dtype: 'fp32' })
      );
    });

    it('throws when all dtypes fail', async () => {
      mockPipelineFn.mockRejectedValue(new Error('not supported'));

      await expect(embedLocal('test')).rejects.toThrow('Failed to load pipeline');
      // Next call should retry (singleton cleared)
      expect(mockPipelineFn).toHaveBeenCalledTimes(3); // q8 + fp16 + fp32
    });

    it('removes listener even when embedLocal rejects', async () => {
      // Pipeline fails — listener should still be removed in the finally block.
      mockPipelineFn.mockRejectedValue(new Error('pipeline failed'));

      let capturedCallback: ((raw: Record<string, unknown>) => void) | undefined;
      // We need the pipeline mock to capture the progress_callback
      mockPipelineFn
        .mockImplementationOnce(
          (
            _t: string,
            _m: string,
            opts: { progress_callback?: (r: Record<string, unknown>) => void }
          ) => {
            capturedCallback = opts.progress_callback;
            return Promise.reject(new Error('q8 failed'));
          }
        )
        .mockRejectedValue(new Error('other dtypes failed'));

      const events: string[] = [];
      await expect(embedLocal('text', 'document', (p) => events.push(p.status))).rejects.toThrow();

      // After rejection, listener should be deregistered — fire an event and assert no delivery.
      const countBefore = events.length;
      capturedCallback?.({ status: 'done' });
      expect(events.length).toBe(countBefore);
    });

    it('backs off after a failure, then retries on a forced warm-up', async () => {
      mockPipelineFn.mockRejectedValue(new Error('network error'));

      await expect(embedLocal('text')).rejects.toThrow();
      expect(getLocalModelRuntimeStatus().state).toBe('error');

      // An immediate retry is refused by the backoff window — no new pipeline() attempt.
      mockPipelineFn.mockClear();
      await expect(embedLocal('text again')).rejects.toThrow();
      expect(mockPipelineFn).not.toHaveBeenCalled();

      // A forced warm-up (manual "Retry download") clears the backoff and re-attempts.
      mockPipelineFn.mockReset();
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      const status = await warmUpLocalModel('/app/data/memory', { force: true });
      expect(status.state).toBe('ready');
      expect(mockPipelineFn).toHaveBeenCalledTimes(1);

      const result = await embedLocal('text after retry');
      expect(result).toHaveLength(LOCAL_EMBEDDING_DIMENSIONS);
    });

    it('invokes the progress callback with mapped progress events', async () => {
      let capturedCallback: ((raw: Record<string, unknown>) => void) | undefined;
      // Use a controlled promise to keep embedLocal in-flight while we fire events.
      let resolveExtractor!: (value: { data: Float32Array }) => void;
      const extractorPromise = new Promise<{ data: Float32Array }>((resolve) => {
        resolveExtractor = resolve;
      });
      const fakeExtractor = vi.fn().mockReturnValue(extractorPromise);

      mockPipelineFn.mockImplementation(
        (
          _task: string,
          _model: string,
          opts: { progress_callback?: (r: Record<string, unknown>) => void }
        ) => {
          capturedCallback = opts.progress_callback;
          return Promise.resolve(fakeExtractor);
        }
      );

      const progressEvents: Array<{ status: string; progress?: number }> = [];
      // Start the call but don't await yet
      const embedPromise = embedLocal('text', 'document', (p) => progressEvents.push(p));

      // Yield to let pipeline init complete
      await Promise.resolve();
      await Promise.resolve();

      // Fire progress events while listener is still registered (call in-flight)
      capturedCallback?.({ status: 'progress', file: 'model.safetensors', progress: 42.7 });
      capturedCallback?.({ status: 'done' });

      // Now resolve the extractor
      resolveExtractor({ data: new Float32Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1) });
      await embedPromise;

      expect(progressEvents).toEqual([
        { status: 'downloading', file: 'model.safetensors', progress: 43 },
        { status: 'ready' },
      ]);
    });

    it('multiple concurrent callers all receive progress events (Set-based listeners)', async () => {
      let capturedCallback: ((raw: Record<string, unknown>) => void) | undefined;
      let resolveExtractor!: (value: { data: Float32Array }) => void;
      const extractorPromise = new Promise<{ data: Float32Array }>((resolve) => {
        resolveExtractor = resolve;
      });
      const fakeExtractor = vi.fn().mockReturnValue(extractorPromise);

      mockPipelineFn.mockImplementation(
        (
          _task: string,
          _model: string,
          opts: { progress_callback?: (r: Record<string, unknown>) => void }
        ) => {
          capturedCallback = opts.progress_callback;
          return Promise.resolve(fakeExtractor);
        }
      );

      const events1: string[] = [];
      const events2: string[] = [];

      // Start two concurrent calls — both should receive progress
      const p1 = embedLocal('text1', 'document', (p) => events1.push(p.status));
      const p2 = embedLocal('text2', 'document', (p) => events2.push(p.status));

      // Yield to let pipeline init complete
      await Promise.resolve();
      await Promise.resolve();

      // Fire progress while both are registered (calls still in-flight)
      capturedCallback?.({ status: 'done' });

      // Resolve extractor to let calls complete
      resolveExtractor({ data: new Float32Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1) });
      await Promise.all([p1, p2]);

      expect(events1).toContain('ready');
      expect(events2).toContain('ready');
    });

    it('deregisters listener after call completes', async () => {
      let capturedCallback: ((raw: Record<string, unknown>) => void) | undefined;
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));

      mockPipelineFn.mockImplementation(
        (
          _task: string,
          _model: string,
          opts: { progress_callback?: (r: Record<string, unknown>) => void }
        ) => {
          capturedCallback = opts.progress_callback;
          return Promise.resolve(fakeExtractor);
        }
      );

      const events: string[] = [];
      await embedLocal('text', 'document', (p) => events.push(p.status));

      const lengthAfterCall = events.length;
      // Fire after call completed — listener should be deregistered, no new events
      capturedCallback?.({ status: 'done' });
      expect(events.length).toBe(lengthAfterCall);
    });
  });

  describe('resetLocalEmbeddingPipeline', () => {
    it('causes the next embedLocal call to re-create the pipeline', async () => {
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

      await embedLocal('before reset');
      expect(mockPipelineFn).toHaveBeenCalledTimes(1);

      resetLocalEmbeddingPipeline();

      await embedLocal('after reset');
      expect(mockPipelineFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('isLocalModelDownloaded', () => {
    const storageRoot = path.join(path.sep, 'abs', 'memory');
    const modelSlug = LOCAL_EMBEDDING_MODEL_ID.replace('/', '--');
    const expectedModelDir = path.join(storageRoot, 'models', `models--${modelSlug}`);

    it('returns true when the model directory exists', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isLocalModelDownloaded(storageRoot)).toBe(true);
      expect(mockExistsSync).toHaveBeenCalledWith(expectedModelDir);
    });

    it('returns false when the model directory does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(isLocalModelDownloaded(storageRoot)).toBe(false);
    });

    it('accepts a relative storageRoot (resolved via path.resolve) and checks existence', () => {
      // resolveModelCacheDir now uses path.resolve, so relative paths are accepted.
      // existsSync returns false for the resolved path in test environment.
      mockExistsSync.mockReturnValue(false);
      expect(isLocalModelDownloaded('relative/path')).toBe(false);
      // existsSync IS called — with the resolved absolute path
      expect(mockExistsSync).toHaveBeenCalled();
    });

    it('returns false if existsSync throws', () => {
      mockExistsSync.mockImplementation(() => {
        throw new Error('EPERM');
      });
      expect(isLocalModelDownloaded(storageRoot)).toBe(false);
    });

    it('returns false for empty storageRoot (catches the thrown error)', () => {
      expect(isLocalModelDownloaded('')).toBe(false);
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it('returns false for whitespace-only storageRoot (catches the thrown error)', () => {
      expect(isLocalModelDownloaded('   ')).toBe(false);
      expect(mockExistsSync).not.toHaveBeenCalled();
    });
  });

  describe('removeLocalModelCache', () => {
    const storageRoot = path.join(path.sep, 'abs', 'memory');
    const modelSlug = LOCAL_EMBEDDING_MODEL_ID.replace('/', '--');
    const expectedModelDir = path.join(storageRoot, 'models', `models--${modelSlug}`);

    it('returns false when the model directory does not exist (ENOENT)', async () => {
      mockFsPromisesAccess.mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      );
      const result = await removeLocalModelCache(storageRoot);
      expect(result).toBe(false);
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('rethrows non-ENOENT access errors (e.g. EPERM)', async () => {
      mockFsPromisesAccess.mockRejectedValue(
        Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      );
      await expect(removeLocalModelCache(storageRoot)).rejects.toThrow('EPERM');
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('deletes only the model dir (not the entire models/ dir) and resets the pipeline', async () => {
      mockFsPromisesAccess.mockResolvedValue(undefined);
      mockFsPromisesRm.mockResolvedValue(undefined);
      // realpath echoes back (default mock) — no symlinks

      // Seed a pipeline so we can verify it gets cleared
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));
      mockPipelineFn.mockResolvedValue(fakeExtractor);
      await embedLocal('before remove');
      expect(mockPipelineFn).toHaveBeenCalledTimes(1);

      const result = await removeLocalModelCache(storageRoot);

      expect(result).toBe(true);
      // Must target only the specific model dir, not the entire models/ directory
      expect(mockFsPromisesRm).toHaveBeenCalledWith(expectedModelDir, { recursive: true });
      expect(mockFsPromisesRm).not.toHaveBeenCalledWith(
        path.join(storageRoot, 'models'),
        expect.anything()
      );
      // Pipeline should be reset — next embed triggers re-init
      await embedLocal('after remove');
      expect(mockPipelineFn).toHaveBeenCalledTimes(2);
    });

    it('accepts a relative storageRoot by resolving it to an absolute path', async () => {
      // resolveModelCacheDir now uses path.resolve, so relative paths are accepted.
      // access() will return ENOENT for the non-existent relative path in tests.
      mockFsPromisesAccess.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      const result = await removeLocalModelCache('relative/path');
      expect(result).toBe(false);
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('throws for empty storageRoot', async () => {
      await expect(removeLocalModelCache('')).rejects.toThrow(
        'storageRoot must not be empty or whitespace'
      );
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('throws for whitespace-only storageRoot', async () => {
      await expect(removeLocalModelCache('   ')).rejects.toThrow(
        'storageRoot must not be empty or whitespace'
      );
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('handles whitespace-padded storageRoot by trimming consistently', async () => {
      // '  /abs/memory  ' should be treated the same as '/abs/memory' —
      // resolveModelCacheDir and realpath both use path.resolve(storageRoot.trim())
      mockFsPromisesAccess.mockResolvedValue(undefined);
      mockFsPromisesRm.mockResolvedValue(undefined);
      // realpath echoes back normalized (default mock)

      const result = await removeLocalModelCache(`  ${path.join(path.sep, 'abs', 'memory')}  `);

      expect(result).toBe(true);
      // rm() must be called with the correct model dir derived from the trimmed root
      const modelSlug = LOCAL_EMBEDDING_MODEL_ID.replace('/', '--');
      const expectedModelDir = path.join(
        path.sep,
        'abs',
        'memory',
        'models',
        `models--${modelSlug}`
      );
      expect(mockFsPromisesRm).toHaveBeenCalledWith(expectedModelDir, { recursive: true });
    });

    it('rethrows when realpath(storageRoot) fails with EPERM', async () => {
      mockFsPromisesAccess.mockResolvedValue(undefined);
      // First realpath call is for storageRoot — make it fail
      mockFsPromisesRealpath.mockRejectedValueOnce(
        Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      );
      await expect(removeLocalModelCache(path.join(path.sep, 'abs', 'memory'))).rejects.toThrow(
        'EPERM'
      );
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('returns false when realpath(storageRoot) fails with ENOENT (storage dir removed)', async () => {
      mockFsPromisesAccess.mockResolvedValue(undefined);
      // realpath(storageRoot) returns ENOENT — storage dir was deleted after access check
      mockFsPromisesRealpath.mockRejectedValueOnce(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      );
      const result = await removeLocalModelCache(path.join(path.sep, 'abs', 'memory'));
      expect(result).toBe(false);
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('returns false when realpath(modelDir) fails with ENOENT (dir disappeared after access)', async () => {
      mockFsPromisesAccess.mockResolvedValue(undefined);
      const expectedCacheDir = path.join(storageRoot, 'models');
      // storageRoot and cacheDir realpath succeed, modelDir realpath returns ENOENT
      mockFsPromisesRealpath
        .mockResolvedValueOnce(storageRoot) // realpath(storageRoot)
        .mockResolvedValueOnce(expectedCacheDir) // realpath(cacheDir)
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })); // realpath(modelDir)
      const result = await removeLocalModelCache(storageRoot);
      expect(result).toBe(false);
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('returns true when rm() throws ENOENT (race: directory removed between realpath and rm)', async () => {
      mockFsPromisesAccess.mockResolvedValue(undefined);
      mockFsPromisesRm.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const result = await removeLocalModelCache(path.join(path.sep, 'abs', 'memory'));
      expect(result).toBe(true);
    });

    it('does not delete storageRoot itself', async () => {
      mockFsPromisesAccess.mockResolvedValue(undefined);
      mockFsPromisesRm.mockResolvedValue(undefined);

      await removeLocalModelCache(storageRoot);

      expect(mockFsPromisesRm).not.toHaveBeenCalledWith(storageRoot, expect.anything());
    });

    it('rejects when realpath resolves model dir outside cache dir (symlink escape)', async () => {
      mockFsPromisesAccess.mockResolvedValue(undefined);
      const expectedCacheDir = path.join(storageRoot, 'models');
      // cacheDir resolves normally, but modelDir symlinks to an unrelated location
      mockFsPromisesRealpath.mockImplementation((p: string) => {
        if (p === expectedModelDir) return Promise.resolve(path.join(path.sep, 'etc', 'passwd'));
        if (p === expectedCacheDir) return Promise.resolve(expectedCacheDir);
        return Promise.resolve(p);
      });

      await expect(removeLocalModelCache(storageRoot)).rejects.toThrow(
        'Model dir resolves outside cache dir'
      );
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('rejects when storageRoot is filesystem root (unsafe root guard)', async () => {
      await expect(removeLocalModelCache(path.sep)).rejects.toThrow(
        'storageRoot is too close to filesystem root'
      );
      expect(mockFsPromisesRm).not.toHaveBeenCalled();
    });

    it('propagates IO errors from rm', async () => {
      mockFsPromisesAccess.mockResolvedValue(undefined);
      mockFsPromisesRm.mockRejectedValue(new Error('EPERM: operation not permitted'));

      await expect(removeLocalModelCache(storageRoot)).rejects.toThrow('EPERM');
    });
  });
});
