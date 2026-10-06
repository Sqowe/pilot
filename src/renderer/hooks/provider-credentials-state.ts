/**
 * State of the **provider credentials** half of API settings: the key and base
 * URL of each catalog provider, the user's custom endpoints, and the unsaved
 * edits to either.
 *
 * Credentials are machine-wide — one slot per provider, plus the custom
 * endpoints — so nothing here belongs to a config set. An edit is tracked
 * against the credential it changes (a *target*), not against whichever set
 * happens to be open: a key typed for one provider is still pending after the
 * form moves to another, and is saved on its own, through its own call. The
 * other half lives in `model-sets-state.ts`; neither imports the other
 * (design §6.4).
 *
 * Pure: the reducer and helpers below have no React or IPC in them.
 */
import type {
  CustomEndpoint,
  CustomProtocolType,
  ProviderCredentialMap,
  ProviderPresets,
  ProviderProfileKey,
  ProviderType,
} from '../types';
import { normalizeOllamaBaseUrl } from '../../shared/ollama-base-url';
import { canonicalBaseUrl, customEndpointKey } from '../../shared/custom-endpoint-key';
import {
  isCustomProtocol,
  isProfileKey,
  modelPresetForProfileSafe,
  profileKeyFromProvider,
  profileKeyToProvider,
} from './api-config-shared';

/**
 * The credential an edit applies to: a catalog provider's slot, an existing
 * custom endpoint, or a custom endpoint that has not been created yet.
 */
export type CredentialTarget =
  | { kind: 'slot'; slot: ProviderProfileKey }
  | { kind: 'endpoint'; id: string }
  | { kind: 'new-endpoint' };

const SLOT_PREFIX = 'slot:';
const ENDPOINT_PREFIX = 'endpoint:';
const NEW_ENDPOINT_KEY = `${ENDPOINT_PREFIX}new`;

export function credentialTargetKey(target: CredentialTarget): string {
  if (target.kind === 'slot') return `${SLOT_PREFIX}${target.slot}`;
  if (target.kind === 'endpoint') return `${ENDPOINT_PREFIX}${target.id}`;
  return NEW_ENDPOINT_KEY;
}

function parseCredentialTargetKey(key: string): CredentialTarget | null {
  if (key === NEW_ENDPOINT_KEY) return { kind: 'new-endpoint' };
  if (key.startsWith(ENDPOINT_PREFIX)) {
    const id = key.slice(ENDPOINT_PREFIX.length);
    return id ? { kind: 'endpoint', id } : null;
  }
  if (key.startsWith(SLOT_PREFIX)) {
    const slot = key.slice(SLOT_PREFIX.length);
    return isProfileKey(slot) && !slot.startsWith('custom:') ? { kind: 'slot', slot } : null;
  }
  return null;
}

/** Where a provider keeps its credential. For `custom` that is an endpoint, named or not yet created. */
export function credentialTargetFor(provider: ProviderType, endpointId: string): CredentialTarget {
  if (provider === 'custom') {
    return endpointId ? { kind: 'endpoint', id: endpointId } : { kind: 'new-endpoint' };
  }
  return { kind: 'slot', slot: profileKeyFromProvider(provider) };
}

/** The credential fields of the form. `protocol` only matters for an endpoint. */
export interface CredentialDraft {
  apiKey: string;
  baseUrl: string;
  protocol: CustomProtocolType;
}

export interface ProviderCredentialsState {
  /** As persisted. The baseline every draft is compared against. */
  providerCredentials: ProviderCredentialMap;
  /** As persisted. */
  customEndpoints: CustomEndpoint[];
  /** Unsaved edits, keyed by `credentialTargetKey`. Only targets the user touched. */
  drafts: Record<string, CredentialDraft>;
  /** The protocol a not-yet-created endpoint starts on, and returns to. */
  lastCustomProtocol: CustomProtocolType;
  isSaving: boolean;
}

