import { describe, expect, it, vi } from 'vitest';
import {
  type AgentLike,
  type BeforeToolCallHook,
  captureExistingHook,
  detectShape,
  installBeforeToolCallHook,
} from '../src/main/claude/before-tool-call-hook';

/**
 * Compatibility-matrix tests for the pi-coding-agent SDK hook installer.
 *
 * Motivation: a previous SDK bump (0.60 → 0.71) renamed the interception
 * API from `setBeforeToolCall()` to a public `beforeToolCall` property.
 * The caller's shape-detection guard silently skipped installation when
 * the setter disappeared, disabling every permission check until someone
 * noticed commands running without prompts. These tests pin down the
 * installer's behaviour across the four shape combinations so a future
 * API change either still works or fails loudly — never silently.
 */

const noopGate: BeforeToolCallHook = async () => undefined;

describe('detectShape', () => {
  it('recognizes the modern property shape even when the value is undefined', () => {
    // The SDK declares `beforeToolCall` as a class field, so it's `in` the
    // instance even before the user sets a hook. Using `'in'` instead of
    // `typeof …=== 'function'` lets us distinguish "supported but empty"
    // from "unsupported API shape".
    const agent: AgentLike = { beforeToolCall: undefined };
    expect(detectShape(agent)).toEqual({ hasProperty: true, hasSetter: false });
  });

  it('recognizes the legacy setter shape', () => {
    const agent: AgentLike = { setBeforeToolCall: () => {} };
    expect(detectShape(agent)).toEqual({ hasProperty: false, hasSetter: true });
  });

  it('recognizes both shapes when the SDK transitionally exposes them', () => {
    const agent: AgentLike = { beforeToolCall: undefined, setBeforeToolCall: () => {} };
    expect(detectShape(agent)).toEqual({ hasProperty: true, hasSetter: true });
  });

  it('reports neither shape on a plain object without the declared field', () => {
    // A POJO without `beforeToolCall` declared is NOT the SDK — guarding
    // against this prevents silently attaching to an arbitrary object
    // that happens to accept property writes.
    const agent = {} as AgentLike;
    expect(detectShape(agent)).toEqual({ hasProperty: false, hasSetter: false });
  });

  it('tolerates null/undefined agent inputs without throwing', () => {
    expect(detectShape(null as unknown as AgentLike)).toEqual({
      hasProperty: false,
      hasSetter: false,
    });
    expect(detectShape(undefined as unknown as AgentLike)).toEqual({
      hasProperty: false,
      hasSetter: false,
    });
  });
});

describe('captureExistingHook', () => {
  it('returns a bound copy of the modern property hook so `this` is preserved', () => {
    // Reason: if the SDK's existing hook uses `this` internally, a raw
    // reference would throw once the new gate overwrites the property.
    // Binding to the original agent keeps chained SDK behaviour correct.
    const capturedThis: unknown[] = [];
    const agent: AgentLike = {
      async beforeToolCall() {
        capturedThis.push(this);
        return undefined;
      },
    };
    const existing = captureExistingHook(agent);
    // Overwrite so an unbound reference would lose context.
    agent.beforeToolCall = async () => undefined;
    void existing?.({} as never);
    expect(capturedThis).toHaveLength(1);
    expect(capturedThis[0]).toBe(agent);
  });

  it('falls back to the legacy _beforeToolCall field when the property is empty', () => {
    const calls: number[] = [];
    const agent: AgentLike = {
      async _beforeToolCall() {
        calls.push(1);
        return undefined;
      },
    };
    const existing = captureExistingHook(agent);
    expect(existing).toBeTypeOf('function');
    void existing?.({} as never);
    expect(calls).toEqual([1]);
  });

  it('returns undefined when neither hook is set', () => {
    const agent: AgentLike = { beforeToolCall: undefined };
    expect(captureExistingHook(agent)).toBeUndefined();
  });
});

describe('installBeforeToolCallHook', () => {
  it('installs via the modern property when only that shape is available', () => {
    const agent: AgentLike = { beforeToolCall: undefined };
    const shape = installBeforeToolCallHook(agent, noopGate);
    expect(shape).toBe('property');
    expect(agent.beforeToolCall).toBe(noopGate);
  });

  it('installs via the legacy setter when only that shape is available', () => {
    const setter = vi.fn<(hook: BeforeToolCallHook) => void>();
    const agent: AgentLike = { setBeforeToolCall: setter };
    const shape = installBeforeToolCallHook(agent, noopGate);
    expect(shape).toBe('setter');
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith(noopGate);
  });

  it('prefers the modern property when both shapes are present', () => {
    // Reviewer guidance: if a future SDK keeps `setBeforeToolCall` as a
    // deprecated no-op while real interception moves to the property,
    // preferring the property keeps us on the live code path. This test
    // pins that ordering in place so no one casually flips it.
    const setter = vi.fn<(hook: BeforeToolCallHook) => void>();
    const agent: AgentLike = { beforeToolCall: undefined, setBeforeToolCall: setter };
    const shape = installBeforeToolCallHook(agent, noopGate);
    expect(shape).toBe('property');
    expect(agent.beforeToolCall).toBe(noopGate);
    expect(setter).not.toHaveBeenCalled();
  });

  it('throws when neither shape is supported (fail-closed, not fail-open)', () => {
    // This is the headline behaviour change vs. the pre-fix code: if an
    // SDK bump removes both known shapes, we MUST surface a loud error
    // rather than silently letting every tool call bypass permission
    // gating (which is what happened before this module existed).
    const agent = {} as AgentLike;
    expect(() => installBeforeToolCallHook(agent, noopGate)).toThrow(
      /neither 'beforeToolCall' property nor 'setBeforeToolCall' method/i
    );
  });

  it('does not partially mutate the agent when detection fails', () => {
    // Regression guard: ensure the throw path has not written any
    // property to the agent. Otherwise a caller that catches and
    // continues would see a ghost `beforeToolCall` that the SDK
    // never reads.
    const agent = { unrelated: 'x' } as AgentLike & { unrelated: string };
    try {
      installBeforeToolCallHook(agent, noopGate);
    } catch {
      /* expected */
    }
    expect('beforeToolCall' in agent).toBe(false);
    expect(agent.unrelated).toBe('x');
  });
});
