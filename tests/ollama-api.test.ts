import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listOllamaModels } from '../src/main/config/ollama-api';

describe('ollama api helpers', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('lists models from the configured ollama base url without requiring authorization', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'qwen3.5:0.8b', object: 'model' },
            { id: 'llama3.2:latest', object: 'model' },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const result = await listOllamaModels({
      baseUrl: 'http://ollama.internal:11434',
      apiKey: '',
    });

    expect(result).toEqual([
      { id: 'qwen3.5:0.8b', name: 'qwen3.5:0.8b' },
      { id: 'llama3.2:latest', name: 'llama3.2:latest' },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://ollama.internal:11434/v1/models',
      expect.objectContaining({
        method: 'GET',
      })
    );
  });

  it('normalizes native ollama /api endpoints to the openai-compatible /v1 models route', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'qwen3.5:0.8b', object: 'model' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const result = await listOllamaModels({
      baseUrl: 'https://ollama.com/api',
      apiKey: '',
    });

    expect(result).toEqual([{ id: 'qwen3.5:0.8b', name: 'qwen3.5:0.8b' }]);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://ollama.com/v1/models',
      expect.objectContaining({
        method: 'GET',
      })
    );
  });
});
