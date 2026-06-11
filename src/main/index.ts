/**
 * @module main/index
 *
 * Electron main-process entry point (2181 lines).
 *
 * Responsibilities:
 * - App lifecycle: ready, activate, before-quit, window-will-close
 * - Central IPC hub: ~60 handlers namespaced as config.*, mcp.*, session.*,
 *   sandbox.*, logs.*, remote.*, schedule.*, etc.
 * - BrowserWindow creation and deep-link / protocol handling
 *
 * Dependencies: session-manager, config-store, mcp-manager, sandbox-adapter,
 *               skills-manager, scheduled-task-manager, nav-server, remote-manager
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeTheme,
  Tray,
  clipboard,
} from 'electron';
import { join, resolve, relative, dirname, isAbsolute, basename } from 'path';
import * as fs from 'fs';
import { execFileSync, execFile } from 'child_process';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { config } from 'dotenv';
import { initDatabase, closeDatabase, getDatabase } from './db/database';
import { SessionManager } from './session/session-manager';
import { SkillsManager } from './skills/skills-manager';
import { PluginCatalogService } from './skills/plugin-catalog-service';
import { PluginRuntimeService } from './skills/plugin-runtime-service';
import { MemoryService } from './memory/memory-service';
import { MemoryExtension } from './memory/memory-extension';
import { CORE_MEMORY_UPDATE_SYSTEM_PROMPT } from './memory/memory-prompts';
import { AgentRuntimeExtensionManager } from './extensions/agent-runtime-extension-manager';
import {
  configStore,
  getPiAiModelPresets,
  type AppConfig,
  type AppTheme,
  type CreateConfigSetPayload,
} from './config/config-store';
import { runConfigApiTest } from './config/config-test-routing';
import { listOllamaModels } from './config/ollama-api';
import { applyLocalDevPath, isBasePathSet, getEffectivePath } from './utils/path-env';
import {
  setPermissionRules,
  setBashCommandLists,
  sanitizeBashCommandList,
  markSessionAutonomous,
  setAutonomousBlockCallback,
  forgetSessionPermissions,
} from './config/permission-rules-store';
import { mcpConfigStore } from './mcp/mcp-config-store';
import {
  saveWorkspaceMcpProfile,
  loadWorkspaceMcpProfile,
  validateWorkspaceCwd,
} from './mcp/mcp-workspace-profile';
import { getSandboxAdapter, shutdownSandbox } from './sandbox/sandbox-adapter';
import { SandboxSync } from './sandbox/sandbox-sync';
import { WSLBridge } from './sandbox/wsl-bridge';
import { LimaBridge } from './sandbox/lima-bridge';
import { getSandboxBootstrap } from './sandbox/sandbox-bootstrap';
import type { MCPServerConfig } from './mcp/mcp-manager';
import type {
  ClientEvent,
  ServerEvent,
  ApiTestInput,
  ApiTestResult,
  DiagnosticInput,
  ProviderModelInfo,
} from '../renderer/types';
import { remoteManager, type AgentExecutor } from './remote/remote-manager';
import { remoteConfigStore } from './remote/remote-config-store';
import type { GatewayConfig, FeishuChannelConfig, ChannelType } from './remote/types';
import { startNavServer, stopNavServer } from './nav-server';
import {
  ScheduledTaskManager,
  type ScheduledTaskCreateInput,
  type ScheduledTaskUpdateInput,
} from './schedule/scheduled-task-manager';
import {
  createScheduledTaskStore,
  createScheduledTaskRunStore,
} from './schedule/scheduled-task-store';
import {
  buildScheduledTaskFallbackTitle,
  buildScheduledTaskTitle,
} from '../shared/schedule/task-title';
import {
  isUncPath,
  isWindowsDrivePath,
  localPathFromAppUrlPathname,
  localPathFromFileUrl,
  decodePathSafely,
} from '../shared/local-file-path';
import { eventRequiresSessionManager } from './client-event-utils';
import { getUnsupportedWorkspacePathReason } from './workspace-path-constraints';
import {
  log,
  logWarn,
  logError,
  getLogFilePath,
  getLogsDirectory,
  getAllLogFiles,
  closeLogFile,
  setDevLogsEnabled,
  isDevLogsEnabled,
} from './utils/logger';
import { listRecentWorkspaceFiles } from './utils/recent-workspace-files';
import { buildDiagnosticsSummary } from './utils/diagnostics-summary';
import { isValidSystemPromptFileChoice } from '../shared/system-prompt-file-choices';
import {
  ensurePromptFiles,
  loadPromptSections,
  updatePromptSection,
  resetPromptSection,
  resetAllPromptSections,
  togglePromptSection,
  openPromptsDir,
  invalidatePromptCache,
} from './prompts/prompt-loader';

// Current working directory (persisted between sessions)
let currentWorkingDir: string | null = null;

// Load .env file from project root (for development)
const envPath = resolve(__dirname, '../../.env');
log('[dotenv] Loading from:', envPath);
const dotenvResult = config({ path: envPath });
if (dotenvResult.error) {
  logWarn('[dotenv] Failed to load .env:', dotenvResult.error.message);
} else {
  log('[dotenv] Loaded successfully');
}

// Apply saved config (this overrides .env if config exists)
if (configStore.isConfigured()) {
  log('[Config] Applying saved configuration...');
  configStore.applyToEnv();
}

// Disable hardware acceleration for better compatibility
app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;
let skillsManager: SkillsManager | null = null;
let pluginRuntimeService: PluginRuntimeService | null = null;
let memoryService: MemoryService | null = null;
let scheduledTaskManager: ScheduledTaskManager | null = null;

/** Maps sessionId → taskId for autonomous scheduled task sessions. */
const scheduledSessionToTaskId = new Map<string, string>();

/**
 * Skill ID for the cowork-memory skill (Python scripts for manual memory).
 * When the in-app memory system is active, this skill is redundant and should be disabled.
 */
const COWORK_MEMORY_SKILL_ID = 'builtin-cowork-memory';

/** Monotonic token to prevent stale async sync completions from overwriting newer state. */
let syncCoworkMemoryGeneration = 0;

/**
 * Sync the cowork-memory skill enabled state with the in-app memory toggle.
 * The skill should be disabled when in-app memory is ON (automated system handles it),
 * and enabled when in-app memory is OFF (fall back to manual skill scripts).
 *
 * Only mutates skill state if it's currently out of sync.
 * Uses a generation token to discard stale completions from concurrent calls.
 * Returns silently if skillsManager is unavailable or the skill is not installed.
 *
 * Note: skillsManager.setSkillEnabled() is synchronous (mutates in-memory Map + stops
 * MCP server if applicable). No disk persistence to await.
 */
async function syncCoworkMemorySkillState(memoryEnabled: boolean): Promise<void> {
  if (!skillsManager) return;

  const generation = ++syncCoworkMemoryGeneration;

  // Ensure skills are loaded from disk before checking state.
  const allSkills = await skillsManager.listSkills();

  // If a newer sync was requested while we awaited, discard this one.
  if (generation !== syncCoworkMemoryGeneration) return;

  const skill = allSkills.find((s) => s.id === COWORK_MEMORY_SKILL_ID);
  if (!skill) return;

  // Re-check effective memory state to avoid applying stale input.
  const effectiveMemoryEnabled = memoryService?.isEnabled() ?? memoryEnabled;
  const skillShouldBeEnabled = !effectiveMemoryEnabled;

  if (skill.enabled !== skillShouldBeEnabled) {
    skillsManager.setSkillEnabled(COWORK_MEMORY_SKILL_ID, skillShouldBeEnabled);
    sessionManager?.invalidateSkillsSetup();
  }
}

function sanitizeDiagnosticBaseUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.origin}${pathname}`;
  } catch {
    return value.replace(/[?#].*$/, '');
  }
}

async function resolveScheduledTaskTitle(
  prompt: string,
  _cwd?: string,
  fallbackTitle?: string
): Promise<string> {
  const normalizedPrompt = prompt.trim();
  const fallback = fallbackTitle
    ? buildScheduledTaskTitle(fallbackTitle)
    : buildScheduledTaskFallbackTitle(normalizedPrompt);
  if (!sessionManager) {
    return fallback;
  }
  try {
    return await sessionManager.generateScheduledTaskTitle(normalizedPrompt);
  } catch (error) {
    logWarn('[Schedule] Failed to generate title via session title flow, using fallback', error);
    return fallback;
  }
}

async function waitForDevServer(url: string, maxAttempts = 30, intervalMs = 500): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        if (attempt > 1) {
          log(`[App] Dev server ready after ${attempt} attempt(s): ${url}`);
        }
        return true;
      }
    } catch {
      // Ignore and retry until timeout
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  logWarn(`[App] Dev server did not become ready within timeout: ${url}`);
  return false;
}

// Single-instance lock: skip in dev mode so vite-plugin-electron can restart freely
// without the old process blocking the new one during async cleanup.
const isDev = !!process.env.VITE_DEV_SERVER_URL;
const ELECTRON_DEVTOOLS_DEBUG_PORT = '9223';

// Enable Chrome DevTools Protocol in dev mode so the renderer can be inspected
// via chrome://inspect or connected to by Puppeteer/Playwright at localhost:9223.
// Chrome MCP uses 9222, so keep Electron on a separate port in development.
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', ELECTRON_DEVTOOLS_DEBUG_PORT);
  app.commandLine.appendSwitch(
    'remote-allow-origins',
    `http://localhost:${ELECTRON_DEVTOOLS_DEBUG_PORT}`
  );
}

const hasSingleInstanceLock = isDev || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  logWarn('[App] Another instance is already running, quitting this instance');
  app.quit();
} else if (!isDev) {
  app.on('second-instance', () => {
    const existingWindow =
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());

    if (!existingWindow) {
      log('[App] No existing window found, creating new one');
      createWindow();
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = existingWindow;
    }
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
    log('[App] Blocked second instance and focused existing window');
  });
}

// Tray instance (kept alive to prevent GC)
let tray: Tray | null = null;
const DARK_BG = '#171614';
const LIGHT_BG = '#f5f3ee';

function buildMacMenu() {
  if (process.platform !== 'darwin') return;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () =>
            mainWindow?.webContents.send('server-event', { type: 'navigate', payload: 'settings' }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupTray() {
  if (tray) return;

  // Use .ico on Windows for proper multi-resolution tray support; fall back to .png if absent
  const iconName =
    process.platform === 'darwin'
      ? 'tray-iconTemplate.png'
      : process.platform === 'win32'
        ? 'tray-icon.ico'
        : 'tray-icon.png';
  // TODO: create resources/tray-icon.ico from tray-icon.png for full Windows tray fidelity
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, iconName)
    : join(__dirname, '../../resources', iconName);

  // On Windows, fall back to .png if the .ico file has not been created yet
  const resolvedIconPath =
    process.platform === 'win32' && !fs.existsSync(iconPath)
      ? app.isPackaged
        ? join(process.resourcesPath, 'tray-icon.png')
        : join(__dirname, '../../resources', 'tray-icon.png')
      : iconPath;

  // Gracefully skip tray if icon is missing (e.g. dev environment)
  if (!fs.existsSync(resolvedIconPath)) {
    log('[Tray] Icon not found at', resolvedIconPath, '— skipping tray setup');
    return;
  }

  tray = new Tray(resolvedIconPath);
  tray.setToolTip('Open Cowork');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide Window',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow();
        } else if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'New Session',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('server-event', { type: 'new-session' });
        }
      },
    },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('server-event', { type: 'navigate', payload: 'settings' });
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getSavedThemePreference(): AppTheme {
  const theme = configStore.get('theme');
  return theme === 'dark' || theme === 'system' ? theme : 'light';
}

function resolveEffectiveTheme(theme: AppTheme): 'dark' | 'light' {
  if (theme === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }
  return theme;
}

function applyNativeThemePreference(theme: AppTheme): void {
  nativeTheme.themeSource = theme;
}

function createWindow() {
  const savedTheme = getSavedThemePreference();
  applyNativeThemePreference(savedTheme);
  const effectiveTheme = resolveEffectiveTheme(savedTheme);
  const THEME =
    effectiveTheme === 'dark'
      ? {
          background: DARK_BG,
          titleBar: DARK_BG,
          titleBarSymbol: '#f1ece4',
        }
      : {
          background: LIGHT_BG,
          titleBar: LIGHT_BG,
          titleBarSymbol: '#1a1a1a',
        };

  // Platform-specific window configuration
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  // Base window options
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: THEME.background,
    icon: (() => {
      const windowIconName = isMac ? 'icon.icns' : isWindows ? 'icon.ico' : 'icon.png';
      return app.isPackaged
        ? join(process.resourcesPath, windowIconName)
        : join(__dirname, `../../resources/${windowIconName}`);
    })(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  };

  if (isMac) {
    // macOS: Use hiddenInset for native traffic light buttons
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 12 };
  } else if (isWindows) {
    // Windows: Use frameless window with custom titlebar
    // Note: frame: false removes native frame, allowing custom titlebar
    windowOptions.frame = false;
  } else {
    // Linux: Use frameless window
    windowOptions.frame = false;
  }

  mainWindow = new BrowserWindow(windowOptions);

  const allowedOrigins = new Set<string>();
  if (process.env.VITE_DEV_SERVER_URL) {
    try {
      allowedOrigins.add(new URL(process.env.VITE_DEV_SERVER_URL).origin);
    } catch {
      // 忽略无效的开发服务地址
    }
  }
  const allowedProtocols = new Set<string>(['file:', 'devtools:']);

  const isExternalUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      if (allowedProtocols.has(parsed.protocol)) {
        return false;
      }
      if (allowedOrigins.has(parsed.origin)) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  const extractLocalPathFromNavigationUrl = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') {
        return localPathFromFileUrl(url);
      }
      if (!allowedOrigins.has(parsed.origin)) {
        return null;
      }
      return localPathFromAppUrlPathname(parsed.pathname || '');
    } catch {
      return null;
    }
  };

  async function revealNavigationTarget(url: string): Promise<boolean> {
    const localPath = extractLocalPathFromNavigationUrl(url);
    if (!localPath) {
      return false;
    }
    return revealFileInFolder(localPath);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const localPath = extractLocalPathFromNavigationUrl(url);
    if (localPath) {
      void revealNavigationTarget(url);
      return { action: 'deny' };
    }
    if (isExternalUrl(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const localPath = extractLocalPathFromNavigationUrl(url);
    if (localPath) {
      event.preventDefault();
      void revealNavigationTarget(url);
      return;
    }
    if (isExternalUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    void (async () => {
      await waitForDevServer(devServerUrl, 40, 500);
      if (!mainWindow || mainWindow.isDestroyed()) return;

      try {
        await mainWindow.loadURL(devServerUrl);
      } catch (error) {
        logError('[App] Failed to load dev server URL:', error);
      }
    })();
    // mainWindow.webContents.openDevTools(); // Commented out - open manually with Cmd+Option+I if needed
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Notify renderer about config status after window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    const isConfigured = configStore.isConfigured();
    log('[Config] Notifying renderer, isConfigured:', isConfigured);
    sendToRenderer({
      type: 'config.status',
      payload: {
        isConfigured,
        config: configStore.getAll(),
      },
    });

    // Send current working directory to renderer
    sendToRenderer({
      type: 'workdir.changed',
      payload: { path: currentWorkingDir || '' },
    });

    // Start sandbox bootstrap after window is loaded
    startSandboxBootstrap();
  });
}

/**
 * Initialize default working directory
 * This is always the app's default_working_dir in userData - it never changes
 * Each session can have its own cwd that differs from this default
 */
function initializeDefaultWorkingDir(): string {
  // Create default working directory in user data path (this is the permanent global default)
  const userDataPath = app.getPath('userData');
  const defaultDir = join(userDataPath, 'default_working_dir');

  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
    log('[App] Created default working directory:', defaultDir);
  }

  currentWorkingDir = defaultDir;

  log('[App] Global default working directory:', currentWorkingDir);
  return currentWorkingDir;
}

/**
 * Get current working directory
 */
function getWorkingDir(): string | null {
  return currentWorkingDir;
}

function getWorkspacePathUnsupportedReason(workspacePath?: string): string | null {
  return getUnsupportedWorkspacePathReason({
    platform: process.platform,
    sandboxEnabled: configStore.get('sandboxEnabled') !== false,
    workspacePath,
  });
}

/**
 * Set working directory
 * - If sessionId is provided: update only that session's cwd (for switching directories within a chat)
 * - If no sessionId: update UI display only (for WelcomeView - will be used when creating new session)
 *
 * Note: The global default (currentWorkingDir) is NEVER changed after initialization.
 * It is always app.getPath('userData')/default_working_dir
 */
