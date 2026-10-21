/**
 * @module main/claude/permission-gate
 *
 * The permission gate: the check that runs before every tool call the agent makes and
 * decides whether the call runs. Moved out of `agent-runner.ts` (`installPermissionHook`)
 * unchanged in behaviour, so every branch can be tested — and so a test on a real pi session
 * can show the gate is still reached after a pi uplift.
 *
 * For each call, in order:
 *  1. block repeated reads of the same file (`ReadLoopGuard`, always on);
 *  2. ask `decidePermissionDetailed` — rules, trusted directories, MCP tool policy;
 *  3. on `deny` block; on `ask` block in autonomous mode, otherwise open the permission
 *     dialog — counting open dialogs so the runner's activity timer stays paused — and block
 *     on any malformed or failed answer (fail closed);
 *  4. on allow, hand the call to `next` — the hook pi had installed.
 *
 * `installPermissionGate` puts it in place of pi's `agent.beforeToolCall` — the one private
 * reach-around left (AI_MAIN_PROCESS.md §1). Calls a tool makes through `ctx.executeTool()`
 * do not pass it — docs/design/permission-gate-tool-call-event.md.
 *
 * Known limitation: the async requestPermission wait (user dialog) causes the renderer to
 * miss UI update events. The tool executes correctly on the backend, but the renderer's
 * loading spinner may not clear. This is a renderer-side issue tracked as a follow-up.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  decidePermissionDetailed,
  getAutonomousBlockCallback,
  isSessionAutonomous,
  rememberAlwaysAllow,
} from '../config/permission-rules-store';
import type { PermissionAskReason } from '../../shared/permission-reason';
import { log, logError, logWarn } from '../utils/logger';
import {
  type AgentLike,
  type BeforeToolCallHook,
  type InstalledShape,
  captureExistingHook,
  installBeforeToolCallHook,
} from './before-tool-call-hook';
import { ReadLoopGuard, extractReadFilePath } from './read-loop-guard';

export type PermissionAnswer = 'allow' | 'deny' | 'allow_always' | 'deny_with_suggestion';

/** Opens the permission dialog over IPC and resolves with the user's answer. */
export type RequestPermission = (
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  reason?: PermissionAskReason
) => Promise<{ result: PermissionAnswer; suggestion?: string }>;

export interface PermissionGateDeps {
  sessionId: string;
  /**
   * The session's current cwd, read at call time. CONCURRENCY NOTE: the runner updates
   * `value` at the start of each run, before `prompt()`; pi runs prompts of a session one at
   * a time, so it is stable for the duration of any single prompt's tool calls. If that ever
   * changes (parallel prompts), this must become a per-prompt value.
   */
  cwdRef: { value: string };
  /**
   * Undefined in non-interactive setups: then only the read-loop guard applies and every
   * call is allowed. The key is required so that a caller cannot drop it by mistake — that
   * would switch the gate to allow-all, and no test builds the runner to notice.
   */
  requestPermission: RequestPermission | undefined;
  /** The hook pi had installed; called on the allow path. */
  next?: BeforeToolCallHook;
  /**
   * Open permission dialogs per session — the runner's map, which its activity timer reads.
   * Each entry carries the run it belongs to, so a dialog of a cancelled run that closes
   * after a new run started does not touch the new run's count.
   */
  waitState: Map<string, { runId: string; count: number }>;
  /** The current run's generation token. */
  currentRunId: () => string;
  /** Cancel the activity timer: a dialog is open. */
  pauseActivityTimeout: () => void;
  /** Start the activity timer again: the run's last open dialog closed. */
  restartActivityTimeout: () => void;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return `[Unserializable: ${details}]`;
  }
}