export type ProviderCredentialsAction =
  | {
      type: 'APPLY_PERSISTED';
      providerCredentials: ProviderCredentialMap;
      customEndpoints: CustomEndpoint[];
      /**
       * `reset` drops every unsaved edit (initial load, or the user chose to
       * discard). `rebase` keeps them: persisted state moved underneath, but the
       * edits are still the user's — a save of the *other* half must not cost
       * them a key they have typed.
       */
      mode: 'reset' | 'rebase';
      lastCustomProtocol?: CustomProtocolType;
    }
  | {
      type: 'PATCH_DRAFT';
      targetKey: string;
      /** The persisted value, used when this is the first edit to the target. */
      baseline: CredentialDraft;
      patch: Partial<CredentialDraft>;
    }
  | { type: 'DISCARD_DRAFT'; targetKey: string }
  | { type: 'SET_LAST_CUSTOM_PROTOCOL'; payload: CustomProtocolType }
  | { type: 'SET_IS_SAVING'; payload: boolean };

/** The base URL a custom endpoint is pre-filled with before the user types one. */
export function defaultCustomBaseUrl(
  protocol: CustomProtocolType,
  presets: ProviderPresets
): string {
  return modelPresetForProfileSafe(profileKeyFromProvider('custom', protocol), presets).baseUrl;
}

/**
 * The persisted value of a credential, as the form shows it — what a target
 * reads before anything is edited, and what its draft is compared against.
 */
export function hydrateCredentialDraft(
  state: Pick<
    ProviderCredentialsState,
    'providerCredentials' | 'customEndpoints' | 'lastCustomProtocol'
  >,
  target: CredentialTarget,
  presets: ProviderPresets
): CredentialDraft {
  if (target.kind === 'slot') {
    const stored = state.providerCredentials[target.slot];
    const presetBaseUrl = modelPresetForProfileSafe(target.slot, presets).baseUrl;
    const rawBaseUrl = stored?.baseUrl?.trim() || presetBaseUrl;
    return {
      apiKey: stored?.apiKey ?? '',
      baseUrl:
        target.slot === 'ollama' ? normalizeOllamaBaseUrl(rawBaseUrl) || presetBaseUrl : rawBaseUrl,
      protocol: profileKeyToProvider(target.slot).customProtocol,
    };
  }

  const endpoint =
    target.kind === 'endpoint'
      ? state.customEndpoints.find((candidate) => candidate.id === target.id)
      : undefined;
  if (endpoint) {
    return {
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl,
      protocol: isCustomProtocol(endpoint.protocol) ? endpoint.protocol : 'anthropic',
    };
  }

  // No endpoint yet (or a pointer to one that is gone): a blank one, pre-filled
  // with the protocol's usual address so the field shows what is expected.
  return {
    apiKey: '',
    baseUrl: defaultCustomBaseUrl(state.lastCustomProtocol, presets),
    protocol: state.lastCustomProtocol,
  };
}

/** A target's current value: its unsaved edit if there is one, otherwise what is persisted. */
export function selectCredentialDraft(
  state: ProviderCredentialsState,
  target: CredentialTarget,
  presets: ProviderPresets
): CredentialDraft {
  return (
    state.drafts[credentialTargetKey(target)] ?? hydrateCredentialDraft(state, target, presets)
  );
}

/**
 * The address a credential is *saved* with, which is not always the one typed:
 *
 * - an endpoint's address is stored in canonical form (main does the same);
 * - Ollama's is normalized to its OpenAI-compatible `/v1` form;
 * - a cloud provider's is the preset's — the form has no field for it;
 * - a native provider has no preset, so its own field stands.
 *
 * The one rule for what is compared and what is sent. With two rules, a save
 * could store something other than what the form then compares against, and the
 * credential would read as changed for ever.
 */
export function savedBaseUrl(
  target: CredentialTarget,
  draft: Pick<CredentialDraft, 'baseUrl'>,
  presets: ProviderPresets
): string {
  const baseUrl = draft.baseUrl.trim();
  if (target.kind !== 'slot') {
    return canonicalBaseUrl(baseUrl) || baseUrl;
  }
  if (target.slot === 'ollama') {
    return normalizeOllamaBaseUrl(baseUrl) || baseUrl;
  }
  return (modelPresetForProfileSafe(target.slot, presets).baseUrl || baseUrl).trim();
}

