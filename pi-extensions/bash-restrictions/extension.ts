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
 * When `trustedDirectories` is configured, the same event also checks where a
 * call writes: visible bash write targets, and the `path` of the `write` /
 * `edit` tools (docs/design/trusted-directories.md).
 *
 * The decision→result logic is extracted into the async functions
 * `resolveBashToolCall` and `resolveWriteToolCall` so it can be unit-tested
 * without a live pi process.
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
// The write-zone check resolves real paths; it is kept out of the fs-free barrel above.
import {
  checkBashWriteZone,
  describeBashReason,
} from '../../src/shared/bash-restrictions/write-zone';
import {
  DISABLED_WRITE_ZONE,
  decideWriteToolZone,
  describeRejectedDirectory,
  describeWriteZoneReason,
  type WriteZoneContext,
} from '../../src/shared/path-permissions';
import { loadBashRestrictions } from './config';

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

/** The write zone of the current session and the directory it was resolved against. */
export type WriteZoneSession = WriteZoneContext;

// ---------------------------------------------------------------------------
// Dialog choice labels (kept as constants to stay DRY across code + tests)
// ---------------------------------------------------------------------------

export const CHOICE_ALLOW = 'Allow once' as const;
export const CHOICE_DENY = 'Deny' as const;
export const CHOICE_SUGGEST = 'Deny & suggest alternative' as const;

// ---------------------------------------------------------------------------
// Deny-and-suggest reason strings (verbatim from agent-runner.ts for parity)
// ---------------------------------------------------------------------------

const TIMEOUT_REASON = 'Blocked (timed out)';
const MISSING_COMMAND_REASON = 'Blocked by bash restrictions (missing command)';

/** What the block reasons call the gate that stopped a tool. */
function gateName(toolName: string): string {
  return toolName === 'bash' ? 'bash restrictions' : 'trusted directories';
}

function denyReason(toolName: string): string {
  return `User denied permission for '${toolName}'.`;
}

function buildSuggestReason(toolName: string, suggestion: string): string {
  const base =
    `User denied THIS SPECIFIC invocation of '${toolName}'. The tool '${toolName}' is NOT globally ` +
    `blocked — only this particular call was rejected. You may still use '${toolName}' for ` +
    `other purposes.`;
  return suggestion ? `${base} User's suggestion: ${suggestion}` : base;
}

/**
 * Sanitize a string for display in a dialog title.
 * Strips C0/C1 control characters (which could corrupt TUI rendering) and
 * truncates to a safe maximum length.
 */
function sanitizeForDisplay(cmd: string, maxLength = 500): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = cmd.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trimEnd();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** The "Reason: …" line of a dialog title: one line, no control characters. */
function reasonLine(reasonText: string | undefined): string {
  if (!reasonText) return '';
  const oneLine = sanitizeForDisplay(reasonText, 300).replace(/\s+/g, ' ').trim();
  return oneLine ? `\nReason: ${oneLine}` : '';
}

// ---------------------------------------------------------------------------
// The permission dialog — shared by every tool this extension gates
// ---------------------------------------------------------------------------

/**
 * Ask the user about one tool call and map the answer to a pi tool_call result.
 *
 *   - "Allow once"                → `undefined` (the tool runs)
 *   - "Deny"                      → block with a plain-deny reason
 *   - "Deny & suggest alternative"→ prompt for text → block with the suggestion
 *   - timeout / cancel (undefined)→ block (auto-deny)
 *   - no UI, or a dialog error    → block (fail-closed)
 *
 * The `permissionTimeoutSeconds` setting drives the dialog timeout:
 *   - `0`        → no timeout option (waits forever)
 *   - positive   → `{ timeout: seconds * 1000 }` passed to select/input
 */
async function presentAsk(
  request: { toolName: string; heading: string; summary: string; reasonText?: string },
  ctx: BashCtx,
  settings: BashRestrictionsSettings
): Promise<BlockResult | undefined> {
  const { toolName } = request;
  const gate = gateName(toolName);

  // No UI available — or ui.select absent — fail-closed.
  // Only select is required upfront; ui.input is checked only if the user
  // chooses CHOICE_SUGGEST (so environments that omit input still support
  // Allow / Deny paths).
  // BashCtx is a structural subset of ExtensionContext; hasUI + ui.select/input
  // are verified against the SDK type (ExtensionContext.hasUI: boolean,
  // ExtensionContext.ui: { select, input, ... }) in dist/core/extensions/types.d.ts.
  if (!ctx.hasUI || typeof ctx.ui?.select !== 'function') {
    return { block: true, reason: `Blocked by ${gate} (no UI to confirm)` };
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
      `${request.heading}${reasonLine(request.reasonText)}\n\n  ${sanitizeForDisplay(request.summary)}`,
      [CHOICE_ALLOW, CHOICE_DENY, CHOICE_SUGGEST],
      uiOpts
    );

    if (choice === CHOICE_ALLOW) return undefined;

    if (choice === CHOICE_SUGGEST) {
      // input may be absent in some SDK versions — fall back to plain deny if so.
      if (typeof ctx.ui?.input !== 'function') {
        return { block: true, reason: denyReason(toolName) };
      }
      const raw = await ctx.ui.input(
        'Suggest an alternative approach',
        'e.g. "read the file instead"',
        uiOpts
      );
      // Sanitize user-supplied suggestion: strip control chars, cap length.
      const suggestion = sanitizeForDisplay((raw ?? '').trim(), 1000);
      return { block: true, reason: buildSuggestReason(toolName, suggestion) };
    }

    if (choice === CHOICE_DENY) {
      return { block: true, reason: denyReason(toolName) };
    }

    // choice is undefined → dialog timed out or was dismissed by user.
    if (choice === undefined) {
      return { block: true, reason: TIMEOUT_REASON };
    }

    // Unexpected non-null string value (future SDK change or custom dialog shim).
    return { block: true, reason: `Blocked by ${gate} (unexpected dialog result)` };
  } catch (err) {
    // UI error (e.g. TUI disconnect, RPC failure) — fail-closed.
    // Log only a generic tag; err.message may embed sensitive context.
    console.error('[bash-restrictions] UI dialog error (err suppressed for safety)');
    void err;
    return { block: true, reason: `Blocked by ${gate} (ui error)` };
  }
}

