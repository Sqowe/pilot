import { Suspense, lazy, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from './store';
import {
  useActiveSessionId,
  useSettings,
  useSystemDarkMode,
  useSettingsState,
  useLayoutState,
  useConfigModalState,
  useGlobalNotice,
  useSandboxSetupState,
  useSandboxSyncStatus,
  usePendingDialogs,
} from './store/selectors';
import { useIPC } from './hooks/useIPC';
import { useWindowSize } from './hooks/useWindowSize';
import { Sidebar } from './components/Sidebar';
import { WelcomeView } from './components/WelcomeView';
import { PermissionDialog } from './components/PermissionDialog';
import { SudoPasswordDialog } from './components/SudoPasswordDialog';
import { Titlebar } from './components/Titlebar';
import { SandboxSetupDialog } from './components/SandboxSetupDialog';
import { SandboxSyncToast } from './components/SandboxSyncToast';
import { GlobalNoticeToast } from './components/GlobalNoticeToast';
import { WorkspaceOrphanCleanupModal } from './components/WorkspaceOrphanCleanupModal';
import { PanelErrorBoundary } from './components/PanelErrorBoundary';
import type { GlobalNoticeAction } from './store';

const ChatView = lazy(() =>
  import('./components/ChatView').then((module) => ({ default: module.ChatView }))
);
const ContextPanel = lazy(() =>
  import('./components/ContextPanel').then((module) => ({ default: module.ContextPanel }))
);
const ConfigModal = lazy(() =>
  import('./components/ConfigModal').then((module) => ({ default: module.ConfigModal }))
);
const SettingsPanel = lazy(() =>
  import('./components/SettingsPanel').then((module) => ({ default: module.SettingsPanel }))
);

function MainPanelFallback() {
  return (
    <div className="flex-1 min-h-0 bg-background px-6 py-6">
      <div className="h-full rounded-[1.75rem] border border-border-subtle bg-background/70" />
    </div>
  );
}

function ContextPanelFallback() {
  return (
    <div
      className="hidden xl:block w-[340px] shrink-0 border-l border-border-subtle bg-background/60"
      aria-hidden="true"
    />
  );
}

function App() {
  // --- Store state via selectors (each subscription is minimally scoped) ---
  const activeSessionId = useActiveSessionId();
  const settings = useSettings();
  const systemDarkMode = useSystemDarkMode();
  const { showSettings } = useSettingsState();
  const { sidebarCollapsed } = useLayoutState();
  const { showConfigModal, isConfigured } = useConfigModalState();
  // The first-run wizard holds a copy of the settings state of its own, as the
  // Settings panel does. Settings is not drawn under it — whatever asks for it
  // meanwhile, and the menu shortcut can — so there are never two live copies,
  // one of them missing what the other has just saved. It is drawn, from what
  // main then holds, once the wizard has closed. Everything that follows
  // "Settings is open" follows this, so nothing moves under the wizard either.
  const settingsOnScreen = showSettings && !showConfigModal;
  const globalNotice = useGlobalNotice();
  const workspaceOrphans = useAppStore((s) => s.workspaceOrphans);
  const showOrphanCleanup = useAppStore((s) => s.showOrphanCleanup);
  const { progress: sandboxSetupProgress, isComplete: isSandboxSetupComplete } =
    useSandboxSetupState();
  const sandboxSyncStatus = useSandboxSyncStatus();
  const { pendingPermission, pendingSudoPassword } = usePendingDialogs();

  // Actions are still pulled directly from the store
  const setShowConfigModal = useAppStore((s) => s.setShowConfigModal);
  const clearGlobalNotice = useAppStore((s) => s.clearGlobalNotice);
  const setSandboxSetupComplete = useAppStore((s) => s.setSandboxSetupComplete);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setContextPanelCollapsed = useAppStore((s) => s.setContextPanelCollapsed);

  const { listSessions, isElectron } = useIPC();
  const { width } = useWindowSize();
  const initialized = useRef(false);
  const sidebarBeforeSettings = useRef(false);

  useEffect(() => {
    // Only run once on mount
    if (initialized.current) return;
    initialized.current = true;

    if (isElectron) {
      listSessions();
    }
  }, []); // Empty deps - run once

  // Apply theme to document root
  useEffect(() => {
    const effectiveTheme =
      settings.theme === 'system' ? (systemDarkMode ? 'dark' : 'light') : settings.theme;

    if (effectiveTheme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
  }, [settings.theme, systemDarkMode]);

  // Auto-collapse panels based on window width
  useEffect(() => {
    setContextPanelCollapsed(width < 1100);
    setSidebarCollapsed(width < 800);
  }, [width, setContextPanelCollapsed, setSidebarCollapsed]);

  // Auto-collapse sidebar when Settings is open, restore on close
  useEffect(() => {
    if (settingsOnScreen) {
      sidebarBeforeSettings.current = !sidebarCollapsed;
      setSidebarCollapsed(true);
    } else if (sidebarBeforeSettings.current) {
      setSidebarCollapsed(false);
      sidebarBeforeSettings.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOnScreen]);

  // Handle config modal close
  const handleConfigClose = useCallback(() => {
    setShowConfigModal(false);
  }, [setShowConfigModal]);

  // Handle sandbox setup complete
  const handleSandboxSetupComplete = useCallback(() => {
    setSandboxSetupComplete(true);
  }, [setSandboxSetupComplete]);

  const handleGlobalNoticeAction = useCallback(
    (action: GlobalNoticeAction) => {
      if (action === 'open_api_settings') {
        if (isConfigured) {
          // Another config set can start a chat and the active one cannot.
          // That is a config set to edit, on the tab where sets are edited.
          useAppStore.getState().setSettingsTab('modelSets');
          setShowSettings(true);
        } else {
          // Nothing is set up at all: the first-run wizard.
          setShowConfigModal(true);
        }
      } else if (action === 'navigate_settings_skills') {
        // Set the settings tab to skills so the panel opens to the right section
        useAppStore.getState().setSettingsTab('skills');
        setShowSettings(true);
      } else if (action === 'open_orphan_cleanup') {
        // Open the orphan cleanup modal
        useAppStore.getState().setShowOrphanCleanup(true);
      }
      clearGlobalNotice();
    },
    [clearGlobalNotice, isConfigured, setShowConfigModal, setShowSettings]
  );

  // Determine if we should show the sandbox setup dialog
  // Show if there's progress and setup is not complete
  const showSandboxSetup = sandboxSetupProgress && !isSandboxSetupComplete;

  return (
    <div className="h-full w-full min-h-0 flex flex-col overflow-hidden bg-background">
      {/* Titlebar - draggable region */}
      <Titlebar />

      {/* Main Content */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Sidebar */}
        <PanelErrorBoundary name="Sidebar" fallback={<div className="w-0" />}>
          <Sidebar />
        </PanelErrorBoundary>

        {/* Main Content Area */}
        <main className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-background">
          {settingsOnScreen ? (
            <PanelErrorBoundary
              name="SettingsPanel"
              resetKey="settings"
              fallback={<MainPanelFallback />}
            >
              <Suspense fallback={<MainPanelFallback />}>
                <SettingsPanel onClose={() => setShowSettings(false)} />
              </Suspense>
            </PanelErrorBoundary>
          ) : activeSessionId ? (
            <PanelErrorBoundary
              name="ChatView"
              resetKey={activeSessionId}
              fallback={<MainPanelFallback />}
            >
              <Suspense fallback={<MainPanelFallback />}>
                <ChatView />
              </Suspense>
            </PanelErrorBoundary>
          ) : (
            <WelcomeView />
          )}
        </main>

        {/* Context Panel - only show when in session and not in settings */}
        {activeSessionId && !settingsOnScreen && (
          <PanelErrorBoundary
            name="ContextPanel"
            resetKey={activeSessionId}
            fallback={<ContextPanelFallback />}
          >
            <Suspense fallback={<ContextPanelFallback />}>
              <ContextPanel />
            </Suspense>
          </PanelErrorBoundary>
        )}
      </div>

      {/* Permission Dialog */}
      {pendingPermission && <PermissionDialog permission={pendingPermission} />}

      {/* Sudo Password Dialog */}
      {pendingSudoPassword && <SudoPasswordDialog request={pendingSudoPassword} />}

      {/* Config Modal */}
      <PanelErrorBoundary name="ConfigModal" fallback={null}>
        <Suspense fallback={null}>
          <ConfigModal isOpen={showConfigModal} onClose={handleConfigClose} />
        </Suspense>
      </PanelErrorBoundary>

      {/* Sandbox Setup Dialog */}
      {showSandboxSetup && (
        <SandboxSetupDialog
          progress={sandboxSetupProgress}
          onComplete={handleSandboxSetupComplete}
        />
      )}

      {/* Sandbox Sync Toast */}
      <SandboxSyncToast status={sandboxSyncStatus} />

      <GlobalNoticeToast
        notice={globalNotice}
        onDismiss={clearGlobalNotice}
        onAction={handleGlobalNoticeAction}
      />

      {/* Workspace Orphan Cleanup Modal */}
      {showOrphanCleanup && workspaceOrphans && (
        <WorkspaceOrphanCleanupModal
          key={`orphan-modal-${workspaceOrphans.cwd}-${workspaceOrphans.totalOrphans}`}
          orphans={workspaceOrphans}
          onClose={() => useAppStore.getState().setShowOrphanCleanup(false)}
        />
      )}
    </div>
  );
}

export default App;
