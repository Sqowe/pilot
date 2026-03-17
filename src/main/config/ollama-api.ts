import type { ProviderModelInfo } from '../../renderer/types';
import { normalizeOllamaBaseUrl } from './auth-utils';

const REQUEST_TIMEOUT_MS = 30000;

function buildBaseUrl(baseUrl: string | undefined): string {
  return normalizeOllamaBaseUrl(baseUrl) || 'http://localhost:11434/v1';
}

function buildHeaders(apiKey: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const trimmedApiKey = apiKey?.trim();
  if (trimmedApiKey) {
    headers.Authorization = `Bearer ${trimmedApiKey}`;
  }
  return headers;
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Failed to parse Ollama API response: ${text.substring(0, 200)}`);
  }
}

export async function listOllamaModels(input: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderModelInfo[]> {
  const response = await fetch(`${buildBaseUrl(input.baseUrl)}/models`, {
    method: 'GET',
    headers: buildHeaders(input.apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await parseJsonResponse(response);
  const models = Array.isArray(data?.data) ? data.data : [];
  return models
    .map((item: unknown) => {
      const modelItem = item as { id?: unknown };
      const id = typeof modelItem?.id === 'string' ? modelItem.id.trim() : '';
      if (!id) {
        return null;
      }
      return {
        id,
        name: id,
      };
    })
    .filter((item: ProviderModelInfo | null): item is ProviderModelInfo => Boolean(item));
}
