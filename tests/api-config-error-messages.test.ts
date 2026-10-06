/**
 * Turning an error from a config call into a message for the user
 * (`translateApiConfigErrorMessage`).
 *
 * Main reports these failures by throwing, and Electron does not hand the
 * renderer the message as it was thrown: it puts its own text in front
 * (`Error invoking remote method '<channel>': Error: …`). A translator that
 * compares the whole text therefore matches nothing in the running app, and
 * tests that feed it the bare message pass anyway. These use the text the
 * renderer really receives.
 */
import { describe, expect, it } from 'vitest';
import {
  stripIpcErrorPrefix,
  translateApiConfigErrorMessage,
  type Translate,
} from '../src/renderer/hooks/api-config-shared';

/** Stands in for i18next: the key, with its values when there are any. */
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as Translate;

/** An error as it reaches the renderer from `ipcRenderer.invoke`. */
function overIpc(channel: string, message: string): string {
  return `Error invoking remote method '${channel}': Error: ${message}`;
}

describe('the text Electron puts in front of an error from main', () => {
  it('is removed, whatever the channel', () => {
    expect(stripIpcErrorPrefix(overIpc('config.createSet', 'Config set not found'))).toBe(
      'Config set not found'
    );
    expect(
      stripIpcErrorPrefix(overIpc('config.deleteCustomEndpoint', 'Custom endpoint not found'))
    ).toBe('Custom endpoint not found');
  });

  it('is removed for another kind of error too', () => {
    expect(
      stripIpcErrorPrefix("Error invoking remote method 'config.save': TypeError: bad value")
    ).toBe('bad value');
  });

  it('leaves a message that has none as it is', () => {
    expect(stripIpcErrorPrefix('Config set not found')).toBe('Config set not found');
    expect(stripIpcErrorPrefix('')).toBe('');
  });
});

describe('config set messages', () => {
  it.each([
    ['Config set name is required', 'api.configSetNameRequired'],
    ['Config set clone source not found', 'api.configSetCloneSourceMissing'],
    ['Config set not found', 'api.configSetMissing'],
    ['System config set cannot be deleted', 'api.configSetSystemDeleteForbidden'],
    ['At least one config set must be kept', 'api.configSetKeepOne'],
  ])('translates "%s" as it arrives over IPC', (message, key) => {
    expect(translateApiConfigErrorMessage(overIpc('config.deleteSet', message), t)).toBe(key);
    expect(translateApiConfigErrorMessage(message, t)).toBe(key);
  });

  it('carries the limit into the message', () => {
    expect(
      translateApiConfigErrorMessage(
        overIpc('config.createSet', 'Config set limit reached: max 20'),
        t
      )
    ).toBe('api.configSetLimitReached {"count":20}');
  });
});

describe('custom endpoint messages', () => {
  it.each([
    ['Endpoint base URL is required', 'api.providers.errors.baseUrlRequired'],
    [
      'An endpoint with this protocol and base URL already exists',
      'api.providers.errors.duplicate',
    ],
    ['Custom endpoint not found', 'api.providers.errors.notFound'],
  ])('translates "%s" as it arrives over IPC', (message, key) => {
    expect(translateApiConfigErrorMessage(overIpc('config.updateCustomEndpoint', message), t)).toBe(
      key
    );
  });

  it('carries the endpoint limit, kept apart from the config-set limit', () => {
    expect(
      translateApiConfigErrorMessage(
        overIpc('config.createCustomEndpoint', 'Custom endpoint limit reached: max 20'),
        t
      )
    ).toBe('api.providers.errors.limitReached {"count":20}');
  });

  it('names the config sets that keep an endpoint from being deleted', () => {
    expect(
      translateApiConfigErrorMessage(
        overIpc(
          'config.deleteCustomEndpoint',
          'Endpoint is in use by config set(s): Work, Local gateway'
        ),
        t
      )
    ).toBe('api.providers.errors.inUse {"sets":"Work, Local gateway"}');
  });
});

describe('a message that is not known', () => {
  it('is shown as main worded it, without the prefix', () => {
    expect(translateApiConfigErrorMessage(overIpc('config.save', 'disk is full'), t)).toBe(
      'disk is full'
    );
  });
});
