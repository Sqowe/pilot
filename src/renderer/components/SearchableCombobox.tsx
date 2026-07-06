/**
 * @module SearchableCombobox
 *
 * Generic controlled typeahead combobox. Used as the primitive behind both
 * ProviderPicker and the model field in SettingsAPI.
 *
 * Implements the ARIA combobox pattern:
 * https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
 *
 * Props
 * -----
 * items           — flat list of selectable options; include `group` to get
 *                   category headings rendered above the first item in each group
 * value           — currently selected item id (controlled)
 * onChange        — called with the new id when the user picks an item
 * placeholder     — trigger button text when nothing is selected
 * searchPlaceholder — input placeholder inside the popover
 * noResultsLabel  — localized text when the search returns no items
 * disabled        — disables the trigger
 * statusDot       — optional coloured dot on the trigger: 'green' | 'amber' | 'none'
 * className       — extra classes on the trigger button
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';

export interface ComboboxItem {
  id: string;
  label: string;
  /** Group heading — items with the same group string are clustered together */
  group?: string;
  /** Short badge text rendered next to the label (e.g. "CN", "AMS") */
  badge?: string;
}

export type StatusDotColor = 'green' | 'amber' | 'none';

interface SearchableComboboxProps {
  items: ComboboxItem[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Localized label shown when no items match the search query */
  noResultsLabel?: string;
  disabled?: boolean;
  statusDot?: StatusDotColor;
  className?: string;
  /** Accessible label for the trigger button */
  'aria-label'?: string;
}

const DOT_CLASSES: Record<StatusDotColor, string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-400',
  none: 'hidden',
};

// Shared filter helper — used by both the memoised `filtered` and the
// synchronous focusedIndex update in onChange to avoid computing twice.
function filterItems(items: ComboboxItem[], queryLower: string): ComboboxItem[] {
  if (!queryLower) return items;
  return items.filter(
    (i) => i.label.toLowerCase().includes(queryLower) || i.id.toLowerCase().includes(queryLower)
  );
}