async function setWorkingDir(
  newDir: string,
  sessionId?: string
): Promise<{ success: boolean; path: string; error?: string }> {
  const unsupportedReason = getWorkspacePathUnsupportedReason(newDir);
  if (unsupportedReason) {
    return { success: false, path: newDir, error: unsupportedReason };
  }

  if (!fs.existsSync(newDir)) {
    return { success: false, path: newDir, error: 'Directory does not exist' };
  }

  if (sessionId && sessionManager) {
    // Update only this session's cwd - don't change the global default
    log('[App] Updating session cwd:', sessionId, '->', newDir);
    sessionManager.updateSessionCwd(sessionId, newDir);

    // Clear this session's sandbox mapping so next query uses the new directory
    SandboxSync.clearSession(sessionId);
    const { LimaSync } = await import('./sandbox/lima-sync');
    LimaSync.clearSession(sessionId);
  }

  // Notify renderer of workdir change (for UI display)
  // This updates what the user sees, and will be passed to startSession for new sessions
  sendToRenderer({
    type: 'workdir.changed',
    payload: { path: newDir },
  });

  log(
    '[App] Working directory for UI updated:',
    newDir,
    sessionId ? `(session: ${sessionId})` : '(pending new session)'
  );

  return { success: true, path: newDir };
}

/**
 * Start sandbox bootstrap in the background
 * This pre-initializes WSL/Lima environment at app startup
 */
async function startSandboxBootstrap(): Promise<void> {
  // Skip sandbox bootstrap if disabled - use native mode directly
  const sandboxEnabled = configStore.get('sandboxEnabled');
  if (sandboxEnabled === false) {
    log('[App] Sandbox disabled, skipping bootstrap (using native mode)');
    return;
  }

  const bootstrap = getSandboxBootstrap();

  // Skip if already complete
  if (bootstrap.isComplete()) {
    log('[App] Sandbox bootstrap already complete');
    return;
  }

  // Set up progress callback to notify renderer
  bootstrap.setProgressCallback((progress) => {
    sendToRenderer({
      type: 'sandbox.progress',
      payload: progress,
    });
  });

  // Start bootstrap (non-blocking)
  log('[App] Starting sandbox bootstrap...');
  try {
    const result = await bootstrap.bootstrap();
    log('[App] Sandbox bootstrap complete:', result.mode);
  } catch (error) {
    logError('[App] Sandbox bootstrap error:', error);
  }
}

// 发送事件到渲染进程（含远程会话拦截）
function sendToRenderer(event: ServerEvent) {
  const payload =
    'payload' in event
      ? (event.payload as { sessionId?: string; [key: string]: unknown })
      : undefined;
  const sessionId = payload?.sessionId;

  // 判断是否远程会话
  if (sessionId && remoteManager.isRemoteSession(sessionId)) {
    // 处理远程会话事件

    // 拦截 stream.message，用于回传到远程通道
    if (event.type === 'stream.message') {
      const message = payload.message as {
        role?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      if (message?.role === 'assistant' && message?.content) {
        // 提取助手文本内容
        const textContent = message.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');

        if (textContent) {
          // 发送到远程通道（带缓冲）
          remoteManager.sendResponseToChannel(sessionId, textContent).catch((err: Error) => {
            logError('[Remote] Failed to send response to channel:', err);
          });
        }
      }
    }

    // 拦截 trace.step 作为工具进度
    if (event.type === 'trace.step') {
      const step = payload.step as {
        type?: string;
        toolName?: string;
        status?: string;
        title?: string;
      };
      if (step?.type === 'tool_call' && step?.toolName) {
        remoteManager
          .sendToolProgress(
            sessionId,
            step.toolName,
            step.status === 'completed'
              ? 'completed'
              : step.status === 'error'
                ? 'error'
                : 'running'
          )
          .catch((err: Error) => {
            logError('[Remote] Failed to send tool progress:', err);
          });
      }
    }

    // trace.update 预留；当前主要用 trace.step

    // 拦截 session.status 用于清理
    if (event.type === 'session.status') {
      const status = payload.status as string;
      if (status === 'idle' || status === 'error') {
        // 会话结束，清空缓冲
        remoteManager.clearSessionBuffer(sessionId).catch((err: Error) => {
          logError('[Remote] Failed to clear session buffer:', err);
        });
      }
    }

    // 拦截 permission.request
    if (event.type === 'permission.request' && payload.toolUseId && payload.toolName) {
      log('[Remote] Intercepting permission for remote session:', sessionId);
      remoteManager
        .handlePermissionRequest(
          sessionId,
          payload.toolUseId as string,
          payload.toolName as string,
          (payload.input as Record<string, unknown> | undefined) ?? {}
        )
        .then((result) => {
          if (result !== null && sessionManager) {
            let permissionResult: 'allow' | 'deny' | 'allow_always';
            if (result.allow) {
              permissionResult = result.remember ? 'allow_always' : 'allow';
            } else {
              permissionResult = 'deny';
            }
            sessionManager.handlePermissionResponse(payload.toolUseId as string, permissionResult);
          }
        })
        .catch((err) => {
          logError('[Remote] Failed to handle permission request:', err);
        });
      return; // 不发送到本地 UI
    }
  }

  // 发送到本地 UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-event', event);
  }
}

// Initialize app
app
  .whenReady()
  .then(async () => {
    // Smoke test mode: verify the app can start, then exit cleanly
    if (process.argv.includes('--smoke-test')) {
      log('[SmokeTest] App launched successfully in smoke test mode');
      log('[SmokeTest] Platform:', process.platform, 'Arch:', process.arch);
      log('[SmokeTest] Electron:', process.versions.electron, 'Node:', process.versions.node);
      try {
        // Verify critical native modules load
        require('better-sqlite3');
        log('[SmokeTest] better-sqlite3: OK');
      } catch (e) {
        log('[SmokeTest] FAIL: better-sqlite3 failed to load:', e);
        process.exit(1);
      }
      log('[SmokeTest] PASSED');
      process.exit(0);
    }

    // Apply dev logs setting from config
    const enableDevLogs = configStore.get('enableDevLogs');
    setDevLogsEnabled(enableDevLogs);

    // Hydrate the bash trust/deny lists from persisted config so the
    // authoritative-mode policy is active before the renderer has a chance
    // to send its bootstrap `settings.update`. Closes the startup race
    // window where list control would otherwise be skipped.
    setBashCommandLists(configStore.get('bashTrustedCommands'), configStore.get('bashDenylist'));

    // Log environment variables for debugging
    log('=== Open Cowork Starting ===');
    log('Config file:', configStore.getPath());
    log('Is configured:', configStore.isConfigured());
    log('[Runtime] Using pi-coding-agent SDK for all providers');
    log('Developer logs:', enableDevLogs ? 'Enabled' : 'Disabled');
    log('Environment Variables:');
    log('  ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? '✓ Set' : '✗ Not set');
    log('  ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL || '(not set)');
    log('  CLAUDE_MODEL:', process.env.CLAUDE_MODEL || '(not set)');
    log('  CLAUDE_CODE_PATH:', process.env.CLAUDE_CODE_PATH || '(not set)');
    log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✓ Set' : '✗ Not set');
    log('  OPENAI_BASE_URL:', process.env.OPENAI_BASE_URL || '(not set)');
    log('  OPENAI_MODEL:', process.env.OPENAI_MODEL || '(not set)');
    log('  OPENAI_API_MODE:', process.env.OPENAI_API_MODE || '(default)');
    log('===========================');

    // Initialize default working directory
    initializeDefaultWorkingDir();
    log('Working directory:', currentWorkingDir);
    // 远程会话默认使用全局工作目录
    remoteManager.setDefaultWorkingDirectory(currentWorkingDir || undefined);

    // Initialize database
    const db = initDatabase();

    pluginRuntimeService = new PluginRuntimeService(new PluginCatalogService());
    memoryService = new MemoryService(db);
    const extensionManager = new AgentRuntimeExtensionManager([new MemoryExtension(memoryService)]);

    // Initialize session manager before creating an interactive window.
    // This avoids session.start racing the startup path and hitting a null manager.
    sessionManager = new SessionManager(db, sendToRenderer, pluginRuntimeService, extensionManager);
    skillsManager = new SkillsManager(db, {
      getConfiguredGlobalSkillsPath: () => configStore.get('globalSkillsPath') || '',
      setConfiguredGlobalSkillsPath: (nextPath: string) => {
        configStore.update({ globalSkillsPath: nextPath });
      },
      watchStorage: true,
    });
    skillsManager.onStorageChanged((event) => {
      sendToRenderer({
        type: 'skills.storageChanged',
        payload: event,
      });
      // Re-sync cowork-memory skill state when skills are reloaded/installed/changed.
      syncCoworkMemorySkillState(memoryService!.isEnabled()).catch((err) => {
        logWarn('[Memory] Failed to sync cowork-memory skill state after storage change:', err);
      });
    });

    // Sync cowork-memory skill state with in-app memory toggle on startup.
    // When in-app memory is enabled, the skill is redundant (the MemoryExtension
    // handles ingestion/retrieval automatically). Disable it to avoid confusion.
    syncCoworkMemorySkillState(memoryService.isEnabled()).catch((err) => {
      logWarn('[Memory] Failed to sync cowork-memory skill state on startup:', err);
    });
    // pi-ai handles model routing natively — no proxy warmup needed

    // macOS: application menu, dock menu, tray icon
    buildMacMenu();
    setupTray();

    // Show window after core managers are ready so first-load actions can be handled.
    ensurePromptFiles();
    createWindow();

    // macOS: dock menu
    if (process.platform === 'darwin') {
      const dockMenu = Menu.buildFromTemplate([
        {
          label: 'New Session',
          click: () => mainWindow?.webContents.send('server-event', { type: 'new-session' }),
        },
        {
          label: 'Settings',
          click: () =>
            mainWindow?.webContents.send('server-event', { type: 'navigate', payload: 'settings' }),
        },
      ]);
      app.dock?.setMenu(dockMenu);
    }

    // macOS: send initial system theme to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.on('did-finish-load', () => {
        sendToRenderer({
          type: 'native-theme.changed',
          payload: { shouldUseDarkColors: nativeTheme.shouldUseDarkColors },
        });
      });
    }

    // Listen for system theme changes
    nativeTheme.on('updated', () => {
      sendToRenderer({
        type: 'native-theme.changed',
        payload: { shouldUseDarkColors: nativeTheme.shouldUseDarkColors },
      });
      if (getSavedThemePreference() === 'system' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG);
      }
    });

    // Auto-updater: check for updates in production
    if (!isDev) {
      import('electron-updater')
        .then(({ autoUpdater }) => {
          autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
            log('[AutoUpdater] Update check failed:', err);
          });
        })
        .catch((err: unknown) => {
          log('[AutoUpdater] Failed to load electron-updater:', err);
        });
    }

    startNavServer(() => mainWindow);

    const scheduledTaskStore = createScheduledTaskStore(db);
    const scheduledTaskRunStore = createScheduledTaskRunStore(db);
    scheduledTaskManager = new ScheduledTaskManager({
      store: scheduledTaskStore,
      runStore: scheduledTaskRunStore,
      executeTask: async (task) => {
        if (!sessionManager) {
          throw new Error('Session manager not initialized');
        }
        const unsupportedReason = getWorkspacePathUnsupportedReason(task.cwd);
        if (unsupportedReason) {
          throw new Error(unsupportedReason);
        }
        const fallbackTitle = buildScheduledTaskFallbackTitle(task.prompt);
        const needsRegeneratedTitle = !task.title?.trim() || task.title === fallbackTitle;
        const title = needsRegeneratedTitle
          ? await resolveScheduledTaskTitle(task.prompt, task.cwd, task.title)
          : buildScheduledTaskTitle(task.title);
        if (title !== task.title) {
          scheduledTaskStore.update(task.id, { title });
        }
        const started = await sessionManager.startSession(title, task.prompt, task.cwd);
        // v2: Mark session as autonomous if task uses auto execution mode
        if (task.executionMode === 'auto') {
          markSessionAutonomous(started.id);
          scheduledSessionToTaskId.set(started.id, task.id);
        }
        // 定时任务创建的新会话需要主动同步到前端会话列表
        sendToRenderer({
          type: 'session.update',
          payload: { sessionId: started.id, updates: started },
        });
        return { sessionId: started.id };
      },
      onTaskError: (taskId, error) => {
        sendToRenderer({
          type: 'scheduled-task.error',
          payload: { taskId, error },
        });
      },
      getSchedulerSettings: () => ({
        catchUpPolicy: configStore.get('schedulerCatchUpPolicy') as
          | 'skip'
          | 'run-once'
          | 'run-all'
          | 'ask',
        conflictPolicy: configStore.get('schedulerConflictPolicy') as 'queue' | 'skip-if-busy',
        runHistoryDepth: configStore.get('schedulerRunHistoryDepth') as number,
      }),
      isConfigSetValid: (configSetId: string) => {
        const config = configStore.getAll();
        return config.configSets.some((set) => set.id === configSetId);
      },
      isAgentBusy: () => {
        return sessionManager?.isAgentActive() ?? false;
      },
      onCatchUp: (tasks) => {
        sendToRenderer({
          type: 'scheduled-task.catch-up',
          payload: { tasks },
        });
      },
      onTaskStarted: (taskId, runId, sessionId) => {
        sendToRenderer({
          type: 'scheduled-task.started',
          payload: { taskId, runId, sessionId },
        });
      },
      onTaskCompleted: (taskId, runId, status, tokensUsed) => {
        sendToRenderer({
          type: 'scheduled-task.completed',
          payload: { taskId, runId, status, tokensUsed },
        });
        // Clean up all session→task mappings and autonomous state for this completed task
        for (const [sessionId, mappedTaskId] of scheduledSessionToTaskId.entries()) {
          if (mappedTaskId === taskId) {
            forgetSessionPermissions(sessionId);
            scheduledSessionToTaskId.delete(sessionId);
          }
        }
      },
      onConfigInvalid: (taskId, configSetId) => {
        sendToRenderer({
          type: 'scheduled-task.config-invalid',
          payload: { taskId, configSetId, error: `Config set '${configSetId}' no longer exists` },
        });
      },
      onBudgetExceeded: (taskId, runId, budgetType) => {
        sendToRenderer({
          type: 'scheduled-task.budget-exceeded',
          payload: { taskId, runId, budgetType },
        });
      },
      now: () => Date.now(),
    });

    // v2: Set up autonomous block callback BEFORE starting scheduler
    // to avoid missing blocked-command events during catch-up runs
    setAutonomousBlockCallback((sessionId, toolName, command) => {
      log(`[Scheduler] Autonomous block: session=${sessionId} tool=${toolName} cmd=${command}`);
      const taskId = scheduledSessionToTaskId.get(sessionId);
      if (taskId) {
        sendToRenderer({
          type: 'scheduled-task.error',
          payload: {
            taskId,
            error: `Command blocked in autonomous mode: ${toolName} — ${command}`,
          },
        });
      }
    });

    scheduledTaskManager.start();

    // 初始化远程管理器
    remoteManager.setRendererCallback(sendToRenderer);
    const agentExecutor: AgentExecutor = {
      startSession: async (title, prompt, cwd) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
        if (unsupportedReason) {
          throw new Error(unsupportedReason);
        }
        return sessionManager.startSession(title, prompt, cwd);
      },
      continueSession: async (sessionId, prompt, content, cwd) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        if (cwd) {
          const result = await setWorkingDir(cwd, sessionId);
          if (!result.success) {
            throw new Error(result.error || 'Failed to update working directory');
          }
        }
        await sessionManager.continueSession(sessionId, prompt, content);
      },
      stopSession: async (sessionId) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        await sessionManager.stopSession(sessionId);
      },
      validateWorkingDirectory: async (cwd) => {
        const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
        if (unsupportedReason) {
          return unsupportedReason;
        }
        if (!fs.existsSync(cwd)) {
          return 'Directory does not exist';
        }
        return null;
      },
    };
    remoteManager.setAgentExecutor(agentExecutor);

    // 远程控制启用时启动
    if (remoteConfigStore.isEnabled()) {
      remoteManager.start().catch((error) => {
        logError('[App] Failed to start remote control:', error);
      });
    }

    app.on('activate', () => {
      const hasVisibleWindow = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
      if (!hasVisibleWindow) {
        createWindow();
      }
    });
  })
  .catch((error) => {
    logError('[App] Startup failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    dialog.showErrorBox('Open Cowork 启动失败', `${message}\n\n请查看日志获取更多信息。`);
    app.quit();
  });

// Flag to prevent double cleanup
let isCleaningUp = false;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
}

/**
 * Cleanup all sandbox resources
 * Called on app quit (both Windows and macOS)
 */
