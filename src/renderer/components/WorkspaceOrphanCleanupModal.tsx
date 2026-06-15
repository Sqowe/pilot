/**
 * WorkspaceOrphanCleanupModal — Modal for reviewing and removing stale
 * workspace profile entries (skills/MCP servers that are no longer installed).
 *
 * Opened when user clicks "Review & Clean Up" on the orphan detection toast.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Trash2, CheckCircle, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../store';
import type { OrphanDetectionResult } from '../../shared/workspace-orphan-types';

interface Props {
  orphans: OrphanDetectionResult;
  onClose: () => void;
}

interface OrphanEntry {
  id: string;
  type: 'skill' | 'mcp';
  section: string;
  checked: boolean;
}

export function WorkspaceOrphanCleanupModal({ orphans, onClose }: Props) {
  const { t } = useTranslation();
  const setWorkspaceOrphans = useAppStore((s) => s.setWorkspaceOrphans);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);

  // Build flat list of orphan entries with checkboxes (all checked by default)
  // Group by unique ID — a skill/server may appear in multiple sections, but cleanup
  // removes it from all sections at once. Show the first section encountered as context.
  const [entries, setEntries] = useState<OrphanEntry[]>(() => {
    const seen = new Set<string>();
    const items: OrphanEntry[] = [];

    for (const id of orphans.orphanedSkills.inPinned) {
      if (!seen.has(`skill:${id}`)) {
        seen.add(`skill:${id}`);
        items.push({ id, type: 'skill', section: 'pinned', checked: true });
      }
    }
    for (const id of orphans.orphanedSkills.inDisabled) {
      if (!seen.has(`skill:${id}`)) {
        seen.add(`skill:${id}`);
        items.push({ id, type: 'skill', section: 'disabled', checked: true });
      }
    }
    for (const name of orphans.orphanedMcpServers.inDisabled) {
      if (!seen.has(`mcp:${name}`)) {
        seen.add(`mcp:${name}`);
        items.push({ id: name, type: 'mcp', section: 'disabled', checked: true });
      }
    }
    for (const name of orphans.orphanedMcpServers.inEnabled) {
      if (!seen.has(`mcp:${name}`)) {
        seen.add(`mcp:${name}`);
        items.push({ id: name, type: 'mcp', section: 'enabled', checked: true });
      }
    }
    return items;
  });

  const [dontRemind, setDontRemind] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<{ status: 'success' | 'error'; count?: number } | null>(
    null
  );
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const checkedCount = entries.filter((e) => e.checked).length;
  const skillEntries = entries.filter((e) => e.type === 'skill');
  const mcpEntries = entries.filter((e) => e.type === 'mcp');

  const toggleEntry = useCallback((index: number) => {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, checked: !e.checked } : e)));
  }, []);

  const handleRemove = useCallback(
    async (removeAll: boolean) => {
      setIsProcessing(true);
      try {
        const toRemove = removeAll ? entries : entries.filter((e) => e.checked);
        const skillIds = toRemove.filter((e) => e.type === 'skill').map((e) => e.id);
        const mcpServerNames = toRemove.filter((e) => e.type === 'mcp').map((e) => e.id);

        const response = await window.electronAPI?.workspace?.cleanupOrphans({
          cwd: orphans.cwd,
          skillIds,
          mcpServerNames,
        });

        if (!mountedRef.current) return;

        if (response?.success) {
          const totalRemoved = (response.removed?.skills || 0) + (response.removed?.mcp || 0);

          // Guard against workspace change during async operation
          const currentState = useAppStore.getState();
          if (currentState.workingDir === orphans.cwd || !currentState.workingDir) {
            setWorkspaceOrphans(null);
            setGlobalNotice({
              id: `workspace-cleanup-success-${Date.now()}`,
              type: 'success',
              message: t('workspace.cleanupSuccess', { count: totalRemoved }),
              messageKey: 'workspace.cleanupSuccess',
              messageValues: { count: totalRemoved },
            });
          }

          setResult({ status: 'success', count: totalRemoved });
          // Auto-close after brief delay (guarded by mount check)
          closeTimerRef.current = setTimeout(() => {
            if (mountedRef.current) onClose();
          }, 1200);
        } else {
          setResult({ status: 'error' });
        }
      } catch (err) {
        console.error('[OrphanCleanup] Cleanup failed:', err);
        if (mountedRef.current) setResult({ status: 'error' });
      } finally {
        if (mountedRef.current) setIsProcessing(false);
      }
    },
    [entries, orphans.cwd, onClose, setWorkspaceOrphans, setGlobalNotice, t]
  );

  const handleDismiss = useCallback(async () => {
    // Clear state first to avoid stale mutations from async IPC
    setWorkspaceOrphans(null);
    onClose();

    if (dontRemind) {
      try {
        await window.electronAPI?.workspace?.dismissOrphanNotice(orphans.cwd);
      } catch (err) {
        console.warn('[OrphanCleanup] Failed to dismiss:', err);
      }
    }
  }, [dontRemind, orphans.cwd, onClose, setWorkspaceOrphans]);

  const getSectionLabel = (entry: OrphanEntry): string => {
    if (entry.section === 'pinned') return t('workspace.wasInPinned');
    if (entry.section === 'enabled') return t('workspace.wasInEnabled');
    return t('workspace.wasInDisabled');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="orphan-cleanup-title"
        className="w-full max-w-md rounded-2xl border border-border bg-surface shadow-elevated"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            <h2 id="orphan-cleanup-title" className="text-base font-semibold text-text-primary">
              {t('workspace.cleanupTitle')}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Description */}
        <p className="px-5 pb-3 text-sm text-text-secondary">{t('workspace.cleanupDescription')}</p>

        {/* Entry list */}
        <div className="max-h-64 overflow-y-auto px-5 pb-3">
          {/* Skills section */}
          {skillEntries.length > 0 && (
            <div className="mb-3">
              <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1.5">
                {t('workspace.sectionSkills')} ({skillEntries.length})
              </div>
              {skillEntries.map((entry) => {
                const globalIdx = entries.indexOf(entry);
                return (
                  <label
                    key={`skill-${entry.id}-${entry.section}`}
                    className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-surface-hover rounded-lg px-2 -mx-2"
                  >
                    <input
                      type="checkbox"
                      checked={entry.checked}
                      onChange={() => toggleEntry(globalIdx)}
                      className="rounded border-border text-accent focus:ring-accent/30"
                    />
                    <span className="text-sm text-text-primary font-mono">{entry.id}</span>
                    <span className="text-xs text-text-muted ml-auto">
                      {getSectionLabel(entry)}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {/* MCP section */}
          {mcpEntries.length > 0 && (
            <div className="mb-3">
              <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1.5">
                {t('workspace.sectionMcp')} ({mcpEntries.length})
              </div>
              {mcpEntries.map((entry) => {
                const globalIdx = entries.indexOf(entry);
                return (
                  <label
                    key={`mcp-${entry.id}-${entry.section}`}
                    className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-surface-hover rounded-lg px-2 -mx-2"
                  >
                    <input
                      type="checkbox"
                      checked={entry.checked}
                      onChange={() => toggleEntry(globalIdx)}
                      className="rounded border-border text-accent focus:ring-accent/30"
                    />
                    <span className="text-sm text-text-primary font-mono">{entry.id}</span>
                    <span className="text-xs text-text-muted ml-auto">
                      {getSectionLabel(entry)}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Result feedback */}
        {result?.status === 'success' && (
          <div className="mx-5 mb-3 flex items-center gap-2 text-sm text-success">
            <CheckCircle className="h-4 w-4" />
            <span>{t('workspace.cleanupSuccess', { count: result.count || 0 })}</span>
          </div>
        )}
        {result?.status === 'error' && (
          <div className="mx-5 mb-3 flex items-center gap-2 text-sm text-error">
            <AlertTriangle className="h-4 w-4" />
            <span>{t('workspace.cleanupFailed')}</span>
          </div>
        )}

        {/* Don't remind checkbox */}
        <div className="px-5 pb-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dontRemind}
              onChange={(e) => setDontRemind(e.target.checked)}
              className="rounded border-border text-accent focus:ring-accent/30"
            />
            <span className="text-xs text-text-muted">{t('workspace.cleanupDontRemind')}</span>
          </label>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 px-5 pb-5">
          <button
            type="button"
            onClick={() => handleRemove(true)}
            disabled={isProcessing || entries.length === 0}
            className="flex items-center gap-1.5 rounded-xl border border-error/40 bg-error/10 px-3 py-2 text-sm font-medium text-error hover:bg-error/20 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('workspace.cleanupRemoveAll')}
          </button>
          <button
            type="button"
            onClick={() => handleRemove(false)}
            disabled={isProcessing || checkedCount === 0}
            className="flex items-center gap-1.5 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {t('workspace.cleanupRemoveSelected')} ({checkedCount})
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={isProcessing}
            className="ml-auto rounded-xl px-3 py-2 text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            {t('workspace.cleanupDismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