export function SearchableCombobox({
  items,
  value,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  noResultsLabel = 'No results',
  disabled = false,
  statusDot = 'none',
  className = '',
  'aria-label': ariaLabel,
}: SearchableComboboxProps) {
  const uid = useId();
  const listboxId = `${uid}-listbox`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const selectedItem = useMemo(() => items.find((i) => i.id === value), [items, value]);

  // Fallback label: when value is set but not yet in items (async loading),
  // show the raw value rather than the placeholder so the user knows what's selected.
  const selectedLabel = selectedItem?.label ?? (value || null);

  // Filter items by query (label + id match) — memoised
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => filterItems(items, q), [items, q]);

  // Build a flat list with group-change markers for rendering — memoised
  const listWithGroups = useMemo(() => buildGroupedList(filtered), [filtered]);

  // Flat selectable items only — for keyboard navigation index arithmetic
  const selectableItems = useMemo(
    () => listWithGroups.filter((r): r is ItemRow => r.type === 'item'),
    [listWithGroups]
  );

  // Clamp focusedIndex when the selectable item list shrinks asynchronously
  // (e.g. model options load after the popover is already open).
  useEffect(() => {
    setFocusedIndex((i) => {
      if (selectableItems.length === 0) return -1;
      return Math.min(i, selectableItems.length - 1);
    });
  }, [selectableItems.length]);

  // Stable option id for aria-activedescendant
  const optionId = (idx: number) => `${uid}-opt-${idx}`;
  const activeDescendant = open && focusedIndex >= 0 ? optionId(focusedIndex) : undefined;

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus search input when popover opens
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFocusedIndex(-1);
    const id = window.setTimeout(() => searchRef.current?.focus(), 10);
    return () => window.clearTimeout(id);
  }, [open]);

  // Close popover when disabled flips to true mid-interaction.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const handleTrigger = useCallback(() => {
    if (!disabled) setOpen((o) => !o);
  }, [disabled]);

  const handleSelect = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange]
  );

  // Keyboard navigation within the list
  const handleSearchKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (selectableItems.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, selectableItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const focused = selectableItems[focusedIndex];
        if (focused) handleSelect(focused.item.id);
      }
    },
    [selectableItems, focusedIndex, handleSelect]
  );

  // Scroll focused item into view — use getElementById to avoid CSS.escape issues
  // with useId()-generated ids that may contain colons.
  useEffect(() => {
    if (focusedIndex < 0 || !listRef.current) return;
    const el = document.getElementById(optionId(focusedIndex));
    if (el && listRef.current.contains(el)) {
      el.scrollIntoView({ block: 'nearest' });
    }
    // optionId is stable per uid — exclude from deps to avoid infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedIndex]);

  return (
    <div ref={containerRef} className={`relative w-full ${className}`}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={handleTrigger}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`w-full flex items-center justify-between gap-2 px-4 py-3 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all disabled:opacity-50 disabled:cursor-not-allowed ${open ? 'ring-2 ring-accent/30 border-accent' : ''}`}
      >
        <span className="flex items-center gap-2 min-w-0">
          {statusDot !== 'none' && (
            <span
              className={`flex-shrink-0 w-2 h-2 rounded-full ${DOT_CLASSES[statusDot]}`}
              aria-hidden="true"
            />
          )}
          <span className="truncate text-sm">
            {selectedLabel ? selectedLabel : <span className="text-text-muted">{placeholder}</span>}
          </span>
          {selectedItem?.badge && (
            <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-hover text-text-secondary">
              {selectedItem.badge}
            </span>
          )}
        </span>
        <ChevronDown
          className={`flex-shrink-0 w-4 h-4 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-background shadow-lg overflow-hidden">
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border-muted">
            <Search className="flex-shrink-0 w-4 h-4 text-text-muted" aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-label={searchPlaceholder}
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant}
              aria-autocomplete="list"
              value={query}
              onChange={(e) => {
                const nextVal = e.target.value;
                setQuery(nextVal);
                // Compute next filtered length synchronously using the shared
                // helper so focusedIndex is consistent with the new query.
                const nextQ = nextVal.trim().toLowerCase();
                const nextFiltered = filterItems(items, nextQ);
                setFocusedIndex(nextFiltered.length > 0 ? 0 : -1);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder={searchPlaceholder}
              className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-muted outline-none"
            />
          </div>

          {/* List */}
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={placeholder}
            className="max-h-64 overflow-y-auto py-1"
          >
            {listWithGroups.length === 0 ? (
              <li
                className="px-4 py-3 text-sm text-text-muted text-center"
                role="option"
                aria-selected={false}
              >
                {noResultsLabel}
              </li>
            ) : (
              (() => {
                let itemIndex = -1;
                return listWithGroups.map((row, rowIdx) => {
                  if (row.type === 'group') {
                    return (
                      <li
                        key={`group-${row.label}-${rowIdx}`}
                        role="presentation"
                        className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted select-none"
                      >
                        {row.label}
                      </li>
                    );
                  }
                  itemIndex++;
                  const idx = itemIndex;
                  const item = row.item;
                  const isSelected = item.id === value;
                  const isFocused = idx === focusedIndex;
                  return (
                    <li
                      key={item.id}
                      id={optionId(idx)}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleSelect(item.id)}
                      onMouseEnter={() => setFocusedIndex(idx)}
                      className={`flex items-center justify-between gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                        isFocused
                          ? 'bg-surface-hover text-text-primary'
                          : isSelected
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="truncate">{item.label}</span>
                        {item.badge && (
                          <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-hover text-text-secondary">
                            {item.badge}
                          </span>
                        )}
                      </span>
                      {isSelected && (
                        <Check className="flex-shrink-0 w-4 h-4 text-accent" aria-hidden="true" />
                      )}
                    </li>
                  );
                });
              })()
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type GroupRow = { type: 'group'; label: string };
type ItemRow = { type: 'item'; item: ComboboxItem };
type ListRow = GroupRow | ItemRow;

function buildGroupedList(items: ComboboxItem[]): ListRow[] {
  const rows: ListRow[] = [];
  let lastGroup: string | undefined = undefined;
  for (const item of items) {
    if (item.group !== undefined && item.group !== lastGroup) {
      rows.push({ type: 'group', label: item.group });
      lastGroup = item.group;
    }
    rows.push({ type: 'item', item });
  }
  return rows;
}
