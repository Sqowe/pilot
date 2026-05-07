/**
 * Tests for scheduler v2 UI helper functions:
 * - parseBudgetField: numeric validation and conversion
 * - Config set fallback logic
 */
import { describe, expect, it } from 'vitest';
import { parseBudgetField, resolveConfigSetId } from '../src/renderer/utils/schedule-helpers';

describe('parseBudgetField', () => {
  describe('maxDurationMs (multiplier = 60000)', () => {
    const MINUTE_MS = 60_000;

    it('returns null for empty string', () => {
      expect(parseBudgetField('', MINUTE_MS)).toBeNull();
      expect(parseBudgetField('   ', MINUTE_MS)).toBeNull();
    });

    it('converts valid minutes to milliseconds', () => {
      expect(parseBudgetField('5', MINUTE_MS)).toBe(300_000);
      expect(parseBudgetField('1', MINUTE_MS)).toBe(60_000);
      expect(parseBudgetField('60', MINUTE_MS)).toBe(3_600_000);
    });

    it('handles decimal minutes', () => {
      expect(parseBudgetField('1.5', MINUTE_MS)).toBe(90_000);
      expect(parseBudgetField('0.5', MINUTE_MS)).toBe(30_000);
    });

    it('returns null for zero', () => {
      expect(parseBudgetField('0', MINUTE_MS)).toBeNull();
    });

    it('returns null for negative values', () => {
      expect(parseBudgetField('-5', MINUTE_MS)).toBeNull();
      expect(parseBudgetField('-0.1', MINUTE_MS)).toBeNull();
    });

    it('returns null for NaN inputs', () => {
      expect(parseBudgetField('abc', MINUTE_MS)).toBeNull();
      expect(parseBudgetField('-', MINUTE_MS)).toBeNull();
      expect(parseBudgetField('1e', MINUTE_MS)).toBeNull();
    });

    it('returns null for Infinity', () => {
      expect(parseBudgetField('Infinity', MINUTE_MS)).toBeNull();
      expect(parseBudgetField('1e309', MINUTE_MS)).toBeNull();
    });

    it('returns null for -Infinity', () => {
      expect(parseBudgetField('-Infinity', MINUTE_MS)).toBeNull();
    });
  });

  describe('maxTokens (multiplier = 1)', () => {
    it('returns null for empty string', () => {
      expect(parseBudgetField('', 1)).toBeNull();
    });

    it('converts valid token counts', () => {
      expect(parseBudgetField('50000', 1)).toBe(50_000);
      expect(parseBudgetField('1', 1)).toBe(1);
      expect(parseBudgetField('10000000', 1)).toBe(10_000_000);
    });

    it('rounds decimal token counts', () => {
      expect(parseBudgetField('50000.7', 1)).toBe(50_001);
    });

    it('returns null for zero and negative', () => {
      expect(parseBudgetField('0', 1)).toBeNull();
      expect(parseBudgetField('-100', 1)).toBeNull();
    });

    it('returns null for non-numeric', () => {
      expect(parseBudgetField('abc', 1)).toBeNull();
      expect(parseBudgetField('NaN', 1)).toBeNull();
    });
  });
});

describe('config set fallback logic', () => {
  it('returns the selected configSetId when it exists in available sets', () => {
    const sets = [
      { id: 'set-1', name: 'Set 1' },
      { id: 'set-2', name: 'Set 2' },
    ];
    expect(resolveConfigSetId('set-2', sets)).toBe('set-2');
  });

  it('returns null when selected is not found in non-empty sets', () => {
    const sets = [
      { id: 'set-1', name: 'Set 1' },
      { id: 'set-2', name: 'Set 2' },
    ];
    expect(resolveConfigSetId('deleted-set', sets)).toBeNull();
  });

  it('always allows "default" even when configSets is empty', () => {
    expect(resolveConfigSetId('default', [])).toBe('default');
  });

  it('always allows "default" even when not in configSets list', () => {
    const sets = [{ id: 'set-1', name: 'Set 1' }];
    expect(resolveConfigSetId('default', sets)).toBe('default');
  });

  it('allows any value when configSets is empty (not loaded yet)', () => {
    expect(resolveConfigSetId('my-custom-set', [])).toBe('my-custom-set');
  });

  it('returns "default" when selected is "default" and it exists', () => {
    const sets = [{ id: 'default', name: 'Default' }];
    expect(resolveConfigSetId('default', sets)).toBe('default');
  });
});
