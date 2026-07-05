/**
 * Unit tests for the Custom-mode embedding model-override validator.
 */
import { describe, expect, it } from 'vitest';
import { classifyEmbeddingModel } from '../../renderer/components/settings/embedding-model-validation';

describe('classifyEmbeddingModel', () => {
  it('returns null for empty / whitespace (no override)', () => {
    expect(classifyEmbeddingModel('')).toBeNull();
    expect(classifyEmbeddingModel('   ')).toBeNull();
  });

  it('passes known-good prefix-free embedding models', () => {
    for (const m of [
      'text-embedding-3-small',
      'text-embedding-3-large',
      'text-embedding-ada-002',
      'BAAI/bge-m3',
      'bge-large-en-v1.5',
      'gemini-embedding-001',
      'voyage-3-large',
      'jina-embeddings-v3',
    ]) {
      expect(classifyEmbeddingModel(m), m).toBeNull();
    }
  });

  it('warns (non-blocking) on prefix-needing embedding models', () => {
    for (const m of [
      'multilingual-e5-small',
      'intfloat/multilingual-e5-large',
      'e5-base-v2',
      'nomic-embed-text-v1.5', // contains "embed" but still needs prefixes
      'nomic-ai/nomic-embed-text-v1',
    ]) {
      expect(classifyEmbeddingModel(m), m).toBe('prefix');
    }
  });

  it('flags chat / completion / reasoning models as a blocking error', () => {
    for (const m of [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-3.5-turbo',
      'chatgpt-4o-latest',
      'claude-sonnet-5',
      'gemini-2.5-flash',
      'llama-3.1-70b',
      'mistral-large',
      'mixtral-8x7b',
      'qwen2.5-72b',
      'deepseek-chat',
      'grok-2',
      'o1-preview',
      'o3-mini',
    ]) {
      expect(classifyEmbeddingModel(m), m).toBe('chat');
    }
  });

  it('does not nag on unrecognized-but-plausible models', () => {
    // Not obviously chat, not a known embedding family — stay quiet.
    expect(classifyEmbeddingModel('my-custom-encoder-v2')).toBeNull();
    expect(classifyEmbeddingModel('gte-large')).toBeNull();
  });

  it('gemini embedding is clean even though "gemini" is a chat family', () => {
    // The 'embed' allowlist must win over the chat heuristic.
    expect(classifyEmbeddingModel('gemini-embedding-001')).toBeNull();
    expect(classifyEmbeddingModel('gemini-2.5-pro')).toBe('chat');
  });

  it('is case-insensitive', () => {
    expect(classifyEmbeddingModel('GPT-4O')).toBe('chat');
    expect(classifyEmbeddingModel('Text-Embedding-3-Small')).toBeNull();
  });
});
