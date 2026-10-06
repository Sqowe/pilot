import { useEffect, useRef, useState } from 'react';
import type { AppConfig, ProviderPresets } from '../types';
import { BUILTIN_ENTRIES, type ProviderCatalogEntry } from '../../shared/provider-catalog';
import {
  FALLBACK_PROVIDER_PRESETS,
  isElectron,
  mergeProviderCatalog,
  sanitizeCatalogEntry,
} from './api-config-shared';

interface UseApiConfigSourceOptions {
  /** Load only while the screen is open. */
  enabled: boolean;
  /** A config the caller already has; skips asking main for one. */
  initialConfig?: AppConfig | null;
  /**
   * Called once per load with what main returned, in the same update that ends
   * the loading state — so the screen never renders a frame of defaults between
   * "loaded" and "applied".
   */
  onLoaded: (config: AppConfig | null | undefined, presets: ProviderPresets) => void;
}

/**
 * Loads what an API-settings screen is built from: the model presets, the
 * provider catalog (builtin + native), and the config itself.
 *
 * Read-only. The state slices take what this hands them and own it from there.
 */
export function useApiConfigSource(options: UseApiConfigSourceOptions) {
  const { enabled, initialConfig, onLoaded } = options;

  const [presets, setPresets] = useState<ProviderPresets>(FALLBACK_PROVIDER_PRESETS);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>(BUILTIN_ENTRIES);
  // True until the first IPC catalog load completes (or fails).
  // Consumers can use this to defer the model picker for native providers.
  const [isCatalogLoading, setIsCatalogLoading] = useState(isElectron);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  // The caller's handler changes identity as its own state does; a load must
  // call the current one without restarting because of it. Assigned during
  // render so it is current before the load effect below can possibly run.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    async function load() {
      setIsLoadingConfig(true);
      try {
        const loadedPresets = isElectron
          ? await window.electronAPI.config.getPresets()
          : FALLBACK_PROVIDER_PRESETS;
        const config = initialConfig || (isElectron ? await window.electronAPI.config.get() : null);
        // Load the provider catalog (builtin + native) from the main process.
        // Guard against missing IPC method (older preload builds) so catalog
        // fetch failure never aborts the config/presets load path.
        // Merge IPC results with BUILTIN_ENTRIES (deduped by id) so builtin
        // providers are always present even if the main process returns a
        // partial list.
        let loadedCatalog: ProviderCatalogEntry[] = BUILTIN_ENTRIES;
        if (isElectron) {
          const getCatalog = window.electronAPI?.config?.getProviderCatalog;
          if (typeof getCatalog === 'function') {
            try {
              const result = await getCatalog();
              if (Array.isArray(result) && result.length > 0) {
                // Sanitize entries before merging — drop malformed ones
                const sanitized = result
                  .map(sanitizeCatalogEntry)
                  .filter((e): e is ProviderCatalogEntry => e !== null);
                loadedCatalog = mergeProviderCatalog(sanitized, BUILTIN_ENTRIES);
              }
            } catch {
              // non-fatal — fall back to builtin-only catalog
            }
          }
        }
        if (cancelled) {
          return;
        }
        setProviderCatalog(loadedCatalog);
        setIsCatalogLoading(false);
        setPresets(loadedPresets);
        onLoadedRef.current(config, loadedPresets);
      } catch (loadError) {
        if (!cancelled) {
          console.error('Failed to load API config:', loadError);
          setIsCatalogLoading(false);
          setPresets(FALLBACK_PROVIDER_PRESETS);
          onLoadedRef.current(initialConfig, FALLBACK_PROVIDER_PRESETS);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingConfig(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, initialConfig]);

  return { presets, providerCatalog, isCatalogLoading, isLoadingConfig };
}
