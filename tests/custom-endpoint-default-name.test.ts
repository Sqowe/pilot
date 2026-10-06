/**
 * The name an endpoint gets when nobody gave it one.
 *
 * It is the host of its address — the only name the data offers. One host can
 * serve more than one protocol (a local gateway often does), and each is an
 * endpoint of its own; named by host alone, the two could be told apart only by
 * a badge. So the second one on a host gets the protocol added, wherever in the
 * store an endpoint is named: created from the dialog, minted by a save, or
 * built by the conversion of a pre-split config.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCustomEndpointName } from '../src/shared/custom-endpoint-key';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
  last: null as { store: Record<string, unknown> } | null,
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
        ...mocks.seed,
      };
      mocks.last = this;
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    // Like conf: assigns the keys it is given and never removes one.
    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = {
        ...this.store,
        ...key,
      };
    }

    delete(key: string): void {
      delete this.store[key];
    }

    clear(): void {
      this.store = {};
    }
  }

  return {
    default: MockStore,
  };
});

import { ConfigStore } from '../src/main/config/config-store';

/** Start a second store over what the first one persisted: an app restart. */
function restart(): ConfigStore {
  mocks.seed = JSON.parse(JSON.stringify(mocks.last!.store));
  return new ConfigStore();
}

const LOCAL = 'http://127.0.0.1:9000';

describe('the default name of an endpoint', () => {
  it('is the host of its address, with the port when there is one', () => {
    expect(defaultCustomEndpointName('http://127.0.0.1:9000')).toBe('127.0.0.1:9000');
    expect(defaultCustomEndpointName('https://gateway.example.com/v1')).toBe('gateway.example.com');
  });

  it('is the address as typed when no host can be read from it, and says so when empty', () => {
    expect(defaultCustomEndpointName('not a url')).toBe('not a url');
    expect(defaultCustomEndpointName('   ')).toBe('Custom endpoint');
  });

  it('stays the bare host while no other endpoint has that name', () => {
    expect(
      defaultCustomEndpointName(LOCAL, { protocol: 'openai', takenNames: ['kiro-gateway'] })
    ).toBe('127.0.0.1:9000');
  });

  it('adds the protocol when the host is already the name of another endpoint', () => {
    const taken = ['127.0.0.1:9000'];

    expect(
      defaultCustomEndpointName(`${LOCAL}/v1`, { protocol: 'openai', takenNames: taken })
    ).toBe('127.0.0.1:9000 (OpenAI)');
    expect(defaultCustomEndpointName(LOCAL, { protocol: 'gemini', takenNames: taken })).toBe(
      '127.0.0.1:9000 (Gemini)'
    );
    expect(defaultCustomEndpointName(LOCAL, { protocol: 'anthropic', takenNames: taken })).toBe(
      '127.0.0.1:9000 (Anthropic)'
    );
  });

  it('adds a number when host and protocol together are taken too', () => {
    // Same host and protocol, another path.
    const taken = new Set(['127.0.0.1:9000', '127.0.0.1:9000 (OpenAI)']);
    expect(defaultCustomEndpointName(`${LOCAL}/b`, { protocol: 'openai', takenNames: taken })).toBe(
      '127.0.0.1:9000 (OpenAI) 2'
    );

    taken.add('127.0.0.1:9000 (OpenAI) 2');
    expect(defaultCustomEndpointName(`${LOCAL}/c`, { protocol: 'openai', takenNames: taken })).toBe(
      '127.0.0.1:9000 (OpenAI) 3'
    );
  });

  it('counts a name the user chose as taken, exactly as written', () => {
    expect(
      defaultCustomEndpointName(LOCAL, { protocol: 'openai', takenNames: ['127.0.0.1:9000'] })
    ).toBe('127.0.0.1:9000 (OpenAI)');
    // Another spelling is another name.
    expect(
      defaultCustomEndpointName(LOCAL, { protocol: 'openai', takenNames: ['127.0.0.1:9000 '] })
    ).toBe('127.0.0.1:9000');
  });
});

