/**
 * The config mutation IPC contract.
 *
 * `config.*` mutations signal failure two different ways, and the preload types
 * must say which:
 *
 * - **`config.save` returns `{ success: false, error }`** for `httpProxy`
 *   validation. Main re-validates because the renderer's own checks can be
 *   bypassed via devtools or a corrupted config on disk. That branch carries
 *   **no `config`** field.
 * - **Every other mutation rejects** (cap reached, duplicate URL, endpoint in
 *   use, not found). They return no `success` flag at all: one that is always
 *   `true` only invites a dead branch.
 *
 * The previous shape `{ success: boolean; config: AppConfig }` was wrong for both
 * groups and three call sites each got it wrong differently — a dead
 * `if (result.success)` with no catch, an ignored `success: false` that reported
 * "Saved", and an unguarded `result.config` read. These tests pin the contract and
 * the call sites that consume it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildModelSetSavePayload } from '../src/renderer/hooks/model-sets-state';

const read = (relative: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('preload declares the two mutation shapes distinctly', () => {
  const preload = read('src/preload/index.ts');

  it('types config.save as the fallible union', () => {
    expect(preload).toContain('save: (config: Partial<AppConfig>): Promise<ConfigSaveResult> =>');
    expect(preload).toContain('save: (config: Partial<AppConfig>) => Promise<ConfigSaveResult>;');
  });

  it('types the throwing mutations without a success flag', () => {
    // Each of the eight appears twice — bridge implementation and ElectronAPI
    // declaration — and neither occurrence may carry a `success` field. Signatures
    // span multiple lines for the CRUD methods, so match from the method name to
    // its arrow/return rather than line by line.
    for (const method of [
      'createSet',
      'renameSet',
      'deleteSet',
      'switchSet',
      'createCustomEndpoint',
      'updateCustomEndpoint',
      'deleteCustomEndpoint',
      'setProviderCredential',
    ]) {
      const matches = [...preload.matchAll(new RegExp(`${method}: \\(payload:`, 'g'))];
      expect(matches, `${method} should be declared twice`).toHaveLength(2);
      for (const match of matches) {
        const signature = preload.slice(match.index, match.index + 320);
        const returnType = signature.slice(0, signature.indexOf('>'));
        expect(returnType, `${method} must not promise a success flag`).not.toContain('success');
      }
      expect(
        preload.match(new RegExp(`${method}:[\\s\\S]{0,320}?ConfigMutationResult`, 'g')),
        `${method} should resolve to ConfigMutationResult twice`
      ).toHaveLength(2);
    }
  });

  it('no longer declares the misleading success+config shape for config mutations', () => {
    // The old shape promised a `config` on every outcome, including failures.
    const configSection = preload.slice(
      preload.indexOf('  config: {'),
      preload.indexOf('isConfigured: (): Promise<boolean>')
    );
    expect(configSection).not.toContain('{ success: boolean; config: AppConfig }');
  });
});

describe('ConfigSaveResult is a discriminated union', () => {
  const types = read('src/renderer/types/index.ts');

  it('models failure without a config field', () => {
    expect(types).toContain('export type ConfigSaveResult =');
    expect(types).toContain('| { success: true; config: AppConfig }');
    expect(types).toContain('| { success: false; error: string };');
  });

  it('models the throwing mutations as config-only', () => {
    expect(types).toContain('export interface ConfigMutationResult {');
  });
});

describe('main returns the shape each handler declares', () => {
  const main = read('src/main/index.ts');

  it('keeps the structured httpProxy rejections on config.save', () => {
    // Security-relevant: these are the server-side checks that survive a
    // compromised renderer. They must stay structured returns, not throws,
    // because the union is what forces callers to handle them.
    expect(main).toContain("return { success: false, error: 'httpProxy is not a valid URL' };");
    expect(main).toContain(
      "return { success: false, error: 'httpProxy must use http:// or https:// scheme' };"
    );
    expect(main).toContain('httpProxy must not include credentials');
  });

  it('returns success:true with a config only from config.save', () => {
    const occurrences = main.match(/return \{ success: true, config: updatedConfig \};/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('returns a bare config from the eight throwing mutations', () => {
    const occurrences = main.match(/return \{ config: updatedConfig \};/g) ?? [];
    expect(occurrences).toHaveLength(8);
  });

  it('never logs the credential payload', () => {
    // The handler receives an API key. Only the provider id may reach the log.
    const handler = main.slice(
      main.indexOf("'config.setProviderCredential'"),
      main.indexOf("ipcMain.handle('workspace-instructions.getStatus'")
    );
    expect(handler).toContain("log('[Config] Saving provider credential:', payload?.provider);");
    expect(handler.match(/\blog\(/g)).toHaveLength(1);
  });
});

describe('the save payloads carry exactly what the store routes', () => {
  // Asserted on the payloads themselves, key for key. An exact list, not
  // `arrayContaining`: the looser form is what once let `contextWindow` /
  // `maxTokens` drop out of the payload unnoticed.
  const setDraft = {
    provider: 'custom',
    endpointId: 'custom-endpoint-1',
    model: '',
    customModel: 'claude-opus-5',
    useCustomModel: true,
    contextWindow: '200000',
    maxTokens: '',
    thinkingLevel: 'high' as const,
  };

  it('sends a config set as its own fields and no credential', () => {
    const payload = buildModelSetSavePayload(setDraft, 'default');

    expect(Object.keys(payload).sort()).toEqual(
      [
        'activeConfigSetId',
        'provider',
        'endpointId',
        'model',
        'contextWindow',
        'maxTokens',
        'enableThinking',
        'thinkingLevel',
      ].sort()
    );
  });

  it('sends the token limits as numbers, never as an absent key', () => {
    // IPC drops `undefined`, and the store reads an absent key as "leave the
    // stored limit unchanged" — so a cleared limit has to travel as 0.
    const payload = buildModelSetSavePayload(setDraft, 'default');

    expect(payload.contextWindow).toBe(200000);
    expect(payload.maxTokens).toBe(0);
  });

  it('never sends profiles or activeProfileKey', () => {
    // Sending the per-set profile map is what once let a stale snapshot slot
    // overwrite a key rotated elsewhere. Neither field exists any more, on the
    // payloads or anywhere in the renderer's state code.
    for (const file of [
      'src/renderer/hooks/useApiSettingsState.ts',
      'src/renderer/hooks/useModelSets.ts',
      'src/renderer/hooks/useModelSetForm.ts',
      'src/renderer/hooks/useFirstRunWizard.ts',
      'src/renderer/hooks/model-sets-state.ts',
      'src/renderer/hooks/api-settings-view.ts',
      'src/renderer/hooks/credential-dialog-view.ts',
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/\bactiveProfileKey\b/);
      expect(source, file).not.toMatch(/\bprofiles\s*[:,]/);
    }
  });
});

describe('the tabs and the wizard save each half through its own call (§6.4)', () => {
  // A credential is saved from a dialog of the Providers tab or by the wizard's
  // Continue; a config set from the Model Sets tab or by the wizard's Start.
  // Both screens go through the same two places, and neither place makes the
  // other's call. What the wizard does with the answers is in
  // `first-run-wizard-render.test.ts`.
  const shared = read('src/renderer/hooks/useApiSettingsState.ts');
  const sets = read('src/renderer/hooks/useModelSets.ts');

  it('makes each of the four credential calls once, in the state both screens share', () => {
    for (const method of [
      'createCustomEndpoint',
      'updateCustomEndpoint',
      'deleteCustomEndpoint',
      'setProviderCredential',
    ]) {
      const calls = shared.match(
        new RegExp(
          `runCredentialCall\\(\\(\\) => window\\.electronAPI\\.config\\.${method}\\(`,
          'g'
        )
      );
      expect(calls, method).toHaveLength(1);
      expect(sets, method).not.toContain(`config.${method}(`);
    }
  });

  it('never calls config.save from that state itself', () => {
    // It has no payload of its own to send: the config-set half owns that call.
    expect(shared).not.toContain('config.save(');
    expect(sets).toContain('window.electronAPI.config.save(payload)');
  });

  it('keeps the unsaved edits to a config set across a credential call', () => {
    // A credential call answers with the whole config. Taken as a reset, it
    // would cost the user a model they have not saved yet — on the Model Sets
    // tab, and in the wizard between its two steps.
    const callAt = shared.indexOf('const { config } = await call();');
    const rebaseAt = shared.indexOf("applySetsConfig(config, presets, 'rebase');", callAt);
    const takeAt = shared.indexOf('takeConfig(config);', callAt);

    expect(callAt).toBeGreaterThan(-1);
    expect(rebaseAt).toBeGreaterThan(callAt);
    expect(takeAt).toBeGreaterThan(rebaseAt);
    expect(shared.slice(callAt, takeAt)).not.toContain("'reset'");
  });
});

describe('hook wiring that no test can run', () => {
  // The suite has no DOM environment, so effects never execute here. These pin
  // orderings that only show up at run time, each of which was a real defect
  // found in review.

  it('hands a loaded config to a handler that is current before the load can finish', () => {
    // Filled in an effect, the ref was still empty when a load that awaits
    // nothing (the browser preview) reported back, and the config was dropped.
    const layer = read('src/renderer/hooks/useApiSettingsState.ts');
    const source = read('src/renderer/hooks/useApiConfigSource.ts');

    expect(layer).toContain('\n  applyLoadedRef.current = (config, loadedPresets) => {\n');
    expect(layer).not.toMatch(/useEffect\(\(\) => \{\s*applyLoadedRef\.current =/);
    expect(source).toContain('\n  onLoadedRef.current = onLoaded;\n');
    expect(source).not.toMatch(/useEffect\(\(\) => \{\s*onLoadedRef\.current =/);
  });

  it('asks what a model can do for the draft being rendered, not the previous one', () => {
    // Passed in as state set from an effect, the protocol and address lagged a
    // render behind and the first query went to the wrong place.
    const sets = read('src/renderer/hooks/useModelSets.ts');
    const layer = read('src/renderer/hooks/useApiSettingsState.ts');

    expect(sets).toContain('= runtimeFor(draft);');
    expect(layer).toContain('useModelSets({ initialConfig, messages, runtimeFor })');
    expect(layer).not.toContain('setRuntime(');
  });

  it('drops the answer of a connection check that arrives for values the form has left', () => {
    const connectivity = read('src/renderer/hooks/useApiConnectivity.ts');

    expect(connectivity).toContain('resultGenerationRef.current += 1;');
    // The check asks before showing anything: on success, on failure, and
    // before it takes its busy mark down.
    expect(connectivity.match(/isCurrent\(\)/g)).toHaveLength(3);
  });

  it('resets the Ollama model list only when the address really changes', () => {
    const connectivity = read('src/renderer/hooks/useApiConnectivity.ts');

    expect(connectivity).toContain(
      'if (previousUrl === null || previousUrl === currentUrl) {\n      return;\n    }'
    );
    // Discovery records the address its list is for before setting it, so the
    // reset does not undo what discovery just filled in.
    const stampAt = connectivity.indexOf('ollamaModelsUrlRef.current = discoveredUrl;');
    const setAt = connectivity.indexOf('setBaseUrl(discoveredUrl);');
    expect(stampAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(stampAt);
  });
});

describe('the store has no credential write path into a config set (§9.4)', () => {
  const store = read('src/main/config/config-store.ts');

  it('no longer forwards a renderer profiles map into the credential store', () => {
    // applyProfilesToCredentials was the Phase 2a bridge that existed only because
    // handleSave still sent the field. Deleted with its sole caller.
    expect(store).not.toContain('applyProfilesToCredentials');
  });

  it('routes credential writes through writeCredential only', () => {
    expect(store).toContain('const written = this.writeCredential({');
  });
});

describe('call sites handle both failure modes', () => {
  it('App.tsx no longer saves a config: the first-run wizard saves as the Settings tabs do', () => {
    // The old first-run dialog handed its save to a handler here, which once
    // dropped a rejected save without a word. The wizard has no save of its
    // own to get wrong: a credential goes through the calls of the shared
    // settings state, which report a failure as a message, and the config set
    // through the Model Sets form — whose `config.save` is checked below.
    const app = read('src/renderer/App.tsx');
    expect(app).not.toContain('config.save(');
    expect(app).not.toContain('handleConfigSave');

    const wizard = read('src/renderer/hooks/useFirstRunWizard.ts');
    expect(wizard).toContain('await saveProviderCredential(');
    expect(wizard).toContain('await updateEndpoint(');
    expect(wizard).toContain('await createEndpoint(');
    expect(wizard).not.toContain('electronAPI');

    const steps = read('src/renderer/components/FirstRunWizardSteps.tsx');
    expect(steps).toContain('await handleSave({ silentSuccess: true })');
    expect(steps).not.toContain('electronAPI');
  });

  it('SettingsGeneral surfaces a rejected httpProxy instead of reporting saved', () => {
    const settings = read('src/renderer/components/settings/SettingsGeneral.tsx');
    const saveIndex = settings.indexOf('config.save({ httpProxy: trimmed })');
    expect(saveIndex).toBeGreaterThan(-1);
    const afterSave = settings.slice(saveIndex, saveIndex + 500);
    expect(afterSave).toContain('if (!result.success)');
    expect(afterSave).toContain('setHttpProxyError(');
    // The success path must come after the guard, not before it.
    expect(afterSave.indexOf('if (!result.success)')).toBeLessThan(
      afterSave.indexOf('setHttpProxyCommitted(trimmed)')
    );
  });

  it('useModelSets guards result.config behind the discriminant', () => {
    // The config-set half owns the one `config.save` call the API form makes.
    const hook = read('src/renderer/hooks/useModelSets.ts');
    const saveIndex = hook.indexOf('const result = await window.electronAPI.config.save(payload)');
    expect(saveIndex).toBeGreaterThan(-1);
    const afterSave = hook.slice(saveIndex, saveIndex + 600);
    expect(afterSave).toContain('if (!result.success)');
    expect(afterSave.indexOf('if (!result.success)')).toBeLessThan(
      afterSave.indexOf('applyPersistedConfig(result.config, presets)')
    );
  });

  it('leaves the three callers that cannot receive success:false untouched', () => {
    // Only `httpProxy` can produce a structured rejection. These save
    // `localDevPath` / `memoryRuntime`, so a `success` check would be dead code;
    // each already has try/catch for the rejection path.
    for (const file of [
      'src/renderer/components/settings/SettingsSkills.tsx',
      'src/renderer/components/settings/SettingsMemory.tsx',
    ]) {
      const source = read(file);
      expect(source).not.toContain('httpProxy');
      expect(source).toContain('config.save(');
    }
  });
});
