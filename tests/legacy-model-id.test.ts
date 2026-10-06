/**
 * The one rule for a model id spelled the way an older version stored it.
 *
 * Main applies it to every config set it normalizes and the renderer applies it
 * when a stored model is loaded into the form, so both import it from `shared/`.
 * The store-level effect is covered in `config-store-credential-migration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { normalizeLegacyModelId } from '../src/shared/legacy-model-id';
import { normalizeLegacyModelId as rendererRule } from '../src/renderer/hooks/api-config-shared';

describe('normalizeLegacyModelId', () => {
  it('drops the gemini/ prefix, whichever provider the id is stored under', () => {
    expect(normalizeLegacyModelId('gemini', 'gemini/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(normalizeLegacyModelId('custom', 'gemini/gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });

  it('writes an OpenRouter Claude version with a dot', () => {
    expect(normalizeLegacyModelId('openrouter', 'anthropic/claude-sonnet-4-5')).toBe(
      'anthropic/claude-sonnet-4.5'
    );
    expect(normalizeLegacyModelId('openrouter', 'anthropic/claude-opus-4-1')).toBe(
      'anthropic/claude-opus-4.1'
    );
    expect(normalizeLegacyModelId('openrouter', 'anthropic/claude-haiku-4-5:batch')).toBe(
      'anthropic/claude-haiku-4.5:batch'
    );
  });

  it('leaves an id that has no minor version to rewrite', () => {
    for (const id of [
      'anthropic/claude-sonnet-4',
      'anthropic/claude-opus-5-fast',
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-5.4',
    ]) {
      expect(normalizeLegacyModelId('openrouter', id), id).toBe(id);
    }
  });

  it('leaves a dated id alone: a date is not a version written with a dash', () => {
    expect(normalizeLegacyModelId('openrouter', 'anthropic/claude-sonnet-4-20250514')).toBe(
      'anthropic/claude-sonnet-4-20250514'
    );
  });

  it('rewrites the version only on OpenRouter', () => {
    // Anthropic's own ids are spelled with dashes.
    expect(normalizeLegacyModelId('anthropic', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normalizeLegacyModelId('custom', 'anthropic/claude-sonnet-4-5')).toBe(
      'anthropic/claude-sonnet-4-5'
    );
  });

  it('trims, and gives the same answer when applied twice', () => {
    const once = normalizeLegacyModelId('openrouter', '  anthropic/claude-sonnet-4-5 ');
    expect(once).toBe('anthropic/claude-sonnet-4.5');
    expect(normalizeLegacyModelId('openrouter', once)).toBe(once);
  });

  it('is the same function in the renderer', () => {
    expect(rendererRule).toBe(normalizeLegacyModelId);
  });
});
