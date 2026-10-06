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
  // custom-endpoint dialog; the guidance follows them there in the next step.
  it.todo('wires the setups card and the address hints into the custom-endpoint dialog');
});
