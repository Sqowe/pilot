/**
 * @module main/claude/pi-durations
 *
 * pi (1.1.0+) times model responses and tool runs itself, with a monotonic clock:
 * `durationMs` on the final assistant message (`pi-ai` `AssistantMessage`, set by
 * `AssistantMessageEventStream`) and on `tool_execution_end` (`pi-agent-core`,
 * the time `execute()` took). Both are optional — absent on responses pi did not
 * stream itself and when a tool never ran — so read them defensively.
 */

/** A duration pi reported, as whole milliseconds, or undefined when there is none. */
export function readPiDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}
