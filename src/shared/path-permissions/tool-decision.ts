/**
 * @module shared/path-permissions/tool-decision
 *
 * Write-zone decision for the file-writing tools (`write`, `edit`), shared by
 * the Electron app and the pi CLI extension.
 *
 * Node-standalone; NOT renderer-safe.
 */
import { resolveToolPath, type ResolveOptions } from './resolve';
import { classifyAbsolutePath, type WriteZone } from './zone';

/** Tools whose `path` argument is checked against the write zone. */
export const WRITE_ZONE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

/** Why a write was not let through. Shared by the tool check and the bash check. */
export type WriteZoneReason =
  | { kind: 'write-outside'; path: string }
  | { kind: 'write-protected'; path: string }
  | { kind: 'write-undetermined'; detail: string };

export interface WriteZoneContext extends ResolveOptions {
  zone: WriteZone;
  /** The session's working directory (pi: `ctx.cwd`; app: the session workspace). */
  cwd: string | undefined;
}

export interface WriteToolDecision {
  decision: 'allow' | 'ask';
  reason?: WriteZoneReason;
}

/**
 * Decide a `write` / `edit` call against the write zone.
 *
 *   - null    — the zone is off, or the tool is not one this check covers;
 *               the caller keeps its existing behaviour.
 *   - 'allow' — the target is inside a trusted directory.
 *   - 'ask'   — the target is outside, is one of the gate's own settings
 *               files, or cannot be determined.
 */
export function decideWriteToolZone(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  ctx: WriteZoneContext
): WriteToolDecision | null {
  if (!ctx.zone.enabled) return null;
  if (!WRITE_ZONE_TOOLS.has(String(toolName).toLowerCase())) return null;

  const rawPath = input?.path;
  if (typeof rawPath !== 'string' || !rawPath) {
    return { decision: 'ask', reason: { kind: 'write-undetermined', detail: 'no path given' } };
  }
  if (!ctx.cwd) {
    return {
      decision: 'ask',
      reason: { kind: 'write-undetermined', detail: 'the working directory is unknown' },
    };
  }

  const absolute = resolveToolPath(rawPath, ctx.cwd, ctx);
  if (!absolute) {
    return { decision: 'ask', reason: { kind: 'write-undetermined', detail: rawPath } };
  }

  const classified = classifyAbsolutePath(absolute, ctx.zone);
  if (classified.zone === 'inside') return { decision: 'allow' };
  if (classified.zone === 'protected') {
    return {
      decision: 'ask',
      reason: { kind: 'write-protected', path: classified.realPath ?? absolute },
    };
  }
  if (classified.zone === 'outside') {
    return {
      decision: 'ask',
      reason: { kind: 'write-outside', path: classified.realPath ?? absolute },
    };
  }
  return { decision: 'ask', reason: { kind: 'write-undetermined', detail: rawPath } };
}

/** Human-readable text for a write-zone reason, for permission prompts. */
export function describeWriteZoneReason(reason: WriteZoneReason): string {
  switch (reason.kind) {
    case 'write-outside':
      return `writes outside the trusted directories: ${reason.path}`;
    case 'write-protected':
      return `writes to a permission settings file: ${reason.path}`;
    default:
      return `the write target cannot be determined: ${reason.detail}`;
  }
}
