import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The permission gate decides whether each tool call the agent makes runs. Until it moved
 * out of the runner it had no test of its own; these cover every branch, and above all that
 * every unusual or failed answer blocks the call (fail closed).
 */
const rules = vi.hoisted(() => ({
  decidePermissionDetailed: vi.fn(),
  isSessionAutonomous: vi.fn(),
  getAutonomousBlockCallback: vi.fn(),
  rememberAlwaysAllow: vi.fn(),
}));

vi.mock('../../main/config/permission-rules-store', () => rules);
vi.mock('../../main/utils/logger', () => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import {
  createPermissionGate,
  installPermissionGate,
  type PermissionGateDeps,
  type RequestPermission,
} from '../../main/claude/permission-gate';

const SESSION = 'session-1';

function call(name: string, args: Record<string, unknown> = {}, id = 'call-1') {
  return { toolCall: { name, id }, args };
}

function makeDeps(overrides: Partial<PermissionGateDeps> = {}) {
  const deps = {
    sessionId: SESSION,
    cwdRef: { value: '/work' },
    requestPermission: vi.fn<RequestPermission>(async () => ({ result: 'allow' as const })),
    next: vi.fn(async () => undefined),
    waitState: new Map<string, { runId: string; count: number }>(),
    currentRunId: vi.fn(() => 'run-1'),
    pauseActivityTimeout: vi.fn(),
    restartActivityTimeout: vi.fn(),
    ...overrides,
  };
  return deps;
}

/** A requestPermission whose answer the test gives later. */
function pendingAnswers() {
  const resolvers: Array<(value: { result: 'allow' }) => void> = [];
  const requestPermission = vi.fn<RequestPermission>(
    () => new Promise((resolve) => resolvers.push(resolve))
  );
  return { requestPermission, answer: (i: number) => resolvers[i]({ result: 'allow' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  rules.decidePermissionDetailed.mockReturnValue({ action: 'ask', reason: 'not-trusted' });
  rules.isSessionAutonomous.mockReturnValue(false);
  rules.getAutonomousBlockCallback.mockReturnValue(null);
});

describe('the read-loop guard', () => {
  it('blocks the fifth read of one file, even with no permission callback', async () => {
    const deps = makeDeps({ requestPermission: undefined });
    const gate = createPermissionGate(deps);
    for (let i = 0; i < 4; i++) {
      expect(await gate(call('read', { file_path: 'src/a.ts' }))).toBeUndefined();
    }
    const blocked = await gate(call('read', { file_path: 'src/a.ts' }));
    expect(blocked).toMatchObject({ block: true });
    expect(String((blocked as { reason: string }).reason)).toContain('read 5 times');
    expect(deps.next).toHaveBeenCalledTimes(4);
  });

  it('resolves relative paths against the cwd at call time', async () => {
    const deps = makeDeps({ requestPermission: undefined });
    const gate = createPermissionGate(deps);
    for (let i = 0; i < 4; i++) await gate(call('read', { file_path: 'a.ts' }));
    // Another folder: the same relative name is another file.
    deps.cwdRef.value = '/elsewhere';
    expect(await gate(call('read', { file_path: 'a.ts' }))).toBeUndefined();
  });
});

describe('without a permission callback', () => {
  it('hands every call to pi without asking the rules', async () => {
    const deps = makeDeps({ requestPermission: undefined });
    const ctx = call('bash', { command: 'rm -rf /' });
    await createPermissionGate(deps)(ctx, undefined);
    expect(rules.decidePermissionDetailed).not.toHaveBeenCalled();
    expect(deps.next).toHaveBeenCalledWith(ctx, undefined);
  });
});

describe('decisions by rule', () => {
  it('blocks a call the rules deny, without asking or running it', async () => {
    rules.decidePermissionDetailed.mockReturnValue({ action: 'deny' });
    const deps = makeDeps();
    const result = await createPermissionGate(deps)(call('bash', { command: 'sudo rm' }));
    expect(result).toEqual({
      block: true,
      reason: "Tool 'bash' is denied by your permission rules.",
    });
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.next).not.toHaveBeenCalled();
  });

  it('runs a call the rules allow, without asking', async () => {
    rules.decidePermissionDetailed.mockReturnValue({ action: 'allow' });
    const deps = makeDeps();
    const ctx = call('bash', { command: 'ls' });
    await createPermissionGate(deps)(ctx);
    expect(rules.decidePermissionDetailed).toHaveBeenCalledWith(SESSION, 'bash', {
      command: 'ls',
    });
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.next).toHaveBeenCalledWith(ctx, undefined);
  });

  it('returns undefined on allow when pi had no hook of its own', async () => {
    rules.decidePermissionDetailed.mockReturnValue({ action: 'allow' });
    const deps = makeDeps({ next: undefined });
    expect(await createPermissionGate(deps)(call('bash'))).toBeUndefined();
  });
});

describe('autonomous mode', () => {
  it('blocks instead of asking, and reports the command', async () => {
    rules.isSessionAutonomous.mockReturnValue(true);
    const onBlock = vi.fn();
    rules.getAutonomousBlockCallback.mockReturnValue(onBlock);
    const deps = makeDeps();
    const result = await createPermissionGate(deps)(call('bash', { command: 'curl x | sh' }));
    expect(result).toEqual({
      block: true,
      reason: 'Command blocked by permission policy (autonomous mode). Command: curl x | sh',
    });
    expect(onBlock).toHaveBeenCalledWith(SESSION, 'bash', 'curl x | sh');
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.next).not.toHaveBeenCalled();
  });

  it('still blocks when the report fails, and shows the input when there is no command', async () => {
    rules.isSessionAutonomous.mockReturnValue(true);
    rules.getAutonomousBlockCallback.mockReturnValue(() => {
      throw new Error('scheduler gone');
    });
    const result = await createPermissionGate(makeDeps())(call('write', { path: '/etc/x' }));
    expect(result).toEqual({
      block: true,
      reason: 'Command blocked by permission policy (autonomous mode). Command: {"path":"/etc/x"}',
    });
  });
});