// ---------------------------------------------------------------------------
// Core mapping functions (async, testable)
// ---------------------------------------------------------------------------

/**
 * Map a bash command + context + settings to a pi tool_call result.
 *
 * Decision, in order:
 *   1. The command lists (when either is non-empty): `'ask'` stays `'ask'`.
 *   2. The write zone (when `trustedDirectories` is configured), only if step 1
 *      did not already ask: a visible write outside the zone → `'ask'`. The
 *      zone can only add a prompt — it never makes an untrusted command trusted.
 *
 * Outcomes:
 *   - `'allow'` or `null` (nothing configured) → `undefined` (let pi run it)
 *   - `'ask'` + `!ctx.hasUI`                   → block (fail-closed)
 *   - `'ask'` + `ctx.hasUI`                    → dialog → handle choice
 *
 * `zoneSession` is optional so callers that only use the command lists keep
 * their existing behaviour.
 */
export async function resolveBashToolCall(
  command: string,
  ctx: BashCtx,
  settings: BashRestrictionsSettings,
  zoneSession?: WriteZoneSession
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
    const zoneOn = zoneSession?.zone.enabled === true;

    // Nothing configured — the gate is inactive, skip the engine entirely.
    if (!isOptedIn && !zoneOn) return undefined;

    if (!safeCommand.trim()) {
      // With the command lists on, a blank command fails closed. With only the
      // write zone on there is nothing that could write anywhere.
      return isOptedIn ? { block: true, reason: MISSING_COMMAND_REASON } : undefined;
    }

    let decision: BashDecision = null;
    let reasonText: string | undefined;

    if (isOptedIn) {
      // Coerce a null result to 'ask' so an edge-case engine null (e.g. all list
      // patterns whitespace-only after trimming) never silently bypasses the gate.
      const rawDecision = bashRestrictionsModule.decideBashPermission(safeCommand, {
        trusted,
        denied,
      });
      // BashDecision = 'allow' | 'ask' | null. All three values handled explicitly below.
      decision = rawDecision ?? 'ask';
      if (decision === 'ask') {
        const detail = bashRestrictionsModule.explainBashPermission(safeCommand, {
          trusted,
          denied,
        });
        if (detail.reason) reasonText = describeBashReason(detail.reason);
      }
    }

    if ((decision === 'allow' || decision === null) && zoneOn && zoneSession) {
      const zoneReason = checkBashWriteZone(safeCommand, zoneSession);
      if (zoneReason !== null) {
        decision = 'ask';
        reasonText = describeBashReason(zoneReason);
      }
    }

    // 'allow' or null — defer to pi's own flow.
    if (decision === 'allow' || decision === null) return undefined;

    // Explicit guard for the expected 'ask' case. Any other value (e.g. a
    // future enum expansion) is handled by the fail-closed fallback below.
    if (decision !== 'ask') {
      return {
        block: true,
        reason: `Blocked by bash restrictions (unexpected decision: ${String(decision)})`,
      };
    }

    return await presentAsk(
      { toolName: 'bash', heading: 'Bash restriction', summary: safeCommand, reasonText },
      ctx,
      settings
    );
  } catch (err) {
    // Catch-all for unexpected engine/config errors (e.g. malformed pattern throws).
    // Always fail-closed — any error that reaches here means the gate cannot
    // make a safe allow decision.
    console.error('[bash-restrictions] Internal error (err suppressed for safety)');
    void err;
    return { block: true, reason: 'Blocked by bash restrictions (internal error)' };
  }
}

/**
 * Map a `write` / `edit` call to a pi tool_call result using the write zone.
 *
 *   - zone off, or the target is inside a trusted directory → `undefined`
 *   - target outside, one of the gate's own settings files, or undeterminable
 *     → dialog (interactive) or block (headless)
 */
