/**
 * What the two API-settings tabs show, worked out from persisted state: the
 * entries of the provider chooser on a config set, the status of each
 * credential, which config sets use what, and the payloads the dialogs send.
 *
 * The Providers tab edits credentials and the Model Sets tab edits a config
 * set; neither edits the other's half (design §6.4). Everything here reads the
 * persisted credential store as it is — a credential is edited in a dialog with
 * its own Save, so there is no unsaved credential state to take into account.
 *
 * Pure: no React, no IPC.
 */
import type {
  ApiConfigSet,
  CustomEndpoint,
  CustomProtocolType,
  ProviderCredentialMap,
  ProviderPresets,
  ProviderType,
} from '../types';
import { isLoopbackBaseUrl } from '../../shared/network/loopback';
import { canonicalBaseUrl, customEndpointKey } from '../../shared/custom-endpoint-key';
import {
  groupEntriesByCategory,
  type ProviderCatalogEntry,
  type ProviderCategory,
} from '../../shared/provider-catalog';
import {
  formShapeFor,
  isCustomProtocol,
  isProviderType,
  profileKeyFromProvider,
  protocolOf,
} from './api-config-shared';
import { hydrateCredentialDraft, type CredentialDraft } from './provider-credentials-state';

/** The credential store as main persists it. */
export interface PersistedCredentials {
  providerCredentials: ProviderCredentialMap;
  customEndpoints: CustomEndpoint[];
}

// ---------------------------------------------------------------------------
// Credential status
// ---------------------------------------------------------------------------

/**
 * `configured` — usable as it is. `key-missing` — something relies on it and it
 * has no key. `not-set` — nothing stored and nothing relies on it.
 */
export type CredentialStatus = 'configured' | 'key-missing' | 'not-set';

/** Whether a catalog provider needs an API key at all. Ollama and some native providers do not. */
export function providerNeedsKey(provider: ProviderType, catalog: ProviderCatalogEntry[]): boolean {
  const shape = formShapeFor(catalog, provider);
  return shape !== null ? shape.apiKey !== false : provider !== 'ollama';
}

/** A gateway on this machine is allowed to run without a key. */
export function endpointNeedsKey(endpoint: Pick<CustomEndpoint, 'baseUrl'>): boolean {
  return !isLoopbackBaseUrl(endpoint.baseUrl);
}

export function setsUsingProvider(provider: ProviderType, configSets: ApiConfigSet[]) {
  return configSets.filter((set) => set.provider === provider);
}

export function setsUsingEndpoint(endpointId: string, configSets: ApiConfigSet[]) {
  return configSets.filter((set) => set.provider === 'custom' && set.endpointId === endpointId);
}

export function providerCredentialStatus(
  provider: ProviderType,
  catalog: ProviderCatalogEntry[],
  providerCredentials: ProviderCredentialMap,
  configSets: ApiConfigSet[]
): CredentialStatus {
  const stored = providerCredentials[profileKeyFromProvider(provider)];
  if (stored?.apiKey?.trim()) {
    return 'configured';
  }
  const inUse = setsUsingProvider(provider, configSets).length > 0;
  if (!providerNeedsKey(provider, catalog)) {
    // Keyless: there is nothing to be missing. It counts as set up once a
    // config set runs on it or the user has given it an address of their own.
    return inUse || Boolean(stored?.baseUrl?.trim()) ? 'configured' : 'not-set';
  }
  return inUse ? 'key-missing' : 'not-set';
}

/** An endpoint exists because the user created it, so it is never `not-set`. */
export function endpointCredentialStatus(
  endpoint: Pick<CustomEndpoint, 'apiKey' | 'baseUrl'>
): CredentialStatus {
  return endpoint.apiKey.trim() || !endpointNeedsKey(endpoint) ? 'configured' : 'key-missing';
}

// ---------------------------------------------------------------------------
// The credential a config set runs with
// ---------------------------------------------------------------------------

