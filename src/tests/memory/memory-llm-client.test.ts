import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const completeSimpleMock = vi.hoisted(() => vi.fn());

vi.mock('@earendil-works/pi-ai', () => ({
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
});
