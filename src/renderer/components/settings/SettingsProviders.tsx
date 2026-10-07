import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Plus } from 'lucide-react';
import type { CustomEndpoint, ProviderType } from '../../types';
import { getCatalogEntry, type ProviderCatalogEntry } from '../../../shared/provider-catalog';
import { CUSTOM_ENDPOINT_LIMIT } from '../../hooks/api-config-shared';
import {
  buildCreateEndpointPayload,
  buildEndpointRows,
  buildProviderCredentialPayload,
  buildProviderRowGroups,
  buildUpdateEndpointPayload,
  createdEndpointId,
  droppedKeySetNames,
  setsUsingEndpoint,
  type EndpointFormValues,
} from '../../hooks/api-settings-view';
import { providerDialogValues } from '../../hooks/credential-dialog-view';
import { CustomEndpointDialog } from '../CustomEndpointDialog';
import { ProviderConfigDialog } from '../ProviderConfigDialog';
import { CATEGORY_LABEL_KEY } from '../ProviderChoicePicker';
import { useApiSettings } from './ApiSettingsContext';
import { useSingleFlight } from './SettingsDialogFrame';
import { EndpointListRow, ProviderListRow } from './ProviderListRows';

type OpenDialog =
  | { kind: 'endpoint'; endpoint: CustomEndpoint | null }
  | { kind: 'provider'; entry: ProviderCatalogEntry }
  | null;

interface SettingsProvidersProps {
  /** Whether this is the tab on screen. It stays mounted, hidden, when it is not. */
  isActive: boolean;
}

// ==================== Providers Tab ====================

/**
 * Where credentials are entered: the user's custom endpoints, and the key of
 * each catalog provider.
 *
 * Every credential is edited in a dialog with its own Save, which writes that
 * credential and names no config set. So this tab has no unsaved state of its
 * own, and nothing done here can change the model a config set selects.
 */
