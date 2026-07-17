/**
 * The 6 legacy builtin provider ids. Use this for exhaustive switches
 * over the builtin set.
 */
export type BuiltinProviderType =
  | 'openrouter'
  | 'anthropic'
  | 'custom'
  | 'openai'
  | 'gemini'
  | 'ollama';

/**
 * Open provider type — accepts any catalog id including native providers
 * (e.g. 'zai', 'minimax', 'deepseek') and the 6 legacy builtin ids.
 * Use BuiltinProviderType when you need exhaustive matching over the 6.
 */
export type SharedProviderType = string;

export type SharedCustomProtocolType = 'anthropic' | 'openai' | 'gemini';

export interface SharedProviderPreset {
  name: string;
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
  keyPlaceholder: string;
  keyHint: string;
}

export interface SharedProviderPresets {
  openrouter: SharedProviderPreset;
  anthropic: SharedProviderPreset;
  custom: SharedProviderPreset;
  openai: SharedProviderPreset;
  gemini: SharedProviderPreset;
  ollama: SharedProviderPreset;
}

/**
 * Look up a preset by provider id using own-property checks only.
 * Prototype-chain keys (e.g. `__proto__`, `constructor`) always return undefined.
 * Returns undefined for unknown/native ids.
 */
export function getPresetForProvider(
  presets: SharedProviderPresets,
  providerId: string
): SharedProviderPreset | undefined {
  if (!Object.prototype.hasOwnProperty.call(presets, providerId)) return undefined;
  return (presets as unknown as Record<string, SharedProviderPreset | undefined>)[providerId];
}

export interface ModelInputGuidance {
  placeholder: string;
  hint: string;
}

export const API_PROVIDER_PRESETS: SharedProviderPresets = {
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'anthropic/claude-fable-5', name: 'anthropic/claude-fable-5' },
      { id: 'anthropic/claude-sonnet-5', name: 'anthropic/claude-sonnet-5' },
      { id: 'anthropic/claude-opus-4.8', name: 'anthropic/claude-opus-4.8' },
      { id: 'anthropic/claude-opus-4-6', name: 'anthropic/claude-opus-4-6' },
      { id: 'anthropic/claude-sonnet-4-6', name: 'anthropic/claude-sonnet-4-6' },
      { id: 'anthropic/claude-haiku-4-5', name: 'anthropic/claude-haiku-4-5' },
      { id: 'openai/gpt-5.5', name: 'openai/gpt-5.5' },
      { id: 'openai/gpt-5.4', name: 'openai/gpt-5.4' },
      { id: 'openai/gpt-5.3-codex', name: 'openai/gpt-5.3-codex' },
      { id: 'google/gemini-3.1-pro-preview', name: 'google/gemini-3.1-pro-preview' },
      { id: 'google/gemini-3-flash-preview', name: 'google/gemini-3-flash-preview' },
      { id: 'google/gemini-2.5-flash', name: 'google/gemini-2.5-flash' },
    ],
    keyPlaceholder: 'sk-or-v1-...',
    keyHint: 'api.providerHints.openrouter.keyHint',
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-fable-5', name: 'claude-fable-5' },
      { id: 'claude-sonnet-5', name: 'claude-sonnet-5' },
      { id: 'claude-opus-4-8', name: 'claude-opus-4-8' },
      { id: 'claude-opus-4-6', name: 'claude-opus-4-6' },
      { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' },
      { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5' },
      { id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' },
      { id: 'claude-3-7-sonnet-latest', name: 'claude-3-7-sonnet-latest' },
    ],
    keyPlaceholder: 'sk-ant-...',
    keyHint: 'api.providerHints.anthropic.keyHint',
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5.5', name: 'gpt-5.5' },
      { id: 'gpt-5.5-pro', name: 'gpt-5.5-pro' },
      { id: 'gpt-5.4', name: 'gpt-5.4' },
      { id: 'gpt-5.4-pro', name: 'gpt-5.4-pro' },
      { id: 'gpt-5.4-mini', name: 'gpt-5.4-mini' },
      { id: 'gpt-5.4-nano', name: 'gpt-5.4-nano' },
      { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' },
      { id: 'o3', name: 'o3' },
      { id: 'o4-mini', name: 'o4-mini' },
    ],
    keyPlaceholder: 'sk-...',
    keyHint: 'api.providerHints.openai.keyHint',
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: [
      { id: 'gemini-3.5-flash', name: 'gemini-3.5-flash' },
      { id: 'gemini-3.1-pro-preview', name: 'gemini-3.1-pro-preview' },
      { id: 'gemini-3.1-flash-lite-preview', name: 'gemini-3.1-flash-lite-preview' },
      { id: 'gemini-3.1-flash-lite', name: 'gemini-3.1-flash-lite' },
      { id: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview' },
      { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro' },
      { id: 'gemini-2.5-flash', name: 'gemini-2.5-flash' },
      { id: 'gemini-2.5-flash-lite', name: 'gemini-2.5-flash-lite' },
    ],
    keyPlaceholder: 'AIza...',
    keyHint: 'api.providerHints.gemini.keyHint',
  },
  ollama: {
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'qwen3.5:0.8b', name: 'qwen3.5:0.8b' },
      { id: 'llama3.2:latest', name: 'llama3.2:latest' },
      { id: 'deepseek-r1:latest', name: 'deepseek-r1:latest' },
    ],
    keyPlaceholder: 'sk-xxx',
    keyHint: 'api.providerHints.ollama.keyHint',
  },
  custom: {
    name: 'More Models',
    baseUrl: '',
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
      { id: 'kimi-k3', name: 'kimi-k3' },
      { id: 'kimi-k2-thinking', name: 'kimi-k2-thinking' },
      { id: 'glm-5', name: 'glm-5' },
      { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
      { id: 'qwen-max', name: 'qwen-max' },
      { id: 'mistral-large-latest', name: 'mistral-large-latest' },
    ],
    keyPlaceholder: 'sk-xxx',
    keyHint: 'api.providerHints.custom.keyHint',
  },
};