async function cleanupSandboxResources(): Promise<void> {
  if (isCleaningUp) {
    log('[App] Cleanup already in progress, skipping...');
    return;
  }
  isCleaningUp = true;

  stopNavServer();
  skillsManager?.stopStorageMonitoring();
  scheduledTaskManager?.stop();
  scheduledSessionToTaskId.clear();
  tray?.destroy();
  tray = null;

  // 停止远程控制
  try {
    log('[App] Stopping remote control...');
    await withTimeout(remoteManager.stop(), 5000, 'Remote control shutdown');
    log('[App] Remote control stopped');
  } catch (error) {
    logError('[App] Error stopping remote control:', error);
  }

  // Cleanup all sandbox sessions (sync changes back to host OS first)
  try {
    log('[App] Cleaning up all sandbox sessions...');

    // Cleanup WSL sessions
    await withTimeout(SandboxSync.cleanupAllSessions(), 30000, 'WSL session cleanup');

    // Cleanup Lima sessions
    const { LimaSync } = await import('./sandbox/lima-sync');
    await withTimeout(LimaSync.cleanupAllSessions(), 30000, 'Lima session cleanup');

    log('[App] Sandbox sessions cleanup complete');
  } catch (error) {
    logError('[App] Error cleaning up sandbox sessions:', error);
  }

  // Shutdown sandbox adapter
  try {
    await withTimeout(shutdownSandbox(), 8000, 'Sandbox shutdown');
    log('[App] Sandbox shutdown complete');
  } catch (error) {
    logError('[App] Error shutting down sandbox:', error);
  }

  // Shutdown MCP servers
  try {
    const mcpManager = sessionManager?.getMCPManager();
    if (mcpManager) {
      log('[App] Shutting down MCP servers...');
      await withTimeout(mcpManager.shutdown(), 5000, 'MCP shutdown');
      log('[App] MCP servers shutdown complete');
    }
  } catch (error) {
    logError('[App] Error shutting down MCP servers:', error);
  }

  try {
    closeDatabase();
  } catch (error) {
    logError('[App] Error closing database:', error);
  }

  closeLogFile();

  // pi-ai doesn't need proxy shutdown
}

// Handle app quit - window-all-closed (primary for Windows/Linux)
app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin' || process.env.VITE_DEV_SERVER_URL) {
    // On Windows/Linux, closing all windows means quit.
    // On macOS dev mode, also quit — so vite-plugin-electron can restart cleanly
    // without the old process holding the single-instance lock.
    await cleanupSandboxResources();
    app.quit();
  }
  // On macOS production, keep app alive — cleanup happens in before-quit
});

// Handle SIGTERM/SIGINT (e.g. pkill) — route through app.quit() for clean shutdown
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => app.quit());
}

// Handle app quit - before-quit (for macOS Cmd+Q and other quit methods)
app.on('before-quit', async (event) => {
  if (!isCleaningUp) {
    // In dev mode, exit quickly — no need for async sandbox cleanup
    if (process.env.VITE_DEV_SERVER_URL) {
      stopNavServer();
      try {
        closeDatabase();
      } catch {
        /* best-effort */
      }
      closeLogFile();
      tray?.destroy();
      tray = null;
      return;
    }
    // Set the flag immediately before any await to prevent re-entrant cleanup
    isCleaningUp = true;
    event.preventDefault();
    try {
      await cleanupSandboxResources();
    } catch (error) {
      logError('[App] before-quit cleanup failed, forcing quit:', error);
    }
    app.quit();
  }
});

// IPC Handlers
ipcMain.on('client-event', async (_event, data: ClientEvent) => {
  try {
    await handleClientEvent(data);
  } catch (error) {
    logError('Error handling client event:', error);
    sendToRenderer({
      type: 'error',
      payload: { message: error instanceof Error ? error.message : 'Unknown error' },
    });
  }
});

ipcMain.handle('client-invoke', async (_event, data: ClientEvent) => {
  return handleClientEvent(data);
});

ipcMain.handle('get-version', () => {
  try {
    return app.getVersion();
  } catch (error) {
    logError('[IPC] Error getting version:', error);
    return 'unknown';
  }
});

ipcMain.handle('system.getTheme', () => {
  try {
    return { shouldUseDarkColors: nativeTheme.shouldUseDarkColors };
  } catch (error) {
    logError('[IPC] Error getting theme:', error);
    return { shouldUseDarkColors: true };
  }
});

ipcMain.handle('shell.openExternal', async (_event, url: string) => {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      logWarn('[shell.openExternal] Blocked URL with disallowed protocol:', parsed.protocol);
      return false;
    }
  } catch {
    logWarn('[shell.openExternal] Blocked invalid URL:', url);
    return false;
  }

  return shell.openExternal(url);
});

// Detect installed web browsers (macOS: mdfind by bundle ID)
// Uses a single mdfind query, async execution, in-memory cache, request
// coalescing, and bounded mdls concurrency to avoid blocking the main process.
const KNOWN_BROWSER_IDS: Array<{ bundleId: string; name: string }> = [
  { bundleId: 'com.apple.Safari', name: 'Safari' },
  { bundleId: 'com.google.Chrome', name: 'Google Chrome' },
  { bundleId: 'com.google.Chrome.canary', name: 'Google Chrome Canary' },
  { bundleId: 'org.mozilla.firefox', name: 'Firefox' },
  { bundleId: 'org.mozilla.firefoxdeveloperedition', name: 'Firefox Developer Edition' },
  { bundleId: 'com.microsoft.edgemac', name: 'Microsoft Edge' },
  { bundleId: 'com.brave.Browser', name: 'Brave Browser' },
  { bundleId: 'com.operasoftware.Opera', name: 'Opera' },
  { bundleId: 'com.vivaldi.Vivaldi', name: 'Vivaldi' },
  { bundleId: 'company.thebrowser.Browser', name: 'Arc' },
  { bundleId: 'org.chromium.Chromium', name: 'Chromium' },
  { bundleId: 'org.waterfoxproject.waterfox', name: 'Waterfox' },
  { bundleId: 'app.zen-browser.zen', name: 'Zen Browser' },
];

// Lookup map: bundleId → display name
const BROWSER_NAME_MAP = new Map(KNOWN_BROWSER_IDS.map((b) => [b.bundleId, b.name]));

// Set of allowed bundle IDs for validation
const ALLOWED_BROWSER_BUNDLE_IDS = new Set(KNOWN_BROWSER_IDS.map((b) => b.bundleId));

// Cache for browser discovery (TTL: 5 minutes — browsers don't change often)
let browserCache: {
  browsers: Array<{ bundleId: string; name: string }>;
  timestamp: number;
} | null = null;
const BROWSER_CACHE_TTL_MS = 300_000;

// Request coalescing: if a discovery is already in-flight, share the promise
let inFlightDiscovery: Promise<Array<{ bundleId: string; name: string }>> | null = null;

const execFileAsync = promisify(execFile);

// Bounded concurrency helper (avoids spawning too many child processes)
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function discoverInstalledBrowsers(): Promise<Array<{ bundleId: string; name: string }>> {
  if (process.platform !== 'darwin') {
    return [];
  }

  // Return cached result if still fresh
  if (browserCache && Date.now() - browserCache.timestamp < BROWSER_CACHE_TTL_MS) {
    return browserCache.browsers;
  }

  // Coalesce concurrent requests into a single discovery pass
  if (inFlightDiscovery) {
    return inFlightDiscovery;
  }

  inFlightDiscovery = (async () => {
    try {
      // Single mdfind query scoped to .app bundles in standard app directories.
      // The kind restriction and OR-based bundle ID filter keeps results minimal.
      const conditions = KNOWN_BROWSER_IDS.map(
        (b) => `kMDItemCFBundleIdentifier == "${b.bundleId}"`
      );
      const query = `(${conditions.join(' || ')}) && kMDItemContentType == "com.apple.application-bundle"`;

      const { stdout } = await execFileAsync(
        'mdfind',
        ['-onlyin', '/Applications', '-onlyin', '/System/Applications', query],
        { encoding: 'utf-8', timeout: 10_000 }
      );

      const lines = stdout.trim().split('\n').filter(Boolean);

      if (lines.length === 0) {
        browserCache = { browsers: [], timestamp: Date.now() };
        return [];
      }

      // Deduplicate paths (same app can appear from multiple Spotlight entries)
      const uniquePaths = [...new Set(lines)];

      // Use mdls to extract bundle IDs with bounded concurrency (max 4 at a time)
      const mdlsResults = await mapWithConcurrency(uniquePaths, 4, async (appPath) => {
        const { stdout: mdlsOut } = await execFileAsync(
          'mdls',
          ['-name', 'kMDItemCFBundleIdentifier', '-raw', appPath],
          { encoding: 'utf-8', timeout: 3000 }
        );
        return { bundleId: mdlsOut.trim() };
      });

      const found: Array<{ bundleId: string; name: string }> = [];
      const seen = new Set<string>();
      for (const result of mdlsResults) {
        if (result.status === 'fulfilled') {
          const { bundleId } = result.value;
          const name = BROWSER_NAME_MAP.get(bundleId);
          if (name && !seen.has(bundleId)) {
            seen.add(bundleId);
            found.push({ bundleId, name });
          }
        }
      }

      // Sort to match the order in KNOWN_BROWSER_IDS (familiar ordering)
      const orderMap = new Map(KNOWN_BROWSER_IDS.map((b, i) => [b.bundleId, i]));
      found.sort((a, b) => (orderMap.get(a.bundleId) ?? 99) - (orderMap.get(b.bundleId) ?? 99));

      // Update cache
      browserCache = { browsers: found, timestamp: Date.now() };
      return found;
    } finally {
      inFlightDiscovery = null;
    }
  })();

  return inFlightDiscovery;
}

ipcMain.handle('shell.getInstalledBrowsers', async () => {
  try {
    return await discoverInstalledBrowsers();
  } catch (error) {
    logWarn('[shell.getInstalledBrowsers] Discovery failed:', error);
    return [];
  }
});

// Open a URL in a specific browser by bundle ID (macOS)
ipcMain.handle('shell.openUrlInBrowser', async (_event, url: string, bundleId: string) => {
  if (!url || !bundleId) {
    return false;
  }

  // Validate bundle ID against allowlist (prevent launching arbitrary apps)
  if (!ALLOWED_BROWSER_BUNDLE_IDS.has(bundleId)) {
    logWarn('[shell.openUrlInBrowser] Blocked unknown bundle ID:', bundleId);
    return false;
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      logWarn('[shell.openUrlInBrowser] Blocked URL with disallowed protocol:', parsed.protocol);
      return false;
    }
  } catch {
    logWarn('[shell.openUrlInBrowser] Blocked invalid URL:', url);
    return false;
  }

  if (process.platform !== 'darwin') {
    // Fallback to default browser on non-macOS
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  }

  try {
    await execFileAsync('open', ['-b', bundleId, url], { timeout: 5000 });
    return true;
  } catch (error) {
    logWarn('[shell.openUrlInBrowser] Failed to open URL in browser:', error);
    return false;
  }
});

async function revealFileInFolder(filePath: string, cwd?: string): Promise<boolean> {
  if (!filePath) {
    return false;
  }

  const trimInput = filePath.trim();
  if (!trimInput) {
    return false;
  }

  let normalizedPath = decodePathSafely(trimInput);

  if (normalizedPath.startsWith('file://')) {
    const localPath = localPathFromFileUrl(normalizedPath);
    if (!localPath) {
      logWarn('[shell.showItemInFolder] could not parse file URL:', normalizedPath);
      return false;
    }
    normalizedPath = localPath;
  }

  const baseDir = cwd && isAbsolute(cwd) ? cwd : getWorkingDir() || app.getPath('home');
  if (
    !isAbsolute(normalizedPath) &&
    !isWindowsDrivePath(normalizedPath) &&
    !isUncPath(normalizedPath)
  ) {
    normalizedPath = resolve(baseDir, normalizedPath);
  }

  if (
    normalizedPath.startsWith('/workspace/') ||
    /^[A-Za-z]:[/\\]workspace[/\\]/i.test(normalizedPath)
  ) {
    const relativePart = normalizedPath.startsWith('/workspace/')
      ? normalizedPath.slice('/workspace/'.length)
      : normalizedPath.replace(/^[A-Za-z]:[/\\]workspace[/\\]/i, '');
    normalizedPath = resolve(baseDir, relativePart);
  }

  if (!isUncPath(normalizedPath)) {
    normalizedPath = resolve(normalizedPath);
  }
  log('[shell.showItemInFolder] request:', { filePath, cwd, resolved: normalizedPath });

  const findFileByName = (fileName: string, roots: string[]): string | null => {
    if (!fileName) {
      return null;
    }

    const visited = new Set<string>();
    const queue = roots
      .map((root) => resolve(root))
      .filter((root) => !!root && fs.existsSync(root) && fs.statSync(root).isDirectory());

    let scannedDirs = 0;
    const MAX_DIRS = 2000;

    while (queue.length > 0 && scannedDirs < MAX_DIRS) {
      const dir = queue.shift()!;
      if (visited.has(dir)) {
        continue;
      }
      visited.add(dir);
      scannedDirs += 1;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName) {
          return fullPath;
        }
        if (entry.isDirectory()) {
          queue.push(fullPath);
        }
      }
    }

    return null;
  };

  try {
    if (fs.existsSync(normalizedPath)) {
      const stat = fs.statSync(normalizedPath);
      if (stat.isDirectory()) {
        const openDirResult = await shell.openPath(normalizedPath);
        if (openDirResult) {
          logWarn('[shell.showItemInFolder] openPath returned warning:', openDirResult);
        }
      } else {
        if (process.platform === 'darwin') {
          try {
            execFileSync('open', ['-R', normalizedPath]);
          } catch (error) {
            logWarn(
              '[shell.showItemInFolder] open -R failed, fallback to shell.showItemInFolder:',
              error
            );
            shell.showItemInFolder(normalizedPath);
          }
        } else {
          shell.showItemInFolder(normalizedPath);
        }
      }
      return true;
    }

    const fileName = basename(normalizedPath);
    const defaultWorkingDir = getWorkingDir() || '';
    const discoveredPath = findFileByName(fileName, [
      cwd || '',
      defaultWorkingDir,
      join(app.getPath('userData'), 'default_working_dir'),
    ]);

    if (discoveredPath) {
      logWarn('[shell.showItemInFolder] resolved path not found, discovered by filename:', {
        requested: normalizedPath,
        discoveredPath,
      });
      if (process.platform === 'darwin') {
        try {
          execFileSync('open', ['-R', discoveredPath]);
        } catch (error) {
          logWarn(
            '[shell.showItemInFolder] open -R discovered file failed, fallback to shell.showItemInFolder:',
            error
          );
          shell.showItemInFolder(discoveredPath);
        }
      } else {
        shell.showItemInFolder(discoveredPath);
      }
      return true;
    }

    const parentDir = dirname(normalizedPath);
    if (parentDir && fs.existsSync(parentDir)) {
      logWarn('[shell.showItemInFolder] file not found, opening parent directory:', parentDir);
      const openParentResult = await shell.openPath(parentDir);
      if (openParentResult) {
        logWarn('[shell.showItemInFolder] openPath parent returned warning:', openParentResult);
      }
      return true;
    }

    logWarn('[shell.showItemInFolder] path and parent directory do not exist:', normalizedPath);
    return false;
  } catch (error) {
    logError('[shell.showItemInFolder] failed:', error);
    return false;
  }
}

ipcMain.handle('shell.showItemInFolder', async (_event, filePath: string, cwd?: string) => {
  return revealFileInFolder(filePath, cwd);
});

ipcMain.handle(
  'artifacts.listRecentFiles',
  async (_event, cwd: string, sinceMs: number, limit: number = 50) => {
    if (!cwd || !isAbsolute(cwd)) {
      return [];
    }
    return listRecentWorkspaceFiles(cwd, sinceMs, limit);
  }
);

ipcMain.handle('dialog.selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Select Files',
  });

  if (result.canceled) {
    return [];
  }

  return result.filePaths;
});

// Config IPC handlers
ipcMain.handle('config.get', () => {
  try {
    return configStore.getAll();
  } catch (error) {
    logError('[Config] Error getting config:', error);
    return {};
  }
});

ipcMain.handle('config.getPresets', () => {
  try {
    return getPiAiModelPresets();
  } catch (error) {
    logError('[Config] Error getting presets:', error);
    return [];
  }
});

const buildAgentRuntimeSignature = (config: AppConfig): string =>
  JSON.stringify({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    customProtocol: config.customProtocol,
    model: config.model,
    enableThinking: config.enableThinking,
    memoryEnabled: config.memoryEnabled,
    memoryRuntime: config.memoryRuntime,
  });

