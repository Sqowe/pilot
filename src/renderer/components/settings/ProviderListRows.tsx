import { useTranslation } from 'react-i18next';
import { CheckCircle, Pencil, Settings2, Trash2 } from 'lucide-react';
import { isCustomProtocol, protocolLabel } from '../../hooks/api-config-shared';
import type { CredentialStatus, EndpointRow, ProviderRow } from '../../hooks/api-settings-view';

const STATUS_DOT_CLASS: Record<CredentialStatus, string> = {
  configured: 'bg-green-500',
  'key-missing': 'bg-amber-400',
  'not-set': 'border border-border',
};

const STATUS_LABEL_KEY: Record<CredentialStatus, string> = {
  configured: 'api.providers.status.configured',
  'key-missing': 'api.providers.status.keyMissing',
  'not-set': 'api.providers.status.notSet',
};

interface CredentialStatusBadgeProps {
  status: CredentialStatus;
  /** Set for a moment after this credential was saved. */
  justSaved?: boolean;
}

/**
 * A credential's status as a dot with its meaning in words beside it.
 *
 * Right after a save it says "saved" instead, on the row the save was for: the
 * list is long, and a notice anywhere else may be scrolled out of sight.
 */
export function CredentialStatusBadge({ status, justSaved = false }: CredentialStatusBadgeProps) {
  const { t } = useTranslation();
  if (justSaved) {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 flex-shrink-0 text-xs font-medium text-success"
      >
        <CheckCircle className="w-3.5 h-3.5" aria-hidden="true" />
        {t('api.providers.saved')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 flex-shrink-0 text-xs text-text-muted">
      <span className={`w-2 h-2 rounded-full ${STATUS_DOT_CLASS[status]}`} aria-hidden="true" />
      {t(STATUS_LABEL_KEY[status])}
    </span>
  );
}

const ROW_BUTTON_CLASS =
  'flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border-muted bg-background text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

interface EndpointListRowProps {
  row: EndpointRow;
  justSaved: boolean;
  /** Edit and Delete are off: a delete is being confirmed or is on its way. */
  disabled: boolean;
  /** This is the row whose delete is waiting to be confirmed. */
  confirmingDelete: boolean;
  isDeleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/**
 * One custom endpoint: its name, the protocol it speaks, its address, whether
 * it has a key, and which config sets run on it. An endpoint in use cannot be
 * deleted — the row says by what, which is also what to change first.
 *
 * A delete is confirmed on the row it is for, so the question and the endpoint
 * it is about are never apart.
 */
export function EndpointListRow({
  row,
  justSaved,
  disabled,
  confirmingDelete,
  isDeleting,
  onEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: EndpointListRowProps) {
  const { t } = useTranslation();
  const { endpoint, status, usedBy } = row;
  const inUse = usedBy.length > 0;

  return (
    <li className="px-4 py-3 space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0 space-y-0.5">
          <p className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-medium text-text-primary">{endpoint.name}</span>
            <span className="flex-shrink-0 px-1.5 py-0.5 rounded bg-surface-hover text-[10px] font-medium text-text-secondary">
              {isCustomProtocol(endpoint.protocol)
                ? protocolLabel(endpoint.protocol, t)
                : endpoint.protocol}
            </span>
          </p>
          <p className="truncate text-xs text-text-muted select-text">{endpoint.baseUrl}</p>
          <p className="truncate text-xs text-text-muted">
            {inUse
              ? t('api.providers.usedBy', { sets: usedBy.join(', ') })
              : t('api.providers.notUsed')}
          </p>
        </div>
        <CredentialStatusBadge status={status} justSaved={justSaved} />
        <button type="button" onClick={onEdit} disabled={disabled} className={ROW_BUTTON_CLASS}>
          <Pencil className="w-3.5 h-3.5" />
          {t('common.edit')}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled || inUse}
          title={inUse ? t('api.providers.deleteEndpointInUse') : undefined}
          aria-label={t('api.providers.deleteEndpoint', { name: endpoint.name })}
          className="flex items-center px-2 py-1.5 rounded-lg text-xs text-text-muted hover:text-error hover:bg-error/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-muted transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {confirmingDelete && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-error/30 bg-error/10">
          <p className="text-xs text-text-primary">
            {t('api.providers.deleteEndpointConfirm', { name: endpoint.name })}
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={isDeleting}
              className="px-3 py-1.5 rounded-lg border border-border bg-surface text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={isDeleting}
              className="px-3 py-1.5 rounded-lg bg-error text-xs font-medium text-white hover:bg-error/80 disabled:opacity-50 transition-colors"
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

interface ProviderListRowProps {
  row: ProviderRow;
  justSaved: boolean;
  disabled: boolean;
  onConfigure: () => void;
}

/** One catalog provider: its name, whether it has a key, and which config sets use it. */
export function ProviderListRow({ row, justSaved, disabled, onConfigure }: ProviderListRowProps) {
  const { t } = useTranslation();
  const { entry, status, usedBy } = row;

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm text-text-primary">{entry.name}</span>
          {entry.regionTag && (
            <span className="flex-shrink-0 px-1.5 py-0.5 rounded bg-surface-hover text-[10px] font-medium text-text-secondary">
              {entry.regionTag}
            </span>
          )}
        </p>
        {usedBy.length > 0 && (
          <p className="truncate text-xs text-text-muted">
            {t('api.providers.usedBy', { sets: usedBy.join(', ') })}
          </p>
        )}
      </div>
      <CredentialStatusBadge status={status} justSaved={justSaved} />
      <button
        type="button"
        onClick={onConfigure}
        disabled={disabled}
        aria-label={t('api.providers.configureTitle', { name: entry.name })}
        className={ROW_BUTTON_CLASS}
      >
        <Settings2 className="w-3.5 h-3.5" />
        {t('api.providers.configure')}
      </button>
    </li>
  );
}