describe('naming an endpoint added from the dialog', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  it('tells two protocols on one host apart', () => {
    const store = new ConfigStore();
    store.createCustomEndpoint({ name: '', protocol: 'anthropic', baseUrl: LOCAL });
    const config = store.createCustomEndpoint({
      name: '',
      protocol: 'openai',
      baseUrl: `${LOCAL}/v1`,
    });

    expect(config.customEndpoints.map((endpoint) => endpoint.name)).toEqual([
      '127.0.0.1:9000',
      '127.0.0.1:9000 (OpenAI)',
    ]);
  });

  it('never renames the endpoint that was there first', () => {
    const store = new ConfigStore();
    const first = store.createCustomEndpoint({ name: '', protocol: 'anthropic', baseUrl: LOCAL });
    const firstId = first.customEndpoints[0].id;

    store.createCustomEndpoint({ name: '', protocol: 'openai', baseUrl: `${LOCAL}/v1` });
    const config = store.createCustomEndpoint({ name: '', protocol: 'gemini', baseUrl: LOCAL });

    expect(config.customEndpoints.find((endpoint) => endpoint.id === firstId)?.name).toBe(
      '127.0.0.1:9000'
    );
    expect(config.customEndpoints.map((endpoint) => endpoint.name)).toEqual([
      '127.0.0.1:9000',
      '127.0.0.1:9000 (OpenAI)',
      '127.0.0.1:9000 (Gemini)',
    ]);
  });

  it('keeps a name that was typed, even one another endpoint has', () => {
    // The rule is for names nobody chose. Two endpoints the user gave the same
    // name stay as the user named them.
    const store = new ConfigStore();
    store.createCustomEndpoint({ name: 'gateway', protocol: 'anthropic', baseUrl: LOCAL });
    const config = store.createCustomEndpoint({
      name: 'gateway',
      protocol: 'openai',
      baseUrl: `${LOCAL}/v1`,
    });

    expect(config.customEndpoints.map((endpoint) => endpoint.name)).toEqual(['gateway', 'gateway']);
  });

  it('adds the protocol when the host is the name the user gave another endpoint', () => {
    const store = new ConfigStore();
    store.createCustomEndpoint({
      name: '127.0.0.1:9000',
      protocol: 'anthropic',
      baseUrl: 'https://elsewhere.example',
    });
    const config = store.createCustomEndpoint({
      name: '',
      protocol: 'openai',
      baseUrl: `${LOCAL}/v1`,
    });

    expect(config.customEndpoints[1].name).toBe('127.0.0.1:9000 (OpenAI)');
  });

  it('keeps the names it gave across a restart', () => {
    const store = new ConfigStore();
    store.createCustomEndpoint({ name: '', protocol: 'anthropic', baseUrl: LOCAL });
    store.createCustomEndpoint({ name: '', protocol: 'openai', baseUrl: `${LOCAL}/v1` });

    expect(
      restart()
        .getAll()
        .customEndpoints.map((endpoint) => endpoint.name)
    ).toEqual(['127.0.0.1:9000', '127.0.0.1:9000 (OpenAI)']);
  });
});

describe('naming an endpoint minted by saving a custom address', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  it('adds the protocol when the host already names an endpoint', () => {
    // The first-run dialog saves a custom provider through `update()`, which
    // mints the endpoint itself.
    const store = new ConfigStore();
    store.createCustomEndpoint({ name: '', protocol: 'anthropic', baseUrl: LOCAL });

    store.update({
      provider: 'custom',
      customProtocol: 'openai',
      baseUrl: `${LOCAL}/v1`,
      apiKey: 'gw-key',
      model: 'local-model',
    });

    expect(store.getAll().customEndpoints.map((endpoint) => endpoint.name)).toEqual([
      '127.0.0.1:9000',
      '127.0.0.1:9000 (OpenAI)',
    ]);
  });
});

