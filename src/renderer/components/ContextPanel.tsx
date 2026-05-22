import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { resolveArtifactPath } from '../utils/artifact-path';
import { MAX_PINNED_SKILLS_PER_SESSION } from '../../shared/skill-pinning-constants';
import {
  extractFilePathFromToolInput,
  extractFilePathFromToolOutput,
} from '../utils/tool-output-path';
import {
  getArtifactLabel,
  getArtifactIconComponent,
  getArtifactSteps,
} from '../utils/artifact-steps';
import { useIPC } from '../hooks/useIPC';
import { MemoryLensSection } from './MemoryLensSection';
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileSpreadsheet,
  FilePieChart,
  FileCode2,
  FileArchive,
  FileAudio2,
  FileVideo,
  Image as ImageIcon,
  FolderOpen,
  FolderSync,
  File,
  Check,
  Loader2,
  Plug,
  Wrench,
  MessageSquare,
  Cpu,
  Copy,
  Layers,
  Star,
  X,
} from 'lucide-react';
import type { TraceStep, MCPServerInfo } from '../types';
import { computeContextUsage } from '../utils/context-usage';

const EMPTY_STEPS: TraceStep[] = [];

export function ContextPanel() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const sessionStates = useAppStore((s) => s.sessionStates);
  const appConfig = useAppStore((s) => s.appConfig);
  const contextPanelCollapsed = useAppStore((s) => s.contextPanelCollapsed);
  const toggleContextPanel = useAppStore((s) => s.toggleContextPanel);
  const workingDir = useAppStore((s) => s.workingDir);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const skillsStorageChangedAt = useAppStore((s) => s.skillsStorageChangedAt);
  const { getMCPServers, changeWorkingDir } = useIPC();
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const [pinnedSkillsOpen, setPinnedSkillsOpen] = useState(true);
  const [mcpConnectorsOpen, setMcpConnectorsOpen] = useState(true);
  const [expandedConnector, setExpandedConnector] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([]);
  const [sessionDisabledServers, setSessionDisabledServers] = useState<Set<string>>(new Set());
  const [sessionPinnedSkills, setSessionPinnedSkills] = useState<Set<string>>(new Set());
  const [availableSkills, setAvailableSkills] = useState<
    Array<{ id: string; name: string; description?: string }>
  >([]);
  const [copiedPath, setCopiedPath] = useState(false);
  const [isChangingDir, setIsChangingDir] = useState(false);
  const [recentWorkspaceFiles, setRecentWorkspaceFiles] = useState<
    Array<{
      path: string;
      modifiedAt: number;
      size: number;
    }>
  >([]);

  const handleCopyPath = async (path: string) => {
    try {
      // Escape spaces for shell usage so the path can be pasted into terminal
      let shellPath = path;
      if (path.includes(' ')) {
        const isWindows = window.electronAPI?.platform === 'win32';
        shellPath = isWindows ? `"${path}"` : path.replace(/ /g, '\\ ');
      }
      await window.electronAPI.clipboard.writeText(shellPath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  const ss = activeSessionId ? sessionStates[activeSessionId] : undefined;
  const steps = ss?.traceSteps ?? EMPTY_STEPS;
  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null;
  const currentWorkingDir = activeSession?.cwd || workingDir;
  const { displayArtifactSteps } = getArtifactSteps(steps);
  const canShowItemInFolder =
    typeof window !== 'undefined' && !!window.electronAPI?.showItemInFolder;

  // Session info computations
  const messages = useMemo(
    () => (activeSessionId ? sessionStates[activeSessionId]?.messages || [] : []),
    [activeSessionId, sessionStates]
  );
  const messageCount = messages.length;
  const toolCallCount = steps.filter((s) => s.type === 'tool_call').length;
  const modelName = activeSession?.model || appConfig?.model || '—';

  // Token usage aggregation
  const tokenUsage = useMemo(() => {
    let input = 0;
    let output = 0;
    for (const msg of messages) {
      if (msg.tokenUsage) {
        input += msg.tokenUsage.input || 0;
        output += msg.tokenUsage.output || 0;
      }
    }
    return { input, output, total: input + output };
  }, [messages]);

  // Context usage: effective budget including tool schemas + output reservation
  // Uses live currentInputTokens from _onPayload when available (updates during
  // tool loop), falls back to last message's tokenUsage.input for initial state.
  const contextUsage = useMemo(() => {
    const sessionState = activeSessionId ? sessionStates[activeSessionId] : undefined;
    const contextWindow = sessionState?.contextWindow;
    if (!contextWindow) return null;

    const toolSchemaTokens = sessionState?.toolSchemaTokens ?? 0;
    const maxOutputTokens = sessionState?.maxOutputTokens ?? 0;
    const currentInputTokens = sessionState?.currentInputTokens ?? 0;

    // Find last reported input tokens from assistant messages (fallback)
    let lastMessageInputTokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].tokenUsage?.input) {
        lastMessageInputTokens = messages[i].tokenUsage!.input;
        break;
      }
    }

    return computeContextUsage({
      contextWindow,
      toolSchemaTokens,
      maxOutputTokens,
      currentInputTokens,
      lastMessageInputTokens,
    });
  }, [activeSessionId, sessionStates, messages]);

  const completedStepCount = useMemo(
    () => steps.reduce((n, s) => n + (s.status === 'completed' ? 1 : 0), 0),
    [steps]
  );

  useEffect(() => {
    if (contextPanelCollapsed) {
      return;
    }
    if (
      typeof window === 'undefined' ||
      !window.electronAPI?.artifacts?.listRecentFiles ||
      !currentWorkingDir ||
      !activeSession?.createdAt
    ) {
      setRecentWorkspaceFiles([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const files = await window.electronAPI.artifacts.listRecentFiles(
          currentWorkingDir,
          activeSession.createdAt,
          50
        );
        if (!cancelled) {
          setRecentWorkspaceFiles(files || []);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load recent workspace files:', error);
          setRecentWorkspaceFiles([]);
        }
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    activeSession?.createdAt,
    activeSessionId,
    steps.length,
    completedStepCount,
    contextPanelCollapsed,
    currentWorkingDir,
  ]);

  const displayArtifacts = useMemo(() => {
    const seenPaths = new Set<string>();
    const items: Array<{ label: string; path: string }> = [];

    for (const step of displayArtifactSteps) {
      const fallbackPath =
        extractFilePathFromToolOutput(step.toolOutput) ||
        extractFilePathFromToolInput(step.toolInput);
      if (!fallbackPath) {
        continue;
      }

      const resolvedPath = resolveArtifactPath(fallbackPath, currentWorkingDir);
      const key = resolvedPath.trim();
      if (!key || seenPaths.has(key)) {
        continue;
      }

      seenPaths.add(key);
      items.push({
        label: getArtifactLabel(fallbackPath),
        path: resolvedPath,
      });
    }

    for (const file of recentWorkspaceFiles) {
      const resolvedPath = resolveArtifactPath(file.path, currentWorkingDir);
      const key = resolvedPath.trim();
      if (!key || seenPaths.has(key)) {
        continue;
      }

      seenPaths.add(key);
      items.push({
        label: getArtifactLabel(file.path),
        path: resolvedPath,
      });
    }

    return items;
  }, [currentWorkingDir, displayArtifactSteps, recentWorkspaceFiles]);

  useEffect(() => {
    if (contextPanelCollapsed) {
      return;
    }
    const loadMCPServers = async () => {
      try {
        const servers = await getMCPServers();
        setMcpServers(servers || []);
      } catch (error) {
        console.error('Failed to load MCP servers:', error);
      }
    };
    loadMCPServers();
    const interval = setInterval(loadMCPServers, 30000);
    return () => clearInterval(interval);
  }, [contextPanelCollapsed, getMCPServers]);

  // Load session-disabled MCP servers when active session changes
  useEffect(() => {
    if (!activeSessionId || contextPanelCollapsed) {
      setSessionDisabledServers(new Set());
      return;
    }
    const loadDisabled = async () => {
      try {
        const disabled = await window.electronAPI?.mcp?.getSessionDisabledServers(activeSessionId);
        setSessionDisabledServers(new Set(disabled || []));
      } catch (error) {
        console.error('Failed to load session disabled servers:', error);
      }
    };
    loadDisabled();
  }, [activeSessionId, contextPanelCollapsed]);

  // Load session-pinned skills and available skills when active session changes
  useEffect(() => {
    if (!activeSessionId || contextPanelCollapsed) {
      setSessionPinnedSkills(new Set());
      return;
    }
    const loadPinnedSkills = async () => {
      try {
        const pinned = await window.electronAPI?.skills?.getSessionPinnedSkills(activeSessionId);
        setSessionPinnedSkills(new Set(pinned || []));
      } catch (error) {
        console.error('Failed to load session pinned skills:', error);
      }
    };
    const loadAvailableSkills = async () => {
      try {
        const skills = await window.electronAPI?.skills?.getAll();
        setAvailableSkills(
          (skills || [])
            .filter((s) => s.enabled)
            .map((s) => ({ id: s.id, name: s.name, description: s.description }))
        );
      } catch (error) {
        console.error('Failed to load available skills:', error);
      }
    };
    loadPinnedSkills();
    loadAvailableSkills();
  }, [activeSessionId, contextPanelCollapsed, skillsStorageChangedAt]);

  const handleToggleSessionServer = async (serverId: string, disabled: boolean) => {
    if (!activeSessionId) return;
    try {
      const result = await window.electronAPI?.mcp?.toggleSessionServer(
        activeSessionId,
        serverId,
        disabled
      );
      if (result?.success && result.disabledServers) {
        setSessionDisabledServers(new Set(result.disabledServers));
      }
    } catch (error) {
      console.error('Failed to toggle session MCP server:', error);
    }
  };

  const handleToggleSessionPinnedSkill = async (skillId: string, pinned: boolean) => {
    if (!activeSessionId) return;
    try {
      const result = await window.electronAPI?.skills?.toggleSessionPin(
        activeSessionId,
        skillId,
        pinned
      );
      if (result?.success && result.pinnedSkills) {
        setSessionPinnedSkills(new Set(result.pinnedSkills));
      }
    } catch (error) {
      console.error('Failed to toggle session pinned skill:', error);
    }
  };

  if (contextPanelCollapsed) {
    return (
      <div className="w-10 bg-background border-l border-border-muted flex items-start justify-center pt-3">
        <button
          onClick={toggleContextPanel}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.expandPanel')}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-72 bg-background border-l border-border-muted flex flex-col overflow-hidden text-sm">
      {/* Header */}
      <div className="px-3 h-10 flex items-center gap-2 border-b border-border-muted shrink-0">
        <button
          onClick={toggleContextPanel}
          className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.collapsePanel')}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
          {t('context.context')}
        </span>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Session Stats */}
        {activeSession && (
          <div className="px-4 py-3 border-b border-border-muted space-y-1.5">
            <div className="flex items-center gap-1.5 text-text-primary font-medium">
              <Cpu className="w-3.5 h-3.5 text-text-muted shrink-0" />
              <span className="truncate">{modelName}</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-text-muted pl-5">
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                {messageCount}
              </span>
              <span className="flex items-center gap-1">
                <Wrench className="w-3 h-3" />
                {toolCallCount}
              </span>
              {tokenUsage.total > 0 && (
                <span className="ml-auto text-text-muted/70">
                  {t('context.inputTokens')} {formatTokenCount(tokenUsage.input)} ·{' '}
                  {t('context.outputTokens')} {formatTokenCount(tokenUsage.output)}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Context Usage */}
        {activeSession && contextUsage && (
          <div className="px-4 py-2.5 border-b border-border-muted space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                {t('context.contextUsage')}
              </span>
              <span
                className={`text-xs font-medium ${
                  contextUsage.percentage > 75
                    ? 'text-error'
                    : contextUsage.percentage > 50
                      ? 'text-warning'
                      : 'text-text-primary'
                }`}
              >
                {Math.round(contextUsage.percentage)}%
              </span>
            </div>
            <div className="h-1.5 bg-surface-muted rounded-full overflow-hidden flex">
              {contextUsage.percentage > 50 ? (
                /* Warning/Critical: single-color bar */
                <div
                  className={`h-full rounded-full transition-all duration-500 ease-out ${
                    contextUsage.percentage > 75 ? 'bg-error' : 'bg-warning'
                  }`}
                  style={{ width: `${contextUsage.percentage}%` }}
                />
              ) : (
                /* Normal: stacked segments */
                <>
                  {contextUsage.convPercentage > 0 && (
                    <div
                      className="h-full bg-accent transition-all duration-500 ease-out first:rounded-l-full"
                      style={{ width: `${contextUsage.convPercentage}%` }}
                    />
                  )}
                  {contextUsage.toolPercentage > 0 && (
                    <div
                      className="h-full bg-gray-400/60 transition-all duration-500 ease-out"
                      style={{ width: `${contextUsage.toolPercentage}%` }}
                    />
                  )}
                  {contextUsage.outputPercentage > 0 && (
                    <div
                      className="h-full bg-purple-400/60 transition-all duration-500 ease-out last:rounded-r-full"
                      style={{ width: `${contextUsage.outputPercentage}%` }}
                    />
                  )}
                </>
              )}
            </div>
            <p className="text-xs text-text-muted">
              <span className="text-accent">{formatTokenCount(contextUsage.conversation)}</span>
              {contextUsage.toolSchemaTokens > 0 && (
                <>
                  {' + '}
                  <span className="text-gray-400">
                    {t('context.contextUsageTools', {
                      count: formatTokenCount(contextUsage.toolSchemaTokens),
                    })}
                  </span>
                </>
              )}
              {contextUsage.maxOutputTokens > 0 && (
                <>
                  {' + '}
                  <span className="text-purple-400">
                    {t('context.contextUsageOutput', {
                      count: formatTokenCount(contextUsage.maxOutputTokens),
                    })}
                  </span>
                </>
              )}
              {' / '}
              <span>{formatTokenCount(contextUsage.total)}</span>
            </p>
          </div>
        )}

        {/* Memory Lens */}
        <MemoryLensSection
          cwd={currentWorkingDir || undefined}
          collapsed={contextPanelCollapsed}
          sessionId={activeSessionId || undefined}
        />

        {/* Artifacts Section */}
        <div className="border-b border-border-muted">
          <button
            onClick={() => setArtifactsOpen(!artifactsOpen)}
            className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover transition-colors"
          >
            <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
              {t('context.artifacts')}
            </span>
            {artifactsOpen ? (
              <ChevronUp className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            )}
          </button>

          {artifactsOpen && (
            <div className="pb-2 max-h-64 overflow-y-auto">
              {displayArtifacts.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-2 text-xs text-text-muted">
                  <Layers className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('context.noArtifactsYet')}</span>
                </div>
              ) : (
                <div>
                  {displayArtifacts.map((artifact, index) => {
                    const label = artifact.label || t('context.fileCreated');
                    const artifactPath = artifact.path;
                    const canClick = Boolean(artifactPath && canShowItemInFolder);
                    const iconComponent = getArtifactIconComponent(label);
                    const IconComponent =
                      iconComponent === 'presentation'
                        ? FilePieChart
                        : iconComponent === 'table'
                          ? FileSpreadsheet
                          : iconComponent === 'document'
                            ? FileText
                            : iconComponent === 'code'
                              ? FileCode2
                              : iconComponent === 'image'
                                ? ImageIcon
                                : iconComponent === 'audio'
                                  ? FileAudio2
                                  : iconComponent === 'video'
                                    ? FileVideo
                                    : iconComponent === 'archive'
                                      ? FileArchive
                                      : iconComponent === 'text'
                                        ? File
                                        : File;

                    return (
                      <div
                        key={artifact.path || artifact.label || `artifact-${index}`}
                        className={`flex items-center gap-2 px-4 py-1.5 transition-colors ${canClick ? 'cursor-pointer hover:bg-surface-hover' : ''}`}
                        onClick={async () => {
                          if (!canClick) return;
                          const revealed = await window.electronAPI.showItemInFolder(
                            artifactPath,
                            currentWorkingDir ?? undefined
                          );
                          if (!revealed) {
                            setGlobalNotice({
                              id: `artifact-reveal-failed-${Date.now()}`,
                              type: 'warning',
                              message: t('context.revealFailed'),
                            });
                          }
                        }}
                        title={artifactPath || undefined}
                      >
                        <IconComponent className="w-3.5 h-3.5 text-text-muted shrink-0" />
                        <span className="text-xs text-text-primary truncate">{label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Working Directory */}
        <div className="border-b border-border-muted">
          <div className="px-4 py-2.5">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
              {t('context.workingDirectory')}
            </p>
            <div className="flex items-center gap-1.5 min-w-0">
              <FolderOpen className="w-3.5 h-3.5 text-text-muted shrink-0" />
              <span
                className={`text-xs truncate flex-1 ${currentWorkingDir ? 'text-text-primary cursor-pointer hover:text-accent-primary transition-colors' : 'text-text-muted'}`}
                title={currentWorkingDir ? t('context.openInFileManager') : ''}
                onClick={() =>
                  currentWorkingDir && window.electronAPI?.showItemInFolder(currentWorkingDir)
                }
              >
                {currentWorkingDir ? formatPath(currentWorkingDir) : t('context.noFolderSelected')}
              </span>
              {currentWorkingDir && (
                <button
                  onClick={() => handleCopyPath(currentWorkingDir)}
                  className="text-text-muted hover:text-text-primary transition-colors shrink-0 ml-1"
                  title={t('context.copyPath')}
                >
                  {copiedPath ? (
                    <Check className="w-3 h-3 text-success" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              )}
              <button
                onClick={async () => {
                  setIsChangingDir(true);
                  try {
                    const result = await changeWorkingDir(
                      activeSessionId || undefined,
                      currentWorkingDir || undefined
                    );
                    if (!result.success && result.error && result.error !== 'User cancelled') {
                      setGlobalNotice({
                        id: `change-dir-failed-${Date.now()}`,
                        type: 'warning',
                        message: `${t('context.changeDirFailed')}: ${result.error}`,
                      });
                    }
                  } catch (error) {
                    setGlobalNotice({
                      id: `change-dir-failed-${Date.now()}`,
                      type: 'error',
                      message:
                        error instanceof Error && error.message
                          ? `${t('context.changeDirFailed')}: ${error.message}`
                          : t('context.changeDirFailed'),
                    });
                  } finally {
                    setIsChangingDir(false);
                  }
                }}
                disabled={isChangingDir}
                className="text-text-muted hover:text-text-primary disabled:opacity-50 transition-colors shrink-0"
                title={t('context.changeDir')}
              >
                {isChangingDir ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <FolderSync className="w-3 h-3" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Pinned Skills */}
        {(availableSkills.length > 0 || sessionPinnedSkills.size > 0) && (
          <div className="border-b border-border-muted">
            <button
              onClick={() => setPinnedSkillsOpen(!pinnedSkillsOpen)}
              className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover transition-colors"
            >
              <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                {t('context.pinnedSkills')}
                {sessionPinnedSkills.size > 0 && (
                  <span className="ml-1.5 text-amber-500">({sessionPinnedSkills.size})</span>
                )}
              </span>
              {pinnedSkillsOpen ? (
                <ChevronUp className="w-3.5 h-3.5 text-text-muted" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
              )}
            </button>

            {pinnedSkillsOpen && (
              <div className="px-4 pb-2.5">
                {sessionPinnedSkills.size === 0 ? (
                  <p className="text-xs text-text-muted">{t('context.noSkillsPinned')}</p>
                ) : (
                  <div className="space-y-1 mb-2">
                    {Array.from(sessionPinnedSkills).map((skillId) => {
                      const skill = availableSkills.find((s) => s.id === skillId);
                      const isAvailable = !!skill;
                      return (
                        <div
                          key={skillId}
                          className={`flex items-center gap-2 px-2 py-1 rounded-md ${
                            isAvailable
                              ? 'bg-amber-500/5 border border-amber-500/20'
                              : 'bg-red-500/5 border border-red-500/20'
                          }`}
                        >
                          <Star
                            className={`w-3.5 h-3.5 shrink-0 ${isAvailable ? 'text-amber-500 fill-amber-500' : 'text-red-400 fill-red-400'}`}
                          />
                          <span className="text-xs text-text-primary flex-1 truncate">
                            {skill?.name || skillId}
                            {!isAvailable && (
                              <span className="text-red-400 ml-1">(unavailable)</span>
                            )}
                          </span>
                          <button
                            onClick={() => handleToggleSessionPinnedSkill(skillId, false)}
                            className="text-text-muted hover:text-text-primary transition-colors"
                            title={t('context.unpinSkill')}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Show unpinned skills as addable */}
                {availableSkills.filter((s) => !sessionPinnedSkills.has(s.id)).length > 0 &&
                  sessionPinnedSkills.size < MAX_PINNED_SKILLS_PER_SESSION && (
                    <div className="flex flex-wrap gap-1">
                      {availableSkills
                        .filter((s) => !sessionPinnedSkills.has(s.id))
                        .map((skill) => (
                          <button
                            key={skill.id}
                            onClick={() => handleToggleSessionPinnedSkill(skill.id, true)}
                            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs text-text-muted hover:text-text-primary hover:bg-surface-hover border border-border-muted transition-colors"
                            title={t('context.pinSkill')}
                          >
                            <Star className="w-3 h-3" />
                            <span>{skill.name}</span>
                          </button>
                        ))}
                    </div>
                  )}
              </div>
            )}
          </div>
        )}

        {/* MCP Connectors */}
        <div className="border-b border-border-muted">
          <button
            onClick={() => setMcpConnectorsOpen(!mcpConnectorsOpen)}
            className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover transition-colors"
          >
            <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
              {t('context.mcpConnectors')}
              {mcpServers.length > 0 && (
                <span className="ml-1.5 text-mcp">({mcpServers.length})</span>
              )}
            </span>
            {mcpConnectorsOpen ? (
              <ChevronUp className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            )}
          </button>

          {mcpConnectorsOpen && (
            <div className="px-4 pb-2.5">
              {mcpServers.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-text-muted py-1">
                  <Plug className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('mcp.noConnectors')}</span>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {mcpServers.map((server) => (
                    <ConnectorItem
                      key={server.id}
                      server={server}
                      steps={steps}
                      expanded={expandedConnector === server.id}
                      onToggle={() =>
                        setExpandedConnector(expandedConnector === server.id ? null : server.id)
                      }
                      sessionDisabled={sessionDisabledServers.has(server.id)}
                      onToggleSession={handleToggleSessionServer}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* End scrollable content area */}
    </div>
  );
}

function ConnectorItem({
  server,
  steps,
  expanded,
  onToggle,
  sessionDisabled,
  onToggleSession,
}: {
  server: MCPServerInfo;
  steps: TraceStep[];
  expanded: boolean;
  onToggle: () => void;
  sessionDisabled: boolean;
  onToggleSession: (serverId: string, disabled: boolean) => void;
}) {
  const { t } = useTranslation();
  // Get MCP tools used from this server
  // Tool names are in format: mcp__ServerName__toolname (with double underscores)
  // Server name preserves original case and spaces are replaced with underscores
  const serverNamePattern = server.name.replace(/\s+/g, '_');

  const mcpToolsUsed = steps
    .filter((s) => s.toolName?.startsWith('mcp__'))
    .map((s) => s.toolName!)
    .filter((name, index, self) => self.indexOf(name) === index)
    .filter((name) => {
      // Check if this tool belongs to this server
      // Format: mcp__ServerName__toolname
      const match = name.match(/^mcp__(.+?)__(.+)$/);
      if (match) {
        const toolServerName = match[1];
        return toolServerName === serverNamePattern;
      }
      return false;
    });

  const usageCount = steps.filter(
    (s) => s.toolName?.startsWith('mcp__') && mcpToolsUsed.includes(s.toolName)
  ).length;

  return (
    <div
      className={`rounded-lg border border-border overflow-hidden ${sessionDisabled ? 'opacity-50' : ''}`}
    >
      <div
        className={`w-full px-3 py-2 flex items-center gap-2 transition-colors ${
          server.connected && !sessionDisabled
            ? 'bg-mcp/10 hover:bg-mcp/20'
            : 'bg-surface-muted hover:bg-surface-hover'
        }`}
      >
        {/* Toggle switch */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSession(server.id, !sessionDisabled);
          }}
          className={`w-7 h-4 rounded-full relative transition-colors shrink-0 ${
            sessionDisabled ? 'bg-border' : 'bg-mcp'
          }`}
          title={sessionDisabled ? t('mcp.enableForSession') : t('mcp.disableForSession')}
        >
          <div
            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
              sessionDisabled ? 'left-0.5' : 'translate-x-3.5'
            }`}
          />
        </button>
        <button onClick={onToggle} className="flex-1 flex items-center gap-2 min-w-0">
          <div className="flex-1 text-left min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`text-sm font-medium truncate ${sessionDisabled ? 'text-text-muted line-through' : 'text-text-primary'}`}
              >
                {server.name}
              </span>
              {!server.connected && (
                <span className="text-xs text-text-muted">({t('mcp.notConnected')})</span>
              )}
              {sessionDisabled && (
                <span className="text-xs text-warning">({t('mcp.sessionDisabled')})</span>
              )}
            </div>
            {server.connected && !sessionDisabled && (
              <p className="text-xs text-text-muted">
                {t('mcp.toolCount', { count: server.toolCount })}
                {usageCount > 0 && ` • ${t('mcp.callCount', { count: usageCount })}`}
              </p>
            )}
          </div>
          {server.connected &&
            !sessionDisabled &&
            (expanded ? (
              <ChevronDown className="w-4 h-4 text-text-muted" />
            ) : (
              <ChevronRight className="w-4 h-4 text-text-muted" />
            ))}
        </button>
      </div>

      {expanded && server.connected && !sessionDisabled && (
        <div className="px-3 pb-2 space-y-1 bg-surface">
          {mcpToolsUsed.length > 0 ? (
            <>
              <p className="text-xs text-text-muted px-2 py-1">{t('context.toolsUsedLabel')}</p>
              {mcpToolsUsed.map((toolName, index) => {
                const count = steps.filter((s) => s.toolName === toolName).length;
                // Extract readable tool name - remove mcp__ServerName__ prefix
                const match = toolName.match(/^mcp__(.+?)__(.+)$/);
                const readableName = match ? match[2] : toolName;

                return (
                  <div
                    key={index}
                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-mcp/5 hover:bg-mcp/10 transition-colors"
                  >
                    <Wrench className="w-3.5 h-3.5 text-mcp" />
                    <span className="text-xs text-text-primary flex-1">{readableName}</span>
                    <span className="text-xs text-text-muted">{count}x</span>
                  </div>
                );
              })}
            </>
          ) : (
            <p className="text-xs text-text-muted px-2 py-1">{t('context.noToolsUsedYet')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Format long paths to show abbreviated version
function formatPath(path: string): string {
  if (!path) return '';

  // Windows: Replace C:\Users\username with ~
  const winHome = /^[A-Z]:\\Users\\[^\\]+/i;
  const winMatch = path.match(winHome);
  if (winMatch) {
    return '~' + path.slice(winMatch[0].length).replace(/\\/g, '/');
  }

  // macOS/Linux: Replace /Users/username or /home/username with ~
  const unixHome = /^\/(?:Users|home)\/[^/]+/;
  const unixMatch = path.match(unixHome);
  if (unixMatch) {
    return '~' + path.slice(unixMatch[0].length);
  }

  return path;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
