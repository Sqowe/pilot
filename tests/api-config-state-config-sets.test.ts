import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/renderer/types';
import {
  FALLBACK_PROVIDER_PRESETS,
  buildApiConfigDraftSignature,
  buildApiConfigSets,
  buildApiConfigSnapshot,
} from '../src/renderer/hooks/useApiConfigState';

describe('api config set helpers', () => {
  it('normalizes config sets from app config payload', () => {
    const config = {
      provider: 'openai',
      customProtocol: 'openai',
      activeProfileKey: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      openaiMode: 'responses',
      activeConfigSetId: 'work',
      configSets: [
        {
          id: 'default',
          name: '默认方案',
          isSystem: true,
          provider: 'openrouter',
          customProtocol: 'anthropic',
          activeProfileKey: 'openrouter',
          profiles: {
            openrouter: {
              apiKey: 'sk-or',
              baseUrl: 'https://openrouter.ai/api',
              model: 'anthropic/claude-sonnet-4.5',
              openaiMode: 'responses',
            },
          },
          enableThinking: false,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'work',
          name: 'Work OpenAI',
          isSystem: false,
          provider: 'openai',
          customProtocol: 'openai',
          activeProfileKey: 'openai',
          profiles: {
            openai: {
              apiKey: 'sk-work-openai',
              baseUrl: 'https://api.openai.com/v1',
              model: 'gpt-5.2-mini',
              openaiMode: 'responses',
            },
          },
          enableThinking: true,
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      profiles: {
        openai: {
          apiKey: 'sk-work-openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.2-mini',
          openaiMode: 'responses',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const sets = buildApiConfigSets(config, FALLBACK_PROVIDER_PRESETS);
    expect(sets.length).toBe(2);
    expect(sets[1].name).toBe('Work OpenAI');
    expect(sets[1].profiles.openai?.apiKey).toBe('sk-work-openai');
  });

  it('builds fallback default set when configSets are missing', () => {
    const config = {
      provider: 'openrouter',
      customProtocol: 'anthropic',
      activeProfileKey: 'openrouter',
      apiKey: 'sk-or',
      baseUrl: 'https://openrouter.ai/api',
      model: 'anthropic/claude-sonnet-4.5',
      openaiMode: 'responses',
      profiles: {
        openrouter: {
          apiKey: 'sk-or',
          baseUrl: 'https://openrouter.ai/api',
          model: 'anthropic/claude-sonnet-4.5',
          openaiMode: 'responses',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const sets = buildApiConfigSets(config, FALLBACK_PROVIDER_PRESETS);
    expect(sets.length).toBe(1);
    expect(sets[0].isSystem).toBe(true);
    expect(sets[0].provider).toBe('openrouter');
  });

  it('generates stable draft signature and detects material changes', () => {
    const snapshot = buildApiConfigSnapshot(undefined, FALLBACK_PROVIDER_PRESETS);
    const signatureA = buildApiConfigDraftSignature(snapshot.activeProfileKey, snapshot.profiles, snapshot.enableThinking);
    const signatureB = buildApiConfigDraftSignature(snapshot.activeProfileKey, snapshot.profiles, snapshot.enableThinking);
    expect(signatureA).toBe(signatureB);

    const changedProfiles = {
      ...snapshot.profiles,
      openai: {
        ...snapshot.profiles.openai,
        apiKey: 'sk-new',
      },
    };
    const signatureC = buildApiConfigDraftSignature(snapshot.activeProfileKey, changedProfiles, snapshot.enableThinking);
    expect(signatureC).not.toBe(signatureA);
  });
});
