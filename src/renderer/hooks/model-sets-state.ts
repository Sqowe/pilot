/**
 * State of the **model sets** half of API settings: which config sets exist,
 * which one is active, and the unsaved edits to the active one.
 *
 * A config set selects a provider and a model and holds no credential, so
 * nothing here knows an API key. Unsaved-change tracking covers the set's own
 * fields only — `provider`, `endpointId`, the model, the two token limits and
 * the thinking level — and the save payload carries exactly those. The other
 * half, the credentials, has no unsaved state to keep: a credential is edited
 * in a dialog with its own Save (`useApiSettingsState.ts`), and nothing here
 * imports it (design §6.4).
 *
 * Pure: the reducer and helpers below have no React or IPC in them.
 */
import type {
  ApiConfigSet,
  AppConfig,
  CustomEndpoint,
  CustomProtocolType,
  ModelThinkingLevel,
  ProviderPresets,
  ProviderType,
  ThinkingCapabilities,
} from '../types';
import {
  DEFAULT_CONFIG_SET_ID,
  DEFAULT_CONFIG_SET_NAME,
  defaultModelFields,
  finalModelOf,
  isLegacyOllamaConfig,
  isProviderType,
  normalizeLegacyModelId,
  parseTokenLimitField,
  splitModelSelection,
  type ModelFields,
} from './api-config-shared';

/** The unsaved edits to the active config set. */
export interface ModelSetDraft extends ModelFields {
  provider: ProviderType;
  /** The custom endpoint the set points at; `''` for none. Custom sets only. */
  endpointId: string;
  thinkingLevel: ModelThinkingLevel;
}

export type PendingConfigSetAction = { type: 'switch'; targetSetId: string };

export interface ModelSetsState {
  configSets: ApiConfigSet[];
  activeConfigSetId: string;
  draft: ModelSetDraft;
  /**
   * What the user chose for each provider *during this editing session*, keyed
   * by `modelMemoryKey`. A set stores one model, so flipping the form to
   * another provider and back would otherwise lose what was typed. Never
   * persisted, and emptied whenever persisted state is applied.
   */
  modelMemory: Record<string, ModelFields>;
  /** Signature of the draft as last loaded or saved; `''` until first loaded. */
  savedSignature: string;
  /** A set switch waiting for the unsaved-changes dialog. */
  pendingConfigSetAction: PendingConfigSetAction | null;
  /** What the current model can do. Describes the model, never changes the stored level. */
  thinkingCapabilities: ThinkingCapabilities;
  isSaving: boolean;
  isMutatingConfigSet: boolean;
}

export type ModelSetsAction =
  // Persisted state arrived and replaces the draft (initial load, save, switch).
  | {
      type: 'APPLY_PERSISTED';
      configSets: ApiConfigSet[];
      activeConfigSetId: string;
      draft: ModelSetDraft;
    }
  // Persisted state arrived but the draft is still the user's (rename, or a
  // credential save that did not touch the sets).
  | { type: 'REBASE_PERSISTED'; configSets: ApiConfigSet[]; activeConfigSetId: string }
  // Also how a custom set moves from one endpoint to another: the model is
  // remembered per endpoint, so there is no separate "set the endpoint" action
  // that could carry one gateway's model over to the next.
  | {
      type: 'CHANGE_PROVIDER';
      provider: ProviderType;
      endpointId: string;
      /** What the provider starts on when this session has no memory of it. */
      defaults: ModelFields;
    }
  | { type: 'UPDATE_MODEL_FIELDS'; updater: (previous: ModelFields) => ModelFields }
  | { type: 'SET_THINKING_LEVEL'; payload: ModelThinkingLevel }
  // Thinking capabilities resolved for a concrete model.
  | { type: 'SET_THINKING_CAPABILITIES'; payload: ThinkingCapabilities }
  // Capabilities not knowable right now (no model selected yet, or the query
  // failed). Collapses the selector but must never touch the stored level.
  | { type: 'CLEAR_THINKING_CAPABILITIES' }
  | { type: 'SET_PENDING_CONFIG_SET_ACTION'; payload: PendingConfigSetAction | null }
  | { type: 'MARK_SAVED' }
  | { type: 'SET_IS_SAVING'; payload: boolean }
  | { type: 'SET_IS_MUTATING_CONFIG_SET'; payload: boolean };

