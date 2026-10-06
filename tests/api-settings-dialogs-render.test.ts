/**
 * First render of the inside of the two credential dialogs — the custom
 * endpoint's and a catalog provider's — and what their Save and connection
 * check send.
 *
 * A dialog is drawn into the page body, which this suite does not have, so the
 * dialogs keep their state (`useCustomEndpointDialog`, `useProviderConfigDialog`)
 * and their fields apart from the frame. Here the two are rendered once on the
 * server, for a range of credentials. Effects do not run and nothing can be
 * typed, so each case starts from a stored credential that already holds what a
 * user would have typed.
 *
 * Texts appear as their keys: i18n is not initialised here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfigSet, AppConfig, CustomEndpoint } from '../src/renderer/types';
import { BUILTIN_ENTRIES, type ProviderCatalogEntry } from '../src/shared/provider-catalog';
import {
  useCustomEndpointDialog,
  type CustomEndpointDialogForm,
  type CustomEndpointDialogProps,
} from '../src/renderer/components/CustomEndpointDialog';
import ApiDiagnosticsPanel from '../src/renderer/components/ApiDiagnosticsPanel';
import { CustomEndpointFields } from '../src/renderer/components/CustomEndpointFields';
import {
  useProviderConfigDialog,
  type ProviderConfigDialogForm,
  type ProviderConfigDialogProps,
} from '../src/renderer/components/ProviderConfigDialog';
import { ProviderCredentialFields } from '../src/renderer/components/ProviderCredentialFields';
import { FALLBACK_PROVIDER_PRESETS } from '../src/renderer/hooks/api-config-shared';

const presets = FALLBACK_PROVIDER_PRESETS;
const saved = async () => ({ ok: true as const, config: {} as AppConfig });

function set(overrides: Partial<ApiConfigSet>): ApiConfigSet {
  return {
    id: 'default',
    name: 'Default',
    isSystem: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    enableThinking: false,
    thinkingLevel: 'off',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function endpoint(overrides: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-endpoint-1',
    name: 'hosted-gateway',
    protocol: 'openai',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: 'gw-key',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A native provider as the catalog built from the installed pi lists it. */
const kimiCoding: ProviderCatalogEntry = {
  id: 'kimi-coding',
  name: 'Kimi (Moonshot)',
  kind: 'native',
  category: 'coding-plan',
  piProvider: 'kimi-coding',
  routeProtocol: 'anthropic',
  formShape: {
    apiKey: true,
    baseUrl: false,
    protocol: false,
    contextWindow: false,
    modelDropdown: true,
    manualModelToggle: false,
  },
  modelOptions: [],
};
/** The catalog as it is once the installed pi has been read. */
const providerCatalog: ProviderCatalogEntry[] = [...BUILTIN_ENTRIES, kimiCoding];

