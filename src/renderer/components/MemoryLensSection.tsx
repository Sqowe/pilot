import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Brain, FolderOpen, Database, Zap, X } from 'lucide-react';
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
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState(false);
  const isSaving = useRef(false);
  const isCancelling = useRef(false);
  const [panelState, setPanelState] = useState<MemoryPanelState | null>(null);
  const [error, setError] = useState(false);
  const [expandedSource, setExpandedSource] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  // Watch for message count changes to trigger a refresh after each turn
  const sessionStates = useAppStore((s) => s.sessionStates);
  const messageCount = sessionId ? (sessionStates[sessionId]?.traceSteps?.length ?? 0) : 0;

  const load = useCallback(async () => {
    try {
      const state = await window.electronAPI.memory.getPanelState(cwd, sessionId);
      return state;
    } catch {
      return null;
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    if (collapsed) return;

    let cancelled = false;

    const doLoad = async () => {
      const state = await load();
      if (cancelled) return;
      if (state) {
        setPanelState(state);
        setError(false);
      } else {
        setError(true);
      }
    };
    doLoad();

    // Refresh every 30s while visible
    const interval = setInterval(async () => {
      const state = await load();
      if (cancelled) return;
      if (state) {
        setPanelState(state);
        setError(false);
      }
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cwd, collapsed, messageCount, sessionId, refreshKey, load]);

  const handleDeleteEntry = async (combinedKey: string) => {
    try {
      await window.electronAPI.memory.deleteCoreEntry(combinedKey);
      setRefreshKey((k) => k + 1);
    } catch {
      // Silently fail — panel will show stale data until next refresh
    }
  };

  const handleStartEdit = (combinedKey: string, currentValue: string) => {
    setEditingKey(combinedKey);
    setEditValue(currentValue);
    setEditError(false);
  };

  const handleSaveEdit = async () => {
    if (!editingKey || isSaving.current || isCancelling.current) return;
    const trimmed = editValue.trim();
    if (!trimmed) {
      setEditingKey(null);
      setEditError(false);
      return;
    }
    isSaving.current = true;
    try {
      const result = await window.electronAPI.memory.updateCoreEntry(editingKey, trimmed);
      if (result.success) {
        setEditingKey(null);
        setEditError(false);
        setRefreshKey((k) => k + 1);
      } else {
        setEditError(true);
      }
    } catch {
      setEditError(true);
    } finally {
      isSaving.current = false;
    }
  };

  const handleCancelEdit = () => {
    isCancelling.current = true;
    setEditingKey(null);
    setEditError(false);
    // Reset flag after React processes the state update
    setTimeout(() => {
      isCancelling.current = false;
    }, 0);
  };

  if (collapsed || panelState === null) return null;

  const { enabled, skillFallbackEnabled, coreEntries, workspaceStats, totalStats } = panelState;

  // Group core entries by category (preserve combinedKey for delete)
  const grouped = coreEntries.reduce<
    Record<string, Array<{ key: string; value: string; combinedKey: string }>>
  >((acc, entry) => {
    const cat = entry.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push({ key: entry.key, value: entry.value, combinedKey: entry.combinedKey });
    return acc;
  }, {});

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
                                key={entry.combinedKey}
                                className="group flex items-center gap-1 text-xs text-text-primary pl-2 border-l-2 border-border-muted"
                              >
                                {editingKey === entry.combinedKey ? (
                                  <input
                                    type="text"
                                    value={editValue}
                                    onChange={(e) => {
                                      setEditValue(e.target.value);
                                      setEditError(false);
                                    }}
                                    onBlur={() => {
                                      if (!isSaving.current) handleSaveEdit();
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.currentTarget.blur();
                                      }
                                      if (e.key === 'Escape') handleCancelEdit();
                                    }}
                                    autoFocus
                                    className={`flex-1 text-xs bg-surface-muted border rounded px-1 py-0.5 outline-none focus:border-accent ${
                                      editError ? 'border-red-400' : 'border-border-muted'
                                    }`}
                                  />
                                ) : (
                                  <span
                                    className="truncate flex-1 cursor-pointer hover:text-accent transition-colors"
                                    title={`${entry.value}\n\n${t('memoryLens.clickToEdit')}`}
                                    onClick={() => handleStartEdit(entry.combinedKey, entry.value)}
                                  >
                                    {entry.value}
                                  </span>
                                )}
                                {editingKey !== entry.combinedKey && (
                                  <button
                                    onClick={() => handleDeleteEntry(entry.combinedKey)}
                                    className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-500 transition-all shrink-0"
                                    aria-label={`${t('memoryLens.deleteEntry')}: ${entry.value}`}
                                    title={t('memoryLens.deleteEntry')}
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                )}
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
                        <div key={i}>
                          <button
                            onClick={() => setExpandedSource(expandedSource === i ? null : i)}
                            className="w-full text-left text-xs text-text-secondary pl-2 border-l-2 border-border-muted hover:bg-surface-hover rounded-r-sm transition-colors py-0.5"
                            title={
                              expandedSource === i
                                ? t('memoryLens.collapse')
                                : t('memoryLens.expandSource')
                            }
                          >
                            {source.expanded && <span className="text-accent mr-1">↳</span>}
                            <span className="text-text-muted">
                              {source.workspace ? source.workspace.split('/').pop() : 'global'}
                            </span>
                            {' — '}
                            <span
                              className={
                                expandedSource === i
                                  ? ''
                                  : 'truncate inline-block max-w-[160px] align-bottom'
                              }
                            >
                              {source.summary}
                            </span>
                          </button>
                          {expandedSource === i && (
                            <div className="text-xs text-text-secondary pl-4 py-1 bg-surface-muted/50 rounded-sm mt-0.5 whitespace-pre-wrap break-words">
                              {source.summary}
                            </div>
                          )}
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

              {/* Total Stats + View All */}
              <div className="flex items-center justify-between text-[10px] text-text-muted pt-1 border-t border-border-muted">
                <span>
                  {t('memoryLens.total')}: {totalStats.sessionCount}{' '}
                  {t('memoryLens.sessions').toLowerCase()} · {totalStats.chunkCount}{' '}
                  {t('memoryLens.chunks').toLowerCase()} · {totalStats.workspaceCount}{' '}
                  {t('memoryLens.workspaces').toLowerCase()}
                </span>
                <button
                  onClick={() => {
                    setSettingsTab('memory');
                    setShowSettings(true);
                  }}
                  className="text-[10px] text-accent hover:underline"
                >
                  {t('memoryLens.viewAll')}
                </button>
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
