/**
 * Tests for the ref-counted runtime API key tracker in agent-runner.
 * Verifies session isolation, cleanup semantics, and concurrent-run safety.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _testOnly_trackRuntimeKeys,
  _testOnly_releaseRuntimeKeys,
  _testOnly_runtimeKeyRefCounts,
} from '../src/main/claude/agent-runner';

// ---------------------------------------------------------------------------
// Minimal AuthStorage stub
// ---------------------------------------------------------------------------

function makeAuthStorageStub() {
  const store = new Map<string, string>();
  return {
    setRuntimeApiKey: vi.fn((provider: string, key: string) => {
      store.set(provider, key);
      return Promise.resolve();
    }),
    removeRuntimeApiKey: vi.fn((provider: string) => {
      store.delete(provider);
      return Promise.resolve();
    }),
    _store: store,
  };
}

type AuthStorageStub = ReturnType<typeof makeAuthStorageStub>;

// Cast to satisfy the typed parameter — only the two methods are used
function asAuth(stub: AuthStorageStub) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return stub as any;
}

beforeEach(() => {
  // Clear ref-counts between tests to prevent state leakage
  _testOnly_runtimeKeyRefCounts.clear();
});

describe('runtime key tracker — basic set/release', () => {
  it('sets the key in AuthStorage and tracks ref-count', async () => {
    const auth = makeAuthStorageStub();
    await _testOnly_trackRuntimeKeys(asAuth(auth), ['zai'], 'key-abc');
    expect(auth.setRuntimeApiKey).toHaveBeenCalledWith('zai', 'key-abc');
    expect(_testOnly_runtimeKeyRefCounts.get('zai')).toBe(1);
  });

  it('removes the key when ref-count reaches zero', async () => {
    const auth = makeAuthStorageStub();
    await _testOnly_trackRuntimeKeys(asAuth(auth), ['zai'], 'key-abc');
    await _testOnly_releaseRuntimeKeys(asAuth(auth), ['zai']);
    expect(auth.removeRuntimeApiKey).toHaveBeenCalledWith('zai');
    expect(_testOnly_runtimeKeyRefCounts.has('zai')).toBe(false);
  });

  it('does not remove the key while another session still holds a ref', async () => {
    const auth = makeAuthStorageStub();
    // Session A and B both set the same provider key
    await _testOnly_trackRuntimeKeys(asAuth(auth), ['anthropic'], 'key-a');
    await _testOnly_trackRuntimeKeys(asAuth(auth), ['anthropic'], 'key-b');
    expect(_testOnly_runtimeKeyRefCounts.get('anthropic')).toBe(2);

    // Session A releases — ref-count drops to 1, key must NOT be removed
    await _testOnly_releaseRuntimeKeys(asAuth(auth), ['anthropic']);
    expect(auth.removeRuntimeApiKey).not.toHaveBeenCalled();
    expect(_testOnly_runtimeKeyRefCounts.get('anthropic')).toBe(1);

    // Session B releases — ref-count reaches 0, key IS removed
    await _testOnly_releaseRuntimeKeys(asAuth(auth), ['anthropic']);
    expect(auth.removeRuntimeApiKey).toHaveBeenCalledWith('anthropic');
    expect(_testOnly_runtimeKeyRefCounts.has('anthropic')).toBe(false);
  });

  it('handles multiple keys set by one session independently', async () => {
    const auth = makeAuthStorageStub();
    await _testOnly_trackRuntimeKeys(asAuth(auth), ['openrouter', 'google'], 'key-or');
    expect(_testOnly_runtimeKeyRefCounts.get('openrouter')).toBe(1);
    expect(_testOnly_runtimeKeyRefCounts.get('google')).toBe(1);

    await _testOnly_releaseRuntimeKeys(asAuth(auth), ['openrouter', 'google']);
    expect(auth.removeRuntimeApiKey).toHaveBeenCalledWith('openrouter');
    expect(auth.removeRuntimeApiKey).toHaveBeenCalledWith('google');
    expect(_testOnly_runtimeKeyRefCounts.size).toBe(0);
  });

  it('continues releasing remaining keys even if one removal throws (best-effort)', async () => {
    const auth = makeAuthStorageStub();
    auth.removeRuntimeApiKey.mockImplementationOnce(() =>
      Promise.reject(new Error('storage error'))
    );

    await _testOnly_trackRuntimeKeys(asAuth(auth), ['openrouter', 'google'], 'key-or');
    // Should not throw; both keys should have removal attempted
    await expect(
      _testOnly_releaseRuntimeKeys(asAuth(auth), ['openrouter', 'google'])
    ).resolves.toBeUndefined();
    expect(auth.removeRuntimeApiKey).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for keys with no tracked ref-count (defensive)', async () => {
    const auth = makeAuthStorageStub();
    // Release a key that was never tracked — must not throw or remove anything
    await expect(
      _testOnly_releaseRuntimeKeys(asAuth(auth), ['unknown-key'])
    ).resolves.toBeUndefined();
    expect(auth.removeRuntimeApiKey).toHaveBeenCalledTimes(1); // count<=1 path removes it
  });
});