export function SettingsProviders({ isActive }: SettingsProvidersProps) {
  const { t } = useTranslation();
  const settings = useApiSettings();
  const { isLoadingConfig, presets, providerCatalog, credentials, sets } = settings;
  const { configSets, activeConfigSetId } = sets;

  const [dialog, setDialog] = useState<OpenDialog>(null);
  // A provider's dialog asked for from inside the endpoint dialog, which closes
  // first. See the effect below.
  const [providerToOpen, setProviderToOpen] = useState<ProviderType | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CustomEndpoint | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');
  // The row a save was just made for, so the confirmation appears on it.
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
    },
    []
  );

  const deleteOnce = useSingleFlight();

  // A dialog is drawn over the whole window, not inside this tab, so hiding the
  // tab does not hide it. Whatever was open or waiting here goes when the panel
  // moves to another tab.
  useEffect(() => {
    if (!isActive) {
      setDialog(null);
      setPendingDelete(null);
      setProviderToOpen(null);
    }
  }, [isActive]);

  // Opened only once the endpoint dialog is gone. A dialog remembers what had
  // focus when it opened, to give it back when it closes; opened in the same
  // pass, this one would remember a button inside the dialog being removed,
  // and that dialog's own closing would then pull focus out from under it.
  // React runs the cleanup of everything removed before any new effect, so by
  // the time this runs focus is back on the page.
  useEffect(() => {
    if (dialog !== null || providerToOpen === null) {
      return;
    }
    const entry = getCatalogEntry(providerCatalog, providerToOpen);
    setProviderToOpen(null);
    if (entry && isActive) {
      setDialog({ kind: 'provider', entry });
    }
  }, [dialog, isActive, providerCatalog, providerToOpen]);

  if (isLoadingConfig) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
        <span className="ml-2 text-text-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  const endpointRows = buildEndpointRows(
    credentials.customEndpoints,
    configSets,
    credentials.credentialConflicts
  );
  const providerGroups = buildProviderRowGroups(
    providerCatalog,
    credentials.providerCredentials,
    configSets,
    credentials.credentialConflicts
  );
  const endpointLimitReached = credentials.customEndpoints.length >= CUSTOM_ENDPOINT_LIMIT;

  const showSavedOn = (rowKey: string) => {
    setJustSaved(rowKey);
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
    }
    savedTimerRef.current = setTimeout(() => setJustSaved(null), 2500);
  };

  // One thing at a time: opening a dialog drops a delete that was waiting to
  // be confirmed, so it cannot be found still open underneath afterwards.
  const openDialog = (next: OpenDialog) => {
    setError('');
    setPendingDelete(null);
    setDialog(next);
  };

  const saveEndpoint = async (endpoint: CustomEndpoint | null, values: EndpointFormValues) => {
    const result = endpoint
      ? await settings.updateEndpoint(buildUpdateEndpointPayload(endpoint.id, values))
      : await settings.createEndpoint(buildCreateEndpointPayload(values));
    if (result.ok) {
      const savedId =
        endpoint?.id ??
        createdEndpointId(credentials.customEndpoints, result.config.customEndpoints);
      if (savedId) {
        showSavedOn(`endpoint:${savedId}`);
      }
    }
    return result;
  };

  const saveProvider = async (
    entry: ProviderCatalogEntry,
    showsBaseUrl: boolean,
    input: { apiKey: string; baseUrl: string }
  ) => {
    const result = await settings.saveProviderCredential(
      buildProviderCredentialPayload({ provider: entry.id, ...input, showsBaseUrl })
    );
    if (result.ok) {
      showSavedOn(`provider:${entry.id}`);
    }
    return result;
  };

  const confirmDelete = () =>
    deleteOnce(async () => {
      if (!pendingDelete) {
        return;
      }
      setIsDeleting(true);
      try {
        const result = await settings.deleteEndpoint(pendingDelete.id);
        // A deleted endpoint leaves the list, which is its own confirmation.
        if (!result.ok) {
          setError(result.error);
        }
      } catch {
        setError(t('api.saveFailed'));
      } finally {
        setIsDeleting(false);
        setPendingDelete(null);
      }
    });

  const renderProviderDialog = (entry: ProviderCatalogEntry) => {
    const values = providerDialogValues({
      entry,
      presets,
      catalog: providerCatalog,
      credentials,
      configSets,
      activeConfigSetId,
    });
    return (
      <ProviderConfigDialog
        key={entry.id}
        {...values}
        onSave={(input) => saveProvider(entry, values.showsBaseUrl, input)}
        onClose={() => setDialog(null)}
      />
    );
  };

  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-text-secondary">{t('api.providers.intro')}</p>

      {/* ------------------------------------------------------------------ */}
      {/* Custom endpoints                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium text-text-primary">
            {t('api.providers.customEndpoints')}
          </h4>
          <button
            type="button"
            onClick={() => openDialog({ kind: 'endpoint', endpoint: null })}
            disabled={endpointLimitReached}
            title={
              endpointLimitReached
                ? t('api.providers.errors.limitReached', { count: CUSTOM_ENDPOINT_LIMIT })
                : undefined
            }
            className="flex items-center gap-1 px-3 py-2 rounded-lg bg-accent-muted text-xs font-medium text-accent hover:bg-accent-muted/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('api.providers.addEndpoint')}
          </button>
        </div>
        <p className="text-xs leading-5 text-text-muted">
          {t('api.providers.customEndpointsHint')}
        </p>

        {endpointRows.length === 0 ? (
          <p className="px-4 py-4 rounded-lg border border-dashed border-border-muted text-sm text-text-muted">
            {t('api.providers.noEndpoints')}
          </p>
        ) : (
          <ul className="rounded-lg border border-border-muted divide-y divide-border-muted">
            {endpointRows.map((row) => (
              <EndpointListRow
                key={row.endpoint.id}
                row={row}
                justSaved={justSaved === `endpoint:${row.endpoint.id}`}
                // One delete at a time: while one is being confirmed, no row
                // offers another, so the confirmation cannot change target.
                disabled={isDeleting || pendingDelete !== null}
                confirmingDelete={pendingDelete?.id === row.endpoint.id}
                isDeleting={isDeleting}
                onEdit={() => openDialog({ kind: 'endpoint', endpoint: row.endpoint })}
                onDelete={() => {
                  setError('');
                  setPendingDelete(row.endpoint);
                }}
                onConfirmDelete={() => {
                  void confirmDelete();
                }}
                onCancelDelete={() => setPendingDelete(null)}
              />
            ))}
          </ul>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 px-4 py-3 rounded-lg bg-error/10 text-sm text-error"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Catalog providers                                                   */}
      {/* ------------------------------------------------------------------ */}
      {providerGroups.map(({ category, rows }) => (
        <section key={category} className="space-y-2">
          <h4 className="text-sm font-medium text-text-primary">
            {t(CATEGORY_LABEL_KEY[category])}
          </h4>
          <ul className="rounded-lg border border-border-muted divide-y divide-border-muted">
            {rows.map((row) => (
              <ProviderListRow
                key={row.entry.id}
                row={row}
                justSaved={justSaved === `provider:${row.entry.id}`}
                disabled={isDeleting}
                onConfigure={() => openDialog({ kind: 'provider', entry: row.entry })}
              />
            ))}
          </ul>
        </section>
      ))}

      {dialog?.kind === 'endpoint' && (
        <CustomEndpointDialog
          key={dialog.endpoint?.id ?? 'new'}
          endpoint={dialog.endpoint}
          customEndpoints={credentials.customEndpoints}
          usedBy={
            dialog.endpoint
              ? setsUsingEndpoint(dialog.endpoint.id, configSets).map((set) => set.name)
              : []
          }
          droppedKeySets={
            dialog.endpoint
              ? droppedKeySetNames(dialog.endpoint.id, credentials.credentialConflicts, configSets)
              : []
          }
          configSets={configSets}
          activeConfigSetId={activeConfigSetId}
          providerCatalog={providerCatalog}
          onSave={(values) => saveEndpoint(dialog.endpoint, values)}
          onOpenProvider={(provider) => {
            setDialog(null);
            setProviderToOpen(provider);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'provider' && renderProviderDialog(dialog.entry)}
    </div>
  );
}
