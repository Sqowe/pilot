import { describe, expect, it } from 'vitest';
import { API_PROVIDER_PRESETS, PI_AI_CURATED_PRESETS } from '../src/shared/api-model-presets';

/**
 * Guard tests ensuring curated pick lists stay in sync with provider presets.
 *
 * These tests prevent typo model IDs and naming-convention drift from silently
 * shipping. Each curated pick that references an OC builtin provider must also
 * exist in the corresponding API_PROVIDER_PRESETS model list.
 *
 * Note: OpenRouter uses dot-separated IDs (anthropic/claude-opus-4.8) while
 * Anthropic native uses dash-separated IDs (claude-opus-4-8). Both formats are
 * intentional and correct for their respective providers.
 */

// Map of PI_AI_CURATED_PRESETS key → API_PROVIDER_PRESETS key
// Only entries that have a direct counterpart in FALLBACK_PROVIDER_PRESETS.
const CURATED_TO_PRESET_KEY: Record<string, keyof typeof API_PROVIDER_PRESETS> = {
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
};

describe('curated model picks', () => {
  it('every curated pick for a builtin provider exists in the corresponding preset model list', () => {
    for (const [curatedKey, presetKey] of Object.entries(CURATED_TO_PRESET_KEY)) {
      const curated = PI_AI_CURATED_PRESETS[curatedKey];
      if (!curated) continue;

      const preset = API_PROVIDER_PRESETS[presetKey];
      const presetIds = new Set(preset.models.map((m) => m.id));

      for (const modelId of curated.pick) {
        expect(
          presetIds.has(modelId),
          `Curated pick "${modelId}" in PI_AI_CURATED_PRESETS.${curatedKey} ` +
            `is missing from API_PROVIDER_PRESETS.${presetKey}.models. ` +
            `Either add it to the preset or remove it from the curated list.`
        ).toBe(true);
      }
    }
  });

  it('API_PROVIDER_PRESETS and PI_AI_CURATED_PRESETS have consistent model counts for builtin providers', () => {
    for (const [curatedKey, presetKey] of Object.entries(CURATED_TO_PRESET_KEY)) {
      const curated = PI_AI_CURATED_PRESETS[curatedKey];
      if (!curated) continue;

      const preset = API_PROVIDER_PRESETS[presetKey];
      // Curated pick should not have more models than the preset list
      expect(curated.pick.length).toBeLessThanOrEqual(preset.models.length);
    }
  });

  it('curated picks have no duplicates', () => {
    for (const [curatedKey, curated] of Object.entries(PI_AI_CURATED_PRESETS)) {
      const seen = new Set<string>();
      for (const id of curated.pick) {
        expect(
          seen.has(id),
          `Duplicate model ID "${id}" in PI_AI_CURATED_PRESETS.${curatedKey}`
        ).toBe(false);
        seen.add(id);
      }
    }
  });
});
