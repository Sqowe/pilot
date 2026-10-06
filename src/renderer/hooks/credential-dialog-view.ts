/**
 * What the two credential dialogs work out before they ask main for anything:
 * which ready-made setups an endpoint can be filled from and what filling one
 * in does, which model a connection check tries, and how the outcome of a
 * search for a local Ollama is reported.
 *
 * Pure: no React, no IPC.
 */
import type {
  ApiConfigSet,
  LocalOllamaDiscoveryResult,
  ProviderPresets,
  ProviderType,
} from '../types';
import {
  catalogProviderOfSetup,
  COMMON_PROVIDER_SETUPS,
  getFallbackOpenAISetup,
  type CommonProviderSetup,
} from '../../shared/api-provider-guidance';
import { getCatalogEntry, type ProviderCatalogEntry } from '../../shared/provider-catalog';
import { modelPresetFor } from './api-config-shared';
import { setsUsingEndpoint, setsUsingProvider, type EndpointFormValues } from './api-settings-view';

// ---------------------------------------------------------------------------
// Ready-made setups, in the endpoint dialog
// ---------------------------------------------------------------------------

type SetupTarget = Pick<
  CommonProviderSetup,
  'applyProvider' | 'catalogProvider' | 'preferProviderTab'
>;

/**
 * The catalog provider a ready-made setup's service is — its entry on the
 * Providers tab — or null when the service is not one, or the catalog at hand
 * does not have it.
 *
 * The catalog is built from the installed pi and arrives at run time; before
 * it has, and on a pi that does not know the provider, there is no entry to
 * send anyone to, and the setup is an ordinary custom endpoint again.
 */
export function catalogEntryOfSetup(
  setup: Pick<SetupTarget, 'catalogProvider' | 'preferProviderTab'> | null | undefined,
  catalog: ProviderCatalogEntry[]
): ProviderCatalogEntry | null {
  const provider = setup ? catalogProviderOfSetup(setup) : null;
  return (provider && getCatalogEntry(catalog, provider)) || null;
}

/**
 * Whether a ready-made setup describes a custom endpoint. Some in the list do
 * not: their service is a catalog provider with an entry of its own, and an
 * endpoint filled from one of them would be that provider under another name.
 */
export function isEndpointSetup(setup: SetupTarget, catalog: ProviderCatalogEntry[]): boolean {
  return setup.applyProvider === 'custom' && catalogEntryOfSetup(setup, catalog) === null;
}

/** Ids of the ready-made setups an endpoint can be filled from. */
export function endpointSetupIds(catalog: ProviderCatalogEntry[]): Set<string> {
  return new Set(
    COMMON_PROVIDER_SETUPS.filter((setup) => isEndpointSetup(setup, catalog)).map(
      (setup) => setup.id
    )
  );
}

/**
 * Fill the endpoint form from a ready-made setup: its protocol, its address,
 * and its example model — unless the form already names a model of the user's
 * own. A model left by an earlier setup is replaced: it belongs to that
 * service, not to this one.
 *
 * The generic "any OpenAI-compatible service" setup has no address of its own;
 * what it carries is an example of the shape one takes. It sets the protocol
 * and leaves address and model alone, so nothing nobody typed can be saved.
 */
export function applySetupToEndpointForm(
  values: EndpointFormValues,
  setupId: string
): EndpointFormValues {
  const setup = COMMON_PROVIDER_SETUPS.find((candidate) => candidate.id === setupId);
  // Only what the dialog lists can be asked for; a setup that applies another
  // provider altogether has nothing to put into an endpoint's fields.
  if (!setup || setup.applyProvider !== 'custom') {
    return values;
  }
  if (setup.id === getFallbackOpenAISetup().id) {
    return { ...values, protocol: setup.recommendedProtocol };
  }
  const typedModel = values.defaultModel.trim();
  const modelIsTheUsers =
    typedModel !== '' &&
    !COMMON_PROVIDER_SETUPS.some((candidate) => candidate.exampleModel === typedModel);
  return {
    ...values,
    protocol: setup.recommendedProtocol,
    baseUrl: setup.recommendedBaseUrl,
    defaultModel: modelIsTheUsers ? values.defaultModel : setup.exampleModel,
  };
}

// ---------------------------------------------------------------------------
// The model a connection check tries
// ---------------------------------------------------------------------------

/** The model of the sets given, the active one first; '' when none names one. */
function modelInUse(sets: ApiConfigSet[], activeConfigSetId: string): string {
  const active = sets.find((set) => set.id === activeConfigSetId);
  return (
    [active, ...sets].map((set) => (set?.model ?? '').trim()).find((model) => model !== '') ?? ''
  );
}

/**
 * The model the endpoint dialog's check tries: the one in its Default model
 * field, else the one a config set already runs on this endpoint.
 *
 * '' when neither exists. An endpoint serves whatever its owner set up, so
 * there is no list to take a first entry from; the check then stops short of a
 * model and says so.
 */
export function endpointCheckModel(input: {
  defaultModel: string;
  /** null for an endpoint that is being added. */
  endpointId: string | null;
  configSets: ApiConfigSet[];
  activeConfigSetId: string;
}): string {
  const typed = input.defaultModel.trim();
  if (typed || !input.endpointId) {
    return typed;
  }
  return modelInUse(setsUsingEndpoint(input.endpointId, input.configSets), input.activeConfigSetId);
}

/**
 * The model the provider dialog's check tries: the one a config set already
 * runs on this provider, else the one a new config set would start on, else the
 * first the provider lists.
 *
 * '' for Ollama with no config set on it — its models are whatever the local
 * server has — and for a provider that lists none.
 */
export function providerCheckModel(input: {
  provider: ProviderType;
  configSets: ApiConfigSet[];
  activeConfigSetId: string;
  presets: ProviderPresets;
  catalog: ProviderCatalogEntry[];
}): string {
  const { provider, configSets, activeConfigSetId, presets, catalog } = input;
  const inUse = modelInUse(setsUsingProvider(provider, configSets), activeConfigSetId);
  if (inUse || provider === 'ollama') {
    return inUse;
  }
  return (
    modelPresetFor(provider, 'anthropic', presets).models[0]?.id ||
    getCatalogEntry(catalog, provider)?.modelOptions[0]?.id ||
    ''
  );
}

// ---------------------------------------------------------------------------
// Searching for a local Ollama
// ---------------------------------------------------------------------------

/** One line a dialog shows about something it just did: its tone and its text key. */
export interface DialogNote {
  tone: 'success' | 'warning' | 'error';
  key: string;
  values?: Record<string, number>;
}

/**
 * How the outcome of a search for a local Ollama is reported. Anything short of
 * a clear "found" reads as not found — including no answer at all.
 */
export function ollamaSearchNote(
  result: Partial<LocalOllamaDiscoveryResult> | null | undefined
): DialogNote {
  if (!result || result.available !== true) {
    return { tone: 'error', key: 'api.localOllamaNotFound' };
  }
  const count = result.models?.length ?? 0;
  if (result.status === 'service_available' || count === 0) {
    return { tone: 'warning', key: 'api.localOllamaNoModels' };
  }
  return { tone: 'success', key: 'api.localOllamaDiscovered', values: { count } };
}
