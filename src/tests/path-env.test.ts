/**
 * Behavioral tests for the centralized PATH environment utility.
 * Tests idempotent reconciliation: apply, replace, remove transitions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger to avoid Electron dependency
vi.mock('../main/utils/logger', () => ({
  log: (..._args: unknown[]) => {},
  logWarn: (..._args: unknown[]) => {},
  logError: (..._args: unknown[]) => {},
}));

let savedPath: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  // Reset module state between tests
  const mod = await import('../main/utils/path-env');
  mod._internals.resetForTesting();
});

describe('path-env utility', () => {
  describe('_internals.deduplicatePaths', () => {
    it('removes duplicate entries preserving order', async () => {
      const { _internals } = await import('../main/utils/path-env');
      const result = _internals.deduplicatePaths(['/a', '/b', '/a', '/c', '/b']);
      expect(result).toEqual(['/a', '/b', '/c']);
    });

    it('trims entries and removes empty strings', async () => {
      const { _internals } = await import('../main/utils/path-env');
      const result = _internals.deduplicatePaths(['  /a  ', '', '  ', '/b']);
      expect(result).toEqual(['/a', '/b']);
    });

    it('handles empty input', async () => {
      const { _internals } = await import('../main/utils/path-env');
      const result = _internals.deduplicatePaths([]);
      expect(result).toEqual([]);
    });
  });

  describe('setBasePath + applyLocalDevPath', () => {
    it('applies localDevPath entries at the start of PATH', async () => {
      const { setBasePath, applyLocalDevPath } = await import('../main/utils/path-env');
      process.env.PATH = '/usr/bin:/usr/local/bin';
      setBasePath('/usr/bin:/usr/local/bin');

      const result = applyLocalDevPath('/my/dev/bin:/my/other/bin');
      expect(result.startsWith('/my/dev/bin')).toBe(true);
      expect(result).toContain('/my/other/bin');
      expect(result).toContain('/usr/bin');
      expect(result).toContain('/usr/local/bin');
    });

    it('removes old localDevPath entries when changing to new value', async () => {
      const { setBasePath, applyLocalDevPath } = await import('../main/utils/path-env');
      setBasePath('/usr/bin:/usr/local/bin');

      // Apply initial localDevPath
      applyLocalDevPath('/old/path/A:/old/path/B');
      expect(process.env.PATH).toContain('/old/path/A');

      // Change to new localDevPath — old entries should be gone
      applyLocalDevPath('/new/path/C');
      expect(process.env.PATH).not.toContain('/old/path/A');
      expect(process.env.PATH).not.toContain('/old/path/B');
      expect(process.env.PATH).toContain('/new/path/C');
      expect(process.env.PATH).toContain('/usr/bin');
    });

    it('clears localDevPath entries when set to empty string', async () => {
      const { setBasePath, applyLocalDevPath } = await import('../main/utils/path-env');
      setBasePath('/usr/bin:/usr/local/bin');

      // Apply localDevPath
      applyLocalDevPath('/my/dev/bin');
      expect(process.env.PATH).toContain('/my/dev/bin');

      // Clear it
      applyLocalDevPath('');
      expect(process.env.PATH).not.toContain('/my/dev/bin');
      expect(process.env.PATH).toContain('/usr/bin');
      expect(process.env.PATH).toContain('/usr/local/bin');
    });

    it('is idempotent — calling multiple times with same value produces same result', async () => {
      const { setBasePath, applyLocalDevPath } = await import('../main/utils/path-env');
      setBasePath('/usr/bin:/usr/local/bin');

      applyLocalDevPath('/my/dev/bin');
      const first = process.env.PATH;

      applyLocalDevPath('/my/dev/bin');
      const second = process.env.PATH;

      expect(first).toBe(second);
    });

    it('deduplicates entries that appear in both localDevPath and base', async () => {
      const { setBasePath, applyLocalDevPath } = await import('../main/utils/path-env');
      setBasePath('/usr/bin:/usr/local/bin:/opt/homebrew/bin');

      // localDevPath includes a path already in base
      const result = applyLocalDevPath('/opt/homebrew/bin:/my/custom');
      const parts = result.split(':');

      // /opt/homebrew/bin should appear only once, at the front
      const indices = parts
        .map((p: string, i: number) => (p === '/opt/homebrew/bin' ? i : -1))
        .filter((i: number) => i >= 0);
      expect(indices).toHaveLength(1);
      expect(indices[0]).toBe(0); // at the front
    });

    it('preserves base PATH order after localDevPath entries', async () => {
      const { setBasePath, applyLocalDevPath } = await import('../main/utils/path-env');
      setBasePath('/bundled/node:/opt/homebrew/bin:/usr/local/bin:/usr/bin');

      applyLocalDevPath('/my/dev');
      const parts = (process.env.PATH || '').split(':');

      // localDevPath first, then base in original order
      expect(parts[0]).toBe('/my/dev');
      expect(parts.indexOf('/bundled/node')).toBeLessThan(parts.indexOf('/opt/homebrew/bin'));
      expect(parts.indexOf('/opt/homebrew/bin')).toBeLessThan(parts.indexOf('/usr/local/bin'));
    });

    it('strips existing localDevPath entries from base during setBasePath', async () => {
      const { setBasePath, applyLocalDevPath, _internals } = await import('../main/utils/path-env');

      // Simulate: PATH already has localDevPath entries baked in
      setBasePath('/my/dev:/usr/bin:/usr/local/bin', '/my/dev');

      // Base should NOT contain /my/dev
      const basePath = _internals.getBasePath();
      expect(basePath).not.toContain('/my/dev');
      expect(basePath).toContain('/usr/bin');

      // Applying localDevPath should add it back at front
      applyLocalDevPath('/my/dev');
      expect((process.env.PATH || '').startsWith('/my/dev')).toBe(true);
    });
  });

  describe('isBasePathSet', () => {
    it('returns false before setBasePath is called', async () => {
      const { isBasePathSet } = await import('../main/utils/path-env');
      expect(isBasePathSet()).toBe(false);
    });

    it('returns true after setBasePath is called', async () => {
      const { setBasePath, isBasePathSet } = await import('../main/utils/path-env');
      setBasePath('/usr/bin');
      expect(isBasePathSet()).toBe(true);
    });
  });

  describe('getEffectivePath', () => {
    it('returns current process.env.PATH', async () => {
      const { getEffectivePath } = await import('../main/utils/path-env');
      process.env.PATH = '/test/path:/another';
      expect(getEffectivePath()).toBe('/test/path:/another');
    });
  });

  describe('transition scenarios', () => {
    it('handles A → B → empty → C transitions correctly', async () => {
      const { setBasePath, applyLocalDevPath } = await import('../main/utils/path-env');
      setBasePath('/usr/bin:/usr/local/bin');

      // A
      applyLocalDevPath('/path/A');
      expect(process.env.PATH).toContain('/path/A');

      // A → B
      applyLocalDevPath('/path/B');
      expect(process.env.PATH).toContain('/path/B');
      expect(process.env.PATH).not.toContain('/path/A');

      // B → empty
      applyLocalDevPath('');
      expect(process.env.PATH).not.toContain('/path/B');
      expect(process.env.PATH).toContain('/usr/bin');

      // empty → C
      applyLocalDevPath('/path/C');
      expect(process.env.PATH).toContain('/path/C');
      expect(process.env.PATH).not.toContain('/path/A');
      expect(process.env.PATH).not.toContain('/path/B');
    });

    it('handles multi-entry localDevPath transitions', async () => {
      const { setBasePath, applyLocalDevPath } = await import('../main/utils/path-env');
      setBasePath('/usr/bin');

      applyLocalDevPath('/aaa:/bbb:/ccc');
      expect(process.env.PATH).toBe('/aaa:/bbb:/ccc:/usr/bin');

      applyLocalDevPath('/xxx:/yyy');
      expect(process.env.PATH).toBe('/xxx:/yyy:/usr/bin');
      expect(process.env.PATH).not.toContain('/aaa');
      expect(process.env.PATH).not.toContain('/bbb');
      expect(process.env.PATH).not.toContain('/ccc');
    });
  });
});
