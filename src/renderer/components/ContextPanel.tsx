import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
import { WorkspaceInstructionsBadge } from './WorkspaceInstructionsBadge';
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
  Plus,
  Wrench,
  MessageSquare,
  Cpu,
  Copy,
  Layers,
  Star,
  X,
  Save,
} from 'lucide-react';
import type { TraceStep, MCPServerInfo } from '../types';
import type { SkillsWorkspaceProfile } from '../../shared/skill-conflict-types';
import {
  computeContextUsage,
  computeCacheHitRate,
  findLastTokenUsage,
} from '../utils/context-usage';
import { deriveDisabledServerIds } from '../utils/mcp-profile-derive';
import { isSkillsProfileDirty } from '../utils/skills-profile-derive';

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
  // Workspace profile state — mirrors WelcomeView pattern
  const [workspaceProfileDisabled, setWorkspaceProfileDisabled] = useState<Set<string>>(new Set());
  const [userToggledMcp, setUserToggledMcp] = useState(false);
  // Track which session the user-toggle applies to (session-scoped override)
  const [userToggledSessionId, setUserToggledSessionId] = useState<string | null>(null);
  // Ref to track latest activeSessionId for stale-async guards
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  // Ref to track latest currentWorkingDir for stale-async guards (assigned after derivation)
  const currentWorkingDirRef = useRef<string | null>(null);
  const [sessionPinnedSkills, setSessionPinnedSkills] = useState<Set<string>>(new Set());
  const [sessionDisabledSkills, setSessionDisabledSkills] = useState<Set<string>>(new Set());
  const [skillsWorkspaceProfile, setSkillsWorkspaceProfile] =
    useState<SkillsWorkspaceProfile | null>(null);
  const [skillsSessionLoaded, setSkillsSessionLoaded] = useState(false);
  const [skillsSessionLoadedFor, setSkillsSessionLoadedFor] = useState<string | null>(null);
  const [skillsProfileLoaded, setSkillsProfileLoaded] = useState(false);
  const [skillsProfileCwd, setSkillsProfileCwd] = useState<string | null>(null);
  const [removedSkillsOpen, setRemovedSkillsOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<
    Array<{ id: string; name: string; description?: string }>
  >([]);
  const [copiedPath, setCopiedPath] = useState(false);
  const [isChangingDir, setIsChangingDir] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<
    Array<{
      pluginId: string;
      name: string;
      description?: string;
      enabled: boolean;
      orchestratorSkill?: string | null;
      componentCounts: { skills: number };
    }>
  >([]);
  const [sessionPinnedPlugins, setSessionPinnedPlugins] = useState<Set<string>>(new Set());
  const [pinnedPluginsOpen, setPinnedPluginsOpen] = useState(true);
  const [recentWorkspaceFiles, setRecentWorkspaceFiles] = useState<
    Array<{
      path: string;
      modifiedAt: number;
      size: number;
    }>
  >([]);

  // Resizable panel width
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const stored = localStorage.getItem('context-panel-width');
      if (stored) {
        const parsed = Number(stored);
        return Number.isFinite(parsed) ? Math.max(200, Math.min(400, parsed)) : 288;
      }
    } catch {
      // localStorage unavailable
    }
    return 288; // default w-72 = 288px
  });
  const isResizingRef = useRef(false);
  const currentWidthRef = useRef(panelWidth);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const handlePanelResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (isResizingRef.current) return;
      e.preventDefault();
      isResizingRef.current = true;
      const startX = e.clientX;
      const startWidth = panelWidth;
      currentWidthRef.current = startWidth;

      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        // Dragging left = wider (panel is on the right side)
        const newWidth = Math.max(200, Math.min(400, startWidth + (startX - moveEvent.clientX)));
        currentWidthRef.current = newWidth;
        setPanelWidth(newWidth);
      };

      const cleanup = () => {
        if (!isResizingRef.current) return;
        isResizingRef.current = false;
        try {
          if (target.hasPointerCapture(e.pointerId)) {
            target.releasePointerCapture(e.pointerId);
          }
        } catch {
          // Already released
        }
        target.removeEventListener('pointermove', handlePointerMove);
        target.removeEventListener('pointerup', handlePointerUp);
        target.removeEventListener('lostpointercapture', handlePointerUp);
        window.removeEventListener('blur', cleanup);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragCleanupRef.current = null;
        try {
          localStorage.setItem('context-panel-width', String(currentWidthRef.current));
        } catch {
          // localStorage unavailable
        }
      };

      const handlePointerUp = () => cleanup();

      dragCleanupRef.current = cleanup;
      target.addEventListener('pointermove', handlePointerMove);
      target.addEventListener('pointerup', handlePointerUp);
      target.addEventListener('lostpointercapture', handlePointerUp);
      window.addEventListener('blur', cleanup);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [panelWidth]
  );

  // Cleanup drag on unmount
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

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
  currentWorkingDirRef.current = currentWorkingDir;
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

  // Single reverse scan to find the latest assistant message tokenUsage.
  // Shared by contextUsage (lastMessageInputTokens fallback) and cacheHitRate
  // so we don't scan the messages array more than once per render.
  const lastAssistantTokenUsage = useMemo(() => findLastTokenUsage(messages), [messages]);

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

    return computeContextUsage({
      contextWindow,
      toolSchemaTokens,
      maxOutputTokens,
      currentInputTokens,
      lastMessageInputTokens: lastAssistantTokenUsage?.input ?? 0,
    });
  }, [activeSessionId, sessionStates, lastAssistantTokenUsage]);

  // Cache-hit rate chip: derived from the latest assistant message's tokenUsage
  // so that both `input` and `cacheRead` always come from the same turn.
  // Using session state cacheRead + a separately-scanned lastInput risks a
  // race between message persistence and session.contextInfo updates.
  const cacheHitRate = useMemo(() => {
    if (!lastAssistantTokenUsage || lastAssistantTokenUsage.cacheRead === undefined) return null;
    return computeCacheHitRate({
      cacheRead: lastAssistantTokenUsage.cacheRead,
      input: lastAssistantTokenUsage.input,
    });
  }, [lastAssistantTokenUsage]);

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

  // Load workspace MCP profile and derive disabled IDs (mirrors WelcomeView pattern)
  // Effect 1: Reset user-override state on session or workspace change
  useEffect(() => {
    setUserToggledMcp(false);
    setUserToggledSessionId(null);
  }, [activeSessionId, currentWorkingDir]);

  // Effect 2: Load and derive workspace profile disabled IDs
  // Does NOT reset userToggledMcp — that's handled by the effect above.
  useEffect(() => {
    if (contextPanelCollapsed || !currentWorkingDir) {
      setWorkspaceProfileDisabled(new Set());
      return;
    }
    let cancelled = false;
    const loadProfile = async () => {
      try {
        const profile = await window.electronAPI?.mcp?.getWorkspaceProfile(currentWorkingDir);
        if (cancelled) return;
        if (!profile) {
          setWorkspaceProfileDisabled(new Set());
          return;
        }
        const derived = deriveDisabledServerIds(profile, mcpServers);
        if (derived === null) {
          // Allowlist mode but servers not loaded yet — keep empty for now
          setWorkspaceProfileDisabled(new Set());
        } else {
          setWorkspaceProfileDisabled(derived);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[ContextPanel] Failed to load workspace MCP profile:', error);
          setWorkspaceProfileDisabled(new Set());
        }
      }
    };
    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [currentWorkingDir, contextPanelCollapsed, mcpServers]);

  // Effective disabled set: union of session-disabled and workspace-profile-disabled
  // Once user manually toggles in THIS session, workspace profile is ignored (session state takes over)
  const effectiveDisabledServers = useMemo(() => {
    if (userToggledMcp && userToggledSessionId === activeSessionId) {
      return sessionDisabledServers;
    }
    // Merge both sets — a server is disabled if either source says so
    const merged = new Set(sessionDisabledServers);
    for (const id of workspaceProfileDisabled) {
      merged.add(id);
    }
    return merged;
  }, [
    sessionDisabledServers,
    workspaceProfileDisabled,
    userToggledMcp,
    userToggledSessionId,
    activeSessionId,
  ]);

  // Load session-pinned skills, disabled skills, and available skills when active session changes
  useEffect(() => {
    if (!activeSessionId || contextPanelCollapsed) {
      setSessionPinnedSkills(new Set());
      setSessionDisabledSkills(new Set());
      setAvailableSkills([]);
      setInstalledPlugins([]);
      setSessionPinnedPlugins(new Set());
      setSkillsSessionLoaded(false);
      setSkillsSessionLoadedFor(null);
      return;
    }
    // Reset state immediately to avoid showing previous session's data
    setSessionPinnedSkills(new Set());
    setSessionDisabledSkills(new Set());
    setAvailableSkills([]);
    setInstalledPlugins([]);
    setSessionPinnedPlugins(new Set());
    setSkillsSessionLoaded(false);
    setSkillsSessionLoadedFor(null);
    const sessionId = activeSessionId;
    let cancelled = false;

    const loadAll = async () => {
      let pinned: string[] = [];
      let disabled: string[] = [];
      let skills: Array<{ id: string; name: string; description?: string }> = [];
      let profileStateLoaded = true;

      // Validate required IPC methods exist at runtime
      const skillsApi = window.electronAPI?.skills;
      if (!skillsApi?.getSessionPinnedSkills || !skillsApi?.getSessionDisabledSkills) {
        console.error('[ContextPanel] Required skills IPC methods unavailable');
        return;
      }

      try {
        const result = await skillsApi.getSessionPinnedSkills(sessionId);
        pinned = result || [];
      } catch (error) {
        console.error('Failed to load session pinned skills:', error);
        profileStateLoaded = false;
      }

      try {
        const result = await skillsApi.getSessionDisabledSkills(sessionId);
        disabled = result || [];
      } catch (error) {
        console.error('Failed to load session disabled skills:', error);
        profileStateLoaded = false;
      }

      try {
        const result = await skillsApi.getAll();
        skills = (result || [])
          .filter((s) => s.enabled)
          .map((s) => ({ id: s.id, name: s.name, description: s.description }));
      } catch (error) {
        // Available skills failure is non-critical for profile save/dirty readiness
        console.error('Failed to load available skills:', error);
      }

      if (cancelled || activeSessionIdRef.current !== sessionId) return;

      setSessionPinnedSkills(new Set(pinned));
      setSessionDisabledSkills(new Set(disabled));
      setAvailableSkills(skills);
      // Profile save readiness depends only on pinned + disabled loading successfully
      setSkillsSessionLoaded(profileStateLoaded);
      if (profileStateLoaded) {
        setSkillsSessionLoadedFor(sessionId);
      }

      // Load installed plugins and session-pinned plugins
      try {
        const pluginsApi = window.electronAPI?.plugins;
        if (pluginsApi?.listInstalled && pluginsApi?.getSessionPinnedPlugins) {
          const [allPlugins, pinnedPluginIds] = await Promise.all([
            pluginsApi.listInstalled(),
            pluginsApi.getSessionPinnedPlugins(sessionId),
          ]);
          if (!cancelled && activeSessionIdRef.current === sessionId) {
            const enabledPlugins = (allPlugins || [])
              .filter(
                (p) => p.enabled && p.componentsEnabled.skills && p.componentCounts.skills > 0
              )
              .map((p) => ({
                pluginId: p.pluginId,
                name: p.name,
                description: p.description,
                enabled: p.enabled,
                orchestratorSkill: p.orchestratorSkill,
                componentCounts: { skills: p.componentCounts.skills },
              }));
            setInstalledPlugins(enabledPlugins);
            // Keep all pinned IDs — UI will show stale ones with unpin action
            setSessionPinnedPlugins(new Set(pinnedPluginIds || []));
          }
        }
      } catch (error) {
        console.error('Failed to load plugin pinning state:', error);
      }
    };

    loadAll();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, contextPanelCollapsed, skillsStorageChangedAt]);

  // Load workspace skills profile when workspace changes
  useEffect(() => {
    if (contextPanelCollapsed || !currentWorkingDir) {
      setSkillsWorkspaceProfile(null);
      setSkillsProfileLoaded(false);
      setSkillsProfileCwd(null);
      return;
    }
    // Reset immediately when cwd changes to prevent stale comparisons
    setSkillsWorkspaceProfile(null);
    setSkillsProfileLoaded(false);
    setSkillsProfileCwd(null);

    let cancelled = false;
    const loadProfile = async () => {
      // Validate required IPC method exists at runtime
      const skillsApi = window.electronAPI?.skills;
      if (!skillsApi?.getWorkspaceProfile) {
        console.error('[ContextPanel] skills.getWorkspaceProfile IPC method unavailable');
        return;
      }
      try {
        const profile = await skillsApi.getWorkspaceProfile(currentWorkingDir);
        if (!cancelled) {
          setSkillsWorkspaceProfile(profile || null);
          setSkillsProfileLoaded(true);
          setSkillsProfileCwd(currentWorkingDir);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[ContextPanel] Failed to load skills workspace profile:', error);
          // Do NOT mark as loaded on failure — save button stays hidden
          setSkillsWorkspaceProfile(null);
          setSkillsProfileLoaded(false);
          setSkillsProfileCwd(null);
        }
      }
    };
    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [currentWorkingDir, contextPanelCollapsed]);

  // Seed workspace profile disabled/pinned skills into session if session is empty
  // and a workspace profile exists. This ensures sessions created before the profile
  // was saved (or before this feature existed) still reflect the workspace defaults.
  // Only runs once per session+workspace+profile-content combination.
  // Tracks seeded state by a key that includes profile content hash to detect changes.
  const [skillsProfileSeededKey, setSkillsProfileSeededKey] = useState<string | null>(null);
  // Track whether user has manually modified skills in this session (prevents re-seeding)
  const [userModifiedSessionSkills, setUserModifiedSessionSkills] = useState(false);
  const userModifiedSessionSkillsRef = useRef(false);
  useEffect(() => {
    // Reset on session change
    setSkillsProfileSeededKey(null);
    setUserModifiedSessionSkills(false);
    userModifiedSessionSkillsRef.current = false;
  }, [activeSessionId]);

  useEffect(() => {
    // Derive a content-based key so profile changes trigger re-seeding
    const profileContent = JSON.stringify({
      d: skillsWorkspaceProfile?.disabled ?? [],
      p: skillsWorkspaceProfile?.pinned ?? [],
    });
    const currentSeededKey = `${activeSessionId}:${currentWorkingDir}:${profileContent}`;

    if (
      !activeSessionId ||
      !skillsSessionLoaded ||
      !skillsProfileLoaded ||
      skillsProfileSeededKey === currentSeededKey ||
      userModifiedSessionSkills ||
      skillsSessionLoadedFor !== activeSessionId ||
      skillsProfileCwd !== currentWorkingDir
    ) {
      return;
    }

    // Only seed if workspace profile has something to apply
    const profileDisabled = skillsWorkspaceProfile?.disabled ?? [];
    const profilePinned = skillsWorkspaceProfile?.pinned ?? [];
    if (profileDisabled.length === 0 && profilePinned.length === 0) {
      // No profile to apply — mark as seeded (nothing to do)
      setSkillsProfileSeededKey(currentSeededKey);
      return;
    }

    // If session already has disabled or pinned skills, user has customized — don't overwrite
    if (sessionDisabledSkills.size > 0 || sessionPinnedSkills.size > 0) {
      setSkillsProfileSeededKey(currentSeededKey);
      return;
    }

    // Seed from workspace profile using atomic backend operation
    const sessionId = activeSessionId;
    const seedKey = currentSeededKey;
    let cancelled = false;

    const seedFromProfile = async () => {
      const skillsApi = window.electronAPI?.skills;
      if (!skillsApi?.seedSessionFromProfile) {
        return;
      }

      try {
        if (cancelled || userModifiedSessionSkillsRef.current) return;
        const result = await skillsApi.seedSessionFromProfile(sessionId, {
          pinned: profilePinned,
          disabled: profileDisabled,
        });
        if (
          cancelled ||
          activeSessionIdRef.current !== sessionId ||
          userModifiedSessionSkillsRef.current
        )
          return;
        if (result?.success) {
          setSessionDisabledSkills(new Set(result.disabledSkills || []));
          setSessionPinnedSkills(new Set(result.pinnedSkills || []));
          setSkillsProfileSeededKey(seedKey);
        }
      } catch (error) {
        console.error('[ContextPanel] Failed to seed skills from workspace profile:', error);
      }
    };

    seedFromProfile();

    return () => {
      cancelled = true;
    };
  }, [
    activeSessionId,
    skillsSessionLoaded,
    skillsSessionLoadedFor,
    skillsProfileLoaded,
    skillsProfileCwd,
    currentWorkingDir,
    skillsProfileSeededKey,
    skillsWorkspaceProfile,
    userModifiedSessionSkills,
    sessionDisabledSkills.size,
    sessionPinnedSkills.size,
  ]);

  const handleToggleSessionServer = async (serverId: string, disabled: boolean) => {
    if (!activeSessionId) return;
    // Capture session ID to guard against stale updates from session switches
    const sessionId = activeSessionId;
    try {
      // If user hasn't toggled yet this session, seed session state from effective state.
      // This ensures workspace-profile-disabled servers are reflected in session state
      // so a single click correctly enables/disables them.
      if (!userToggledMcp || userToggledSessionId !== sessionId) {
        // Seed workspace-profile-disabled servers into session state in parallel
        const serversToSeed = Array.from(workspaceProfileDisabled).filter(
          (wpId) => !sessionDisabledServers.has(wpId)
        );
        if (serversToSeed.length > 0) {
          await Promise.all(
            serversToSeed.map((wpId) =>
              window.electronAPI?.mcp?.toggleSessionServer(sessionId, wpId, true)
            )
          );
        }
        // Stale guard: abort if session changed during seeding (uses ref for latest value)
        if (activeSessionIdRef.current !== sessionId) return;
        // Refresh session disabled state after seeding
        const refreshed = await window.electronAPI?.mcp?.getSessionDisabledServers(sessionId);
        if (activeSessionIdRef.current !== sessionId) return;
        setSessionDisabledServers(new Set(refreshed || []));
      }

      // Now apply the actual user toggle
      const result = await window.electronAPI?.mcp?.toggleSessionServer(
        sessionId,
        serverId,
        disabled
      );
      // Stale guard: abort if session changed during toggle (uses ref for latest value)
      if (activeSessionIdRef.current !== sessionId) return;
      if (result?.success && result.disabledServers) {
        setSessionDisabledServers(new Set(result.disabledServers));
        // Only mark user-override after successful toggle
        setUserToggledMcp(true);
        setUserToggledSessionId(sessionId);
      }
    } catch (error) {
      console.error('Failed to toggle session MCP server:', error);
      // On failure, refresh session state to ensure consistency
      if (activeSessionIdRef.current === sessionId) {
        try {
          const refreshed = await window.electronAPI?.mcp?.getSessionDisabledServers(sessionId);
          if (activeSessionIdRef.current === sessionId) {
            setSessionDisabledServers(new Set(refreshed || []));
          }
        } catch {
          // Ignore refresh errors
        }
      }
    }
  };

  const handleSaveWorkspaceProfile = async () => {
    if (!currentWorkingDir) return;
    try {
      const result = await window.electronAPI?.mcp?.saveWorkspaceProfile(
        currentWorkingDir,
        Array.from(effectiveDisabledServers)
      );
      if (result?.success) {
        setGlobalNotice({
          id: `mcp-profile-saved-${Date.now()}`,
          type: 'success',
          message: t('mcp.savedToWorkspace'),
        });
      } else {
        setGlobalNotice({
          id: `mcp-profile-save-failed-${Date.now()}`,
          type: 'error',
          message: `${t('mcp.saveToWorkspaceFailed')}: ${result?.error || 'Unknown error'}`,
        });
      }
    } catch (error) {
      console.error('Failed to save MCP workspace profile:', error);
      setGlobalNotice({
        id: `mcp-profile-save-failed-${Date.now()}`,
        type: 'error',
        message: t('mcp.saveToWorkspaceFailed'),
      });
    }
  };

  const handleToggleSessionPinnedSkill = async (skillId: string, pinned: boolean) => {
    if (!activeSessionId) return;
    setUserModifiedSessionSkills(true);
    userModifiedSessionSkillsRef.current = true;
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

  const handleTogglePluginPin = async (pluginId: string) => {
    if (!activeSessionId) return;
    try {
      const result = await window.electronAPI?.plugins?.toggleSessionPluginPin(
        activeSessionId,
        pluginId
      );
      if (result) {
        setSessionPinnedPlugins(new Set(result));
      }
    } catch (error) {
      console.error('Failed to toggle plugin pin:', error);
    }
  };

  const handleToggleSessionDisabledSkill = async (skillId: string, disabled: boolean) => {
    if (!activeSessionId) return;
    setUserModifiedSessionSkills(true);
    userModifiedSessionSkillsRef.current = true;
    const skillsApi = window.electronAPI?.skills;
    if (!skillsApi?.toggleSessionDisabled || !skillsApi?.toggleSessionPin) {
      console.error('[ContextPanel] Required skills IPC methods unavailable for toggle');
      return;
    }
    const sessionId = activeSessionId;
    let wasPinned = false;
    try {
      // If removing a pinned skill, unpin it first (Pin + Remove = invalid)
      wasPinned = disabled && sessionPinnedSkills.has(skillId);
      if (wasPinned) {
        const unpinResult = await skillsApi.toggleSessionPin(sessionId, skillId, false);
        if (!unpinResult?.success) {
          console.error('Failed to unpin skill before removing — aborting remove');
          return;
        }
        // Only update UI state if still on this session
        if (activeSessionIdRef.current === sessionId && unpinResult.pinnedSkills) {
          setSessionPinnedSkills(new Set(unpinResult.pinnedSkills));
        }
      }
      const result = await skillsApi.toggleSessionDisabled(sessionId, skillId, disabled);
      // Always check result for rollback regardless of UI session
      if (result?.success) {
        // Only update UI state if still on this session
        if (activeSessionIdRef.current === sessionId) {
          if (result.disabledSkills) {
            setSessionDisabledSkills(new Set(result.disabledSkills));
          } else {
            // Server didn't return the list — update locally as fallback
            setSessionDisabledSkills((prev) => {
              const next = new Set(prev);
              if (disabled) {
                next.add(skillId);
              } else {
                next.delete(skillId);
              }
              return next;
            });
          }
        }
      } else if (!result?.success && wasPinned) {
        // Disable failed after successful unpin — rollback the pin on the backend
        await rollbackRepin(sessionId, skillId);
        if (activeSessionIdRef.current === sessionId) {
          setGlobalNotice({
            id: `skill-toggle-failed-${Date.now()}`,
            type: 'error',
            message: t('skills.failedToToggle'),
          });
        }
      } else if (!result?.success) {
        // Non-pinned toggle failure — show error to user
        if (activeSessionIdRef.current === sessionId) {
          setGlobalNotice({
            id: `skill-toggle-failed-${Date.now()}`,
            type: 'error',
            message: t('skills.failedToToggle'),
          });
        }
      }
    } catch (error) {
      console.error('Failed to toggle session disabled skill:', error);
      // If unpin succeeded but disable threw, rollback the pin on the backend
      if (wasPinned) {
        await rollbackRepin(sessionId, skillId);
      }
      if (activeSessionIdRef.current === sessionId) {
        setGlobalNotice({
          id: `skill-toggle-failed-${Date.now()}`,
          type: 'error',
          message: t('skills.failedToToggle'),
        });
      }
    }
  };

  /** Re-pin a skill after a failed disable operation (rollback helper). */
  const rollbackRepin = async (sessionId: string, skillId: string) => {
    try {
      const repinResult = await window.electronAPI?.skills?.toggleSessionPin(
        sessionId,
        skillId,
        true
      );
      // Only update UI if still on the same session
      if (
        activeSessionIdRef.current === sessionId &&
        repinResult?.success &&
        repinResult.pinnedSkills
      ) {
        setSessionPinnedSkills(new Set(repinResult.pinnedSkills));
      }
    } catch (repinError) {
      console.error('Failed to rollback pin after disable failure:', repinError);
    }
  };

  const handleSaveSkillsWorkspaceProfile = async () => {
    if (
      !currentWorkingDir ||
      !activeSessionId ||
      !skillsSessionLoaded ||
      skillsSessionLoadedFor !== activeSessionId ||
      !skillsProfileLoaded ||
      skillsProfileCwd !== currentWorkingDir
    ) {
      return;
    }
    const saveCwd = currentWorkingDir;
    const saveSessionId = activeSessionId;
    // Validate required IPC method exists at runtime
    const skillsApi = window.electronAPI?.skills;
    if (!skillsApi?.saveWorkspaceProfile) {
      console.error('[ContextPanel] skills.saveWorkspaceProfile IPC method unavailable');
      return;
    }
    try {
      // Normalize: exclude disabled IDs from pinned (Pin + Remove = invalid invariant)
      const normalizedPinned = Array.from(sessionPinnedSkills).filter(
        (id) => !sessionDisabledSkills.has(id)
      );
      const profile: SkillsWorkspaceProfile = {
        pinned: normalizedPinned.length > 0 ? normalizedPinned : undefined,
        disabled: sessionDisabledSkills.size > 0 ? Array.from(sessionDisabledSkills) : undefined,
      };
      const result = await skillsApi.saveWorkspaceProfile(saveCwd, profile);
      // Stale guard: only update local state if workspace/session haven't changed
      if (
        activeSessionIdRef.current !== saveSessionId ||
        currentWorkingDirRef.current !== saveCwd
      ) {
        return;
      }
      if (result?.success) {
        // Update local profile reference to match saved state
        setSkillsWorkspaceProfile(profile);
        setGlobalNotice({
          id: `skills-profile-saved-${Date.now()}`,
          type: 'success',
          message: t('skills.profileSavedToWorkspace'),
        });
      } else {
        setGlobalNotice({
          id: `skills-profile-save-failed-${Date.now()}`,
          type: 'error',
          message: `${t('skills.profileSaveToWorkspaceFailed')}: ${result?.error || 'Unknown error'}`,
        });
      }
    } catch (error) {
      console.error('Failed to save skills workspace profile:', error);
      // Only show error if still in the same session/workspace context
      if (
        activeSessionIdRef.current === saveSessionId &&
        currentWorkingDirRef.current === saveCwd
      ) {
        setGlobalNotice({
          id: `skills-profile-save-failed-${Date.now()}`,
          type: 'error',
          message: t('skills.profileSaveToWorkspaceFailed'),
        });
      }
    }
  };

  // Derive whether profile is dirty (save button visibility)
  // Only meaningful when session skills have been loaded for the current session
  // AND workspace profile has been loaded for the current working directory
  const isSkillsProfileDirtyState = useMemo(
    () =>
      skillsSessionLoaded &&
      skillsProfileLoaded &&
      skillsSessionLoadedFor === activeSessionId &&
      skillsProfileCwd === currentWorkingDir
        ? isSkillsProfileDirty(sessionPinnedSkills, sessionDisabledSkills, skillsWorkspaceProfile)
        : false,
    [
      sessionPinnedSkills,
      sessionDisabledSkills,
      skillsWorkspaceProfile,
      skillsSessionLoaded,
      skillsSessionLoadedFor,
      skillsProfileLoaded,
      skillsProfileCwd,
      currentWorkingDir,
      activeSessionId,
    ]
  );

  // Compute skill counts for header
  const skillCounts = useMemo(() => {
    // Pinned count excludes any that are also disabled (shouldn't happen normally but be defensive)
    const pinnedCount = Array.from(sessionPinnedSkills).filter(
      (id) => !sessionDisabledSkills.has(id)
    ).length;
    const disabledCount = sessionDisabledSkills.size;
    const activeCount = availableSkills.filter((s) => !sessionDisabledSkills.has(s.id)).length;
    return { pinnedCount, activeCount, disabledCount };
  }, [sessionPinnedSkills, sessionDisabledSkills, availableSkills]);

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
    <div
      className="bg-background border-l border-border-muted flex flex-col overflow-hidden text-sm relative"
      style={{ width: `${panelWidth}px` }}
    >
      {/* Resize handle (left edge) */}
      <div
        onPointerDown={handlePanelResizeStart}
        className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-accent/30 transition-colors z-10 touch-none"
      />
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
        {cacheHitRate !== null && (
          <span
            className="ml-auto text-xs font-medium text-text-muted/70 tabular-nums"
            title={t('context.cacheHitTooltip')}
          >
            {t('context.cacheHit', { rate: cacheHitRate })}
          </span>
        )}
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

        {/* Workspace Instructions Status */}
        <WorkspaceInstructionsBadge cwd={currentWorkingDir || undefined} />

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

        {/* Plugin Pinning */}
        {(installedPlugins.length > 0 || sessionPinnedPlugins.size > 0) && (
          <div className="border-b border-border-muted">
            <div className="w-full px-4 py-2.5 flex items-center justify-between">
              <button
                onClick={() => setPinnedPluginsOpen(!pinnedPluginsOpen)}
                className="flex items-center gap-1 flex-1 hover:bg-surface-hover transition-colors rounded -ml-1 px-1"
              >
                <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                  {t('context.plugins')}
                  {sessionPinnedPlugins.size > 0 && (
                    <span className="ml-1.5 text-purple-500">
                      ({sessionPinnedPlugins.size} {t('context.pluginsPinned')})
                    </span>
                  )}
                </span>
              </button>
            </div>

            {pinnedPluginsOpen && (
              <div className="px-4 pb-2.5 space-y-1">
                {/* Stale pinned plugins (pinned but no longer available) */}
                {Array.from(sessionPinnedPlugins)
                  .filter((id) => !installedPlugins.some((p) => p.pluginId === id))
                  .map((staleId) => (
                    <div
                      key={staleId}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-red-500/5 border border-red-500/20"
                    >
                      <button
                        onClick={() => handleTogglePluginPin(staleId)}
                        className="shrink-0 text-red-400 transition-colors"
                        title={t('context.unpinPlugin')}
                      >
                        <Star className="w-3.5 h-3.5 fill-red-400" />
                      </button>
                      <span className="text-xs text-text-muted flex-1 truncate">
                        {staleId}
                        <span className="text-red-400 ml-1">
                          ({t('context.pluginUnavailable')})
                        </span>
                      </span>
                    </div>
                  ))}

                {/* Available plugins */}
                {installedPlugins.map((plugin) => {
                  const isPinned = sessionPinnedPlugins.has(plugin.pluginId);
                  return (
                    <div
                      key={plugin.pluginId}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${
                        isPinned
                          ? 'bg-purple-500/5 border border-purple-500/20'
                          : 'border border-border-muted'
                      }`}
                    >
                      <button
                        onClick={() => handleTogglePluginPin(plugin.pluginId)}
                        className={`shrink-0 ${isPinned ? 'text-purple-500' : 'text-text-muted hover:text-purple-500'} transition-colors`}
                        title={isPinned ? t('context.unpinPlugin') : t('context.pinPlugin')}
                      >
                        <Star className={`w-3.5 h-3.5 ${isPinned ? 'fill-purple-500' : ''}`} />
                      </button>
                      <span className="text-xs text-text-primary flex-1 truncate">
                        {plugin.name}
                      </span>
                      <span className="text-[10px] text-text-muted">
                        {plugin.componentCounts.skills} {t('context.pluginSkillCount')}
                      </span>
                      {plugin.orchestratorSkill && (
                        <span
                          className="text-[10px] text-amber-500"
                          title={t('context.pluginHasOrchestrator')}
                        >
                          ★
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Pinned Skills */}
        {(availableSkills.length > 0 ||
          sessionPinnedSkills.size > 0 ||
          sessionDisabledSkills.size > 0) && (
          <div className="border-b border-border-muted">
            <div className="w-full px-4 py-2.5 flex items-center justify-between">
              <button
                onClick={() => setPinnedSkillsOpen(!pinnedSkillsOpen)}
                className="flex items-center gap-1 flex-1 hover:bg-surface-hover transition-colors rounded -ml-1 px-1"
              >
                <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                  {t('skills.profileSectionHeader')}
                  {availableSkills.length > 0 && (
                    <span className="ml-1.5 text-amber-500">
                      (
                      {t('skills.profileActiveCount', {
                        pinned: skillCounts.pinnedCount,
                        active: skillCounts.activeCount,
                        removed: skillCounts.disabledCount,
                      })}
                      )
                    </span>
                  )}
                </span>
              </button>
              <div className="flex items-center gap-1">
                {currentWorkingDir && isSkillsProfileDirtyState && (
                  <button
                    onClick={handleSaveSkillsWorkspaceProfile}
                    className="text-text-muted hover:text-accent-primary transition-colors"
                    title={t('skills.profileSaveToWorkspace')}
                  >
                    <Save className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => setPinnedSkillsOpen(!pinnedSkillsOpen)}
                  className="text-text-muted hover:text-text-primary transition-colors"
                >
                  {pinnedSkillsOpen ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>

            {pinnedSkillsOpen && (
              <div className="px-4 pb-2.5">
                {/* Pinned skills (excluding any that are also disabled) */}
                {sessionPinnedSkills.size > 0 && (
                  <div className="space-y-1 mb-2">
                    {Array.from(sessionPinnedSkills)
                      .filter((id) => !sessionDisabledSkills.has(id))
                      .map((skillId) => {
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
                            <button
                              onClick={() => handleToggleSessionPinnedSkill(skillId, false)}
                              title={t('context.unpinSkill')}
                            >
                              <Star
                                className={`w-3.5 h-3.5 shrink-0 cursor-pointer ${isAvailable ? 'text-amber-500 fill-amber-500' : 'text-red-400 fill-red-400'}`}
                              />
                            </button>
                            <span className="text-xs text-text-primary flex-1 truncate">
                              {skill?.name || skillId}
                              {!isAvailable && (
                                <span className="text-red-400 ml-1">(unavailable)</span>
                              )}
                            </span>
                            <button
                              onClick={() => handleToggleSessionDisabledSkill(skillId, true)}
                              className="text-text-muted hover:text-error transition-colors"
                              title={t('skills.profileRemove')}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        );
                      })}
                  </div>
                )}

                {/* Available (unpinned, not disabled) skills */}
                {availableSkills.filter(
                  (s) => !sessionPinnedSkills.has(s.id) && !sessionDisabledSkills.has(s.id)
                ).length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {availableSkills
                      .filter(
                        (s) => !sessionPinnedSkills.has(s.id) && !sessionDisabledSkills.has(s.id)
                      )
                      .map((skill) => (
                        <div
                          key={skill.id}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs text-text-muted border border-border-muted"
                        >
                          <button
                            onClick={() => handleToggleSessionPinnedSkill(skill.id, true)}
                            className="hover:text-amber-500 transition-colors"
                            title={t('context.pinSkill')}
                            disabled={skillCounts.pinnedCount >= MAX_PINNED_SKILLS_PER_SESSION}
                          >
                            <Star className="w-3 h-3" />
                          </button>
                          <span className="hover:text-text-primary transition-colors">
                            {skill.name}
                          </span>
                          <button
                            onClick={() => handleToggleSessionDisabledSkill(skill.id, true)}
                            className="hover:text-error transition-colors ml-0.5"
                            title={t('skills.profileRemove')}
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      ))}
                  </div>
                )}

                {/* Removed (disabled) skills section */}
                {sessionDisabledSkills.size > 0 && (
                  <div className="mt-2 border-t border-border-muted pt-2">
                    <button
                      onClick={() => setRemovedSkillsOpen(!removedSkillsOpen)}
                      className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors w-full"
                    >
                      {removedSkillsOpen ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                      <span>
                        {t('skills.profileRemovedSection')} ({sessionDisabledSkills.size})
                      </span>
                    </button>
                    {removedSkillsOpen && (
                      <div className="space-y-1 mt-1.5">
                        {Array.from(sessionDisabledSkills).map((skillId) => {
                          const skill = availableSkills.find((s) => s.id === skillId);
                          return (
                            <div
                              key={skillId}
                              className="flex items-center gap-2 px-2 py-1 rounded-md border border-dashed border-border-muted opacity-60"
                            >
                              <span className="text-xs text-text-muted flex-1 truncate line-through">
                                {skill?.name || skillId}
                              </span>
                              <span className="text-xs text-text-muted/60 hidden sm:inline">
                                {t('skills.profileOffThisSession')}
                              </span>
                              <button
                                onClick={() => handleToggleSessionDisabledSkill(skillId, false)}
                                className="text-text-muted hover:text-success transition-colors"
                                title={t('skills.profileRestore')}
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Empty state */}
                {sessionPinnedSkills.size === 0 &&
                  availableSkills.filter((s) => !sessionDisabledSkills.has(s.id)).length === 0 &&
                  sessionDisabledSkills.size === 0 && (
                    <p className="text-xs text-text-muted">{t('context.noSkillsPinned')}</p>
                  )}
              </div>
            )}
          </div>
        )}

        {/* MCP Connectors */}
        <div className="border-b border-border-muted">
          <div className="w-full px-4 py-2.5 flex items-center justify-between">
            <button
              onClick={() => setMcpConnectorsOpen(!mcpConnectorsOpen)}
              className="flex items-center gap-1 flex-1 hover:bg-surface-hover transition-colors rounded -ml-1 px-1"
            >
              <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                {t('context.mcpConnectors')}
                {mcpServers.length > 0 && (
                  <span className="ml-1.5 text-mcp">
                    ({mcpServers.length}/{mcpServers.filter((s) => s.connected).length}/
                    {
                      mcpServers.filter((s) => s.connected && !effectiveDisabledServers.has(s.id))
                        .length
                    }
                    )
                  </span>
                )}
              </span>
            </button>
            <div className="flex items-center gap-1">
              {currentWorkingDir && mcpServers.length > 0 && (
                <button
                  onClick={handleSaveWorkspaceProfile}
                  className="text-text-muted hover:text-accent-primary transition-colors"
                  title={t('mcp.saveToWorkspace')}
                >
                  <Save className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setMcpConnectorsOpen(!mcpConnectorsOpen)}
                className="text-text-muted hover:text-text-primary transition-colors"
              >
                {mcpConnectorsOpen ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

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
                      sessionDisabled={effectiveDisabledServers.has(server.id)}
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
