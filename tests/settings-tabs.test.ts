/**
 * The ids of the Settings tabs, and what an id that arrives from outside the
 * panel opens.
 *
 * "API Settings" was one tab (`api`) until it was split into Providers and
 * Model Sets. The id is named in four places outside the panel; each has to
 * agree with the list here, and the old id has to keep opening something.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS_TAB,
  resolveSettingsTab,
} from '../src/renderer/components/settings/settings-tabs';

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('which tab a requested id opens', () => {
  it('opens the two tabs that replaced API Settings by their own ids', () => {
    expect(resolveSettingsTab('providers')).toBe('providers');
    expect(resolveSettingsTab('modelSets')).toBe('modelSets');
  });

  it('still opens something for the old id: Providers, where a key is entered', () => {
    expect(resolveSettingsTab('api')).toBe('providers');
  });

  it('opens every other tab as before', () => {
    for (const id of [
      'sandbox',
      'connectors',
      'skills',
      'memory',
      'schedule',
      'remote',
      'logs',
      'general',
      'bashCommands',
      'prompt',
    ]) {
      expect(resolveSettingsTab(id)).toBe(id);
    }
  });

  it('opens nothing for an id that names no tab', () => {
    expect(resolveSettingsTab('')).toBeNull();
    expect(resolveSettingsTab(null)).toBeNull();
    expect(resolveSettingsTab(undefined)).toBeNull();
    expect(resolveSettingsTab('apiSettings')).toBeNull();
  });

  it('opens Settings on Model Sets when nothing asks for another tab', () => {
    expect(DEFAULT_SETTINGS_TAB).toBe('modelSets');
    expect(resolveSettingsTab(DEFAULT_SETTINGS_TAB)).toBe(DEFAULT_SETTINGS_TAB);
  });
});

describe('the settings panel', () => {
  const panel = read('src/renderer/components/SettingsPanel.tsx');

  it('lists Providers and Model Sets, and no API Settings tab', () => {
    expect(panel).toContain("id: 'providers' as TabId");
    expect(panel).toContain("id: 'modelSets' as TabId");
    expect(panel).toContain("t('settings.providers')");
    expect(panel).toContain("t('settings.modelSets')");
    expect(panel).not.toContain("'api'");
    expect(panel).not.toContain('SettingsAPI');
  });

  it('creates the state of the two tabs once, above both', () => {
    // Each tab shows what the other changes. Two copies of the state would
    // drift apart at the first save.
    const opening = panel.indexOf('<ApiSettingsProvider>');
    const closing = panel.indexOf('</ApiSettingsProvider>');
    expect(opening).toBeGreaterThan(-1);
    expect(closing).toBeGreaterThan(opening);
    const inside = panel.slice(opening, closing);
    expect(inside).toContain('<SettingsProviders ');
    expect(inside).toContain('<SettingsModelSets />');
    expect(panel.match(/<ApiSettingsProvider>/g)).toHaveLength(1);
  });

  it('tells the Providers tab when it is no longer the one on screen', () => {
    // Its dialogs are drawn over the whole window. A tab that is only hidden
    // would leave one open on top of whichever tab the panel moved to.
    expect(panel).toContain("<SettingsProviders isActive={activeTab === 'providers'} />");
    const providers = read('src/renderer/components/settings/SettingsProviders.tsx');
    expect(providers).toMatch(
      /if \(!isActive\) \{\s+setDialog\(null\);\s+setPendingDelete\(null\);/
    );
  });

  it('resolves an id from outside through the one function that knows the old id', () => {
    expect(panel).toContain('resolveSettingsTab(storeTab)');
  });

  it('no longer has the old screen on disk', () => {
    expect(
      fs.existsSync(path.resolve(process.cwd(), 'src/renderer/components/settings/SettingsAPI.tsx'))
    ).toBe(false);
  });
});

describe('the places outside the panel that name a tab', () => {
  it('sends "not configured" on the welcome screen to Providers', () => {
    expect(read('src/renderer/components/WelcomeView.tsx')).toContain(
      "setSettingsTab('providers');"
    );
  });

  it('opens Settings from the navigation helper on the default tab', () => {
    expect(read('src/renderer/store/index.ts')).toContain(
      `store.setSettingsTab(tab || '${DEFAULT_SETTINGS_TAB}');`
    );
  });

  it('accepts the new ids, and the old one, in the local navigation server', () => {
    const navServer = read('src/main/nav-server.ts');
    for (const id of ['providers', 'modelSets', 'api']) {
      expect(navServer).toContain(`'${id}',`);
    }
  });

  it('gives every id the navigation server accepts a tab to open', () => {
    const navServer = read('src/main/nav-server.ts');
    const list = navServer.slice(
      navServer.indexOf('const VALID_TABS = new Set(['),
      navServer.indexOf(']);')
    );
    const ids = [...list.matchAll(/^\s+'([A-Za-z]+)',$/gm)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(resolveSettingsTab(id), id).not.toBeNull();
    }
  });
});
