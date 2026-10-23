/**
 * The curated model picks, checked against the provider catalogue of the
 * **installed** pi.
 *
 * Why this test reads the installed pi
 * ------------------------------------
 * A curated pick that pi's catalogue does not have is a model id the app
 * offers that no catalogue knows: it cannot be resolved to a model, so it has
 * no context window, no price and no thinking levels, and the picker lists it
 * next to models that do. The curated lists are hand-written, so they drift —
 * `claude-3-7-sonnet-latest` sat in the Anthropic list for two pi releases
 * after Anthropic's catalogue had dropped it.
 *
 * `tests/api-model-presets-guard.test.ts` compares the two hand-written lists
 * with each other, which cannot catch this: both carried the stale id. This
 * one compares them with the truth.
 *
 * When it fails
 * -------------
 * Nothing is broken yet. The pick is either gone from pi's catalogue — drop it
 * from both hand-written lists — or the list is stale in the other direction
 * and should grow. A pick is the app's short, ordered list of what to offer
 * first; it is not the catalogue, which the picker shows in full.
 *
 * Last checked against pi-ai 1.4.0 (2026-10-23).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PI_AI_CURATED_PRESETS } from '../src/shared/api-model-presets';

interface RegistryModel {
  id: string;
}

describe('the curated model picks, against the catalogue of the installed pi', () => {
  let catalogueByProvider: Map<string, Set<string>>;

  beforeAll(async () => {
    const compat = (await import('@earendil-works/pi-ai/compat')) as {
      getModels: (provider: string) => RegistryModel[] | undefined;
    };
    catalogueByProvider = new Map();
    for (const provider of new Set(Object.values(PI_AI_CURATED_PRESETS).map((c) => c.piProvider))) {
      const ids = new Set((compat.getModels(provider) ?? []).map((m) => m.id));
      catalogueByProvider.set(provider, ids);
    }
  });

  it('reads a catalogue that has the models the curated lists name', () => {
    // A guard for the test itself: an empty registry would make every list
    // below empty, and "nothing is missing" would pass for no reason.
    expect(catalogueByProvider.get('anthropic')?.size).toBeGreaterThan(0);
    expect(catalogueByProvider.get('openrouter')?.size).toBeGreaterThan(0);
  });

  it('every curated pick exists in the catalogue of its pi provider', () => {
    for (const [providerKey, curated] of Object.entries(PI_AI_CURATED_PRESETS)) {
      const ids = catalogueByProvider.get(curated.piProvider) ?? new Set<string>();
      for (const id of curated.pick) {
        expect(
          ids.has(id),
          `Curated pick "${id}" in PI_AI_CURATED_PRESETS.${providerKey} is not in the ` +
            `installed pi's catalogue for "${curated.piProvider}". Either drop it from the ` +
            `curated list and from API_PROVIDER_PRESETS, or the catalogue is stale.`
        ).toBe(true);
      }
    }
  });
});
