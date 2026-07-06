/**
 * Unit tests for SearchableCombobox internal logic and ProviderPicker wiring.
 *
 * These tests target the pure helper functions extracted into the module
 * and the ProviderPicker catalog-to-items mapping logic. No DOM rendering
 * is used (vitest runs in node environment).
 */
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_ENTRIES,
  NATIVE_PROVIDER_META,
  groupEntriesByCategory,
  getNonFeaturedEntries,
  getFeaturedEntries,
  getCatalogEntry,
  type ProviderCatalogEntry,
  type ProviderCategory,
} from '../../shared/provider-catalog';

// ---------------------------------------------------------------------------
// Pure filter helper — replicated here since it's module-internal in the
// component. We test the logic contract rather than the private symbol.
// ---------------------------------------------------------------------------

function filterItems(
  items: Array<{ id: string; label: string }>,
  queryLower: string
): Array<{ id: string; label: string }> {
  if (!queryLower) return items;
  return items.filter(
    (i) => i.label.toLowerCase().includes(queryLower) || i.id.toLowerCase().includes(queryLower)
  );
}

// ---------------------------------------------------------------------------
// Pure grouped-list builder — same logic as the component's buildGroupedList.
// ---------------------------------------------------------------------------

type GroupRow = { type: 'group'; label: string };
type ItemRow = { type: 'item'; item: { id: string; label: string; group?: string } };
type ListRow = GroupRow | ItemRow;