/** A config as app 1.0.8 wrote it, with one local gateway used through two protocols. */
function release108TwoProtocolsOnOneHost(): Record<string, unknown> {
  const anthropicProfiles = {
    'custom:anthropic': { apiKey: 'gw-key', baseUrl: LOCAL, model: 'claude-opus-5' },
  };
  return {
    provider: 'custom',
    customProtocol: 'anthropic',
    apiKey: 'gw-key',
    baseUrl: LOCAL,
    model: 'claude-opus-5',
    activeProfileKey: 'custom:anthropic',
    profiles: anthropicProfiles,
    activeConfigSetId: 'default',
    configSchemaVersion: 2,
    configSets: [
      {
        id: 'default',
        name: 'Default',
        isSystem: true,
        provider: 'custom',
        customProtocol: 'anthropic',
        activeProfileKey: 'custom:anthropic',
        enableThinking: false,
        thinkingLevel: 'off',
        updatedAt: '2026-09-01T00:00:00.000Z',
        profiles: anthropicProfiles,
      },
      {
        id: 'set-2',
        name: 'Local OpenAI',
        provider: 'custom',
        customProtocol: 'openai',
        activeProfileKey: 'custom:openai',
        enableThinking: false,
        thinkingLevel: 'off',
        updatedAt: '2026-09-02T00:00:00.000Z',
        profiles: {
          'custom:openai': { apiKey: 'gw-key', baseUrl: `${LOCAL}/v1`, model: 'gpt-local' },
        },
      },
    ],
  };
}

describe('naming an endpoint that was stored without a name', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  it('tells two protocols on one host apart there too', () => {
    // No build writes a blank name; a file edited by hand can hold one.
    mocks.seed = {
      activeConfigSetId: 'default',
      configSets: [
        {
          id: 'default',
          name: 'Default',
          isSystem: true,
          provider: 'anthropic',
          model: 'claude-opus-5',
          enableThinking: false,
          thinkingLevel: 'off',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      providerCredentials: {},
      customEndpoints: [
        { id: 'custom-endpoint-1', name: '', protocol: 'anthropic', baseUrl: LOCAL, apiKey: '' },
        {
          id: 'custom-endpoint-2',
          name: '  ',
          protocol: 'openai',
          baseUrl: `${LOCAL}/v1`,
          apiKey: '',
        },
        { id: 'custom-endpoint-3', name: 'kept', protocol: 'gemini', baseUrl: LOCAL, apiKey: '' },
      ],
    };

    expect(new ConfigStore().getAll().customEndpoints.map((endpoint) => endpoint.name)).toEqual([
      '127.0.0.1:9000',
      '127.0.0.1:9000 (OpenAI)',
      'kept',
    ]);
  });
});

describe('naming the endpoints a conversion builds', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.last = null;
  });

  it('does not repeat the name of an endpoint that is already stored', () => {
    // A pre-split file that also holds an endpoint: what an older build leaves
    // when it writes its own fields back into a file a newer one converted.
    mocks.seed = {
      ...release108TwoProtocolsOnOneHost(),
      customEndpoints: [
        {
          id: 'custom-endpoint-7',
          name: '127.0.0.1:9000',
          protocol: 'gemini',
          baseUrl: LOCAL,
          apiKey: '',
          updatedAt: '2026-09-03T00:00:00.000Z',
        },
      ],
    };
    const byProtocol = Object.fromEntries(
      new ConfigStore()
        .getAll()
        .customEndpoints.map((endpoint) => [endpoint.protocol, endpoint.name])
    );

    expect(byProtocol).toEqual({
      gemini: '127.0.0.1:9000',
      anthropic: '127.0.0.1:9000 (Anthropic)',
      openai: '127.0.0.1:9000 (OpenAI)',
    });
  });

  it('tells two protocols on one host apart, the active set naming first', () => {
    mocks.seed = release108TwoProtocolsOnOneHost();
    const config = new ConfigStore().getAll();

    const byProtocol = Object.fromEntries(
      config.customEndpoints.map((endpoint) => [endpoint.protocol, endpoint.name])
    );
    expect(byProtocol).toEqual({
      anthropic: '127.0.0.1:9000',
      openai: '127.0.0.1:9000 (OpenAI)',
    });
  });

  it('points each set at the endpoint with its own protocol, whatever the names', () => {
    mocks.seed = release108TwoProtocolsOnOneHost();
    const store = new ConfigStore();

    expect(store.getAll().customProtocol).toBe('anthropic');
    const other = store.switchSet({ id: 'set-2' });
    expect(other.customProtocol).toBe('openai');
    expect(other.baseUrl).toBe(`${LOCAL}/v1`);
    expect(other.model).toBe('gpt-local');
  });

  it('gives the same names on every later start', () => {
    mocks.seed = release108TwoProtocolsOnOneHost();
    const first = new ConfigStore().getAll().customEndpoints;
    const second = restart().getAll().customEndpoints;
    const third = restart().getAll().customEndpoints;

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
