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

const read = (relative: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('preload declares the two mutation shapes distinctly', () => {
  const preload = read('src/preload/index.ts');

  it('types config.save as the fallible union', () => {
    expect(preload).toContain('save: (config: Partial<AppConfig>): Promise<ConfigSaveResult> =>');
    expect(preload).toContain('save: (config: Partial<AppConfig>) => Promise<ConfigSaveResult>;');
  });

  it('types the throwing mutations without a success flag', () => {
    // Each of the seven appears twice — bridge implementation and ElectronAPI
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

  it('returns a bare config from the seven throwing mutations', () => {
    const occurrences = main.match(/return \{ config: updatedConfig \};/g) ?? [];
    expect(occurrences).toHaveLength(7);
  });
});

describe('the save payload no longer carries credentials per set (Phase 2b)', () => {
  const hook = read('src/renderer/hooks/useApiConfigState.ts');
  const payload = hook.slice(
    hook.indexOf('const payload: Partial<AppConfig> = {'),
    hook.indexOf('if (onSave) {')
  );

  /**
   * The literal's top-level keys, so assertions do not depend on trailing commas.
   * Matches shorthand (`provider,`), longhand (`apiKey: x,`) and a final key with
   * no delimiter at all (`activeProfileKey` before the closing brace).
   */
  const payloadKeys = [...payload.matchAll(/^\s{10}([A-Za-z_$][\w$]*)\s*[,:}]?\s*$/gm)]
    .map((match) => match[1])
    .concat([...payload.matchAll(/^\s{10}([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1]));

  it('sends the credential as top-level fields', () => {
    expect(payload).toContain('provider,');
    expect(payload).toContain('apiKey: apiKey.trim(),');
    expect(payload).toContain('baseUrl: resolvedBaseUrl || undefined,');
    expect(payload).toContain('customProtocol,');
    expect(payload).toContain('model: finalModel,');
  });

  it('parses the payload keys so the shape is asserted, not a substring', () => {
    // Guards the two assertions below: if this regex ever stops matching the
    // literal, they would silently pass against an empty list.
    expect(payloadKeys).toEqual(
      expect.arrayContaining([
        'provider',
        'apiKey',
        'baseUrl',
        'customProtocol',
        'model',
        'activeConfigSetId',
        'enableThinking',
        'thinkingLevel',
      ])
    );
  });

  it('no longer sends profiles or activeProfileKey', () => {
    // Sending the per-set profile map is what let a stale snapshot slot overwrite
    // a key rotated elsewhere. Dropping it is what makes design §9.4 structural:
    // no write path puts a credential into a config set.
    //
    // Asserted against the parsed key list rather than a substring: a trailing
    // `activeProfileKey,` match would miss both `activeProfileKey: value` and the
    // same key written last without a comma.
    expect(payloadKeys).not.toContain('profiles');
    expect(payloadKeys).not.toContain('activeProfileKey');
  });

  it('keeps toPersistedProfiles for local use only', () => {
    // Still used for the dirty-tracking signature and the in-memory fallback set;
    // it must not feed an IPC payload any more.
    expect(payload).not.toContain('toPersistedProfiles');
    expect(hook).toContain('const persisted = toPersistedProfiles(profiles);');
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
  it('App.tsx catches rejections and checks the discriminant', () => {
    const app = read('src/renderer/App.tsx');
    const handler = app.slice(
      app.indexOf('const handleConfigSave'),
      app.indexOf('const handleConfigClose')
    );
    expect(handler).toContain('try {');
    expect(handler).toContain('if (!result.success)');
    expect(handler).toContain('catch (saveError)');
    // The former bug: a bare `if (result.success)` wrapping the happy path, with
    // no catch, so a rejected save silently did nothing.
    expect(handler).not.toMatch(/if \(result\.success\) \{/);
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

  it('useApiConfigState guards result.config behind the discriminant', () => {
    const hook = read('src/renderer/hooks/useApiConfigState.ts');
    const saveIndex = hook.indexOf('const result = await window.electronAPI.config.save(payload)');
    expect(saveIndex).toBeGreaterThan(-1);
    const afterSave = hook.slice(saveIndex, saveIndex + 600);
    expect(afterSave).toContain('if (!result.success)');
    expect(afterSave.indexOf('if (!result.success)')).toBeLessThan(
      afterSave.indexOf('applyPersistedConfigToStore(result.config, presets)')
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