function renderEndpointDialog(overrides: Partial<CustomEndpointDialogProps> = {}) {
  const props: CustomEndpointDialogProps = {
    endpoint: null,
    customEndpoints: [],
    usedBy: [],
    droppedKeySets: [],
    configSets: [set({})],
    activeConfigSetId: 'default',
    presets,
    providerCatalog,
    onSave: vi.fn(saved),
    onOpenProvider: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  let captured: CustomEndpointDialogForm | null = null;
  function Harness() {
    const form = useCustomEndpointDialog(props);
    captured = form;
    return createElement(CustomEndpointFields, { form });
  }
  const html = renderToString(createElement(Harness));
  return { html, props, form: captured as unknown as CustomEndpointDialogForm };
}

const anthropic = BUILTIN_ENTRIES.find((entry) => entry.id === 'anthropic')!;
const ollama = BUILTIN_ENTRIES.find((entry) => entry.id === 'ollama')!;

function renderProviderDialog(
  overrides: Partial<ProviderConfigDialogProps> = {},
  // A moment a first render cannot reach by itself: a check that is on its way.
  adjust: (form: ProviderConfigDialogForm) => ProviderConfigDialogForm = (form) => form
) {
  const props: ProviderConfigDialogProps = {
    entry: anthropic,
    apiKey: 'sk-ant-typed',
    baseUrl: '',
    showsBaseUrl: false,
    baseUrlPlaceholder: 'https://api.anthropic.com',
    needsKey: true,
    keyPlaceholder: 'sk-ant-…',
    usedBy: [],
    droppedKeySets: [],
    protocol: 'anthropic',
    checkModel: 'claude-opus-5',
    onSave: vi.fn(saved),
    onClose: vi.fn(),
    ...overrides,
  };
  let captured: ProviderConfigDialogForm | null = null;
  function Harness() {
    const form = adjust(useProviderConfigDialog(props));
    captured = form;
    return createElement(ProviderCredentialFields, { form });
  }
  const html = renderToString(createElement(Harness));
  return { html, props, form: captured as unknown as ProviderConfigDialogForm };
}

/** Stand in for the bridge to main, for the one call a connection check makes. */
function stubDiagnose() {
  const diagnose = vi.fn(async () => ({ steps: [], overallOk: true, totalLatencyMs: 0 }));
  vi.stubGlobal('window', { electronAPI: { config: { diagnose } } });
  return diagnose;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the endpoint dialog for a new endpoint', () => {
  it('draws its five fields, empty', () => {
    const { html, form } = renderEndpointDialog();

    for (const id of [
      'endpoint-name-input',
      'endpoint-base-url-input',
      'endpoint-api-key-input',
      'endpoint-default-model-input',
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain('api.protocol');
    expect(form.values).toEqual({
      name: '',
      protocol: 'anthropic',
      baseUrl: '',
      apiKey: '',
      defaultModel: '',
    });
    expect(form.isNew).toBe(true);
  });

  it('offers the ready-made setups an endpoint can be filled from, and only those', () => {
    const { html, form } = renderEndpointDialog();

    expect(html).toContain('api.guidance.commonSetupsTitle');
    for (const name of ['deepseek', 'glm', 'minimax', 'genericOpenAI']) {
      expect(html, name).toContain(`api.guidance.setups.${name}.name`);
    }
    // Catalog providers with an entry of their own on the tab.
    for (const name of ['openrouter', 'ollama', 'gemini', 'kimi']) {
      expect(html, name).not.toContain(`api.guidance.setups.${name}.name`);
    }
    expect(form.setups).toHaveLength(4);
    expect(html.match(/api\.guidance\.apply/g)).toHaveLength(4);
  });

  it('lists a setup again while the catalog has no entry for its service', () => {
    // Before the installed pi has been read the catalog holds the builtin
    // providers only: Kimi has no entry yet, Gemini always has.
    const { html, form } = renderEndpointDialog({ providerCatalog: [...BUILTIN_ENTRIES] });

    expect(html).toContain('api.guidance.setups.kimi.name');
    expect(html).not.toContain('api.guidance.setups.gemini.name');
    expect(form.setups).toHaveLength(5);
  });

  it('draws the list folded, to be opened by whoever wants it', () => {
    const { html } = renderEndpointDialog();
    const details = html.slice(
      html.indexOf('<details'),
      html.indexOf('>', html.indexOf('<details'))
    );

    expect(details).not.toContain('open');
  });

  it('shows no hint before anything is typed', () => {
    const { html, form } = renderEndpointDialog();

    expect(form.protocolHint).toBe('');
    expect(form.addressHint).toBe('');
    expect(form.catalogProviderName).toBe('');
    expect(html).not.toContain('api.providers.catalogProviderHint');
    expect(html).not.toContain('api.providers.droppedKeyInDialog');
    expect(html).not.toContain('role="alert"');
  });
});

describe('the endpoint dialog for an endpoint that exists', () => {
  it('opens on what is stored and says which config sets it would change', () => {
    const { html, form } = renderEndpointDialog({
      endpoint: endpoint({ defaultModel: 'gpt-5.4' }),
      usedBy: ['Work', 'Research'],
    });

    expect(form.isNew).toBe(false);
    expect(form.values).toEqual({
      name: 'hosted-gateway',
      protocol: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'gw-key',
      defaultModel: 'gpt-5.4',
    });
    expect(html).toContain('api.providers.sharedEndpointNotice');
    expect(html).toContain('value="https://gateway.example.com/v1"');
  });

  it('does not offer to refill an endpoint config sets already run on', () => {
    const { html } = renderEndpointDialog({ endpoint: endpoint({}) });

    expect(html).not.toContain('api.guidance.commonSetupsTitle');
    expect(html).not.toContain('api.guidance.apply');
  });

  it('says so when the conversion dropped a key that some config sets had for it', () => {
    expect(
      renderEndpointDialog({ endpoint: endpoint({}), droppedKeySets: ['Work'] }).html
    ).toContain('api.providers.droppedKeyInDialog');
    expect(renderEndpointDialog({ endpoint: endpoint({}) }).html).not.toContain(
      'api.providers.droppedKeyInDialog'
    );
  });
});

describe('the hints under protocol and address', () => {
  it('names a service it recognises and the protocol that suits it', () => {
    const { html, form } = renderEndpointDialog({
      endpoint: endpoint({ protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/v1' }),
    });

    expect(form.protocolHint).toBe('api.guidance.protocolMismatch');
    expect(form.protocolHintTone).toBe('warning');
    expect(form.addressHint).toBe('api.guidance.baseUrlHint');
    expect(html).toContain('api.guidance.protocolMismatch');
    expect(html).toContain('api.guidance.baseUrlHint');
  });

  it('says the protocol fits when it does', () => {
    const { form } = renderEndpointDialog({
      endpoint: endpoint({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' }),
    });

    expect(form.protocolHint).toBe('api.guidance.protocolLooksGood');
    expect(form.protocolHintTone).toBe('info');
  });

  it('describes the usual shape of an address for a service it does not know', () => {
    const { form } = renderEndpointDialog({ endpoint: endpoint({}) });

    expect(form.protocolHint).toBe('');
    expect(form.addressHint).toBe('api.guidance.genericBaseUrlHint');
  });
});

describe('an address that belongs to a catalog provider', () => {
  it('is pointed at that provider, with a way to go there', () => {
    const { html, form, props } = renderEndpointDialog({
      endpoint: endpoint({ baseUrl: 'https://openrouter.ai/api/v1' }),
    });

    expect(form.catalogProviderName).toBe('OpenRouter');
    expect(html).toContain('api.providers.catalogProviderHint');
    expect(html).toContain('api.providers.openCatalogProvider');

    form.openCatalogProvider();
    expect(props.onOpenProvider).toHaveBeenCalledTimes(1);
    expect(props.onOpenProvider).toHaveBeenCalledWith('openrouter');
  });

  it('replaces the hints about protocol and address, which no longer matter', () => {
    const { html, form } = renderEndpointDialog({
      endpoint: endpoint({ baseUrl: 'https://openrouter.ai/api/v1' }),
    });

    expect(form.protocolHint).toBe('');
    expect(form.addressHint).toBe('');
    expect(form.checkFailureHint).toBe('');
    // The old screen's wording sent the user to a "tab" that no longer exists.
    expect(html).not.toContain('api.guidance.preferProviderTab');
  });

  it('recognises a local Ollama on its usual port, and not a server on another', () => {
    expect(
      renderEndpointDialog({ endpoint: endpoint({ baseUrl: 'http://localhost:11434/v1' }) }).form
        .catalogProviderName
    ).toBe('Ollama');

    const elsewhere = renderEndpointDialog({
      endpoint: endpoint({ baseUrl: 'http://localhost:8080/v1' }),
    });
    expect(elsewhere.form.catalogProviderName).toBe('');
    expect(elsewhere.html).not.toContain('api.providers.catalogProviderHint');
  });

  it('recognises Google’s own address as the Gemini provider', () => {
    const { html, form, props } = renderEndpointDialog({
      endpoint: endpoint({
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
      }),
    });

    expect(form.catalogProviderName).toBe('Gemini');
    expect(html).toContain('api.providers.catalogProviderHint');
    // Not "your protocol already matches": that would read as approval.
    expect(form.protocolHint).toBe('');
    expect(form.addressHint).toBe('');

    form.openCatalogProvider();
    expect(props.onOpenProvider).toHaveBeenCalledWith('gemini');
  });

  it('recognises Kimi’s coding address as the catalog’s Kimi provider, by the name the tab shows', () => {
    const { form, props } = renderEndpointDialog({
      endpoint: endpoint({ protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding' }),
    });

    expect(form.catalogProviderName).toBe('Kimi (Moonshot)');
    form.openCatalogProvider();
    expect(props.onOpenProvider).toHaveBeenCalledWith('kimi-coding');
  });

  it('gives the ordinary hints for such an address while the catalog has no entry for it', () => {
    // Nothing to send the user to: the address is a custom endpoint like any other.
    const { html, form, props } = renderEndpointDialog({
      endpoint: endpoint({ protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding' }),
      providerCatalog: [...BUILTIN_ENTRIES],
    });

    expect(form.catalogProviderName).toBe('');
    expect(html).not.toContain('api.providers.catalogProviderHint');
    expect(form.protocolHint).toBe('api.guidance.protocolLooksGood');
    expect(form.addressHint).toBe('api.guidance.baseUrlHint');

    form.openCatalogProvider();
    expect(props.onOpenProvider).not.toHaveBeenCalled();
  });

  it('goes nowhere when the address is not one', () => {
    const { form, props } = renderEndpointDialog({ endpoint: endpoint({}) });

    form.openCatalogProvider();
    expect(props.onOpenProvider).not.toHaveBeenCalled();
  });

  it('does not stop the endpoint from being saved', async () => {
    // A hint, not a rule: reaching such a service through a custom endpoint is
    // unusual but allowed.
    const { form, props } = renderEndpointDialog({
      endpoint: endpoint({ baseUrl: 'https://openrouter.ai/api/v1' }),
    });

    form.submit();
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });
});

describe('saving from the endpoint dialog', () => {
  it('sends the fields as they stand, then closes', async () => {
    const { form, props } = renderEndpointDialog({
      endpoint: endpoint({ defaultModel: 'gpt-5.4' }),
    });

    form.submit();

    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith({
      name: 'hosted-gateway',
      protocol: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'gw-key',
      defaultModel: 'gpt-5.4',
    });
    await vi.waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('asks main for nothing while the endpoint has no address', () => {
    const { form, props } = renderEndpointDialog();

    form.submit();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('asks main for nothing when another endpoint already has that protocol and address', () => {
    const other = endpoint({ id: 'custom-endpoint-2', name: 'twin' });
    const { form, props } = renderEndpointDialog({
      endpoint: endpoint({}),
      customEndpoints: [endpoint({}), other],
    });

    form.submit();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('is not stopped by the endpoint being compared with itself', () => {
    const { form, props } = renderEndpointDialog({
      endpoint: endpoint({}),
      customEndpoints: [endpoint({})],
    });

    form.submit();
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });
});

describe('the connection check in the endpoint dialog', () => {
  it('says which model it will try, or that it has none to try', () => {
    const named = renderEndpointDialog({ endpoint: endpoint({ defaultModel: 'gpt-5.4' }) });
    expect(named.form.checkModel).toBe('gpt-5.4');
    expect(named.html).toContain('api.providers.check.withModel');
    expect(named.html).not.toContain('api.providers.check.noModel');

    const none = renderEndpointDialog();
    expect(none.form.checkModel).toBe('');
    expect(none.html).toContain('api.providers.check.noModel');
    expect(none.html).not.toContain('api.providers.check.withModel');
  });

  it('borrows the model of a config set that runs on the endpoint when the field is empty', () => {
    const { form } = renderEndpointDialog({
      endpoint: endpoint({}),
      configSets: [
        set({ id: 'cloud', model: 'claude-opus-5' }),
        set({
          id: 'work',
          provider: 'custom',
          endpointId: 'custom-endpoint-1',
          model: 'house-model',
        }),
      ],
      activeConfigSetId: 'cloud',
    });

    expect(form.checkModel).toBe('house-model');
  });

  it('runs against what is in the fields, with that model', () => {
    const { form } = renderEndpointDialog({ endpoint: endpoint({ defaultModel: 'gpt-5.4' }) });
    const diagnose = stubDiagnose();

    form.runCheck();

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith({
      provider: 'custom',
      apiKey: 'gw-key',
      baseUrl: 'https://gateway.example.com/v1',
      customProtocol: 'openai',
      model: 'gpt-5.4',
      verificationLevel: 'fast',
    });
  });

  it('stops short of a model rather than borrow one from somewhere else', () => {
    // `model` left out makes main skip its last step. A model it does not know
    // about must never be filled in for it — the active config set's, say.
    const { form } = renderEndpointDialog({
      endpoint: endpoint({}),
      configSets: [set({ id: 'cloud', model: 'claude-opus-5' })],
      activeConfigSetId: 'cloud',
    });
    const diagnose = stubDiagnose();

    form.runCheck();

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose.mock.calls[0][0]).toMatchObject({ provider: 'custom', model: undefined });
  });

  it('does not run without an address', () => {
    // With a key, so that it is the missing address that stops it: an endpoint
    // is its address, and main would otherwise be sent to check a made-up one.
    const { form } = renderEndpointDialog({ endpoint: endpoint({ baseUrl: '   ' }) });
    const diagnose = stubDiagnose();

    form.runCheck();
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('does not run without a key, except against a gateway on this computer', () => {
    const hosted = renderEndpointDialog({ endpoint: endpoint({ apiKey: '' }) });
    let diagnose = stubDiagnose();
    hosted.form.runCheck();
    expect(diagnose).not.toHaveBeenCalled();

    const local = renderEndpointDialog({
      endpoint: endpoint({ apiKey: '', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:9000' }),
    });
    diagnose = stubDiagnose();
    local.form.runCheck();
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose.mock.calls[0][0]).toMatchObject({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:9000',
      customProtocol: 'anthropic',
    });
  });
});

describe('the provider dialog', () => {
  it('draws the key, and an address only where the provider has one', () => {
    const cloud = renderProviderDialog();
    expect(cloud.html).toContain('id="provider-api-key-input"');
    expect(cloud.html).not.toContain('id="provider-base-url-input"');
    expect(cloud.html).toContain('api.apiKeyDescription');

    const local = renderProviderDialog({
      entry: ollama,
      apiKey: '',
      showsBaseUrl: true,
      baseUrlPlaceholder: 'http://localhost:11434/v1',
      needsKey: false,
      protocol: 'openai',
      checkModel: '',
    });
    expect(local.html).toContain('id="provider-base-url-input"');
    expect(local.html).toContain('placeholder="http://localhost:11434/v1"');
    expect(local.html).toContain('api.providers.keyOptionalHint');
  });

  it('offers the search for a local server on Ollama only', () => {
    const local = renderProviderDialog({
      entry: ollama,
      apiKey: '',
      showsBaseUrl: true,
      needsKey: false,
      protocol: 'openai',
      checkModel: '',
    });
    expect(local.form.canSearchOllama).toBe(true);
    expect(local.html).toContain('api.discoverLocalOllama');
    expect(local.html).toContain('api.providers.ollamaSearchHint');
    // Nothing has been searched for yet.
    expect(local.form.searchNote).toBeNull();

    const cloud = renderProviderDialog({ showsBaseUrl: true });
    expect(cloud.form.canSearchOllama).toBe(false);
    expect(cloud.html).not.toContain('api.discoverLocalOllama');
    expect(cloud.html).not.toContain('api.providers.ollamaSearchHint');
  });

  it('says which config sets use the provider, and when the conversion dropped a key', () => {
    const { html } = renderProviderDialog({ usedBy: ['Work'], droppedKeySets: ['Research'] });

    expect(html).toContain('api.providers.usedBy');
    expect(html).toContain('api.providers.droppedKeyInDialog');
    expect(renderProviderDialog().html).not.toContain('api.providers.droppedKeyInDialog');
  });

  it('saves the key and address as they stand, then closes', async () => {
    const { form, props } = renderProviderDialog({ baseUrl: 'https://proxy.example.com' });

    form.submit();

    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith({
      apiKey: 'sk-ant-typed',
      baseUrl: 'https://proxy.example.com',
    });
    await vi.waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });
});

describe('the connection check in the provider dialog', () => {
  it('says which model it will try, or that it has none to try', () => {
    expect(renderProviderDialog().html).toContain('api.providers.check.withModel');
    const none = renderProviderDialog({ checkModel: '' });
    expect(none.html).toContain('api.providers.check.noModel');
    expect(none.html).not.toContain('api.providers.check.withModel');
  });

  it('runs against the key in the field, at the usual address when none is given', () => {
    const { form } = renderProviderDialog();
    const diagnose = stubDiagnose();

    form.runCheck();

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith({
      provider: 'anthropic',
      apiKey: 'sk-ant-typed',
      baseUrl: 'https://api.anthropic.com',
      customProtocol: 'anthropic',
      model: 'claude-opus-5',
      verificationLevel: 'fast',
    });
  });

  it('runs against an address of the user’s own when one is given', () => {
    const { form } = renderProviderDialog({ baseUrl: 'https://proxy.example.com' });
    const diagnose = stubDiagnose();

    form.runCheck();
    expect(diagnose.mock.calls[0][0]).toMatchObject({ baseUrl: 'https://proxy.example.com' });
  });

  it('does not run for a provider that needs a key and has none', () => {
    const { form } = renderProviderDialog({ apiKey: '' });
    const diagnose = stubDiagnose();

    form.runCheck();
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('runs for Ollama with no key, leaving an empty address for main to fill in', () => {
    const { form } = renderProviderDialog({
      entry: ollama,
      apiKey: '',
      showsBaseUrl: true,
      baseUrlPlaceholder: 'http://localhost:11434/v1',
      needsKey: false,
      protocol: 'openai',
      checkModel: '',
    });
    const diagnose = stubDiagnose();

    form.runCheck();

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith({
      provider: 'ollama',
      apiKey: '',
      baseUrl: undefined,
      customProtocol: 'openai',
      model: undefined,
      verificationLevel: 'fast',
    });
  });
});

describe('a check and a search for Ollama, one at a time', () => {
  const ollamaDialog = {
    entry: ollama,
    apiKey: '',
    showsBaseUrl: true,
    baseUrlPlaceholder: 'http://localhost:11434/v1',
    needsKey: false,
    protocol: 'openai' as const,
    checkModel: '',
  };
  // The diagnostics panel gives its button a fallback text beside the key, and
  // with no translations loaded that fallback is what gets drawn.
  const CHECK_BUTTON = 'Diagnose Connection';
  /** The opening tag of the button with the given text. */
  const buttonOf = (html: string, text: string) => {
    const at = html.indexOf(text);
    expect(at, text).toBeGreaterThan(-1);
    const start = html.lastIndexOf('<button', at);
    return html.slice(start, html.indexOf('>', start) + 1);
  };

  it('offers both when neither is on its way', () => {
    const { html } = renderProviderDialog(ollamaDialog);

    expect(buttonOf(html, 'api.discoverLocalOllama')).not.toContain('disabled=""');
    expect(buttonOf(html, CHECK_BUTTON)).not.toContain('disabled=""');
  });

  it('does not offer a search while a check is out', () => {
    // What a search finds is written into the address field, and a result is
    // dropped as soon as the address changes: started now, it would cancel the
    // check the user is waiting for.
    const { html } = renderProviderDialog(ollamaDialog, (form) => ({
      ...form,
      check: { ...form.check, isChecking: true },
    }));

    expect(buttonOf(html, 'api.discoverLocalOllama')).toContain('disabled=""');
  });

  it('does not offer a check while a search is out, and holds the address still', () => {
    const { html } = renderProviderDialog(ollamaDialog, (form) => ({
      ...form,
      isSearchingOllama: true,
    }));

    // Its own button is busy rather than off, so that it keeps focus (below).
    const search = buttonOf(html, 'api.discoveringLocalOllama');
    expect(search).toContain('aria-disabled="true"');
    expect(search).not.toContain('disabled=""');
    expect(buttonOf(html, CHECK_BUTTON)).toContain('disabled=""');
    const address = html.indexOf('id="provider-base-url-input"');
    expect(html.slice(html.lastIndexOf('<input', address), html.indexOf('>', address))).toContain(
      'disabled=""'
    );
  });
});

describe('a result and the values it was run against', () => {
  it('goes as soon as the address, the key, the protocol or the model changes', () => {
    // So a result can never sit next to "this endpoint needs an address": the
    // address had to change to become empty, and that change removed it. The
    // rule is the form's own, in the part both dialogs reuse.
    const connectivity = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/hooks/useApiConnectivity.ts'),
      'utf8'
    );
    const reset = connectivity.slice(
      connectivity.indexOf('const resultGenerationRef = useRef(0);'),
      connectivity.indexOf('latestOllamaTargetRef.current = {')
    );

    expect(reset).toContain('resultGenerationRef.current += 1;');
    expect(reset).toContain('setDiagnosticResult(null);');
    expect(reset).toContain('setIsDiagnosing(false);');
    expect(reset).toContain(
      '}, [resetKey, provider, customProtocol, apiKey, baseUrl, finalModel, clearError]);'
    );
  });

  it('cannot exist for a new endpoint before it has an address', () => {
    const { form } = renderEndpointDialog();
    const diagnose = stubDiagnose();

    form.runCheck();
    expect(diagnose).not.toHaveBeenCalled();
    expect(form.check.result).toBeNull();
  });
});

describe('a button that was just pressed keeps focus', () => {
  // A disabled button cannot hold focus. One that switched itself off for the
  // time its own action takes would drop focus onto the page — in a dialog, out
  // from under the keyboard, as the first check in the running app showed.
  const read = (file: string) =>
    fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components', file), 'utf8');
  const panel = (props: { isRunning: boolean; disabled?: boolean; deep?: boolean }) =>
    renderToString(
      createElement(ApiDiagnosticsPanel, {
        result: null,
        isRunning: props.isRunning,
        onRunDiagnostics: () => {},
        onRunDeepDiagnostics: props.deep ? () => {} : undefined,
        disabled: props.disabled,
      })
    );
  const buttons = (html: string) => html.match(/<button[^>]*>/g) ?? [];

  it('is busy, not off, while a check it started is on its way', () => {
    for (const button of buttons(panel({ isRunning: true, deep: true }))) {
      expect(button).toContain('aria-disabled="true"');
      expect(button).not.toContain('disabled=""');
    }
    expect(buttons(panel({ isRunning: true, deep: true }))).toHaveLength(2);
  });

  it('is plainly available when nothing is running', () => {
    for (const button of buttons(panel({ isRunning: false, deep: true }))) {
      expect(button).not.toContain('aria-disabled');
      expect(button).not.toContain('disabled=""');
    }
  });

  it('is really off when the screen says the check cannot be run', () => {
    // No key, no endpoint, a save on its way: nothing was pressed, so there is
    // no focus to keep.
    for (const button of buttons(panel({ isRunning: false, disabled: true }))) {
      expect(button).toContain('disabled=""');
    }
  });

  it('ignores a second press while it is busy', () => {
    const source = read('ApiDiagnosticsPanel.tsx');
    expect(source).toContain('if (!isRunning) onRunDiagnostics();');
    expect(source).toContain('if (!isRunning) onRunDeepDiagnostics();');
    // And is never switched off by its own run.
    expect(source).not.toContain('disabled={disabled || isRunning}');

    const fields = read('ProviderCredentialFields.tsx');
    expect(fields).toContain('if (!isSearchingOllama) void form.searchOllama();');
    expect(fields).toContain('disabled={isSaving || isChecking}');
  });
});

describe('the setups list after one of them is applied', () => {
  const card = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/components/ProviderGuidance.tsx'),
    'utf8'
  );
  const list = card.slice(
    card.indexOf('function CommonProviderSetupsList('),
    card.indexOf('export function CommonProviderSetupsCard(')
  );

  it('folds itself away, so what it filled in is not left several rows below', () => {
    expect(list).toContain('const [open, setOpen] = useState(false);');
    expect(list).toContain('open={open}');
    // Opened and closed by hand as well, and the two never disagree.
    expect(list).toContain('onToggle={(event) => setOpen(event.currentTarget.open)}');
    expect(list).toMatch(/onApplySetup\(setupId\);\s+setOpen\(false\);/);
    expect(list).toContain('onClick={() => apply(setup.id)}');
  });

  it('moves focus to its heading, since the pressed button is folded away with the rest', () => {
    expect(list).toMatch(/setOpen\(false\);\s+summaryRef\.current\?\.focus\(\);/);
    expect(list).toContain('<summary ref={summaryRef}');
  });

  it('is left as it was in the wide layout of the first-run dialog', () => {
    const table = card.slice(card.indexOf('export function CommonProviderSetupsCard('));
    expect(table).not.toContain('setOpen');
    expect(table).toContain('onClick={() => onApplySetup(setup.id)}');
  });
});

describe('what a dialog leaves switched off', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

  it('does not fetch a model list, or report a silent server, while an address is typed', () => {
    // On the Model Sets tab the list of Ollama's models follows its address. A
    // dialog has no model to pick: fetching it there would only put "cannot
    // connect" next to an address the user has not finished typing.
    const check = read('src/renderer/hooks/useCredentialCheck.ts');
    expect(check).toContain('listsModels: false,');

    const connectivity = read('src/renderer/hooks/useApiConnectivity.ts');
    expect(connectivity).toContain('listsModels = true,');
    expect(connectivity).toContain("if (!listsModels || provider !== 'ollama') return;");
  });

  it('words the outcome of an Ollama search itself, next to the address', () => {
    const check = read('src/renderer/hooks/useCredentialCheck.ts');
    expect(check).toContain('discoverLocalOllama({ silent: true })');

    const dialog = read('src/renderer/components/ProviderConfigDialog.tsx');
    expect(dialog).toContain('setSearchNote(ollamaSearchNote(await searchForOllama()));');
    // What a search finds goes into the field without clearing the note about it.
    expect(dialog).toContain('setBaseUrl: setBaseUrlValue,');
  });

  it('holds the address still while a search is out, so the answer cannot land on another one', () => {
    const fields = read('src/renderer/components/ProviderCredentialFields.tsx');
    expect(fields).toContain('disabled={isSaving || isSearchingOllama}');
  });
});