const UNKNOWN_THINKING_CAPABILITIES: ThinkingCapabilities = {
  supportsThinking: false,
  levels: ['off'],
};

function pickModelFields(draft: ModelSetDraft): ModelFields {
  return {
    model: draft.model,
    customModel: draft.customModel,
    useCustomModel: draft.useCustomModel,
    contextWindow: draft.contextWindow,
    maxTokens: draft.maxTokens,
  };
}

/**
 * Key for the per-session model memory. A custom provider is only as specific
 * as the endpoint behind it — two gateways serve different models — so the
 * endpoint is part of the key there.
 */
export function modelMemoryKey(provider: ProviderType, endpointId: string): string {
  return provider === 'custom' ? `custom::${endpointId}` : provider;
}

/**
 * What marks a draft as different from what is saved. Covers exactly the fields
 * a config set stores, and nothing a credential stores.
 */
export function buildModelSetSignature(draft: ModelSetDraft): string {
  return JSON.stringify({
    provider: draft.provider,
    endpointId: draft.provider === 'custom' ? draft.endpointId : '',
    model: finalModelOf(draft),
    contextWindow: parseTokenLimitField(draft.contextWindow),
    maxTokens: parseTokenLimitField(draft.maxTokens),
    thinkingLevel: draft.thinkingLevel,
  });
}

/**
 * The `config.save` payload for the active config set.
 *
 * Carries **no** `apiKey`, `baseUrl` or `customProtocol`: with none of those
 * present the store writes nothing to the credential store, which is what keeps
 * a model change from ever dragging a key edit along with it.
 *
 * The token limits are always sent as numbers (0 = clear): IPC drops
 * `undefined`, and the store reads an absent key as "leave unchanged".
 */
export function buildModelSetSavePayload(
  draft: ModelSetDraft,
  activeConfigSetId: string
): Partial<AppConfig> {
  return {
    activeConfigSetId,
    provider: draft.provider,
    // '' unpins; left out entirely for a catalog provider, which has no endpoint.
    ...(draft.provider === 'custom' ? { endpointId: draft.endpointId } : {}),
    model: finalModelOf(draft),
    contextWindow: parseTokenLimitField(draft.contextWindow),
    maxTokens: parseTokenLimitField(draft.maxTokens),
    enableThinking: draft.thinkingLevel !== 'off',
    thinkingLevel: draft.thinkingLevel,
  };
}

function thinkingLevelOf(source: {
  thinkingLevel?: ModelThinkingLevel;
  enableThinking?: boolean;
}): ModelThinkingLevel {
  return (source.thinkingLevel ?? (source.enableThinking ? 'medium' : 'off')) as ModelThinkingLevel;
}

/**
 * The config sets as the form lists them. Main always sends a normalized list;
 * this only guards the renderer against a missing one (an older bootstrap, the
 * browser preview) by standing in a default set built from the flat fields.
 */
