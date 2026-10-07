/**
 * First render of the Providers and Model Sets tabs themselves.
 *
 * No test can click these screens — the suite has no browser — so this is the
 * one place their markup runs at all: each tab is rendered once on the server
 * against a loaded state, for a range of configs, to catch a render-time throw
 * and to check that what the user came for is on the page (each endpoint by
 * name, which sets use it, a warning where a set cannot run).
 *
 * Texts appear as their keys: i18n is not initialised here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiConfigSet, AppConfig, CustomEndpoint } from '../src/renderer/types';
import { BUILTIN_ENTRIES } from '../src/shared/provider-catalog';
import { ApiSettingsContext } from '../src/renderer/components/settings/ApiSettingsContext';
import {
  CredentialStatusBadge,
  EndpointListRow,
} from '../src/renderer/components/settings/ProviderListRows';
import { SettingsModelSets } from '../src/renderer/components/settings/SettingsModelSets';
import { SettingsProviders } from '../src/renderer/components/settings/SettingsProviders';
import { useApiSettingsState } from '../src/renderer/hooks/useApiSettingsState';

type Tab = typeof SettingsProviders | typeof SettingsModelSets;
type SetsState = ReturnType<typeof useApiSettingsState>['sets'];

/**
 * Render a tab as it looks once its data has arrived. `sets` overrides part of
 * the config-set half, for a moment a first render cannot reach by itself: a
 * save or a switch that is on its way.
 */
function renderTab(
  tab: Tab,
  initialConfig: AppConfig | null,
  loading = false,
  sets: Partial<SetsState> = {}
): string {
  function Harness() {
    const loaded = useApiSettingsState({ initialConfig });
    const state = { ...loaded, sets: { ...loaded.sets, ...sets } };
    return createElement(
      ApiSettingsContext.Provider,
      { value: { ...state, isLoadingConfig: loading, isCatalogLoading: false } },
      tab === SettingsProviders
        ? createElement(SettingsProviders, { isActive: true })
        : createElement(SettingsModelSets)
    );
  }
  return renderToString(createElement(Harness));
}