/** The gate for one session; it keeps that session's read-loop guard. */
export function createPermissionGate(deps: PermissionGateDeps): BeforeToolCallHook {
  const { sessionId, cwdRef, requestPermission, next, waitState } = deps;

  // Per-session guard against models reading the same file repeatedly,
  // exhausting the context window without making progress.
  // NOTE: This guard runs regardless of whether requestPermission is
  // configured — read-loop protection is a safety control that must
  // always be active, especially in auto-approve/non-interactive modes.
  const readLoopGuard = new ReadLoopGuard();

  return async (ctx, signal) => {
    const toolName: string = ctx.toolCall?.name ?? '';
    const input: Record<string, unknown> = ctx.args ?? {};

    // --- Read loop detection (always active) ---
    if (toolName === 'read') {
      const filePath = extractReadFilePath(input);
      if (filePath) {
        // Use cwdRef.value at call-time (not captured at install-time)
        // so path resolution stays correct across session reuse.
        const guardResult = readLoopGuard.check(filePath, cwdRef.value);
        if (guardResult.blocked) {
          logWarn(
            `[ClaudeAgentRunner] Read loop guard blocked read #${guardResult.count} of "${filePath}" in session ${sessionId}`
          );
          return { block: true, reason: guardResult.reason };
        }
      }
    }

    // --- Permission gating (only when requestPermission is configured) ---
    if (!requestPermission) {
      // No permission callback — delegate to SDK's original hook
      return next ? next(ctx, signal) : undefined;
    }

    const { action: decision, reason: askReason } = decidePermissionDetailed(
      sessionId,
      toolName,
      input
    );

    if (decision === 'deny') {
      log(`[ClaudeAgentRunner] Tool '${toolName}' denied by rule`);
      return { block: true, reason: `Tool '${toolName}' is denied by your permission rules.` };
    }

    if (decision === 'ask') {
      // v2: Autonomous mode — block instead of prompting
      if (isSessionAutonomous(sessionId)) {
        const rawCmd =
          input != null && typeof (input as Record<string, unknown>).command === 'string'
            ? ((input as Record<string, unknown>).command as string)
            : null;
        const cmdStr = rawCmd ?? safeStringify(input).slice(0, 200);
        log(
          `[ClaudeAgentRunner] Tool '${toolName}' blocked in autonomous mode (session ${sessionId})`
        );
        const blockCallback = getAutonomousBlockCallback();
        if (blockCallback) {
          try {
            blockCallback(sessionId, toolName, cmdStr);
          } catch (callbackErr) {
            logError('[ClaudeAgentRunner] Autonomous block callback failed:', callbackErr);
          }
        }
        return {
          block: true,
          reason: `Command blocked by permission policy (autonomous mode). Command: ${cmdStr}`,
        };
      }

      const toolUseId = `${ctx.toolCall?.id ?? 'unknown'}-perm-${uuidv4().slice(0, 8)}`;
      let result: { result: PermissionAnswer; suggestion?: string };
      // Capture the current runId BEFORE the try block so it's accessible in finally.
      // This is the generation token used to detect stale completions from cancelled runs.
      const capturedRunId = deps.currentRunId();
      try {
        // Pause the activity timeout while waiting for user's permission decision.
        // Without this, the 5-minute inactivity timer would abort the agent even
        // when the user has configured "No timeout (wait forever)" for permissions.
        //
        // We use a reference count (not boolean) because the SDK may issue
        // multiple parallel tool calls that each require permission.
        //
        // We also use capturedRunId (declared above) to detect stale completions:
        // if the session is cancelled and restarted while this await is pending,
        // the finally block will see a different runId and become a no-op.
        const existing = waitState.get(sessionId);
        if (existing && existing.runId === capturedRunId) {
          existing.count += 1;
        } else {
          // New run or first permission request — initialize state
          waitState.set(sessionId, { runId: capturedRunId, count: 1 });
        }

        // CRITICAL: Cancel any already-scheduled activity timeout immediately.
        // Without this, a timer started by the last SDK event could still fire
        // during the permission dialog wait and abort the session.
        deps.pauseActivityTimeout();

        const rawResult = await requestPermission(sessionId, toolUseId, toolName, input, askReason);
        // Normalize: accept both legacy string responses and new object shape.
        // Fail-closed on malformed/unknown values.
        if (typeof rawResult === 'string') {
          // Legacy string response — wrap into object
          const validStrings = ['allow', 'deny', 'allow_always', 'deny_with_suggestion'] as const;
          if (validStrings.includes(rawResult as (typeof validStrings)[number])) {
            result = { result: rawResult as (typeof validStrings)[number] };
          } else {
            logWarn(
              `[ClaudeAgentRunner] Unknown legacy permission string '${rawResult}' for '${toolName}' — failing closed`
            );
            return {
              block: true,
              reason: `Permission response invalid for '${toolName}'; tool not executed.`,
            };
          }
        } else if (rawResult && typeof rawResult === 'object' && 'result' in rawResult) {
          const validResults = ['allow', 'deny', 'allow_always', 'deny_with_suggestion'] as const;
          if (
            validResults.includes(
              (rawResult as { result: string }).result as (typeof validResults)[number]
            )
          ) {
            result = rawResult as typeof result;
          } else {
            logWarn(
              `[ClaudeAgentRunner] Unknown permission result '${(rawResult as { result: string }).result}' for '${toolName}' — failing closed`
            );
            return {
              block: true,
              reason: `Permission response invalid for '${toolName}'; tool not executed.`,
            };
          }
        } else {
          logWarn(
            `[ClaudeAgentRunner] Malformed permission response for '${toolName}' — failing closed`
          );
          return {
            block: true,
            reason: `Permission response malformed for '${toolName}'; tool not executed.`,
          };
        }
      } catch (permErr) {
        logError(
          `[ClaudeAgentRunner] Permission request failed for '${toolName}' — failing closed`,
          permErr
        );
        return {
          block: true,
          reason: `Permission request failed for '${toolName}'; tool not executed.`,
        };
      } finally {
        // Decrement the permission-wait reference count. The activity timeout
        // resumes only when all concurrent permission dialogs have resolved
        // (count reaches 0).
        //
        // STALE COMPLETION GUARD: If the session was cancelled and restarted
        // while this await was pending, the runId will have changed. In that
        // case, this finally block is stale and must be a no-op to avoid
        // corrupting the new run's permission state.
        const state = waitState.get(sessionId);
        if (state && state.runId === capturedRunId) {
          if (state.count <= 1) {
            waitState.delete(sessionId);
            // Immediately restart the activity timeout now that all permission
            // dialogs have resolved. Without this, if no further SDK event
            // arrives (e.g., tool was blocked), the session could hang
            // indefinitely with no inactivity timeout.
            deps.restartActivityTimeout();
          } else {
            state.count -= 1;
          }
        }
        // If runId doesn't match, this is a stale completion — ignore it.
      }

      if (result.result === 'deny') {
        log(`[ClaudeAgentRunner] Tool '${toolName}' denied by user`);
        return {
          block: true,
          reason: `User denied THIS SPECIFIC invocation of '${toolName}'. The tool '${toolName}' is NOT globally blocked — only this particular call was rejected. You may still use '${toolName}' for other purposes.`,
        };
      }

      if (result.result === 'deny_with_suggestion') {
        log(`[ClaudeAgentRunner] Tool '${toolName}' denied by user with suggestion`);
        const suggestion = result.suggestion || '';
        return {
          block: true,
          reason: `User denied THIS SPECIFIC invocation of '${toolName}'. The tool '${toolName}' is NOT globally blocked — only this particular call was rejected. You may still use '${toolName}' for other purposes. User's suggestion: ${suggestion}`,
        };
      }

      if (result.result === 'allow_always') {
        rememberAlwaysAllow(sessionId, toolName);
      }
    }

    // Allowed — delegate to SDK's original hook for event pipeline
    return next ? next(ctx, signal) : undefined;
  };
}

