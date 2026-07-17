import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeSimpleMock = vi.hoisted(() => vi.fn());

// `completeSimple` and `getModel` moved to the `/compat` entrypoint in pi-ai 0.80.0.
vi.mock('@earendil-works/pi-ai/compat', () => ({
  completeSimple: completeSimpleMock,
  getModel: vi.fn(() => undefined),
}));

// `AuthStorage` was replaced by the async `ModelRuntime` in pi-coding-agent 0.80.8.
vi.mock('../../main/claude/shared-auth', () => ({
  getSharedModelRuntime: () =>
    Promise.resolve({
      setRuntimeApiKey: vi.fn(() => Promise.resolve()),
      removeRuntimeApiKey: vi.fn(() => Promise.resolve()),
    }),
}));

import type { AppConfig } from '../../main/config/config-store';
import { runPiAiOneShot } from '../../main/claude/claude-sdk-one-shot';

function makeConfig(): AppConfig {
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
        timeoutMs: 180000,
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

describe('runPiAiOneShot', () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
    });
  });

  it('passes generation options through to completeSimple', async () => {
    await runPiAiOneShot('hello', 'system', makeConfig(), {
      temperature: 0.2,
      maxTokens: 1234,
    });

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
      apiKey: 'test-key',
      temperature: 0.2,
      maxTokens: 1234,
    });
  });
});
