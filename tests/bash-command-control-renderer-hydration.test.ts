import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Source-shape test for the renderer-side hydration that mirrors the
 * pre-existing `theme-settings-persistence.test.ts` pattern.
 *
 * Regression: on app restart the renderer used to initialize its Zustand
 * store with `defaultSettings` (empty bash lists) and then immediately
 * push them through `settings.update` IPC — overwriting the persisted
 * values the main process had just loaded from configStore. Users would
 * open Settings → Bash Commands and see their config gone.
 *
 * The fix is in `applyConfigSnapshot` in `src/renderer/hooks/useIPC.ts`:
 * it now copies `bashTrustedCommands` / `bashDenylist` from the AppConfig
 * sent by main into the Zustand store before anything else touches it.
 * These assertions lock that behaviour in place.
 */

const useIPCPath = path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts');

describe('bash command control: renderer bootstrap hydration', () => {
  it('applyConfigSnapshot copies bash trust and deny lists into Zustand from main config', () => {
    const source = fs.readFileSync(useIPCPath, 'utf8');

    // The same setSettings call that hydrates theme must also hydrate the
    // bash lists so the bootstrap `settings.update` round-trip carries the
    // persisted values back instead of renderer defaults.
    expect(source).toContain('bashTrustedCommands: config.bashTrustedCommands ?? []');
    expect(source).toContain('bashDenylist: config.bashDenylist ?? []');

    // Belt-and-braces: all three hydration fields land in the same
    // setSettings call, not spread across multiple redundant setters.
    expect(source).toMatch(
      /store\.setSettings\(\s*\{[^}]*theme:[^}]*bashTrustedCommands[^}]*bashDenylist/s
    );
  });

  it('still sends bash lists in the bootstrap settings.update IPC payload', () => {
    // After hydration pulls them from main, the bootstrap IPC round-trip
    // sends them right back. This is an identity write — harmless and
    // keeps the main-process cache and persisted config in sync even in
    // unusual startup orderings.
    const source = fs.readFileSync(useIPCPath, 'utf8');
    expect(source).toContain('bashTrustedCommands: latest.settings.bashTrustedCommands');
    expect(source).toContain('bashDenylist: latest.settings.bashDenylist');
  });
});
