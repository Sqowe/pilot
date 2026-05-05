import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const welcomeViewPath = path.resolve(process.cwd(), 'src/renderer/components/WelcomeView.tsx');

describe('WelcomeView config set selector', () => {
  const source = fs.readFileSync(welcomeViewPath, 'utf8');

  it('reads configSets and activeConfigSetId from the app store', () => {
    expect(source).toContain('const appConfig = useAppStore((state) => state.appConfig);');
    expect(source).toContain('const configSets = appConfig?.configSets ?? [];');
    expect(source).toContain("const activeConfigSetId = appConfig?.activeConfigSetId ?? '';");
  });

  it('only renders the config set selector when multiple sets exist', () => {
    expect(source).toContain('{configSets.length > 1 && (');
  });

  it('renders a select element bound to activeConfigSetId with config set options', () => {
    expect(source).toContain('value={activeConfigSetId}');
    expect(source).toContain('void handleConfigSetSwitch(e.target.value)');
    expect(source).toContain('{configSets.map((set) => (');
    expect(source).toContain('<option key={set.id} value={set.id}>');
  });

  it('disables the selector while a switch is in progress', () => {
    expect(source).toContain('disabled={isSwitchingSet}');
  });

  it('guards against re-entry while already switching', () => {
    expect(source).toContain('setId === activeConfigSetId || isSwitchingSet) return;');
  });

  it('uses a ref-based request counter to protect against rapid-switch race conditions', () => {
    expect(source).toContain('const switchRequestRef = useRef(0);');
    expect(source).toContain('const requestId = ++switchRequestRef.current;');
    expect(source).toContain('if (switchRequestRef.current === requestId) {');
  });

  it('applies the switched config to the store on success', () => {
    expect(source).toContain('setAppConfig(result.config);');
    expect(source).toContain('setIsConfiguredStore(Boolean(result.config?.isConfigured));');
  });

  it('logs errors without crashing on switch failure', () => {
    expect(source).toContain("console.error('[WelcomeView] Failed to switch config set:', error);");
  });

  it('uses the Layers icon consistent with the settings panel config set UI', () => {
    expect(source).toContain('import {');
    expect(source).toContain('Layers,');
    expect(source).toContain('<Layers className="w-4 h-4 text-text-muted shrink-0" />');
  });
});
