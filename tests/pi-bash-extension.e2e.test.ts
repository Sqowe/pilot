import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBashRestrictionsSettings } from '../pi-extensions/bash-restrictions/config';
import {
  resolveBashToolCall,
  CHOICE_ALLOW,
  CHOICE_DENY,
  CHOICE_SUGGEST,
  type BashCtx,
} from '../pi-extensions/bash-restrictions/extension';

/**
 * Phase 6 integration test — the full chain end to end:
 *
 *   config file  →  loadBashRestrictionsSettings (real)
 *                →  decideBashPermission (real shared engine)
 *                →  resolveBashToolCall (real mapper)
 *
 * Unlike the unit suites, nothing here is stubbed except the UI dialog surface
 * (select/input), which a real TUI would otherwise provide. The config loader,
 * the shared engine, and the mapper are all the production modules, driven by
 * real on-disk JSON in throwaway temp directories. No `pi` process is spawned.
 *
 * SAFETY: resolveBashToolCall only DECIDES — it never executes the command
 * string. The destructive-looking fixtures (`rm -rf …`, `echo $(rm -rf /)`)
 * are inert text used purely to exercise the decision engine.
 */

// ---------------------------------------------------------------------------
// Temp config fixtures (mirrors pi-bash-extension-config.test.ts conventions)
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpProject: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'pi-e2e-home-'));
  tmpProject = mkdtempSync(join(tmpdir(), 'pi-e2e-proj-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
});

