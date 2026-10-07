/**
 * What the first-run wizard works out before it asks main for anything: the
 * entries of the list its first step chooses from, which of them it opens on,
 * what a chosen entry stands for, and the model its second step starts on.
 *
 * The wizard is two steps over the same two halves the Settings tabs edit
 * (design §6.5): first a credential — a catalog provider's key, or a custom
 * endpoint — then the model the active config set selects. It saves each half
 * through the call the tabs use, so nothing here builds a payload of its own.
 *
 * Pure: no React, no IPC.
 */
import type { ApiConfigSet, CustomEndpoint, ProviderPresets, ProviderType } from '../types';
import { detectCommonProviderSetup } from '../../shared/api-provider-guidance';
import { getCatalogEntry, type ProviderCatalogEntry } from '../../shared/provider-catalog';
import {
  CUSTOM_ENDPOINT_LIMIT,
  defaultModelFields,
  isCustomProtocol,
  protocolOf,
  type ModelFields,
} from './api-config-shared';
import {
  buildProviderChoices,
  parseProviderChoice,
  providerChoiceId,
  type PersistedCredentials,
  type ProviderChoice,
} from './api-settings-view';

export type WizardStep = 'credential' | 'model';

/** Id of the list entry that adds a custom endpoint instead of choosing one. */
export const NEW_ENDPOINT_CHOICE = 'new-endpoint';

/** What the entry chosen in the first step stands for. */
export type WizardTarget =
  | { kind: 'provider'; entry: ProviderCatalogEntry }
  | { kind: 'endpoint'; endpoint: CustomEndpoint }
  | { kind: 'new-endpoint' };

/** A target that exists in the credential store — everything but an endpoint not created yet. */
export type SavedWizardTarget = Exclude<WizardTarget, { kind: 'new-endpoint' }>;

/**
 * The entries of the first step's list: what the chooser on a config set
 * offers — every custom endpoint by name, then the catalog — plus one entry
 * that adds an endpoint, placed with the endpoints.
 *
 * The same list as on the Model Sets tab, so an endpoint that already exists
 * is chosen here by its name, not typed in a second time. The entry that adds
 * one is left out once the store can take no more.
 */
export function buildWizardChoices(input: {
  catalog: ProviderCatalogEntry[];
  credentials: PersistedCredentials;
  configSets: ApiConfigSet[];
}): ProviderChoice[] {
  const choices = buildProviderChoices(input);
  if (input.credentials.customEndpoints.length >= CUSTOM_ENDPOINT_LIMIT) {
    return choices;
  }
  const addEndpoint: ProviderChoice = {
    id: NEW_ENDPOINT_CHOICE,
    kind: 'new-endpoint',
    label: '',
    group: 'endpoints',
    status: 'not-set',
  };
  const firstProvider = choices.findIndex((choice) => choice.kind === 'provider');
  return firstProvider === -1
    ? [...choices, addEndpoint]
    : [...choices.slice(0, firstProvider), addEndpoint, ...choices.slice(firstProvider)];
}

/**
 * The entry the first step opens on: what the active config set points at.
 *
 * A custom set whose endpoint is gone — or that never had one — opens on the
 * entry that adds an endpoint: there is nothing of its own to show, and no
 * other endpoint is picked on the user's behalf.
 */
export function initialWizardChoice(
  active: { provider: ProviderType; endpointId: string },
  customEndpoints: CustomEndpoint[]
): string {
  if (active.provider !== 'custom') {
    return providerChoiceId(active.provider, '');
  }
  return customEndpoints.some((endpoint) => endpoint.id === active.endpointId)
    ? providerChoiceId('custom', active.endpointId)
    : NEW_ENDPOINT_CHOICE;
}

/**
 * What a list entry stands for, or null when it stands for nothing the wizard
 * can show: an endpoint deleted since, or a provider the catalog at hand does
 * not have.
 */
export function resolveWizardTarget(
  choiceId: string,
  catalog: ProviderCatalogEntry[],
  customEndpoints: CustomEndpoint[]
): WizardTarget | null {
  if (choiceId === NEW_ENDPOINT_CHOICE) {
    return { kind: 'new-endpoint' };
  }
  const choice = parseProviderChoice(choiceId);
  if (!choice) {
    return null;
  }
  if (choice.provider === 'custom') {
    const endpoint = customEndpoints.find((candidate) => candidate.id === choice.endpointId);
    return endpoint ? { kind: 'endpoint', endpoint } : null;
  }
  const entry = getCatalogEntry(catalog, choice.provider);
  return entry ? { kind: 'provider', entry } : null;
}

/** The provider and endpoint a config set names when it runs on a target. */
export function targetPointer(target: SavedWizardTarget): {
  provider: ProviderType;
  endpointId: string;
} {
  return target.kind === 'endpoint'
    ? { provider: 'custom', endpointId: target.endpoint.id }
    : { provider: target.entry.id, endpointId: '' };
}

/** Whether a config set already points at a target. */
export function pointsAt(
  set: { provider: ProviderType; endpointId: string },
  target: SavedWizardTarget
): boolean {
  const pointer = targetPointer(target);
  return (
    set.provider === pointer.provider &&
    (pointer.provider !== 'custom' || set.endpointId === pointer.endpointId)
  );
}

/**
 * The model the second step starts on for a custom endpoint: the endpoint's
 * own default model, else the example model of the well-known service its
 * address belongs to, else none (design §6.5).
 *
 * An endpoint serves whatever its owner set up, so there is no list to take a
 * first entry from; with neither, the model is typed.
 */
export function endpointStartModel(
  endpoint: Pick<CustomEndpoint, 'defaultModel' | 'baseUrl'>
): string {
  return (
    endpoint.defaultModel?.trim() || detectCommonProviderSetup(endpoint.baseUrl)?.exampleModel || ''
  );
}

/**
 * The model fields the active config set takes when the first step moves it
 * to a target it was not on: what a config set chosen for that provider on the
 * Model Sets tab starts on, with an endpoint's start model filled in.
 */
export function startModelFields(target: SavedWizardTarget, presets: ProviderPresets): ModelFields {
  if (target.kind === 'endpoint') {
    const protocol = isCustomProtocol(target.endpoint.protocol)
      ? target.endpoint.protocol
      : 'anthropic';
    return defaultModelFields('custom', protocol, presets, endpointStartModel(target.endpoint));
  }
  const provider = target.entry.id;
  return defaultModelFields(provider, protocolOf(provider, 'anthropic'), presets);
}

/**
 * Whether the first step has to stop for a key.
 *
 * The Settings dialogs save a credential without one — it may be on its way.
 * The wizard exists to end on a setup that can start a chat, so where the
 * chosen entry needs a key it does not go on without it.
 */
export function keyIsMissing(needsKey: boolean, apiKey: string): boolean {
  return needsKey && !apiKey.trim();
}
