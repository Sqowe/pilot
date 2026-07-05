import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import type { UserMessage as PiUserMessage } from '@earendil-works/pi-ai';
// `completeSimple` moved off the pi-ai root entrypoint to `/compat` in 0.80.0.
import { completeSimple } from '@earendil-works/pi-ai/compat';
import type {
  AppConfig,
  CustomProtocolType,
  ProviderType,
  EmbeddingProviderType,
} from '../config/config-store';
import { configStore } from '../config/config-store';
import {
  normalizeOpenAICompatibleBaseUrl,
  resolveOllamaCredentials,
  resolveOpenAICredentials,
} from '../config/auth-utils';
import {
  buildSyntheticPiModel,
  resolvePiRegistryModel,
  resolvePiModelString,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
  applyPiModelRuntimeOverrides,
  inferPiApi,
} from '../claude/pi-model-resolution';
import { log, logWarn } from '../utils/logger';
import {
  configureLocalEmbeddingCacheDir,
  embedLocal,
  type EmbeddingKind,
  type LocalEmbeddingProgress,
} from './local-embedding-provider';

export interface MemoryCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface MemoryCompletionResponse {
  text: string;
}

/** Result of probing the currently-configured memory LLM + embedding providers. */
export interface MemoryModelCheckResult {
  llm: { ok: boolean; error?: string };
  /** `skipped` is true when embeddings are disabled (nothing to check). */
  embedding: { ok: boolean; error?: string; skipped?: boolean };
}

export interface MemoryLLMClientLike {
  complete(request: MemoryCompletionRequest): Promise<MemoryCompletionResponse>;
  /** `kind` selects the local model's query/document prefix; ignored by remote providers. */
  embed(text: string, kind?: EmbeddingKind): Promise<number[]>;
}

interface MemoryModelConfig {
  inheritFromActive?: boolean;
  /** Accepts EmbeddingProviderType so callers can pass embedding config directly; 'local' is handled before this reaches normalizeModelConfig. */
  provider?: EmbeddingProviderType;
  customProtocol?: CustomProtocolType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

interface ResolvedMemoryModelConfig {
  /** Always a ProviderType — 'local' is handled before normalizeModelConfig is called. */
  provider: ProviderType;
  customProtocol?: CustomProtocolType;
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs: number;
}

function normalizeModelConfig(
  appConfig: AppConfig,
  input: MemoryModelConfig | undefined,
  fallbackModel: string
): ResolvedMemoryModelConfig {
  const inherit = input?.inheritFromActive !== false;
  const activeProvider = appConfig.provider;
  const activeProtocol = appConfig.customProtocol;
  const activeBaseUrl = appConfig.baseUrl;
  const activeApiKey = appConfig.apiKey;
  const activeModel = appConfig.model;

  const rawProvider = inherit ? activeProvider : input?.provider || activeProvider;
  // 'local' is always handled before normalizeModelConfig is called (in embed());
  // if it somehow arrives here, fall back to the active provider.
  const provider: ProviderType =
    rawProvider === 'local' ? activeProvider : (rawProvider as ProviderType);
  const customProtocol = inherit ? activeProtocol : input?.customProtocol || activeProtocol;
  const apiKey = inherit ? activeApiKey : input?.apiKey || '';
  const baseUrl = inherit ? activeBaseUrl : input?.baseUrl || activeBaseUrl;
  const model = (input?.model || (inherit ? activeModel : '') || fallbackModel).trim();
  const timeoutMs = Math.max(5_000, input?.timeoutMs || 180_000);

  return {
    provider,
    customProtocol,
    apiKey,
    baseUrl,
    model,
    timeoutMs,
  };
}

function buildAppConfig(base: AppConfig, resolved: ResolvedMemoryModelConfig): AppConfig {
  return {
    ...base,
    // resolved.provider is ProviderType — 'local' never reaches this function.
    provider: resolved.provider,
    customProtocol: resolved.customProtocol,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
  };
}

export interface MemoryLLMClientOptions {
  /** Called during first-use local model download — wire to IPC from index.ts. */
  onLocalEmbeddingProgress?: (p: LocalEmbeddingProgress) => void;
  /** Returns the storage root path for the local model cache. Injected to keep this module Electron-free. */
  getStorageRoot?: () => string;
}

export class MemoryLLMClient implements MemoryLLMClientLike {
  private readonly onLocalEmbeddingProgress?: (p: LocalEmbeddingProgress) => void;
  private readonly getStorageRoot: () => string;
  /** Cache dir is configured once — subsequent calls are no-ops unless it changes. */
  private configuredCacheDir = '';

