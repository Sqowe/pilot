import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYSTEM_PROMPT_PRIORITY,
  isValidSystemPromptPriority,
  normalizeSystemPromptPriority,
  isValidSystemPromptFileChoice,
} from '../src/shared/system-prompt-file-choices';

describe('isValidSystemPromptPriority', () => {
  it('accepts a full permutation', () => {
    expect(isValidSystemPromptPriority([...DEFAULT_SYSTEM_PROMPT_PRIORITY])).toBe(true);
  });

  it('accepts a valid subset (not all candidates required)', () => {
    expect(isValidSystemPromptPriority(['CLAUDE.md', 'AGENTS.md'])).toBe(true);
  });

  it('accepts a single whitelisted entry', () => {
    expect(isValidSystemPromptPriority(['memory.md'])).toBe(true);
  });

  it('rejects an empty array', () => {
    expect(isValidSystemPromptPriority([])).toBe(false);
  });

  it('rejects a non-array', () => {
    expect(isValidSystemPromptPriority('CLAUDE.md')).toBe(false);
    expect(isValidSystemPromptPriority(null)).toBe(false);
    expect(isValidSystemPromptPriority(undefined)).toBe(false);
    expect(isValidSystemPromptPriority(42)).toBe(false);
  });

  it('rejects unknown filenames', () => {
    expect(isValidSystemPromptPriority(['README.md'])).toBe(false);
    expect(isValidSystemPromptPriority(['CLAUDE.md', 'UNKNOWN.md'])).toBe(false);
  });

  it('rejects duplicates', () => {
    expect(isValidSystemPromptPriority(['CLAUDE.md', 'CLAUDE.md'])).toBe(false);
  });

  it('rejects non-string elements', () => {
    expect(isValidSystemPromptPriority([42, 'CLAUDE.md'])).toBe(false);
  });
});

describe('normalizeSystemPromptPriority', () => {
  it('returns a full permutation for a valid full permutation', () => {
    const input = [...DEFAULT_SYSTEM_PROMPT_PRIORITY];
    expect(normalizeSystemPromptPriority(input)).toEqual(input);
  });

  it('backfills missing entries at the end in default order', () => {
    const result = normalizeSystemPromptPriority(['AGENTS.md', 'CLAUDE.md']);
    // AGENTS.md and CLAUDE.md come first (in user order), then the rest in default order
    expect(result[0]).toBe('AGENTS.md');
    expect(result[1]).toBe('CLAUDE.md');
    expect(result).toHaveLength(DEFAULT_SYSTEM_PROMPT_PRIORITY.length);
    // All default candidates must be present exactly once
    for (const c of DEFAULT_SYSTEM_PROMPT_PRIORITY) {
      expect(result.filter((x) => x === c)).toHaveLength(1);
    }
  });

  it('hoists a single entry to position 0 and backfills the rest', () => {
    const result = normalizeSystemPromptPriority(['memory.md']);
    expect(result[0]).toBe('memory.md');
    expect(result).toHaveLength(DEFAULT_SYSTEM_PROMPT_PRIORITY.length);
  });

  it('deduplicates entries', () => {
    const result = normalizeSystemPromptPriority(['CLAUDE.md', 'CLAUDE.md', 'AGENTS.md']);
    expect(result.filter((x) => x === 'CLAUDE.md')).toHaveLength(1);
    expect(result.filter((x) => x === 'AGENTS.md')).toHaveLength(1);
  });

  it('drops unknown/off-whitelist entries', () => {
    const result = normalizeSystemPromptPriority(['CLAUDE.md', 'README.md', 'AGENTS.md']);
    expect(result).not.toContain('README.md');
    expect(result[0]).toBe('CLAUDE.md');
    expect(result[1]).toBe('AGENTS.md');
  });

  it('handles non-array input by returning the full default order', () => {
    const defaultOrder = [...DEFAULT_SYSTEM_PROMPT_PRIORITY];
    expect(normalizeSystemPromptPriority(null)).toEqual(defaultOrder);
    expect(normalizeSystemPromptPriority(undefined)).toEqual(defaultOrder);
    expect(normalizeSystemPromptPriority('CLAUDE.md')).toEqual(defaultOrder);
    expect(normalizeSystemPromptPriority(42)).toEqual(defaultOrder);
  });

  it('handles an empty array by returning the full default order', () => {
    expect(normalizeSystemPromptPriority([])).toEqual([...DEFAULT_SYSTEM_PROMPT_PRIORITY]);
  });

  it('result always has exactly DEFAULT_SYSTEM_PROMPT_PRIORITY.length entries', () => {
    const cases = [
      ['CLAUDE.md'],
      ['AGENTS.md', 'CLAUDE.md'],
      [...DEFAULT_SYSTEM_PROMPT_PRIORITY].reverse(),
      [],
      null,
      ['UNKNOWN.md'],
    ];
    for (const input of cases) {
      expect(normalizeSystemPromptPriority(input)).toHaveLength(
        DEFAULT_SYSTEM_PROMPT_PRIORITY.length
      );
    }
  });
});

describe('isValidSystemPromptFileChoice (legacy, kept for migration)', () => {
  it('accepts the empty string sentinel', () => {
    expect(isValidSystemPromptFileChoice('')).toBe(true);
  });

  it('accepts all whitelisted filenames', () => {
    for (const name of DEFAULT_SYSTEM_PROMPT_PRIORITY) {
      expect(isValidSystemPromptFileChoice(name)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isValidSystemPromptFileChoice('README.md')).toBe(false);
    expect(isValidSystemPromptFileChoice(null)).toBe(false);
  });
});