/**
 * The persisted credential behind a provider choice: the endpoint's own for a
 * custom set, the provider's slot otherwise.
 *
 * A custom set that points at no endpoint has no credential at all. It is never
 * given a default address to stand in for one — the runtime would resolve it to
 * nothing, and showing an address here would say otherwise.
 */
export function persistedCredentialFor(
  provider: ProviderType,
  endpointId: string,
  credentials: PersistedCredentials,
  presets: ProviderPresets
): CredentialDraft {
  if (provider === 'custom') {
    const endpoint = credentials.customEndpoints.find((candidate) => candidate.id === endpointId);
    return endpoint
      ? {
          apiKey: endpoint.apiKey,
          baseUrl: endpoint.baseUrl,
          protocol: isCustomProtocol(endpoint.protocol) ? endpoint.protocol : 'anthropic',
        }
      : { apiKey: '', baseUrl: '', protocol: 'anthropic' };
  }
  return hydrateCredentialDraft(
    { ...credentials, lastCustomProtocol: 'anthropic' },
    { kind: 'slot', slot: profileKeyFromProvider(provider) },
    presets
  );
}

/** The protocol and address a config set would run with — what a model's capabilities depend on. */
export function runtimeOf(
  provider: ProviderType,
  endpointId: string,
  credentials: PersistedCredentials,
  presets: ProviderPresets
): { customProtocol: CustomProtocolType; baseUrl: string } {
  const credential = persistedCredentialFor(provider, endpointId, credentials, presets);
  return { customProtocol: protocolOf(provider, credential.protocol), baseUrl: credential.baseUrl };
}

// ---------------------------------------------------------------------------
// The provider chooser on a config set
// ---------------------------------------------------------------------------

const PROVIDER_CHOICE_PREFIX = 'provider:';
const ENDPOINT_CHOICE_PREFIX = 'endpoint:';

/**
 * Id of a chooser entry. A catalog provider is chosen by its provider id; a
 * custom endpoint by its own id, because "custom" alone does not say which
 * gateway. A custom set with no endpoint is the bare `provider:custom`.
 */
export function providerChoiceId(provider: ProviderType, endpointId: string): string {
  return provider === 'custom' && endpointId
    ? `${ENDPOINT_CHOICE_PREFIX}${endpointId}`
    : `${PROVIDER_CHOICE_PREFIX}${provider}`;
}

export function parseProviderChoice(
  choiceId: string
): { provider: ProviderType; endpointId: string } | null {
  if (choiceId.startsWith(ENDPOINT_CHOICE_PREFIX)) {
    const endpointId = choiceId.slice(ENDPOINT_CHOICE_PREFIX.length);
    return endpointId ? { provider: 'custom', endpointId } : null;
  }
  if (choiceId.startsWith(PROVIDER_CHOICE_PREFIX)) {
    const provider = choiceId.slice(PROVIDER_CHOICE_PREFIX.length);
    return isProviderType(provider) ? { provider, endpointId: '' } : null;
  }
  return null;
}

export interface ProviderChoice {
  id: string;
  /** `no-endpoint` stands for a custom set that points at none; it cannot be picked. */
  kind: 'endpoint' | 'provider' | 'no-endpoint';
  /** The endpoint's name or the provider's; empty for `no-endpoint`, which the screen words. */
  label: string;
  group: 'endpoints' | ProviderCategory;
  /** An endpoint's protocol, or a provider's region tag. */
  badge?: string;
  status: CredentialStatus;
}

/**
 * The entries of the chooser: every custom endpoint by name first — they are
 * the ones a user has to tell apart — then the catalog in its usual grouping.
 *
 * The catalog's own `custom` entry is left out: a set cannot run on "custom"
 * without saying which endpoint, and each endpoint is listed already.
 */