/**
 * Curated model pick-lists for the pi-native model picker (used when the pi SDK
 * catalog is active). Each entry maps an OC provider id to:
 *   - `piProvider`: the pi-ai catalog provider id (may differ, e.g. 'google' vs 'gemini')
 *   - `pick`: ordered list of model IDs to show.
 *
 * NOTE on naming conventions: provider catalogs use different model-ID formats.
 * For example, Anthropic native uses dashes (claude-opus-4-8) while OpenRouter
 * uses dots for the same model (anthropic/claude-opus-4.8). Both are correct for
 * their respective providers and verified against the pi-ai catalog.
 */
export const PI_AI_CURATED_PRESETS: Record<string, { piProvider: string; pick: string[] }> = {
  openrouter: {
    piProvider: 'openrouter',
    pick: [
      'anthropic/claude-fable-5',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-5.5',
      'openai/gpt-5.4',
      'openai/gpt-5.3-codex',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3-flash-preview',
      'google/gemini-2.5-flash',
    ],
  },
  anthropic: {
    piProvider: 'anthropic',
    pick: [
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
      'claude-3-7-sonnet-latest',
    ],
  },
  openai: {
    piProvider: 'openai',
    pick: [
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.4',
      'gpt-5.4-pro',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.3-codex',
      'o3',
      'o4-mini',
    ],
  },
  gemini: {
    piProvider: 'google',
    pick: [
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3.1-flash-lite',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
  },
};

export function getModelInputGuidance(
  provider: SharedProviderType,
  customProtocol: SharedCustomProtocolType = 'anthropic'
): ModelInputGuidance {
  if (provider === 'openrouter') {
    return {
      placeholder: 'openai/gpt-5.5, anthropic/claude-fable-5, google/gemini-3.1-pro-preview',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'custom' && customProtocol === 'openai') {
    return {
      placeholder: 'deepseek-chat, deepseek-reasoner, qwen-max, gpt-5.5-pro',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'custom' && customProtocol === 'gemini') {
    return {
      placeholder: 'gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-2.5-flash',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'custom') {
    return {
      placeholder: 'kimi-k3, glm-5, claude-fable-5',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'openai') {
    return {
      placeholder: 'gpt-5.4, gpt-5.4-mini, o3',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  if (provider === 'ollama') {
    return {
      placeholder: 'qwen3.5:0.8b, llama3.2:latest, deepseek-r1:latest',
      hint: 'Use the exact model ID returned by your Ollama server.',
    };
  }

  if (provider === 'gemini') {
    return {
      placeholder: 'gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-2.5-flash',
      hint: 'Use the exact model ID for the selected protocol or endpoint.',
    };
  }

  return {
    placeholder: 'claude-fable-5, claude-sonnet-5',
    hint: 'Use the exact model ID for the selected protocol or endpoint.',
  };
}
