/**
 * @module pi-extensions/bash-restrictions/extension
 *
 * Pi CLI extension — bash restrictions gate.
 *
 * Layers Open Cowork's bash trust/denylist engine on top of `pi`'s own
 * permission flow via the public `tool_call` event. Only the LLM's bash tool
 * is gated; human `!`/`!!` commands (`user_bash`) are intentionally not
 * intercepted.
 *
 * The decision→result logic is extracted into the pure async function
 * `resolveBashToolCall` so it can be unit-tested without a live pi process.
 */
import type { ExtensionAPI, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_BASH_RESTRICTIONS_SETTINGS,
  type BashDecision,
  type BashRestrictionsSettings,
} from '../../src/shared/bash-restrictions';
// Namespace import so tests can reliably spy on decideBashPermission via
// vi.spyOn(sharedModule, 'decideBashPermission') without being blocked by
// the local-reference capture that named imports create.
import * as bashRestrictionsModule from '../../src/shared/bash-restrictions';
import { loadBashRestrictionsSettings } from './config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The subset of ExtensionContext that resolveBashToolCall actually uses. */
export type BashCtx = {
  /** True in TUI / RPC modes; false in headless / piped invocations. */
  hasUI: boolean;
  /** May be absent in headless contexts — always guard with hasUI before use. */
  ui?: {
    select(
      title: string,
      options: string[],
      opts?: ExtensionUIDialogOptions
    ): Promise<string | undefined>;
    input(
      title: string,
      placeholder?: string,
      opts?: ExtensionUIDialogOptions
    ): Promise<string | undefined>;
  };
};

/** Successful block return shape expected by pi's tool_call event. */
type BlockResult = { block: true; reason: string };

// ---------------------------------------------------------------------------
// Dialog choice labels (kept as constants to stay DRY across code + tests)
// ---------------------------------------------------------------------------

export const CHOICE_ALLOW = 'Allow once' as const;
export const CHOICE_DENY = 'Deny' as const;
export const CHOICE_SUGGEST = 'Deny & suggest alternative' as const;

// ---------------------------------------------------------------------------
// Deny-and-suggest reason strings (verbatim from agent-runner.ts for parity)
// ---------------------------------------------------------------------------

const DENY_REASON = "User denied permission for 'bash'.";
const TIMEOUT_REASON = 'Blocked (timed out)';
const UNKNOWN_CHOICE_REASON = 'Blocked by bash restrictions (unexpected dialog result)';
const NO_UI_REASON = 'Blocked by bash restrictions (no UI to confirm)';
const UI_ERROR_REASON = 'Blocked by bash restrictions (ui error)';
const MISSING_COMMAND_REASON = 'Blocked by bash restrictions (missing command)';
const INTERNAL_ERROR_REASON = 'Blocked by bash restrictions (internal error)';

function buildSuggestReason(suggestion: string): string {
  const base =
    `User denied THIS SPECIFIC invocation of 'bash'. The tool 'bash' is NOT globally ` +
    `blocked — only this particular call was rejected. You may still use 'bash' for ` +
    `other purposes.`;
  return suggestion ? `${base} User's suggestion: ${suggestion}` : base;
}

/**
 * Sanitize a command string for display in a dialog title.
 * Strips C0/C1 control characters (which could corrupt TUI rendering) and
 * truncates to a safe maximum length.
 */
function sanitizeForDisplay(cmd: string, maxLength = 500): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = cmd.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trimEnd();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

// ---------------------------------------------------------------------------
// Core mapping function (pure, async, testable)
// ---------------------------------------------------------------------------

