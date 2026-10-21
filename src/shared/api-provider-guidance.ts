import type { SharedCustomProtocolType, SharedProviderType } from './api-model-presets';

export type CommonProviderSetupId =
  | 'openrouter'
  | 'deepseek'
  | 'kimi-coding'
  | 'glm-anthropic'
  | 'ollama'
  | 'gemini-custom'
  | 'minimax'
  | 'generic-openai';

export interface CommonProviderSetup {
  id: CommonProviderSetupId;
  nameKey: string;
  noteKey: string;
  applyProvider: SharedProviderType;
  recommendedProtocol: SharedCustomProtocolType;
  recommendedBaseUrl: string;
  exampleModel: string;
  protocolLabel?: string;
  /**
   * The catalog provider this setup's service is, when the catalog lists that
   * very service. The Providers tab then sends such an address to the
   * provider's own entry instead of offering to make a custom endpoint of it.
   * Read through `catalogProviderOfSetup`.
   */
  catalogProvider?: Exclude<SharedProviderType, 'custom'>;
  matcher?: {
    hosts?: string[];
    hostContains?: string[];
    ports?: string[];
    pathPrefixes?: string[];
    pathIncludes?: string[];
  };
}

export type ProviderGuidanceHintCode =
  | 'empty_probe_response'
  | 'probe_response_mismatch'
  | 'prefer_provider_tab'
  | 'protocol_mismatch';

export type ProviderGuidanceErrorHintKind =
  | 'emptyProbeGeneric'
  | 'emptyProbeDetected'
  | 'probeMismatchGeneric'
  | 'probeMismatchDetected';

/**
 * Ready-made setups for a custom endpoint.
 *
 * This list is older than the provider catalog, and the catalog — built from
 * the installed pi — keeps growing. A service listed here may since have
 * become a catalog provider of its own; a custom endpoint made from its setup
 * is then that provider under another name, with a second copy of its key.
 *
 * So the list is re-checked against the catalog on every pi uplift, and the
 * check is a test rather than a note: `tests/provider-setups-vs-catalog.test.ts`
 * reads the installed pi's own provider data and fails when what it finds no
 * longer matches what these setups were last checked against. Decide again
 * there which setups send their address to a catalog provider
 * (`catalogProvider`) and which stay custom endpoints. Rule and reasons:
 * AI_MAIN_PROCESS.md §1, "Ready-made setups and the catalog".
 */
export const COMMON_PROVIDER_SETUPS: CommonProviderSetup[] = [
  {
    id: 'openrouter',
    nameKey: 'api.guidance.setups.openrouter.name',
    noteKey: 'api.guidance.setups.openrouter.note',
    applyProvider: 'openrouter',
    recommendedProtocol: 'anthropic',
    recommendedBaseUrl: 'https://openrouter.ai/api/v1',
    exampleModel: 'anthropic/claude-sonnet-4-6',
    protocolLabel: 'OpenRouter',
    // A provider of its own in the catalog, not an endpoint.
    catalogProvider: 'openrouter',
    matcher: {
      hosts: ['openrouter.ai'],
      pathPrefixes: ['/', '/api', '/api/v1'],
    },
  },
  {
    id: 'deepseek',
    nameKey: 'api.guidance.setups.deepseek.name',
    noteKey: 'api.guidance.setups.deepseek.note',
    applyProvider: 'custom',
    recommendedProtocol: 'openai',
    recommendedBaseUrl: 'https://api.deepseek.com/v1',
    exampleModel: 'deepseek-chat',
    matcher: {
      hosts: ['api.deepseek.com'],
      pathPrefixes: ['/v1'],
    },
  },
  {
    id: 'kimi-coding',
    nameKey: 'api.guidance.setups.kimi.name',
    noteKey: 'api.guidance.setups.kimi.note',
    applyProvider: 'custom',
    recommendedProtocol: 'openai',
    recommendedBaseUrl: 'https://api.kimi.com/coding/v1',
    exampleModel: 'kimi-k2-thinking',
    // The catalog's `kimi-coding` is this address and this protocol — OpenAI Chat
    // Completions since pi 1.3.0, Anthropic Messages at `/coding` before it. The
    // older address is still recognised and sent to the same provider.
    catalogProvider: 'kimi-coding',
    matcher: {
      hosts: ['api.kimi.com'],
      pathPrefixes: ['/coding', '/coding/v1'],
    },
  },
  {
    id: 'glm-anthropic',
    nameKey: 'api.guidance.setups.glm.name',
    noteKey: 'api.guidance.setups.glm.note',
    applyProvider: 'custom',
    recommendedProtocol: 'anthropic',
    recommendedBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    exampleModel: 'glm-5',
    matcher: {
      hosts: ['open.bigmodel.cn'],
      pathIncludes: ['/api/anthropic'],
    },
  },
  {
    id: 'ollama',
    nameKey: 'api.guidance.setups.ollama.name',
    noteKey: 'api.guidance.setups.ollama.note',
    applyProvider: 'ollama',
    recommendedProtocol: 'openai',
    recommendedBaseUrl: 'http://localhost:11434/v1',
    exampleModel: 'qwen3.5:0.8b',
    protocolLabel: 'Ollama',
    // A provider of its own in the catalog, not an endpoint.
    catalogProvider: 'ollama',
    matcher: {
      hosts: ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'],
      ports: ['11434'],
      pathPrefixes: ['', '/', '/v1'],
    },
  },
  {
    id: 'gemini-custom',
    nameKey: 'api.guidance.setups.gemini.name',
    noteKey: 'api.guidance.setups.gemini.note',
    applyProvider: 'custom',
    recommendedProtocol: 'gemini',
    recommendedBaseUrl: 'https://generativelanguage.googleapis.com',
    exampleModel: 'gemini-2.5-flash',
    // Google's own address: the catalog's `gemini` is this address and protocol.
    catalogProvider: 'gemini',
    matcher: {
      hosts: ['generativelanguage.googleapis.com'],
    },
  },
  {
    id: 'minimax',
    nameKey: 'api.guidance.setups.minimax.name',
    noteKey: 'api.guidance.setups.minimax.note',
    applyProvider: 'custom',
    recommendedProtocol: 'openai',
    recommendedBaseUrl: 'https://api.minimax.chat/v1',
    exampleModel: 'MiniMax-M2.5',
    matcher: {
      hosts: ['api.minimax.chat'],
      hostContains: ['minimax'],
      pathPrefixes: ['/v1'],
    },
  },
  {
    id: 'generic-openai',
    nameKey: 'api.guidance.setups.genericOpenAI.name',
    noteKey: 'api.guidance.setups.genericOpenAI.note',
    applyProvider: 'custom',
    recommendedProtocol: 'openai',
    recommendedBaseUrl: 'https://your-provider.example/v1',
    exampleModel: 'deepseek-chat',
  },
];

