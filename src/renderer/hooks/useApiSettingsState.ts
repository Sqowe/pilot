import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import type { AppConfig, CustomProtocolType, ProviderPresets, ProviderType } from '../types';
import { isElectron, translateApiConfigErrorMessage } from './api-config-shared';
import { runtimeOf, type PersistedCredentials } from './api-settings-view';
import type { ModelSetDraft } from './model-sets-state';
import { useApiConfigMessages } from './useApiConfigMessages';
import { useApiConfigSource } from './useApiConfigSource';
import { useModelSets } from './useModelSets';

interface UseApiSettingsStateOptions {
  /** A config the caller already has; skips asking main for one. */
  initialConfig?: AppConfig | null;
}

/** The outcome of one credential call. A failure carries a message ready to show. */
export type CredentialCallResult = { ok: true; config: AppConfig } | { ok: false; error: string };

function credentialsOf(config: AppConfig | null | undefined): PersistedCredentials {
  return {
    providerCredentials: config?.providerCredentials ?? {},
    customEndpoints: config?.customEndpoints ?? [],
  };
}

/**
 * The state the **Providers** and **Model Sets** tabs share.
 *
 * The two tabs stay mounted side by side, and each shows something the other
 * changes: an endpoint added on Providers has to appear in the chooser on Model
 * Sets, and a set saved there changes which endpoints are in use. So the state
 * is created once, above both, instead of once per tab.
 *
 * It holds two things that are saved independently (design §6.4):
 *
 * - the credential store as main last returned it. A credential is edited in a
 *   dialog with its own Save, so there are no unsaved credential edits here —
 *   each call below writes one credential and names no config set;
 * - the config sets and the unsaved edits to the open one (`useModelSets`),
 *   whose save names no credential.
 */
export function useApiSettingsState(options: UseApiSettingsStateOptions = {}) {
  const { t } = useTranslation();
  const { initialConfig } = options;
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const setIsConfigured = useAppStore((s) => s.setIsConfigured);

  // The loader is created before the config-set half (which needs nothing from
  // it) and reports through a ref, because the handler that applies a loaded
  // config is defined after both.
  const applyLoadedRef = useRef<
    (config: AppConfig | null | undefined, presets: ProviderPresets) => void
  >(() => {});
  const handleLoaded = useCallback(
    (config: AppConfig | null | undefined, loadedPresets: ProviderPresets) =>
      applyLoadedRef.current(config, loadedPresets),
    []
  );
  const { presets, providerCatalog, isCatalogLoading, isLoadingConfig } = useApiConfigSource({
    enabled: true,
    initialConfig,
    onLoaded: handleLoaded,
  });

  const [credentials, setCredentials] = useState<PersistedCredentials>(() =>
    credentialsOf(initialConfig)
  );

  // The Model Sets tab's error and success line. A credential dialog shows its
  // own failure next to the fields it is about.
  const messages = useApiConfigMessages();

  // What a model can do depends on where it is served from, so the config-set
  // half asks where a given draft would run.
  const runtimeFor = useCallback(
    (draft: ModelSetDraft) => runtimeOf(draft.provider, draft.endpointId, credentials, presets),
    [credentials, presets]
  );
  const sets = useModelSets({ initialConfig, messages, runtimeFor });
  const applySetsConfig = sets.applyPersistedConfig;

  const publishConfig = useCallback(
    (config: AppConfig) => {
      setAppConfig(config);
      setIsConfigured(Boolean(config.isConfigured));
    },
    [setAppConfig, setIsConfigured]
  );

  // Assigned during render, not in an effect: the loader's own effect runs
  // before any effect declared here, and when nothing in a load has to be
  // awaited it reports within that same pass.
  applyLoadedRef.current = (config, loadedPresets) => {
    applySetsConfig(config, loadedPresets, 'reset');
    setCredentials(credentialsOf(config));
  };

  /**
   * Take a config main returned for a call made by the config-set half, which
   * has already applied its own part of it.
   */
  const takeConfig = useCallback(
    (config: AppConfig) => {
      setCredentials(credentialsOf(config));
      publishConfig(config);
    },
    [publishConfig]
  );

  /**
   * Run one call that writes a credential. The set list is refreshed from what
   * comes back, but the unsaved edits to the open set are kept: saving a key
   * must never cost the user a model they have not saved yet.
   */
  const runCredentialCall = useCallback(
    async (call: () => Promise<{ config: AppConfig }>): Promise<CredentialCallResult> => {
      if (!isElectron) {
        return { ok: false, error: t('api.saveFailed') };
      }
      try {
        const { config } = await call();
        applySetsConfig(config, presets, 'rebase');
        takeConfig(config);
        return { ok: true, config };
      } catch (failure) {
        return {
          ok: false,
          error:
            failure instanceof Error
              ? translateApiConfigErrorMessage(failure.message, t)
              : t('api.saveFailed'),
        };
      }
    },
    [applySetsConfig, presets, t, takeConfig]
  );

  const createEndpoint = useCallback(
    (payload: {
      name: string;
      protocol: CustomProtocolType;
      baseUrl: string;
      apiKey: string;
      defaultModel?: string;
    }) => runCredentialCall(() => window.electronAPI.config.createCustomEndpoint(payload)),
    [runCredentialCall]
  );

  const updateEndpoint = useCallback(
    (payload: {
      id: string;
      name: string;
      protocol: CustomProtocolType;
      baseUrl: string;
      apiKey: string;
      defaultModel: string;
    }) => runCredentialCall(() => window.electronAPI.config.updateCustomEndpoint(payload)),
    [runCredentialCall]
  );

  const deleteEndpoint = useCallback(
    (id: string) => runCredentialCall(() => window.electronAPI.config.deleteCustomEndpoint({ id })),
    [runCredentialCall]
  );

  const saveProviderCredential = useCallback(
    (payload: { provider: ProviderType; apiKey: string; baseUrl?: string }) =>
      runCredentialCall(() => window.electronAPI.config.setProviderCredential(payload)),
    [runCredentialCall]
  );

  return {
    isLoadingConfig,
    isCatalogLoading,
    presets,
    providerCatalog,
    credentials,
    sets,
    messages,
    takeConfig,
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    saveProviderCredential,
  };
}

export type ApiSettingsState = ReturnType<typeof useApiSettingsState>;