export function buildConfigSets(config: AppConfig | null | undefined): ApiConfigSet[] {
  const now = new Date().toISOString();

  if (config?.configSets && config.configSets.length > 0) {
    // A fresh object with the known fields only — never a spread of what came
    // over IPC. A set holds no credential, and copying field by field is what
    // keeps that true whatever else the incoming object happens to carry.
    return config.configSets.map((set, index): ApiConfigSet => {
      const provider = isProviderType(set.provider) ? set.provider : 'openrouter';
      const endpointId =
        provider === 'custom' && typeof set.endpointId === 'string' ? set.endpointId.trim() : '';
      return {
        id: typeof set.id === 'string' && set.id.trim() ? set.id : `set-${index + 1}`,
        name:
          typeof set.name === 'string' && set.name.trim() ? set.name : `Config Set ${index + 1}`,
        ...(set.isSystem !== undefined ? { isSystem: Boolean(set.isSystem) } : {}),
        provider,
        ...(endpointId ? { endpointId } : {}),
        model: typeof set.model === 'string' ? set.model : '',
        ...(typeof set.contextWindow === 'number' && set.contextWindow > 0
          ? { contextWindow: set.contextWindow }
          : {}),
        ...(typeof set.maxTokens === 'number' && set.maxTokens > 0
          ? { maxTokens: set.maxTokens }
          : {}),
        enableThinking: Boolean(set.enableThinking),
        // Sets read from an older on-disk config have no thinkingLevel; deriving
        // it here keeps the legacy boolean from being the only source of truth.
        thinkingLevel: thinkingLevelOf(set),
        updatedAt: typeof set.updatedAt === 'string' && set.updatedAt.trim() ? set.updatedAt : now,
      };
    });
  }

  return [
    {
      id:
        typeof config?.activeConfigSetId === 'string' && config.activeConfigSetId.trim()
          ? config.activeConfigSetId
          : DEFAULT_CONFIG_SET_ID,
      name: DEFAULT_CONFIG_SET_NAME,
      isSystem: true,
      provider: isProviderType(config?.provider) ? config.provider : 'openrouter',
      ...(config?.endpointId ? { endpointId: config.endpointId } : {}),
      model: config?.model ?? '',
      ...(typeof config?.contextWindow === 'number' ? { contextWindow: config.contextWindow } : {}),
      ...(typeof config?.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
      enableThinking: Boolean(config?.enableThinking),
      thinkingLevel: thinkingLevelOf(config ?? {}),
      updatedAt: now,
    },
  ];
}

/** The id of the set the form should show: the configured one if it exists. */
export function resolveActiveConfigSetId(
  config: AppConfig | null | undefined,
  configSets: ApiConfigSet[]
): string {
  return typeof config?.activeConfigSetId === 'string' &&
    configSets.some((set) => set.id === config.activeConfigSetId)
    ? config.activeConfigSetId
    : configSets[0]?.id || DEFAULT_CONFIG_SET_ID;
}

/**
 * Load a config set into the form.
 *
 * A set names a provider, optionally an endpoint, and one model id; the form
 * needs that model split into its picked / typed pair, which depends on the
 * provider's preset list — and for a custom set on the protocol its endpoint
 * speaks.
 */
export function hydrateModelSetDraft(
  set: ApiConfigSet,
  presets: ProviderPresets,
  customEndpoints: CustomEndpoint[]
): ModelSetDraft {
  const endpoint =
    set.provider === 'custom' && set.endpointId
      ? customEndpoints.find((candidate) => candidate.id === set.endpointId)
      : undefined;

  // A custom OpenAI-protocol endpoint on the default local Ollama port is an
  // Ollama setup from before Ollama had its own provider. Show it as Ollama, so
  // the user gets model discovery instead of a bare manual field; saving then
  // stores it that way.
  const isLegacyOllama = isLegacyOllamaConfig({
    provider: set.provider,
    customProtocol: endpoint?.protocol,
    baseUrl: endpoint?.baseUrl,
  });
  const provider: ProviderType = isLegacyOllama ? 'ollama' : set.provider;
  const customProtocol: CustomProtocolType =
    provider === 'custom' ? (endpoint?.protocol ?? 'anthropic') : 'anthropic';
  const endpointId = provider === 'custom' ? (endpoint?.id ?? '') : '';

  // A custom endpoint has no list to pick from — its models are whatever its
  // owner serves — so its model is always shown as typed. Splitting it like a
  // catalog model would hide one that happens to share an id with a preset
  // behind a picker the form does not show for this provider.
  const selection =
    provider === 'custom'
      ? {
          ...defaultModelFields(provider, customProtocol, presets),
          customModel: normalizeLegacyModelId(provider, set.model ?? ''),
        }
      : splitModelSelection(set.model ?? '', provider, customProtocol, presets);

  return {
    provider,
    endpointId,
    model: selection.model,
    customModel: selection.customModel,
    useCustomModel: selection.useCustomModel,
    contextWindow: set.contextWindow ? String(set.contextWindow) : '',
    maxTokens: set.maxTokens ? String(set.maxTokens) : '',
    thinkingLevel: thinkingLevelOf(set),
  };
}

/** A draft for the moment before any config has loaded. */
export function emptyModelSetDraft(presets: ProviderPresets): ModelSetDraft {
  return {
    provider: 'openrouter',
    endpointId: '',
    ...defaultModelFields('openrouter', 'anthropic', presets),
    thinkingLevel: 'off',
  };
}

/** Everything the reducer needs to start from a config. */
export function buildModelSetsBootstrap(
  config: AppConfig | null | undefined,
  presets: ProviderPresets
): { configSets: ApiConfigSet[]; activeConfigSetId: string; draft: ModelSetDraft } {
  const configSets = buildConfigSets(config);
  const activeConfigSetId = resolveActiveConfigSetId(config, configSets);
  const activeSet = configSets.find((set) => set.id === activeConfigSetId) ?? configSets[0];
  return {
    configSets,
    activeConfigSetId,
    draft: activeSet
      ? hydrateModelSetDraft(activeSet, presets, config?.customEndpoints ?? [])
      : emptyModelSetDraft(presets),
  };
}

export function createModelSetsState(
  config: AppConfig | null | undefined,
  presets: ProviderPresets
): ModelSetsState {
  return {
    ...buildModelSetsBootstrap(config, presets),
    modelMemory: {},
    // Empty until a real load completes, so the form never reads as "changed"
    // while it is still showing bootstrap defaults.
    savedSignature: '',
    pendingConfigSetAction: null,
    thinkingCapabilities: UNKNOWN_THINKING_CAPABILITIES,
    isSaving: false,
    isMutatingConfigSet: false,
  };
}

export function hasUnsavedModelSetChanges(state: ModelSetsState): boolean {
  return (
    state.savedSignature !== '' && buildModelSetSignature(state.draft) !== state.savedSignature
  );
}

export function modelSetsReducer(state: ModelSetsState, action: ModelSetsAction): ModelSetsState {
  switch (action.type) {
    case 'APPLY_PERSISTED':
      return {
        ...state,
        configSets: action.configSets,
        activeConfigSetId: action.activeConfigSetId,
        draft: action.draft,
        modelMemory: {},
        savedSignature: buildModelSetSignature(action.draft),
        pendingConfigSetAction: null,
      };

    case 'REBASE_PERSISTED':
      return {
        ...state,
        configSets: action.configSets,
        activeConfigSetId: action.activeConfigSetId,
      };

    case 'CHANGE_PROVIDER': {
      const leaving = modelMemoryKey(state.draft.provider, state.draft.endpointId);
      const arriving = modelMemoryKey(action.provider, action.endpointId);
      const modelMemory = { ...state.modelMemory, [leaving]: pickModelFields(state.draft) };
      return {
        ...state,
        modelMemory,
        draft: {
          ...state.draft,
          provider: action.provider,
          endpointId: action.endpointId,
          // The model belongs to the provider it was chosen for. Carrying it
          // across would leave, say, a Claude id selected on OpenAI.
          ...(modelMemory[arriving] ?? action.defaults),
        },
      };
    }

    case 'UPDATE_MODEL_FIELDS':
      return {
        ...state,
        draft: { ...state.draft, ...action.updater(pickModelFields(state.draft)) },
      };

    case 'SET_THINKING_LEVEL':
      return { ...state, draft: { ...state.draft, thinkingLevel: action.payload } };

    case 'CLEAR_THINKING_CAPABILITIES':
      // "Unknown" is not "unsupported". On mount no model is resolved yet, so the
      // capability effect runs once with nothing to ask about; treating that as
      // unsupported used to overwrite the level loaded from config with 'off' —
      // the user's stored preference was destroyed before it was ever displayed,
      // and the bogus value then got persisted by the next save.
      return { ...state, thinkingCapabilities: UNKNOWN_THINKING_CAPABILITIES };

    case 'SET_THINKING_CAPABILITIES':
      // Capabilities describe the *model*; `thinkingLevel` is the user's
      // model-independent intent. Clamping the stored value here corrupted that
      // intent on every model switch and — because the draft signature covers
      // thinkingLevel — left the form permanently "unsaved", which in turn
      // blocked config-set switching behind the unsaved-changes gate.
      //
      // Storage stays unclamped; the clamp is applied for display via
      // `effectiveThinkingLevel` and again at consumption in agent-runner.
      return { ...state, thinkingCapabilities: action.payload };

    case 'SET_PENDING_CONFIG_SET_ACTION':
      return { ...state, pendingConfigSetAction: action.payload };

    case 'MARK_SAVED':
      return { ...state, savedSignature: buildModelSetSignature(state.draft) };

    case 'SET_IS_SAVING':
      return { ...state, isSaving: action.payload };

    case 'SET_IS_MUTATING_CONFIG_SET':
      return { ...state, isMutatingConfigSet: action.payload };

    default: {
      // Exhaustiveness check — TypeScript will error if a case is missing
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