const syncConfigAfterMutation = async (previousConfig: AppConfig) => {
  // Mark as configured if any config set has usable credentials
  configStore.set('isConfigured', configStore.hasAnyUsableCredentials());

  // Apply to environment
  configStore.applyToEnv();

  const updatedConfig = configStore.getAll();
  const shouldReloadRunner =
    buildAgentRuntimeSignature(previousConfig) !== buildAgentRuntimeSignature(updatedConfig);
  const shouldReloadSandbox = previousConfig.sandboxEnabled !== updatedConfig.sandboxEnabled;

  if (sessionManager) {
    if (shouldReloadRunner) {
      sessionManager.reloadConfig();
    }
    if (shouldReloadSandbox) {
      await sessionManager
        .reloadSandbox()
        .catch((err) => logError('[Config] Sandbox reload failed:', err));
    }
    if (shouldReloadRunner || shouldReloadSandbox) {
      log(
        '[Config] Session manager config synced:',
        JSON.stringify({ runnerReloaded: shouldReloadRunner, sandboxReloaded: shouldReloadSandbox })
      );
    }
  }

  // Notify renderer of config update
  const isConfigured = configStore.isConfigured();
  sendToRenderer({
    type: 'config.status',
    payload: {
      isConfigured,
      config: updatedConfig,
    },
  });
  log('[Config] Notified renderer of config update, isConfigured:', isConfigured);
  return updatedConfig;
};

ipcMain.handle('config.save', async (_event, newConfig: Partial<AppConfig>) => {
  log('[Config] Saving config:', {
    ...newConfig,
    apiKey: newConfig.apiKey ? '***' : '',
    memoryRuntime: newConfig.memoryRuntime
      ? {
          ...newConfig.memoryRuntime,
          llm: newConfig.memoryRuntime.llm
            ? {
                ...newConfig.memoryRuntime.llm,
                apiKey: newConfig.memoryRuntime.llm.apiKey ? '***' : '',
              }
            : undefined,
          embedding: newConfig.memoryRuntime.embedding
            ? {
                ...newConfig.memoryRuntime.embedding,
                apiKey: newConfig.memoryRuntime.embedding.apiKey ? '***' : '',
              }
            : undefined,
        }
      : undefined,
  });

  const previousConfig = configStore.getAll();
  // Update config
  configStore.update(newConfig);

  // If localDevPath changed, re-apply it idempotently via centralized utility
  if (
    newConfig.localDevPath !== undefined &&
    newConfig.localDevPath !== previousConfig.localDevPath
  ) {
    if (isBasePathSet()) {
      applyLocalDevPath(newConfig.localDevPath);
    }

    // Invalidate MCP manager's cached env so next server spawn picks up the change
    if (sessionManager) {
      const mcpManager = sessionManager.getMCPManager();
      if (mcpManager) {
        mcpManager.invalidateEnvCache();
      }
    }
  }

  const updatedConfig = await syncConfigAfterMutation(previousConfig);

  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.createSet', async (_event, payload: CreateConfigSetPayload) => {
  log('[Config] Creating config set:', payload);
  const previousConfig = configStore.getAll();
  configStore.createSet(payload);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);
  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.renameSet', async (_event, payload: { id: string; name: string }) => {
  log('[Config] Renaming config set:', payload);
  const previousConfig = configStore.getAll();
  configStore.renameSet(payload);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);
  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.deleteSet', async (_event, payload: { id: string }) => {
  log('[Config] Deleting config set:', payload);
  const previousConfig = configStore.getAll();
  configStore.deleteSet(payload);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);

  // Only invalidate scheduled tasks if the config set actually existed before
  // and is now gone. This prevents false invalidation for non-existent IDs or
  // protected/system sets that deleteSet silently refuses to remove.
  const existedBefore = previousConfig.configSets.some((set) => set.id === payload.id);
  const existsAfter = updatedConfig.configSets.some((set) => set.id === payload.id);
  const wasRemoved = existedBefore && !existsAfter;
  if (wasRemoved && scheduledTaskManager) {
    scheduledTaskManager.handleConfigSetDeleted(payload.id);
  }

  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.switchSet', async (_event, payload: { id: string }) => {
  log('[Config] Switching config set:', payload);
  const previousConfig = configStore.getAll();
  configStore.switchSet(payload);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);
  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.isConfigured', () => {
  try {
    return configStore.isConfigured();
  } catch (error) {
    logError('[Config] Error checking configured status:', error);
    return false;
  }
});

