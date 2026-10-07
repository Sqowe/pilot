/**
 * P1 migration tests — type widening & validator round-trips.
 *
 * Verifies §7 of the native-provider-catalog design:
 * - Legacy config sets load identically after widening (no regression).
 * - Newly-saved native provider ids survive a load round-trip.
 * - Excluded/unknown provider ids coerce to the fallback without throwing.
 * - native:* profile keys are accepted by isProfileKey logic.
 *
 * Uses the real shared implementations from src/shared/provider-ids.ts and
 * the exported profileKeyFromProvider/profileKeyToProvider from
 * api-config-shared (renderer-side) for round-trip tests.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeProviderId,
  isValidProviderId,
  isValidProfileKey,
  isNativeProfileKey,
  deriveProfileKey,
  profileKeyToProviderInfo,
  BUILTIN_PROVIDER_ID_LIST,
  BUILTIN_PROFILE_KEY_LIST,
} from '../../shared/provider-ids';
import {
  profileKeyFromProvider,
  profileKeyToProvider,
} from '../../renderer/hooks/api-config-shared';

// ---------------------------------------------------------------------------
// normalizeProviderId
// ---------------------------------------------------------------------------

describe('normalizeProviderId', () => {
  it('trims and returns canonical id', () => {
    expect(normalizeProviderId(' zai ')).toBe('zai');
    expect(normalizeProviderId('  anthropic  ')).toBe('anthropic');
    expect(normalizeProviderId('groq')).toBe('groq');
  });

  it('returns undefined for empty/whitespace strings', () => {
    expect(normalizeProviderId('')).toBeUndefined();
    expect(normalizeProviderId('   ')).toBeUndefined();
  });

  it('returns undefined for "local" (reserved for embedding)', () => {
    expect(normalizeProviderId('local')).toBeUndefined();
  });

  it('returns undefined for dangerous prototype keys', () => {
    expect(normalizeProviderId('__proto__')).toBeUndefined();
    expect(normalizeProviderId('constructor')).toBeUndefined();
    expect(normalizeProviderId('prototype')).toBeUndefined();
  });

  it('returns undefined for non-strings', () => {
    expect(normalizeProviderId(null)).toBeUndefined();
    expect(normalizeProviderId(undefined)).toBeUndefined();
    expect(normalizeProviderId(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isValidProviderId
// ---------------------------------------------------------------------------

describe('isValidProviderId (widened)', () => {
  it('accepts all 6 legacy builtin ids', () => {
    for (const id of BUILTIN_PROVIDER_ID_LIST) {
      expect(isValidProviderId(id), `${id} should be valid`).toBe(true);
    }
  });

  it('accepts native provider ids', () => {
    for (const id of ['zai', 'minimax', 'deepseek', 'groq', 'kimi-coding']) {
      expect(isValidProviderId(id), `${id} should be valid`).toBe(true);
    }
  });

  it('rejects "local" (reserved for embedding)', () => {
    expect(isValidProviderId('local')).toBe(false);
  });

  it('rejects dangerous prototype keys', () => {
    expect(isValidProviderId('__proto__')).toBe(false);
    expect(isValidProviderId('constructor')).toBe(false);
    expect(isValidProviderId('prototype')).toBe(false);
  });

  it('rejects empty/whitespace strings', () => {
    expect(isValidProviderId('')).toBe(false);
    expect(isValidProviderId('   ')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidProviderId(null)).toBe(false);
    expect(isValidProviderId(undefined)).toBe(false);
    expect(isValidProviderId(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidProfileKey
// ---------------------------------------------------------------------------

describe('isValidProfileKey', () => {
  it('accepts all 8 builtin profile keys', () => {
    for (const key of BUILTIN_PROFILE_KEY_LIST) {
      expect(isValidProfileKey(key), `${key} should be valid`).toBe(true);
    }
  });

  it('accepts canonical native:* keys', () => {
    expect(isValidProfileKey('native:zai')).toBe(true);
    expect(isValidProfileKey('native:minimax')).toBe(true);
    expect(isValidProfileKey('native:kimi-coding')).toBe(true);
  });

  it('rejects non-canonical native:* keys (whitespace in suffix)', () => {
    expect(isValidProfileKey('native: zai')).toBe(false);
    expect(isValidProfileKey('native:zai ')).toBe(false);
    expect(isValidProfileKey('native:  zai  ')).toBe(false);
    expect(isValidProfileKey('native:   ')).toBe(false);
  });

  it('rejects bare "native:" with no suffix', () => {
    expect(isValidProfileKey('native:')).toBe(false);
  });

  it('rejects native:local (reserved)', () => {
    expect(isValidProfileKey('native:local')).toBe(false);
  });

  it('rejects native:__proto__ (dangerous key)', () => {
    expect(isValidProfileKey('native:__proto__')).toBe(false);
    expect(isValidProfileKey('native:constructor')).toBe(false);
  });

  it('rejects raw provider ids (not prefixed with native:)', () => {
    expect(isValidProfileKey('zai')).toBe(false);
    expect(isValidProfileKey('minimax')).toBe(false);
    expect(isValidProfileKey('bedrock')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidProfileKey(null)).toBe(false);
    expect(isValidProfileKey(undefined)).toBe(false);
    expect(isValidProfileKey(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNativeProfileKey
// ---------------------------------------------------------------------------

describe('isNativeProfileKey', () => {
  it('returns true for canonical native:* keys', () => {
    expect(isNativeProfileKey('native:zai')).toBe(true);
    expect(isNativeProfileKey('native:minimax')).toBe(true);
  });

  it('returns false for builtin keys', () => {
    expect(isNativeProfileKey('anthropic')).toBe(false);
    expect(isNativeProfileKey('openai')).toBe(false);
    expect(isNativeProfileKey('custom:openai')).toBe(false);
  });

  it('returns false for non-canonical native keys', () => {
    expect(isNativeProfileKey('native: zai ')).toBe(false);
    expect(isNativeProfileKey('native:')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveProfileKey (shared module)
// ---------------------------------------------------------------------------

describe('deriveProfileKey', () => {
  it('builtin providers map to their id directly', () => {
    expect(deriveProfileKey('anthropic')).toBe('anthropic');
    expect(deriveProfileKey('openai')).toBe('openai');
    expect(deriveProfileKey('gemini')).toBe('gemini');
    expect(deriveProfileKey('openrouter')).toBe('openrouter');
    expect(deriveProfileKey('ollama')).toBe('ollama');
  });

  it('custom provider maps to protocol-scoped key', () => {
    expect(deriveProfileKey('custom', 'anthropic')).toBe('custom:anthropic');
    expect(deriveProfileKey('custom', 'openai')).toBe('custom:openai');
    expect(deriveProfileKey('custom', 'gemini')).toBe('custom:gemini');
  });

  it('native providers produce canonical native:* keys', () => {
    expect(deriveProfileKey('zai')).toBe('native:zai');
    expect(deriveProfileKey('minimax')).toBe('native:minimax');
    expect(deriveProfileKey('kimi-coding')).toBe('native:kimi-coding');
  });

  it('whitespace-padded provider ids are canonicalized', () => {
    expect(deriveProfileKey(' zai ')).toBe('native:zai');
    expect(deriveProfileKey('  anthropic  ')).toBe('anthropic');
  });

  it('dangerous provider ids fall back to openrouter', () => {
    expect(deriveProfileKey('__proto__')).toBe('openrouter');
    expect(deriveProfileKey('constructor')).toBe('openrouter');
  });

  it('produced native:* keys pass isValidProfileKey', () => {
    for (const id of ['zai', 'minimax', 'deepseek', 'groq']) {
      const key = deriveProfileKey(id);
      expect(isValidProfileKey(key), `key ${key} should pass isValidProfileKey`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// profileKeyToProviderInfo (shared module)
// ---------------------------------------------------------------------------

describe('profileKeyToProviderInfo', () => {
  it('builtin keys recover their provider', () => {
    expect(profileKeyToProviderInfo('anthropic')).toMatchObject({ provider: 'anthropic' });
    expect(profileKeyToProviderInfo('openai')).toMatchObject({
      provider: 'openai',
      customProtocol: 'openai',
    });
    expect(profileKeyToProviderInfo('ollama')).toMatchObject({
      provider: 'ollama',
      customProtocol: 'openai',
    });
  });

  it('custom:* keys recover custom provider + protocol', () => {
    expect(profileKeyToProviderInfo('custom:anthropic')).toEqual({
      provider: 'custom',
      customProtocol: 'anthropic',
    });
    expect(profileKeyToProviderInfo('custom:openai')).toEqual({
      provider: 'custom',
      customProtocol: 'openai',
    });
    expect(profileKeyToProviderInfo('custom:gemini')).toEqual({
      provider: 'custom',
      customProtocol: 'gemini',
    });
  });

  it('native:* keys recover the provider id', () => {
    expect(profileKeyToProviderInfo('native:zai')).toMatchObject({ provider: 'zai' });
    expect(profileKeyToProviderInfo('native:kimi-coding')).toMatchObject({
      provider: 'kimi-coding',
    });
  });

  it('corrupted native: key falls back to openrouter', () => {
    expect(profileKeyToProviderInfo('native:')).toMatchObject({ provider: 'openrouter' });
  });
});

// ---------------------------------------------------------------------------
// profileKeyFromProvider / profileKeyToProvider (renderer exports)
// ---------------------------------------------------------------------------

describe('profileKeyFromProvider (renderer)', () => {
  it('builtin providers return their id as profile key', () => {
    expect(profileKeyFromProvider('anthropic')).toBe('anthropic');
    expect(profileKeyFromProvider('openai')).toBe('openai');
    expect(profileKeyFromProvider('ollama')).toBe('ollama');
  });

  it('custom returns protocol-scoped key', () => {
    expect(profileKeyFromProvider('custom', 'openai')).toBe('custom:openai');
  });

  it('native providers return canonical native:* key', () => {
    expect(profileKeyFromProvider('zai')).toBe('native:zai');
    expect(profileKeyFromProvider('minimax')).toBe('native:minimax');
  });
});

describe('profileKeyToProvider (renderer)', () => {
  it('native:* keys recover the provider id', () => {
    expect(profileKeyToProvider('native:zai')).toMatchObject({ provider: 'zai' });
  });

  it('corrupted native: key falls back defensively', () => {
    expect(profileKeyToProvider('native:' as `native:${string}`)).toMatchObject({
      provider: 'openrouter',
    });
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('profile key round-trip', () => {
  it('builtin providers round-trip without data loss', () => {
    for (const p of ['anthropic', 'openai', 'gemini', 'openrouter', 'ollama']) {
      const key = profileKeyFromProvider(p);
      expect(profileKeyToProvider(key).provider).toBe(p);
    }
  });

  it('native providers round-trip through native:* format', () => {
    for (const id of ['zai', 'minimax', 'deepseek', 'groq', 'kimi-coding']) {
      const key = profileKeyFromProvider(id);
      expect(key).toBe(`native:${id}`);
      expect(isValidProfileKey(key)).toBe(true);
      expect(profileKeyToProvider(key).provider).toBe(id);
    }
  });

  it('whitespace-padded provider id round-trips as canonical key', () => {
    const key = profileKeyFromProvider(' zai ');
    expect(key).toBe('native:zai');
    expect(isValidProfileKey(key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config migration (§7)
// ---------------------------------------------------------------------------

describe('config migration round-trip', () => {
  it('legacy provider:openrouter passes isValidProviderId', () => {
    expect(isValidProviderId('openrouter')).toBe(true);
  });

  it('legacy activeProfileKey:anthropic passes isValidProfileKey', () => {
    expect(isValidProfileKey('anthropic')).toBe(true);
  });

  it('native provider:zai passes isValidProviderId', () => {
    expect(isValidProviderId('zai')).toBe(true);
  });

  it('native activeProfileKey:native:zai passes isValidProfileKey', () => {
    expect(isValidProfileKey('native:zai')).toBe(true);
  });

  it('"local" is rejected as a main provider (reserved for embedding)', () => {
    expect(isValidProviderId('local')).toBe(false);
  });

  it('dangerous prototype key is rejected as provider id', () => {
    expect(isValidProviderId('__proto__')).toBe(false);
    expect(isValidProviderId('constructor')).toBe(false);
  });

  it('non-canonical native:* key is rejected by isValidProfileKey', () => {
    expect(isValidProfileKey('native: zai')).toBe(false);
    expect(isValidProfileKey('native:zai ')).toBe(false);
  });

  it('simulated persisted config survives validation round-trip', () => {
    const persisted = {
      provider: 'zai',
      activeProfileKey: 'native:zai',
    };
    expect(isValidProviderId(persisted.provider)).toBe(true);
    expect(isValidProfileKey(persisted.activeProfileKey)).toBe(true);
    const recovered = profileKeyToProviderInfo(persisted.activeProfileKey);
    expect(recovered.provider).toBe('zai');
  });

  it('defaultProtocolForProvider returns safe default for native/unknown ids', () => {
    // We validate this indirectly: deriveProfileKey falls back for invalid ids
    // and the function returns 'openrouter' (a known safe builtin).
    // Direct test: unknown ids should produce 'anthropic' protocol via
    // profileKeyToProviderInfo (the default branch).
    const info = profileKeyToProviderInfo('native:zai');
    expect(info.customProtocol).toBe('anthropic');
    // Another unknown native id
    const info2 = profileKeyToProviderInfo('native:some-future-provider');
    expect(info2.customProtocol).toBe('anthropic');
  });
});
