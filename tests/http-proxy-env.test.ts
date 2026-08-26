import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for applyConfigHttpProxy.
 *
 * Vitest 4 defaults to pool:'forks' — each test file runs in its own forked
 * process, so process.env mutations here are fully isolated from other files.
 * describe.sequential ensures tests within this file run in order (not in
 * parallel), preventing within-file env-var races.
 */

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;

function getProxyEnv(): Record<string, string | undefined> {
  return Object.fromEntries(PROXY_VARS.map((k) => [k, process.env[k]]));
}

function clearProxyEnv(): void {
  for (const k of PROXY_VARS) delete process.env[k];
}

// Use describe.sequential so env mutations don't race with parallel test files
describe.sequential('applyConfigHttpProxy', () => {
  let savedEnv: Record<string, string | undefined>;
  let applyConfigHttpProxy: typeof import('../src/main/utils/http-proxy').applyConfigHttpProxy;
  let _overrideInitialProxyEnvForTest: typeof import('../src/main/utils/http-proxy')._overrideInitialProxyEnvForTest;

  beforeEach(async () => {
    // Save proxy env vars, clear them, then import a fresh module instance
    savedEnv = getProxyEnv();
    clearProxyEnv();
    // Reset module registry so initialProxyEnv snapshot is captured fresh
    // with the cleared env vars, not a stale snapshot from a prior import.
    vi.resetModules();
    // Re-import to get a fresh module instance
    const mod = await import('../src/main/utils/http-proxy');
    applyConfigHttpProxy = mod.applyConfigHttpProxy;
    _overrideInitialProxyEnvForTest = mod._overrideInitialProxyEnvForTest;
  });

  afterEach(() => {
    // Restore original env
    clearProxyEnv();
    for (const k of PROXY_VARS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    }
  });

  // --- blank / undefined with force=false: no-op ---

  it('does nothing when httpProxy is undefined (startup mode)', () => {
    applyConfigHttpProxy(undefined);
    expect(getProxyEnv()).toEqual({
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
    });
  });

  it('does nothing when httpProxy is empty string (startup mode)', () => {
    applyConfigHttpProxy('');
    expect(getProxyEnv()).toEqual({
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
    });
  });

  it('does nothing when httpProxy is whitespace-only (startup mode)', () => {
    applyConfigHttpProxy('   ');
    expect(getProxyEnv()).toEqual({
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
    });
  });

  // --- startup mode (force=false) with a URL ---

  it('sets all four proxy vars in startup mode when none are set', () => {
    applyConfigHttpProxy('http://proxy.example.com:8080');
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBe('http://proxy.example.com:8080');
    }
  });

  it('does not overwrite existing env vars in startup mode (??= semantics)', () => {
    process.env.HTTP_PROXY = 'http://shell-proxy:3128';
    process.env.http_proxy = 'http://shell-proxy:3128';
    applyConfigHttpProxy('http://config-proxy:8080', false);
    // Shell-provided vars preserved
    expect(process.env.HTTP_PROXY).toBe('http://shell-proxy:3128');
    expect(process.env.http_proxy).toBe('http://shell-proxy:3128');
    // Unset vars get the config value
    expect(process.env.HTTPS_PROXY).toBe('http://config-proxy:8080');
    expect(process.env.https_proxy).toBe('http://config-proxy:8080');
  });

  // --- force mode (force=true) with a URL ---

  it('unconditionally overwrites all four vars in force mode', () => {
    for (const k of PROXY_VARS) process.env[k] = 'http://old-proxy:3128';
    applyConfigHttpProxy('http://new-proxy:8080', true);
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBe('http://new-proxy:8080');
    }
  });

  // --- trimming ---

  it('trims whitespace from the proxy URL before applying', () => {
    applyConfigHttpProxy('  http://proxy.example.com:8080  ', true);
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBe('http://proxy.example.com:8080');
    }
  });

  // --- clear/restore (force=true with blank) ---

  it('restores to initial undefined when cleared after being set by the app', () => {
    // Simulate: initial env had no proxy (already cleared in beforeEach)
    _overrideInitialProxyEnvForTest({
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
    });
    // App sets proxy
    applyConfigHttpProxy('http://proxy.example.com:8080', true);
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBe('http://proxy.example.com:8080');
    }
    // User clears proxy — should restore to initial (undefined = delete)
    applyConfigHttpProxy('', true);
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBeUndefined();
    }
  });

  it('restores to shell-provided value when cleared after app override', () => {
    // Simulate: shell had a proxy set before app started
    _overrideInitialProxyEnvForTest({
      HTTP_PROXY: 'http://shell-proxy:3128',
      HTTPS_PROXY: 'http://shell-proxy:3128',
      http_proxy: 'http://shell-proxy:3128',
      https_proxy: 'http://shell-proxy:3128',
    });
    // App sets its own proxy (force=true at startup wouldn't normally overwrite,
    // but simulating a user change scenario)
    applyConfigHttpProxy('http://config-proxy:8080', true);
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBe('http://config-proxy:8080');
    }
    // User clears — should restore to shell values
    applyConfigHttpProxy('', true);
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBe('http://shell-proxy:3128');
    }
  });

  it('clear with force=false is a no-op (does not restore)', () => {
    applyConfigHttpProxy('http://proxy.example.com:8080', true);
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBe('http://proxy.example.com:8080');
    }
    // Startup-mode clear should not disturb env
    applyConfigHttpProxy('', false);
    for (const k of PROXY_VARS) {
      expect(process.env[k]).toBe('http://proxy.example.com:8080');
    }
  });
});
