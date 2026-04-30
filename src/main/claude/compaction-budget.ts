/**
 * @module main/claude/compaction-budget
 *
 * Pure, testable helpers for computing pi-coding-agent compaction settings
 * that account for tool-schema payloads in addition to the conversation
 * history.
 *
 * Background: pi-coding-agent's built-in `shouldCompact` compares reported
 * conversation tokens against `contextWindow - reserveTokens`, where
 * `reserveTokens` defaults to 16K (sized for output only). Tool definitions
 * (built-in + MCP customTools) are NOT counted — they are sent fresh on every
 * request and can easily reach 20K+ tokens, pushing requests past the
 * provider's hard context limit before compaction ever fires.
 *
 * These helpers compute a `reserveTokens` that covers output + tool schemas +
 * a safety margin, and a `keepRecentTokens` that never exceeds what actually
 * fits in the window.
 */

/**
 * Shape that covers both pi-coding-agent ToolDefinition (built-in + MCP) and
 * the raw objects we pass through wrappers. Intentionally loose — we only
 * need `name`, `description`, and `parameters` for token estimation.
 */
export interface ToolLike {
  name?: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Target headroom we prefer to leave for conversation input. This is a
 * *soft* target — when tool schemas + output budget exceed
 * `contextWindow - MIN_INPUT_HEADROOM`, we prioritize overflow prevention
 * over input headroom (the window is then effectively unusable, but we do
 * not silently allow provider-side overflow).
 */
export const MIN_INPUT_HEADROOM = 8000;

/**
 * Minimum recent-history retention when the window can support it. Below this
 * compaction is aggressive enough that sessions lose useful recent context,
 * so we target at least this much. NOTE: only used as a candidate target, not
 * a hard floor — on very tight windows keepRecent may legitimately drop to 0.
 */
export const MIN_KEEP_RECENT = 4000;

/**
 * Upper cap on how much recent history we retain, even on huge windows.
 * Larger values work but waste tokens on stale context.
 */
export const MAX_KEEP_RECENT = 32000;

/**
 * Default safety margin on top of modelMaxOutput + toolSchemaTokens.
 * Absorbs chars/4 underestimates (CJK text, dense JSON tool results).
 */
export const DEFAULT_SAFETY_MARGIN = 4000;

/**
 * Default modelMaxOutput when the model descriptor doesn't specify one.
 * Mirrors pi-coding-agent's own 16K default for Claude-family models.
 */
export const DEFAULT_MODEL_MAX_OUTPUT = 16384;

/**
 * Coerce an arbitrary input to a safe non-negative integer.
 *
 * Inputs from model registries and persisted profiles are not always
 * well-formed JavaScript numbers:
 *   - Numeric strings like "16384" (e.g. from JSON/electron-store payloads
 *     or user profile fields that bypass the UI's Number() conversion)
 *   - Empty strings or malformed text -> NaN after coercion
 *   - Certain metadata sources emit Infinity for "unknown" caps
 *   - Users can (accidentally) type negative values
 *
 * If any of these slip through to arithmetic, compaction math produces NaN
 * and `shouldCompact`'s comparison silently short-circuits — compaction
 * never triggers, which is the exact failure mode this module exists to
 * prevent. We coerce via Number() first, then validate.
 */
function toSafeNonNegativeInt(value: unknown, fallback: number): number {
  // Preserve null/undefined fast-path — Number(null) is 0 but we want the
  // configured fallback (e.g., DEFAULT_MODEL_MAX_OUTPUT) in that case.
  if (value === null || value === undefined) {
    return fallback;
  }
  const coerced = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(coerced) || coerced < 0) {
    return fallback;
  }
  return Math.floor(coerced);
}

/**
 * Estimate the token cost of tool-schema payloads sent to the provider on
 * every request. Uses the same chars/4 heuristic pi-coding-agent uses for
 * message estimation — intentionally approximate and slightly conservative
 * for pure-English tool schemas.
 *
 * Unserializable params (e.g., cyclic objects) are silently skipped rather
 * than crashing the session.
 */
export function estimateToolSchemaTokens(
  builtInTools: ReadonlyArray<ToolLike>,
  customTools: ReadonlyArray<ToolLike>
): number {
  let chars = 0;
  const accumulate = (tool: ToolLike): void => {
    chars += (tool.name?.length ?? 0) + (tool.description?.length ?? 0);
    try {
      chars += JSON.stringify(tool.parameters ?? {}).length;
    } catch {
      // Unserializable (cyclic, getter throws, etc.) — skip params,
      // keep name+description contributions already counted.
    }
  };
  for (const tool of builtInTools) accumulate(tool);
  for (const tool of customTools) accumulate(tool);
  return Math.ceil(chars / 4);
}

