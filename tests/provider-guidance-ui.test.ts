import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The settings tabs live in components/settings/; the dialogs they open sit beside the panel.
const settingsPanelPath = path.resolve(process.cwd(), 'src/renderer/components/SettingsPanel.tsx');
const settingsDir = path.resolve(process.cwd(), 'src/renderer/components/settings');
const settingsPanelContent = [
  fs.readFileSync(settingsPanelPath, 'utf8'),
  ...fs.readdirSync(settingsDir).map((f) => fs.readFileSync(path.join(settingsDir, f), 'utf8')),
].join('\n');

describe('provider guidance UI wiring', () => {
  it('gives the first-run wizard the guidance of the endpoint dialog, not a copy of it', () => {
    // The old first-run dialog drew the setups card and the hints itself. The
    // wizard's first step is the inside of the custom-endpoint dialog — its
    // state and its fields — so what is checked for the dialog below holds for
    // the wizard too.
    const read = (file: string) =>
      fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components', file), 'utf8');
    const steps = read('FirstRunWizardSteps.tsx');

    expect(steps).toContain('useCustomEndpointDialog({');
    expect(steps).toContain('<CustomEndpointFields form={form} />');
    for (const file of ['ConfigModal.tsx', 'FirstRunWizard.tsx', 'FirstRunWizardSteps.tsx']) {
      expect(read(file), file).not.toContain('CommonProviderSetupsCard');
      expect(read(file), file).not.toContain('GuidanceInlineHint');
    }
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

    // The card, and what its button does.
    expect(fields).toContain('<CommonProviderSetupsCard');
    expect(fields).toContain('onApplySetup={form.applySetup}');
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

  it('draws the setups as a list, the one layout the card has', () => {
    // The six-column table was for the wide first-run dialog and went with it:
    // a dialog is too narrow for a column per field.
    const components = path.resolve(process.cwd(), 'src/renderer/components');
    const card = fs.readFileSync(path.join(components, 'ProviderGuidance.tsx'), 'utf8');
    expect(card).toContain('<ul className="mt-3 divide-y divide-border-subtle">');
    expect(card).not.toContain('<table');
    expect(card).not.toMatch(/\blayout\b/);

    const users = fs
      .readdirSync(components, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.tsx') && !file.endsWith('ProviderGuidance.tsx'))
      .map((file) => ({ file, source: fs.readFileSync(path.join(components, file), 'utf8') }))
      .filter(({ source }) => source.includes('<CommonProviderSetupsCard'));

    expect(users.map(({ file }) => file)).toEqual(['CustomEndpointFields.tsx']);
    expect(users[0].source).not.toContain('layout=');
  });
});
