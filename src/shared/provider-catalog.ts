/**
 * @module shared/provider-catalog
 *
 * SDK-free provider catalog types, builtin entries, and pure helpers.
 * Safe to import in the renderer bundle — no pi-ai imports here.
 *
 * The native half of the catalog (entries derived from getProviders() /
 * getModels()) is built in the main process and delivered over IPC via
 * `config.getProviderCatalog`. See `main/config/provider-catalog-native.ts`.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type ProviderKind = 'builtin' | 'native' | 'custom';

export type ProviderCategory = 'featured' | 'coding-plan' | 'inference' | 'local' | 'custom';

/**
 * Describes which form fields are shown for a given provider entry.
 * The settings form and ConfigModal read these flags instead of branching on provider
 * literals — so adding a new provider never requires touching the form logic.
 */
export interface ProviderFormShape {
  /** Show API key input (all except keyless ollama) */
  apiKey: boolean;
  /** Show editable base URL (custom, ollama, unknowns) */
  baseUrl: boolean;
  /** Show anthropic/openai/gemini protocol selector (custom only) */
  protocol: boolean;
  /** Show context-window / max-tokens inputs (custom, ollama, unknown) */
  contextWindow: boolean;
  /** Populate model dropdown from registry */
  modelDropdown: boolean;
  /** Allow free-text model id alongside or instead of the dropdown */
  manualModelToggle: boolean;
}

export interface ProviderModelOption {
  id: string;
  name: string;
}

export interface ProviderCatalogEntry {
  /** Stable catalog id — stored as ApiConfigSet.provider */
  id: string;
  /** Human-readable display name */
  name: string;
  kind: ProviderKind;
  category: ProviderCategory;
  /**
   * pi-ai provider key used for getModel / getModels / auth.
   * For builtin entries this may differ from `id` (e.g. gemini → 'google').
   */
  piProvider: string;
  /** Maps to pi-ai routing protocol */
  routeProtocol: 'anthropic' | 'openai' | 'gemini';
  /** Fixed base URL from the registry (informational for native entries) */
  baseUrl?: string;
  /** Env var name that holds the API key, e.g. 'ZAI_API_KEY' */
  keyEnvVar?: string;
  keyPlaceholder?: string;
  docsUrl?: string;
  formShape: ProviderFormShape;
  /** Pinned as a one-click chip in the featured row */
  featured?: boolean;
  /** Points to the base provider id for regional variants, e.g. 'minimax-cn' → 'minimax' */
  regionOf?: string;
  /** Short label rendered as a badge in the picker, e.g. 'CN' */
  regionTag?: string;
  /**
   * Model options fetched from the registry.
   * Populated by the main process and delivered over IPC.
   * Empty array for builtin cloud providers (they use API_PROVIDER_PRESETS).
   */
  modelOptions: ProviderModelOption[];
}

// ---------------------------------------------------------------------------
// Form-shape presets (reused across entry definitions)
// ---------------------------------------------------------------------------

const BUILTIN_CLOUD_SHAPE: ProviderFormShape = {
  apiKey: true,
  baseUrl: false,
  protocol: false,
  contextWindow: false,
  modelDropdown: true,
  manualModelToggle: false,
};

export const NATIVE_SHAPE: ProviderFormShape = {
  apiKey: true,
  baseUrl: false,
  protocol: false,
  contextWindow: false,
  modelDropdown: true,
  manualModelToggle: true,
};

const OLLAMA_SHAPE: ProviderFormShape = {
  apiKey: false,
  baseUrl: true,
  protocol: false,
  contextWindow: true,
  modelDropdown: false,
  manualModelToggle: true,
};

const CUSTOM_SHAPE: ProviderFormShape = {
  apiKey: true,
  baseUrl: true,
  protocol: true,
  contextWindow: true,
  modelDropdown: false,
  manualModelToggle: true,
};

// ---------------------------------------------------------------------------
// Builtin entries — the 6 legacy providers, hand-authored to preserve today's
// exact labels, form shapes, and routing semantics.
// ---------------------------------------------------------------------------

/**
 * The 6 builtin provider entries. Treated as immutable constants — do not
 * mutate entries at runtime. Callers that need a mutable copy must clone.
 */
