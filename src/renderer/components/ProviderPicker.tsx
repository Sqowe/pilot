/**
 * @module ProviderPicker
 *
 * Single searchable provider combobox fed by the full provider catalog
 * (Option 2 in docs/design/native-provider-catalog.md §13).
 *
 * There is no separate featured-chip row: the builtin/"featured" providers
 * appear as a pinned "Popular" group at the top of the same list, so there is
 * exactly one control and one always-visible selected state. The trigger always
 * shows the current provider (name + region badge + key-status dot).
 */

import { useTranslation } from 'react-i18next';
import {
  type ProviderCatalogEntry,
  type ProviderCategory,
  groupEntriesByCategory,
} from '../../shared/provider-catalog';
import { SearchableCombobox, type ComboboxItem, type StatusDotColor } from './SearchableCombobox';

interface ProviderPickerProps {
  /** Full catalog (builtin + native), as delivered by useApiConfigState */
  catalog: ProviderCatalogEntry[];
  /** Currently active provider id */
  value: string;
  /** Called when the user picks a new provider */
  onChange: (id: string) => void;
  /** Status dot on the trigger (parent computes from key presence / requirement) */
  statusDot?: StatusDotColor;
  /** Accessible label/tooltip for the status dot */
  statusDotLabel?: string;
  disabled?: boolean;
}

/**
 * Map ProviderCategory to its i18n key. The 'featured' category renders as
 * "Popular" (the pinned top group); every other category keeps its own name so
 * Custom and Local read as distinct concepts rather than provider families.
 */
export const CATEGORY_LABEL_KEY: Record<ProviderCategory, string> = {
  featured: 'api.providerPicker.categories.popular',
  'coding-plan': 'api.providerPicker.categories.codingPlan',
  inference: 'api.providerPicker.categories.inference',
  local: 'api.providerPicker.categories.local',
  custom: 'api.providerPicker.categories.custom',
};

export function ProviderPicker({
  catalog,
  value,
  onChange,
  statusDot = 'none',
  statusDotLabel,
  disabled = false,
}: ProviderPickerProps) {
  const { t } = useTranslation();

  // Group the FULL catalog. groupEntriesByCategory orders groups by category
  // weight (featured/Popular first) — the pinned-Popular combobox pattern.
  const grouped = groupEntriesByCategory(catalog);

  const items: ComboboxItem[] = grouped.flatMap(({ category, entries }) => {
    const groupLabel = t(CATEGORY_LABEL_KEY[category]);
    return entries.map((e) => ({
      id: e.id,
      // 'custom' is a UI concept (bring-your-own endpoint), not a brand name —
      // localize it; provider brand names stay as-is.
      label: e.id === 'custom' ? t('api.custom') : e.name,
      group: groupLabel,
      badge: e.regionTag,
    }));
  });

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