function credentialSignature(
  target: CredentialTarget,
  draft: CredentialDraft,
  presets: ProviderPresets
): string {
  return JSON.stringify({
    apiKey: draft.apiKey.trim(),
    baseUrl: savedBaseUrl(target, draft, presets),
    // A catalog provider's protocol is fixed, so it is no part of what can change.
    protocol: target.kind === 'slot' ? '' : draft.protocol,
  });
}

/**
 * The targets with an edit that differs from what is persisted **and that a
 * save would send**. `planCredentialSave` works from this list, so what reads
 * as unsaved and what a save writes cannot disagree.
 *
 * Two kinds of draft have nowhere to be saved and are not counted: one for an
 * endpoint that no longer exists, and one for an endpoint not created yet that
 * has no address — an endpoint is created at an address. Counting the second
 * left the form reading as changed after a save that had succeeded.
 */
export function dirtyCredentialTargets(
  state: ProviderCredentialsState,
  presets: ProviderPresets
): Array<{ target: CredentialTarget; targetKey: string; draft: CredentialDraft }> {
  const dirty: Array<{ target: CredentialTarget; targetKey: string; draft: CredentialDraft }> = [];
  for (const [targetKey, draft] of Object.entries(state.drafts)) {
    const target = parseCredentialTargetKey(targetKey);
    if (!target) continue;
    if (
      target.kind === 'endpoint' &&
      !state.customEndpoints.some((candidate) => candidate.id === target.id)
    ) {
      continue;
    }
    if (target.kind === 'new-endpoint' && !savedBaseUrl(target, draft, presets)) {
      continue;
    }
    const baseline = hydrateCredentialDraft(state, target, presets);
    if (
      credentialSignature(target, draft, presets) !== credentialSignature(target, baseline, presets)
    ) {
      dirty.push({ target, targetKey, draft });
    }
  }
  return dirty;
}

export function hasUnsavedCredentialChanges(
  state: ProviderCredentialsState,
  presets: ProviderPresets
): boolean {
  return dirtyCredentialTargets(state, presets).length > 0;
}

/**
 * Change an endpoint draft's protocol. A draft still showing the old protocol's
 * usual address (or none) moves to the new protocol's — the user has not named
 * a gateway yet, so the placeholder should follow. An address they typed stays.
 */
export function withEndpointProtocol(
  draft: CredentialDraft,
  protocol: CustomProtocolType,
  presets: ProviderPresets
): CredentialDraft {
  const currentUrl = draft.baseUrl.trim();
  const isPlaceholderUrl =
    !currentUrl ||
    canonicalBaseUrl(currentUrl) ===
      canonicalBaseUrl(defaultCustomBaseUrl(draft.protocol, presets));
  return {
    ...draft,
    protocol,
    baseUrl: isPlaceholderUrl ? defaultCustomBaseUrl(protocol, presets) : draft.baseUrl,
  };
}

/** One call to main that saves one credential. None of them names a config set. */
export type CredentialSaveStep =
  | {
      kind: 'provider';
      targetKey: string;
      payload: { provider: ProviderType; apiKey: string; baseUrl: string };
    }
  | {
      kind: 'update-endpoint';
      targetKey: string;
      payload: { id: string; protocol: CustomProtocolType; baseUrl: string; apiKey: string };
    }
  | {
      kind: 'create-endpoint';
      targetKey: string;
      payload: {
        name: string;
        protocol: CustomProtocolType;
        baseUrl: string;
        apiKey: string;
        defaultModel?: string;
      };
    }
  // The address typed is one another endpoint already has: point at that one
  // instead of creating a twin, and pass on a key if one was typed.
  | {
      kind: 'reuse-endpoint';
      targetKey: string;
      endpointId: string;
      payload?: { id: string; apiKey: string };
    };

/**
 * Turn every unsaved credential edit into the call that saves it.
 *
 * Catalog providers go through `setProviderCredential`; endpoints through the
 * endpoint CRUD calls. One step per unsaved edit: `dirtyCredentialTargets`
 * has already left out the edits that have nowhere to be saved.
 */