export const BUILTIN_ENTRIES: ProviderCatalogEntry[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'builtin',
    category: 'featured',
    piProvider: 'openrouter',
    routeProtocol: 'openai',
    keyEnvVar: 'OPENROUTER_API_KEY',
    keyPlaceholder: 'sk-or-v1-...',
    docsUrl: 'https://openrouter.ai/docs',
    formShape: { ...BUILTIN_CLOUD_SHAPE },
    featured: true,
    modelOptions: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'builtin',
    category: 'featured',
    piProvider: 'anthropic',
    routeProtocol: 'anthropic',
    keyEnvVar: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-...',
    docsUrl: 'https://docs.anthropic.com',
    formShape: { ...BUILTIN_CLOUD_SHAPE },
    featured: true,
    modelOptions: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'builtin',
    category: 'featured',
    piProvider: 'openai',
    routeProtocol: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    keyPlaceholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/docs',
    formShape: { ...BUILTIN_CLOUD_SHAPE },
    featured: true,
    modelOptions: [],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'builtin',
    category: 'featured',
    // NOTE: pi-ai uses 'google' as the registry provider id for Gemini
    piProvider: 'google',
    routeProtocol: 'gemini',
    keyEnvVar: 'GEMINI_API_KEY',
    keyPlaceholder: 'AIza...',
    docsUrl: 'https://ai.google.dev/docs',
    formShape: { ...BUILTIN_CLOUD_SHAPE },
    featured: true,
    modelOptions: [],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'builtin',
    category: 'local',
    piProvider: 'ollama',
    routeProtocol: 'openai',
    docsUrl: 'https://ollama.com/docs',
    formShape: { ...OLLAMA_SHAPE },
    featured: true,
    modelOptions: [],
  },
  {
    id: 'custom',
    name: 'Custom',
    kind: 'custom',
    category: 'custom',
    piProvider: 'custom',
    routeProtocol: 'anthropic',
    formShape: { ...CUSTOM_SHAPE },
    featured: true,
    modelOptions: [],
  },
];

// ---------------------------------------------------------------------------
// NATIVE_PROVIDER_META — labels, categories, env vars, and region hints.
// Model lists, base URLs, and routing protocols come live from getModels().
// This is the ONLY hand-maintained data for native providers (~30 lines).
// ---------------------------------------------------------------------------

export interface NativeProviderMeta {
  name: string;
  category: ProviderCategory;
  keyEnvVar?: string;
  keyPlaceholder?: string;
  docsUrl?: string;
  regionOf?: string;
  regionTag?: string;
  /**
   * Explicit routing protocol override.
   * When set, this takes precedence over the api-field-derived protocol.
   * Use for providers that expose mixed API types or where the first model's
   * api field is not representative of the correct routing path.
   */
  routeProtocol?: 'anthropic' | 'openai' | 'gemini';
}