export interface CompactionBudgetInput {
  contextWindow: number;
  modelMaxOutput?: number;
  builtInTools: ReadonlyArray<ToolLike>;
  customTools: ReadonlyArray<ToolLike>;
  safetyMargin?: number;
}

export interface CompactionBudgetResult {
  /** Token budget passed to pi-coding-agent as `reserveTokens`. */
  reserveTokens: number;
  /** Token budget passed to pi-coding-agent as `keepRecentTokens`. */
  keepRecentTokens: number;
  /** Internal breakdown (logged for diagnostics). */
  breakdown: {
    contextWindow: number;
    modelMaxOutput: number;
    toolSchemaTokens: number;
    safetyMargin: number;
    /** The ideal reserve before clamping against the window. */
    rawReserve: number;
    /** True if rawReserve exceeded the window and was clamped. */
    clamped: boolean;
    /**
     * True if the required reserve (output + tools + safety) is >= the whole
     * context window, meaning no room remains for input. In this state
     * triggerAt is 0 (compaction fires every turn), but the session is
     * effectively unusable until tools are removed or maxTokens lowered.
     */
    unworkable: boolean;
    /** The point at which compaction will trigger: contextWindow - reserveTokens. */
    triggerAt: number;
  };
}

/**
 * Compute `reserveTokens` and `keepRecentTokens` for a non-Ollama session,
 * accounting for tool-schema payloads.
 *
 * Design priority: **overflow prevention first**. The whole reason this
 * module exists is to ensure requests don't exceed the provider's hard
 * context window. To that end:
 *
 *   1. reserveTokens covers the FULL output + tool-schema + safety budget
 *      whenever the window can fit it. It is never silently reduced below
 *      that just to preserve conversation headroom — doing so would
 *      reintroduce exactly the overflow bug this module fixes.
 *
 *   2. When the required reserve cannot fit (tools + maxTokens + safety >=
 *      contextWindow), reserveTokens is clamped to contextWindow itself so
 *      triggerAt becomes 0, forcing compaction on every turn. The session is
 *      effectively unusable (there is no room for input), but that state is
 *      surfaced via `breakdown.unworkable` and logged upstream so the user
 *      can act on it (disable MCP servers / lower maxTokens).
 *
 *   3. keepRecentTokens is bounded by what actually remains in the window
 *      after reserve, and preferentially leaves MIN_INPUT_HEADROOM for the
 *      user's next turn. When the window can afford it alongside that input
 *      target, MIN_KEEP_RECENT is enforced as a floor; on very tight windows
 *      keepRecent may legitimately drop to 0, which is correct behavior —
 *      compaction can only shrink the prompt if it is allowed to discard
 *      recent history.
 *
 * Guarantees:
 *   - All outputs are finite non-negative integers
 *   - `reserveTokens <= contextWindow`
 *   - `reserveTokens + keepRecentTokens <= contextWindow` (always feasible)
 *   - `triggerAt = contextWindow - reserveTokens >= 0`
 *   - `keepRecentTokens <= MAX_KEEP_RECENT`
 *   - When feasible, `reserveTokens + keepRecentTokens <= contextWindow - MIN_INPUT_HEADROOM`
 */
