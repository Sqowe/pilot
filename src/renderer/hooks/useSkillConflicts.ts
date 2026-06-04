/**
 * Hook for managing skill conflict resolution state.
 * Loads conflict config + detected conflicts from the main process.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  ConflictPolicy,
  SkillConflictConfig,
  SkillConflict,
} from '../../shared/skill-conflict-types';
import { useAppStore } from '../store';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

/** Shape of the skills conflict API exposed via electronAPI.skills */
interface SkillsConflictAPI {
  getConflictConfig: () => Promise<SkillConflictConfig>;
  getConflicts: () => Promise<{ conflicts: SkillConflict[]; notImplemented?: boolean }>;
  setConflictPolicy: (policy: ConflictPolicy) => Promise<{ success: boolean; error?: string }>;
  setSourceOverride: (
    skillName: string,
    source: string
  ) => Promise<{ success: boolean; error?: string }>;
  toggleDisabled: (
    skillName: string,
    disabled: boolean
  ) => Promise<{ success: boolean; error?: string }>;
  acknowledgeConflict: (
    skillName: string,
    choice: string
  ) => Promise<{ success: boolean; error?: string }>;
  resetToBuiltin: (skillName: string) => Promise<{ success: boolean; error?: string }>;
}

function getSkillsApi(): SkillsConflictAPI | null {
  if (!isElectron) return null;
  const electronAPI = (window as unknown as Record<string, unknown>).electronAPI as
    | Record<string, unknown>
    | undefined;
  if (!electronAPI || typeof electronAPI !== 'object') return null;
  const api = electronAPI.skills;
  if (!api || typeof api !== 'object') return null;
  // Verify all required methods exist
  const typed = api as Record<string, unknown>;
  const requiredMethods = [
    'getConflictConfig',
    'getConflicts',
    'setConflictPolicy',
    'setSourceOverride',
    'toggleDisabled',
    'acknowledgeConflict',
    'resetToBuiltin',
  ];
  for (const method of requiredMethods) {
    if (typeof typed[method] !== 'function') return null;
  }
  return api as unknown as SkillsConflictAPI;
}

export interface UseSkillConflictsResult {
  config: SkillConflictConfig | null;
  conflicts: SkillConflict[];
  loading: boolean;
  available: boolean;
  setPolicy: (policy: ConflictPolicy) => Promise<void>;
  setSourceOverride: (skillName: string, source: string) => Promise<void>;
  toggleDisabled: (skillName: string, disabled: boolean) => Promise<void>;
  acknowledgeConflict: (skillName: string, choice: string) => Promise<void>;
  resetToBuiltin: (skillName: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSkillConflicts(): UseSkillConflictsResult {
  const [config, setConfig] = useState<SkillConflictConfig | null>(null);
  const [conflicts, setConflicts] = useState<SkillConflict[]>([]);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(false);
  const refreshIdRef = useRef(0);

  // Subscribe to skills storage change events to auto-refresh when conflicts change
  const skillsStorageChangedAt = useAppStore((state) => state.skillsStorageChangedAt);

  const refresh = useCallback(async () => {
    const api = getSkillsApi();
    if (!api) {
      setAvailable(false);
      return;
    }
    setAvailable(true);
    setLoading(true);
    const requestId = ++refreshIdRef.current;
    try {
      const [configResult, conflictsResult] = await Promise.all([
        api.getConflictConfig(),
        api.getConflicts(),
      ]);
      // Only update state if this is still the latest request
      if (requestId !== refreshIdRef.current) return;
      if (configResult) setConfig(configResult);
      if (conflictsResult && !conflictsResult.notImplemented) {
        setConflicts(conflictsResult.conflicts);
      }
    } catch (err) {
      if (requestId !== refreshIdRef.current) return;
      console.error('[useSkillConflicts] Failed to load:', err);
    } finally {
      if (requestId === refreshIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Refresh on mount and when skills storage changes (covers conflict-detected events)
  useEffect(() => {
    refresh();
  }, [refresh, skillsStorageChangedAt]);

  const setPolicy = useCallback(
    async (policy: ConflictPolicy) => {
      const api = getSkillsApi();
      if (!api) return;
      try {
        const result = await api.setConflictPolicy(policy);
        if (result?.success) {
          await refresh();
        }
      } catch (err) {
        console.error('[useSkillConflicts] setPolicy failed:', err);
      }
    },
    [refresh]
  );

  const setSourceOverride = useCallback(
    async (skillName: string, source: string) => {
      const api = getSkillsApi();
      if (!api) return;
      try {
        const result = await api.setSourceOverride(skillName, source);
        if (result?.success) {
          await refresh();
        }
      } catch (err) {
        console.error('[useSkillConflicts] setSourceOverride failed:', err);
      }
    },
    [refresh]
  );

  const toggleDisabled = useCallback(
    async (skillName: string, disabled: boolean) => {
      const api = getSkillsApi();
      if (!api) return;
      try {
        const result = await api.toggleDisabled(skillName, disabled);
        if (result?.success) {
          await refresh();
        }
      } catch (err) {
        console.error('[useSkillConflicts] toggleDisabled failed:', err);
      }
    },
    [refresh]
  );

  const acknowledgeConflict = useCallback(
    async (skillName: string, choice: string) => {
      const api = getSkillsApi();
      if (!api) return;
      try {
        const result = await api.acknowledgeConflict(skillName, choice);
        if (result?.success) {
          await refresh();
        }
      } catch (err) {
        console.error('[useSkillConflicts] acknowledgeConflict failed:', err);
      }
    },
    [refresh]
  );

  const resetToBuiltin = useCallback(
    async (skillName: string) => {
      const api = getSkillsApi();
      if (!api) return;
      try {
        const result = await api.resetToBuiltin(skillName);
        if (result?.success) {
          await refresh();
        }
      } catch (err) {
        console.error('[useSkillConflicts] resetToBuiltin failed:', err);
      }
    },
    [refresh]
  );

  return {
    config,
    conflicts,
    loading,
    available,
    setPolicy,
    setSourceOverride,
    toggleDisabled,
    acknowledgeConflict,
    resetToBuiltin,
    refresh,
  };
}
