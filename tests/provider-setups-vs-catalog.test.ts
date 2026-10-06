/**
 * The ready-made setups for a custom endpoint, checked against the provider
 * catalog of the **installed** pi.
 *
 * Why this test reads the installed pi
 * ------------------------------------
 * The rest of the suite stands in for pi's provider data, so that no test
 * depends on what a library happens to ship. This one depends on it on purpose.
 *
 * The setups list (`COMMON_PROVIDER_SETUPS`) is older than the catalog, and the
 * catalog is built from pi and grows with every version. A service that has a
 * setup today can be a catalog provider tomorrow. A custom endpoint made from
 * its setup is then that provider under another name, holding a second copy of
 * its key — the thing the split into Providers and Model Sets set out to end.
 * Nothing in the app would notice: the setup still fills a form, the endpoint
 * still works.
 *
 * So the rule "re-check the setups against the catalog on every pi uplift"
 * (AI_MAIN_PROCESS.md §1, "Ready-made setups and the catalog") is this test.
 * `FOUND_IN_THE_CATALOG` is what the catalog said when the setups were last
 * checked; `SENT_TO_THE_CATALOG` is what was decided on the strength of it.
 *
 * When it fails after an uplift
 * -----------------------------
 * Nothing is broken yet. Read what changed in the first table, decide again
 * for each setup it touches whether its address is now a catalog provider's
 * own (same service, same protocol), set or clear `catalogProvider` in
 * `src/shared/api-provider-guidance.ts`, and bring both tables up to date.
 *
 * Last checked against pi-ai 0.87.1 (2026-10-06).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  catalogProviderOfSetup,
  COMMON_PROVIDER_SETUPS,
} from '../src/shared/api-provider-guidance';
import { BUILTIN_ENTRIES } from '../src/shared/provider-catalog';
import { buildNativeEntries } from '../src/main/config/provider-catalog-native';

const RECHECK =
  'The provider catalog of the installed pi no longer matches what the ready-made setups were ' +
  'last checked against. Nothing is broken yet — see the note at the top of this file, and ' +
  'AI_MAIN_PROCESS.md §1 "Ready-made setups and the catalog".';

/**
 * For each setup that names a real service: every catalog provider that serves
 * from the same host, with the protocol and address pi gives it.
 *
 * An empty list means no catalog provider uses that host. Ollama's is empty by
 * nature — it runs on the user's own computer and pi has no data for it.
 */
const FOUND_IN_THE_CATALOG: Record<string, string[]> = {
  openrouter: [
    'openrouter | anthropic-messages | https://openrouter.ai/api',
    'openrouter | openai-completions | https://openrouter.ai/api/v1',
  ],
  deepseek: ['deepseek | openai-completions | https://api.deepseek.com'],
  'kimi-coding': ['kimi-coding | anthropic-messages | https://api.kimi.com/coding'],
  'glm-anthropic': [
    'zai-coding-cn | openai-completions | https://open.bigmodel.cn/api/coding/paas/v4',
  ],
  ollama: [],
  'gemini-custom': [
    'gemini | google-generative-ai | https://generativelanguage.googleapis.com/v1beta',
  ],
  minimax: [],
};

/**
 * What was decided for each setup: the catalog provider its address is sent to
 * on the Providers tab, or null to leave it a custom endpoint.
 */
const SENT_TO_THE_CATALOG: Record<string, string | null> = {
  // The setup's address is the provider's own, in the provider's own protocol.
  openrouter: 'openrouter',
  ollama: 'ollama',
  'gemini-custom': 'gemini',
  'kimi-coding': 'kimi-coding',

  // The same service and protocol as the catalog's `deepseek`, at an address
  // that differs by `/v1`. Left a custom setup — decided 2026-10-06, and the
  // first one to look at again.
  deepseek: null,
  // The Anthropic route of a host whose catalog provider speaks the OpenAI
  // protocol on another path: a different way in, not the same entry.
  'glm-anthropic': null,
  // No catalog provider serves from api.minimax.chat; the catalog's MiniMax
  // entries are other hosts and another protocol.
  minimax: null,
  // Not a service at all: an example of the shape an address takes.
  'generic-openai': null,
};