export function planCredentialSave(
  state: ProviderCredentialsState,
  presets: ProviderPresets,
  options: { newEndpointDefaultModel?: string } = {}
): CredentialSaveStep[] {
  const steps: CredentialSaveStep[] = [];
  for (const { target, targetKey, draft } of dirtyCredentialTargets(state, presets)) {
    const apiKey = draft.apiKey.trim();
    const baseUrl = savedBaseUrl(target, draft, presets);

    if (target.kind === 'slot') {
      steps.push({
        kind: 'provider',
        targetKey,
        payload: { provider: profileKeyToProvider(target.slot).provider, apiKey, baseUrl },
      });
      continue;
    }

    // An endpoint is identified by protocol + address, so one that already
    // exists at the typed address is the same endpoint: point at it rather than
    // create a twin (or ask main for one, which it refuses).
    const sameAddress = baseUrl
      ? state.customEndpoints.find(
          (candidate) =>
            !(target.kind === 'endpoint' && candidate.id === target.id) &&
            customEndpointKey(candidate.protocol, candidate.baseUrl) ===
              customEndpointKey(draft.protocol, baseUrl)
        )
      : undefined;
    if (sameAddress) {
      // Only a key the user typed in this edit is passed on. The one the form
      // was showing belongs to the endpoint being left, and writing it here
      // would overwrite the key of the endpoint being arrived at.
      const typedKey = apiKey !== hydrateCredentialDraft(state, target, presets).apiKey.trim();
      steps.push({
        kind: 'reuse-endpoint',
        targetKey,
        endpointId: sameAddress.id,
        ...(typedKey && apiKey && apiKey !== sameAddress.apiKey
          ? { payload: { id: sameAddress.id, apiKey } }
          : {}),
      });
      continue;
    }

    if (target.kind === 'endpoint') {
      steps.push({
        kind: 'update-endpoint',
        targetKey,
        payload: { id: target.id, protocol: draft.protocol, baseUrl, apiKey },
      });
      continue;
    }

    const defaultModel = options.newEndpointDefaultModel?.trim();
    steps.push({
      kind: 'create-endpoint',
      targetKey,
      payload: {
        // Left for main to name after the address's host.
        name: '',
        protocol: draft.protocol,
        baseUrl,
        apiKey,
        ...(defaultModel ? { defaultModel } : {}),
      },
    });
  }
  // Catalog providers first: independent of everything else, so one failing
  // endpoint call never holds a provider key back.
  return steps.sort(
    (left, right) => Number(left.kind !== 'provider') - Number(right.kind !== 'provider')
  );
}

export function createProviderCredentialsState(
  config:
    | {
        providerCredentials?: ProviderCredentialMap;
        customEndpoints?: CustomEndpoint[];
        customProtocol?: CustomProtocolType;
      }
    | null
    | undefined
): ProviderCredentialsState {
  return {
    providerCredentials: config?.providerCredentials ?? {},
    customEndpoints: config?.customEndpoints ?? [],
    drafts: {},
    lastCustomProtocol: isCustomProtocol(config?.customProtocol)
      ? config.customProtocol
      : 'anthropic',
    isSaving: false,
  };
}

export function providerCredentialsReducer(
  state: ProviderCredentialsState,
  action: ProviderCredentialsAction
): ProviderCredentialsState {
  switch (action.type) {
    case 'APPLY_PERSISTED':
      return {
        ...state,
        providerCredentials: action.providerCredentials,
        customEndpoints: action.customEndpoints,
        drafts: action.mode === 'reset' ? {} : state.drafts,
        lastCustomProtocol: action.lastCustomProtocol ?? state.lastCustomProtocol,
      };

    case 'PATCH_DRAFT':
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.targetKey]: {
            ...(state.drafts[action.targetKey] ?? action.baseline),
            ...action.patch,
          },
        },
      };

    case 'DISCARD_DRAFT': {
      const drafts = { ...state.drafts };
      delete drafts[action.targetKey];
      return { ...state, drafts };
    }

    case 'SET_LAST_CUSTOM_PROTOCOL':
      return { ...state, lastCustomProtocol: action.payload };

    case 'SET_IS_SAVING':
      return { ...state, isSaving: action.payload };

    default: {
      // Exhaustiveness check — TypeScript will error if a case is missing
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
