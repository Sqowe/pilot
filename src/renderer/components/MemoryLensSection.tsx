import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Brain, FolderOpen, Database, Zap } from 'lucide-react';
import { useAppStore } from '../store';
import type { MemoryPanelState } from '../types';

interface MemoryLensSectionProps {
  cwd: string | undefined;
  collapsed: boolean;
  sessionId: string | undefined;
}

export function MemoryLensSection({ cwd, collapsed, sessionId }: MemoryLensSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [panelState, setPanelState] = useState<MemoryPanelState | null>(null);
  const [error, setError] = useState(false);

  // Watch for message count changes to trigger a refresh after each turn
  const sessionStates = useAppStore((s) => s.sessionStates);
  const messageCount = sessionId ? (sessionStates[sessionId]?.traceSteps?.length ?? 0) : 0;

  useEffect(() => {
    if (collapsed) return;

    let cancelled = false;
    const load = async () => {
      try {
        const state = await window.electronAPI.memory.getPanelState(cwd, sessionId);
        if (!cancelled) {
          setPanelState(state);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    load();

    // Refresh every 30s while visible
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cwd, collapsed, messageCount, sessionId]);

  if (collapsed || panelState === null) return null;

  const { enabled, skillFallbackEnabled, coreEntries, workspaceStats, totalStats } = panelState;

  // Group core entries by category
  const grouped = coreEntries.reduce<Record<string, Array<{ key: string; value: string }>>>(
    (acc, entry) => {
      const cat = entry.category || 'other';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push({ key: entry.key, value: entry.value });
      return acc;
    },
    {}
  );

  const categoryLabels: Record<string, string> = {
    interests: t('memoryLens.interests'),
    preferences: t('memoryLens.preferences'),
    skills: t('memoryLens.skills'),
    identity: t('memoryLens.identity'),
    other: t('memoryLens.other'),
  };

  const categoryOrder = ['interests', 'preferences', 'skills', 'identity', 'other'];

  return (
    <div className="border-b border-border-muted">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover transition-colors"
      >
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5">
          <Brain className="w-3.5 h-3.5" />
          {t('memoryLens.title')}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={`flex items-center gap-1 text-xs ${enabled ? 'text-green-500' : 'text-text-muted'}`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-green-500' : 'bg-red-400'}`}
            />
            {enabled ? t('memoryLens.active') : t('memoryLens.disabled')}
          </span>
          {open ? (
            <ChevronUp className="w-3.5 h-3.5 text-text-muted" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
          )}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-3">
          {error && <p className="text-xs text-red-400">{t('memoryLens.loadError')}</p>}

          {!enabled && <p className="text-xs text-text-muted">{t('memoryLens.disabledHint')}</p>}

          {enabled && (
            <>
              {/* Status */}
              <div className="text-xs text-text-muted space-y-0.5">
                <div className="flex items-center justify-between">
                  <span>{t('memoryLens.inAppMemory')}</span>
                  <span className="text-green-500 font-medium">ON</span>
                </div>
                {skillFallbackEnabled && (
                  <div className="flex items-center justify-between">
                    <span>{t('memoryLens.skillFallback')}</span>
                    <span className="text-amber-500 font-medium">ON</span>
                  </div>
                )}
              </div>

              {/* Profile */}
              {coreEntries.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-text-muted flex items-center gap-1">
                      <Database className="w-3 h-3" />
                      {t('memoryLens.profile')} ({coreEntries.length})
                    </span>
                  </div>
                  <div className="space-y-1.5 pl-1">
                    {categoryOrder
                      .filter((cat) => grouped[cat]?.length)
                      .map((cat) => (
                        <div key={cat}>
                          <span className="text-[10px] uppercase tracking-wider text-text-muted/70">
                            {categoryLabels[cat] || cat}
                          </span>
                          <div className="space-y-0.5 mt-0.5">
                            {grouped[cat].map((entry) => (
                              <div
                                key={entry.key}
                                className="text-xs text-text-primary truncate pl-2 border-l-2 border-border-muted"
                                title={entry.value}
                              >
                                {entry.value}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {coreEntries.length === 0 && (
                <p className="text-xs text-text-muted italic">{t('memoryLens.noProfile')}</p>
              )}

              {/* Workspace Stats */}
              {workspaceStats && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-text-muted flex items-center gap-1">
                    <FolderOpen className="w-3 h-3" />
                    {workspaceStats.name || t('memoryLens.currentWorkspace')}
                  </span>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="text-sm font-semibold text-text-primary">
                        {workspaceStats.sessionCount}
                      </div>
                      <div className="text-[10px] text-text-muted">{t('memoryLens.sessions')}</div>
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-text-primary">
                        {workspaceStats.chunkCount}
                      </div>
                      <div className="text-[10px] text-text-muted">{t('memoryLens.chunks')}</div>
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-text-primary">
                        {workspaceStats.lastIngestedAt
                          ? formatRelativeTime(workspaceStats.lastIngestedAt)
                          : '—'}
                      </div>
                      <div className="text-[10px] text-text-muted">
                        {t('memoryLens.lastLearned')}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {!workspaceStats && (
                <p className="text-xs text-text-muted italic">{t('memoryLens.noWorkspaceData')}</p>
              )}

              {/* Last Retrieval */}
              {panelState.lastRetrieval && (
                <div className="space-y-1.5 pt-1 border-t border-border-muted">
                  <span className="text-xs font-medium text-text-muted flex items-center gap-1">
                    <Zap className="w-3 h-3" />
                    {t('memoryLens.lastRetrieval')}
                  </span>
                  <div className="space-y-0.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">{t('memoryLens.coreMatched')}</span>
                      <span className="text-text-primary font-medium">
                        {panelState.lastRetrieval.coreMatched}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">{t('memoryLens.chunksRetrieved')}</span>
                      <span className="text-text-primary font-medium">
                        {panelState.lastRetrieval.chunksRetrieved}
                      </span>
                    </div>
                    {panelState.lastRetrieval.chunksExpanded > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-text-muted">{t('memoryLens.expanded')}</span>
                        <span className="text-accent font-medium">
                          {panelState.lastRetrieval.chunksExpanded}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">{t('memoryLens.tokensInjected')}</span>
                      <span className="text-amber-600 font-medium">
                        ~{panelState.lastRetrieval.tokensInjected.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">{t('memoryLens.retrievalTime')}</span>
                      <span className="text-text-muted">
                        {panelState.lastRetrieval.durationMs}ms
                      </span>
                    </div>
                  </div>
                  {panelState.lastRetrieval.sources.length > 0 && (
                    <div className="space-y-0.5 mt-1">
                      <span className="text-[10px] uppercase tracking-wider text-text-muted/70">
                        {t('memoryLens.sources')}
                      </span>
                      {panelState.lastRetrieval.sources.map((source, i) => (
                        <div
                          key={i}
                          className="text-xs text-text-secondary truncate pl-2 border-l-2 border-border-muted"
                          title={source.summary}
                        >
                          {source.expanded && <span className="text-accent mr-1">↳</span>}
                          <span className="text-text-muted">
                            {source.workspace ? source.workspace.split('/').pop() : 'global'}
                          </span>
                          {' — '}
                          {source.summary}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!panelState.lastRetrieval && (
                <p className="text-xs text-text-muted italic pt-1 border-t border-border-muted">
                  {t('memoryLens.noRetrievalYet')}
                </p>
              )}

              {/* Total Stats (compact) */}
              <div className="flex items-center gap-3 text-[10px] text-text-muted pt-1 border-t border-border-muted">
                <span>
                  {t('memoryLens.total')}: {totalStats.sessionCount}{' '}
                  {t('memoryLens.sessions').toLowerCase()} · {totalStats.chunkCount}{' '}
                  {t('memoryLens.chunks').toLowerCase()} · {totalStats.workspaceCount}{' '}
                  {t('memoryLens.workspaces').toLowerCase()}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
