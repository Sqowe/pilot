import { describe, expect, it } from 'vitest';
import {
  resolveThinkingCapabilities,
  resolvePiRegistryModel,
} from '../src/main/claude/pi-model-resolution';

/**
 * Runs against the REAL pi-ai registry (no mocks) — the whole point is verifying
 * behaviour against pi's own model tables. If pi drops or renames one of the
 * models named here, these tests should be updated to a current equivalent
 * rather than mocked away.
 *
 * Context: a model reached through provider:"custom" never resolves to a registry
 * entry, so it falls back to a synthetic model that guesses `reasoning` from
 * REASONING_MODEL_PATTERN. Models pi knows about under a provider outside
 * COMMON_FALLBACK_PROVIDERS (openai/anthropic/google) were therefore reported as
 * having no reasoning support at all, and the Settings panel stated as fact that
 * the model "does not support adjustable reasoning".
 */
describe('reasoning traits borrowed from the registry (custom endpoints)', () => {
  const customOpts = {
    configProvider: 'openai',
    rawProvider: 'custom',
    customProtocol: 'openai',
    customBaseUrl: 'http://127.0.0.1:9000/v1',
  };

  it('detects reasoning for a model pi knows under a non-fallback provider', () => {
    // MiniMax-M3 lives under `minimax`, which was never searched.
    const caps = resolveThinkingCapabilities('MiniMax-M3', customOpts);
    expect(caps.supportsThinking).toBe(true);
    expect(caps.levels).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  it('detects reasoning for a slash-prefixed model id', () => {
    const caps = resolveThinkingCapabilities('z-ai/glm-5.1', customOpts);
    expect(caps.supportsThinking).toBe(true);
  });

  it('does not borrow xhigh/max from an unrelated provider', () => {
    // claude-opus-4.8 exists only under github-copilot, whose thinkingLevelMap
    // exposes xhigh/max. That donor is not the endpoint being called, and pi
    // gates those levels behind explicit per-vendor mapping — so we take the
    // reasoning flag and let getSupportedThinkingLevels yield the safe default.
    const caps = resolveThinkingCapabilities('claude-opus-4.8', customOpts);
    expect(caps.supportsThinking).toBe(true);
    expect(caps.levels).not.toContain('xhigh');
    expect(caps.levels).not.toContain('max');
  });

  it('leaves genuinely non-reasoning models alone', () => {
    for (const model of ['llama3.1:8b', 'qwen2.5-coder:7b', 'not-a-real-model-xyz']) {
      const caps = resolveThinkingCapabilities(model, customOpts);
      expect(caps.supportsThinking).toBe(false);
      expect(caps.levels).toEqual(['off']);
    }
  });

  it('does not change which registry entry a model resolves to', () => {
    // Guard against the rejected design: adopting a foreign provider's entry
    // wholesale would import its transport, compat quirks, pricing and context
    // limits for an endpoint the user is not calling.
    expect(resolvePiRegistryModel('MiniMax-M3', customOpts)).toBeUndefined();
    expect(resolvePiRegistryModel('claude-opus-4.8', customOpts)).toBeUndefined();
    expect(resolvePiRegistryModel('claude-sonnet-4-5', customOpts)?.provider).toBe('anthropic');
  });
});