/**
 * Map a bash command + context + settings to a pi tool_call result.
 *
 * Engine outcomes:
 *   - `'allow'` or `null` (not opted-in) → `undefined` (let pi run it)
 *   - `'ask'` + `!ctx.hasUI`             → block (fail-closed)
 *   - `'ask'` + `ctx.hasUI`              → show select dialog → handle choice
 *
 * Interactive choices mirror the app's PermissionDialog:
 *   - "Allow once"                → `undefined`
 *   - "Deny"                      → block with plain-deny reason
 *   - "Deny & suggest alternative"→ prompt for text → block with suggestion
 *   - timeout / cancel (undefined)→ block (auto-deny)
 *
 * The `permissionTimeoutSeconds` setting drives the dialog timeout:
 *   - `0`        → no timeout option (waits forever)
 *   - positive   → `{ timeout: seconds * 1000 }` passed to select/input
 */
export async function resolveBashToolCall(
  command: string,
  ctx: BashCtx,
  settings: BashRestrictionsSettings
): Promise<BlockResult | undefined> {
  try {
    // Coerce command to string at the function boundary — the handler already
    // validates, but defend against callers that bypass (e.g. tests, future refactors).
    const safeCommand = typeof command === 'string' ? command : '';

    // Defensively coerce list fields — sanitizeBashRestrictionsSettings always
    // produces arrays, but callers may bypass the loader (e.g. tests, future code).
    const trusted = Array.isArray(settings.trusted) ? settings.trusted : [];
    const denied = Array.isArray(settings.denied) ? settings.denied : [];
    const isOptedIn = trusted.length > 0 || denied.length > 0;

    // When not opted-in (both lists empty), the gate is inactive — skip engine entirely.
    if (!isOptedIn) return undefined;

    // When opted-in and command is blank, fail-closed immediately.
    if (!safeCommand.trim()) {
      return { block: true, reason: MISSING_COMMAND_REASON };
    }

    // When opted-in, coerce a null result to 'ask' so an edge-case engine null
    // (e.g. all list patterns whitespace-only after trimming) never silently
    // bypasses the gate. When not opted-in, null correctly means "gate inactive".
    const rawDecision = bashRestrictionsModule.decideBashPermission(safeCommand, {
      trusted,
      denied,
    });
    // BashDecision = 'allow' | 'ask' | null. All three values handled explicitly below.
    const decision: BashDecision = isOptedIn ? (rawDecision ?? 'ask') : rawDecision;

    // 'allow' or null (not opted in) — defer to pi's own approval flow.
    if (decision === 'allow' || decision === null) return undefined;

    // Explicit guard for the expected 'ask' case. Any other value (e.g. a
    // future enum expansion) is handled by the fail-closed fallback below.
    if (decision !== 'ask') {
      return {
        block: true,
        reason: `Blocked by bash restrictions (unexpected decision: ${String(decision)})`,
      };
    }

    // 'ask' with no UI available — or ui.select absent — fail-closed.
    // Only select is required upfront; ui.input is checked only if the user
    // chooses CHOICE_SUGGEST (so environments that omit input still support
    // Allow / Deny paths).
    // BashCtx is a structural subset of ExtensionContext; hasUI + ui.select/input
    // are verified against the SDK type (ExtensionContext.hasUI: boolean,
    // ExtensionContext.ui: { select, input, ... }) in dist/core/extensions/types.d.ts.
    if (!ctx.hasUI || typeof ctx.ui?.select !== 'function') {
      return { block: true, reason: NO_UI_REASON };
    }

    // Normalize the timeout through the shared sanitizer so NaN/Infinity/negative
    // values are clamped consistently (0 = infinite, positive → [10, 3600]).
    const normalizedTimeout = bashRestrictionsModule.normalizePermissionTimeout(
      settings.permissionTimeoutSeconds
    );
    // Pass undefined (not {}) when infinite so the SDK sees no timeout option at all.
    const uiOpts: ExtensionUIDialogOptions | undefined =
      normalizedTimeout > 0 ? { timeout: Math.round(normalizedTimeout * 1000) } : undefined;

    // Wrap the UI interaction so that dialog errors (disconnect, RPC failure, etc.)
    // fail-closed rather than crashing the extension.
    try {
      const choice = await ctx.ui.select(
        `Bash restriction\n\n  ${sanitizeForDisplay(safeCommand)}`,
        [CHOICE_ALLOW, CHOICE_DENY, CHOICE_SUGGEST],
        uiOpts
      );

      if (choice === CHOICE_ALLOW) return undefined;

      if (choice === CHOICE_SUGGEST) {
        // input may be absent in some SDK versions — fall back to plain deny if so.
        if (typeof ctx.ui?.input !== 'function') {
          return { block: true, reason: DENY_REASON };
        }
        const raw = await ctx.ui.input(
          'Suggest an alternative approach',
          'e.g. "read the file instead"',
          uiOpts
        );
        // Sanitize user-supplied suggestion: strip control chars, cap length.
        const suggestion = sanitizeForDisplay((raw ?? '').trim(), 1000);
        return { block: true, reason: buildSuggestReason(suggestion) };
      }

      if (choice === CHOICE_DENY) {
        return { block: true, reason: DENY_REASON };
      }

      // choice is undefined → dialog timed out or was dismissed by user.
      if (choice === undefined) {
        return { block: true, reason: TIMEOUT_REASON };
      }

      // Unexpected non-null string value (future SDK change or custom dialog shim).
      return { block: true, reason: UNKNOWN_CHOICE_REASON };
    } catch (err) {
      // UI error (e.g. TUI disconnect, RPC failure) — fail-closed.
      // Log only a generic tag; err.message may embed sensitive context.
      console.error('[bash-restrictions] UI dialog error (err suppressed for safety)');
      void err;
      return { block: true, reason: UI_ERROR_REASON };
    }
  } catch (err) {
    // Catch-all for unexpected engine/config errors (e.g. malformed pattern throws).
    // Always fail-closed — any error that reaches here means the gate cannot
    // make a safe allow decision.
    console.error('[bash-restrictions] Internal error (err suppressed for safety)');
    void err;
    return { block: true, reason: INTERNAL_ERROR_REASON };
  }
}

