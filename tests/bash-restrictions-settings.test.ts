/**
 * Unit tests for the shared bash-restrictions settings module.
 *
 * Covers sanitizeBashCommandList, normalizePermissionTimeout, and
 * sanitizeBashRestrictionsSettings — the normalizers that are the parity
 * mechanism between the Electron app and the pi CLI extension.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASH_RESTRICTIONS_SETTINGS,
  normalizePermissionTimeout,
  sanitizeBashCommandList,
  sanitizeBashRestrictionsSettings,
  sanitizeTrustedDirectories,
} from '../src/shared/bash-restrictions/settings';

// ---------------------------------------------------------------------------
// sanitizeBashCommandList
// ---------------------------------------------------------------------------

describe('sanitizeBashCommandList', () => {
  it('passes through a clean string array unchanged', () => {
    expect(sanitizeBashCommandList(['npm *', 'git *'])).toEqual(['npm *', 'git *']);
  });

  it('trims leading and trailing whitespace from each entry', () => {
    expect(sanitizeBashCommandList(['  npm *  ', '  git *  '])).toEqual(['npm *', 'git *']);
  });

  it('filters out empty strings after trimming', () => {
    expect(sanitizeBashCommandList(['npm *', '', '   ', 'git *'])).toEqual(['npm *', 'git *']);
  });

  it('drops non-string entries (numbers, null, undefined, objects)', () => {
    expect(sanitizeBashCommandList(['npm *', 42, null, undefined, {}, 'git *'])).toEqual([
      'npm *',
      'git *',
    ]);
  });

  it('returns an empty array for a non-array input (string)', () => {
    expect(sanitizeBashCommandList('npm *')).toEqual([]);
  });

  it('returns an empty array for a non-array input (object)', () => {
    expect(sanitizeBashCommandList({ trusted: ['npm *'] })).toEqual([]);
  });

  it('returns an empty array for null', () => {
    expect(sanitizeBashCommandList(null)).toEqual([]);
  });

  it('returns an empty array for undefined', () => {
    expect(sanitizeBashCommandList(undefined)).toEqual([]);
  });

  it('returns an empty array for a number', () => {
    expect(sanitizeBashCommandList(42)).toEqual([]);
  });

  it('returns an empty array for an empty array', () => {
    expect(sanitizeBashCommandList([])).toEqual([]);
  });

  it('preserves `*` wildcard and special chars that are part of patterns', () => {
    expect(sanitizeBashCommandList(['./configure *', '--force', 'tool[x]'])).toEqual([
      './configure *',
      '--force',
      'tool[x]',
    ]);
  });
});

// ---------------------------------------------------------------------------
// normalizePermissionTimeout
// ---------------------------------------------------------------------------

describe('sanitizeTrustedDirectories', () => {
  it('keeps entries as written — they are resolved later, against the session directory', () => {
    expect(sanitizeTrustedDirectories(['./', '~/work', '/tmp'])).toEqual(['./', '~/work', '/tmp']);
  });

  it('drops non-strings and blanks, trims, and removes exact duplicates', () => {
    expect(sanitizeTrustedDirectories([' /tmp ', '/tmp', '', '  ', 7, {}, './'])).toEqual([
      '/tmp',
      './',
    ]);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(sanitizeTrustedDirectories(undefined)).toEqual([]);
    expect(sanitizeTrustedDirectories('/tmp')).toEqual([]);
    expect(sanitizeTrustedDirectories({ 0: '/tmp' })).toEqual([]);
  });
});

describe('normalizePermissionTimeout', () => {
  // --- Pass-through ---

  it('returns 300 as-is (default value)', () => {
    expect(normalizePermissionTimeout(300)).toBe(300);
  });

  it('returns 10 as-is (minimum boundary)', () => {
    expect(normalizePermissionTimeout(10)).toBe(10);
  });

  it('returns 3600 as-is (maximum boundary)', () => {
    expect(normalizePermissionTimeout(3600)).toBe(3600);
  });

  it('floors a fractional value before clamping', () => {
    // 10.9 → floor → 10 → within range
    expect(normalizePermissionTimeout(10.9)).toBe(10);
  });

  // --- Clamping ---

  it('clamps 5 up to the minimum of 10', () => {
    expect(normalizePermissionTimeout(5)).toBe(10);
  });

  it('clamps 1 up to the minimum of 10', () => {
    expect(normalizePermissionTimeout(1)).toBe(10);
  });

  it('clamps 9999 down to the maximum of 3600', () => {
    expect(normalizePermissionTimeout(9999)).toBe(3600);
  });

  it('clamps 3601 down to 3600', () => {
    expect(normalizePermissionTimeout(3601)).toBe(3600);
  });

  // --- Infinite (zero/negative → 0) ---

  it('returns 0 for 0 (infinite — no timeout)', () => {
    expect(normalizePermissionTimeout(0)).toBe(0);
  });

  it('returns 0 for negative values (also treated as infinite)', () => {
    expect(normalizePermissionTimeout(-1)).toBe(0);
    expect(normalizePermissionTimeout(-100)).toBe(0);
  });

  // --- Invalid / fallback to 300 ---

  it('returns 300 for NaN', () => {
    expect(normalizePermissionTimeout(NaN)).toBe(300);
  });

  it('returns 300 for Infinity', () => {
    expect(normalizePermissionTimeout(Infinity)).toBe(300);
  });

  it('returns 300 for -Infinity', () => {
    expect(normalizePermissionTimeout(-Infinity)).toBe(300);
  });

  it('returns 300 for a string', () => {
    expect(normalizePermissionTimeout('300')).toBe(300);
  });

  it('returns 300 for null', () => {
    expect(normalizePermissionTimeout(null)).toBe(300);
  });

  it('returns 300 for undefined', () => {
    expect(normalizePermissionTimeout(undefined)).toBe(300);
  });

  it('returns 300 for an object', () => {
    expect(normalizePermissionTimeout({ seconds: 300 })).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// sanitizeBashRestrictionsSettings
// ---------------------------------------------------------------------------

describe('sanitizeBashRestrictionsSettings', () => {
  // --- Full valid input ---

  it('returns a canonical object from a fully valid input (pi extension key names)', () => {
    const result = sanitizeBashRestrictionsSettings({
      trusted: ['npm *', 'git *'],
      denied: ['rm -rf', 'sudo'],
      permissionTimeoutSeconds: 120,
    });
    expect(result).toEqual({
      trusted: ['npm *', 'git *'],
      denied: ['rm -rf', 'sudo'],
      trustedDirectories: [],
      permissionTimeoutSeconds: 120,
    });
  });

  it('reads trustedDirectories, trimmed and without duplicates', () => {
    const result = sanitizeBashRestrictionsSettings({
      trustedDirectories: [' ./ ', '/tmp', './', '', 42, null, '/tmp'],
    });
    expect(result.trustedDirectories).toEqual(['./', '/tmp']);
  });

  it('treats a missing or malformed trustedDirectories as empty (write checks off)', () => {
    expect(sanitizeBashRestrictionsSettings({}).trustedDirectories).toEqual([]);
    expect(
      sanitizeBashRestrictionsSettings({ trustedDirectories: './' }).trustedDirectories
    ).toEqual([]);
    expect(
      sanitizeBashRestrictionsSettings({ trustedDirectories: null }).trustedDirectories
    ).toEqual([]);
  });

  it('also accepts app key names (bashTrustedCommands / bashDenylist)', () => {
    const result = sanitizeBashRestrictionsSettings({
      bashTrustedCommands: ['npm *'],
      bashDenylist: ['sudo'],
      permissionTimeoutSeconds: 60,
    });
    expect(result.trusted).toEqual(['npm *']);
    expect(result.denied).toEqual(['sudo']);
    expect(result.permissionTimeoutSeconds).toBe(60);
  });

  // --- Partial input — missing fields use defaults ---

  it('fills in missing `trusted` with an empty array', () => {
    const result = sanitizeBashRestrictionsSettings({
      denied: ['rm'],
      permissionTimeoutSeconds: 300,
    });
    expect(result.trusted).toEqual([]);
  });

  it('fills in missing `denied` with an empty array', () => {
    const result = sanitizeBashRestrictionsSettings({
      trusted: ['git *'],
      permissionTimeoutSeconds: 300,
    });
    expect(result.denied).toEqual([]);
  });

  it('fills in missing `permissionTimeoutSeconds` with 300', () => {
    const result = sanitizeBashRestrictionsSettings({ trusted: ['git *'], denied: [] });
    expect(result.permissionTimeoutSeconds).toBe(300);
  });

  it('returns all defaults for an empty object', () => {
    expect(sanitizeBashRestrictionsSettings({})).toEqual({
      ...DEFAULT_BASH_RESTRICTIONS_SETTINGS,
    });
  });

  // --- Garbage / invalid inputs fall back to defaults ---

  it('returns all defaults for null', () => {
    expect(sanitizeBashRestrictionsSettings(null)).toEqual({
      ...DEFAULT_BASH_RESTRICTIONS_SETTINGS,
    });
  });

  it('returns all defaults for undefined', () => {
    expect(sanitizeBashRestrictionsSettings(undefined)).toEqual({
      ...DEFAULT_BASH_RESTRICTIONS_SETTINGS,
    });
  });

  it('returns all defaults for a string', () => {
    expect(sanitizeBashRestrictionsSettings('invalid')).toEqual({
      ...DEFAULT_BASH_RESTRICTIONS_SETTINGS,
    });
  });

  it('returns all defaults for a number', () => {
    expect(sanitizeBashRestrictionsSettings(42)).toEqual({
      ...DEFAULT_BASH_RESTRICTIONS_SETTINGS,
    });
  });

  it('returns all defaults for an array', () => {
    expect(sanitizeBashRestrictionsSettings(['npm *'])).toEqual({
      ...DEFAULT_BASH_RESTRICTIONS_SETTINGS,
    });
  });

  // --- Field-level sanitization applied ---

  it('strips non-string entries from trusted and denied lists', () => {
    const result = sanitizeBashRestrictionsSettings({
      trusted: ['npm *', 42, null, ''],
      denied: ['rm', undefined, '  sudo  '],
      permissionTimeoutSeconds: 300,
    });
    expect(result.trusted).toEqual(['npm *']);
    expect(result.denied).toEqual(['rm', 'sudo']);
  });

  it('clamps out-of-range permissionTimeoutSeconds', () => {
    expect(
      sanitizeBashRestrictionsSettings({ permissionTimeoutSeconds: 5 }).permissionTimeoutSeconds
    ).toBe(10);
    expect(
      sanitizeBashRestrictionsSettings({ permissionTimeoutSeconds: 9999 }).permissionTimeoutSeconds
    ).toBe(3600);
  });

  it('accepts permissionTimeoutSeconds of 0 as infinite (no timeout)', () => {
    expect(
      sanitizeBashRestrictionsSettings({ permissionTimeoutSeconds: 0 }).permissionTimeoutSeconds
    ).toBe(0);
  });

  it('falls back to 300 for invalid permissionTimeoutSeconds', () => {
    expect(
      sanitizeBashRestrictionsSettings({ permissionTimeoutSeconds: 'fast' })
        .permissionTimeoutSeconds
    ).toBe(300);
    expect(
      sanitizeBashRestrictionsSettings({ permissionTimeoutSeconds: null }).permissionTimeoutSeconds
    ).toBe(300);
  });

  // --- Output is always a complete canonical object ---

  it('always returns all three required fields', () => {
    const result = sanitizeBashRestrictionsSettings({});
    expect(result).toHaveProperty('trusted');
    expect(result).toHaveProperty('denied');
    expect(result).toHaveProperty('permissionTimeoutSeconds');
  });

  it('never throws on any input', () => {
    const inputs = [null, undefined, '', 0, false, [], {}, 'bad', Symbol('x'), () => {}];
    for (const input of inputs) {
      expect(() => sanitizeBashRestrictionsSettings(input)).not.toThrow();
    }
  });
});
