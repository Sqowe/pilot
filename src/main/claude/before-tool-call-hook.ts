/**
 * @module main/claude/before-tool-call-hook
 *
 * SDK-shape-aware installer for the pi-coding-agent `beforeToolCall` hook.
 *
 * The pi-coding-agent SDK has changed its interception API twice in recent
 * memory: older releases exposed `agent.setBeforeToolCall()` plus an
 * internal `agent._beforeToolCall` field; 0.71+ dropped the setter and
 * made `agent.beforeToolCall` a public property assigned at construction
 * time or directly afterwards. When the 0.71 bump landed we had a
 * `typeof agent.setBeforeToolCall !== 'function'` guard that silently
 * logged a warning and skipped installation — which disabled every
 * permission check, including the bash trust/deny lists, until someone
 * noticed commands were executing without prompts.
 *
 * This module exists so the shape detection is:
 *   1. concentrated in one place with a narrow, documented contract
 *   2. fully unit-testable without instantiating a real SDK session
 *   3. fail-closed: if neither known shape is present we throw, so a
 *      future SDK change cannot silently disable permissions again
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtx = any;
export type BeforeToolCallHook = (ctx: AnyCtx, signal?: AbortSignal) => Promise<unknown>;

/**
 * Minimal duck-typed view of the SDK `Agent` we depend on. Kept narrow so
 * tests can supply plain objects and the TypeScript surface is stable
 * across SDK internal reshuffles.
 */
export interface AgentLike {
  /**
   * Modern shape (pi-coding-agent ≥ 0.71): public property assigned
   * directly. `'beforeToolCall' in agent` is the signal — the SDK's
   * class field declaration makes this true even when unset, which
   * distinguishes it from a random object where anyone can add any
   * property after the fact.
   */
  beforeToolCall?: BeforeToolCallHook;
  /**
   * Legacy shape (pi-coding-agent ≤ 0.60): setter method. We keep
   * supporting this so a pinned dependency during rollout doesn't
   * get caught out, but prefer the modern property when both exist.
   */
  setBeforeToolCall?: (hook: BeforeToolCallHook) => void;
  /** Legacy internal field some older SDK versions used. */
  _beforeToolCall?: BeforeToolCallHook;
}

/** Which interception shape the installer detected and used. */
export type InstalledShape = 'property' | 'setter';

/**
 * Result of inspecting an `agent` for supported hook shapes. Exposed so
 * the caller can log the chosen path without re-running the detection.
 */
export interface DetectedShape {
  /** Whether `'beforeToolCall'` is declared on the agent or its prototype. */
  hasProperty: boolean;
  /** Whether a `setBeforeToolCall()` method is callable on the agent. */
  hasSetter: boolean;
}

/**
 * Inspect an agent instance for the two known hook shapes.
 *
 * Uses `'beforeToolCall' in agent` rather than a `typeof` check because
 * the SDK declares the field at class level (so it's always "in") but
 * leaves the value `undefined` until assigned. A plain POJO with no such
 * field would not satisfy `'in'`, giving us a real signal that this is
 * a shape we recognize — not just any object someone handed us.
 */
export function detectShape(agent: AgentLike): DetectedShape {
  const hasProperty = agent != null && typeof agent === 'object' && 'beforeToolCall' in agent;
  const hasSetter = agent != null && typeof (agent as AgentLike).setBeforeToolCall === 'function';
  return { hasProperty, hasSetter };
}

/**
 * Capture the currently-installed hook on `agent` so the newly-installed
 * gate can delegate to it on the allow path. Preserves the SDK's event
 * pipeline (extension tool_call events, internal queue) which would
 * otherwise be broken by overwriting the property outright.
 *
 * Prefers the modern property; falls back to the legacy private field.
 * Bound to `agent` so the captured function can safely use `this`.
 */
export function captureExistingHook(agent: AgentLike): BeforeToolCallHook | undefined {
  if (typeof agent?.beforeToolCall === 'function') {
    return agent.beforeToolCall.bind(agent);
  }
  if (typeof agent?._beforeToolCall === 'function') {
    return agent._beforeToolCall.bind(agent);
  }
  return undefined;
}

/**
 * Install `gate` as the `beforeToolCall` hook on `agent` and return which
 * shape was used. Throws if neither shape is available — callers MUST
 * surface this as a startup-blocking error rather than letting a session
 * proceed without a permission gate.
 *
 * Ordering: the modern public-property shape is preferred over the legacy
 * setter. If a future SDK release keeps `setBeforeToolCall` as a
 * deprecated no-op while real interception runs through the property,
 * preferring the property keeps us on the live code path. The legacy
 * setter is attempted only when the property shape is unavailable.
 *
 * @throws Error when neither shape is supported. The message is explicit
 *   so the caller can propagate it directly to the user.
 */
export function installBeforeToolCallHook(
  agent: AgentLike,
  gate: BeforeToolCallHook
): InstalledShape {
  const shape = detectShape(agent);

  if (shape.hasProperty) {
    agent.beforeToolCall = gate;
    return 'property';
  }

  if (shape.hasSetter) {
    // setter is guarded by hasSetter which already narrowed the type.
    agent.setBeforeToolCall!(gate);
    return 'setter';
  }

  throw new Error(
    "pi-coding-agent SDK exposes neither 'beforeToolCall' property nor " +
      "'setBeforeToolCall' method; refusing to start session without a " +
      'permission gate. The SDK API likely changed — update the hook installer.'
  );
}