ipcMain.handle('workspace-instructions.getStatus', async (_event, requestedCwd?: string) => {
  try {
    const { loadWorkspaceSystemPrompt, MAX_BYTES } =
      await import('./utils/workspace-system-prompt');
    const choice = configStore.get('systemPromptFile') || '';
    if (!choice) {
      return { configuredFile: '', loaded: false };
    }
    // Use the renderer-provided cwd (session workspace) if given,
    // falling back to the global default only as a last resort.
    const cwd = requestedCwd || currentWorkingDir || undefined;
    const result = await loadWorkspaceSystemPrompt(cwd, choice);
    if (result) {
      const sizeBytes = Buffer.byteLength(result.text, 'utf8');
      return {
        configuredFile: choice,
        loaded: true,
        sizeBytes,
        truncated: sizeBytes >= MAX_BYTES,
        fingerprintShort: result.fingerprint.slice(0, 8),
      };
    }
    return {
      configuredFile: choice,
      loaded: false,
      error: 'File not found or unreadable at workspace root',
    };
  } catch (error) {
    logError('[WorkspaceInstructions] getStatus failed:', error);
    return {
      configuredFile: configStore.get('systemPromptFile') || '',
      loaded: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

ipcMain.handle('config.test', async (_event, payload: ApiTestInput): Promise<ApiTestResult> => {
  try {
    return await runConfigApiTest(payload, configStore.getAll());
  } catch (error) {
    logError('[Config] API test failed:', error);
    return {
      ok: false,
      errorType: 'unknown',
      details: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle(
  'config.listModels',
  async (
    _event,
    payload: { provider: AppConfig['provider']; apiKey: string; baseUrl?: string }
  ): Promise<ProviderModelInfo[]> => {
    if (payload.provider !== 'ollama') {
      return [];
    }
    return listOllamaModels(payload);
  }
);

ipcMain.handle('config.diagnose', async (_event, payload: DiagnosticInput) => {
  try {
    const { runDiagnostics } = await import('./config/api-diagnostics');
    return await runDiagnostics(payload);
  } catch (error) {
    logError('[Config] Error running diagnostics:', error);
    throw error;
  }
});

ipcMain.handle('config.discover-local', async (_event, payload?: { baseUrl?: string }) => {
  try {
    const { discoverLocalOllama } = await import('./config/api-diagnostics');
    return await discoverLocalOllama(payload);
  } catch (error) {
    logError('[Config] Error discovering local services:', error);
    return [];
  }
});

// Environment IPC handlers
ipcMain.handle('env.getEffectivePath', () => {
  return getEffectivePath();
});

// MCP Server IPC handlers
ipcMain.handle('mcp.getServers', () => {
  try {
    return mcpConfigStore.getServers();
  } catch (error) {
    logError('[MCP] Error getting servers:', error);
    return [];
  }
});

ipcMain.handle('mcp.getServer', (_event, serverId: string) => {
  try {
    return mcpConfigStore.getServer(serverId);
  } catch (error) {
    logError('[MCP] Error getting server:', error);
    return null;
  }
});

ipcMain.handle('mcp.saveServer', async (_event, config: MCPServerConfig) => {
  mcpConfigStore.saveServer(config);
  // Update only this specific server, not all servers
  if (sessionManager) {
    const mcpManager = sessionManager.getMCPManager();
    try {
      await mcpManager.updateServer(config);
      sessionManager.invalidateMcpServersCache();
      log(`[MCP] Server ${config.name} updated successfully`);
    } catch (err) {
      logError('[MCP] Failed to update server:', err);
      // Roll back: save the config with enabled=false so a broken connector
      // is not retried on next app startup
      if (config.enabled) {
        mcpConfigStore.saveServer({ ...config, enabled: false });
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMessage };
    }
  }
  return { success: true };
});

ipcMain.handle('mcp.deleteServer', async (_event, serverId: string) => {
  mcpConfigStore.deleteServer(serverId);
  // Remove and disconnect only this specific server
  if (sessionManager) {
    const mcpManager = sessionManager.getMCPManager();
    try {
      await mcpManager.removeServer(serverId);
      sessionManager.invalidateMcpServersCache();
      log(`[MCP] Server ${serverId} removed successfully`);
    } catch (err) {
      logError('[MCP] Failed to remove server:', err);
    }
  }
  return { success: true };
});

ipcMain.handle('mcp.getTools', () => {
  try {
    if (!sessionManager) {
      return [];
    }
    const mcpManager = sessionManager.getMCPManager();
    return mcpManager.getTools();
  } catch (error) {
    logError('[MCP] Error getting tools:', error);
    return [];
  }
});

ipcMain.handle('mcp.getServerStatus', () => {
  try {
    if (!sessionManager) {
      return [];
    }
    const mcpManager = sessionManager.getMCPManager();
    return mcpManager.getServerStatus();
  } catch (error) {
    logError('[MCP] Error getting server status:', error);
    return [];
  }
});

ipcMain.handle('mcp.getPresets', () => {
  try {
    return mcpConfigStore.getPresets();
  } catch (error) {
    logError('[MCP] Error getting presets:', error);
    return {};
  }
});

ipcMain.handle('mcp.regenerateDescription', async (_event, serverId: string) => {
  try {
    const config = mcpConfigStore.getServer(serverId);
    if (!config) {
      return { success: false, error: 'Server not found' };
    }

    // Get tools for this server
    if (!sessionManager) {
      return { success: false, error: 'Session manager not initialized' };
    }
    const mcpManager = sessionManager.getMCPManager();
    const allTools = mcpManager.getTools();
    const serverTools = allTools.filter((t) => t.serverId === serverId);

    if (serverTools.length === 0) {
      return { success: false, error: 'No tools available for this server' };
    }

    const {
      generateServerDescription,
      generateHeuristicDescription,
      computeToolsHash,
      sanitizeDescription,
    } = await import('./mcp/mcp-description-generator');

    // Try LLM generation first (optional upgrade)
    const llmDescription = await generateServerDescription(config.name, serverTools);

    // Template-based description is the reliable primary — LLM is just an upgrade
    const rawDescription = llmDescription || generateHeuristicDescription(config.name, serverTools);
    const description = sanitizeDescription(rawDescription);
    const hash = computeToolsHash(serverTools);

    mcpConfigStore.saveServer({
      ...config,
      description,
      descriptionToolsHash: hash,
      descriptionSource: 'auto',
    });

    sessionManager.invalidateMcpServersCache();
    log(
      `[MCP] Description regenerated for ${config.name}: ${description} (source: ${llmDescription ? 'llm' : 'template'})`
    );
    return { success: true, description };
  } catch (error) {
    logError('[MCP] Error regenerating description:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle('mcp.saveDescription', async (_event, serverId: string, description: string) => {
  try {
    const config = mcpConfigStore.getServer(serverId);
    if (!config) {
      return { success: false, error: 'Server not found' };
    }

    const { sanitizeDescription } = await import('./mcp/mcp-description-generator');

    mcpConfigStore.saveServer({
      ...config,
      description: sanitizeDescription(description),
      descriptionSource: 'manual',
    });

    if (sessionManager) {
      sessionManager.invalidateMcpServersCache();
    }
    log(`[MCP] Description manually saved for ${config.name}: ${description}`);
    return { success: true };
  } catch (error) {
    logError('[MCP] Error saving description:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle(
  'mcp.toggleSessionServer',
  async (_event, sessionId: string, serverId: string, disabled: boolean) => {
    try {
      if (!sessionManager) {
        return { success: false, error: 'Session manager not initialized' };
      }
      const disabledServers = sessionManager.toggleSessionMcpServer(sessionId, serverId, disabled);
      log(`[MCP] Session ${sessionId}: server ${serverId} ${disabled ? 'disabled' : 'enabled'}`);
      return { success: true, disabledServers };
    } catch (error) {
      logError('[MCP] Error toggling session server:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }
);

ipcMain.handle('mcp.getSessionDisabledServers', async (_event, sessionId: string) => {
  try {
    if (!sessionManager) {
      return [];
    }
    return sessionManager.getSessionDisabledMcpServers(sessionId);
  } catch (error) {
    logError('[MCP] Error getting session disabled servers:', error);
    return [];
  }
});

ipcMain.handle(
  'mcp.saveWorkspaceProfile',
  async (_event, cwd: string, disabledServerIds: string[]) => {
    try {
      // Validate cwd: must be an absolute path that matches an authorized workspace.
      // Authorized workspaces are: the global working directory OR any session's cwd.
      // Trust chain: session cwds are validated at creation time via setWorkingDir() and
      // getWorkspacePathUnsupportedReason(), so they are main-process-trusted by the time
      // they appear in listSessions(). This prevents a compromised renderer from writing
      // to arbitrary filesystem paths.
      const authorizedWorkspaces: string[] = [];
      const globalCwd = getWorkingDir();
      if (globalCwd) authorizedWorkspaces.push(globalCwd);
      if (sessionManager) {
        for (const session of sessionManager.listSessions()) {
          if (session.cwd) authorizedWorkspaces.push(session.cwd);
        }
      }

      const validation = validateWorkspaceCwd(cwd, authorizedWorkspaces);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      // Use the canonical path for all downstream writes to prevent TOCTOU symlink attacks
      const trustedCwd = validation.canonicalCwd;

      // Validate disabledServerIds: must be an array of non-empty strings, bounded size.
      if (!Array.isArray(disabledServerIds)) {
        return { success: false, error: 'disabledServerIds must be an array' };
      }
      const MAX_ENTRIES = 100;
      const MAX_ID_LENGTH = 256;
      if (disabledServerIds.length > MAX_ENTRIES) {
        return { success: false, error: `Too many entries (max ${MAX_ENTRIES})` };
      }
      const sanitizedIds: string[] = [];
      for (const id of disabledServerIds) {
        if (typeof id !== 'string') {
          return {
            success: false,
            error: 'Each server ID must be a non-empty string (max 256 chars)',
          };
        }
        const normalized = id.trim();
        if (normalized.length === 0 || normalized.length > MAX_ID_LENGTH) {
          return {
            success: false,
            error: 'Each server ID must be a non-empty string (max 256 chars)',
          };
        }
        sanitizedIds.push(normalized);
      }
      // Deduplicate
      const uniqueIds = [...new Set(sanitizedIds)];

      const result = await saveWorkspaceMcpProfile(trustedCwd, { disabled: uniqueIds });
      if (result.success) {
        log(`[MCP] Workspace profile saved to ${trustedCwd}/.cowork/mcp-servers.json`);
      }
      return result;
    } catch (error) {
      logError('[MCP] Error saving workspace profile:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }
);

ipcMain.handle('mcp.getWorkspaceProfile', async (_event, cwd: string) => {
  try {
    if (!cwd || !isAbsolute(cwd)) {
      return null;
    }
    // Return the raw profile as-is. The renderer handles both `disabled` and `enabled`
    // modes using its own server list, avoiding lossy normalization here.
    return loadWorkspaceMcpProfile(cwd);
  } catch (error) {
    logError('[MCP] Error loading workspace profile:', error);
    return null;
  }
});

// Skills API handlers
ipcMain.handle('skills.getAll', async () => {
  try {
    if (!skillsManager) {
      throw new Error('Skills manager is still starting');
    }
    return await skillsManager.listSkills();
  } catch (error) {
    logError('[Skills] Error getting skills:', error);
    throw error;
  }
});

ipcMain.handle('skills.install', async (_event, skillPath: string) => {
  try {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    const skill = await skillsManager.installSkill(skillPath);
    sessionManager?.invalidateSkillsSetup();
    return { success: true, skill };
  } catch (error) {
    logError('[Skills] Error installing skill:', error);
    throw error;
  }
});

ipcMain.handle('skills.delete', async (_event, skillId: string) => {
  try {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    await skillsManager.uninstallSkill(skillId);
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error deleting skill:', error);
    throw error;
  }
});

ipcMain.handle('skills.setEnabled', async (_event, skillId: string, enabled: boolean) => {
  try {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    skillsManager.setSkillEnabled(skillId, enabled);
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error toggling skill:', error);
    throw error;
  }
});

ipcMain.handle('skills.validate', async (_event, skillPath: string) => {
  try {
    if (!skillsManager) {
      return { valid: false, errors: ['SkillsManager not initialized'] };
    }
    const result = await skillsManager.validateSkillFolder(skillPath);
    return result;
  } catch (error) {
    logError('[Skills] Error validating skill:', error);
    return { valid: false, errors: ['Validation failed'] };
  }
});

ipcMain.handle('skills.getStoragePath', async () => {
  try {
    if (!skillsManager) {
      return null;
    }
    return skillsManager.getGlobalSkillsPath();
  } catch (error) {
    logError('[Skills] Error getting storage path:', error);
    return null;
  }
});

ipcMain.handle('skills.setStoragePath', async (_event, targetPath: string, migrate = true) => {
  if (!skillsManager) {
    throw new Error('SkillsManager not initialized');
  }
  const result = await skillsManager.setGlobalSkillsPath(targetPath, migrate !== false);
  sendToRenderer({
    type: 'config.status',
    payload: {
      isConfigured: configStore.isConfigured(),
      config: configStore.getAll(),
    },
  });
  return { success: true, ...result };
});

ipcMain.handle('skills.openStoragePath', async () => {
  if (!skillsManager) {
    throw new Error('SkillsManager not initialized');
  }
  const storagePath = skillsManager.getGlobalSkillsPath();
  const openResult = await shell.openPath(storagePath);
  if (openResult) {
    return { success: false, path: storagePath, error: openResult };
  }
  return { success: true, path: storagePath };
});

ipcMain.handle(
  'skills.toggleSessionPin',
  async (_event, sessionId: string, skillId: string, pinned: boolean) => {
    try {
      if (!sessionManager) {
        return { success: false, error: 'Session manager not initialized' };
      }
      // Validate skill exists and is enabled before pinning
      if (pinned && skillsManager) {
        const allSkills = skillsManager.getAllSkills();
        const skill = allSkills.find((s) => s.id === skillId);
        if (!skill) {
          return { success: false, error: `Skill not found: ${skillId}` };
        }
        if (!skill.enabled) {
          return { success: false, error: `Skill is disabled: ${skillId}` };
        }
      }
      const pinnedSkills = sessionManager.toggleSessionPinnedSkill(sessionId, skillId, pinned);
      log(`[Skills] Session ${sessionId}: skill ${skillId} ${pinned ? 'pinned' : 'unpinned'}`);
      return { success: true, pinnedSkills };
    } catch (error) {
      logError('[Skills] Error toggling session pinned skill:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }
);

ipcMain.handle('skills.getSessionPinnedSkills', async (_event, sessionId: string) => {
  try {
    if (!sessionManager) {
      return [];
    }
    return sessionManager.getSessionPinnedSkills(sessionId);
  } catch (error) {
    logError('[Skills] Error getting session pinned skills:', error);
    return [];
  }
});

ipcMain.handle('skills.getBuiltinStatus', async () => {
  try {
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');
    const possiblePaths = [
      join(__dirname, '..', '..', '..', '.claude', 'skills'),
      join(process.resourcesPath || '', 'skills'),
      ...(fs.existsSync(join(unpackedPath, '.claude', 'skills'))
        ? [join(unpackedPath, '.claude', 'skills')]
        : []),
      join(appPath, '.claude', 'skills'),
    ];
    let builtinSkillsPath = '';
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        builtinSkillsPath = p;
        break;
      }
    }
    if (!builtinSkillsPath) return [];

    const runtimeSkillsDir = join(app.getPath('userData'), 'claude', 'skills');
    const builtinSkills = fs.readdirSync(builtinSkillsPath).filter((name) => {
      try {
        return fs.statSync(join(builtinSkillsPath, name)).isDirectory();
      } catch {
        return false;
      }
    });

    const results: Array<{
      skillName: string;
      bundledHash: string;
      runtimeHash: string;
      isSymlink: boolean;
      isUserModified: boolean;
      isUpToDate: boolean;
      isLegacy: boolean;
      isInstalled: boolean;
      lastUpdated: number | null;
    }> = [];

    for (const skillName of builtinSkills) {
      const builtinSkillMd = join(builtinSkillsPath, skillName, 'SKILL.md');
      const builtinSkillDir = join(builtinSkillsPath, skillName);
      const runtimePath = join(runtimeSkillsDir, skillName);
      const runtimeHashFile = join(runtimePath, '.builtin-hash');
      const userModifiedFile = join(runtimePath, '.user-modified');

      // Compute bundled hash from SKILL.md + all root-level .md files (sorted).
      // This covers the primary skill definition and any supplementary reference
      // docs (e.g., forms.md, editing.md) that the LLM reads.
      let bundledHash = 'no-skill-md';
      if (fs.existsSync(builtinSkillMd)) {
        const hash = crypto.createHash('sha256');
        const mdFiles = fs
          .readdirSync(builtinSkillDir)
          .filter((f) => f.endsWith('.md'))
          .sort();
        for (const mdFile of mdFiles) {
          hash.update(mdFile); // include filename as separator
          hash.update(fs.readFileSync(join(builtinSkillDir, mdFile)));
        }
        bundledHash = hash.digest('hex').slice(0, 16);
      }

      // Check runtime state
      let runtimeHash = '';
      let isSymlink = false;
      let isUserModified = false;
      let lastUpdated: number | null = null;
      let isLegacy = false;
      const isInstalled = fs.existsSync(runtimePath);

      if (isInstalled) {
        try {
          const lstat = fs.lstatSync(runtimePath);
          isSymlink = lstat.isSymbolicLink();
          lastUpdated = Math.floor(lstat.mtimeMs);
        } catch {
          // ignore
        }

        try {
          runtimeHash = fs.readFileSync(runtimeHashFile, 'utf-8').trim();
        } catch {
          // No hash file — pre-versioning install or symlink
          if (!isSymlink) {
            isLegacy = true;
          }
        }

        isUserModified = fs.existsSync(userModifiedFile);
      }

      // Symlinks are always up-to-date (they point to the source)
      const isUpToDate = isSymlink || runtimeHash === bundledHash;

      results.push({
        skillName,
        bundledHash,
        runtimeHash,
        isSymlink,
        isUserModified,
        isUpToDate,
        isLegacy,
        isInstalled,
        lastUpdated,
      });
    }

    return results;
  } catch (error) {
    logError('[Skills] Error getting builtin status:', error);
    return [];
  }
});

ipcMain.handle('skills.setUserModified', async (_event, skillName: string, protect: boolean) => {
  try {
    // Validate skillName: reject path separators, traversal, and empty values
    if (!skillName || /[/\\]|\.\./.test(skillName)) {
      return { success: false, error: 'Invalid skill name' };
    }

    const runtimeSkillsDir = resolve(join(app.getPath('userData'), 'claude', 'skills'));
    const targetDir = resolve(runtimeSkillsDir, skillName);

    // Platform-safe path containment: relative path must not escape parent
    const rel = relative(runtimeSkillsDir, targetDir);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return { success: false, error: 'Invalid skill name' };
    }

    // Ensure the runtime skill directory exists before writing marker
    if (!fs.existsSync(targetDir)) {
      return { success: false, error: 'Skill runtime directory does not exist' };
    }

    // Reject symlinked skill directories — writes would escape the runtime root
    const lstat = fs.lstatSync(targetDir);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
      return { success: false, error: 'Cannot modify a symlinked or non-directory skill' };
    }

    const markerPath = join(targetDir, '.user-modified');

    if (protect) {
      fs.writeFileSync(markerPath, `Protected at ${new Date().toISOString()}\n`, 'utf-8');
    } else {
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
      }
    }
    return { success: true };
  } catch (error) {
    logError('[Skills] Error setting user-modified:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('skills.forceRefreshBuiltin', async (_event, skillName: string) => {
  try {
    // Validate skillName: reject path separators, traversal, and empty values
    if (!skillName || /[/\\]|\.\./.test(skillName)) {
      return { success: false, error: 'Invalid skill name' };
    }

    const runtimeSkillsDir = resolve(join(app.getPath('userData'), 'claude', 'skills'));
    const runtimePath = resolve(runtimeSkillsDir, skillName);

    // Platform-safe path containment: relative path must not escape parent
    const rel = relative(runtimeSkillsDir, runtimePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return { success: false, error: 'Invalid skill name' };
    }

    // Remove the runtime copy
    if (fs.existsSync(runtimePath)) {
      fs.rmSync(runtimePath, { recursive: true, force: true });
    }

    // Invalidate skills setup so next query re-copies from bundled source
    if (sessionManager) {
      sessionManager.invalidateSkillsSetup();
    }

    return { success: true };
  } catch (error) {
    logError('[Skills] Error force-refreshing builtin skill:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// --- Skill Conflict Resolution IPC Handlers ---

ipcMain.handle('skills.getConflictConfig', async () => {
  try {
    return configStore.get('skillConflictConfig');
  } catch (error) {
    logError('[Skills] Error getting conflict config:', error);
    throw error;
  }
});

ipcMain.handle('skills.setConflictPolicy', async (_event, policy: string) => {
  try {
    const { isValidConflictPolicy } = await import('../shared/skill-conflict-types');
    if (!isValidConflictPolicy(policy)) {
      return { success: false, error: `Invalid policy: ${policy}` };
    }
    const current = configStore.get('skillConflictConfig');
    configStore.set('skillConflictConfig', { ...current, conflictPolicy: policy });
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error setting conflict policy:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('skills.setSourceOverride', async (_event, skillName: string, source: string) => {
  try {
    const { isValidSkillSource } = await import('../shared/skill-conflict-types');
    const { isValidSkillId } = await import('../shared/skill-pinning-constants');
    if (!isValidSkillId(skillName)) {
      return { success: false, error: 'Invalid skill name' };
    }
    if (!isValidSkillSource(source)) {
      return { success: false, error: `Invalid source: ${source}` };
    }
    const current = configStore.get('skillConflictConfig');
    // Cap sourceOverrides size to prevent unbounded growth
    const MAX_OVERRIDES = 200;
    if (
      Object.keys(current.sourceOverrides).length >= MAX_OVERRIDES &&
      !(skillName in current.sourceOverrides)
    ) {
      return { success: false, error: `Too many source overrides (max ${MAX_OVERRIDES})` };
    }
    const sourceOverrides = { ...current.sourceOverrides, [skillName]: source };
    configStore.set('skillConflictConfig', { ...current, sourceOverrides });
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error setting source override:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('skills.toggleDisabled', async (_event, skillName: string, disabled: boolean) => {
  try {
    const { isValidSkillId } = await import('../shared/skill-pinning-constants');
    if (!isValidSkillId(skillName)) {
      return { success: false, error: 'Invalid skill name' };
    }
    if (typeof disabled !== 'boolean') {
      return { success: false, error: 'Invalid disabled flag: must be a boolean' };
    }
    const current = configStore.get('skillConflictConfig');
    const disabledSkills = new Set(current.disabledSkills);
    // Cap disabled list size
    const MAX_DISABLED = 200;
    if (disabled && disabledSkills.size >= MAX_DISABLED && !disabledSkills.has(skillName)) {
      return { success: false, error: `Too many disabled skills (max ${MAX_DISABLED})` };
    }
    if (disabled) {
      disabledSkills.add(skillName);
    } else {
      disabledSkills.delete(skillName);
    }
    configStore.set('skillConflictConfig', {
      ...current,
      disabledSkills: [...disabledSkills],
    });
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error toggling disabled skill:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('skills.acknowledgeConflict', async (_event, skillName: string, choice: string) => {
  try {
    const { isValidSkillSource } = await import('../shared/skill-conflict-types');
    const { isValidSkillId } = await import('../shared/skill-pinning-constants');
    if (!isValidSkillId(skillName)) {
      return { success: false, error: 'Invalid skill name' };
    }
    if (!isValidSkillSource(choice)) {
      return { success: false, error: `Invalid choice: ${choice}` };
    }
    const current = configStore.get('skillConflictConfig');
    // Cap acknowledged list size
    const MAX_ENTRIES = 200;
    const acknowledgedConflicts = new Set(current.acknowledgedConflicts);
    if (acknowledgedConflicts.size >= MAX_ENTRIES && !acknowledgedConflicts.has(skillName)) {
      return { success: false, error: `Too many acknowledged conflicts (max ${MAX_ENTRIES})` };
    }
    // Cap sourceOverrides size
    if (
      Object.keys(current.sourceOverrides).length >= MAX_ENTRIES &&
      !(skillName in current.sourceOverrides)
    ) {
      return { success: false, error: `Too many source overrides (max ${MAX_ENTRIES})` };
    }
    acknowledgedConflicts.add(skillName);
    const sourceOverrides = { ...current.sourceOverrides, [skillName]: choice };
    configStore.set('skillConflictConfig', {
      ...current,
      acknowledgedConflicts: [...acknowledgedConflicts],
      sourceOverrides,
    });
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error acknowledging conflict:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('skills.getConflicts', async () => {
  try {
    const { discoverAllSkillSources, detectConflicts } =
      await import('./skills/skill-conflict-detector');
    const { normalizeSkillConflictConfig } = await import('../shared/skill-conflict-types');

    // Gather skill source directories
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');
    const builtinPaths = [
      join(__dirname, '..', '..', '..', '.claude', 'skills'),
      join(process.resourcesPath || '', 'skills'),
      join(unpackedPath, '.claude', 'skills'),
      join(appPath, '.claude', 'skills'),
    ];
    let builtinDir = '';
    for (const p of builtinPaths) {
      if (fs.existsSync(p)) {
        builtinDir = p;
        break;
      }
    }

    const userDir = join(app.getPath('home'), '.claude', 'skills');
    const rawConfiguredPath = configStore.get('globalSkillsPath');
    const configuredPath = typeof rawConfiguredPath === 'string' ? rawConfiguredPath.trim() : '';
    const configuredDir = configuredPath ? resolve(configuredPath) : undefined;

    // Note: project-level skills (.skills/) are not yet included in conflict detection
    // because project skill syncing is not implemented in ClaudeAgentRunner yet (Phase 2+).
    // Including them here would report conflicts that the runtime cannot resolve.

    const config = normalizeSkillConflictConfig(configStore.get('skillConflictConfig'));
    const sourceMap = discoverAllSkillSources(builtinDir, userDir, configuredDir);
    const conflicts = detectConflicts(sourceMap, config);

    return { conflicts, notImplemented: false };
  } catch (error) {
    logError('[Skills] Error getting conflicts:', error);
    return { conflicts: [], notImplemented: false };
  }
});

ipcMain.handle('skills.resetToBuiltin', async (_event, skillName: string) => {
  try {
    const { isValidSkillId } = await import('../shared/skill-pinning-constants');
    if (!isValidSkillId(skillName)) {
      return { success: false, error: 'Invalid skill name' };
    }
    const current = configStore.get('skillConflictConfig');
    // Cap sourceOverrides size (resetToBuiltin adds an entry)
    const MAX_OVERRIDES = 200;
    if (
      Object.keys(current.sourceOverrides).length >= MAX_OVERRIDES &&
      !(skillName in current.sourceOverrides)
    ) {
      return { success: false, error: `Too many source overrides (max ${MAX_OVERRIDES})` };
    }
    // Explicitly select 'builtin' as the source override — this ensures the built-in
    // version is used regardless of the global policy (including 'custom-wins').
    const sourceOverrides = { ...current.sourceOverrides, [skillName]: 'builtin' as const };
    const acknowledgedConflicts = current.acknowledgedConflicts.filter((n) => n !== skillName);
    configStore.set('skillConflictConfig', {
      ...current,
      sourceOverrides,
      acknowledgedConflicts,
    });
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error resetting to builtin:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// --- Skill Workspace Profile IPC Handlers ---

ipcMain.handle(
  'skills.toggleSessionDisabled',
  async (_event, sessionId: string, skillId: string, disabled: boolean) => {
    try {
      if (!sessionManager) {
        return { success: false, error: 'Session manager not initialized' };
      }
      const { isValidSkillId } = await import('../shared/skill-pinning-constants');
      if (!isValidSkillId(skillId)) {
        return { success: false, error: `Invalid skill ID: ${skillId}` };
      }
      if (typeof disabled !== 'boolean') {
        return { success: false, error: 'Invalid disabled flag: must be a boolean' };
      }
      const disabledSkills = sessionManager.toggleSessionDisabledSkill(
        sessionId,
        skillId,
        disabled
      );
      const pinnedSkills = sessionManager.getSessionPinnedSkills(sessionId);
      log(`[Skills] Session ${sessionId}: skill ${skillId} ${disabled ? 'disabled' : 'enabled'}`);
      // Emit event to renderer (includes pinned state for reconciliation)
      sendToRenderer({
        type: 'skills.session-disabled-changed',
        payload: { sessionId, disabledSkills, pinnedSkills },
      });
      return { success: true, disabledSkills, pinnedSkills };
    } catch (error) {
      logError('[Skills] Error toggling session disabled skill:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
);

ipcMain.handle('skills.getSessionDisabledSkills', async (_event, sessionId: string) => {
  try {
    if (!sessionManager) {
      return [];
    }
    return sessionManager.getSessionDisabledSkills(sessionId);
  } catch (error) {
    logError('[Skills] Error getting session disabled skills:', error);
    return [];
  }
});

ipcMain.handle('skills.getWorkspaceProfile', async (_event, cwd: string) => {
  try {
    if (!cwd || !isAbsolute(cwd)) {
      return null;
    }
    // Security: validate cwd against authorized workspaces (same as save handler)
    const authorizedWorkspaces: string[] = [];
    const globalCwd = getWorkingDir();
    if (globalCwd) authorizedWorkspaces.push(globalCwd);
    if (sessionManager) {
      for (const session of sessionManager.listSessions()) {
        if (session.cwd) authorizedWorkspaces.push(session.cwd);
      }
    }
    const validation = validateWorkspaceCwd(cwd, authorizedWorkspaces);
    if (!validation.valid) {
      return null; // Unauthorized workspace — silent null (read-only, no error leak)
    }

    // Use the workspace profile module (mtime-cached, validated)
    const { loadSkillsWorkspaceProfile } = await import('./skills/skills-workspace-profile');
    return loadSkillsWorkspaceProfile(validation.canonicalCwd);
  } catch (error) {
    logError('[Skills] Error loading workspace profile:', error);
    return null;
  }
});

ipcMain.handle(
  'skills.saveWorkspaceProfile',
  async (_event, cwd: string, profile: { pinned?: string[]; disabled?: string[] }) => {
    try {
      // Security: validate cwd against authorized workspaces (same pattern as MCP profiles)
      const authorizedWorkspaces: string[] = [];
      const globalCwd = getWorkingDir();
      if (globalCwd) authorizedWorkspaces.push(globalCwd);
      if (sessionManager) {
        for (const session of sessionManager.listSessions()) {
          if (session.cwd) authorizedWorkspaces.push(session.cwd);
        }
      }

      const validation = validateWorkspaceCwd(cwd, authorizedWorkspaces);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      const trustedCwd = validation.canonicalCwd;

      // Validate profile schema
      if (!profile || typeof profile !== 'object') {
        return { success: false, error: 'Invalid profile object' };
      }

      const { isValidSkillId } = await import('../shared/skill-pinning-constants');
      const MAX_ENTRIES = 200;
      const sanitized: { pinned?: string[]; disabled?: string[] } = {};

      if ('pinned' in profile && profile.pinned !== undefined) {
        if (!Array.isArray(profile.pinned)) {
          return { success: false, error: 'pinned must be an array' };
        }
        if (profile.pinned.length > MAX_ENTRIES) {
          return { success: false, error: `pinned exceeds max entries (${MAX_ENTRIES})` };
        }
        for (const id of profile.pinned) {
          if (typeof id !== 'string' || !isValidSkillId(id)) {
            return { success: false, error: `Invalid skill ID in pinned: ${String(id)}` };
          }
        }
        sanitized.pinned = [...new Set(profile.pinned)];
      }

      if ('disabled' in profile && profile.disabled !== undefined) {
        if (!Array.isArray(profile.disabled)) {
          return { success: false, error: 'disabled must be an array' };
        }
        if (profile.disabled.length > MAX_ENTRIES) {
          return { success: false, error: `disabled exceeds max entries (${MAX_ENTRIES})` };
        }
        for (const id of profile.disabled) {
          if (typeof id !== 'string' || !isValidSkillId(id)) {
            return { success: false, error: `Invalid skill ID in disabled: ${String(id)}` };
          }
        }
        sanitized.disabled = [...new Set(profile.disabled)];
      }

      // If both arrays are empty or undefined, delete the file
      const isEmpty =
        (!sanitized.pinned || sanitized.pinned.length === 0) &&
        (!sanitized.disabled || sanitized.disabled.length === 0);

      const coworkDir = join(trustedCwd, '.cowork');
      const profilePath = join(coworkDir, 'skills-profile.json');

      // Security: reject symlinks in the write path to prevent symlink attacks
      if (fs.existsSync(coworkDir)) {
        const coworkStat = fs.lstatSync(coworkDir);
        if (coworkStat.isSymbolicLink()) {
          return {
            success: false,
            error: '.cowork directory is a symlink (rejected for security)',
          };
        }
        if (!coworkStat.isDirectory()) {
          return { success: false, error: '.cowork exists but is not a directory' };
        }
      }
      if (fs.existsSync(profilePath)) {
        const fileStat = fs.lstatSync(profilePath);
        if (fileStat.isSymbolicLink()) {
          return {
            success: false,
            error: 'skills-profile.json is a symlink (rejected for security)',
          };
        }
        if (!fileStat.isFile()) {
          return { success: false, error: 'skills-profile.json exists but is not a regular file' };
        }
      }

      // Verify the resolved paths remain within the trusted workspace
      const resolvedCoworkDir = resolve(coworkDir);
      const resolvedProfilePath = resolve(profilePath);
      const relCowork = relative(trustedCwd, resolvedCoworkDir);
      const relProfile = relative(trustedCwd, resolvedProfilePath);
      if (
        !relCowork ||
        relCowork.startsWith('..') ||
        isAbsolute(relCowork) ||
        !relProfile ||
        relProfile.startsWith('..') ||
        isAbsolute(relProfile)
      ) {
        return { success: false, error: 'Resolved path escapes workspace boundary' };
      }

      if (isEmpty) {
        if (fs.existsSync(profilePath)) {
          fs.unlinkSync(profilePath);
          log(`[Skills] Removed empty workspace profile: ${profilePath}`);
        }
      } else {
        if (!fs.existsSync(coworkDir)) {
          fs.mkdirSync(coworkDir, { recursive: true });
        }
        // Re-verify .cowork after mkdir: confirm it's a real directory within workspace
        const coworkLstat = fs.lstatSync(coworkDir);
        if (coworkLstat.isSymbolicLink() || !coworkLstat.isDirectory()) {
          return { success: false, error: '.cowork is not a real directory after creation' };
        }
        const realCoworkDir = fs.realpathSync(coworkDir);
        const relCoworkReal = relative(trustedCwd, realCoworkDir);
        if (!relCoworkReal || relCoworkReal.startsWith('..') || isAbsolute(relCoworkReal)) {
          return { success: false, error: '.cowork realpath escapes workspace' };
        }

        // Atomic write: use crypto-random temp name with O_CREAT|O_EXCL to prevent
        // symlink pre-creation attacks. Then rename over the target.
        const { randomUUID } = await import('crypto');
        const tmpName = `.skills-profile.${randomUUID()}.tmp`;
        const tmpPath = join(realCoworkDir, tmpName);
        const content = JSON.stringify(sanitized, null, 2) + '\n';
        // O_CREAT | O_EXCL | O_WRONLY = create exclusively, fail if exists
        const fd = fs.openSync(
          tmpPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o644
        );
        try {
          fs.writeSync(fd, content);
        } finally {
          fs.closeSync(fd);
        }
        // Atomic rename within same directory/filesystem
        const finalPath = join(realCoworkDir, 'skills-profile.json');
        fs.renameSync(tmpPath, finalPath);
        log(`[Skills] Workspace profile saved: ${finalPath}`);
      }

      return { success: true };
    } catch (error) {
      logError('[Skills] Error saving workspace profile:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
);

// Atomic workspace profile seeding: applies profile defaults to a session only if
// the session has not been manually customized (both pinned and disabled are empty).
ipcMain.handle(
  'skills.seedSessionFromProfile',
  async (
    _event,
    sessionId: string,
    profile: { pinned?: string[]; disabled?: string[] }
  ): Promise<{
    success: boolean;
    pinnedSkills?: string[];
    disabledSkills?: string[];
    error?: string;
  }> => {
    try {
      if (!sessionManager) {
        return { success: false, error: 'Session manager not initialized' };
      }
      if (!sessionId || typeof sessionId !== 'string') {
        return { success: false, error: 'Invalid session ID' };
      }
      if (!profile || typeof profile !== 'object') {
        return { success: false, error: 'Invalid profile object' };
      }

      // Import validation before the critical check-then-apply section (no async gap)
      const { isValidSkillId } = await import('../shared/skill-pinning-constants');

      // Atomic check-then-apply: no awaits between reading session state and mutating it
      const existingPinned = sessionManager.getSessionPinnedSkills(sessionId);
      const existingDisabled = sessionManager.getSessionDisabledSkills(sessionId);
      if (existingPinned.length > 0 || existingDisabled.length > 0) {
        // Session already customized — return current state without modification
        return {
          success: true,
          pinnedSkills: existingPinned,
          disabledSkills: existingDisabled,
        };
      }

      // Apply disabled skills
      const disabledToApply = (profile.disabled || []).filter(
        (id): id is string => typeof id === 'string' && isValidSkillId(id)
      );
      if (disabledToApply.length > 0) {
        for (const skillId of disabledToApply) {
          sessionManager.toggleSessionDisabledSkill(sessionId, skillId, true);
        }
      }

      // Apply pinned skills (respecting pinned-wins-over-disabled)
      const pinnedToApply = (profile.pinned || []).filter(
        (id): id is string => typeof id === 'string' && isValidSkillId(id)
      );
      if (pinnedToApply.length > 0) {
        for (const skillId of pinnedToApply) {
          sessionManager.toggleSessionPinnedSkill(sessionId, skillId, true);
        }
      }

      return {
        success: true,
        pinnedSkills: sessionManager.getSessionPinnedSkills(sessionId),
        disabledSkills: sessionManager.getSessionDisabledSkills(sessionId),
      };
    } catch (error) {
      logError('[Skills] Error seeding session from profile:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
);

ipcMain.handle('plugins.listCatalog', async (_event, options?: { installableOnly?: boolean }) => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    return await pluginRuntimeService.listCatalog(options);
  } catch (error) {
    logError('[Plugins] Error listing catalog:', error);
    throw error;
  }
});

ipcMain.handle('plugins.listInstalled', async () => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    return pluginRuntimeService.listInstalled();
  } catch (error) {
    logError('[Plugins] Error listing installed plugins:', error);
    throw error;
  }
});

ipcMain.handle('plugins.install', async (_event, pluginName: string) => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    const result = await pluginRuntimeService.install(pluginName);
    sessionManager?.invalidateSkillsSetup();
    return result;
  } catch (error) {
    logError('[Plugins] Error installing plugin:', error);
    throw error;
  }
});

ipcMain.handle('plugins.setEnabled', async (_event, pluginId: string, enabled: boolean) => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    const result = await pluginRuntimeService.setEnabled(pluginId, enabled);
    sessionManager?.invalidateSkillsSetup();
    return result;
  } catch (error) {
    logError('[Plugins] Error toggling plugin:', error);
    throw error;
  }
});

ipcMain.handle(
  'plugins.setComponentEnabled',
  async (
    _event,
    pluginId: string,
    component: 'skills' | 'commands' | 'agents' | 'hooks' | 'mcp',
    enabled: boolean
  ) => {
    try {
      if (!pluginRuntimeService) {
        throw new Error('PluginRuntimeService not initialized');
      }
      const result = await pluginRuntimeService.setComponentEnabled(pluginId, component, enabled);
      if (component === 'skills') {
        sessionManager?.invalidateSkillsSetup();
      }
      return result;
    } catch (error) {
      logError('[Plugins] Error toggling plugin component:', error);
      throw error;
    }
  }
);

ipcMain.handle('plugins.uninstall', async (_event, pluginId: string) => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    const result = await pluginRuntimeService.uninstall(pluginId);
    sessionManager?.invalidateSkillsSetup();
    return result;
  } catch (error) {
    logError('[Plugins] Error uninstalling plugin:', error);
    throw error;
  }
});

ipcMain.handle('plugins.installFromFile', async () => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }

    // Always show file dialog in main process — never accept paths from renderer
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Plugin Archives', extensions: ['plugin', 'zip'] }],
      title: 'Select Plugin Archive',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const targetPath = result.filePaths[0];
    const installResult = await pluginRuntimeService.installFromArchive(targetPath);
    sessionManager?.invalidateSkillsSetup();
    return installResult;
  } catch (error) {
    logError('[Plugins] Error installing plugin from file:', error);
    throw error;
  }
});

// Window control IPC handlers
ipcMain.on('window.minimize', () => {
  try {
    mainWindow?.minimize();
  } catch (error) {
    logError('[Window] Error minimizing:', error);
  }
});

ipcMain.on('window.maximize', () => {
  try {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  } catch (error) {
    logError('[Window] Error maximizing:', error);
  }
});

ipcMain.on('window.close', () => {
  try {
    mainWindow?.close();
  } catch (error) {
    logError('[Window] Error closing:', error);
  }
});

// Clipboard IPC handler (avoids deprecated renderer clipboard access in Electron 40+)
ipcMain.handle('clipboard.writeText', (_event, text: string) => {
  clipboard.writeText(text);
});

// Sandbox IPC handlers
ipcMain.handle('sandbox.getStatus', async () => {
  try {
    const adapter = getSandboxAdapter();
    const platform = process.platform;

    if (platform === 'win32') {
      const wslStatus = await WSLBridge.checkWSLStatus();
      return {
        platform: 'win32',
        mode: adapter.initialized ? adapter.mode : 'none',
        initialized: adapter.initialized,
        wsl: wslStatus,
        lima: null,
      };
    } else if (platform === 'darwin') {
      const limaStatus = await LimaBridge.checkLimaStatus();
      return {
        platform: 'darwin',
        mode: adapter.initialized ? adapter.mode : 'native',
        initialized: adapter.initialized,
        wsl: null,
        lima: limaStatus,
      };
    } else {
      return {
        platform,
        mode: adapter.initialized ? adapter.mode : 'native',
        initialized: adapter.initialized,
        wsl: null,
        lima: null,
      };
    }
  } catch (error) {
    logError('[Sandbox] Error getting status:', error);
    return {
      platform: process.platform,
      mode: 'none',
      initialized: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

// WSL IPC handlers (Windows)
ipcMain.handle('sandbox.checkWSL', async () => {
  try {
    return await WSLBridge.checkWSLStatus();
  } catch (error) {
    logError('[Sandbox] Error checking WSL:', error);
    return { available: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('sandbox.installNodeInWSL', async (_event, distro: string) => {
  try {
    return await WSLBridge.installNodeInWSL(distro);
  } catch (error) {
    logError('[Sandbox] Error installing Node.js:', error);
    return false;
  }
});

ipcMain.handle('sandbox.installPythonInWSL', async (_event, distro: string) => {
  try {
    return await WSLBridge.installPythonInWSL(distro);
  } catch (error) {
    logError('[Sandbox] Error installing Python:', error);
    return false;
  }
});

// Lima IPC handlers (macOS)
ipcMain.handle('sandbox.checkLima', async () => {
  try {
    return await LimaBridge.checkLimaStatus();
  } catch (error) {
    logError('[Sandbox] Error checking Lima:', error);
    return { available: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('sandbox.createLimaInstance', async () => {
  try {
    return await LimaBridge.createLimaInstance();
  } catch (error) {
    logError('[Sandbox] Error creating Lima instance:', error);
    return false;
  }
});

ipcMain.handle('sandbox.startLimaInstance', async () => {
  try {
    return await LimaBridge.startLimaInstance();
  } catch (error) {
    logError('[Sandbox] Error starting Lima instance:', error);
    return false;
  }
});

ipcMain.handle('sandbox.stopLimaInstance', async () => {
  try {
    return await LimaBridge.stopLimaInstance();
  } catch (error) {
    logError('[Sandbox] Error stopping Lima instance:', error);
    return false;
  }
});

ipcMain.handle('sandbox.installNodeInLima', async () => {
  try {
    return await LimaBridge.installNodeInLima();
  } catch (error) {
    logError('[Sandbox] Error installing Node.js in Lima:', error);
    return false;
  }
});

ipcMain.handle('sandbox.installPythonInLima', async () => {
  try {
    return await LimaBridge.installPythonInLima();
  } catch (error) {
    logError('[Sandbox] Error installing Python in Lima:', error);
    return false;
  }
});

// Logs IPC handlers
ipcMain.handle('logs.getPath', () => {
  try {
    return getLogFilePath();
  } catch (error) {
    logError('[Logs] Error getting log path:', error);
    return null;
  }
});

ipcMain.handle('logs.getDirectory', () => {
  try {
    return getLogsDirectory();
  } catch (error) {
    logError('[Logs] Error getting logs directory:', error);
    return null;
  }
});

ipcMain.handle('logs.getAll', () => {
  try {
    return getAllLogFiles();
  } catch (error) {
    logError('[Logs] Error getting all log files:', error);
    return [];
  }
});

ipcMain.handle('logs.export', async () => {
  try {
    const logFiles = getAllLogFiles();
    const diagnosticsSummary = buildDiagnosticsSummary({
      app: {
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
      },
      runtime: {
        currentWorkingDir,
        logsDirectory: getLogsDirectory(),
        logFileCount: logFiles.length,
        totalLogSizeBytes: logFiles.reduce((total, file) => total + file.size, 0),
        devLogsEnabled: isDevLogsEnabled(),
      },
      config: {
        provider: configStore.get('provider'),
        model: configStore.get('model'),
        baseUrl: sanitizeDiagnosticBaseUrl(configStore.get('baseUrl') || undefined),
        customProtocol: configStore.get('customProtocol') || null,
        sandboxEnabled: !!configStore.get('sandboxEnabled'),
        thinkingEnabled: !!configStore.get('enableThinking'),
        apiKeyConfigured: !!configStore.get('apiKey'),
        claudeCodePathConfigured: !!configStore.get('claudeCodePath'),
        defaultWorkdir: configStore.get('defaultWorkdir') || null,
        globalSkillsPathConfigured: !!configStore.get('globalSkillsPath'),
      },
      sandbox: {
        mode: getSandboxAdapter().mode,
        initialized: getSandboxAdapter().initialized,
      },
      sessions: sessionManager ? sessionManager.listSessions() : [],
      logFiles,
      deps: {
        getMessages: (sessionId: string) =>
          sessionManager ? sessionManager.getMessages(sessionId) : [],
        getTraceSteps: (sessionId: string) =>
          sessionManager ? sessionManager.getTraceSteps(sessionId) : [],
      },
    });

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Logs',
      defaultPath: `opencowork-logs-${new Date().toISOString().split('T')[0]}.zip`,
      filters: [
        { name: 'ZIP Archive', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'User cancelled' };
    }

    // Dynamic import archiver
    const archiver = await import('archiver');
    const output = fs.createWriteStream(result.filePath);
    const archive = archiver.default('zip', { zlib: { level: 9 } });

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: {
        success: boolean;
        path?: string;
        size?: number;
        error?: string;
      }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      output.on('close', () => {
        log('[Logs] Exported logs to:', result.filePath);
        settle({
          success: true,
          path: result.filePath,
          size: archive.pointer(),
        });
      });

      output.on('error', (err: Error) => {
        logError('[Logs] Error writing exported archive:', err);
        settle({ success: false, error: err.message });
      });

      archive.on('error', (err: Error) => {
        logError('[Logs] Error creating archive:', err);
        settle({ success: false, error: err.message });
      });

      archive.pipe(output);

      // Add all log files
      for (const logFile of logFiles) {
        archive.file(logFile.path, { name: logFile.name });
      }

      // Add system info
      const systemInfo = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appVersion: app.getVersion(),
        exportDate: new Date().toISOString(),
        logFiles: logFiles.map((f) => ({
          name: f.name,
          size: f.size,
          modified: f.mtime,
        })),
      };
      archive.append(JSON.stringify(systemInfo, null, 2), { name: 'system-info.json' });
      archive.append(JSON.stringify(diagnosticsSummary, null, 2), {
        name: 'diagnostics-summary.json',
      });
      archive.append(
        [
          'Open Cowork diagnostic bundle',
          `Exported at: ${diagnosticsSummary.exportedAt}`,
          '',
          'Included files:',
          '- Application log files (*.log)',
          '- system-info.json',
          '- diagnostics-summary.json',
          '',
          'diagnostics-summary.json contains a redacted runtime/config snapshot,',
          'plus metadata-only session summaries and recent error traces to speed up debugging.',
        ].join('\n'),
        { name: 'README.txt' }
      );

      archive.finalize();
    });
  } catch (error) {
    logError('[Logs] Error exporting logs:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('logs.open', async () => {
  try {
    const logsDir = getLogsDirectory();
    await shell.openPath(logsDir);
    return { success: true };
  } catch (error) {
    logError('[Logs] Error opening logs directory:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('logs.clear', async () => {
  try {
    const logFiles = getAllLogFiles();

    // Close current log file
    closeLogFile();

    // Delete all log files
    for (const logFile of logFiles) {
      try {
        fs.unlinkSync(logFile.path);
        log('[Logs] Deleted log file:', logFile.name);
      } catch (err) {
        logError('[Logs] Failed to delete log file:', logFile.name, err);
      }
    }

    // Log will automatically reinitialize on next log call
    log('[Logs] Log files cleared and reinitialized');

    return { success: true, deletedCount: logFiles.length };
  } catch (error) {
    logError('[Logs] Error clearing logs:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('logs.setEnabled', async (_event, enabled: boolean) => {
  try {
    setDevLogsEnabled(enabled);
    configStore.set('enableDevLogs', enabled);
    log('[Logs] Developer logs', enabled ? 'enabled' : 'disabled');
    return { success: true, enabled };
  } catch (error) {
    logError('[Logs] Error setting dev logs enabled:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('logs.isEnabled', () => {
  try {
    return { success: true, enabled: isDevLogsEnabled() };
  } catch (error) {
    logError('[Logs] Error getting dev logs enabled:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

// ============================================================================
// Chat Export IPC
// ============================================================================

ipcMain.handle(
  'chat.exportMarkdown',
  async (
    _event,
    request: {
      sessionId: string;
      messageIds?: string[];
      options?: Partial<import('./chat/export-markdown').ExportOptions>;
    }
  ) => {
    const { exportChatToMarkdown } = await import('./chat/export-markdown');

    const getSession = (sessionId: string) => {
      if (!sessionManager) return undefined;
      const sessions = sessionManager.listSessions();
      return sessions.find((s) => s.id === sessionId);
    };

    const getMessages = (sessionId: string) => {
      if (!sessionManager) return [];
      return sessionManager.getMessages(sessionId);
    };

    return exportChatToMarkdown(request, getSession, getMessages);
  }
);

// ============================================================================
// 远程控制 IPC 处理
// ============================================================================

ipcMain.handle('remote.getConfig', () => {
  try {
    return remoteConfigStore.getAll();
  } catch (error) {
    logError('[Remote] Error getting config:', error);
    return null;
  }
});

ipcMain.handle('remote.getStatus', () => {
  try {
    return remoteManager.getStatus();
  } catch (error) {
    logError('[Remote] Error getting status:', error);
    return { running: false, channels: [], activeSessions: 0, pendingPairings: 0 };
  }
});

ipcMain.handle('remote.setEnabled', async (_event, enabled: boolean) => {
  try {
    remoteConfigStore.setEnabled(enabled);

    if (enabled) {
      await remoteManager.start();
    } else {
      await remoteManager.stop();
    }

    return { success: true };
  } catch (error) {
    logError('[Remote] Error setting enabled:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.updateGatewayConfig', async (_event, config: Partial<GatewayConfig>) => {
  try {
    await remoteManager.updateGatewayConfig(config);
    return { success: true };
  } catch (error) {
    logError('[Remote] Error updating gateway config:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.updateFeishuConfig', async (_event, config: FeishuChannelConfig) => {
  try {
    await remoteManager.updateFeishuConfig(config);
    return { success: true };
  } catch (error) {
    logError('[Remote] Error updating Feishu config:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.getPairedUsers', () => {
  try {
    return remoteManager.getPairedUsers();
  } catch (error) {
    logError('[Remote] Error getting paired users:', error);
    return [];
  }
});

ipcMain.handle('remote.getPendingPairings', () => {
  try {
    return remoteManager.getPendingPairings();
  } catch (error) {
    logError('[Remote] Error getting pending pairings:', error);
    return [];
  }
});

ipcMain.handle('remote.approvePairing', (_event, channelType: ChannelType, userId: string) => {
  try {
    const success = remoteManager.approvePairing(channelType, userId);
    return { success };
  } catch (error) {
    logError('[Remote] Error approving pairing:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.revokePairing', (_event, channelType: ChannelType, userId: string) => {
  try {
    const success = remoteManager.revokePairing(channelType, userId);
    return { success };
  } catch (error) {
    logError('[Remote] Error revoking pairing:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.rejectPairing', (_event, channelType: ChannelType, userId: string) => {
  try {
    const success = remoteManager.rejectPairing(channelType, userId);
    return { success };
  } catch (error) {
    logError('[Remote] Error rejecting pairing:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.getRemoteSessions', () => {
  try {
    return remoteManager.getRemoteSessions();
  } catch (error) {
    logError('[Remote] Error getting remote sessions:', error);
    return [];
  }
});

ipcMain.handle('remote.clearRemoteSession', (_event, sessionId: string) => {
  try {
    const success = remoteManager.clearRemoteSession(sessionId);
    return { success };
  } catch (error) {
    logError('[Remote] Error clearing remote session:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.getTunnelStatus', () => {
  try {
    return remoteManager.getTunnelStatus();
  } catch (error) {
    logError('[Remote] Error getting tunnel status:', error);
    return { connected: false, url: null, provider: 'none' };
  }
});

ipcMain.handle('remote.getWebhookUrl', () => {
  try {
    return remoteManager.getFeishuWebhookUrl();
  } catch (error) {
    logError('[Remote] Error getting webhook URL:', error);
    return null;
  }
});

ipcMain.handle('remote.restart', async () => {
  try {
    await remoteManager.restart();
    return { success: true };
  } catch (error) {
    logError('[Remote] Error restarting:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('schedule.list', () => {
  try {
    if (!scheduledTaskManager) return [];
    return scheduledTaskManager.list();
  } catch (error) {
    logError('[Schedule] Error listing tasks:', error);
    return [];
  }
});

ipcMain.handle('schedule.create', async (_event, payload: ScheduledTaskCreateInput) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  const unsupportedReason = getWorkspacePathUnsupportedReason(payload.cwd);
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }
  const normalizedPrompt = payload.prompt.trim();
  const title = await resolveScheduledTaskTitle(normalizedPrompt, payload.cwd, payload.title);
  return scheduledTaskManager.create({
    ...payload,
    prompt: normalizedPrompt,
    title,
  });
});

ipcMain.handle('schedule.update', async (_event, id: string, updates: ScheduledTaskUpdateInput) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  const existing = scheduledTaskManager.get(id);
  if (!existing) return null;
  const nextCwd = updates.cwd ?? existing.cwd;
  const unsupportedReason = getWorkspacePathUnsupportedReason(nextCwd);
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }
  const normalizedPrompt = updates.prompt === undefined ? existing.prompt : updates.prompt.trim();
  const normalizedUpdates: ScheduledTaskUpdateInput = {
    ...updates,
    prompt: normalizedPrompt,
  };

  if (updates.prompt !== undefined) {
    normalizedUpdates.title = await resolveScheduledTaskTitle(
      normalizedPrompt,
      updates.cwd ?? existing.cwd,
      updates.title ?? existing.title
    );
  } else if (updates.title !== undefined) {
    normalizedUpdates.title = buildScheduledTaskTitle(updates.title);
  }

  return scheduledTaskManager.update(id, normalizedUpdates);
});

ipcMain.handle('schedule.delete', (_event, id: string) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  return { success: scheduledTaskManager.delete(id) };
});

ipcMain.handle('schedule.toggle', (_event, id: string, enabled: boolean) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  return scheduledTaskManager.toggle(id, enabled);
});

ipcMain.handle('schedule.runNow', async (_event, id: string) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  return scheduledTaskManager.runNow(id);
});

ipcMain.handle('schedule.getHistory', (_event, taskId: string) => {
  try {
    const db = getDatabase();
    const runStore = createScheduledTaskRunStore(db);
    return runStore.getByTaskId(taskId);
  } catch (error) {
    logError('[Schedule] Error getting run history:', error);
    return [];
  }
});

ipcMain.handle('memory.getOverview', (_event, cwd?: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.getOverview(cwd);
});

ipcMain.handle('memory.getPanelState', (_event, cwd?: string, sessionId?: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  const overview = memoryService.getOverview(cwd);
  // When cwd is available, show workspace-filtered entries (what gets injected).
  // When cwd is missing, show all entries so user can still manage them.
  const coreEntries = cwd
    ? memoryService.getCoreEntriesForWorkspace(cwd)
    : memoryService.getCoreEntries();

  // Determine cowork-memory skill state
  let skillFallbackEnabled = false;
  if (skillsManager) {
    const skill = skillsManager.getAllSkills().find((s) => s.id === COWORK_MEMORY_SKILL_ID);
    skillFallbackEnabled = skill?.enabled ?? false;
  }

  return {
    enabled: overview.enabled,
    skillFallbackEnabled,
    coreEntries: coreEntries.map((e) => ({
      category: e.category || 'other',
      key: e.key,
      value: e.value,
      combinedKey: e.combinedKey || `${e.category || 'other'}.${e.key}`,
    })),
    workspaceStats: overview.currentWorkspace
      ? {
          name: cwd ? cwd.split('/').pop() || cwd : '',
          sessionCount: overview.currentWorkspace.experienceSessionCount,
          chunkCount: overview.currentWorkspace.experienceChunkCount,
          lastIngestedAt: overview.latestIngestionAt,
        }
      : null,
    totalStats: {
      coreCount: overview.coreCount,
      sessionCount: overview.experienceSessionCount,
      chunkCount: overview.experienceChunkCount,
      workspaceCount: overview.sourceWorkspaceCount,
    },
    lastRetrieval: memoryService.getLastRetrievalMetrics(sessionId || undefined),
  };
});

ipcMain.handle(
  'memory.search',
  (
    _event,
    payload: {
      query: string;
      cwd?: string;
      sourceWorkspace?: string | null;
      scope?: 'workspace' | 'global' | 'all';
      limit?: number;
    }
  ) => {
    if (!memoryService) {
      throw new Error('Memory service not initialized');
    }
    return memoryService.search(payload);
  }
);

ipcMain.handle('memory.read', (_event, id: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.read(id);
});

ipcMain.handle('memory.rebuildWorkspace', async (_event, cwd: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.rebuildWorkspace(cwd);
});

ipcMain.handle('memory.clearWorkspace', (_event, cwd: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.clearWorkspace(cwd);
});

ipcMain.handle('memory.clearCoreMemory', () => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.clearCoreMemory();
});

ipcMain.handle('memory.dismissIngestionErrors', () => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.dismissIngestionErrors();
});

ipcMain.handle('memory.deleteCoreEntry', (_event, combinedKey: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  if (typeof combinedKey !== 'string' || !combinedKey.trim()) {
    return { success: false };
  }
  if (combinedKey.length > 200 || /[/\\<>]/.test(combinedKey)) {
    return { success: false };
  }
  try {
    return memoryService.deleteCoreEntry(combinedKey.trim());
  } catch {
    return { success: false };
  }
});
ipcMain.handle('memory.updateCoreEntry', (_event, combinedKey: string, newValue: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  if (typeof combinedKey !== 'string' || !combinedKey.trim()) {
    return { success: false };
  }
  if (typeof newValue !== 'string' || !newValue.trim()) {
    return { success: false };
  }
  // Limit value length to prevent abuse
  if (newValue.length > 1000) {
    return { success: false };
  }
  // Validate combinedKey format (category.key or plain key)
  if (combinedKey.length > 200 || /[/\\<>]/.test(combinedKey)) {
    return { success: false };
  }
  try {
    return memoryService.updateCoreEntry(combinedKey.trim(), newValue.trim());
  } catch {
    return { success: false };
  }
});

ipcMain.handle('memory.rebuildAll', async () => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.rebuildAll();
});

ipcMain.handle('memory.listFiles', () => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.listFiles();
});

ipcMain.handle('memory.readFile', (_event, filePath: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.readFile(filePath);
});

ipcMain.handle('memory.inspectSession', (_event, sessionId: string, workspaceKey?: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.inspectSession(sessionId, workspaceKey);
});

ipcMain.handle('memory.getBuiltinExtractionPrompt', () => {
  return CORE_MEMORY_UPDATE_SYSTEM_PROMPT;
});

ipcMain.handle('memory.getCustomExtractionPrompt', () => {
  const promptPath = resolveMemoryPromptPath();
  if (!promptPath) return { exists: false, content: '' };
  try {
    const content = fs.readFileSync(promptPath, 'utf-8');
    return { exists: true, content };
  } catch {
    return { exists: false, content: '' };
  }
});

ipcMain.handle('memory.createCustomExtractionPrompt', () => {
  const promptPath = resolveMemoryPromptPath();
  if (!promptPath) return { success: false, reason: 'no-storage-root' };
  // Don't overwrite existing custom prompt
  if (fs.existsSync(promptPath)) {
    return { success: false, reason: 'exists' };
  }
  try {
    const dir = dirname(promptPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(promptPath, CORE_MEMORY_UPDATE_SYSTEM_PROMPT, { flag: 'wx' });
    return { success: true };
  } catch {
    return { success: false, reason: 'write-error' };
  }
});

ipcMain.handle('memory.deleteCustomExtractionPrompt', () => {
  const promptPath = resolveMemoryPromptPath();
  if (!promptPath) return { success: false };
  try {
    fs.unlinkSync(promptPath);
    return { success: true };
  } catch {
    return { success: false };
  }
});

ipcMain.handle('memory.openFileInEditor', () => {
  const promptPath = resolveMemoryPromptPath();
  if (!promptPath) return;
  shell.openPath(promptPath);
});

/**
 * Resolve the fixed prompt file path inside the memory storage root.
 * Uses the same fallback logic as MemoryService.getPaths() — if storageRoot
 * is empty, falls back to app.getPath('userData')/memory.
 */
function resolveMemoryPromptPath(): string {
  const appConfig = configStore.getAll();
  const configuredRoot = appConfig.memoryRuntime?.storageRoot?.trim();
  const storageRoot = configuredRoot || join(app.getPath('userData'), 'memory');
  return join(storageRoot, 'prompts', 'core-extraction.md');
}

ipcMain.handle('memory.setEnabled', (_event, enabled: boolean) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  const result = memoryService.setEnabled(enabled);
  sessionManager?.clearAllCachedAgentSessions();

  // Toggle cowork-memory skill based on the effective memory state (not the input),
  // so we stay in sync even if setEnabled applies a different final state.
  syncCoworkMemorySkillState(result.enabled).catch((err) => {
    logWarn('[Memory] Failed to sync cowork-memory skill state:', err);
  });

  sendToRenderer({
    type: 'config.status',
    payload: {
      isConfigured: configStore.isConfigured(),
      config: configStore.getAll(),
    },
  });
  return result;
});

ipcMain.handle('logs.write', (_event, level: 'info' | 'warn' | 'error', args: unknown[]) => {
  try {
    if (level === 'warn') {
      logWarn(...args);
    } else if (level === 'error') {
      logError(...args);
    } else {
      log(...args);
    }
    return { success: true };
  } catch (error) {
    console.error('[Logs] Error writing log:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('sandbox.retryLimaSetup', async () => {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Lima is only available on macOS' };
  }

  try {
    const bootstrap = getSandboxBootstrap();
    bootstrap.setProgressCallback((progress) => {
      sendToRenderer({
        type: 'sandbox.progress',
        payload: progress,
      });
    });

    try {
      await LimaBridge.stopLimaInstance();
    } catch (error) {
      logError('[Sandbox] Error stopping Lima before retry:', error);
    }

    bootstrap.reset();
    const result = await bootstrap.bootstrap();
    const success = !result.error;
    return { success, result, error: result.error };
  } catch (error) {
    logError('[Sandbox] Error retrying Lima setup:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

// Generic retry setup for both WSL and Lima
ipcMain.handle('sandbox.retrySetup', async () => {
  try {
    const bootstrap = getSandboxBootstrap();
    bootstrap.setProgressCallback((progress) => {
      sendToRenderer({
        type: 'sandbox.progress',
        payload: progress,
      });
    });

    // Reset and re-run bootstrap
    bootstrap.reset();
    const result = await bootstrap.bootstrap();
    const success = !result.error;
    return { success, result, error: result.error };
  } catch (error) {
    logError('[Sandbox] Error retrying setup:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

/**
 * Strip known skill source prefixes (builtin-, global-, configured-, project-)
 * to get the bare directory name for filesystem comparison.
 * If no known prefix is found, returns the ID unchanged.
 */
function stripKnownPrefix(skillId: string): string {
  const KNOWN_PREFIXES = ['builtin-', 'global-', 'configured-', 'project-'];
  for (const prefix of KNOWN_PREFIXES) {
    if (skillId.startsWith(prefix)) {
      return skillId.substring(prefix.length);
    }
  }
  return skillId;
}

async function handleClientEvent(event: ClientEvent): Promise<unknown> {
  // Check if configured before starting sessions
  if (event.type === 'session.start' && !configStore.hasUsableCredentialsForActiveSet()) {
    sendToRenderer({
      type: 'error',
      payload: {
        message: '当前方案未配置可用凭证，请先在 API 设置中完成配置',
        code: 'CONFIG_REQUIRED_ACTIVE_SET',
        action: 'open_api_settings',
      },
    });
    return null;
  }

  if (eventRequiresSessionManager(event) && !sessionManager) {
    throw new Error('Session manager not initialized');
  }
  // After the guard above, sessionManager is guaranteed non-null for session.* events.
  // Use a local alias to satisfy TypeScript's control-flow narrowing.
  const sm = sessionManager!;

  switch (event.type) {
    case 'session.start':
      if (getWorkspacePathUnsupportedReason(event.payload.cwd)) {
        sendToRenderer({
          type: 'error',
          payload: {
            message: getWorkspacePathUnsupportedReason(event.payload.cwd)!,
          },
        });
        return null;
      }
      {
        // Validate initialPinnedSkills against actual installed+enabled skills
        // (same validation as skills.toggleSessionPin IPC handler)
        let validatedPinnedSkills = event.payload.initialPinnedSkills;
        if (validatedPinnedSkills && validatedPinnedSkills.length > 0 && skillsManager) {
          const allSkills = skillsManager.getAllSkills();
          const enabledSkillIds = new Set(allSkills.filter((s) => s.enabled).map((s) => s.id));
          validatedPinnedSkills = validatedPinnedSkills.filter((id) => enabledSkillIds.has(id));
        }

        // Load workspace skills profile to seed session state if no explicit values provided.
        // The cwd was already validated above via getWorkspacePathUnsupportedReason().
        // We can safely load the profile from it without re-validating against session list.
        let effectivePinnedSkills = validatedPinnedSkills;
        // Validate initialDisabledSkills immediately (runtime IPC boundary protection)
        let effectiveDisabledSkills: string[] | undefined;
        if (Array.isArray(event.payload.initialDisabledSkills)) {
          effectiveDisabledSkills = event.payload.initialDisabledSkills;
        }
        if (event.payload.cwd && (!effectivePinnedSkills || !effectiveDisabledSkills)) {
          try {
            const { loadSkillsWorkspaceProfile } =
              await import('./skills/skills-workspace-profile');
            // loadSkillsWorkspaceProfile has its own security checks (lstat, symlink
            // rejection, size limit, realpath boundary verification)
            const profile = loadSkillsWorkspaceProfile(event.payload.cwd);
            if (profile) {
              if (!effectivePinnedSkills && profile.pinned?.length) {
                // Validate workspace profile pinned skills against installed skills
                if (skillsManager) {
                  const allSkills = skillsManager.getAllSkills();
                  const enabledSkillIds = new Set(
                    allSkills.filter((s) => s.enabled).map((s) => s.id)
                  );
                  effectivePinnedSkills = profile.pinned.filter((id) => enabledSkillIds.has(id));
                } else {
                  effectivePinnedSkills = profile.pinned;
                }
              }
              if (!effectiveDisabledSkills && profile.disabled?.length) {
                effectiveDisabledSkills = profile.disabled;
              }
            }
          } catch (err) {
            logWarn('[Session] Failed to load workspace skills profile:', err);
          }
        }

        // Runtime validation for initialDisabledSkills
        if (effectiveDisabledSkills) {
          const { isValidSkillId: isValidId } = await import('../shared/skill-pinning-constants');
          const MAX_INITIAL_DISABLED = 200;
          effectiveDisabledSkills = effectiveDisabledSkills
            .filter((id): id is string => typeof id === 'string' && isValidId(id))
            .slice(0, MAX_INITIAL_DISABLED);
        }

        // Enforce pinned-wins-over-disabled: remove pinned skills from disabled set.
        // Uses canonicalized comparison to handle both prefixed IDs and bare names.
        if (effectivePinnedSkills?.length && effectiveDisabledSkills?.length) {
          const pinnedBareNames = new Set<string>();
          for (const id of effectivePinnedSkills) {
            pinnedBareNames.add(id);
            pinnedBareNames.add(stripKnownPrefix(id));
          }
          effectiveDisabledSkills = effectiveDisabledSkills.filter((id) => {
            return !pinnedBareNames.has(id) && !pinnedBareNames.has(stripKnownPrefix(id));
          });
        }

        const session = await sm.startSession(
          event.payload.title,
          event.payload.prompt,
          event.payload.cwd,
          event.payload.allowedTools,
          event.payload.content,
          event.payload.memoryEnabled,
          event.payload.initialDisabledMcpServers,
          effectivePinnedSkills,
          effectiveDisabledSkills
        );
        return session;
      }

    case 'session.continue':
      return sm.continueSession(
        event.payload.sessionId,
        event.payload.prompt,
        event.payload.content
      );

    case 'session.stop':
      return sm.stopSession(event.payload.sessionId);

    case 'session.delete':
      return sm.deleteSession(event.payload.sessionId);

    case 'session.batchDelete':
      return sm.batchDeleteSessions(event.payload.sessionIds);

    case 'session.list': {
      const sessions = sm.listSessions();
      sendToRenderer({ type: 'session.list', payload: { sessions } });
      return sessions;
    }

    case 'session.getMessages':
      return sm.getMessages(event.payload.sessionId);

    case 'session.getTraceSteps':
      return sm.getTraceSteps(event.payload.sessionId);

    case 'permission.response':
      return sm.handlePermissionResponse(
        event.payload.toolUseId,
        event.payload.result,
        event.payload.suggestion
      );

    case 'sudo.password.response':
      return sm.handleSudoPasswordResponse(event.payload.toolUseId, event.payload.password);

    case 'folder.select': {
      const folderResult = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
      });
      if (!folderResult.canceled && folderResult.filePaths.length > 0) {
        sendToRenderer({
          type: 'folder.selected',
          payload: { path: folderResult.filePaths[0] },
        });
        return folderResult.filePaths[0];
      }
      return null;
    }

    case 'workdir.get':
      return getWorkingDir();

    case 'workdir.set':
      return setWorkingDir(event.payload.path, event.payload.sessionId);

    case 'workdir.select': {
      const dialogDefaultPath =
        event.payload.currentPath && isAbsolute(event.payload.currentPath)
          ? event.payload.currentPath
          : currentWorkingDir || undefined;
      const workdirResult = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: 'Select Working Directory',
        defaultPath: dialogDefaultPath,
      });
      if (!workdirResult.canceled && workdirResult.filePaths.length > 0) {
        const selectedPath = workdirResult.filePaths[0];
        return setWorkingDir(selectedPath, event.payload.sessionId);
      }
      return { success: false, path: '', error: 'User cancelled' };
    }

    case 'settings.update':
      if (
        event.payload.theme === 'dark' ||
        event.payload.theme === 'light' ||
        event.payload.theme === 'system'
      ) {
        const nextTheme = event.payload.theme as AppTheme;
        configStore.update({ theme: nextTheme });
        applyNativeThemePreference(nextTheme);
        if (mainWindow && !mainWindow.isDestroyed()) {
          const effectiveTheme = resolveEffectiveTheme(nextTheme);
          mainWindow.setBackgroundColor(effectiveTheme === 'dark' ? DARK_BG : LIGHT_BG);
        }
        sendToRenderer({
          type: 'config.status',
          payload: {
            isConfigured: configStore.isConfigured(),
            config: configStore.getAll(),
          },
        });
      }

      if ('systemPromptFile' in event.payload) {
        const raw = (event.payload as { systemPromptFile?: unknown }).systemPromptFile;
        if (isValidSystemPromptFileChoice(raw)) {
          configStore.update({ systemPromptFile: raw });
          sendToRenderer({
            type: 'config.status',
            payload: {
              isConfigured: configStore.isConfigured(),
              config: configStore.getAll(),
            },
          });
        } else {
          logWarn('[settings.update] Ignored invalid systemPromptFile value:', raw);
        }
      }

      // Scheduler settings — validate and persist to configStore, then
      // broadcast updated config so the renderer stays in sync.
      if (event.payload && typeof event.payload === 'object') {
        const hasOwn = (key: string): boolean =>
          Object.prototype.hasOwnProperty.call(event.payload, key);
        const schedulerUpdates: Partial<{
          schedulerCatchUpPolicy: 'skip' | 'run-once' | 'run-all' | 'ask';
          schedulerConflictPolicy: 'queue' | 'skip-if-busy';
          schedulerRunHistoryDepth: number;
        }> = {};

        if (hasOwn('schedulerCatchUpPolicy')) {
          const val = (event.payload as Record<string, unknown>).schedulerCatchUpPolicy;
          if (val === 'skip' || val === 'run-once' || val === 'run-all' || val === 'ask') {
            schedulerUpdates.schedulerCatchUpPolicy = val;
          }
        }
        if (hasOwn('schedulerConflictPolicy')) {
          const val = (event.payload as Record<string, unknown>).schedulerConflictPolicy;
          if (val === 'queue' || val === 'skip-if-busy') {
            schedulerUpdates.schedulerConflictPolicy = val;
          }
        }
        if (hasOwn('schedulerRunHistoryDepth')) {
          const val = (event.payload as Record<string, unknown>).schedulerRunHistoryDepth;
          if (typeof val === 'number' && Number.isFinite(val) && val >= 1 && val <= 100) {
            schedulerUpdates.schedulerRunHistoryDepth = Math.floor(val);
          }
        }

        if (Object.keys(schedulerUpdates).length > 0) {
          configStore.update(schedulerUpdates);
          sendToRenderer({
            type: 'config.status',
            payload: {
              isConfigured: configStore.isConfigured(),
              config: configStore.getAll(),
            },
          });
        }

        // Permission timeout setting
        const hasOwnPerm = (key: string): boolean =>
          Object.prototype.hasOwnProperty.call(event.payload, key);
        if (hasOwnPerm('permissionTimeoutSeconds')) {
          const val = (event.payload as Record<string, unknown>).permissionTimeoutSeconds;
          if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
            const normalized = val <= 0 ? 0 : Math.max(10, Math.min(3600, Math.floor(val)));
            configStore.update({ permissionTimeoutSeconds: normalized });
            sendToRenderer({
              type: 'config.status',
              payload: {
                isConfigured: configStore.isConfigured(),
                config: configStore.getAll(),
              },
            });
          }
        }

        // MCP tool timeout setting
        if (hasOwnPerm('mcpToolTimeoutSeconds')) {
          const val = (event.payload as Record<string, unknown>).mcpToolTimeoutSeconds;
          if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
            const normalized = val <= 0 ? 0 : Math.max(10, Math.min(600, Math.floor(val)));
            configStore.update({ mcpToolTimeoutSeconds: normalized });
            sendToRenderer({
              type: 'config.status',
              payload: {
                isConfigured: configStore.isConfigured(),
                config: configStore.getAll(),
              },
            });
          }
        }

        // Notifications toggle
        if (hasOwnPerm('notificationsEnabled')) {
          const val = (event.payload as Record<string, unknown>).notificationsEnabled;
          if (typeof val === 'boolean') {
            configStore.update({ notificationsEnabled: val });
            sendToRenderer({
              type: 'config.status',
              payload: {
                isConfigured: configStore.isConfigured(),
                config: configStore.getAll(),
              },
            });
          }
        }
      }

      // Permission-related settings are gated behind a single object-guard
      // so a malformed IPC message (null payload, primitive payload) can
      // never throw inside the property checks below. Each sub-block
      // decides independently whether the payload carries its field.
      // We use `Object.prototype.hasOwnProperty.call` instead of the `in`
      // operator so an inherited / prototype-chain property can never be
      // mistaken for an intentional update at this trust boundary.
      if (event.payload && typeof event.payload === 'object') {
        const payload = event.payload as {
          permissionRules?: unknown;
          bashTrustedCommands?: unknown;
          bashDenylist?: unknown;
        };
        const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(payload, key);

        if (Array.isArray(payload.permissionRules)) {
          setPermissionRules(payload.permissionRules);
        }

        // Bash trust list and denylist. Normalize ONCE at the IPC boundary
        // using the shared sanitizer, then feed the normalized arrays to
        // both the runtime policy cache and configStore. This guarantees
        // the two stay consistent and that no untrusted value crosses into
        // persistent storage, addressing a prior review finding.
        if (hasOwn('bashTrustedCommands') || hasOwn('bashDenylist')) {
          const trustedNext = hasOwn('bashTrustedCommands')
            ? sanitizeBashCommandList(payload.bashTrustedCommands)
            : undefined;
          const deniedNext = hasOwn('bashDenylist')
            ? sanitizeBashCommandList(payload.bashDenylist)
            : undefined;

          setBashCommandLists(trustedNext, deniedNext);

          const persistPayload: Partial<{
            bashTrustedCommands: string[];
            bashDenylist: string[];
          }> = {};
          if (trustedNext !== undefined) persistPayload.bashTrustedCommands = trustedNext;
          if (deniedNext !== undefined) persistPayload.bashDenylist = deniedNext;
          if (Object.keys(persistPayload).length > 0) {
            configStore.update(persistPayload);
          }
        }
      }
      return null;

    case 'scheduled-task.catch-up-response':
      if (scheduledTaskManager && Array.isArray(event.payload?.decisions)) {
        scheduledTaskManager.resolveCatchUp(event.payload.decisions);
      }
      return null;

    case 'prompt.getSections':
      // Invalidate cache to pick up external file edits (e.g. via "Open folder")
      invalidatePromptCache();
      return loadPromptSections();

    case 'prompt.updateSection':
      if (event.payload?.filename && typeof event.payload.content === 'string') {
        return updatePromptSection(event.payload.filename, event.payload.content);
      }
      return { success: false, error: 'Invalid payload: filename and content required' };

    case 'prompt.resetSection':
      if (event.payload?.filename) {
        return resetPromptSection(event.payload.filename);
      }
      return { success: false, error: 'Invalid payload: filename required' };

    case 'prompt.toggleSection':
      if (event.payload?.filename && typeof event.payload.enabled === 'boolean') {
        return togglePromptSection(event.payload.filename, event.payload.enabled);
      }
      return { success: false, error: 'Invalid payload: filename and enabled required' };

    case 'prompt.getDir':
      return openPromptsDir();

    case 'prompt.resetAll':
      return resetAllPromptSections();

    default:
      logWarn('Unknown event type:', event);
      return null;
  }
}
