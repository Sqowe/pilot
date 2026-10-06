import { useCallback } from 'react';
import type { CustomProtocolType, ProviderModelInfo, ProviderType } from '../types';
import type { ModelFields } from './api-config-shared';
import { useApiConfigMessages } from './useApiConfigMessages';
import { useApiConnectivity } from './useApiConnectivity';

interface UseCredentialCheckOptions {
  provider: ProviderType;
  customProtocol: CustomProtocolType;
  /** The key and address as they stand in the dialog, saved or not. */
  apiKey: string;
  baseUrl: string;
  /** The model the check tries; '' to stop short of one. */
  model: string;
  /** The provider's usual address, used when the dialog has none of its own. */
  presetBaseUrl: string;
  requiresApiKey: boolean;
  /** Where a found Ollama address goes: the dialog's address field. */
  setBaseUrl: (value: string) => void;
}

const NO_MODELS: ProviderModelInfo[] = [];

/** A credential dialog has no model fields for a check or a search to fill in. */
const ignoreModelFields: (updater: (previous: ModelFields) => ModelFields) => void = () => {};

/**
 * The connection check of a credential dialog, and — for Ollama — the search
 * for a local server.
 *
 * Both are the ones the API settings form has (`useApiConnectivity`), pointed
 * at the values in the dialog instead of at a config set: they run against what
 * is typed, so a key can be tried before it is kept, and an answer that arrives
 * after the fields have changed is dropped. What a dialog does not have — a
 * model to pick, a list of models to keep fresh — is switched off.
 */
export function useCredentialCheck(options: UseCredentialCheckOptions) {
  const messages = useApiConfigMessages();
  const connectivity = useApiConnectivity({
    provider: options.provider,
    customProtocol: options.customProtocol,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    finalModel: options.model,
    presetBaseUrl: options.presetBaseUrl,
    presetModels: NO_MODELS,
    requiresApiKey: options.requiresApiKey,
    hasUnsavedChanges: false,
    // One dialog shows one credential from open to close.
    resetKey: '',
    messages,
    setBaseUrl: options.setBaseUrl,
    updateModelFields: ignoreModelFields,
    listsModels: false,
  });

  const { handleDiagnose, discoverLocalOllama } = connectivity;
  const runCheck = useCallback(() => handleDiagnose('fast'), [handleDiagnose]);
  // Silent: the dialog words the outcome itself, next to the address it is
  // about, from what the search returns.
  const searchOllama = useCallback(
    () => discoverLocalOllama({ silent: true }),
    [discoverLocalOllama]
  );

  return {
    /** Why a check did not run or could not finish; '' otherwise. */
    error: messages.error,
    result: connectivity.diagnosticResult,
    isChecking: connectivity.isDiagnosing,
    runCheck,
    isSearchingOllama: connectivity.isDiscoveringLocalOllama,
    searchOllama,
  };
}

export type CredentialCheck = ReturnType<typeof useCredentialCheck>;