  constructor(
    private readonly getConfig: () => AppConfig = () => configStore.getAll(),
    options?: MemoryLLMClientOptions
  ) {
    this.onLocalEmbeddingProgress = options?.onLocalEmbeddingProgress;
    // Default storage root uses os.homedir() so non-Electron contexts (tests, CLI)
    // never throw on construction. Callers should inject app.getPath('userData')
    // via options.getStorageRoot for the canonical production path.
    this.getStorageRoot =
      options?.getStorageRoot ?? (() => path.join(os.homedir(), '.open-cowork', 'memory'));
  }

  async complete(request: MemoryCompletionRequest): Promise<MemoryCompletionResponse> {
    const appConfig = this.getConfig();
    const llmConfig = normalizeModelConfig(
      appConfig,
      appConfig.memoryRuntime?.llm,
      appConfig.model
    );
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Memory LLM request timed out after ${llmConfig.timeoutMs}ms`));
        }, llmConfig.timeoutMs);
        timeout.unref?.();
      });

      // Resolve the model for the memory system's own config — without mutating
      // the shared authStorage. This avoids credential contamination between the
      // memory system and the main agent when they use different providers/keys.
      const memoryAppConfig = buildAppConfig(appConfig, llmConfig);
      const provider = resolvePiRouteProtocol(
        memoryAppConfig.provider,
        memoryAppConfig.customProtocol
      );
      const modelString = resolvePiModelString({
        model: memoryAppConfig.model,
        provider: memoryAppConfig.provider,
        customProtocol: memoryAppConfig.customProtocol,
      });
      const effectiveBaseUrl = memoryAppConfig.baseUrl?.trim()
        ? normalizeOpenAICompatibleBaseUrl(memoryAppConfig.baseUrl)
        : undefined;

      let piModel = resolvePiRegistryModel(modelString, {
        configProvider: provider,
        customBaseUrl: effectiveBaseUrl,
        rawProvider: memoryAppConfig.provider,
        customProtocol: memoryAppConfig.customProtocol,
      });

      if (!piModel) {
        const effectiveProtocol = provider as CustomProtocolType;
        const api = effectiveBaseUrl ? inferPiApi(effectiveProtocol) : undefined;
        const synthetic = resolveSyntheticPiModelFallback({
          rawModel: memoryAppConfig.model,
          resolvedModelString: modelString,
          rawProvider: memoryAppConfig.provider,
          routeProtocol: effectiveProtocol,
          baseUrl: effectiveBaseUrl,
        });
        piModel = buildSyntheticPiModel(
          synthetic.modelId,
          synthetic.provider,
          effectiveProtocol,
          effectiveBaseUrl || '',
          api
        );
        piModel = applyPiModelRuntimeOverrides(piModel, {
          configProvider: provider,
          customBaseUrl: effectiveBaseUrl,
          rawProvider: memoryAppConfig.provider,
          customProtocol: memoryAppConfig.customProtocol,
        });
      }

      // Call completeSimple directly with explicit apiKey — no shared state mutation
      const apiKey = memoryAppConfig.apiKey?.trim() || '';
      const userMsg: PiUserMessage = {
        role: 'user',
        content: request.userPrompt,
        timestamp: Date.now(),
      };

      log(
        '[MemoryLLM] Calling completeSimple:',
        piModel.provider,
        piModel.id,
        'baseUrl:',
        piModel.baseUrl
      );

      const response = await Promise.race([
        completeSimple(
          piModel,
          {
            systemPrompt: request.systemPrompt,
            messages: [userMsg],
          },
          {
            apiKey: apiKey || undefined,
            temperature: request.temperature ?? 0,
            maxTokens: request.maxTokens ?? 16_000,
            signal: controller.signal,
          }
        ),
        timeoutPromise,
      ]);

      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage || 'Memory LLM provider returned an error');
      }

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
        .trim();

      return { text };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async embed(text: string, kind: EmbeddingKind = 'document'): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) {
      return [];
    }

    const appConfig = this.getConfig();
    if (!appConfig.memoryRuntime?.useEmbedding) {
      return [];
    }

    // Check for local provider before normalizeModelConfig — the local branch
    // bypasses all remote credential resolution and uses the in-process ONNX pipeline.
    const rawEmbeddingProvider = appConfig.memoryRuntime.embedding?.provider;
    if (rawEmbeddingProvider === 'local') {
      const configuredRoot = appConfig.memoryRuntime.storageRoot?.trim();
      const storageRoot = configuredRoot || this.getStorageRoot();
      // Configure cache dir only on first call or when storageRoot changes.
      if (storageRoot !== this.configuredCacheDir) {
        if (this.configuredCacheDir) {
          logWarn(
            '[MemoryLLMClient] storageRoot changed after pipeline init — cache dir updated:',
            storageRoot
          );
        }
        configureLocalEmbeddingCacheDir(storageRoot);
        this.configuredCacheDir = storageRoot;
      }
      return embedLocal(trimmed, kind, this.onLocalEmbeddingProgress);
    }

    const embedConfig = normalizeModelConfig(
      appConfig,
      appConfig.memoryRuntime.embedding,
      'text-embedding-3-small'
    );

    const provider = embedConfig.provider;
    const protocol = embedConfig.customProtocol;
    const isOpenAiCompatible =
      provider === 'openai' ||
      provider === 'openrouter' ||
      provider === 'ollama' ||
      (provider === 'custom' && protocol === 'openai');

    if (!isOpenAiCompatible) {
      logWarn(
        '[MemoryLLMClient] Embedding requested for unsupported provider; returning empty embedding:',
        provider
      );
      return [];
    }

    const resolved =
      provider === 'ollama'
        ? resolveOllamaCredentials({
            provider,
            customProtocol: protocol,
            apiKey: embedConfig.apiKey,
            baseUrl: embedConfig.baseUrl,
          })
        : resolveOpenAICredentials({
            provider,
            customProtocol: protocol,
            apiKey: embedConfig.apiKey,
            baseUrl: embedConfig.baseUrl,
          });

    const client = new OpenAI({
      apiKey: resolved?.apiKey || embedConfig.apiKey,
      baseURL: resolved?.baseUrl || normalizeOpenAICompatibleBaseUrl(embedConfig.baseUrl),
      timeout: embedConfig.timeoutMs,
    });
    const response = await client.embeddings.create({
      model: embedConfig.model,
      input: trimmed,
    });
    return response.data[0]?.embedding || [];
  }

  /**
   * Probe the currently-configured LLM and embedding providers without saving
   * anything. Used by the Settings "Check models availability" step before a
   * model-config change can be saved.
   *
   * Bind a throwaway client to the *draft* config to check unsaved settings:
   *   new MemoryLLMClient(() => ({ ...appConfig, memoryRuntime: draft }), opts)
   *
   * - LLM: a 1-token, temperature-0 completion — the only reliable cross-provider
   *   proof that the key + model + endpoint actually work.
   * - Embedding: a tiny embed('ping'). For the local provider this warms up
   *   (downloads if needed) and confirms the pipeline loads; for remote it makes a
   *   real embeddings call. Skipped entirely when useEmbedding is off.
   */
  async checkAvailability(): Promise<MemoryModelCheckResult> {
    const llm = await this.probeLLM();
    const embedding = await this.probeEmbedding();
    return { llm, embedding };
  }

  private async probeLLM(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.complete({ systemPrompt: '', userPrompt: 'ping', temperature: 0, maxTokens: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async probeEmbedding(): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
    if (!this.getConfig().memoryRuntime?.useEmbedding) {
      return { ok: true, skipped: true };
    }
    try {
      const vector = await this.embed('ping', 'query');
      if (!vector.length) {
        // embed() returns [] (rather than throwing) for unsupported providers.
        return {
          ok: false,
          error: 'Embedding returned an empty vector — provider or model not supported.',
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
