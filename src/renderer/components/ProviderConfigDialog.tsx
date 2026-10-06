import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomProtocolType } from '../types';
import type { ProviderCatalogEntry } from '../../shared/provider-catalog';
import { ollamaSearchNote, type DialogNote } from '../hooks/credential-dialog-view';
import type { CredentialCallResult } from '../hooks/useApiSettingsState';
import { useCredentialCheck } from '../hooks/useCredentialCheck';
import { ProviderCredentialFields } from './ProviderCredentialFields';
import { DialogFooterButtons } from './settings/CredentialDialogParts';
import { SettingsDialogFrame, useDialogSave } from './settings/SettingsDialogFrame';

export interface ProviderConfigDialogProps {
  entry: ProviderCatalogEntry;
  /** The key and address exactly as they are stored; an address never given is empty. */
  apiKey: string;
  baseUrl: string;
  /** Whether this provider has an address of its own to edit (Ollama, some native providers). */
  showsBaseUrl: boolean;
  /** The provider's usual address, shown as a hint in an empty address field. */
  baseUrlPlaceholder: string;
  needsKey: boolean;
  keyPlaceholder: string;
  /** i18n key of a provider-specific hint about where to get a key, when there is one. */
  keyHintKey?: string;
  /** Names of the config sets that use this provider. */
  usedBy: string[];
  /** Names of the config sets whose own key for this provider the conversion did not keep. */
  droppedKeySets: string[];
  /** The protocol requests to this provider are made in. */
  protocol: CustomProtocolType;
  /** The model a connection check tries; '' when none is known. */
  checkModel: string;
  onSave: (input: { apiKey: string; baseUrl: string }) => Promise<CredentialCallResult>;
  onClose: () => void;
}

/**
 * The provider dialog as a form: the key, the address where the provider has
 * one, the connection check, the search for a local Ollama, and Save.
 *
 * Apart from the dialog's frame, so that the fields can be drawn — and this
 * state read — where there is no page to draw a dialog into.
 */
export function useProviderConfigDialog(props: ProviderConfigDialogProps) {
  const { entry, baseUrlPlaceholder, needsKey, protocol, checkModel, onSave, onClose } = props;
  const { t } = useTranslation();
  const [apiKey, setApiKeyValue] = useState(props.apiKey);
  const [baseUrl, setBaseUrlValue] = useState(props.baseUrl);
  const [searchNote, setSearchNote] = useState<DialogNote | null>(null);
  const {
    isSaving,
    error: saveError,
    setError,
    save,
  } = useDialogSave(onClose, t('api.saveFailed'));

  const setApiKey = useCallback(
    (value: string) => {
      setApiKeyValue(value);
      setError('');
    },
    [setError]
  );
  const setBaseUrl = useCallback(
    (value: string) => {
      setBaseUrlValue(value);
      setError('');
      // Typed over: what the last search found no longer describes the field.
      setSearchNote(null);
    },
    [setError]
  );

  const check = useCredentialCheck({
    provider: entry.id,
    customProtocol: protocol,
    apiKey,
    baseUrl,
    model: checkModel,
    presetBaseUrl: baseUrlPlaceholder,
    requiresApiKey: needsKey,
    // A found address goes straight into the field, past `setBaseUrl` above:
    // the note about the search that found it has to stay.
    setBaseUrl: setBaseUrlValue,
  });
  const { searchOllama: searchForOllama } = check;

  const submit = () => {
    void save(() => onSave({ apiKey, baseUrl }));
  };

  const runCheck = () => {
    setError('');
    void check.runCheck();
  };

  const searchOllama = useCallback(async () => {
    setError('');
    setSearchNote(null);
    setSearchNote(ollamaSearchNote(await searchForOllama()));
  }, [searchForOllama, setError]);

  return {
    entry,
    apiKey,
    baseUrl,
    setApiKey,
    setBaseUrl,
    showsBaseUrl: props.showsBaseUrl,
    baseUrlPlaceholder,
    needsKey,
    keyPlaceholder: props.keyPlaceholder,
    keyHintKey: props.keyHintKey,
    usedBy: props.usedBy,
    droppedKeySets: props.droppedKeySets,
    isSaving,
    error: saveError || check.error,
    check,
    checkModel,
    runCheck,
    // The search only ever looks for Ollama, so only Ollama's dialog offers it.
    canSearchOllama: entry.id === 'ollama',
    isSearchingOllama: check.isSearchingOllama,
    searchOllama,
    searchNote,
    submit,
  };
}

export type ProviderConfigDialogForm = ReturnType<typeof useProviderConfigDialog>;

/**
 * Enter one catalog provider's key, and its address where it has one.
 *
 * A provider has one key on this machine, shared by every config set that uses
 * it. Save writes that credential and nothing else: it names no config set, so
 * it cannot change which model a chat runs on.
 */
export function ProviderConfigDialog(props: ProviderConfigDialogProps) {
  const { t } = useTranslation();
  const form = useProviderConfigDialog(props);

  return (
    <SettingsDialogFrame
      title={t('api.providers.configureTitle', { name: props.entry.name })}
      onClose={props.onClose}
      onSubmit={form.submit}
      busy={form.isSaving}
      footer={<DialogFooterButtons isSaving={form.isSaving} onCancel={props.onClose} />}
    >
      <ProviderCredentialFields form={form} />
    </SettingsDialogFrame>
  );
}
