import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';
import { PLUGIN_GITHUB_ERROR_CODES } from '../../shared/plugin-github-url';
import {
  describePluginGitHubSource,
  pluginGitHubErrorKey,
  pluginGitHubErrorMessage,
  shortCommitSha,
} from '../../renderer/components/settings/plugin-github-messages';
import type { InstalledPlugin } from '../../renderer/types';

const localesDir = path.resolve(process.cwd(), 'src/renderer/i18n/locales');
const locales = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
const settingsDir = path.resolve(process.cwd(), 'src/renderer/components/settings');
const skillsTab = readFileSync(path.join(settingsDir, 'SettingsSkills.tsx'), 'utf8');
const dialog = readFileSync(path.join(settingsDir, 'PluginGitHubInstallDialog.tsx'), 'utf8');

function lookup(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }, tree);
}

const NEW_KEYS = [
  'skills.installFromGitHub',
  'skills.installFromGitHubTitle',
  'skills.githubUrlLabel',
  'skills.githubUrlHint',
  'skills.githubTrustWarning',
  'skills.githubInstalling',
  'skills.pluginUpdate',
  'skills.pluginUpdateAria',
  'skills.pluginUpToDate',
  'skills.pluginUpdated',
  'skills.pluginSkippedSymlinks_other',
];

describe('GitHub plugin install — translations', () => {
  it('covers all four locales', () => {
    expect(locales.sort()).toEqual(['en.json', 'hu.json', 'ru.json', 'zh.json']);
  });

  it.each(locales)('%s has every new key and a message for every error code', (file) => {
    const tree = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    for (const key of [...NEW_KEYS, ...PLUGIN_GITHUB_ERROR_CODES.map(pluginGitHubErrorKey)]) {
      const value = lookup(tree, key);
      expect(typeof value === 'string' && value.trim().length > 0, `${file}: ${key}`).toBe(true);
    }
  });

  it.each(locales)('%s keeps the {{details}} placeholder where the English text has it', (file) => {
    const en = JSON.parse(readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
    const tree = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    for (const code of PLUGIN_GITHUB_ERROR_CODES) {
      const key = pluginGitHubErrorKey(code);
      const enHas = String(lookup(en, key)).includes('{{details}}');
      expect(String(lookup(tree, key)).includes('{{details}}'), `${file}: ${key}`).toBe(enHas);
    }
  });

  it('ru has every plural form i18next asks for', () => {
    const tree = JSON.parse(readFileSync(path.join(localesDir, 'ru.json'), 'utf8'));
    for (const suffix of ['one', 'few', 'many', 'other']) {
      expect(lookup(tree, `skills.pluginSkippedSymlinks_${suffix}`)).toBeTruthy();
    }
  });
});

describe('GitHub plugin install — messages', () => {
  it('maps a code to its translated message with details, and an unknown code to the generic one', async () => {
    const en = JSON.parse(readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
    const instance = i18next.createInstance();
    await instance.init({ lng: 'en', resources: { en: { translation: en } } });
    const t = instance.t.bind(instance);

    expect(pluginGitHubErrorMessage({ code: 'multiplePlugins', details: 'a, b' }, t)).toContain(
      'a, b'
    );
    expect(pluginGitHubErrorMessage({ code: 'nope' as never }, t)).toBe(
      en.skills.githubErrors.unknown
    );
    expect(t('skills.pluginSkippedSymlinks', { count: 1, files: 'CLAUDE.md' })).toBe(
      '1 symbolic link was not installed: CLAUDE.md'
    );
  });

  it('describes a GitHub source and nothing else', () => {
    const base = { pluginId: 'p', name: 'p' } as InstalledPlugin;
    expect(describePluginGitHubSource(base)).toBeNull();
    expect(
      describePluginGitHubSource({
        ...base,
        source: {
          type: 'github',
          owner: 'o',
          repo: 'r',
          ref: 'v1',
          path: 'plugins/x',
          commitSha: 'e85f3cbc2e4a79bf33b2a12e9bdd9087d414735b',
        },
      })
    ).toBe('o/r/plugins/x · v1 · e85f3cb');
    expect(shortCommitSha(undefined)).toBeUndefined();
  });
});

describe('GitHub plugin install — wiring', () => {
  it('the Skills tab opens the dialog and offers Update only for GitHub plugins', () => {
    expect(skillsTab).toContain("t('skills.installFromGitHub')");
    expect(skillsTab).toContain('<PluginGitHubInstallDialog');
    expect(skillsTab).toContain('window.electronAPI.plugins.updateFromGitHub(plugin.pluginId)');
    expect(skillsTab).toMatch(
      /\{githubSource && \(\s*<button\s+onClick=\{\(\) => handleUpdatePlugin\(plugin\)\}/
    );
    expect(skillsTab).toContain("aria-label={t('skills.pluginUpdateAria', { name: plugin.name })}");
    expect(skillsTab).toContain('role="status"');
  });

  it('the dialog sends only the typed text and has a labelled, described field', () => {
    expect(dialog).toContain('window.electronAPI.plugins.installFromGitHub(url.trim())');
    expect(dialog).toContain('htmlFor="plugin-github-url-input"');
    expect(dialog).toContain('id="plugin-github-url-input"');
    expect(dialog).toContain('aria-describedby={describedBy}');
    expect(dialog).toContain('role="alert"');
    expect(dialog).toContain('disabled={isInstalling || !parsed}');
  });
});
