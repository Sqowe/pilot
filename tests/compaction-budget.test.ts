import { describe, expect, it } from 'vitest';
import {
  computeCompactionBudget,
  estimateToolSchemaTokens,
  MAX_KEEP_RECENT,
  MIN_INPUT_HEADROOM,
  MIN_KEEP_RECENT,
  selectCompactionSettings,
  type ToolLike,
} from '../src/main/claude/compaction-budget';

// ---------------------------------------------------------------------------
// estimateToolSchemaTokens
// ---------------------------------------------------------------------------
describe('estimateToolSchemaTokens', () => {
  it('returns 0 for empty tool lists', () => {
    expect(estimateToolSchemaTokens([], [])).toBe(0);
  });

  it('counts name + description + stringified parameters at chars/4', () => {
    const tool: ToolLike = {
      name: 'read', // 4 chars
      description: 'Read a file from disk', // 21 chars
      parameters: { path: 'string' }, // JSON: {"path":"string"} = 17 chars
    };
    // Total chars: 4 + 21 + 17 = 42. ceil(42/4) = 11
    expect(estimateToolSchemaTokens([tool], [])).toBe(11);
  });

  it('handles CJK descriptions (chars/4 under-estimates but does not crash)', () => {
    const tool: ToolLike = {
      name: 'search',
      description: '搜索文件内容并返回匹配的行',
      parameters: {},
    };
    expect(estimateToolSchemaTokens([tool], [])).toBeGreaterThan(0);
  });

  it('sums built-in and custom tool contributions', () => {
    const builtIn: ToolLike = { name: 'a', description: 'x', parameters: {} };
    const custom: ToolLike = { name: 'b', description: 'y', parameters: {} };
    const combined = estimateToolSchemaTokens([builtIn, custom], []);
    const asCustomOnly = estimateToolSchemaTokens([], [builtIn, custom]);
    expect(combined).toBe(asCustomOnly);
  });

  it('silently skips unserializable (cyclic) parameters without crashing', () => {
    interface Cyclic {
      self?: Cyclic;
    }
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const tool: ToolLike = {
      name: 'broken',
      description: 'has a cyclic schema',
      parameters: cyclic,
    };
    // Should still count name + description, just not parameters.
    // name=6 chars + description=19 chars = 25; ceil(25/4)=7
    expect(estimateToolSchemaTokens([tool], [])).toBe(7);
  });

  it('handles parameters whose toJSON throws', () => {
    const tool: ToolLike = {
      name: 'x',
      description: 'y',
      parameters: {
        get hostile(): never {
          throw new Error('nope');
        },
      },
    };
    expect(() => estimateToolSchemaTokens([tool], [])).not.toThrow();
  });

  it('tolerates missing fields on ToolLike', () => {
    // With no name, description, or parameters, we still JSON.stringify(params ?? {})
    // which is "{}" = 2 chars, so we get 1 token per tool. This is acceptable
    // conservatism — undercounting is the real failure mode.
    expect(estimateToolSchemaTokens([{}], [])).toBe(1);
    expect(estimateToolSchemaTokens([{ name: 'n' }], [])).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// computeCompactionBudget — happy path sizing
// ---------------------------------------------------------------------------
describe('computeCompactionBudget — normal sizing', () => {
  it('sizes reserve as output + tool schemas + safety margin on a roomy window', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    // rawReserve = 8192 + 0 + 4000 (default safety) = 12192
    expect(budget.reserveTokens).toBe(12_192);
    expect(budget.breakdown.clamped).toBe(false);
    expect(budget.breakdown.triggerAt).toBe(200_000 - 12_192);
  });

  it('adds tool-schema tokens into the reserve', () => {
    const tools: ToolLike[] = [
      { name: 'read', description: 'x'.repeat(200), parameters: { path: 'string' } },
    ];
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      modelMaxOutput: 8192,
      builtInTools: tools,
      customTools: [],
    });
    expect(budget.breakdown.toolSchemaTokens).toBeGreaterThan(0);
    expect(budget.reserveTokens).toBe(8192 + budget.breakdown.toolSchemaTokens + 4000);
  });

  it('falls back to 16K modelMaxOutput default when undefined', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      builtInTools: [],
      customTools: [],
    });
    expect(budget.breakdown.modelMaxOutput).toBe(16_384);
  });

  it('honors custom safetyMargin override', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
      safetyMargin: 100,
    });
    expect(budget.reserveTokens).toBe(8192 + 100);
  });

  it('keepRecentTokens equals 15% of window when within bounds', () => {
    const budget = computeCompactionBudget({
      contextWindow: 128_000,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    // 15% of 128K = 19200, which is between MIN (4000) and MAX (32000)
    expect(budget.keepRecentTokens).toBe(19_200);
  });

  it('caps keepRecentTokens at MAX_KEEP_RECENT (32K) on huge windows', () => {
    const budget = computeCompactionBudget({
      contextWindow: 1_000_000,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    expect(budget.keepRecentTokens).toBe(MAX_KEEP_RECENT);
  });
});

// ---------------------------------------------------------------------------
// computeCompactionBudget — clamping and boundary conditions
// ---------------------------------------------------------------------------
describe('computeCompactionBudget — clamping and safety invariants', () => {
  // Universal invariant checker — every computed budget must satisfy these,
  // regardless of how degenerate the inputs are.
  const assertSafetyInvariants = (budget: ReturnType<typeof computeCompactionBudget>): void => {
    expect(Number.isFinite(budget.reserveTokens)).toBe(true);
    expect(Number.isFinite(budget.keepRecentTokens)).toBe(true);
    expect(budget.reserveTokens).toBeGreaterThanOrEqual(0);
    expect(budget.keepRecentTokens).toBeGreaterThanOrEqual(0);
    // Reserve never exceeds the window itself — protects against negative
    // triggerAt, which breaks shouldCompact's comparison.
    expect(budget.reserveTokens).toBeLessThanOrEqual(budget.breakdown.contextWindow);
    // The full budget (reserve + recent history) must be feasible.
    expect(budget.reserveTokens + budget.keepRecentTokens).toBeLessThanOrEqual(
      budget.breakdown.contextWindow
    );
    // triggerAt must be non-negative.
    expect(budget.breakdown.triggerAt).toBeGreaterThanOrEqual(0);
  };

  it('clamps rawReserve at contextWindow (not at window - MIN_INPUT_HEADROOM) to guarantee overflow safety', () => {
    // A massive tool payload that dwarfs even a large window.
    const hugeTools: ToolLike[] = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'x'.repeat(4000),
      parameters: {},
    }));
    const budget = computeCompactionBudget({
      contextWindow: 128_000,
      modelMaxOutput: 16_384,
      builtInTools: hugeTools,
      customTools: [],
    });
    assertSafetyInvariants(budget);
    expect(budget.breakdown.clamped).toBe(true);
    expect(budget.breakdown.unworkable).toBe(true);
    // Specifically: reserve is clamped at the window, NOT at window - 8K.
    expect(budget.reserveTokens).toBeLessThanOrEqual(128_000);
  });

  it('sets unworkable=true when required reserve meets or exceeds the window', () => {
    const absurdTools: ToolLike[] = [
      { name: 'bloat', description: 'x'.repeat(4_000_000), parameters: {} },
    ];
    const budget = computeCompactionBudget({
      contextWindow: 8_000,
      modelMaxOutput: 4096,
      builtInTools: absurdTools,
      customTools: [],
    });
    assertSafetyInvariants(budget);
    expect(budget.breakdown.unworkable).toBe(true);
    expect(budget.breakdown.clamped).toBe(true);
    // triggerAt must be 0 so compaction fires on every single turn.
    expect(budget.breakdown.triggerAt).toBe(0);
    // And keepRecent must be 0 so compaction can actually reduce the prompt.
    expect(budget.keepRecentTokens).toBe(0);
  });

  it('keeps unworkable=false on normal GLM/Claude-class windows with typical MCP payloads', () => {
    // Realistic: 200K window, 16K output, ~30K of tools (30 servers × 1K tokens each)
    const typicalTools: ToolLike[] = Array.from({ length: 30 }, (_, i) => ({
      name: `mcp__server_${i}__tool`,
      description: 'x'.repeat(4000),
      parameters: { query: 'string' },
    }));
    const budget = computeCompactionBudget({
      contextWindow: 204_800,
      modelMaxOutput: 16_384,
      builtInTools: [],
      customTools: typicalTools,
    });
    assertSafetyInvariants(budget);
    expect(budget.breakdown.unworkable).toBe(false);
    expect(budget.breakdown.clamped).toBe(false);
  });

  it('tight-window with default Claude-class output (16K) is unworkable — flagged, not silently under-reserved', () => {
    // A 16K window with the pi default 16K output can't fit anything else.
    // rawReserve = 16384 + 0 + 4000 = 20384 >= 16384 → unworkable
    const budget = computeCompactionBudget({
      contextWindow: 16_384,
      modelMaxOutput: 16_384,
      builtInTools: [],
      customTools: [],
    });
    assertSafetyInvariants(budget);
    // Under the new semantics this is flagged as unworkable rather than
    // silently under-reserving (which would let provider overflow errors
    // slip through). The session will compact every turn, which is the
    // correct behavior — the user must lower maxTokens in their profile.
    expect(budget.breakdown.unworkable).toBe(true);
  });

  it('keepRecentTokens is bounded by freeAfterReserve (no hard floor when infeasible)', () => {
    // Window where reserve consumes most of the space but not all.
    const budget = computeCompactionBudget({
      contextWindow: 16_000,
      modelMaxOutput: 4096,
      builtInTools: [],
      customTools: [],
      safetyMargin: 10_000, // pushes rawReserve to 14096
    });
    assertSafetyInvariants(budget);
    const freeAfterReserve = 16_000 - budget.reserveTokens;
    expect(budget.keepRecentTokens).toBeLessThanOrEqual(freeAfterReserve);
  });

  it('keepRecentTokens can drop to 0 on unworkable windows so compaction can actually shrink the prompt', () => {
    const budget = computeCompactionBudget({
      contextWindow: 4_000,
      modelMaxOutput: 4096, // already exceeds the whole window
      builtInTools: [],
      customTools: [],
    });
    assertSafetyInvariants(budget);
    expect(budget.breakdown.unworkable).toBe(true);
    expect(budget.keepRecentTokens).toBe(0);
  });

  it('handles contextWindow=0 without dividing by zero or crashing', () => {
    const budget = computeCompactionBudget({
      contextWindow: 0,
      modelMaxOutput: 4096,
      builtInTools: [],
      customTools: [],
    });
    assertSafetyInvariants(budget);
    expect(budget.reserveTokens).toBe(0);
    expect(budget.keepRecentTokens).toBe(0);
    expect(budget.breakdown.triggerAt).toBe(0);
    expect(budget.breakdown.unworkable).toBe(true);
  });

  it('treats negative contextWindow as 0', () => {
    const budget = computeCompactionBudget({
      contextWindow: -1,
      modelMaxOutput: 4096,
      builtInTools: [],
      customTools: [],
    });
    assertSafetyInvariants(budget);
    expect(budget.breakdown.contextWindow).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: the original failing scenario
// ---------------------------------------------------------------------------
describe('computeCompactionBudget — original failing scenario', () => {
  it('would trigger compaction well before the original 224K-token request', () => {
    // Simulate the reported 400 error: 200K window, ~31K of tool schemas,
    // 16K output budget. Without the fix, compaction would only trigger at
    // 200K - 16K = 184K of reported conversation tokens, but the provider
    // saw input(176K) + tools(31K) + output(16K) = 223K and rejected it.
    //
    // 31K tool tokens × 4 chars/token = ~124K chars of schema. Spread across
    // 30 tools that's ~4200 chars each.
    const heavyTools: ToolLike[] = Array.from({ length: 30 }, (_, i) => ({
      name: `mcp__server_${i}__tool`,
      description: 'x'.repeat(4200),
      parameters: { query: 'string', filters: { type: 'object' } },
    }));
    const budget = computeCompactionBudget({
      contextWindow: 204_800,
      modelMaxOutput: 16_384,
      builtInTools: [],
      customTools: heavyTools,
    });
    // Sanity: tool schemas should come out near the real 31K value
    expect(budget.breakdown.toolSchemaTokens).toBeGreaterThan(25_000);
    // triggerAt must be noticeably lower than the reported 176K input that
    // blew up in production — we want compaction to run BEFORE that point.
    expect(budget.breakdown.triggerAt).toBeLessThan(160_000);
    // And compaction must still leave enough headroom for actual input.
    expect(budget.breakdown.triggerAt).toBeGreaterThan(100_000);
  });
});

// ---------------------------------------------------------------------------
// computeCompactionBudget — malformed numeric inputs
// ---------------------------------------------------------------------------
describe('computeCompactionBudget — malformed numeric inputs', () => {
  it('treats contextWindow=NaN as 0 (not NaN)', () => {
    const budget = computeCompactionBudget({
      contextWindow: Number.NaN,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    expect(Number.isFinite(budget.reserveTokens)).toBe(true);
    expect(Number.isFinite(budget.keepRecentTokens)).toBe(true);
    expect(budget.breakdown.contextWindow).toBe(0);
    expect(budget.breakdown.triggerAt).toBe(0);
  });

  it('treats contextWindow=Infinity as invalid (falls back to 0)', () => {
    const budget = computeCompactionBudget({
      contextWindow: Number.POSITIVE_INFINITY,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    expect(budget.breakdown.contextWindow).toBe(0);
    expect(Number.isFinite(budget.reserveTokens)).toBe(true);
    expect(Number.isFinite(budget.keepRecentTokens)).toBe(true);
  });

  it('treats modelMaxOutput=NaN as the default 16K', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      modelMaxOutput: Number.NaN,
      builtInTools: [],
      customTools: [],
    });
    expect(budget.breakdown.modelMaxOutput).toBe(16_384);
    expect(Number.isFinite(budget.reserveTokens)).toBe(true);
  });

  it('treats modelMaxOutput=Infinity as the default 16K', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      modelMaxOutput: Number.POSITIVE_INFINITY,
      builtInTools: [],
      customTools: [],
    });
    expect(budget.breakdown.modelMaxOutput).toBe(16_384);
  });

  it('treats negative modelMaxOutput as the default 16K', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      modelMaxOutput: -500,
      builtInTools: [],
      customTools: [],
    });
    expect(budget.breakdown.modelMaxOutput).toBe(16_384);
  });

  it('treats negative safetyMargin as the default 4K', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
      safetyMargin: -100,
    });
    expect(budget.breakdown.safetyMargin).toBe(4000);
  });

  it('treats safetyMargin=NaN as the default 4K', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
      safetyMargin: Number.NaN,
    });
    expect(budget.breakdown.safetyMargin).toBe(4000);
  });

  it('floors non-integer contextWindow to an integer', () => {
    const budget = computeCompactionBudget({
      contextWindow: 128_000.7,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    expect(Number.isInteger(budget.breakdown.contextWindow)).toBe(true);
    expect(budget.breakdown.contextWindow).toBe(128_000);
  });

  it('produces finite, non-negative outputs even when every input is malformed', () => {
    const budget = computeCompactionBudget({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contextWindow: 'not a number' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelMaxOutput: null as any,
      builtInTools: [],
      customTools: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      safetyMargin: undefined as any,
    });
    expect(Number.isFinite(budget.reserveTokens)).toBe(true);
    expect(Number.isFinite(budget.keepRecentTokens)).toBe(true);
    expect(budget.reserveTokens).toBeGreaterThanOrEqual(0);
    expect(budget.keepRecentTokens).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// computeCompactionBudget — string coercion for numeric inputs
// ---------------------------------------------------------------------------
describe('computeCompactionBudget — string-coerced numeric inputs', () => {
  it('accepts numeric strings for contextWindow (e.g. from JSON-persisted profiles)', () => {
    const budget = computeCompactionBudget({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contextWindow: '128000' as any,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    expect(budget.breakdown.contextWindow).toBe(128_000);
    // And downstream math should use the coerced value.
    expect(budget.reserveTokens).toBe(8192 + 4000);
  });

  it('accepts numeric strings for modelMaxOutput and safetyMargin', () => {
    const budget = computeCompactionBudget({
      contextWindow: 200_000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelMaxOutput: '8192' as any,
      builtInTools: [],
      customTools: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      safetyMargin: '2000' as any,
    });
    expect(budget.breakdown.modelMaxOutput).toBe(8192);
    expect(budget.breakdown.safetyMargin).toBe(2000);
  });

  it('rejects non-numeric strings and falls back (e.g. "abc")', () => {
    const budget = computeCompactionBudget({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contextWindow: 'abc' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelMaxOutput: 'xyz' as any,
      builtInTools: [],
      customTools: [],
    });
    expect(budget.breakdown.contextWindow).toBe(0);
    expect(budget.breakdown.modelMaxOutput).toBe(16_384);
  });

  it('treats empty string as invalid (Number("") === 0 is misleading here)', () => {
    const budget = computeCompactionBudget({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contextWindow: '' as any,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    // Number("") is 0, which is a valid non-negative integer — so the coercer
    // accepts it. This is acceptable because a contextWindow of 0 produces
    // unworkable=true, and the user will see the error.
    expect(budget.breakdown.contextWindow).toBe(0);
    expect(budget.breakdown.unworkable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeCompactionBudget — MIN_KEEP_RECENT and MIN_INPUT_HEADROOM behavior
// ---------------------------------------------------------------------------
describe('computeCompactionBudget — soft targets', () => {
  it('keepRecentTokens leaves MIN_INPUT_HEADROOM free when feasible', () => {
    const budget = computeCompactionBudget({
      contextWindow: 128_000,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    const totalBudget = budget.reserveTokens + budget.keepRecentTokens;
    // On a roomy window we respect the soft input headroom target.
    expect(totalBudget).toBeLessThanOrEqual(128_000 - MIN_INPUT_HEADROOM);
  });

  it('keepRecentTokens honors MIN_KEEP_RECENT when the window can afford it', () => {
    // A window where the 15% heuristic would produce less than MIN_KEEP_RECENT
    // but freeAfterReserve has room for it.
    const budget = computeCompactionBudget({
      contextWindow: 20_000,
      modelMaxOutput: 4096,
      builtInTools: [],
      customTools: [],
      safetyMargin: 0,
    });
    // 15% of 20K = 3000, below MIN_KEEP_RECENT=4000. freeAfterReserve=16000,
    // upper bound = 16000-8000 = 8000. 8000 >= MIN_KEEP_RECENT, so floor applies.
    expect(budget.keepRecentTokens).toBeGreaterThanOrEqual(MIN_KEEP_RECENT);
  });

  it('drops keepRecent below MIN_KEEP_RECENT when the window cannot afford both the floor and input headroom', () => {
    // Tight workable window: reserve leaves very little slack.
    const budget = computeCompactionBudget({
      contextWindow: 14_000,
      modelMaxOutput: 4096,
      builtInTools: [],
      customTools: [],
      safetyMargin: 0,
    });
    // reserve = 4096, free = 9904, upper bound = 9904 - 8000 = 1904.
    // 1904 < MIN_KEEP_RECENT, so floor drops to 0 and keepRecent <= 1904.
    expect(budget.keepRecentTokens).toBeLessThan(MIN_KEEP_RECENT);
    expect(budget.keepRecentTokens).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// selectCompactionSettings — per-provider branching
// ---------------------------------------------------------------------------
describe('selectCompactionSettings', () => {
  it('disables compaction on Ollama small-context models (<16K)', () => {
    const result = selectCompactionSettings({
      provider: 'ollama',
      contextWindow: 8192,
      builtInTools: [],
      customTools: [],
    });
    expect(result.branch).toBe('ollama_small');
    expect(result.settings.enabled).toBe(false);
    expect(result.budget).toBeUndefined();
  });

  it('uses proportional reserves on Ollama medium-context models (16K-64K)', () => {
    const result = selectCompactionSettings({
      provider: 'ollama',
      contextWindow: 32_768,
      builtInTools: [],
      customTools: [],
    });
    expect(result.branch).toBe('ollama_medium');
    expect(result.settings.enabled).toBe(true);
    // 15% reserve, 25% keep-recent for medium Ollama
    expect(result.settings.reserveTokens).toBe(Math.floor(32_768 * 0.15));
    expect(result.settings.keepRecentTokens).toBe(Math.floor(32_768 * 0.25));
    expect(result.budget).toBeUndefined();
  });

  it('uses tool-aware budget on large Ollama models (>=64K)', () => {
    const result = selectCompactionSettings({
      provider: 'ollama',
      contextWindow: 131_072,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: [],
    });
    expect(result.branch).toBe('tool_aware');
    expect(result.budget).toBeDefined();
    expect(result.settings.reserveTokens).toBe(result.budget!.reserveTokens);
    expect(result.settings.keepRecentTokens).toBe(result.budget!.keepRecentTokens);
  });

  it('uses tool-aware budget on non-Ollama providers regardless of window size', () => {
    const result = selectCompactionSettings({
      provider: 'anthropic',
      contextWindow: 8192, // would be "small" if provider were Ollama
      modelMaxOutput: 4096,
      builtInTools: [],
      customTools: [],
    });
    expect(result.branch).toBe('tool_aware');
    expect(result.budget).toBeDefined();
  });

  it('propagates tool-schema tokens into the budget on the tool_aware branch', () => {
    const heavyTools: ToolLike[] = Array.from({ length: 20 }, (_, i) => ({
      name: `mcp__server_${i}`,
      description: 'x'.repeat(2000),
      parameters: {},
    }));
    const result = selectCompactionSettings({
      provider: 'openrouter',
      contextWindow: 200_000,
      modelMaxOutput: 8192,
      builtInTools: [],
      customTools: heavyTools,
    });
    expect(result.branch).toBe('tool_aware');
    expect(result.budget!.breakdown.toolSchemaTokens).toBeGreaterThan(5000);
    // Reserve should include tool-schema tokens, not just output+safety.
    expect(result.settings.reserveTokens).toBeGreaterThan(8192 + 4000);
  });

  it('flags unworkable sessions on the tool_aware branch so caller can warn', () => {
    const absurdTools: ToolLike[] = [
      { name: 'bloat', description: 'x'.repeat(4_000_000), parameters: {} },
    ];
    const result = selectCompactionSettings({
      provider: 'anthropic',
      contextWindow: 16_000,
      modelMaxOutput: 8192,
      builtInTools: absurdTools,
      customTools: [],
    });
    expect(result.branch).toBe('tool_aware');
    expect(result.budget!.breakdown.unworkable).toBe(true);
  });

  it('sanitizes malformed contextWindow via toSafeNonNegativeInt path', () => {
    const result = selectCompactionSettings({
      provider: 'custom',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contextWindow: Number.NaN as any,
      builtInTools: [],
      customTools: [],
    });
    // NaN contextWindow → 0 → tool_aware branch with unworkable budget
    expect(result.branch).toBe('tool_aware');
    expect(result.budget!.breakdown.contextWindow).toBe(0);
    expect(result.budget!.breakdown.unworkable).toBe(true);
  });
});
