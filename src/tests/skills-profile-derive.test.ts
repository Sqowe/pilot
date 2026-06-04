import { describe, it, expect } from 'vitest';
import { isSkillsProfileDirty } from '../renderer/utils/skills-profile-derive';
import type { SkillsWorkspaceProfile } from '../shared/skill-conflict-types';

describe('isSkillsProfileDirty', () => {
  it('returns false when session state matches a null profile (both empty)', () => {
    expect(isSkillsProfileDirty(new Set(), new Set(), null)).toBe(false);
  });

  it('returns false when session state matches profile exactly', () => {
    const profile: SkillsWorkspaceProfile = {
      pinned: ['a', 'b'],
      disabled: ['c', 'd'],
    };
    expect(isSkillsProfileDirty(new Set(['a', 'b']), new Set(['c', 'd']), profile)).toBe(false);
  });

  it('returns false with order-insensitive comparison', () => {
    const profile: SkillsWorkspaceProfile = {
      pinned: ['b', 'a'],
      disabled: ['d', 'c'],
    };
    expect(isSkillsProfileDirty(new Set(['a', 'b']), new Set(['c', 'd']), profile)).toBe(false);
  });

  it('returns true when pinned differs from profile', () => {
    const profile: SkillsWorkspaceProfile = {
      pinned: ['a'],
      disabled: [],
    };
    expect(isSkillsProfileDirty(new Set(['a', 'b']), new Set(), profile)).toBe(true);
  });

  it('returns true when disabled differs from profile', () => {
    const profile: SkillsWorkspaceProfile = {
      pinned: [],
      disabled: ['c'],
    };
    expect(isSkillsProfileDirty(new Set(), new Set(['c', 'd']), profile)).toBe(true);
  });

  it('returns true when session has pinned but profile is null', () => {
    expect(isSkillsProfileDirty(new Set(['a']), new Set(), null)).toBe(true);
  });

  it('returns true when session has disabled but profile is null', () => {
    expect(isSkillsProfileDirty(new Set(), new Set(['x']), null)).toBe(true);
  });

  it('returns true when profile has pinned but session does not', () => {
    const profile: SkillsWorkspaceProfile = { pinned: ['a'], disabled: [] };
    expect(isSkillsProfileDirty(new Set(), new Set(), profile)).toBe(true);
  });

  it('returns true when profile has disabled but session does not', () => {
    const profile: SkillsWorkspaceProfile = { pinned: [], disabled: ['x'] };
    expect(isSkillsProfileDirty(new Set(), new Set(), profile)).toBe(true);
  });

  it('handles profile with undefined pinned/disabled (treated as empty)', () => {
    const profile: SkillsWorkspaceProfile = {};
    expect(isSkillsProfileDirty(new Set(), new Set(), profile)).toBe(false);
  });

  it('handles profile with only pinned defined', () => {
    const profile: SkillsWorkspaceProfile = { pinned: ['a'] };
    expect(isSkillsProfileDirty(new Set(['a']), new Set(), profile)).toBe(false);
  });

  it('handles profile with only disabled defined', () => {
    const profile: SkillsWorkspaceProfile = { disabled: ['x'] };
    expect(isSkillsProfileDirty(new Set(), new Set(['x']), profile)).toBe(false);
  });

  it('returns true for both pinned and disabled changes simultaneously', () => {
    const profile: SkillsWorkspaceProfile = { pinned: ['a'], disabled: ['x'] };
    expect(isSkillsProfileDirty(new Set(['b']), new Set(['y']), profile)).toBe(true);
  });

  it('returns false for empty sets vs empty arrays in profile', () => {
    const profile: SkillsWorkspaceProfile = { pinned: [], disabled: [] };
    expect(isSkillsProfileDirty(new Set(), new Set(), profile)).toBe(false);
  });

  it('normalizes pinned by excluding disabled IDs before comparison', () => {
    // Session has 'a' pinned AND disabled — effective pinned is empty
    const profile: SkillsWorkspaceProfile = { pinned: [], disabled: ['a'] };
    expect(isSkillsProfileDirty(new Set(['a']), new Set(['a']), profile)).toBe(false);
  });

  it('detects dirty when normalized pinned differs from profile', () => {
    // Session has 'a' pinned + 'a' disabled → effective pinned is empty, but profile has 'a' pinned
    const profile: SkillsWorkspaceProfile = { pinned: ['a'], disabled: ['a'] };
    expect(isSkillsProfileDirty(new Set(['a']), new Set(['a']), profile)).toBe(true);
  });
});
