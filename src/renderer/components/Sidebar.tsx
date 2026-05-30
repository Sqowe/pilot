import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Trash2,
  Moon,
  Sun,
  Monitor,
  Settings,
  Search as SearchIcon,
  Plus,
  ListChecks,
  Check,
  Download,
  FolderOpen,
  Clock,
} from 'lucide-react';
import type { Session } from '../types';
import { SearchOverlay } from './SearchOverlay';

import sidebarLogoSrc from '../assets/logo.png';

type SessionGroup = {
  key: string;
  label: string;
  sessions: Session[];
};

type GroupMode = 'date' | 'workspace';

export function Sidebar() {
  const { t } = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);
  const sessionStates = useAppStore((s) => s.sessionStates);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setMessages = useAppStore((s) => s.setMessages);
  const setTraceSteps = useAppStore((s) => s.setTraceSteps);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const {
    deleteSession,
    batchDeleteSessions,
    getSessionMessages,
    getSessionTraceSteps,
    isElectron,
  } = useIPC();
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    try {
      const stored = localStorage.getItem('sidebar-group-mode');
      if (stored === 'workspace' || stored === 'date') return stored;
    } catch {
      // localStorage unavailable
    }
    return 'date';
  });
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('sidebar-collapsed-workspaces');
      if (stored) return new Set(JSON.parse(stored));
    } catch {
      // localStorage unavailable or invalid JSON
    }
    return new Set();
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem('sidebar-width');
      if (stored) {
        const parsed = Number(stored);
        return Number.isFinite(parsed) ? Math.max(200, Math.min(480, parsed)) : 280;
      }
    } catch {
      // localStorage unavailable (privacy mode, sandbox, etc.)
    }
    return 280;
  });
  const isResizingRef = useRef(false);
  const currentWidthRef = useRef(280);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const switchRequestRef = useRef(0);
  const filteredSessions = useMemo(() => {
    return sessions;
  }, [sessions]);

  const groupedSessions = useMemo(
    () =>
      groupMode === 'workspace'
        ? groupSessionsByWorkspace(filteredSessions, t)
        : groupSessionsByDate(filteredSessions, t),
    [filteredSessions, t, groupMode]
  );

  const toggleGroupMode = useCallback(() => {
    const next = groupMode === 'date' ? 'workspace' : 'date';
    setGroupMode(next);
    try {
      localStorage.setItem('sidebar-group-mode', next);
    } catch {
      // localStorage unavailable
    }
  }, [groupMode]);

  const toggleWorkspaceCollapsed = useCallback((key: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      try {
        localStorage.setItem('sidebar-collapsed-workspaces', JSON.stringify([...next]));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }, []);

  // Exit select mode when sidebar collapses
  useEffect(() => {
    if (sidebarCollapsed && isSelectMode) {
      setIsSelectMode(false);
      setSelectedIds(new Set());
      setShowDeleteConfirm(false);
    }
    if (sidebarCollapsed) {
      setDeleteConfirmSessionId(null);
    }
  }, [sidebarCollapsed, isSelectMode]);

  // Escape key exits select mode
  useEffect(() => {
    if (!isSelectMode && !deleteConfirmSessionId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (deleteConfirmSessionId) {
          setDeleteConfirmSessionId(null);
        }
        if (isSelectMode) {
          setIsSelectMode(false);
          setSelectedIds(new Set());
          setShowDeleteConfirm(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectMode, deleteConfirmSessionId]);

  // Cmd+K shortcut to open search overlay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  }, []);

  const toggleSelectSession = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const visibleSessionIds = useMemo(() => filteredSessions.map((s) => s.id), [filteredSessions]);

  const allVisibleSelected =
    visibleSessionIds.length > 0 && visibleSessionIds.every((id) => selectedIds.has(id));

  const toggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      // Deselect all visible, keep others
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      // Select all visible, keep existing selections
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) {
          next.add(id);
        }
        return next;
      });
    }
  }, [allVisibleSelected, visibleSessionIds]);

  const handleBatchDelete = useCallback(() => {
    const visibleSet = new Set(visibleSessionIds);
    const ids = Array.from(selectedIds).filter((id) => visibleSet.has(id));
    if (ids.length === 0) return;
    batchDeleteSessions(ids);
    exitSelectMode();
  }, [selectedIds, visibleSessionIds, batchDeleteSessions, exitSelectMode]);

  const handleSessionClick = useCallback(
    async (sessionId: string) => {
      setShowSettings(false);

      if (activeSessionId === sessionId) {
        // User re-clicked the current session — cancel any pending switch
        switchRequestRef.current++;
        return;
      }

      // Guard against rapid clicks: only the latest selection wins
      const requestId = ++switchRequestRef.current;

      // Load messages BEFORE activating the session so ChatView has data on first render
      const existingMessages = sessionStates[sessionId]?.messages;
      if ((!existingMessages || existingMessages.length === 0) && isElectron) {
        try {
          const messages = await getSessionMessages(sessionId);
          if (switchRequestRef.current !== requestId) return; // Stale request, abort
          if (messages && messages.length > 0) {
            setMessages(sessionId, messages);
          }
        } catch (error) {
          console.error('[Sidebar] Failed to load messages:', error);
        }
      }

      if (switchRequestRef.current !== requestId) return; // Stale request, abort

      const existingSteps = sessionStates[sessionId]?.traceSteps;
      if ((!existingSteps || existingSteps.length === 0) && isElectron) {
        try {
          const steps = await getSessionTraceSteps(sessionId);
          if (switchRequestRef.current !== requestId) return; // Stale request, abort
          setTraceSteps(sessionId, steps || []);
        } catch (error) {
          console.error('[Sidebar] Failed to load trace steps:', error);
        }
      }

      if (switchRequestRef.current !== requestId) return; // Stale request, abort

      // Activate session AFTER data is loaded so ChatView renders with messages immediately
      setActiveSession(sessionId);
    },
    [
      activeSessionId,
      getSessionMessages,
      getSessionTraceSteps,
      isElectron,
      sessionStates,
      setActiveSession,
      setMessages,
      setShowSettings,
      setTraceSteps,
    ]
  );

  const handleNewSession = () => {
    setActiveSession(null);
    setShowSettings(false);
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setDeleteConfirmSessionId(sessionId);
  };

  const confirmDeleteSession = () => {
    if (deleteConfirmSessionId) {
      deleteSession(deleteConfirmSessionId);
      setDeleteConfirmSessionId(null);
    }
  };

  const cancelDeleteSession = () => {
    setDeleteConfirmSessionId(null);
  };

  const handleExportSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      const result = await window.electronAPI.chat.exportMarkdown({ sessionId });
      if (result.success && result.path) {
        setGlobalNotice({
          id: `chat-export-${Date.now()}`,
          type: 'info',
          message: t('chat.exportSuccess'),
        });
      } else if (result.error && result.error !== 'Export cancelled') {
        setGlobalNotice({
          id: `chat-export-error-${Date.now()}`,
          type: 'warning',
          message: t('chat.exportFailed', { error: result.error }),
        });
      }
    } catch (error) {
      console.error('[Sidebar] Export failed:', error);
    }
  };

  const toggleTheme = () => {
    const next =
      settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark';
    updateSettings({ theme: next });
  };

  const themeIcon =
    settings.theme === 'dark' ? (
      <Sun className="w-4 h-4" />
    ) : settings.theme === 'light' ? (
      <Moon className="w-4 h-4" />
    ) : (
      <Monitor className="w-4 h-4" />
    );

  const handleSearchSelectSession = useCallback(
    (sessionId: string) => {
      handleSessionClick(sessionId);
    },
    [handleSessionClick]
  );

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      // Guard against re-entrant drags
      if (isResizingRef.current) return;

      e.preventDefault();
      isResizingRef.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      currentWidthRef.current = startWidth;

      // Capture pointer for reliable tracking even outside window
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const newWidth = Math.max(200, Math.min(480, startWidth + (moveEvent.clientX - startX)));
        currentWidthRef.current = newWidth;
        setSidebarWidth(newWidth);
      };

      const cleanup = () => {
        if (!isResizingRef.current) return; // Idempotent
        isResizingRef.current = false;
        try {
          if (target.hasPointerCapture(e.pointerId)) {
            target.releasePointerCapture(e.pointerId);
          }
        } catch {
          // Pointer capture already released or element detached — safe to ignore
        }
        target.removeEventListener('pointermove', handlePointerMove);
        target.removeEventListener('pointerup', handlePointerUp);
        target.removeEventListener('lostpointercapture', handlePointerUp);
        window.removeEventListener('blur', cleanup);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragCleanupRef.current = null;
        // Persist final width
        try {
          localStorage.setItem('sidebar-width', String(currentWidthRef.current));
        } catch {
          // localStorage unavailable — ignore
        }
      };

      const handlePointerUp = () => {
        cleanup();
      };

      dragCleanupRef.current = cleanup;
      target.addEventListener('pointermove', handlePointerMove);
      target.addEventListener('pointerup', handlePointerUp);
      target.addEventListener('lostpointercapture', handlePointerUp);
      window.addEventListener('blur', cleanup);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [sidebarWidth]
  );

  // Cleanup drag listeners on unmount to prevent leaks
  useEffect(() => {
    return () => {
      if (dragCleanupRef.current) {
        dragCleanupRef.current();
      }
    };
  }, []);

  if (sidebarCollapsed) {
    return (
      <>
        <aside className="w-[4.5rem] bg-surface/96 border-r border-border-muted flex flex-col overflow-hidden">
          <div className="px-3 pt-4 pb-3 flex flex-col items-center gap-2 border-b border-border-muted">
            <button
              onClick={toggleSidebar}
              className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
              title={t('context.expandPanel')}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={handleNewSession}
              className="w-9 h-9 rounded-2xl flex items-center justify-center bg-background hover:bg-surface-hover transition-colors text-text-primary border border-border-subtle"
              title={t('sidebar.newTask')}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center px-3 py-4">
            <button
              onClick={toggleSidebar}
              className="rounded-2xl px-2 py-3 text-[11px] leading-4 text-center text-text-muted hover:bg-surface-hover transition-colors"
              title={t('sidebar.expandToView')}
            >
              {t('sidebar.expandToView')}
            </button>
          </div>

          <div className="px-3 py-3 border-t border-border-muted flex flex-col items-center gap-2">
            <button
              onClick={toggleTheme}
              className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
              title={t('sidebar.themeToggle')}
            >
              {themeIcon}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary relative"
              title={t('sidebar.settings')}
            >
              <Settings className="w-4 h-4" />
              {!isConfigured && (
                <span className="absolute right-2 top-2 w-1.5 h-1.5 rounded-full bg-accent" />
              )}
            </button>
          </div>
        </aside>
        <SearchOverlay
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
          onSelectSession={handleSearchSelectSession}
        />
      </>
    );
  }

  return (
    <>
      <aside
        className="bg-surface/96 border-r border-border-muted flex flex-col overflow-hidden relative"
        style={{ width: `${sidebarWidth}px` }}
      >
        {/* Resize handle */}
        <div
          onPointerDown={handleResizeStart}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/30 transition-colors z-10 touch-none"
        />
        <div className="px-4 pt-5 pb-4 border-b border-border-muted">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex items-center gap-3">
              <img
                src={sidebarLogoSrc}
                alt={t('common.appLogoAlt')}
                className="w-10 h-10 rounded-2xl object-cover border border-border-subtle bg-background/60 flex-shrink-0"
              />
              <div className="min-w-0">
                <h1 className="text-[1.34rem] leading-none font-semibold tracking-[-0.035em] text-text-primary">
                  Sqowe Pilot
                </h1>
              </div>
            </div>
            <button
              onClick={toggleSidebar}
              className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary flex-shrink-0"
              title={t('context.collapsePanel')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={handleNewSession}
            className="mt-3 w-full flex items-center gap-2 rounded-xl bg-background/60 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
          >
            <Plus className="w-4 h-4 text-text-secondary flex-shrink-0" />
            <span className="text-[13px] font-medium">{t('sidebar.newTask')}</span>
          </button>

          {sessions.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => setIsSearchOpen(true)}
                className="relative flex-1 min-w-0 flex items-center gap-2 rounded-xl border border-transparent bg-background/50 px-3 py-2 text-[13px] text-text-muted hover:border-border hover:bg-background transition-colors"
              >
                <SearchIcon className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t('sidebar.search')}</span>
                <kbd className="ml-auto text-[10px] font-mono opacity-60">⌘K</kbd>
              </button>
              <button
                onClick={toggleGroupMode}
                className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
                  groupMode === 'workspace'
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
                title={
                  groupMode === 'workspace'
                    ? t('sidebar.groupByDate')
                    : t('sidebar.groupByWorkspace')
                }
              >
                {groupMode === 'workspace' ? (
                  <FolderOpen className="w-3.5 h-3.5" />
                ) : (
                  <Clock className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                onClick={() => {
                  if (isSelectMode) {
                    exitSelectMode();
                  } else {
                    setIsSelectMode(true);
                  }
                }}
                className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
                  isSelectMode
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
                title={t('sidebar.manage')}
              >
                <ListChecks className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          {groupedSessions.length === 0 ? (
            <div className="px-3 py-6">
              <p className="text-sm text-text-secondary">{t('sidebar.noTasks')}</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{t('sidebar.noTasksHint')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {groupedSessions.map((group) => (
                <section key={group.key}>
                  {groupMode === 'workspace' ? (
                    <button
                      onClick={() => toggleWorkspaceCollapsed(group.key)}
                      className="w-full flex items-center gap-1.5 px-3 pb-2 text-[11px] font-medium tracking-[0.04em] text-text-muted hover:text-text-secondary transition-colors"
                      aria-expanded={!collapsedWorkspaces.has(group.key)}
                    >
                      <ChevronDown
                        className={`w-3 h-3 flex-shrink-0 transition-transform ${
                          collapsedWorkspaces.has(group.key) ? '-rotate-90' : ''
                        }`}
                      />
                      <span className="truncate">{group.label}</span>
                      <span className="ml-auto text-[10px] opacity-60 flex-shrink-0">
                        {group.sessions.length}
                      </span>
                    </button>
                  ) : (
                    <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                      {group.label}
                    </div>
                  )}
                  {!(groupMode === 'workspace' && collapsedWorkspaces.has(group.key)) && (
                    <div className="space-y-0.5">
                      {group.sessions.map((session) => {
                        const isActive = activeSessionId === session.id;
                        const isSelected = selectedIds.has(session.id);
                        const isConfirmingDelete = deleteConfirmSessionId === session.id;
                        return (
                          <div
                            key={session.id}
                            onClick={() => {
                              if (isConfirmingDelete) return;
                              if (isSelectMode) {
                                toggleSelectSession(session.id);
                              } else {
                                handleSessionClick(session.id);
                              }
                            }}
                            onMouseEnter={() => setHoveredSession(session.id)}
                            onMouseLeave={() => setHoveredSession(null)}
                            className={`group relative cursor-pointer rounded-lg px-2.5 py-1.5 transition-colors ${
                              isConfirmingDelete
                                ? 'bg-error/5 border border-error/30'
                                : isSelectMode && isSelected
                                  ? 'bg-accent-muted/20'
                                  : isActive && !isSelectMode
                                    ? 'bg-surface-hover/80'
                                    : 'hover:bg-surface-hover/60'
                            }`}
                          >
                            {isConfirmingDelete ? (
                              <div className="py-1">
                                <p className="text-[12px] text-text-primary mb-2 leading-4">
                                  {t('sidebar.singleDeleteConfirm', { title: session.title })}
                                </p>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      cancelDeleteSession();
                                    }}
                                    className="flex-1 px-2 py-1 rounded-lg text-[12px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                                  >
                                    {t('sidebar.cancel')}
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      confirmDeleteSession();
                                    }}
                                    className="flex-1 px-2 py-1 rounded-lg text-[12px] font-medium bg-error text-white hover:bg-error/90 transition-colors"
                                  >
                                    {t('sidebar.confirmDelete')}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div
                                  className={`flex items-center gap-2 ${!isSelectMode ? 'pr-6' : ''}`}
                                >
                                  {isSelectMode && (
                                    <div
                                      className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                                        isSelected
                                          ? 'bg-accent text-white'
                                          : 'border border-border-muted bg-background'
                                      }`}
                                    >
                                      {isSelected && <Check className="w-2.5 h-2.5" />}
                                    </div>
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <div
                                      className="text-[13px] font-medium leading-5 text-text-primary truncate"
                                      title={session.title}
                                    >
                                      {session.title}
                                    </div>
                                  </div>
                                </div>

                                {!isSelectMode && hoveredSession === session.id && (
                                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                                    <button
                                      onClick={(e) => handleExportSession(e, session.id)}
                                      className="w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-accent hover:bg-surface-active transition-colors"
                                      title={t('chat.exportMarkdown')}
                                    >
                                      <Download className="w-3 h-3" />
                                    </button>
                                    <button
                                      onClick={(e) => handleDeleteSession(e, session.id)}
                                      className="w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-error hover:bg-surface-active transition-colors"
                                      title={t('common.delete')}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>

        {isSelectMode ? (
          <div className="px-3 py-3 border-t border-border-muted">
            {showDeleteConfirm ? (
              <div className="border border-error/30 bg-error/10 rounded-lg px-3 py-3">
                <p className="text-[13px] text-text-primary mb-3">
                  {t('sidebar.batchDeleteConfirm', { count: selectedIds.size })}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                  >
                    {t('sidebar.cancel')}
                  </button>
                  <button
                    onClick={handleBatchDelete}
                    className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors"
                  >
                    {t('sidebar.confirmDelete')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <button
                    onClick={toggleSelectAll}
                    className="text-[12px] font-medium text-accent hover:text-accent/80 transition-colors"
                  >
                    {allVisibleSelected ? t('sidebar.deselectAll') : t('sidebar.selectAll')}
                  </button>
                  <span className="text-[12px] text-text-muted">
                    {t('sidebar.nSelected', { count: selectedIds.size })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={exitSelectMode}
                    className="flex-1 px-3 py-2 rounded-xl text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                  >
                    {t('sidebar.cancel')}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={selectedIds.size === 0}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 py-3 border-t border-border-muted">
            <div className="flex items-center gap-2 rounded-2xl bg-background/50 px-3 py-2.5">
              <button
                onClick={() => setShowSettings(true)}
                className="flex-1 min-w-0 flex items-center gap-2 text-left text-text-secondary hover:text-text-primary transition-colors"
              >
                <Settings className="w-4 h-4 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-text-primary">
                    {t('sidebar.settings')}
                  </div>
                  <div className="text-[11px] text-text-muted truncate">
                    {isConfigured ? t('sidebar.apiConfigured') : t('sidebar.apiNotConfigured')}
                  </div>
                </div>
              </button>

              <button
                onClick={toggleTheme}
                className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
                title={t('sidebar.themeToggle')}
              >
                {themeIcon}
              </button>
            </div>
          </div>
        )}
      </aside>
      <SearchOverlay
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectSession={handleSearchSelectSession}
      />
    </>
  );
}

function groupSessionsByDate(sessions: Session[], t: (key: string) => string): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfPreviousWeek = startOfToday - 7 * 86_400_000;

  const buckets: SessionGroup[] = [
    { key: 'today', label: t('sidebar.today'), sessions: [] },
    { key: 'yesterday', label: t('sidebar.yesterday'), sessions: [] },
    { key: 'previousWeek', label: t('sidebar.previousWeek'), sessions: [] },
    { key: 'older', label: t('sidebar.older'), sessions: [] },
  ];

  const sortedSessions = [...sessions].sort(
    (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
  );
  for (const session of sortedSessions) {
    const timestamp = session.updatedAt || session.createdAt;
    if (timestamp >= startOfToday) {
      buckets[0].sessions.push(session);
    } else if (timestamp >= startOfYesterday) {
      buckets[1].sessions.push(session);
    } else if (timestamp >= startOfPreviousWeek) {
      buckets[2].sessions.push(session);
    } else {
      buckets[3].sessions.push(session);
    }
  }

  return buckets.filter((bucket) => bucket.sessions.length > 0);
}

function groupSessionsByWorkspace(sessions: Session[], t: (key: string) => string): SessionGroup[] {
  const workspaceMap = new Map<string, { label: string; sessions: Session[] }>();

  const sortedSessions = [...sessions].sort(
    (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
  );

  for (const session of sortedSessions) {
    const cwd = session.cwd;
    const key = cwd || '__ungrouped__';
    const label = cwd ? cwd.split('/').filter(Boolean).pop() || cwd : t('sidebar.ungrouped');

    if (!workspaceMap.has(key)) {
      workspaceMap.set(key, { label, sessions: [] });
    }
    workspaceMap.get(key)!.sessions.push(session);
  }

  // Convert to array and sort workspace groups by their most recent session
  const groups: SessionGroup[] = [];
  for (const [key, { label, sessions: groupSessions }] of workspaceMap) {
    groups.push({ key, label, sessions: groupSessions });
  }

  // Sort by the most recent session timestamp in each group (already sorted within)
  groups.sort((a, b) => {
    const aLatest = a.sessions[0]?.updatedAt || a.sessions[0]?.createdAt || 0;
    const bLatest = b.sessions[0]?.updatedAt || b.sessions[0]?.createdAt || 0;
    return bLatest - aLatest;
  });

  return groups;
}