// ---------------------------------------------------------------------------
// Pi extension factory (default export)
// ---------------------------------------------------------------------------

/**
 * Pi extension entry point.
 *
 * Loads settings once at startup (config reload requires `/reload` in pi or
 * a process restart) and intercepts every `bash` tool_call event.
 *
 * Note on `process.cwd()`: pi invokes extensions with the working directory
 * set to the session's project root, so `process.cwd()` matches the location
 * where `.pi/bash-restrictions.json` is expected. This follows the same
 * convention used by pi's own workspace-scoped settings loading.
 */
export default function (pi: ExtensionAPI): void {
  let settings: BashRestrictionsSettings;
  try {
    settings = loadBashRestrictionsSettings(process.cwd());
  } catch (err) {
    // loadBashRestrictionsSettings is designed to never throw, but wrap
    // defensively so a future regression here cannot crash pi at extension load.
    console.warn(
      '[bash-restrictions] Failed to load config, gate inactive:',
      err instanceof Error ? err.message : String(err)
    );
    settings = { ...DEFAULT_BASH_RESTRICTIONS_SETTINGS };
  }

  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('bash', event)) return undefined;
    // Returning undefined from tool_call lets the tool proceed through pi's
    // normal pipeline — it does NOT re-trigger pi's own permission dialog.
    // The two permission layers are independent; this extension runs first.
    // After isToolCallEventType('bash', event), TypeScript types event.input as
    // BashToolInput { command: string } per the SDK (dist/core/tools/bash.d.ts).
    // Defensively coerce at runtime in case the SDK emits a malformed event.
    const command = typeof event.input?.command === 'string' ? event.input.command : '';
    return resolveBashToolCall(command, ctx, settings);
  });

  // user_bash (human's ! / !! commands) is intentionally NOT gated here —
  // only the LLM-invoked bash tool is subject to the restriction engine.
}