/** Write the global config file at <tmpHome>/.pi/agent/bash-restrictions.json. */
function writeGlobal(content: unknown): void {
  const dir = join(tmpHome, '.pi', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bash-restrictions.json'), JSON.stringify(content));
}

/** Write the project config file at <tmpProject>/.pi/bash-restrictions.json. */
function writeProject(content: unknown): void {
  const dir = join(tmpProject, '.pi');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bash-restrictions.json'), JSON.stringify(content));
}

/** Run the real loader against the temp home + temp project. */
function load() {
  return loadBashRestrictionsSettings(tmpProject, { homeDir: tmpHome });
}

// ---------------------------------------------------------------------------
// Fake UI contexts
// ---------------------------------------------------------------------------

type SpyCtx = BashCtx & {
  ui: { select: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> };
};

/**
 * Interactive ctx whose `select` resolves to a fixed choice (pass `undefined`
 * to simulate a dialog timeout / dismissal) and whose `input` resolves to the
 * given suggestion text.
 */
function uiCtx(selectResult: string | undefined, inputResult = ''): SpyCtx {
  return {
    hasUI: true,
    ui: {
      select: vi.fn().mockResolvedValue(selectResult),
      input: vi.fn().mockResolvedValue(inputResult),
    },
  };
}

/** Headless ctx — no UI surface at all. */
const headlessCtx: BashCtx = { hasUI: false };

// ---------------------------------------------------------------------------
// Core chain: the five cases from the design doc (§9, Phase 6)
// ---------------------------------------------------------------------------

describe('full chain: config file → loader → engine → mapper', () => {
  it('trusted command → allow (undefined, no dialog shown)', async () => {
    writeProject({ trusted: ['ls *', 'cat *'], denied: [], permissionTimeoutSeconds: 300 });
    const settings = load();
    // Would deny if asked — asserting it is never asked proves the allow path.
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall('ls -la', ctx, settings);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('denylisted command → block (denylist beats trust)', async () => {
    writeProject({ trusted: ['ls *'], denied: ['rm'], permissionTimeoutSeconds: 300 });
    const settings = load();
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall('rm -rf build', ctx, settings);
    expect(result?.block).toBe(true);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it('unsupported shell syntax (command substitution) → ask → block', async () => {
    // `echo` is trusted, but `$(...)` trips the syntax guard → 'ask' regardless.
    writeProject({ trusted: ['echo *'], denied: [], permissionTimeoutSeconds: 300 });
    const settings = load();
    const ctx = uiCtx(undefined); // user dismisses
    const result = await resolveBashToolCall('echo $(rm -rf /)', ctx, settings);
    expect(result?.block).toBe(true);
  });

  it('headless ask → block (fail-closed, no UI to confirm)', async () => {
    writeProject({ trusted: ['ls *'], denied: ['rm'], permissionTimeoutSeconds: 300 });
    const settings = load();
    const result = await resolveBashToolCall('rm -rf build', headlessCtx, settings);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('no UI');
  });

  it('dialog timeout / dismiss (select → undefined) → block (auto-deny)', async () => {
    writeProject({ trusted: ['ls *'], denied: [], permissionTimeoutSeconds: 300 });
    const settings = load();
    const ctx = uiCtx(undefined); // select resolves undefined = timeout/cancel
    const result = await resolveBashToolCall('git push --force', ctx, settings);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('timed out');
  });
});

// ---------------------------------------------------------------------------
// Global ∪ project merge actually drives the decision (§7)
// ---------------------------------------------------------------------------

describe('global ∪ project merge drives the decision', () => {
  it('denylist from global blocks a command trusted only in the project', async () => {
    writeGlobal({ denied: ['curl'] });
    writeProject({ trusted: ['curl *'] });
    const settings = load();
    // project trusts `curl *`, but the global denylist `curl` wins → ask → block.
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall('curl https://example.com', ctx, settings);
    expect(result?.block).toBe(true);
  });

  it('trust union: a pipeline auto-allows only via global+project combined', async () => {
    writeGlobal({ trusted: ['ls *'] });
    writeProject({ trusted: ['cat *'] });
    const settings = load();
    const ctx = uiCtx(CHOICE_DENY);
    // `cat f | ls -la` → [`cat f`, `ls -la`]: cat from project, ls from global.
    // Both pieces need a prefix match (`cat *` = ^cat .*, `ls *` = ^ls .*), so
    // each must carry an argument — bare `ls` would not match `ls *`.
    const result = await resolveBashToolCall('cat f | ls -la', ctx, settings);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Interactive outcomes & timeout plumbing through the real loader
// ---------------------------------------------------------------------------

describe('interactive outcomes and timeout plumbing', () => {
  it('"Deny & suggest" → block whose reason carries the suggestion verbatim', async () => {
    writeProject({ trusted: [], denied: ['rm'], permissionTimeoutSeconds: 300 });
    const settings = load();
    const ctx = uiCtx(CHOICE_SUGGEST, 'use trash-cli instead');
    const result = await resolveBashToolCall('rm -rf build', ctx, settings);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('use trash-cli instead');
    expect(result?.reason).toContain('NOT globally');
    expect(ctx.ui.input).toHaveBeenCalledTimes(1);
  });

  it('config permissionTimeoutSeconds flows into the dialog timeout option', async () => {
    writeProject({ trusted: ['ls *'], denied: [], permissionTimeoutSeconds: 45 });
    const settings = load();
    expect(settings.permissionTimeoutSeconds).toBe(45);
    const ctx = uiCtx(CHOICE_ALLOW);
    // `git push` is not trusted → ask → select shown with the configured timeout.
    await resolveBashToolCall('git push', ctx, settings);
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
      timeout: 45_000,
    });
  });

  it('infinite timeout (0) omits the timeout option entirely', async () => {
    writeProject({ trusted: ['ls *'], denied: [], permissionTimeoutSeconds: 0 });
    const settings = load();
    expect(settings.permissionTimeoutSeconds).toBe(0);
    const ctx = uiCtx(CHOICE_ALLOW);
    await resolveBashToolCall('git push', ctx, settings);
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.any(String), expect.any(Array), undefined);
  });
});

// ---------------------------------------------------------------------------
// Gate inactive when neither config file exists
// ---------------------------------------------------------------------------

describe('no config files → gate inactive', () => {
  it('defers to pi (undefined) when neither config file exists', async () => {
    const settings = load(); // both temp dirs are empty
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall('rm -rf /', ctx, settings);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});