export function buildProviderChoices(input: {
  catalog: ProviderCatalogEntry[];
  credentials: PersistedCredentials;
  configSets: ApiConfigSet[];
  /** What the open config set points at, so a set with no endpoint still has an entry to show. */
  current?: { provider: ProviderType; endpointId: string };
}): ProviderChoice[] {
  const { catalog, credentials, configSets, current } = input;
  const choices: ProviderChoice[] = [];

  const currentEndpointExists =
    current?.provider === 'custom' &&
    credentials.customEndpoints.some((endpoint) => endpoint.id === current.endpointId);
  if (current?.provider === 'custom' && !currentEndpointExists) {
    choices.push({
      id: providerChoiceId('custom', ''),
      kind: 'no-endpoint',
      label: '',
      group: 'endpoints',
      status: 'key-missing',
    });
  }

  for (const endpoint of credentials.customEndpoints) {
    choices.push({
      id: providerChoiceId('custom', endpoint.id),
      kind: 'endpoint',
      label: endpoint.name,
      group: 'endpoints',
      badge: endpoint.protocol,
      status: endpointCredentialStatus(endpoint),
    });
  }

  const providers = catalog.filter((entry) => entry.id !== 'custom');
  for (const { category, entries } of groupEntriesByCategory(providers)) {
    for (const entry of entries) {
      choices.push({
        id: providerChoiceId(entry.id, ''),
        kind: 'provider',
        label: entry.name,
        group: category,
        ...(entry.regionTag ? { badge: entry.regionTag } : {}),
        status: providerCredentialStatus(
          entry.id,
          catalog,
          credentials.providerCredentials,
          configSets
        ),
      });
    }
  }
  return choices;
}

// ---------------------------------------------------------------------------
// Rows of the Providers tab
// ---------------------------------------------------------------------------

export interface EndpointRow {
  endpoint: CustomEndpoint;
  status: CredentialStatus;
  /** Names of the config sets that point at it. Non-empty means it cannot be deleted. */
  usedBy: string[];
}

export function buildEndpointRows(
  customEndpoints: CustomEndpoint[],
  configSets: ApiConfigSet[]
): EndpointRow[] {
  return customEndpoints.map((endpoint) => ({
    endpoint,
    status: endpointCredentialStatus(endpoint),
    usedBy: setsUsingEndpoint(endpoint.id, configSets).map((set) => set.name),
  }));
}

/** The id of the endpoint a create call added: the one the list did not have before. */
export function createdEndpointId(
  before: CustomEndpoint[],
  after: CustomEndpoint[]
): string | null {
  const known = new Set(before.map((endpoint) => endpoint.id));
  return after.find((endpoint) => !known.has(endpoint.id))?.id ?? null;
}

export interface ProviderRow {
  entry: ProviderCatalogEntry;
  status: CredentialStatus;
  usedBy: string[];
}

/** The catalog providers, grouped and ordered as the provider picker has always shown them. */
export function buildProviderRowGroups(
  catalog: ProviderCatalogEntry[],
  providerCredentials: ProviderCredentialMap,
  configSets: ApiConfigSet[]
): Array<{ category: ProviderCategory; rows: ProviderRow[] }> {
  const providers = catalog.filter((entry) => entry.id !== 'custom');
  return groupEntriesByCategory(providers).map(({ category, entries }) => ({
    category,
    rows: entries.map((entry) => ({
      entry,
      status: providerCredentialStatus(entry.id, catalog, providerCredentials, configSets),
      usedBy: setsUsingProvider(entry.id, configSets).map((set) => set.name),
    })),
  }));
}

// ---------------------------------------------------------------------------
// The endpoint dialog
// ---------------------------------------------------------------------------

