import { describe, it, expect } from 'vitest';
import { parseCodexAuthPayload } from '../src/main/auth/local-auth';

describe('parseCodexAuthPayload', () => {
  it('extracts token from nested tokens payload', () => {
    const parsed = parseCodexAuthPayload({
      auth_mode: 'oauth_personal',
      tokens: {
        access_token: 'nested-codex-token',
        account_id: 'nested-user',
      },
      last_refresh: '2026-02-12T10:02:00.000Z',
    });

    expect(parsed).toEqual({
      token: 'nested-codex-token',
      account: 'nested-user',
      updatedAt: '2026-02-12T10:02:00.000Z',
      expiresAt: undefined,
    });
  });

  it('extracts token from default profile', () => {
    const parsed = parseCodexAuthPayload({
      default_profile: 'default',
      profiles: {
        default: {
          access_token: 'codex-token',
          account_id: 'user@example.com',
          last_refresh: '2026-02-15T00:00:00Z',
        },
      },
    });

    expect(parsed).toEqual({
      token: 'codex-token',
      profile: 'default',
      account: 'user@example.com',
      updatedAt: '2026-02-15T00:00:00Z',
      expiresAt: undefined,
    });
  });

  it('extracts token from flat payload', () => {
    const parsed = parseCodexAuthPayload({
      access_token: 'flat-token',
      account_id: 'flat-user',
    });

    expect(parsed?.token).toBe('flat-token');
    expect(parsed?.account).toBe('flat-user');
  });
  it('returns null for invalid payload', () => {
    expect(parseCodexAuthPayload({ profiles: {} })).toBeNull();
  });
});
