import { describe, expect, it } from 'vitest';

import {
  resolveMessageEndPayload,
  toUserFacingErrorText,
} from '../src/main/claude/agent-runner-message-end';

describe('resolveMessageEndPayload', () => {
  it('falls back to accumulated streamed text when message_end content is empty', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: 'streamed fallback',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([{ type: 'text', text: 'streamed fallback' }]);
  });

  it('surfaces user-facing error text when message_end stops with error', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'first_response_timeout',
      },
      streamedText: 'partial text',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.shouldEmitMessage).toBe(false);
    expect(result.effectiveContent).toEqual([]);
    expect(result.errorText).toBe(
      'Model response timeout: no response received from upstream for an extended period. Please retry or check the current model/gateway load.'
    );
  });

  it('surfaces empty_success_result when message_end has no content and no streamed fallback', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: '',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.shouldEmitMessage).toBe(false);
    expect(result.effectiveContent).toEqual([]);
    expect(result.errorText).toBe(
      'Model returned an empty success result. There may be a compatibility issue with the current model or gateway. Please retry or try switching the protocol.'
    );
  });
});

describe('toUserFacingErrorText', () => {
  it('maps 400 / bad request to configuration hint', () => {
    const result = toUserFacingErrorText('HTTP 400: bad request - ROLE_UNSPECIFIED');
    expect(result).toContain('Request rejected by upstream (400)');
    expect(result).toContain('Original error:');
    expect(result).toContain('ROLE_UNSPECIFIED');
  });

  it('maps invalid request to configuration hint', () => {
    const result = toUserFacingErrorText('invalid request: unsupported parameter "store"');
    expect(result).toContain('Request rejected by upstream (400)');
    expect(result).toContain('Original error:');
  });

  it('maps 401 to authentication hint', () => {
    const result = toUserFacingErrorText('Error 401: Unauthorized');
    expect(result).toContain('Authentication failed');
    expect(result).toContain('API Key');
    expect(result).toContain('Original error:');
  });

  it('maps 429 / rate limit to throttle hint', () => {
    const result = toUserFacingErrorText('429 Too Many Requests - rate limit exceeded');
    expect(result).toContain('Request rate-limited (429)');
    expect(result).toContain('Original error:');
  });

  it('passes through unknown errors unchanged', () => {
    const raw = 'some obscure upstream error';
    expect(toUserFacingErrorText(raw)).toBe(raw);
  });

  it('still maps first_response_timeout correctly (regression)', () => {
    expect(toUserFacingErrorText('first_response_timeout')).toBe(
      'Model response timeout: no response received from upstream for an extended period. Please retry or check the current model/gateway load.'
    );
  });

  it('maps 5xx server errors to upstream service hint', () => {
    const result = toUserFacingErrorText('HTTP 502: Bad Gateway');
    expect(result).toContain('Upstream service error');
    expect(result).toContain('Original error:');
    expect(result).toContain('502');
  });

  it('maps "server error" to upstream service hint', () => {
    const result = toUserFacingErrorText('internal server error');
    expect(result).toContain('Upstream service error');
  });

  it('maps "overloaded" to upstream service hint', () => {
    const result = toUserFacingErrorText('overloaded_error');
    expect(result).toContain('Upstream service error');
  });

  it('maps "terminated" to network connection hint', () => {
    const result = toUserFacingErrorText('terminated');
    expect(result).toContain('Network connection interrupted');
    expect(result).toContain('terminated');
  });

  it('maps "connection error" to network connection hint', () => {
    const result = toUserFacingErrorText('connection error: ECONNRESET');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "fetch failed" to network connection hint', () => {
    const result = toUserFacingErrorText('fetch failed');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "other side closed" to network connection hint', () => {
    const result = toUserFacingErrorText('other side closed');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "too many requests" without status code to throttle hint', () => {
    const result = toUserFacingErrorText('too many requests');
    expect(result).toContain('Request rate-limited (429)');
    expect(result).toContain('Original error:');
  });

  it('maps "retry delay exceeded" to network connection hint', () => {
    const result = toUserFacingErrorText('retry delay exceeded');
    expect(result).toContain('Network connection interrupted');
  });
});