/**
 * Install the gate on a pi session in place of `agent.beforeToolCall`, keeping pi's own hook
 * as `next` so extension `tool_call` events still run on the allow path. Throws — so the
 * caller refuses to start the session — when the session has no agent or the agent has no
 * known hook shape. That a pi run then actually reaches the gate is shown by
 * `src/tests/claude/permission-gate-session.test.ts` on a real session.
 */
export function installPermissionGate(
  piSession: unknown,
  deps: Omit<PermissionGateDeps, 'next'>
): InstalledShape {
  // Access the Agent instance (public readonly property on AgentSession).
  const agent = (piSession as { agent?: AgentLike } | null)?.agent;
  if (!agent) {
    // Fail closed: without an agent we cannot gate tool calls. Throwing
    // prevents the caller from starting a session that would silently
    // bypass every permission rule.
    throw new Error(
      '[ClaudeAgentRunner] piSession.agent is missing — cannot install permission hook; refusing to start session'
    );
  }

  // Capture the SDK's existing hook before we overwrite it so the new
  // gate can delegate to it on the allow path — preserving extension
  // tool_call events and the SDK's internal event queue.
  const next = captureExistingHook(agent);

  // Install via the first supported shape — modern property preferred,
  // legacy setter as fallback. Throws on neither supported.
  return installBeforeToolCallHook(agent, createPermissionGate({ ...deps, next }));
}
