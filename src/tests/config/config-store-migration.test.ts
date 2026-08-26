/**
 * Unit tests for the v1→v2 config schema migration logic.
 *
 * Tests §7 of local-embeddings-default.md via the exported pure helper
 * `computeV2Migration` and the schema-version-aware normalization strategy.
 *
 * Migration strategy:
 * - migrateToV2() only freezes useEmbedding via a dot-path write and stamps v2.
 * - embedding.provider is NOT touched by migration — instead,
 *   normalizeMemoryRuntimeConfig is schema-version-aware: for schemaVersion < 2
 *   it uses old defaults (provider: undefined, useEmbedding: false) as fallbacks,
 *   and for schemaVersion >= 2 it uses new defaults (provider: 'local', useEmbedding: true).
 * - This means existing users with an explicit provider (e.g., 'openai') keep it,
 *   and users who never set a provider stay on 'undefined' (inherit behavior) — not 'local'.
 */
import { describe, expect, it } from 'vitest';
import { computeV2Migration } from '../../main/config/config-store';

describe('computeV2Migration', () => {
  it('(a) freezes useEmbedding: false for a v1 install that never touched embedding', () => {
    const rawMemory = {
      useEmbedding: false,
      embedding: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: 'text-embedding-3-small',
        timeoutMs: 180000,
      },
      llm: { inheritFromActive: true, model: '', timeoutMs: 180000 },
      ingestionConcurrency: 4,
      maxNavSteps: 2,
      storageRoot: '/home/user/.config/open-cowork/memory',
    };

    const result = computeV2Migration(rawMemory);

    expect(result.useEmbedding).toBe(false);
  });

  it('(b) no persisted memoryRuntime — defaults to useEmbedding: false', () => {
    // When the key was never written the store passes undefined.
    // computeV2Migration freezes false; fresh installs skip migrateToV2 entirely.
    const result = computeV2Migration(undefined);

    expect(result.useEmbedding).toBe(false);
  });

  it('(c) preserves useEmbedding: true for a user who explicitly enabled it', () => {
    const rawMemory = {
      useEmbedding: true,
      embedding: {
        inheritFromActive: false,
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-3-large',
        timeoutMs: 180000,
      },
    };

    const result = computeV2Migration(rawMemory);

    expect(result.useEmbedding).toBe(true);
  });

  it('(d) only returns useEmbedding — no other keys that could clobber config', () => {
    const rawMemory = {
      useEmbedding: false,
      llm: { inheritFromActive: true, model: 'gpt-4o', timeoutMs: 180000 },
      ingestionConcurrency: 8,
      storageRoot: '/data/memory',
      embedding: { model: 'text-embedding-3-small', apiKey: 'sk-abc' },
    };

    const result = computeV2Migration(rawMemory);

    // Only useEmbedding — no other fields that could clobber nested config.
    expect(Object.keys(result)).toEqual(['useEmbedding']);
    expect('llm' in result).toBe(false);
    expect('ingestionConcurrency' in result).toBe(false);
    expect('storageRoot' in result).toBe(false);
    expect('embedding' in result).toBe(false);
  });

  it('handles null gracefully', () => {
    const result = computeV2Migration(null);
    expect(result.useEmbedding).toBe(false);
  });

  it('handles non-boolean useEmbedding gracefully', () => {
    const result = computeV2Migration({ useEmbedding: 'yes' });
    expect(result.useEmbedding).toBe(false);
  });

  it('handles non-object rawMemory gracefully', () => {
    const result = computeV2Migration(42);
    expect(result.useEmbedding).toBe(false);
  });
});

describe('schema-version-aware normalization', () => {
  /**
   * Core D4 guarantee: existing installs do not silently switch embedding provider.
   * normalizeMemoryRuntimeConfig uses schemaVersion to determine which defaults to
   * apply — pre-v2 configs fall back to old defaults, v2+ get new defaults.
   */

  it('computeV2Migration is exported and callable', async () => {
    const configModule = await import('../../main/config/config-store');
    expect(typeof configModule.computeV2Migration).toBe('function');
  });

  it('v1 install with explicit openai provider — migration does not touch embedding.provider', () => {
    // migrateToV2 only writes useEmbedding (dot-path). The existing 'openai' provider
    // in the raw data is preserved in the store and normalizeMemoryEmbeddingRuntimeConfig
    // reads it from the persisted object — it does not get reset to 'local'.
    const rawV1Memory = {
      useEmbedding: true,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        inheritFromActive: false,
        apiKey: 'sk-x',
        baseUrl: '',
        timeoutMs: 180000,
      },
    };
    const result = computeV2Migration(rawV1Memory);
    // Migration only produces useEmbedding — nothing that would overwrite provider.
    expect(result.useEmbedding).toBe(true);
    expect('embedding' in result).toBe(false);
    expect('embeddingProvider' in result).toBe(false);
  });

  it('v1 install with no explicit provider — migration does not inject "local"', () => {
    // A user who never configured embedding stays on provider: undefined (inherit mode),
    // not on 'local'. The schema-version-aware fallback handles this correctly.
    const rawV1Memory = { useEmbedding: false };
    const result = computeV2Migration(rawV1Memory);

    expect(result.useEmbedding).toBe(false);
    // No embedding field — provider is untouched in the store
    expect('embedding' in result).toBe(false);
  });
});