function set(overrides: Partial<ApiConfigSet>): ApiConfigSet {
  return {
    id: 'default',
    name: 'Default',
    isSystem: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    enableThinking: false,
    thinkingLevel: 'off',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function config(overrides: Partial<AppConfig>): AppConfig {
  return {
    provider: 'anthropic',
    apiKey: '',
    model: 'claude-sonnet-4-6',
    providerCredentials: {},
    customEndpoints: [],
    credentialConflicts: [],
    activeConfigSetId: 'default',
    configSets: [set({})],
    isConfigured: true,
    ...overrides,
  } as AppConfig;
}

const local: CustomEndpoint = {
  id: 'custom-endpoint-1',
  name: 'kiro-gateway',
  protocol: 'anthropic',
  baseUrl: 'http://127.0.0.1:9000',
  apiKey: '',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const hosted: CustomEndpoint = {
  id: 'custom-endpoint-2',
  name: 'hosted-gateway',
  protocol: 'openai',
  baseUrl: 'https://gateway.example.com/v1',
  apiKey: 'gw-secret-key',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const twoGateways = config({
  provider: 'custom',
  providerCredentials: { anthropic: { apiKey: 'sk-ant-secret' } },
  customEndpoints: [local, hosted],
  activeConfigSetId: 'work',
  configSets: [
    set({ id: 'default', name: 'Local', provider: 'custom', endpointId: local.id, model: 'm' }),
    set({
      id: 'work',
      name: 'Hosted work',
      isSystem: false,
      provider: 'custom',
      endpointId: hosted.id,
      model: 'gpt-5.4',
    }),
  ],
});

describe('the Providers tab', () => {
  it('lists each custom endpoint by name, with its address and the sets that use it', () => {
    const html = renderTab(SettingsProviders, twoGateways);

    for (const text of [
      'kiro-gateway',
      'http://127.0.0.1:9000',
      'hosted-gateway',
      'https://gateway.example.com/v1',
      'api.providers.customEndpoints',
      'api.providers.addEndpoint',
      'api.providers.usedBy',
    ]) {
      expect(html, text).toContain(text);
    }
  });

  it('lists the catalog providers, without the bare "Custom"', () => {
    const html = renderTab(SettingsProviders, twoGateways);

    for (const entry of BUILTIN_ENTRIES.filter((candidate) => candidate.id !== 'custom')) {
      expect(html, entry.name).toContain(entry.name);
    }
    expect(html).toContain('api.providers.configure');
    expect(html).toContain('api.providers.status.configured');
    expect(html).toContain('api.providers.status.notSet');
  });

  it('never puts a key on the page: keys are shown only inside a dialog', () => {
    const html = renderTab(SettingsProviders, twoGateways);

    expect(html).not.toContain('gw-secret-key');
    expect(html).not.toContain('sk-ant-secret');
  });

  it('says so when there are no custom endpoints', () => {
    const html = renderTab(SettingsProviders, config({}));

    expect(html).toContain('api.providers.noEndpoints');
  });

  it('renders with no config at all, and shows a spinner while loading', () => {
    expect(renderTab(SettingsProviders, null)).toContain('api.providers.customEndpoints');
    expect(renderTab(SettingsProviders, null, true)).toContain('common.loading');
  });
});

describe('the status shown on a row', () => {
  it('says what state the credential is in', () => {
    expect(
      renderToString(createElement(CredentialStatusBadge, { status: 'key-missing' }))
    ).toContain('api.providers.status.keyMissing');
  });

  it('says "saved" instead, for a moment, on the row a save was made for', () => {
    // The list is long. A notice anywhere but on the row itself can be
    // scrolled out of sight when a provider far down the list is saved.
    const html = renderToString(
      createElement(CredentialStatusBadge, { status: 'configured', justSaved: true })
    );

    expect(html).toContain('api.providers.saved');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('api.providers.status.configured');
  });
});

describe('what a provider dialog opens on', () => {
  it('is the credential as stored, not the one a set would run with', () => {
    // The dialog is closed at first render, so its wiring is checked in the
    // source: fed from `persistedCredentialFor`, an untouched Save would store
    // the provider's usual address as if the user had typed it.
    //
    // The values are worked out in one place for the tab's dialog and for the
    // first step of the first-run wizard (`providerDialogValues`, whose result
    // is checked in `credential-dialog-view.test.ts`); the tab only passes them on.
    const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const tab = read('src/renderer/components/settings/SettingsProviders.tsx');
    const rule = read('src/renderer/hooks/credential-dialog-view.ts');

    expect(tab).toContain('providerDialogValues({');
    expect(tab).toContain('{...values}');
    expect(tab).not.toContain('persistedCredentialFor');
    expect(rule).toContain('storedProviderCredential(entry.id, credentials.providerCredentials)');
    expect(rule).not.toContain('persistedCredentialFor');
  });
});

describe('deleting a custom endpoint', () => {
  const row = {
    endpoint: hosted,
    status: 'configured' as const,
    usedBy: [] as string[],
    droppedKeySets: [] as string[],
  };
  const handlers = {
    onEdit: () => {},
    onDelete: () => {},
    onConfirmDelete: () => {},
    onCancelDelete: () => {},
  };

  it('asks for confirmation on the row it is for', () => {
    const html = renderToString(
      createElement(EndpointListRow, {
        row,
        justSaved: false,
        disabled: true,
        confirmingDelete: true,
        isDeleting: false,
        ...handlers,
      })
    );

    expect(html).toContain('hosted-gateway');
    expect(html).toContain('api.providers.deleteEndpointConfirm');
    expect(html).toContain('common.delete');
    expect(html).toContain('common.cancel');
  });

  it('asks nothing on a row that is not being deleted', () => {
    const html = renderToString(
      createElement(EndpointListRow, {
        row,
        justSaved: false,
        disabled: false,
        confirmingDelete: false,
        isDeleting: false,
        ...handlers,
      })
    );

    expect(html).not.toContain('api.providers.deleteEndpointConfirm');
  });

  it('does not offer to delete an endpoint a config set runs on', () => {
    const html = renderToString(
      createElement(EndpointListRow, {
        row: { ...row, usedBy: ['Work'] },
        justSaved: false,
        disabled: false,
        confirmingDelete: false,
        isDeleting: false,
        ...handlers,
      })
    );

    // Edit stays available; only the delete button is off, and says why.
    expect(html).toContain('api.providers.deleteEndpointInUse');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
});

describe('a key the conversion dropped, on the Providers tab', () => {
  const withConflicts = config({
    ...twoGateways,
    credentialConflicts: [
      { target: 'anthropic', setIds: ['work'] },
      { target: hosted.id, setIds: ['default'] },
    ],
  });

  it('is said on the row of each credential it happened to', () => {
    const html = renderTab(SettingsProviders, withConflicts);

    // One provider row, one endpoint row. Texts appear as their keys.
    expect(html.match(/api\.providers\.droppedKey(?!InDialog)/g)).toHaveLength(2);
    // No dialog is open at first render.
    expect(html).not.toContain('api.providers.droppedKeyInDialog');
  });

  it('is not said when nothing was dropped', () => {
    expect(renderTab(SettingsProviders, twoGateways)).not.toContain('api.providers.droppedKey');
  });

  it('is not said about config sets that no longer exist', () => {
    const html = renderTab(
      SettingsProviders,
      config({ ...twoGateways, credentialConflicts: [{ target: 'anthropic', setIds: ['gone'] }] })
    );
    expect(html).not.toContain('api.providers.droppedKey');
  });
});

/** The opening tag that carries the given attribute text. */
function tagWith(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('the Model Sets tab while a call that changes a set is on its way', () => {
  // What main returns replaces what is on screen. A field left open in that
  // moment would show an edit and then silently lose it.
  const FIELDS = [
    'aria-label="api.provider"',
    'id="api-model-input"',
    'id="api-context-window-input"',
    'id="api-max-tokens-input"',
  ];

  it('leaves the chooser and the model fields open when nothing is on its way', () => {
    const html = renderTab(SettingsModelSets, twoGateways);
    for (const field of FIELDS) {
      expect(tagWith(html, field), field).not.toContain('disabled=""');
    }
  });

  it.each(['isSaving', 'isMutatingConfigSet'] as const)(
    'holds the chooser and the model fields still while %s',
    (flag) => {
      const html = renderTab(SettingsModelSets, twoGateways, false, { [flag]: true });
      for (const field of FIELDS) {
        expect(tagWith(html, field), field).toContain('disabled=""');
      }
    }
  );

  it('does not offer another set, or a new one, while a save is on its way', () => {
    const open = renderTab(SettingsModelSets, twoGateways);
    const saving = renderTab(SettingsModelSets, twoGateways, false, { isSaving: true });

    // The set switcher is the first select on the tab.
    expect(tagWith(open, '<select'), 'open').not.toContain('disabled=""');
    expect(tagWith(saving, '<select'), 'saving').toContain('disabled=""');
    // Switcher, its Save / New / Rename / Delete, the chooser, the model field,
    // the two limits and the Save at the foot of the tab: more is off than on
    // an idle tab, where only what cannot apply is.
    const off = (html: string) => (html.match(/disabled=""/g) ?? []).length;
    expect(off(saving) - off(open)).toBeGreaterThanOrEqual(9);
  });
});

describe('the Model Sets tab', () => {
  it('names the endpoint the open set runs on, with its protocol and address', () => {
    const html = renderTab(SettingsModelSets, twoGateways);

    expect(html).toContain('hosted-gateway');
    expect(html).toContain('https://gateway.example.com/v1');
    expect(html).toContain('gpt-5.4');
    expect(html).toContain('api.modelSets.manageProviders');
    // The chosen one, not the other.
    expect(html).not.toContain('http://127.0.0.1:9000');
  });

  it('never puts a key on the page', () => {
    const html = renderTab(SettingsModelSets, twoGateways);

    expect(html).not.toContain('gw-secret-key');
    expect(html).not.toContain('sk-ant-secret');
  });

  it('warns when the provider of the set has no key', () => {
    expect(renderTab(SettingsModelSets, config({}))).toContain('api.modelSets.keyMissing');
    expect(
      renderTab(SettingsModelSets, config({ providerCredentials: { anthropic: { apiKey: 'k' } } }))
    ).not.toContain('api.modelSets.keyMissing');
  });

  it('warns when a custom set points at no endpoint', () => {
    const html = renderTab(
      SettingsModelSets,
      config({ provider: 'custom', configSets: [set({ provider: 'custom', model: 'm' })] })
    );

    expect(html).toContain('api.modelSets.endpointMissing');
    expect(html).toContain('api.modelSets.noEndpoint');
  });

  it('does not ask a keyless local gateway or Ollama for a key', () => {
    const onLocalGateway = renderTab(
      SettingsModelSets,
      config({
        provider: 'custom',
        customEndpoints: [local],
        configSets: [set({ provider: 'custom', endpointId: local.id, model: 'm' })],
      })
    );
    expect(onLocalGateway).not.toContain('api.modelSets.keyMissing');

    const onOllama = renderTab(
      SettingsModelSets,
      config({ provider: 'ollama', configSets: [set({ provider: 'ollama', model: 'llama3' })] })
    );
    expect(onOllama).not.toContain('api.modelSets.keyMissing');
    expect(onOllama).toContain('api.refreshModels');
  });

  it('renders with no config at all, and shows a spinner while loading', () => {
    expect(renderTab(SettingsModelSets, null)).toContain('api.saveSettings');
    expect(renderTab(SettingsModelSets, null, true)).toContain('common.loading');
  });
});