function normalizeBaseUrl(baseUrl: string | undefined): URL | null {
  const value = baseUrl?.trim();
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isParsableBaseUrl(baseUrl: string | undefined): boolean {
  return normalizeBaseUrl(baseUrl) !== null;
}

function matchesHost(hostname: string, candidates: string[] | undefined): boolean {
  if (!candidates?.length) {
    return true;
  }
  const host = hostname.toLowerCase();
  return candidates.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

function matchesHostContains(hostname: string, candidates: string[] | undefined): boolean {
  if (!candidates?.length) {
    return true;
  }
  const host = hostname.toLowerCase();
  return candidates.some((candidate) => host.includes(candidate.toLowerCase()));
}

function matchesPath(pathname: string, setup: CommonProviderSetup): boolean {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const { pathPrefixes, pathIncludes } = setup.matcher || {};

  const prefixOk =
    !pathPrefixes?.length ||
    pathPrefixes.some((prefix) => {
      const value = prefix || '/';
      return normalizedPath === value || normalizedPath.startsWith(`${value}/`);
    });
  if (!prefixOk) {
    return false;
  }

  const includesOk =
    !pathIncludes?.length || pathIncludes.some((fragment) => normalizedPath.includes(fragment));
  return includesOk;
}

function matchesPort(portname: string, candidates: string[] | undefined): boolean {
  if (!candidates?.length) {
    return true;
  }
  const value = portname || '';
  return candidates.includes(value);
}

export function detectCommonProviderSetup(baseUrl: string | undefined): CommonProviderSetup | null {
  const parsed = normalizeBaseUrl(baseUrl);
  if (!parsed) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  for (const setup of COMMON_PROVIDER_SETUPS) {
    if (!setup.matcher) {
      continue;
    }
    if (!matchesHost(hostname, setup.matcher.hosts)) {
      continue;
    }
    if (!matchesHostContains(hostname, setup.matcher.hostContains)) {
      continue;
    }
    if (!matchesPort(parsed.port, setup.matcher.ports)) {
      continue;
    }
    if (!matchesPath(pathname, setup)) {
      continue;
    }
    return setup;
  }

  return null;
}

/**
 * The catalog provider a setup's service is, or null when it is a service of
 * its own. Whether the catalog really has that provider is the caller's to
 * check: the catalog is built from the installed pi and loaded at run time.
 */
export function catalogProviderOfSetup(
  setup: Pick<CommonProviderSetup, 'catalogProvider'>
): string | null {
  return setup.catalogProvider ?? null;
}

export function orderCommonProviderSetups(
  activeId?: CommonProviderSetupId | null
): CommonProviderSetup[] {
  if (!activeId) {
    return COMMON_PROVIDER_SETUPS;
  }

  return [...COMMON_PROVIDER_SETUPS].sort((left, right) => {
    if (left.id === activeId) return -1;
    if (right.id === activeId) return 1;
    return 0;
  });
}

export function getFallbackOpenAISetup(): CommonProviderSetup {
  return COMMON_PROVIDER_SETUPS.find((setup) => setup.id === 'generic-openai')!;
}

function detectProviderGuidanceHintCode(
  details: string | undefined
): ProviderGuidanceHintCode | null {
  const value = details?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === 'empty_probe_response') {
    return 'empty_probe_response';
  }
  if (value.startsWith('probe_response_mismatch:')) {
    return 'probe_response_mismatch';
  }
  return null;
}

export function resolveProviderGuidanceErrorHint(
  details: string | undefined,
  setup?: CommonProviderSetup | null
): ProviderGuidanceErrorHintKind | null {
  const hintCode = detectProviderGuidanceHintCode(details);
  if (!hintCode) {
    return null;
  }

  if (hintCode === 'empty_probe_response') {
    return setup ? 'emptyProbeDetected' : 'emptyProbeGeneric';
  }

  return setup ? 'probeMismatchDetected' : 'probeMismatchGeneric';
}