export interface EndpointFormValues {
  name: string;
  protocol: CustomProtocolType;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

/**
 * What the endpoint dialog opens on. A new endpoint starts with an empty
 * address: the protocol's usual one is shown as a hint, never as a value the
 * user might save without having typed it.
 */
export function endpointFormValues(
  endpoint: CustomEndpoint | null,
  protocolForNew: CustomProtocolType
): EndpointFormValues {
  if (!endpoint) {
    return { name: '', protocol: protocolForNew, baseUrl: '', apiKey: '', defaultModel: '' };
  }
  return {
    name: endpoint.name,
    protocol: isCustomProtocol(endpoint.protocol) ? endpoint.protocol : 'anthropic',
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    defaultModel: endpoint.defaultModel ?? '',
  };
}

export type EndpointFormProblem = 'missing_base_url' | 'duplicate';

/**
 * What stops an endpoint from being saved. Main checks the same two things and
 * refuses; asking here first means the dialog can say so next to the field.
 */
export function checkEndpointForm(
  values: EndpointFormValues,
  customEndpoints: CustomEndpoint[],
  editingId: string | null
): EndpointFormProblem | null {
  const baseUrl = values.baseUrl.trim();
  if (!baseUrl) {
    return 'missing_base_url';
  }
  const key = customEndpointKey(values.protocol, baseUrl);
  const taken = customEndpoints.some(
    (endpoint) =>
      endpoint.id !== editingId && customEndpointKey(endpoint.protocol, endpoint.baseUrl) === key
  );
  return taken ? 'duplicate' : null;
}

function savedEndpointAddress(baseUrl: string): string {
  return canonicalBaseUrl(baseUrl) || baseUrl.trim();
}

export function buildCreateEndpointPayload(values: EndpointFormValues): {
  name: string;
  protocol: CustomProtocolType;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
} {
  const defaultModel = values.defaultModel.trim();
  return {
    // Left empty, main names the endpoint after its address.
    name: values.name.trim(),
    protocol: values.protocol,
    baseUrl: savedEndpointAddress(values.baseUrl),
    apiKey: values.apiKey.trim(),
    ...(defaultModel ? { defaultModel } : {}),
  };
}

export function buildUpdateEndpointPayload(
  id: string,
  values: EndpointFormValues
): {
  id: string;
  name: string;
  protocol: CustomProtocolType;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
} {
  return {
    id,
    // An emptied name keeps the one the endpoint has; main never stores a blank.
    name: values.name.trim(),
    protocol: values.protocol,
    baseUrl: savedEndpointAddress(values.baseUrl),
    apiKey: values.apiKey.trim(),
    // Always sent: an empty one clears it, which leaving it out would not.
    defaultModel: values.defaultModel.trim(),
  };
}

// ---------------------------------------------------------------------------
// The provider dialog
// ---------------------------------------------------------------------------

/**
 * What the provider dialog opens on: the credential exactly as it is stored.
 *
 * Not `persistedCredentialFor`, which stands the provider's usual address in
 * for one that was never given — right for showing where a set would run, wrong
 * for a field that Save writes back. Opening the dialog and saving a key would
 * store that usual address as if the user had typed it. Here an address nobody
 * gave is empty, and the dialog shows the usual one as a hint.
 */
export function storedProviderCredential(
  provider: ProviderType,
  providerCredentials: ProviderCredentialMap
): { apiKey: string; baseUrl: string } {
  const stored = providerCredentials[profileKeyFromProvider(provider)];
  return { apiKey: stored?.apiKey ?? '', baseUrl: stored?.baseUrl?.trim() ?? '' };
}

/**
 * The call that saves one catalog provider's credential.
 *
 * The address is sent only for a provider that has an address field. For the
 * others main keeps what it has; sending the preset here would store the
 * provider's own default as if the user had overridden it.
 */
export function buildProviderCredentialPayload(input: {
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;
  showsBaseUrl: boolean;
}): { provider: ProviderType; apiKey: string; baseUrl?: string } {
  return {
    provider: input.provider,
    apiKey: input.apiKey.trim(),
    // '' removes an override, so the provider's usual address applies again.
    ...(input.showsBaseUrl ? { baseUrl: input.baseUrl.trim() } : {}),
  };
}
