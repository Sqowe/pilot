import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPiResourceLoader } from '../../main/claude/pi-resource-loader';
import {
  buildMcpServerDirectory,
  planCachedSessionMcpTools,
} from '../../main/claude/session-mcp-tools';

/**
 * A chat keeps its pi session between messages, and pi takes the tools when the session is
 * created. Turning an MCP server off for the chat (or on, or in the workspace profile) has to
 * reach that session — before, the agent of an open chat kept calling a switched-off server.
 */
describe('planCachedSessionMcpTools', () => {
  const builtins = ['read', 'bash', 'edit', 'write'];

  it('keeps a session that already offers exactly the wanted MCP tools', () => {
    expect(
      planCachedSessionMcpTools({
        registered: [...builtins, 'mcp__a__x', 'mcp__b__y'],
        active: [...builtins, 'mcp__a__x', 'mcp__b__y'],
        wantedMcp: ['mcp__b__y', 'mcp__a__x'],
      })
    ).toEqual({ kind: 'keep' });
  });

  it('stops offering the tools of a server turned off, and leaves the other tools alone', () => {
    expect(
      planCachedSessionMcpTools({
        registered: [...builtins, 'memory_search', 'mcp__a__x', 'mcp__b__y'],
        active: [...builtins, 'memory_search', 'mcp__a__x', 'mcp__b__y'],
        wantedMcp: ['mcp__a__x'],
      })
    ).toEqual({
      kind: 'set-active',
      activeToolNames: [...builtins, 'memory_search', 'mcp__a__x'],
    });
  });

  it('offers again the tools of a server turned back on', () => {
    expect(
      planCachedSessionMcpTools({
        registered: [...builtins, 'mcp__a__x', 'mcp__b__y'],
        active: [...builtins, 'mcp__a__x'],
        wantedMcp: ['mcp__a__x', 'mcp__b__y'],
      })
    ).toEqual({ kind: 'set-active', activeToolNames: [...builtins, 'mcp__a__x', 'mcp__b__y'] });
  });

  it('asks for a new session when a wanted tool was never registered', () => {
    expect(
      planCachedSessionMcpTools({
        registered: [...builtins, 'mcp__a__x'],
        active: [...builtins, 'mcp__a__x'],
        wantedMcp: ['mcp__a__x', 'mcp__c__z'],
      })
    ).toEqual({ kind: 'recreate', missing: ['mcp__c__z'] });
  });
});

describe('buildMcpServerDirectory', () => {
  const statuses = [
    { id: 'a', connected: true, toolCount: 2 },
    { id: 'b', connected: true, toolCount: 5 },
    { id: 'c', connected: false, toolCount: 1 },
  ];

  it('lists the connected servers among those enabled for the chat', () => {
    const directory = buildMcpServerDirectory(
      [
        { id: 'a', name: 'Alpha', description: 'Alpha data' },
        { id: 'c', name: 'Gamma', description: 'Gamma data' },
      ],
      statuses
    );
    expect(directory).toContain('- Alpha: Alpha data');
    // Beta is connected but switched off for the chat; Gamma is enabled but not connected.
    expect(directory).not.toContain('Beta');
    expect(directory).not.toContain('Gamma');
  });

  it('is empty when no server enabled for the chat is connected', () => {
    expect(buildMcpServerDirectory([{ id: 'c', name: 'Gamma' }], statuses)).toBe('');
  });
});

describe('a cached pi session follows the MCP switches', () => {
  let root: string;
  let previousOffline: string | undefined;

  beforeAll(() => {
    previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    root = mkdtempSync(join(tmpdir(), 'session-mcp-tools-'));
    mkdirSync(join(root, 'ws'), { recursive: true });
  });

  afterAll(() => {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    rmSync(root, { recursive: true, force: true });
  });

  it('stops offering a switched-off server, offers it again, and asks to recreate for a new one', async () => {
    const executed: string[] = [];
    const mcpTool = (name: string): ToolDefinition =>
      ({
        name,
        label: name,
        description: `tool ${name}`,
        parameters: Type.Object({}),
        execute: async () => {
          executed.push(name);
          return { content: [{ type: 'text' as const, text: `ran ${name}` }], details: {} };
        },
      }) as unknown as ToolDefinition;

    // pi-ai's faux provider plays the model, offline; the loader is the app's own.
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    const faux = fauxProvider({
      provider: 'faux-mcp-switches',
      models: [{ id: 'faux-1', contextWindow: 100000, maxTokens: 1000 }],
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({
      model: faux.getModel(),
      thinkingLevel: 'off',
      modelRuntime,
      noTools: 'builtin',
      customTools: [mcpTool('mcp__a__x'), mcpTool('mcp__b__y')],
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
      resourceLoader: await createPiResourceLoader({
        cwd: join(root, 'ws'),
        agentDir: join(root, 'agent'),
        additionalSkillPaths: [],
        appendSystemPrompt: undefined,
      }),
      cwd: join(root, 'ws'),
    });

    const results: Array<{ tool: string; isError: boolean; text: string }> = [];
    session.subscribe((event) => {
      if (event.type === 'tool_execution_end') {
        const content = (event.result as { content?: Array<{ text?: string }> })?.content;
        results.push({
          tool: event.toolName,
          isError: event.isError,
          text: content?.[0]?.text ?? '',
        });
      }
    });
    const modelCalls = async (toolName: string) => {
      executed.length = 0;
      results.length = 0;
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ]);
      await session.prompt(`use ${toolName}`);
    };
    const apply = (s: AgentSession, wantedMcp: string[]) => {
      const plan = planCachedSessionMcpTools({
        registered: s.getAllTools().map((tool) => tool.name),
        active: s.getActiveToolNames(),
        wantedMcp,
      });
      if (plan.kind === 'set-active') s.setActiveToolsByName(plan.activeToolNames);
      return plan.kind;
    };

    // Server b switched off for the chat: its tool is no longer offered, and a call fails.
    expect(apply(session, ['mcp__a__x'])).toBe('set-active');
    await modelCalls('mcp__b__y');
    expect(executed).toEqual([]);
    expect(results).toEqual([
      { tool: 'mcp__b__y', isError: true, text: 'Tool mcp__b__y not found' },
    ]);

    // Switched back on: offered and run again.
    expect(apply(session, ['mcp__a__x', 'mcp__b__y'])).toBe('set-active');
    await modelCalls('mcp__b__y');
    expect(executed).toEqual(['mcp__b__y']);

    // A server the session never had cannot be added to it.
    expect(apply(session, ['mcp__a__x', 'mcp__b__y', 'mcp__c__z'])).toBe('recreate');
    session.dispose();
  });
});