export const NATIVE_PROVIDER_META: Record<string, NativeProviderMeta> = {
  zai: {
    name: 'z.ai (GLM)',
    category: 'coding-plan',
    keyEnvVar: 'ZAI_API_KEY',
    keyPlaceholder: 'zai-...',
    docsUrl: 'https://z.ai/docs',
  },
  'zai-coding-cn': {
    name: 'z.ai Coding (CN)',
    category: 'coding-plan',
    keyEnvVar: 'ZAI_CODING_CN_API_KEY',
    keyPlaceholder: 'zai-...',
    regionOf: 'zai',
    regionTag: 'CN',
  },
  minimax: {
    name: 'MiniMax',
    category: 'coding-plan',
    keyEnvVar: 'MINIMAX_API_KEY',
    docsUrl: 'https://www.minimaxi.com/document/guides/developer',
    // Registry models use anthropic-messages — override so cold-start routing
    // (before the catalog builds) matches the derived protocol.
    routeProtocol: 'anthropic',
  },
  'minimax-cn': {
    name: 'MiniMax (CN)',
    category: 'coding-plan',
    keyEnvVar: 'MINIMAX_CN_API_KEY',
    regionOf: 'minimax',
    regionTag: 'CN',
    routeProtocol: 'anthropic',
  },
  'kimi-coding': {
    name: 'Kimi (Moonshot)',
    category: 'coding-plan',
    keyEnvVar: 'KIMI_API_KEY',
    docsUrl: 'https://platform.moonshot.cn/docs',
    // Registry models use anthropic-messages — override so cold-start routing
    // (before the catalog builds) matches the derived protocol.
    routeProtocol: 'anthropic',
  },
  moonshotai: {
    name: 'Moonshot',
    category: 'coding-plan',
    keyEnvVar: 'MOONSHOT_API_KEY',
    docsUrl: 'https://platform.moonshot.cn/docs',
  },
  'moonshotai-cn': {
    name: 'Moonshot (CN)',
    category: 'coding-plan',
    keyEnvVar: 'MOONSHOT_API_KEY',
    regionOf: 'moonshotai',
    regionTag: 'CN',
  },
  deepseek: {
    name: 'DeepSeek',
    category: 'coding-plan',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://platform.deepseek.com/docs',
  },
  'ant-ling': {
    name: 'Ant Ling',
    category: 'coding-plan',
    keyEnvVar: 'ANT_LING_API_KEY',
  },
  opencode: {
    name: 'OpenCode Zen',
    category: 'coding-plan',
    keyEnvVar: 'OPENCODE_API_KEY',
  },
  'opencode-go': {
    name: 'OpenCode Go',
    category: 'coding-plan',
    keyEnvVar: 'OPENCODE_API_KEY',
    regionOf: 'opencode',
  },
  xiaomi: {
    name: 'Xiaomi MiMo',
    category: 'coding-plan',
    keyEnvVar: 'XIAOMI_API_KEY',
  },
  'xiaomi-token-plan-cn': {
    name: 'Xiaomi MiMo (CN)',
    category: 'coding-plan',
    keyEnvVar: 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    regionOf: 'xiaomi',
    regionTag: 'CN',
  },
  'xiaomi-token-plan-ams': {
    name: 'Xiaomi MiMo (AMS)',
    category: 'coding-plan',
    keyEnvVar: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    regionOf: 'xiaomi',
    regionTag: 'AMS',
  },
  'xiaomi-token-plan-sgp': {
    name: 'Xiaomi MiMo (SGP)',
    category: 'coding-plan',
    keyEnvVar: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    regionOf: 'xiaomi',
    regionTag: 'SGP',
  },
  xai: {
    name: 'xAI (Grok)',
    category: 'inference',
    keyEnvVar: 'XAI_API_KEY',
    docsUrl: 'https://docs.x.ai',
  },
  groq: {
    name: 'Groq',
    category: 'inference',
    keyEnvVar: 'GROQ_API_KEY',
    docsUrl: 'https://console.groq.com/docs',
  },
  cerebras: {
    name: 'Cerebras',
    category: 'inference',
    keyEnvVar: 'CEREBRAS_API_KEY',
    docsUrl: 'https://inference-docs.cerebras.ai',
  },
  mistral: {
    name: 'Mistral',
    category: 'inference',
    keyEnvVar: 'MISTRAL_API_KEY',
    docsUrl: 'https://docs.mistral.ai',
  },
  together: {
    name: 'Together AI',
    category: 'inference',
    keyEnvVar: 'TOGETHER_API_KEY',
    docsUrl: 'https://docs.together.ai',
  },
  fireworks: {
    name: 'Fireworks',
    category: 'inference',
    keyEnvVar: 'FIREWORKS_API_KEY',
    docsUrl: 'https://docs.fireworks.ai',
  },
  nvidia: {
    name: 'NVIDIA NIM',
    category: 'inference',
    keyEnvVar: 'NVIDIA_API_KEY',
    docsUrl: 'https://docs.api.nvidia.com',
  },
  huggingface: {
    name: 'Hugging Face',
    category: 'inference',
    keyEnvVar: 'HF_TOKEN',
    docsUrl: 'https://huggingface.co/docs/api-inference',
  },
  'vercel-ai-gateway': {
    name: 'Vercel AI Gateway',
    category: 'inference',
    keyEnvVar: 'AI_GATEWAY_API_KEY',
    docsUrl: 'https://vercel.com/docs/ai/ai-gateway',
  },
};

/**
 * Provider ids excluded from the native catalog (v1).
 * These require multi-field credentials, OAuth, or are not simple API-key providers.
 * They remain reachable via the Custom escape hatch.
 */
export const EXCLUDED_NATIVE = new Set([
  'amazon-bedrock',
  'google-vertex',
  'azure-openai-responses',
  'cloudflare-workers-ai',
  'cloudflare-ai-gateway',
  'github-copilot',
  'openai-codex',
  // Already covered as builtin entries — exclude from native to avoid duplicates
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ollama',
]);

// ---------------------------------------------------------------------------
// Pure helpers — no pi-ai imports, safe anywhere
// ---------------------------------------------------------------------------

