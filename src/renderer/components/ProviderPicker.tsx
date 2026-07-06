/**
 * @module ProviderPicker
 *
 * Searchable provider combobox fed by the full provider catalog.
 * Renders native + custom entries grouped by category.
 * Featured (builtin) entries are shown as chips above this component
 * in SettingsAPI — this picker handles the "All providers" expansion.
 *
 * The component is always rendered; providers not in the non-featured list
 * simply leave the combobox with an empty selection (showing its placeholder),
 * which acts as a clear visual affordance to expand to more providers.
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
  /** Whether a key is saved for the given provider id (drives status dot) */
  hasKey?: (id: string) => boolean;
  disabled?: boolean;
}

/** Map ProviderCategory to its i18n key */
const CATEGORY_LABEL_KEY: Record<ProviderCategory, string> = {
  featured: 'api.providerPicker.categories.featured',
  'coding-plan': 'api.providerPicker.categories.codingPlan',
  inference: 'api.providerPicker.categories.inference',
  local: 'api.providerPicker.categories.local',
  custom: 'api.providerPicker.categories.custom',
};

export function ProviderPicker({
  catalog,
  value,
  onChange,
  hasKey,
  disabled = false,
}: ProviderPickerProps) {
  const { t } = useTranslation();

  // Non-featured entries only — featured chips are rendered separately above
  const nonFeatured = catalog.filter((e) => !e.featured);
  const grouped = groupEntriesByCategory(nonFeatured);

  // Build flat ComboboxItem list with group headings
  const items: ComboboxItem[] = grouped.flatMap(({ category, entries }) => {
    const groupLabel = t(CATEGORY_LABEL_KEY[category]);
    return entries.map((e) => ({
      id: e.id,
      label: e.name,
      group: groupLabel,
      badge: e.regionTag,
    }));
  });

  // Status dot: green if key is saved, amber if selected but no key, none otherwise
  const statusDot: StatusDotColor = (() => {
    const entry = catalog.find((e) => e.id === value);
    if (!entry || entry.featured) return 'none';
    if (hasKey?.(value)) return 'green';
    return 'amber';
  })();

  const selectedIsNonFeatured = nonFeatured.some((e) => e.id === value);

  return (
    <SearchableCombobox
      items={items}
      value={selectedIsNonFeatured ? value : ''}
      onChange={onChange}
      placeholder={t('api.providerPicker.allProviders')}
      searchPlaceholder={t('api.providerPicker.searchPlaceholder')}
      noResultsLabel={t('api.providerPicker.noResults')}
      statusDot={statusDot}
      disabled={disabled}
      aria-label={t('api.providerPicker.allProviders')}
    />
  );
}