interface RegistryModel {
  api?: string;
  baseUrl?: string;
}

function hostOf(address: string): string | null {
  try {
    return new URL(address).host;
  } catch {
    return null;
  }
}

describe('the ready-made setups, against the catalog of the installed pi', () => {
  /** Catalog provider id → the lines `id | protocol | address` pi gives it. */
  const served = new Map<string, Set<string>>();
  const catalogIds = new Set<string>();

  beforeAll(async () => {
    const compat = (await import('@earendil-works/pi-ai/compat')) as {
      getProviders: () => string[];
      getModels: (provider: string) => RegistryModel[] | undefined;
    };
    // The catalog as the app builds it from this pi: the native providers by
    // the app's own rule for which to list, and the builtin ones.
    const native = await buildNativeEntries({
      getProviders: compat.getProviders,
      getModels: (provider) =>
        (compat.getModels(provider) ?? []) as Array<{ id: string; name: string; api?: string }>,
    });
    for (const entry of [...BUILTIN_ENTRIES, ...native]) {
      catalogIds.add(entry.id);
      const lines = new Set<string>();
      // `custom` is the user's own endpoint and Ollama is local: pi has no
      // address for either.
      if (entry.id !== 'custom' && entry.id !== 'ollama') {
        for (const model of compat.getModels(entry.piProvider) ?? []) {
          if (model.baseUrl) {
            lines.add(`${entry.id} | ${model.api} | ${model.baseUrl}`);
          }
        }
      }
      served.set(entry.id, lines);
    }
  });

  /** Every catalog provider serving from the host of the given address. */
  function onTheSameHost(address: string): string[] {
    const host = hostOf(address);
    return [...served.values()]
      .flatMap((lines) => [...lines])
      .filter((line) => hostOf(line.split(' | ')[2]) === host)
      .sort();
  }

  it('reads a catalog that has the providers the app lists', () => {
    // A guard for the test itself: an empty registry would make every list
    // below empty, and "nothing shares a host" would pass for no reason.
    expect(catalogIds.size).toBeGreaterThan(BUILTIN_ENTRIES.length);
    expect(served.get('openrouter')?.size).toBeGreaterThan(0);
  });

  it('finds the same catalog providers on each setup’s host as when it was last checked', () => {
    const found: Record<string, string[]> = {};
    for (const setup of COMMON_PROVIDER_SETUPS) {
      // A setup with nothing to recognise an address by names no service.
      if (setup.matcher) {
        found[setup.id] = onTheSameHost(setup.recommendedBaseUrl);
      }
    }

    expect(found, RECHECK).toEqual(FOUND_IN_THE_CATALOG);
  });

  it('has a decision for every setup, and the data says the same', () => {
    expect(COMMON_PROVIDER_SETUPS.map((setup) => setup.id).sort()).toEqual(
      Object.keys(SENT_TO_THE_CATALOG).sort()
    );
    for (const setup of COMMON_PROVIDER_SETUPS) {
      expect(catalogProviderOfSetup(setup), setup.id).toBe(SENT_TO_THE_CATALOG[setup.id]);
    }
  });

  it('sends an address only to a provider the catalog still has', () => {
    // A provider pi drops, or renames, leaves a hint that points at nothing.
    for (const [setupId, provider] of Object.entries(SENT_TO_THE_CATALOG)) {
      if (provider !== null) {
        expect(catalogIds.has(provider), `${setupId} → ${provider}: ${RECHECK}`).toBe(true);
      }
    }
  });

  it('sends an address only to a provider that serves from that very host', () => {
    for (const setup of COMMON_PROVIDER_SETUPS) {
      const provider = SENT_TO_THE_CATALOG[setup.id];
      // Ollama is found by its local port; pi has no address to compare with.
      if (provider === null || provider === 'ollama') {
        continue;
      }
      const sharing = onTheSameHost(setup.recommendedBaseUrl).map((line) => line.split(' | ')[0]);
      expect(sharing, `${setup.id}: ${RECHECK}`).toContain(provider);
    }
  });
});