export function computeCompactionBudget(input: CompactionBudgetInput): CompactionBudgetResult {
  // Sanitize all numeric inputs defensively: NaN/Infinity/negative values
  // silently break compaction math by propagating to the reserveTokens
  // comparison inside pi-coding-agent's `shouldCompact`.
  const contextWindow = toSafeNonNegativeInt(input.contextWindow, 0);
  const modelMaxOutput = toSafeNonNegativeInt(input.modelMaxOutput, DEFAULT_MODEL_MAX_OUTPUT);
  const safetyMargin = toSafeNonNegativeInt(input.safetyMargin, DEFAULT_SAFETY_MARGIN);

  const toolSchemaTokens = estimateToolSchemaTokens(input.builtInTools, input.customTools);
  const rawReserve = modelMaxOutput + toolSchemaTokens + safetyMargin;

  // Overflow-safe clamp: reserve may never exceed the window itself (which
  // would produce a negative triggerAt inside shouldCompact). We clamp at
  // the window, not at `window - MIN_INPUT_HEADROOM` — doing the latter
  // would mean on tight windows we'd under-reserve and still hit provider
  // overflow errors, defeating the purpose of this whole module.
  const reserveTokens = Math.min(rawReserve, contextWindow);
  const clamped = rawReserve > contextWindow;
  const unworkable = rawReserve >= contextWindow;

  // Recent-history retention is bounded by whatever budget actually remains
  // after reserve, minus MIN_INPUT_HEADROOM so we prefer to leave room for
  // the user's next turn. MIN_INPUT_HEADROOM is a *soft* target: if reserve
  // is already so large there's no room for it, keepRecent drops to 0
  // rather than becoming negative.
  //
  // MIN_KEEP_RECENT is applied as a floor only when the window can support
  // it alongside the input-headroom target — never forced onto windows that
  // can't fit it, where compaction needs to be free to shrink the prompt to
  // nothing.
  const freeAfterReserve = contextWindow - reserveTokens;
  const keepRecentUpperBound = Math.max(0, freeAfterReserve - MIN_INPUT_HEADROOM);
  const keepRecentCandidate = Math.floor(contextWindow * 0.15);
  const canAffordMinKeepRecent = keepRecentUpperBound >= MIN_KEEP_RECENT;
  const keepRecentFloor = canAffordMinKeepRecent ? MIN_KEEP_RECENT : 0;
  const keepRecentTokens = Math.max(
    keepRecentFloor,
    Math.min(MAX_KEEP_RECENT, keepRecentCandidate, keepRecentUpperBound)
  );

  return {
    reserveTokens,
    keepRecentTokens,
    breakdown: {
      contextWindow,
      modelMaxOutput,
      toolSchemaTokens,
      safetyMargin,
      rawReserve,
      clamped,
      unworkable,
      triggerAt: contextWindow - reserveTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level: compaction settings selection per provider
// ---------------------------------------------------------------------------

/**
 * Shape of the `compaction` field passed to pi-coding-agent's
 * PiSettingsManager.inMemory({ compaction: ... }).
 */
export interface PiCompactionSettings {
  enabled: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface SelectCompactionSettingsInput {
  provider: string;
  contextWindow: number;
  modelMaxOutput?: number;
  builtInTools: ReadonlyArray<ToolLike>;
  customTools: ReadonlyArray<ToolLike>;
  safetyMargin?: number;
}

export interface SelectCompactionSettingsResult {
  /** The settings object to pass to pi-coding-agent. */
  settings: PiCompactionSettings;
  /** Which branch was taken, for logging/diagnostics. */
  branch: 'ollama_small' | 'ollama_medium' | 'tool_aware';
  /**
   * Detailed breakdown from computeCompactionBudget, only populated on the
   * `tool_aware` branch (Ollama branches use heuristic sizing and don't
   * need the full breakdown).
   */
  budget?: CompactionBudgetResult;
}

/**
 * Select pi-coding-agent compaction settings based on provider and context
 * window. Extracted as a pure function so the branching heuristic can be
 * unit-tested without spinning up an Electron session.
 *
 * Behavior:
 *   - provider='ollama' + contextWindow < 16K: disable compaction (tiny
 *     local models produce unreliable summaries — letting the session
 *     error out is preferable to feeding it garbage).
 *   - provider='ollama' + contextWindow < 64K: enabled with heuristic
 *     reserves proportional to window size (15% reserve, 25% keep-recent).
 *   - All other cases (non-Ollama, or Ollama with 64K+ windows): use the
 *     tool-aware budget via computeCompactionBudget().
 */
export function selectCompactionSettings(
  input: SelectCompactionSettingsInput
): SelectCompactionSettingsResult {
  const contextWindow = toSafeNonNegativeInt(input.contextWindow, 0);

  if (input.provider === 'ollama' && contextWindow < 16_384) {
    return {
      branch: 'ollama_small',
      settings: { enabled: false },
    };
  }

  if (input.provider === 'ollama' && contextWindow < 65_536) {
    return {
      branch: 'ollama_medium',
      settings: {
        enabled: true,
        reserveTokens: Math.floor(contextWindow * 0.15),
        keepRecentTokens: Math.floor(contextWindow * 0.25),
      },
    };
  }

  const budget = computeCompactionBudget({
    contextWindow,
    modelMaxOutput: input.modelMaxOutput,
    builtInTools: input.builtInTools,
    customTools: input.customTools,
    safetyMargin: input.safetyMargin,
  });
  return {
    branch: 'tool_aware',
    settings: {
      enabled: true,
      reserveTokens: budget.reserveTokens,
      keepRecentTokens: budget.keepRecentTokens,
    },
    budget,
  };
}
