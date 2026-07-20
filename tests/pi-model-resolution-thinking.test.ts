import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelThinkingLevel } from '../src/renderer/types';

// Mock the pi-ai/compat module so tests don't depend on external registry state.
// We control model shapes explicitly.
const mockGetModel = vi.fn();
const mockGetSupportedThinkingLevels = vi.fn();
const mockClampThinkingLevel = vi.fn();

vi.mock('@earendil-works/pi-ai/compat', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
  getModels: vi.fn(() => []),
  getSupportedThinkingLevels: (...args: unknown[]) => mockGetSupportedThinkingLevels(...args),
  clampThinkingLevel: (...args: unknown[]) => mockClampThinkingLevel(...args),
}));

// Also mock the registry lookup used inside pi-model-resolution
vi.mock('@earendil-works/pi-ai', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
}));

import {
  resolveThinkingCapabilities,
  clampModelThinkingLevel,
} from '../src/main/claude/pi-model-resolution';

function makeModel(reasoning: boolean, levels?: string[]) {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16000,
    thinkingLevelMap: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: getSupportedThinkingLevels returns standard set
  mockGetSupportedThinkingLevels.mockReturnValue(['off', 'minimal', 'low', 'medium', 'high']);
  mockClampThinkingLevel.mockImplementation((_model: unknown, level: string) => level);
});

describe('resolveThinkingCapabilities', () => {
  it('always includes off in levels', () => {
    mockGetModel.mockReturnValue(makeModel(true));
    const caps = resolveThinkingCapabilities('test-model', { rawProvider: 'anthropic' });
    expect(caps.levels).toContain('off');
  });

  it('returns supportsThinking:false for non-reasoning registry model', () => {
    mockGetModel.mockReturnValue(makeModel(false));
    const caps = resolveThinkingCapabilities('test-model', { rawProvider: 'anthropic' });
    expect(caps.supportsThinking).toBe(false);
    expect(caps.levels).toEqual(['off']);
  });

  it('returns supportsThinking:true for reasoning registry model', () => {
    mockGetModel.mockReturnValue(makeModel(true));
    const caps = resolveThinkingCapabilities('test-model', { rawProvider: 'anthropic' });
    expect(caps.supportsThinking).toBe(true);
    expect(caps.levels.length).toBeGreaterThan(1);
  });

  it('returns supportsThinking:false when all pi-ai levels are unknown/filtered out', () => {
    mockGetModel.mockReturnValue(makeModel(true));
    // pi-ai returns only unknown future levels
    mockGetSupportedThinkingLevels.mockReturnValue(['ultra', 'super-max']);
    const caps = resolveThinkingCapabilities('test-model', { rawProvider: 'anthropic' });
    expect(caps.supportsThinking).toBe(false);
    expect(caps.levels).toEqual(['off']);
  });

  it('handles registry miss (synthetic fallback) for non-reasoning model', () => {
    mockGetModel.mockReturnValue(undefined);
    // Non-reasoning pattern model
    const caps = resolveThinkingCapabilities('gpt-4o', { rawProvider: 'openai' });
    expect(caps.levels).toContain('off');
  });

  it('handles registry miss for reasoning-pattern model (ollama)', () => {
    mockGetModel.mockReturnValue(undefined);
    mockGetSupportedThinkingLevels.mockReturnValue(['off', 'low', 'medium', 'high']);
    // deepseek-r1 matches REASONING_MODEL_PATTERN
    const caps = resolveThinkingCapabilities('deepseek-r1', {
      rawProvider: 'ollama',
      configProvider: 'ollama',
    });
    // Either supports thinking (pattern matched) or doesn't — must not throw
    expect(caps.levels).toContain('off');
  });

  it('never throws on garbage input', () => {
    mockGetModel.mockReturnValue(undefined);
    expect(() => resolveThinkingCapabilities('!!@@##$$', { rawProvider: 'custom' })).not.toThrow();
  });

  it('never throws on empty model string', () => {
    mockGetModel.mockReturnValue(undefined);
    expect(() => resolveThinkingCapabilities('', {})).not.toThrow();
  });

  it('returns safe fallback when compat throws', () => {
    mockGetModel.mockReturnValue(makeModel(true));
    mockGetSupportedThinkingLevels.mockImplementation(() => {
      throw new Error('compat error');
    });
    const caps = resolveThinkingCapabilities('test-model', { rawProvider: 'anthropic' });
    expect(caps.supportsThinking).toBe(false);
    expect(caps.levels).toEqual(['off']);
  });
});

describe('clampModelThinkingLevel', () => {
  it('clamps to off for non-reasoning registry model', () => {
    mockGetModel.mockReturnValue(makeModel(false));
    mockClampThinkingLevel.mockReturnValue('off');
    const level = clampModelThinkingLevel('test-model', 'high', { rawProvider: 'anthropic' });
    expect(level).toBe('off');
  });

  it('preserves valid level for reasoning model', () => {
    mockGetModel.mockReturnValue(makeModel(true));
    mockClampThinkingLevel.mockReturnValue('medium');
    const level = clampModelThinkingLevel('test-model', 'medium', { rawProvider: 'anthropic' });
    expect(level).toBe('medium');
  });

  it('returns off for non-reasoning model even when compat returns non-off', () => {
    mockGetModel.mockReturnValue(makeModel(false));
    mockClampThinkingLevel.mockReturnValue('high'); // compat misbehaves
    expect(clampModelThinkingLevel('test-model', 'high', { rawProvider: 'anthropic' })).toBe('off');
  });

  it('returns off for synthetic non-reasoning model even when compat returns non-off', () => {
    mockGetModel.mockReturnValue(undefined); // registry miss
    mockClampThinkingLevel.mockReturnValue('medium'); // compat misbehaves
    // gpt-4o does not match REASONING_MODEL_PATTERN
    expect(clampModelThinkingLevel('gpt-4o', 'medium', { rawProvider: 'openai' })).toBe('off');
  });

  it('returns off when compat throws', () => {
    mockGetModel.mockReturnValue(makeModel(true));
    mockClampThinkingLevel.mockImplementation(() => {
      throw new Error('compat error');
    });
    const level = clampModelThinkingLevel('test-model', 'high', { rawProvider: 'anthropic' });
    expect(level).toBe('off');
  });

  it('guards unknown return value from compat', () => {
    mockGetModel.mockReturnValue(makeModel(true));
    mockClampThinkingLevel.mockReturnValue('future-unknown-level');
    const level = clampModelThinkingLevel('test-model', 'high', { rawProvider: 'anthropic' });
    expect(level).toBe('off');
  });
});
