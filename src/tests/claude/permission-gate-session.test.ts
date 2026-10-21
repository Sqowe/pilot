import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The permission gate replaces pi's private `agent.beforeToolCall` and works only as long as
 * pi reads that field on every run (pi-agent-core `agent.js`, `beforeToolCall:
 * this.beforeToolCall` in the run config). `before-tool-call-hook.ts` checks that the field
 * exists, not that pi still uses it — a pi uplift that captured the hook at construction would
 * silently disable every permission check. This test runs a real pi session on pi-ai's faux
 * provider (offline), installs the gate with the runner's own function, and checks that a
 * `bash` call the model makes reaches the permission dialog and runs only when allowed.
 */
vi.mock('../../main/config/permission-rules-store', () => ({
  decidePermissionDetailed: vi.fn(() => ({ action: 'ask', reason: 'not-trusted' })),
  isSessionAutonomous: vi.fn(() => false),
  getAutonomousBlockCallback: vi.fn(() => null),
  rememberAlwaysAllow: vi.fn(),
}));
vi.mock('../../main/utils/logger', () => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { installPermissionGate, type RequestPermission } from '../../main/claude/permission-gate';
import { createPiResourceLoader } from '../../main/claude/pi-resource-loader';

let root: string;
let previousOffline: string | undefined;

beforeAll(() => {
  previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  root = mkdtempSync(join(tmpdir(), 'permission-gate-session-'));
  mkdirSync(join(root, 'ws'), { recursive: true });
});

afterAll(() => {
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  rmSync(root, { recursive: true, force: true });
});

describe('the permission gate on a real pi session', () => {
  it('stops a bash call the user denies and runs one the user allows', async () => {
    const commandsRun: string[] = [];
    const bash = {
      name: 'bash',
      label: 'bash',
      description: 'Run a shell command',
      parameters: Type.Object({ command: Type.String() }),
      execute: async (_id: string, params: { command: string }) => {
        commandsRun.push(params.command);
        return { content: [{ type: 'text' as const, text: `ran ${params.command}` }], details: {} };
      },
    } as unknown as ToolDefinition;

    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    const faux = fauxProvider({
      provider: 'faux-permission-gate',
      models: [{ id: 'faux-1', contextWindow: 100000, maxTokens: 1000 }],
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const cwd = join(root, 'ws');
    const { session } = await createAgentSession({
      model: faux.getModel(),
      thinkingLevel: 'off',
      modelRuntime,
      noTools: 'builtin',
      customTools: [bash],
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
      resourceLoader: await createPiResourceLoader({
        cwd,
        agentDir: join(root, 'agent'),
        additionalSkillPaths: [],
        appendSystemPrompt: undefined,
      }),
      cwd,
    });

    let answer: 'deny' | 'allow' = 'deny';
    const requestPermission = vi.fn<RequestPermission>(async () => ({ result: answer }));
    expect(
      installPermissionGate(session, {
        sessionId: 'chat-1',
        cwdRef: { value: cwd },
        requestPermission,
        waitState: new Map(),
        currentRunId: () => 'run-1',
        pauseActivityTimeout: () => {},
        restartActivityTimeout: () => {},
      })
    ).toBe('property');

    const results: Array<{ isError: boolean; text: string }> = [];
    session.subscribe((event) => {
      if (event.type === 'tool_execution_end') {
        const content = (event.result as { content?: Array<{ text?: string }> })?.content;
        results.push({ isError: event.isError, text: content?.[0]?.text ?? '' });
      }
    });
    const modelRuns = async (command: string) => {
      results.length = 0;
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ]);
      await session.prompt(`please run ${command}`);
    };

    await modelRuns('rm -rf build');
    expect(requestPermission).toHaveBeenCalledWith(
      'chat-1',
      expect.any(String),
      'bash',
      { command: 'rm -rf build' },
      'not-trusted'
    );
    expect(commandsRun).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].text).toContain("User denied THIS SPECIFIC invocation of 'bash'");

    answer = 'allow';
    await modelRuns('ls');
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(commandsRun).toEqual(['ls']);
    expect(results).toEqual([{ isError: false, text: 'ran ls' }]);

    session.dispose();
  });
});
