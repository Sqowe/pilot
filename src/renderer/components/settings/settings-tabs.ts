/**
 * The tabs of the Settings panel, by id.
 *
 * Kept apart from the panel so the ids, and what an id from outside resolves
 * to, can be checked without rendering anything. Ids arrive from outside the
 * panel in three ways: the store's `settingsTab` (a link elsewhere in the app),
 * the `initialTab` prop, and the local navigation server
 * (`/navigate?page=settings&tab=…`).
 */
export type SettingsTabId =
  | 'providers'
  | 'modelSets'
  | 'sandbox'
  | 'connectors'
  | 'skills'
  | 'memory'
  | 'schedule'
  | 'remote'
  | 'logs'
  | 'general'
  | 'bashCommands'
  | 'prompt';

const VALID_TABS = new Set<SettingsTabId>([
  'providers',
  'modelSets',
  'sandbox',
  'connectors',
  'skills',
  'memory',
  'schedule',
  'remote',
  'logs',
  'general',
  'bashCommands',
  'prompt',
]);

/** The tab Settings opens on when nothing asks for another. */
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'modelSets';

/**
 * The tab a requested id opens, or null when it names none.
 *
 * `api` was one tab until it was split into Providers and Model Sets. A link or
 * a script that still asks for it gets Providers: entering a key is what "API
 * settings" was most often opened for.
 */
export function resolveSettingsTab(requested: string | null | undefined): SettingsTabId | null {
  if (requested === 'api') {
    return 'providers';
  }
  return requested && VALID_TABS.has(requested as SettingsTabId)
    ? (requested as SettingsTabId)
    : null;
}
