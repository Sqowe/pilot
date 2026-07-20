import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const completeSimpleMock = vi.hoisted(() => vi.fn());

// `completeSimple` moved to the `/compat` entrypoint in pi-ai 0.80.0.
vi.mock('@earendil-works/pi-ai/compat', () => ({
  completeSimple: completeSimpleMock,
}));

// Mock the config store to avoid electron-store import
vi.mock('../../main/config/config-store', () => ({
  configStore: {
    getAll: () => ({}),
    get: () => undefined,
  },
}));

// Mock pi-model-resolution
vi.mock('../../main/claude/pi-model-resolution', () => ({
  resolvePiRegistryModel: () => ({
    id: 'test-model',
    provider: 'openai',
    api: 'openai-completions',
    baseUrl: 'https://example.test/v1',
  }),
  resolvePiRouteProtocol: () => 'openai',
  resolvePiModelString: () => 'openai/test-model',
  buildSyntheticPiModel: () => ({
    id: 'test-model',
    provider: 'openai',
    api: 'openai-completions',
    baseUrl: 'https://example.test/v1',
  }),
  applyPiModelRuntimeOverrides: (model: unknown) => model,
  resolveSyntheticPiModelFallback: () => ({
    provider: 'openai',
    modelId: 'test-model',
    baseUrl: 'https://example.test/v1',
  }),
  inferPiApi: () => 'openai-completions',
}));

// Mock logger
vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// openai is used by memory-llm-client for remote embedding — it's already imported
// at module load time, so we can't re-mock it here. Tests that exercise the remote
// path check the embedLocalMock call count (not the OpenAI result) as the assertion.

// Stub OpenAI with a synchronous fake so remote-path tests don't hang on network.
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    embeddings = {
      create: () => Promise.resolve({ data: [{ embedding: [0.1] }] }),
    };
  },
}));

// Mock local-embedding-provider so tests never touch real ONNX / network
const embedLocalMock = vi.hoisted(() => vi.fn());
const configureLocalEmbeddingCacheDirMock = vi.hoisted(() => vi.fn());
vi.mock('../../main/memory/local-embedding-provider', () => ({
  embedLocal: embedLocalMock,
  configureLocalEmbeddingCacheDir: configureLocalEmbeddingCacheDirMock,
  LOCAL_EMBEDDING_MODEL_ID: 'onnx-community/embeddinggemma-300m-ONNX',
  LOCAL_EMBEDDING_DIMENSIONS: 768,
  resetLocalEmbeddingPipeline: vi.fn(),
}));

import type { AppConfig } from '../../main/config/config-store';
import { MemoryLLMClient } from '../../main/memory/memory-llm-client';

function makeConfig(timeoutMs: number): AppConfig {
  return {
    provider: 'custom',
    customProtocol: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    activeProfileKey: 'custom:openai',
    profiles: {},
    activeConfigSetId: 'default',
    configSets: [],
    claudeCodePath: '',
    defaultWorkdir: '',
    globalSkillsPath: '',
    enableDevLogs: false,
    theme: 'light',
    sandboxEnabled: false,
    memoryEnabled: true,
    memoryRuntime: {
      llm: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: '',
        timeoutMs,
      },
      embedding: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: 'text-embedding-3-small',
        timeoutMs: 180000,
      },
      useEmbedding: false,
      maxNavSteps: 2,
      ingestionConcurrency: 4,
      storageRoot: '',
      evalEnabled: false,
      evalWorkspaces: [],
      evalMaxRounds: 12,
      evalArtifactsRoot: '',
      promptIterationRounds: 2,
    },
    enableThinking: false,
    thinkingLevel: 'off' as const,
    bashTrustedCommands: [],
    bashDenylist: [],
    schedulerCatchUpPolicy: 'ask',
    schedulerConflictPolicy: 'queue',
    schedulerRunHistoryDepth: 10,
    permissionTimeoutSeconds: 300,
    mcpToolTimeoutSeconds: 240,
    isConfigured: true,
    notificationsEnabled: true,
    skillConflictConfig: {
      conflictPolicy: 'custom-wins',
      disabledSkills: [],
      sourceOverrides: {},
      acknowledgedConflicts: [],
    },
    orphanDismissals: [],
    systemPromptFileEnabled: true,
    systemPromptFilePriority: [
      'CLAUDE.md',
      'AGENTS.md',
      '.cowork/instructions.md',
      'memory.md',
      'instructions.md',
    ],
    configSchemaVersion: 1,
  };
}

