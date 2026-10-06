/**
 * @module ProviderChoicePicker
 *
 * The chooser on a config set: one searchable list of everything a set can run
 * on — each custom endpoint by its own name, then the catalog providers in
 * their usual grouping. Before this, every custom endpoint was the same single
 * "Custom" entry, so two gateways could be neither told apart nor chosen
 * between.
 */

import { useTranslation } from 'react-i18next';
import type { CustomProtocolType } from '../types';
import { isCustomProtocol, protocolLabel } from '../hooks/api-config-shared';
import type { CredentialStatus, ProviderChoice } from '../hooks/api-settings-view';
import { CATEGORY_LABEL_KEY } from './ProviderPicker';
import { SearchableCombobox, type ComboboxItem, type StatusDotColor } from './SearchableCombobox';

interface ProviderChoicePickerProps {
  choices: ProviderChoice[];
  /** Id of the chosen entry, see `providerChoiceId` */
  value: string;
  onChange: (choiceId: string) => void;
  /** Status dot on the trigger — the chosen entry's, as the open set would run with it */
  statusDot?: StatusDotColor;
  statusDotLabel?: string;
  disabled?: boolean;
}

const STATUS_DOT: Record<CredentialStatus, StatusDotColor> = {
  configured: 'green',
  'key-missing': 'amber',
  'not-set': 'none',
};

export function ProviderChoicePicker({
  choices,
  value,
  onChange,
  statusDot = 'none',
  statusDotLabel,
  disabled = false,
}: ProviderChoicePickerProps) {
  const { t } = useTranslation();

  const items: ComboboxItem[] = choices.map((choice) => ({
    id: choice.id,
    label: choice.kind === 'no-endpoint' ? t('api.modelSets.noEndpoint') : choice.label,
    group:
      choice.group === 'endpoints'
        ? t('api.providers.customEndpoints')
        : t(CATEGORY_LABEL_KEY[choice.group]),
    // An endpoint's badge is the protocol it speaks; a provider's is its region.
    badge:
      choice.kind === 'endpoint' && isCustomProtocol(choice.badge)
        ? protocolLabel(choice.badge as CustomProtocolType, t)
        : choice.badge,
    dot: STATUS_DOT[choice.status],
  }));

  return (
    <SearchableCombobox
      items={items}
      value={value}
      onChange={onChange}
      placeholder={t('api.providerPicker.allProviders')}
      searchPlaceholder={t('api.providerPicker.searchPlaceholder')}
      noResultsLabel={t('api.providerPicker.noResults')}
      statusDot={statusDot}
      statusDotLabel={statusDotLabel}
      disabled={disabled}
      aria-label={t('api.provider')}
    />
  );
}
