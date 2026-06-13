/**
 * Tests for skill-conflict-types shared module.
 * Covers: normalizeSkillConflictConfig, validation helpers, default factory isolation.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeSkillConflictConfig,
  createDefaultSkillConflictConfig,
  DEFAULT_SKILL_CONFLICT_CONFIG,
  isValidConflictPolicy,
  isValidSkillSource,
} from '../src/shared/skill-conflict-types';

describe('skill-conflict-types', () => {
  describe('isValidConflictPolicy', () => {
    it('accepts valid policies', () => {
      expect(isValidConflictPolicy('custom-wins')).toBe(true);
      expect(isValidConflictPolicy('builtin-wins')).toBe(true);
      expect(isValidConflictPolicy('ask')).toBe(true);
    });

    it('rejects invalid values', () => {
      expect(isValidConflictPolicy('')).toBe(false);
      expect(isValidConflictPolicy('invalid')).toBe(false);
      expect(isValidConflictPolicy(null)).toBe(false);
      expect(isValidConflictPolicy(undefined)).toBe(false);
      expect(isValidConflictPolicy(42)).toBe(false);
    });
  });

  describe('isValidSkillSource', () => {
    it('accepts valid sources', () => {
      expect(isValidSkillSource('builtin')).toBe(true);
      expect(isValidSkillSource('user')).toBe(true);
      expect(isValidSkillSource('project')).toBe(true);
      expect(isValidSkillSource('configured')).toBe(true);
    });

    it('rejects invalid values', () => {
      expect(isValidSkillSource('')).toBe(false);
      expect(isValidSkillSource('custom')).toBe(false);
      expect(isValidSkillSource(null)).toBe(false);
      expect(isValidSkillSource(undefined)).toBe(false);
    });
  });

  describe('createDefaultSkillConflictConfig', () => {
    it('returns the expected default values', () => {
      const config = createDefaultSkillConflictConfig();
      expect(config.conflictPolicy).toBe('custom-wins');
      expect(config.disabledSkills).toEqual([]);
      expect(config.sourceOverrides).toEqual({});
      expect(config.acknowledgedConflicts).toEqual([]);
    });

    it('returns independent instances (no shared mutable references)', () => {
      const a = createDefaultSkillConflictConfig();
      const b = createDefaultSkillConflictConfig();
      a.disabledSkills.push('test-skill');
      a.sourceOverrides['pdf'] = 'user';
      a.acknowledgedConflicts.push('pdf');

      // b must not be affected
      expect(b.disabledSkills).toEqual([]);
      expect(b.sourceOverrides).toEqual({});
      expect(b.acknowledgedConflicts).toEqual([]);
    });

    it('does not share references with DEFAULT_SKILL_CONFLICT_CONFIG', () => {
      const config = createDefaultSkillConflictConfig();
      config.disabledSkills.push('mutated');
      expect(DEFAULT_SKILL_CONFLICT_CONFIG.disabledSkills).toEqual([]);
    });
  });

  describe('normalizeSkillConflictConfig', () => {
    it('returns fresh defaults for null/undefined/non-object input', () => {
      expect(normalizeSkillConflictConfig(null)).toEqual(createDefaultSkillConflictConfig());
      expect(normalizeSkillConflictConfig(undefined)).toEqual(createDefaultSkillConflictConfig());
      expect(normalizeSkillConflictConfig(42)).toEqual(createDefaultSkillConflictConfig());
      expect(normalizeSkillConflictConfig('string')).toEqual(createDefaultSkillConflictConfig());
    });

    it('returns fresh defaults for empty object', () => {
      const result = normalizeSkillConflictConfig({});
      expect(result.conflictPolicy).toBe('custom-wins');
      expect(result.disabledSkills).toEqual([]);
      expect(result.sourceOverrides).toEqual({});
      expect(result.acknowledgedConflicts).toEqual([]);
    });

    it('preserves valid conflictPolicy', () => {
      expect(normalizeSkillConflictConfig({ conflictPolicy: 'builtin-wins' }).conflictPolicy).toBe(
        'builtin-wins'
      );
      expect(normalizeSkillConflictConfig({ conflictPolicy: 'ask' }).conflictPolicy).toBe('ask');
    });

    it('falls back to custom-wins for invalid policy', () => {
      expect(normalizeSkillConflictConfig({ conflictPolicy: 'invalid' }).conflictPolicy).toBe(
        'custom-wins'
      );
      expect(normalizeSkillConflictConfig({ conflictPolicy: 123 }).conflictPolicy).toBe(
        'custom-wins'
      );
    });

    it('preserves valid disabledSkills strings', () => {
      const result = normalizeSkillConflictConfig({
        disabledSkills: ['pdf', 'xlsx', 'docx'],
      });
      expect(result.disabledSkills).toEqual(['pdf', 'xlsx', 'docx']);
    });

    it('filters non-string and invalid skill ID entries from disabledSkills', () => {
      const result = normalizeSkillConflictConfig({
        disabledSkills: ['valid', 42, null, undefined, 'also-valid', {}, 'has spaces', '../escape'],
      });
      expect(result.disabledSkills).toEqual(['valid', 'also-valid']);
    });

    it('deduplicates disabledSkills', () => {
      const result = normalizeSkillConflictConfig({
        disabledSkills: ['pdf', 'xlsx', 'pdf', 'xlsx', 'docx'],
      });
      expect(result.disabledSkills).toEqual(['pdf', 'xlsx', 'docx']);
    });

    it('returns empty array for non-array disabledSkills', () => {
      expect(normalizeSkillConflictConfig({ disabledSkills: 'not-array' }).disabledSkills).toEqual(
        []
      );
      expect(normalizeSkillConflictConfig({ disabledSkills: 42 }).disabledSkills).toEqual([]);
    });

    it('preserves valid sourceOverrides', () => {
      const result = normalizeSkillConflictConfig({
        sourceOverrides: { pdf: 'user', xlsx: 'builtin', myskill: 'project' },
      });
      expect(result.sourceOverrides).toEqual({ pdf: 'user', xlsx: 'builtin', myskill: 'project' });
    });

    it('filters invalid source values and invalid keys from sourceOverrides', () => {
      const result = normalizeSkillConflictConfig({
        sourceOverrides: { valid: 'user', invalid: 'bogus', another: 42, 'has spaces': 'user' },
      });
      expect(result.sourceOverrides).toEqual({ valid: 'user' });
    });

    it('returns empty object for non-object sourceOverrides', () => {
      expect(normalizeSkillConflictConfig({ sourceOverrides: 'string' }).sourceOverrides).toEqual(
        {}
      );
      expect(normalizeSkillConflictConfig({ sourceOverrides: null }).sourceOverrides).toEqual({});
    });

    it('preserves valid acknowledgedConflicts', () => {
      const result = normalizeSkillConflictConfig({
        acknowledgedConflicts: ['pdf', 'xlsx'],
      });
      expect(result.acknowledgedConflicts).toEqual(['pdf', 'xlsx']);
    });

    it('filters non-string and invalid skill ID entries from acknowledgedConflicts', () => {
      const result = normalizeSkillConflictConfig({
        acknowledgedConflicts: ['valid', 123, null, 'also-valid', 'has spaces'],
      });
      expect(result.acknowledgedConflicts).toEqual(['valid', 'also-valid']);
    });

    it('returns independent arrays (not shared with input)', () => {
      const input = {
        disabledSkills: ['pdf'],
        acknowledgedConflicts: ['xlsx'],
      };
      const result = normalizeSkillConflictConfig(input);
      result.disabledSkills.push('mutated');
      result.acknowledgedConflicts.push('mutated');
      expect(input.disabledSkills).toEqual(['pdf']);
      expect(input.acknowledgedConflicts).toEqual(['xlsx']);
    });

    it('multiple calls return independent instances', () => {
      const a = normalizeSkillConflictConfig({});
      const b = normalizeSkillConflictConfig({});
      a.disabledSkills.push('only-in-a');
      expect(b.disabledSkills).toEqual([]);
    });

    it('handles a complete valid config without modification', () => {
      const input = {
        conflictPolicy: 'ask',
        disabledSkills: ['skill-a', 'skill-b'],
        sourceOverrides: { 'skill-a': 'user', 'skill-b': 'configured' },
        acknowledgedConflicts: ['skill-a'],
      };
      const result = normalizeSkillConflictConfig(input);
      expect(result).toEqual(input);
    });

    it('caps arrays and overrides at 200 entries', () => {
      const manySkills = Array.from({ length: 250 }, (_, i) => `skill-${i}`);
      const manyOverrides: Record<string, string> = {};
      for (let i = 0; i < 250; i++) {
        manyOverrides[`skill-${i}`] = 'user';
      }
      const result = normalizeSkillConflictConfig({
        disabledSkills: manySkills,
        acknowledgedConflicts: manySkills,
        sourceOverrides: manyOverrides,
      });
      expect(result.disabledSkills.length).toBe(200);
      expect(result.acknowledgedConflicts.length).toBe(200);
      expect(Object.keys(result.sourceOverrides).length).toBe(200);
    });
  });
});
