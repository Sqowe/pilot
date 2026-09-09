import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

/**
 * Guards the SDK-only boundary applied to sessions (ARCHITECTURE.md §4.1).
 *
 * A persisting `SessionManager` writes to `~/.pi/agent/sessions/--<encoded cwd>--`, the
 * directory the user's own `pi` CLI reads and writes. Sharing it would put this app's
 * conversations in the CLI's session list and vice versa — and because the pinned SDK and
 * the installed CLI are normally *different* versions, and session files are rewritten to
 * the current format version on load, whichever side is newer would silently migrate the
 * other's files.
 *
 * It also has a second effect worth pinning: pi only sets `PI_SESSION_FILE` in the
 * environment of agent bash commands when a session file exists, so an in-memory session
 * keeps the transcript path out of reach of model-authored commands.
 *
 * Two independent things have to hold, so both are asserted: that the SDK's `inMemory()`
 * still means "no file" (an uplift could change it), and that the app still asks for it.
 */
describe('SDK-only boundary: pi sessions stay in memory', () => {
  it('inMemory() reports no session file', () => {
    const manager = SessionManager.inMemory();

    // The bash tool's session-environment injection is gated on exactly this call
    // returning something falsy.
    expect(manager.getSessionFile()).toBeFalsy();
  });

  it('inMemory() does not resolve to the pi CLI session directory', () => {
    const manager = SessionManager.inMemory();
    const dir = manager.getSessionDir();

    expect(dir).toBeFalsy();
    // Belt and braces: even if a directory is reported one day, it must not be the
    // CLI's default location for this cwd.
    expect(manager.usesDefaultSessionDir()).toBe(false);
  });

  it('the agent runner constructs its session with inMemory()', () => {
    const runnerPath = join(__dirname, '..', '..', 'main', 'claude', 'agent-runner.ts');
    const source = readFileSync(runnerPath, 'utf8');

    expect(source).toContain('sessionManager: PiSessionManager.inMemory()');

    // No file-backed construction anywhere in the runner. `fromFile`/`forkFrom` would
    // both land in the CLI's directory.
    expect(source).not.toMatch(/PiSessionManager\.(fromFile|forkFrom|create)\s*\(/);
  });
});