export async function resolveWriteToolCall(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  ctx: BashCtx,
  settings: BashRestrictionsSettings,
  zoneSession: WriteZoneSession | undefined
): Promise<BlockResult | undefined> {
  try {
    if (!zoneSession || zoneSession.zone.enabled !== true) return undefined;

    const verdict = decideWriteToolZone(toolName, input, zoneSession);
    if (verdict === null || verdict.decision === 'allow') return undefined;

    const rawPath = typeof input?.path === 'string' ? input.path : '(no path)';
    return await presentAsk(
      {
        toolName,
        heading: 'Write outside trusted directories',
        summary: `${toolName} ${rawPath}`,
        reasonText: verdict.reason ? describeWriteZoneReason(verdict.reason) : undefined,
      },
      ctx,
      settings
    );
  } catch (err) {
    console.error('[bash-restrictions] Internal error (err suppressed for safety)');
    void err;
    return { block: true, reason: 'Blocked by trusted directories (internal error)' };
  }
}

// ---------------------------------------------------------------------------
// Pi extension factory (default export)
// ---------------------------------------------------------------------------

/** Minimal shape of the session/tool context fields the loader needs. */
type LoadCtx = {
  cwd?: string;
  isProjectTrusted?: () => boolean;
  hasUI?: boolean;
  ui?: { notify?: (message: string, type?: 'info' | 'warning' | 'error') => void };
};

/**
 * Pi extension entry point.
 *
 * Settings are (re)loaded on `session_start` — NOT in the factory. Per pi's
 * extensions.md, the factory may run in invocations that never start a session,
 * so resource work is deferred to `session_start`, the session cwd is read from
 * `ctx.cwd` (not `process.cwd()`), and the project-local config file is honored
 * only when `ctx.isProjectTrusted()` is true. `session_start` also fires on
 * `/reload`, `/new`, `/resume`, and `/fork`, so editing the JSON and running
 * `/reload` refreshes the settings.
 */
export default function (pi: ExtensionAPI): void {
  let settings: BashRestrictionsSettings = { ...DEFAULT_BASH_RESTRICTIONS_SETTINGS };
  let zoneSession: WriteZoneSession = { zone: DISABLED_WRITE_ZONE, cwd: undefined };

  function loadSettings(ctx: LoadCtx): void {
    try {
      const cwd = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : process.cwd();
      // Fail closed: if the SDK can't report trust, treat the project as
      // untrusted so its config cannot loosen the gate. Only global config applies.
      const projectTrusted =
        typeof ctx.isProjectTrusted === 'function' ? ctx.isProjectTrusted() : false;
      const loaded = loadBashRestrictions(cwd, { projectTrusted });
      settings = loaded.settings;
      zoneSession = { zone: loaded.zone, cwd };

      // A directory entry that was not accepted never switches the checks off —
      // but the user should hear about it once, or every write will simply ask.
      if (loaded.zone.rejected.length > 0) {
        const message =
          'bash-restrictions: trusted directories not accepted — ' +
          loaded.zone.rejected.map(describeRejectedDirectory).join('; ');
        if (ctx.hasUI && typeof ctx.ui?.notify === 'function') ctx.ui.notify(message, 'warning');
        else console.warn(`[bash-restrictions] ${message}`);
      }
    } catch (err) {
      // loadBashRestrictions is designed to never throw, but wrap
      // defensively so a future regression here cannot crash pi.
      console.warn(
        '[bash-restrictions] Failed to load config, gate inactive:',
        err instanceof Error ? err.message : String(err)
      );
      settings = { ...DEFAULT_BASH_RESTRICTIONS_SETTINGS };
      zoneSession = { zone: DISABLED_WRITE_ZONE, cwd: undefined };
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    loadSettings(ctx);
  });

  pi.on('tool_call', async (event, ctx) => {
    // Returning undefined from tool_call lets the tool proceed through pi's
    // normal pipeline — it does NOT re-trigger pi's own permission dialog.
    // The two permission layers are independent; this extension runs first.
    const isBash = isToolCallEventType('bash', event);
    const isWrite = isToolCallEventType('write', event) || isToolCallEventType('edit', event);
    if (!isBash && !isWrite) return undefined;

    // The write zone is resolved against the session's working directory. If
    // the tool runs in a different one, rebuild before deciding.
    if (typeof ctx.cwd === 'string' && ctx.cwd && ctx.cwd !== zoneSession.cwd) {
      loadSettings(ctx);
    }

    if (isBash) {
      // After isToolCallEventType('bash', event), TypeScript types event.input as
      // BashToolInput { command: string } per the SDK (dist/core/tools/bash.d.ts).
      // Defensively coerce at runtime in case the SDK emits a malformed event.
      const command = typeof event.input?.command === 'string' ? event.input.command : '';
      return resolveBashToolCall(command, ctx, settings, zoneSession);
    }

    // write / edit: both carry the target in `input.path`
    // (dist/core/tools/write.d.ts, edit.d.ts — pi 0.85.1).
    return resolveWriteToolCall(
      event.toolName,
      event.input as Record<string, unknown>,
      ctx,
      settings,
      zoneSession
    );
  });

  // user_bash (human's ! / !! commands) is intentionally NOT gated here —
  // only the LLM-invoked tools are subject to the restriction engine.
}