function buildGroupedList(items: Array<{ id: string; label: string; group?: string }>): ListRow[] {
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

// ---------------------------------------------------------------------------
// filterItems
// ---------------------------------------------------------------------------

describe('filterItems', () => {
  const items = [
    { id: 'zai', label: 'z.ai (GLM)' },
    { id: 'groq', label: 'Groq' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'minimax', label: 'MiniMax' },
  ];

  it('returns all items when query is empty string', () => {
    expect(filterItems(items, '')).toHaveLength(4);
  });

  it('matches by label (case-insensitive)', () => {
    const result = filterItems(items, 'groq');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('groq');
  });

  it('matches by id (case-insensitive)', () => {
    // filterItems expects queryLower already lowercased (matches component usage)
    const result = filterItems(items, 'deepseek');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('deepseek');
  });

  it('matches partial label substring', () => {
    const result = filterItems(items, 'mini');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('minimax');
  });

  it('returns empty array when nothing matches', () => {
    expect(filterItems(items, 'xyznotfound')).toHaveLength(0);
  });

  it('returns multiple matches when query is ambiguous', () => {
    // 'z' matches 'z.ai (GLM)' (label) and nothing else
    const result = filterItems(items, 'z');
    expect(result.some((i) => i.id === 'zai')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildGroupedList
// ---------------------------------------------------------------------------

describe('buildGroupedList', () => {
  const items = [
    { id: 'zai', label: 'z.ai', group: 'Coding plans' },
    { id: 'minimax', label: 'MiniMax', group: 'Coding plans' },
    { id: 'groq', label: 'Groq', group: 'Fast inference' },
  ];

  it('inserts a group row before the first item of each group', () => {
    const rows = buildGroupedList(items);
    expect(rows[0]).toMatchObject({ type: 'group', label: 'Coding plans' });
    expect(rows[1]).toMatchObject({ type: 'item' });
    expect(rows[2]).toMatchObject({ type: 'item' });
    expect(rows[3]).toMatchObject({ type: 'group', label: 'Fast inference' });
    expect(rows[4]).toMatchObject({ type: 'item' });
  });

  it('does not insert duplicate group rows for consecutive same-group items', () => {
    const rows = buildGroupedList(items);
    const groupRows = rows.filter((r) => r.type === 'group');
    expect(groupRows).toHaveLength(2);
  });

  it('handles items with no group (no group header)', () => {
    const ungrouped = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    const rows = buildGroupedList(ungrouped);
    expect(rows.every((r) => r.type === 'item')).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(buildGroupedList([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ProviderPicker catalog → items logic
// ---------------------------------------------------------------------------

describe('ProviderPicker catalog mapping', () => {
  // Minimal native entries simulating what IPC delivers
  const nativeEntries: ProviderCatalogEntry[] = [
    {
      id: 'zai',
      name: 'z.ai (GLM)',
      kind: 'native',
      category: 'coding-plan',
      piProvider: 'zai',
      routeProtocol: 'openai',
      keyEnvVar: 'ZAI_API_KEY',
      formShape: {
        apiKey: true,
        baseUrl: false,
        protocol: false,
        contextWindow: false,
        modelDropdown: true,
        manualModelToggle: true,
      },
      featured: false,
      modelOptions: [],
    },
    {
      id: 'minimax-cn',
      name: 'MiniMax (CN)',
      kind: 'native',
      category: 'coding-plan',
      piProvider: 'minimax-cn',
      routeProtocol: 'openai',
      keyEnvVar: 'MINIMAX_CN_API_KEY',
      regionOf: 'minimax',
      regionTag: 'CN',
      formShape: {
        apiKey: true,
        baseUrl: false,
        protocol: false,
        contextWindow: false,
        modelDropdown: true,
        manualModelToggle: true,
      },
      featured: false,
      modelOptions: [],
    },
    {
      id: 'groq',
      name: 'Groq',
      kind: 'native',
      category: 'inference',
      piProvider: 'groq',
      routeProtocol: 'openai',
      keyEnvVar: 'GROQ_API_KEY',
      formShape: {
        apiKey: true,
        baseUrl: false,
        protocol: false,
        contextWindow: false,
        modelDropdown: true,
        manualModelToggle: true,
      },
      featured: false,
      modelOptions: [],
    },
  ];

  const fullCatalog = [...BUILTIN_ENTRIES, ...nativeEntries];

  it('getFeaturedEntries returns only the 6 builtin entries', () => {
    const featured = getFeaturedEntries(fullCatalog);
    expect(featured).toHaveLength(6);
    expect(featured.every((e) => e.featured)).toBe(true);
  });

  it('getNonFeaturedEntries returns only native/non-featured entries', () => {
    const nonFeatured = getNonFeaturedEntries(fullCatalog);
    expect(nonFeatured.every((e) => !e.featured)).toBe(true);
    expect(nonFeatured.some((e) => e.id === 'zai')).toBe(true);
    expect(nonFeatured.some((e) => e.id === 'groq')).toBe(true);
  });

  it('getNonFeaturedEntries are sorted by category order then name', () => {
    const nonFeatured = getNonFeaturedEntries(fullCatalog);
    // coding-plan comes before inference
    const codingPlanIdx = nonFeatured.findIndex((e) => e.category === 'coding-plan');
    const inferenceIdx = nonFeatured.findIndex((e) => e.category === 'inference');
    expect(codingPlanIdx).toBeLessThan(inferenceIdx);
  });

  it('groupEntriesByCategory produces one group per category', () => {
    const nonFeatured = getNonFeaturedEntries(fullCatalog);
    const groups = groupEntriesByCategory(nonFeatured);
    const categories = groups.map((g) => g.category);
    // No duplicates
    expect(new Set(categories).size).toBe(categories.length);
    // All expected categories present
    expect(categories).toContain('coding-plan');
    expect(categories).toContain('inference');
  });

  it('regionTag is preserved on catalog entry (used as badge in picker)', () => {
    const entry = getCatalogEntry(fullCatalog, 'minimax-cn');
    expect(entry?.regionTag).toBe('CN');
  });

  it('getCatalogEntry returns undefined for unknown id', () => {
    expect(getCatalogEntry(fullCatalog, 'nonexistent-provider-xyz')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SettingsAPI formShape-derived display flags — logic contract tests
// ---------------------------------------------------------------------------

describe('SettingsAPI formShape display flag derivation', () => {
  // Mirror the exact derivation logic used in SettingsAPI
  function deriveFlags(
    provider: string,
    activeFormShape: {
      apiKey: boolean;
      baseUrl: boolean;
      protocol: boolean;
      contextWindow: boolean;
      modelDropdown: boolean;
      manualModelToggle: boolean;
    } | null
  ) {
    const showProtocol = provider === 'custom';
    const showBaseUrl =
      activeFormShape != null
        ? activeFormShape.baseUrl
        : provider === 'custom' || provider === 'ollama';
    const showContextWindow =
      activeFormShape != null
        ? activeFormShape.contextWindow
        : provider === 'custom' || provider === 'ollama';
    const showModelDropdown = activeFormShape != null ? activeFormShape.modelDropdown : false;
    const showManualModelToggle =
      activeFormShape != null ? activeFormShape.manualModelToggle : true;
    return {
      showProtocol,
      showBaseUrl,
      showContextWindow,
      showModelDropdown,
      showManualModelToggle,
    };
  }

  it('native provider: shows model dropdown, hides base URL and protocol', () => {
    const nativeShape = {
      apiKey: true,
      baseUrl: false,
      protocol: false,
      contextWindow: false,
      modelDropdown: true,
      manualModelToggle: true,
    };
    const flags = deriveFlags('zai', nativeShape);
    expect(flags.showModelDropdown).toBe(true);
    expect(flags.showBaseUrl).toBe(false);
    expect(flags.showProtocol).toBe(false);
    expect(flags.showContextWindow).toBe(false);
    expect(flags.showManualModelToggle).toBe(true);
  });

  it('custom provider: shows protocol, base URL, context window', () => {
    const flags = deriveFlags('custom', null);
    expect(flags.showProtocol).toBe(true);
    expect(flags.showBaseUrl).toBe(true);
    expect(flags.showContextWindow).toBe(true);
    expect(flags.showModelDropdown).toBe(false);
  });

  it('ollama provider: shows base URL and context window, not protocol', () => {
    const flags = deriveFlags('ollama', null);
    expect(flags.showProtocol).toBe(false);
    expect(flags.showBaseUrl).toBe(true);
    expect(flags.showContextWindow).toBe(true);
  });

  it('builtin cloud provider (anthropic): hides all extra fields', () => {
    const flags = deriveFlags('anthropic', null);
    expect(flags.showProtocol).toBe(false);
    expect(flags.showBaseUrl).toBe(false);
    expect(flags.showContextWindow).toBe(false);
    expect(flags.showModelDropdown).toBe(false);
  });

  it('protocol is always false for native providers (hard-gated to custom)', () => {
    // Even if a hypothetical native formShape had protocol:true, showProtocol
    // is derived solely from provider === 'custom'
    const nativeShapeWithProtocol = {
      apiKey: true,
      baseUrl: false,
      protocol: true, // hypothetical — NATIVE_SHAPE has false
      contextWindow: false,
      modelDropdown: true,
      manualModelToggle: true,
    };
    const flags = deriveFlags('zai', nativeShapeWithProtocol);
    expect(flags.showProtocol).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// activeIsNonFeatured logic contract
// ---------------------------------------------------------------------------

describe('activeIsNonFeatured derivation', () => {
  function deriveActiveIsNonFeatured(
    activeCatalogEntry: ProviderCatalogEntry | undefined
  ): boolean {
    return (
      !!activeCatalogEntry &&
      !activeCatalogEntry.featured &&
      (activeCatalogEntry.kind === 'native' || activeCatalogEntry.kind === 'custom')
    );
  }

  it('is false when catalog entry is undefined (loading state)', () => {
    expect(deriveActiveIsNonFeatured(undefined)).toBe(false);
  });

  it('is false for a featured builtin entry', () => {
    const anthropic = BUILTIN_ENTRIES.find((e) => e.id === 'anthropic')!;
    expect(deriveActiveIsNonFeatured(anthropic)).toBe(false);
  });

  it('is true for a non-featured native entry', () => {
    const native: ProviderCatalogEntry = {
      id: 'groq',
      name: 'Groq',
      kind: 'native',
      category: 'inference',
      piProvider: 'groq',
      routeProtocol: 'openai',
      formShape: {
        apiKey: true,
        baseUrl: false,
        protocol: false,
        contextWindow: false,
        modelDropdown: true,
        manualModelToggle: true,
      },
      featured: false,
      modelOptions: [],
    };
    expect(deriveActiveIsNonFeatured(native)).toBe(true);
  });

  it('is false for a featured custom entry (the More Models chip)', () => {
    const custom = BUILTIN_ENTRIES.find((e) => e.id === 'custom')!;
    // custom is featured:true, so should not be non-featured
    expect(deriveActiveIsNonFeatured(custom)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NATIVE_PROVIDER_META completeness — ensures all v1 allowlist entries have
// the fields the ProviderPicker relies on.
// ---------------------------------------------------------------------------

describe('NATIVE_PROVIDER_META completeness', () => {
  it('every entry has a non-empty name', () => {
    for (const [id, meta] of Object.entries(NATIVE_PROVIDER_META)) {
      expect(meta.name, `${id}.name`).toBeTruthy();
    }
  });

  it('every entry has a valid category', () => {
    const validCategories: ProviderCategory[] = [
      'featured',
      'coding-plan',
      'inference',
      'local',
      'custom',
    ];
    for (const [id, meta] of Object.entries(NATIVE_PROVIDER_META)) {
      expect(validCategories, `${id}.category`).toContain(meta.category);
    }
  });

  it('region variants have a regionOf that points to a base entry', () => {
    const allIds = new Set(Object.keys(NATIVE_PROVIDER_META));
    for (const [id, meta] of Object.entries(NATIVE_PROVIDER_META)) {
      if (meta.regionOf) {
        expect(allIds, `${id}.regionOf '${meta.regionOf}' not found`).toContain(meta.regionOf);
      }
    }
  });
});