/** Title-case a kebab-case provider id, e.g. 'my-provider' → 'My Provider' */
export function titleCase(id: string): string {
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Map pi-ai model `api` string to a routing protocol.
 * Uses prefix matching so future google-* variants (e.g. google-generative-ai-stream)
 * are classified as 'gemini' rather than silently falling back to 'openai'.
 * `mistral-conversations` → 'openai' (Mistral is OpenAI-compatible at the routing layer).
 */
export function apiToRouteProtocol(api: string): 'anthropic' | 'openai' | 'gemini' {
  if (api === 'anthropic-messages') return 'anthropic';
  if (api.startsWith('google-')) return 'gemini';
  // mistral-conversations, openai-completions, openai-responses, bedrock-*, etc.
  return 'openai';
}

/** Ordering weight for category grouping in the provider picker. */
const CATEGORY_ORDER: Record<ProviderCategory, number> = {
  featured: 0,
  'coding-plan': 1,
  inference: 2,
  local: 3,
  custom: 4,
};

export function categoryOrder(category: ProviderCategory): number {
  return CATEGORY_ORDER[category] ?? 99;
}

/**
 * Find a catalog entry by id.
 * Returns `undefined` for unknown ids (caller decides the fallback).
 */
export function getCatalogEntry(
  catalog: ProviderCatalogEntry[],
  id: string
): ProviderCatalogEntry | undefined {
  return catalog.find((e) => e.id === id);
}

/**
 * Get featured entries (the chips shown at the top of the picker).
 * Returns entries in the order they appear in the catalog — callers that
 * need a guaranteed builtin order should pass BUILTIN_ENTRIES directly.
 */
export function getFeaturedEntries(catalog: ProviderCatalogEntry[]): ProviderCatalogEntry[] {
  return catalog.filter((e) => e.featured);
}

/**
 * Get non-featured entries (native + custom kinds), sorted by category then name.
 * Builtin entries with featured=false would also appear here, but in practice
 * all builtin entries are featured. The filter is intentionally kind-agnostic
 * so future non-featured builtins surface correctly rather than being hidden.
 */
export function getNonFeaturedEntries(catalog: ProviderCatalogEntry[]): ProviderCatalogEntry[] {
  return catalog
    .filter((e) => !e.featured)
    .sort((a, b) => {
      const catDiff = categoryOrder(a.category) - categoryOrder(b.category);
      if (catDiff !== 0) return catDiff;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Group entries by category for the picker's grouped list.
 * Entries within each group are sorted by name for deterministic ordering.
 */
export function groupEntriesByCategory(
  entries: ProviderCatalogEntry[]
): Array<{ category: ProviderCategory; entries: ProviderCatalogEntry[] }> {
  const groups = new Map<ProviderCategory, ProviderCatalogEntry[]>();
  for (const entry of entries) {
    const existing = groups.get(entry.category);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(entry.category, [entry]);
    }
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => categoryOrder(a) - categoryOrder(b))
    .map(([category, groupEntries]) => ({
      category,
      entries: [...groupEntries].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/**
 * Set of all native provider ids in the v1 allowlist.
 * Derived from NATIVE_PROVIDER_META keys — the single source of truth for
 * which providers are native vs builtin/custom.
 * Used to gate cold-start fallback behavior in resolvePiRouteProtocol.
 */
export const NATIVE_PROVIDER_IDS: ReadonlySet<string> = new Set(Object.keys(NATIVE_PROVIDER_META));

const VALID_PROTOCOLS = new Set(['anthropic', 'openai', 'gemini']);

/**
 * Cold-start route protocol map for native providers.
 *
 * Used by `resolvePiRouteProtocol` when the async catalog hasn't resolved yet
 * so native providers still get a valid routing protocol (not a raw provider id
 * string) during cold start. Derived from NATIVE_PROVIDER_META.routeProtocol
 * overrides; providers not listed here default to 'openai' (the most common
 * native protocol).
 *
 * This is the ONLY place cold-start protocol is hand-specified. The full
 * catalog (built from getModels()) remains the authoritative source at runtime.
 * Values are validated at build time against the known protocol set so invalid
 * strings in NATIVE_PROVIDER_META cannot silently produce bad routing.
 */
export const NATIVE_COLD_START_PROTOCOL: Record<string, 'anthropic' | 'openai' | 'gemini'> =
  Object.fromEntries(
    Object.entries(NATIVE_PROVIDER_META)
      .filter(([id, meta]) => {
        if (meta.routeProtocol === undefined) return false;
        if (!VALID_PROTOCOLS.has(meta.routeProtocol)) {
          // Should never happen with correct NATIVE_PROVIDER_META authoring,
          // but guard defensively so bad values don't silently enter the map.
          // console.warn used since this runs at module-init before the logger
          // is available; only reachable via incorrect authoring.
          console.warn(
            `[ProviderCatalog] NATIVE_PROVIDER_META['${id}'].routeProtocol ` +
              `'${meta.routeProtocol}' is not a valid protocol ` +
              `(anthropic|openai|gemini) — ignoring.`
          );
          return false;
        }
        return true;
      })
      .map(([id, meta]) => [id, meta.routeProtocol as 'anthropic' | 'openai' | 'gemini'])
  );
