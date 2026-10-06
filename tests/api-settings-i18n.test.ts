/**
 * The texts of the Providers and Model Sets tabs exist in every language.
 *
 * A key that is missing shows up as the raw key on screen, and no test clicks
 * these screens — so the keys the new code asks for are read out of its source
 * and looked up in all four locale files.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const LOCALES = ['en', 'zh', 'ru', 'hu'] as const;
const SOURCES = [
  'src/renderer/components/CustomEndpointDialog.tsx',
  'src/renderer/components/CustomEndpointFields.tsx',
  'src/renderer/components/ProviderConfigDialog.tsx',
  'src/renderer/components/ProviderCredentialFields.tsx',
  'src/renderer/components/ProviderGuidance.tsx',
  'src/renderer/components/ProviderChoicePicker.tsx',
  'src/renderer/components/settings/CredentialDialogParts.tsx',
  'src/renderer/components/settings/SettingsProviders.tsx',
  'src/renderer/components/settings/SettingsModelSets.tsx',
  'src/renderer/components/settings/ModelFieldsSection.tsx',
  'src/renderer/components/settings/ProviderListRows.tsx',
  'src/renderer/components/settings/SettingsDialogFrame.tsx',
  'src/renderer/hooks/useModelSetForm.ts',
  'src/renderer/hooks/useApiSettingsState.ts',
  'src/renderer/hooks/useCustomEndpointGuidance.ts',
  'src/renderer/hooks/credential-dialog-view.ts',
  'src/renderer/hooks/api-config-shared.ts',
];

type Messages = { [key: string]: string | Messages };

function load(locale: string): Messages {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), `src/renderer/i18n/locales/${locale}.json`), 'utf8')
  ) as Messages;
}

function lookup(messages: Messages, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Messages)[part] : undefined),
      messages
    );
}

function leafKeys(node: Messages, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`)
  );
}

/** Every quoted `api.…` / `settings.…` / `common.…` key in the source of the new screens. */
function keysUsed(): string[] {
  const found = new Set<string>();
  for (const source of SOURCES) {
    const text = fs.readFileSync(path.resolve(process.cwd(), source), 'utf8');
    for (const match of text.matchAll(/'((?:api|settings|common)\.[A-Za-z0-9_.]+)'/g)) {
      // A key that ends in a dot is a prefix completed at run time
      // (`api.thinkingLevelOption.${level}`), not a key.
      if (!match[1].endsWith('.')) {
        found.add(match[1]);
      }
    }
  }
  return [...found].sort();
}

describe('texts of the Providers and Model Sets tabs', () => {
  const used = keysUsed();

  it('finds the keys the screens ask for', () => {
    expect(used.length).toBeGreaterThan(40);
    expect(used).toContain('api.providers.customEndpoints');
    expect(used).toContain('api.modelSets.manageProviders');
    // What the dialogs gained: the check, the hint towards a catalog provider,
    // the dropped-key notice, and the texts of the guidance they now show.
    expect(used).toContain('api.providers.check.withModel');
    expect(used).toContain('api.providers.check.noModel');
    expect(used).toContain('api.providers.catalogProviderHint');
    expect(used).toContain('api.providers.droppedKey');
    expect(used).toContain('api.providers.droppedKeyInDialog');
    expect(used).toContain('api.providers.ollamaSearchHint');
    expect(used).toContain('api.guidance.protocolMismatch');
    expect(used).toContain('api.localOllamaNotFound');
  });

  it.each(LOCALES)('names the two tabs in %s', (locale) => {
    // The panel's own file is not scanned: other tabs there fall back to a
    // default text for keys that were never translated, which is not this
    // test's business.
    const messages = load(locale);
    for (const key of [
      'settings.providers',
      'settings.providersDesc',
      'settings.modelSets',
      'settings.modelSetsDesc',
    ]) {
      expect(typeof lookup(messages, key), key).toBe('string');
    }
    expect(lookup(messages, 'settings.apiSettings')).toBeUndefined();
  });

  it.each(LOCALES)('has every one of them in %s', (locale) => {
    const messages = load(locale);
    const missing = used.filter((key) => typeof lookup(messages, key) !== 'string');
    expect(missing).toEqual([]);
  });

  it('keeps the api section the same shape in all four languages', () => {
    const english = leafKeys(load('en').api as Messages).sort();
    for (const locale of LOCALES) {
      expect(leafKeys(load(locale).api as Messages).sort(), locale).toEqual(english);
    }
  });

  it('carries the same placeholders in every translation', () => {
    const english = load('en');
    const sections = ['api.providers', 'api.modelSets'];
    for (const section of sections) {
      for (const key of leafKeys(lookup(english, section) as Messages, `${section}.`)) {
        const expected = [...String(lookup(english, key)).matchAll(/\{\{(\w+)\}\}/g)]
          .map((match) => match[1])
          .sort();
        for (const locale of LOCALES) {
          const actual = [...String(lookup(load(locale), key)).matchAll(/\{\{(\w+)\}\}/g)]
            .map((match) => match[1])
            .sort();
          expect(actual, `${locale}: ${key}`).toEqual(expected);
        }
      }
    }
  });

  it('no longer says a key belongs to a config set', () => {
    // It did before the split; now it is saved once per provider.
    expect(String(lookup(load('en'), 'api.apiKeyDescription'))).not.toMatch(/configuration set/i);
    expect(String(lookup(load('en'), 'api.apiKeyDescription'))).toMatch(/once per provider/i);
  });
});
