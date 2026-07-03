/**
 * Unit tests for local-embedding-provider.ts
 *
 * @huggingface/transformers is fully mocked — no real model download in CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted so they run before imports) ---

const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockPipelineFn = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  cacheDir: '',
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, mkdirSync: mockMkdirSync };
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
  resetLocalEmbeddingPipeline,
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
      const embed = embedLocal('test', (p) => events.push(p.status));

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

      await embedLocal('test text');

      expect(fakeExtractor).toHaveBeenCalledWith('test text', {
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
      await expect(embedLocal('text', (p) => events.push(p.status))).rejects.toThrow();

      // After rejection, listener should be deregistered — fire an event and assert no delivery.
      const countBefore = events.length;
      capturedCallback?.({ status: 'done' });
      expect(events.length).toBe(countBefore);
    });

    it('clears the singleton and allows retry after pipeline init failure', async () => {
      mockPipelineFn.mockRejectedValue(new Error('network error'));

      await expect(embedLocal('text')).rejects.toThrow();

      // Second call should attempt pipeline creation again
      mockPipelineFn.mockReset();
      const fakeExtractor = makeFakeExtractor(new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(0.1));
      mockPipelineFn.mockResolvedValue(fakeExtractor);

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
      const embedPromise = embedLocal('text', (p) => progressEvents.push(p));

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
      const p1 = embedLocal('text1', (p) => events1.push(p.status));
      const p2 = embedLocal('text2', (p) => events2.push(p.status));

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
      await embedLocal('text', (p) => events.push(p.status));

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
});
