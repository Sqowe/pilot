import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as sharedModule from '../src/shared/bash-restrictions';
import {
  resolveBashToolCall,
  CHOICE_ALLOW,
  CHOICE_DENY,
  CHOICE_SUGGEST,
  type BashCtx,
} from '../pi-extensions/bash-restrictions/extension';
import type { BashRestrictionsSettings } from '../src/shared/bash-restrictions';

/**
 * Unit tests for resolveBashToolCall.
 *
 * Most tests stub decideBashPermission so the mapping logic is isolated
 * from engine details. A small "integration" block at the bottom exercises
 * real engine behavior (denylist beats trust).
 *
 * vitest.config.mts sets mockReset:true + restoreMocks:true, so every spy
 * created in beforeEach is automatically restored after each test.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SETTINGS_OPTED_IN: BashRestrictionsSettings = {
  trusted: ['npm *', 'git status', 'ls *'],
  denied: ['rm -rf', '--force'],
  permissionTimeoutSeconds: 300,
};

const SETTINGS_NOT_OPTED_IN: BashRestrictionsSettings = {
  trusted: [],
  denied: [],
  permissionTimeoutSeconds: 300,
};

const SETTINGS_INFINITE_TIMEOUT: BashRestrictionsSettings = {
  ...SETTINGS_OPTED_IN,
  permissionTimeoutSeconds: 0,
};

const SETTINGS_CUSTOM_TIMEOUT: BashRestrictionsSettings = {
  ...SETTINGS_OPTED_IN,
  permissionTimeoutSeconds: 60,
};

function makeCtx(
  hasUI = true
): BashCtx & { ui: { select: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> } } {
  return {
    hasUI,
    ui: {
      select: vi.fn(),
      input: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Default stub: engine returns 'ask' for all tests unless overridden.
// Integration tests that need the real engine restore mocks inline.
// ---------------------------------------------------------------------------
let decideSpy: ReturnType<typeof vi.spyOn<typeof sharedModule, 'decideBashPermission'>>;

beforeEach(() => {
  decideSpy = vi.spyOn(sharedModule, 'decideBashPermission').mockReturnValue('ask');
});

// ---------------------------------------------------------------------------
// allow / null → undefined (no dialog shown)
// ---------------------------------------------------------------------------

describe("engine returns 'allow' or null → undefined, no dialog", () => {
  it("returns undefined and shows no dialog when command is trusted ('allow')", async () => {
    decideSpy.mockReturnValue('allow');
    const ctx = makeCtx();
    const result = await resolveBashToolCall('npm install', ctx, SETTINGS_OPTED_IN);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('returns undefined when all sub-commands in a pipeline are trusted', async () => {
    decideSpy.mockReturnValue('allow');
    const ctx = makeCtx();
    const result = await resolveBashToolCall('ls -la | npm run build', ctx, SETTINGS_OPTED_IN);
    expect(result).toBeUndefined();
  });

  it('returns undefined and shows no dialog when lists are empty (null — not opted in)', async () => {
    // Not opted-in → early return before engine is called; spy doesn't matter.
    const ctx = makeCtx();
    const result = await resolveBashToolCall('anything at all', ctx, SETTINGS_NOT_OPTED_IN);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('returns undefined for an empty command when NOT opted-in (null — gate inactive)', async () => {
    // Not opted-in → early return; engine never called.
    const ctx = makeCtx();
    const result = await resolveBashToolCall('', ctx, SETTINGS_NOT_OPTED_IN);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('blocks when opted-in and command is empty (fail-closed, missing command)', async () => {
    const ctx = makeCtx();
    const result = await resolveBashToolCall('', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('missing command');
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('blocks when opted-in and command is whitespace-only (fail-closed)', async () => {
    const ctx = makeCtx();
    const result = await resolveBashToolCall('   ', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('missing command');
  });
});

// ---------------------------------------------------------------------------
// ask + hasUI:false → block (fail-closed, no dialog)
// ---------------------------------------------------------------------------

describe("engine returns 'ask' + hasUI:false → block (fail-closed)", () => {
  it('blocks an untrusted command when hasUI is false', async () => {
    const ctx = makeCtx(false);
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result).toEqual({
      block: true,
      reason: 'Blocked by bash restrictions (no UI to confirm)',
    });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('blocks a denylisted command when hasUI is false', async () => {
    const ctx = makeCtx(false);
    const result = await resolveBashToolCall('rm -rf /tmp', ctx, SETTINGS_OPTED_IN);
    expect(result).toEqual({
      block: true,
      reason: 'Blocked by bash restrictions (no UI to confirm)',
    });
  });

  it('blocks unsupported shell syntax (fail-closed) when hasUI is false', async () => {
    const ctx = makeCtx(false);
    const result = await resolveBashToolCall('npm install && rm -rf /', ctx, SETTINGS_OPTED_IN);
    expect(result).toEqual({
      block: true,
      reason: 'Blocked by bash restrictions (no UI to confirm)',
    });
  });

  it('blocks when hasUI is true but ui object is absent (typed as undefined)', async () => {
    // BashCtx has ui?: {...} — guard prevents calling .ui.select when ui is absent.
    const ctx: BashCtx = { hasUI: true, ui: undefined };
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result).toEqual({
      block: true,
      reason: 'Blocked by bash restrictions (no UI to confirm)',
    });
  });
});

// ---------------------------------------------------------------------------
// ask + hasUI:true → "Allow once" → undefined
// ---------------------------------------------------------------------------

describe(`ask + hasUI:true → select "${CHOICE_ALLOW}" → undefined`, () => {
  it('returns undefined when user selects "Allow once"', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_ALLOW);
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    expect(ctx.ui.input).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ask + hasUI:true → "Deny" → plain-deny block
// ---------------------------------------------------------------------------

describe(`ask + hasUI:true → select "${CHOICE_DENY}" → plain-deny block`, () => {
  it('returns the plain-deny reason when user selects "Deny"', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result).toEqual({ block: true, reason: "User denied permission for 'bash'." });
    expect(ctx.ui.input).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ask + hasUI:true → "Deny & suggest" → input → block with suggestion
// ---------------------------------------------------------------------------

describe(`ask + hasUI:true → select "${CHOICE_SUGGEST}" → input → block with reason`, () => {
  it('invokes ctx.ui.input and includes the suggestion in the reason', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_SUGGEST);
    ctx.ui.input.mockResolvedValue('use cat instead');
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("User's suggestion: use cat instead");
    expect(ctx.ui.input).toHaveBeenCalledOnce();
  });

  it("reason contains 'NOT globally blocked' and 'only this particular call' wording", async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_SUGGEST);
    ctx.ui.input.mockResolvedValue('a suggestion');
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result?.reason).toContain('NOT globally blocked');
    expect(result?.reason).toContain('only this particular call was rejected');
    expect(result?.reason).toContain("You may still use 'bash' for other purposes");
  });

  it("omits 'User's suggestion' text when input returns empty string", async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_SUGGEST);
    ctx.ui.input.mockResolvedValue('');
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).not.toContain("User's suggestion");
    expect(result?.reason).toContain('NOT globally blocked');
  });

  it("omits 'User's suggestion' text when input returns undefined (cancel)", async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_SUGGEST);
    ctx.ui.input.mockResolvedValue(undefined);
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).not.toContain("User's suggestion");
  });

  it('trims leading/trailing whitespace from the suggestion', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_SUGGEST);
    ctx.ui.input.mockResolvedValue('  use cat instead  ');
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result?.reason).toContain("User's suggestion: use cat instead");
    expect(result?.reason).not.toContain('  use cat instead  ');
  });
});

// ---------------------------------------------------------------------------
// ask + hasUI:true → select undefined (timeout / dismiss) → auto-deny
// ---------------------------------------------------------------------------

describe('ask + hasUI:true → select returns undefined (timeout/cancel) → auto-deny', () => {
  it('returns auto-deny block when select returns undefined', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(undefined);
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result).toEqual({ block: true, reason: 'Blocked (timed out)' });
    expect(ctx.ui.input).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Timeout option propagation
// ---------------------------------------------------------------------------

describe('timeout option propagation to select / input', () => {
  it('passes { timeout: ms } to select when permissionTimeoutSeconds > 0', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    await resolveBashToolCall('docker build .', ctx, SETTINGS_CUSTOM_TIMEOUT); // 60s
    const opts = ctx.ui.select.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toEqual({ timeout: 60_000 });
  });

  it('passes { timeout: ms } to input when permissionTimeoutSeconds > 0', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_SUGGEST);
    ctx.ui.input.mockResolvedValue('suggestion');
    await resolveBashToolCall('docker build .', ctx, SETTINGS_CUSTOM_TIMEOUT); // 60s
    const opts = ctx.ui.input.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toEqual({ timeout: 60_000 });
  });

  it('passes empty opts to select when permissionTimeoutSeconds is 0 (infinite)', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    await resolveBashToolCall('docker build .', ctx, SETTINGS_INFINITE_TIMEOUT);
    const opts = ctx.ui.select.mock.calls[0][2];
    expect(opts).toBeUndefined();
  });

  it('passes empty opts to input when permissionTimeoutSeconds is 0 (infinite)', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_SUGGEST);
    ctx.ui.input.mockResolvedValue('suggestion');
    await resolveBashToolCall('docker build .', ctx, SETTINGS_INFINITE_TIMEOUT);
    const opts = ctx.ui.input.mock.calls[0][2];
    expect(opts).toBeUndefined();
  });

  it('passes { timeout: 300_000 } for the default 300s timeout', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN); // 300s
    const opts = ctx.ui.select.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toEqual({ timeout: 300_000 });
  });

  it('treats NaN permissionTimeoutSeconds as the default (300s timeout)', async () => {
    const settings: BashRestrictionsSettings = {
      ...SETTINGS_OPTED_IN,
      permissionTimeoutSeconds: NaN,
    };
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    await resolveBashToolCall('docker build .', ctx, settings);
    const opts = ctx.ui.select.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toEqual({ timeout: 300_000 }); // NaN normalizes to default 300
  });

  it('treats negative permissionTimeoutSeconds as 0 (infinite — no timeout option)', async () => {
    const settings: BashRestrictionsSettings = {
      ...SETTINGS_OPTED_IN,
      permissionTimeoutSeconds: -1,
    };
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    await resolveBashToolCall('docker build .', ctx, settings);
    const opts = ctx.ui.select.mock.calls[0][2];
    expect(opts).toBeUndefined(); // negative → 0 → no timeout
  });

  it('clamps very large permissionTimeoutSeconds to 3600s maximum', async () => {
    const settings: BashRestrictionsSettings = {
      ...SETTINGS_OPTED_IN,
      permissionTimeoutSeconds: 99999,
    };
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    await resolveBashToolCall('docker build .', ctx, settings);
    const opts = ctx.ui.select.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toEqual({ timeout: 3_600_000 }); // clamped to max 3600s
  });
});

// ---------------------------------------------------------------------------
// Malformed event inputs — defensive boundary tests
// ---------------------------------------------------------------------------

describe('malformed command inputs (event boundary robustness)', () => {
  it('blocks when opted-in and command is undefined (non-string input)', async () => {
    const ctx = makeCtx();
    // Simulate a malformed event where command is not a string
    const result = await resolveBashToolCall(
      undefined as unknown as string,
      ctx,
      SETTINGS_OPTED_IN
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('missing command');
  });

  it('blocks when opted-in and command is null (non-string input)', async () => {
    const ctx = makeCtx();
    const result = await resolveBashToolCall(null as unknown as string, ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('missing command');
  });

  it('does not block when NOT opted-in and command is undefined (defers to pi)', async () => {
    // Not opted-in → early return before engine; no spy override needed.
    const ctx = makeCtx();
    const result = await resolveBashToolCall(
      undefined as unknown as string,
      ctx,
      SETTINGS_NOT_OPTED_IN
    );
    expect(result).toBeUndefined();
  });
});

describe('UI throws or rejects → fail-closed block', () => {
  it('returns fail-closed block when ctx.ui.select rejects', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockRejectedValue(new Error('TUI disconnected'));
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('ui error');
  });

  it('returns fail-closed block when ctx.ui.input rejects', async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_SUGGEST);
    ctx.ui.input.mockRejectedValue(new Error('RPC failure'));
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('ui error');
  });

  it('blocks deterministically when select returns an unexpected string value', async () => {
    // Any non-matching string → falls to the auto-deny (timeout) path.
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue('Unknown option not in the list');
    const result = await resolveBashToolCall('docker build .', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration (real engine — no stub)
// ---------------------------------------------------------------------------

describe('integration: real engine (no stub)', () => {
  it('shows dialog for a command matching both trusted and denylist (denylist beats trust)', async () => {
    // Restore the real engine for this test.
    vi.restoreAllMocks();
    const settings: BashRestrictionsSettings = {
      trusted: ['git *'],
      denied: ['--force'],
      permissionTimeoutSeconds: 300,
    };
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_ALLOW);
    await resolveBashToolCall('git push --force', ctx, settings);
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// sanitizeForDisplay regression (command sanitization in dialog title)
// ---------------------------------------------------------------------------

describe('sanitizeForDisplay — command title sanitization', () => {
  it('strips control characters from the command shown in the dialog title', async () => {
    // Command with ANSI escape and newline — the command portion should be sanitized.
    // The static template "Bash restriction\n\n  <cmd>" uses intentional \n separators;
    // only the command-derived part should be free of control characters.
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    await resolveBashToolCall('cmd\x1b[31mred\x1b[0m\nnewline', ctx, SETTINGS_OPTED_IN);
    const title: string = ctx.ui.select.mock.calls[0][0] as string;
    // Extract the command portion after the "  " indent prefix.
    const cmdPart = title.split('  ').slice(1).join('  ');
    expect(cmdPart).not.toContain('\x1b');
    expect(cmdPart).not.toContain('\n');
    expect(cmdPart).not.toContain('\r');
  });

  it('truncates a very long command in the dialog title with an ellipsis', async () => {
    const longCmd = 'x'.repeat(600); // exceeds the 500-char default cap
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(CHOICE_DENY);
    await resolveBashToolCall(longCmd, ctx, SETTINGS_OPTED_IN);
    const title: string = ctx.ui.select.mock.calls[0][0] as string;
    expect(title).toContain('…');
    // The raw command should not appear in full
    expect(title).not.toContain(longCmd);
  });
});

// ---------------------------------------------------------------------------
// Unexpected engine decision → fail-closed (future-proofing guard)
// ---------------------------------------------------------------------------

describe('unexpected engine decision → fail-closed block', () => {
  it('blocks with unexpected-decision reason when engine returns an unrecognized value', async () => {
    decideSpy.mockImplementationOnce(() => 'future_value' as never);
    const ctx = makeCtx();
    const result = await resolveBashToolCall('some command', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('unexpected decision');
  });

  it('blocks when engine returns null while opted-in (coerced to ask, then no-UI fail-closed)', async () => {
    decideSpy.mockImplementationOnce(() => null);
    const ctx = makeCtx(false); // headless → fail-closed immediately
    const result = await resolveBashToolCall('some command', ctx, SETTINGS_OPTED_IN);
    expect(result?.block).toBe(true);
  });

  it('shows dialog when engine returns null while opted-in and hasUI is true (coerced to ask)', async () => {
    decideSpy.mockImplementationOnce(() => null);
    const ctx = makeCtx(true);
    ctx.ui.select.mockResolvedValue(CHOICE_ALLOW);
    const result = await resolveBashToolCall('some command', ctx, SETTINGS_OPTED_IN);
    // Null coerced to ask → dialog shown → user allows
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });
});