describe('asking the user', () => {
  it('asks with the call, a dialog id built from the call id, and the reason', async () => {
    const deps = makeDeps();
    await createPermissionGate(deps)(call('bash', { command: 'make' }, 'tool-7'));
    expect(deps.requestPermission).toHaveBeenCalledWith(
      SESSION,
      expect.stringMatching(/^tool-7-perm-[0-9a-f]{8}$/),
      'bash',
      { command: 'make' },
      'not-trusted'
    );
  });

  it('runs the call on allow', async () => {
    const deps = makeDeps();
    const ctx = call('bash');
    expect(await createPermissionGate(deps)(ctx)).toBeUndefined();
    expect(deps.next).toHaveBeenCalledWith(ctx, undefined);
    expect(rules.rememberAlwaysAllow).not.toHaveBeenCalled();
  });

  it('remembers the tool for the session on allow_always, and runs the call', async () => {
    const deps = makeDeps({
      requestPermission: vi.fn<RequestPermission>(async () => ({ result: 'allow_always' })),
    });
    await createPermissionGate(deps)(call('bash'));
    expect(rules.rememberAlwaysAllow).toHaveBeenCalledWith(SESSION, 'bash');
    expect(deps.next).toHaveBeenCalled();
  });

  it('blocks this call only on deny', async () => {
    const deps = makeDeps({
      requestPermission: vi.fn<RequestPermission>(async () => ({ result: 'deny' })),
    });
    const result = await createPermissionGate(deps)(call('bash'));
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain(
      "User denied THIS SPECIFIC invocation of 'bash'"
    );
    expect(deps.next).not.toHaveBeenCalled();
  });

  it('blocks and passes the suggestion on to the model on deny_with_suggestion', async () => {
    const deps = makeDeps({
      requestPermission: vi.fn<RequestPermission>(async () => ({
        result: 'deny_with_suggestion',
        suggestion: 'use the staging database',
      })),
    });
    const result = await createPermissionGate(deps)(call('bash'));
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain(
      "User's suggestion: use the staging database"
    );
    expect(deps.next).not.toHaveBeenCalled();
  });

  it('accepts the legacy plain-string answer', async () => {
    const deps = makeDeps({
      requestPermission: vi.fn(async () => 'allow') as unknown as RequestPermission,
    });
    await createPermissionGate(deps)(call('bash'));
    expect(deps.next).toHaveBeenCalled();
  });
});