describe('MemoryLLMClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    completeSimpleMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts one-shot completions with the configured memory LLM timeout', async () => {
    let signal: AbortSignal | undefined;
    completeSimpleMock.mockImplementation(
      (_model: unknown, _msgs: unknown, options: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => undefined);
      }
    );

    const client = new MemoryLLMClient(() => makeConfig(5000));
    const completion = client
      .complete({
        systemPrompt: 'memory system',
        userPrompt: 'memory user',
      })
      .then(
        () => null,
        (error: unknown) => error as Error
      );

    await vi.advanceTimersByTimeAsync(4999);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    const error = await completion;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Memory LLM request timed out after 5000ms');
  });

  describe('embed() — local provider', () => {
    beforeEach(() => {
      embedLocalMock.mockReset();
      configureLocalEmbeddingCacheDirMock.mockReset();
    });

    function makeLocalConfig(storageRoot = '/app/data/memory'): AppConfig {
      const base = makeConfig(180000);
      return {
        ...base,
        memoryRuntime: {
          ...base.memoryRuntime,
          useEmbedding: true,
          storageRoot,
          embedding: {
            ...base.memoryRuntime.embedding,
            provider: 'local' as const,
          },
        },
      };
    }

    it('routes to embedLocal and never constructs an OpenAI client', async () => {
      const fakeVec = new Array(768).fill(0.1);
      embedLocalMock.mockResolvedValue(fakeVec);

      const client = new MemoryLLMClient(() => makeLocalConfig());
      const result = await client.embed('hello world');

      expect(embedLocalMock).toHaveBeenCalledWith('hello world', 'document', undefined);
      expect(result).toEqual(fakeVec);
    });

    it('calls configureLocalEmbeddingCacheDir with the storageRoot from config', async () => {
      embedLocalMock.mockResolvedValue([]);

      const client = new MemoryLLMClient(() => makeLocalConfig('/custom/storage'));
      await client.embed('test');

      expect(configureLocalEmbeddingCacheDirMock).toHaveBeenCalledWith('/custom/storage');
    });

    it('falls back to getStorageRoot() when config storageRoot is empty', async () => {
      embedLocalMock.mockResolvedValue([]);

      const client = new MemoryLLMClient(() => makeLocalConfig(''), {
        getStorageRoot: () => '/injected/storage',
      });
      await client.embed('test');

      expect(configureLocalEmbeddingCacheDirMock).toHaveBeenCalledWith('/injected/storage');
    });

    it('forwards the onLocalEmbeddingProgress callback to embedLocal', async () => {
      embedLocalMock.mockResolvedValue([]);
      const progressCb = vi.fn();

      const client = new MemoryLLMClient(() => makeLocalConfig(), {
        onLocalEmbeddingProgress: progressCb,
      });
      await client.embed('test');

      expect(embedLocalMock).toHaveBeenCalledWith('test', 'document', progressCb);
    });

    it('passes the embedding kind through to embedLocal', async () => {
      embedLocalMock.mockResolvedValue([]);

      const client = new MemoryLLMClient(() => makeLocalConfig());
      await client.embed('a search', 'query');

      expect(embedLocalMock).toHaveBeenCalledWith('a search', 'query', undefined);
    });

    it('returns [] when useEmbedding is false even with provider: local', async () => {
      const config = makeLocalConfig();
      config.memoryRuntime!.useEmbedding = false;

      const client = new MemoryLLMClient(() => config);
      const result = await client.embed('test');

      expect(result).toEqual([]);
      expect(embedLocalMock).not.toHaveBeenCalled();
    });

    it('configureLocalEmbeddingCacheDir called only once when storageRoot unchanged', async () => {
      embedLocalMock.mockResolvedValue([]);

      const client = new MemoryLLMClient(() => makeLocalConfig('/stable/storage'));
      await client.embed('first');
      await client.embed('second');
      await client.embed('third');

      // configureLocalEmbeddingCacheDir should only be called once — not on every embed call.
      expect(configureLocalEmbeddingCacheDirMock).toHaveBeenCalledTimes(1);
      expect(configureLocalEmbeddingCacheDirMock).toHaveBeenCalledWith('/stable/storage');
    });

    it('reconfigures cache dir when storageRoot changes between calls', async () => {
      embedLocalMock.mockResolvedValue([]);
      let root = '/initial/storage';

      const client = new MemoryLLMClient(() => makeLocalConfig(root));
      await client.embed('first');
      expect(configureLocalEmbeddingCacheDirMock).toHaveBeenCalledWith('/initial/storage');

      root = '/new/storage';
      await client.embed('second');
      expect(configureLocalEmbeddingCacheDirMock).toHaveBeenCalledWith('/new/storage');
      expect(configureLocalEmbeddingCacheDirMock).toHaveBeenCalledTimes(2);
    });

    it('remote provider path used when provider is openai (not local)', async () => {
      // Verify that non-local providers bypass embedLocal entirely.
      // The OpenAI call itself may fail in test (no real client), but that's
      // irrelevant — the assertion is purely that embedLocalMock was not called.
      const base = makeConfig(180000);
      const remoteConfig = {
        ...base,
        memoryRuntime: {
          ...base.memoryRuntime,
          useEmbedding: true,
          embedding: {
            ...base.memoryRuntime.embedding,
            provider: 'openai' as const,
            inheritFromActive: false,
            apiKey: 'sk-test',
            model: 'text-embedding-3-small',
          },
        },
      };

      const client = new MemoryLLMClient(() => remoteConfig);
      const result = await client.embed('test');

      // The key invariant: local path was never entered.
      expect(embedLocalMock).not.toHaveBeenCalled();
      // And the remote path returned a real embedding vector.
      expect(result).toEqual([0.1]);
    });

    it('uses os.homedir() fallback when no getStorageRoot is provided and config root is empty', async () => {
      embedLocalMock.mockResolvedValue([]);

      // No options passed — should default to os.homedir()-based path, not throw.
      const client = new MemoryLLMClient(() => makeLocalConfig(''));
      await client.embed('test');

      // configureLocalEmbeddingCacheDir should have been called with a non-empty absolute path.
      expect(configureLocalEmbeddingCacheDirMock).toHaveBeenCalledTimes(1);
      const calledWith = configureLocalEmbeddingCacheDirMock.mock.calls[0][0] as string;
      expect(calledWith).toBeTruthy();
      expect(calledWith.startsWith('/')).toBe(true); // absolute path on Unix
    });

    it('returns [] for empty/whitespace input without calling embedLocal', async () => {
      const client = new MemoryLLMClient(() => makeLocalConfig());

      expect(await client.embed('')).toEqual([]);
      expect(await client.embed('   ')).toEqual([]);
      expect(embedLocalMock).not.toHaveBeenCalled();
    });
  });

  describe('checkAvailability()', () => {
    function makeConfigWithEmbedding(useEmbedding: boolean): AppConfig {
      const config = makeConfig(180000);
      config.memoryRuntime.useEmbedding = useEmbedding;
      return config;
    }

    it('reports llm ok and embedding skipped when embeddings are disabled', async () => {
      const client = new MemoryLLMClient(() => makeConfigWithEmbedding(false));
      const completeSpy = vi.spyOn(client, 'complete').mockResolvedValue({ text: 'ok' });
      const embedSpy = vi.spyOn(client, 'embed');

      const result = await client.checkAvailability();

      expect(result.llm).toEqual({ ok: true });
      expect(result.embedding).toEqual({ ok: true, skipped: true });
      expect(completeSpy).toHaveBeenCalledTimes(1);
      // Embedding disabled → embed() is never called.
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it('reports llm failure with its error, still probing embedding', async () => {
      const client = new MemoryLLMClient(() => makeConfigWithEmbedding(true));
      vi.spyOn(client, 'complete').mockRejectedValue(new Error('401 unauthorized'));
      const embedSpy = vi.spyOn(client, 'embed').mockResolvedValue(new Array(768).fill(0.1));

      const result = await client.checkAvailability();

      expect(result.llm.ok).toBe(false);
      expect(result.llm.error).toContain('401');
      expect(result.embedding).toEqual({ ok: true });
      expect(embedSpy).toHaveBeenCalledTimes(1);
    });

    it('treats an empty embedding vector as a failure (unsupported provider)', async () => {
      const client = new MemoryLLMClient(() => makeConfigWithEmbedding(true));
      vi.spyOn(client, 'complete').mockResolvedValue({ text: 'ok' });
      vi.spyOn(client, 'embed').mockResolvedValue([]);

      const result = await client.checkAvailability();

      expect(result.llm).toEqual({ ok: true });
      expect(result.embedding.ok).toBe(false);
      expect(result.embedding.error).toBeTruthy();
    });

    it('reports embedding failure with its thrown error', async () => {
      const client = new MemoryLLMClient(() => makeConfigWithEmbedding(true));
      vi.spyOn(client, 'complete').mockResolvedValue({ text: 'ok' });
      vi.spyOn(client, 'embed').mockRejectedValue(new Error('model download failed'));

      const result = await client.checkAvailability();

      expect(result.llm).toEqual({ ok: true });
      expect(result.embedding.ok).toBe(false);
      expect(result.embedding.error).toContain('download failed');
    });
  });
});
