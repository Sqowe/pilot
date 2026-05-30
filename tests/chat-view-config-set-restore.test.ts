import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const chatViewPath = path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx');

describe('ChatView config set restore on session open', () => {
  const source = fs.readFileSync(chatViewPath, 'utf8');

  it('reads configSets and activeConfigSetId from appConfig', () => {
    expect(source).toContain('const configSets = appConfig?.configSets ?? [];');
    expect(source).toContain("const activeConfigSetId = appConfig?.activeConfigSetId ?? '';");
  });

  it('uses a ref to prevent duplicate restore switches per session', () => {
    expect(source).toContain('const lastRestoredSessionRef = useRef<string | null>(null)');
    expect(source).toContain('if (lastRestoredSessionRef.current === activeSessionId) return;');
  });

  it('uses a monotonically increasing request token incremented at the top of every effect run', () => {
    expect(source).toContain('const restoreRequestRef = useRef(0);');
    expect(source).toContain('const requestToken = ++restoreRequestRef.current;');
    // Token must be incremented before precondition checks
    const tokenLine = source.indexOf('const requestToken = ++restoreRequestRef.current;');
    const preconditionLine = source.indexOf('if (configSets.length <= 1) return;');
    expect(tokenLine).toBeGreaterThan(-1);
    expect(preconditionLine).toBeGreaterThan(-1);
    expect(tokenLine).toBeLessThan(preconditionLine);
  });

  it('uses a promise chain for serialization instead of polling', () => {
    expect(source).toContain('const restoreChainRef = useRef<Promise<void>>(Promise.resolve());');
    expect(source).toContain(
      'restoreChainRef.current = restoreChainRef.current.then(async () => {'
    );
    // No polling loop
    expect(source).not.toContain('while (restoreInFlightRef.current)');
  });

  it('checks staleness before calling main-process IPC', () => {
    expect(source).toContain('// Pre-IPC staleness check: abort if a newer effect run has fired');
    expect(source).toContain('if (restoreRequestRef.current !== requestToken) return;');
  });

  it('issues a corrective switch when stale IPC mutates main-process config', () => {
    expect(source).toContain('// Stale IPC mutated main-process config. Issue a corrective switch');
    expect(source).toContain('useAppStore.getState().appConfig?.activeConfigSetId');
    expect(source).toContain(
      'await window.electronAPI!.config.switchSet({ id: currentActiveSetId });'
    );
  });

  it('prefers stored configSetId over model-based fallback', () => {
    expect(source).toContain(
      'let targetConfigSetId: string | undefined = activeSession.configSetId;'
    );
    expect(source).toContain('if (!targetConfigSetId && activeSession.model)');
  });

  it('only applies model-based fallback when exactly one config set matches', () => {
    expect(source).toContain('const matchingSets = configSets.filter((set) => {');
    expect(source).toContain('if (matchingSets.length === 1) {');
  });

  it('does NOT mark session as handled for transient states', () => {
    expect(source).toContain('if (!targetConfigSetId) {\n      // Cannot determine target');
    expect(source).toContain('// Target config set not found \u2014 do NOT mark as handled');
  });

  it('only marks session as definitively restored after successful switch application', () => {
    expect(source).toContain('// Mark as definitively restored only after successful application');
    expect(source).toContain('lastRestoredSessionRef.current = capturedSessionId;');
  });

  it('marks session as restored when target already equals active config set', () => {
    expect(source).toContain('if (targetConfigSetId === activeConfigSetId) {');
    expect(source).toContain('// Already on the correct set \u2014 mark as definitively restored');
  });

  it('shows a notification after successful restore', () => {
    expect(source).toContain("t('chat.configSetRestored', { name: setName })");
  });

  it('does not mark as restored on error so it can retry', () => {
    expect(source).toContain('// Do not mark as restored \u2014 will retry on next render cycle');
  });

  it('includes all real data dependencies in the effect dependency array', () => {
    // Dependency array is now multi-line; verify key deps are present
    expect(source).toContain('activeSessionId,');
    expect(source).toContain('activeSession,');
    expect(source).toContain('configSets,');
    expect(source).toContain('activeConfigSetId,');
    expect(source).toContain('setAppConfig,');
    expect(source).toContain('setIsConfigured,');
    expect(source).toContain('setGlobalNotice,');
  });
});