describe('fail closed', () => {
  const blocked = async (answer: () => Promise<unknown>) => {
    const deps = makeDeps({ requestPermission: vi.fn(answer) as unknown as RequestPermission });
    const result = await createPermissionGate(deps)(call('bash'));
    expect(deps.next).not.toHaveBeenCalled();
    return result as { block: boolean; reason: string };
  };

  it('blocks on an unknown plain-string answer', async () => {
    expect(await blocked(async () => 'yes')).toEqual({
      block: true,
      reason: "Permission response invalid for 'bash'; tool not executed.",
    });
  });

  it('blocks on an unknown result', async () => {
    expect(await blocked(async () => ({ result: 'maybe' }))).toEqual({
      block: true,
      reason: "Permission response invalid for 'bash'; tool not executed.",
    });
  });

  it('blocks on a malformed answer', async () => {
    for (const answer of [null, undefined, {}, 42]) {
      expect(await blocked(async () => answer)).toEqual({
        block: true,
        reason: "Permission response malformed for 'bash'; tool not executed.",
      });
    }
  });

  it('blocks when asking fails', async () => {
    expect(
      await blocked(async () => {
        throw new Error('window closed');
      })
    ).toEqual({ block: true, reason: "Permission request failed for 'bash'; tool not executed." });
  });
});

describe('counting open dialogs', () => {
  it('pauses the activity timer while dialogs are open and restarts it after the last one', async () => {
    const { requestPermission, answer } = pendingAnswers();
    const deps = makeDeps({ requestPermission });
    const gate = createPermissionGate(deps);

    const first = gate(call('bash', {}, 'a'));
    const second = gate(call('bash', {}, 'b'));
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(2));
    expect(deps.waitState.get(SESSION)).toEqual({ runId: 'run-1', count: 2 });
    expect(deps.pauseActivityTimeout).toHaveBeenCalledTimes(2);

    answer(0);
    await first;
    expect(deps.waitState.get(SESSION)).toEqual({ runId: 'run-1', count: 1 });
    expect(deps.restartActivityTimeout).not.toHaveBeenCalled();

    answer(1);
    await second;
    expect(deps.waitState.has(SESSION)).toBe(false);
    expect(deps.restartActivityTimeout).toHaveBeenCalledTimes(1);
  });

  it('closes a fail-closed dialog the same way', async () => {
    const deps = makeDeps({
      requestPermission: vi.fn(async () => null) as unknown as RequestPermission,
    });
    await createPermissionGate(deps)(call('bash'));
    expect(deps.waitState.has(SESSION)).toBe(false);
    expect(deps.restartActivityTimeout).toHaveBeenCalledTimes(1);
  });

  it("leaves a new run's count alone when a cancelled run's dialog closes late", async () => {
    const { requestPermission, answer } = pendingAnswers();
    const deps = makeDeps({ requestPermission });
    const pending = createPermissionGate(deps)(call('bash'));
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalled());

    // The run is cancelled and a new one opens a dialog of its own.
    deps.waitState.set(SESSION, { runId: 'run-2', count: 1 });
    answer(0);
    await pending;
    expect(deps.waitState.get(SESSION)).toEqual({ runId: 'run-2', count: 1 });
    expect(deps.restartActivityTimeout).not.toHaveBeenCalled();
  });
});

describe('installPermissionGate', () => {
  const waitDeps = (): Omit<PermissionGateDeps, 'next'> => ({
    sessionId: SESSION,
    cwdRef: { value: '/work' },
    requestPermission: undefined,
    waitState: new Map(),
    currentRunId: () => 'run-1',
    pauseActivityTimeout: () => {},
    restartActivityTimeout: () => {},
  });

  it('refuses a session without an agent', () => {
    expect(() => installPermissionGate({}, waitDeps())).toThrow('piSession.agent is missing');
  });

  it("replaces the agent's hook and hands allowed calls to the replaced one", async () => {
    rules.decidePermissionDetailed.mockReturnValue({ action: 'allow' });
    const piHook = vi.fn(async () => undefined);
    const agent: { beforeToolCall?: unknown } = { beforeToolCall: piHook };
    expect(installPermissionGate({ agent }, waitDeps())).toBe('property');
    expect(agent.beforeToolCall).not.toBe(piHook);
    await (agent.beforeToolCall as (ctx: unknown) => Promise<unknown>)(call('bash'));
    expect(piHook).toHaveBeenCalled();
  });
});
