import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const configModalPath = path.resolve(process.cwd(), 'src/renderer/components/ConfigModal.tsx');
// The settings tabs live in components/settings/; the dialogs they open sit beside the panel.
const settingsPanelPath = path.resolve(process.cwd(), 'src/renderer/components/SettingsPanel.tsx');
const settingsDir = path.resolve(process.cwd(), 'src/renderer/components/settings');
const settingsPanelContent = [
  fs.readFileSync(settingsPanelPath, 'utf8'),
  ...fs.readdirSync(settingsDir).map((f) => fs.readFileSync(path.join(settingsDir, f), 'utf8')),
].join('\n');

describe('provider guidance UI wiring', () => {
  it('wires shared guidance UI into ConfigModal', () => {
    const source = fs.readFileSync(configModalPath, 'utf8');
    expect(source).toContain('CommonProviderSetupsCard');
    expect(source).toContain('GuidanceInlineHint');
    expect(source).toContain('onApplySetup={applyCommonProviderSetup}');
    expect(source).toContain('friendlyTestDetails');
  });

  it('keeps the diagnostics panel in Settings, on the tab where a config set is edited', () => {
    expect(settingsPanelContent).toContain('<ApiDiagnosticsPanel');
  });

  // The ready-made setups and the hints under protocol and address belonged to
  // the address fields of the old single screen. Those fields are now in the
  // custom-endpoint dialog, and the guidance is there with them. What it shows
  // for a given address is checked in `api-settings-dialogs-render.test.ts`.
  it('puts the setups card and the address hints into the custom-endpoint dialog', () => {
    const read = (file: string) =>
      fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components', file), 'utf8');
    const dialog = read('CustomEndpointDialog.tsx');
    const fields = read('CustomEndpointFields.tsx');

    // Worked out from what is typed, by the same rules the old screen used.
    expect(dialog).toContain('useCustomEndpointGuidance({');
    expect(dialog).toContain("provider: 'custom',");
    expect(dialog).toContain('customProtocol: values.protocol,');
    expect(dialog).toContain('baseUrl: values.baseUrl,');

    // The card, in the layout that fits a dialog, and what its button does.
    expect(fields).toContain('<CommonProviderSetupsCard');
    expect(fields).toContain('onApplySetup={form.applySetup}');
    expect(fields).toContain('layout="list"');
    expect(dialog).toContain('applySetupToEndpointForm(current, setupId)');

    // One hint under the protocol, one under the address.
    expect(fields).toContain(
      '<GuidanceInlineHint text={form.protocolHint} tone={form.protocolHintTone} />'
    );
    expect(fields).toContain('<GuidanceInlineHint text={form.addressHint} />');
  });

  it('sends an address that belongs to a catalog provider to that provider instead', () => {
    const read = (file: string) =>
      fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components', file), 'utf8');
    const fields = read('CustomEndpointFields.tsx');
    const providers = read('settings/SettingsProviders.tsx');

    expect(fields).toContain("t('api.providers.catalogProviderHint'");
    expect(fields).toContain('onClick={form.openCatalogProvider}');
    // The tab closes the endpoint dialog first and opens the provider's after.
    expect(providers).toContain('onOpenProvider={(provider) => {');
    expect(providers).toContain('setProviderToOpen(provider);');
  });

  it('keeps the table layout of the setups card for the wide first-run dialog', () => {
    const card = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/ProviderGuidance.tsx'),
      'utf8'
    );
    expect(card).toContain("layout = 'table',");
    expect(fs.readFileSync(configModalPath, 'utf8')).not.toContain('layout="list"');
  });
});
