/**
 * @module main/utils/native-notifications
 *
 * Cross-platform native desktop notifications for Open Cowork.
 *
 * Fires OS-level notifications (macOS UNNotification, Windows Toast, Linux libnotify)
 * only when the main window is NOT focused. Clicking a notification brings the
 * window to the foreground.
 *
 * Supported triggers:
 * - Permission request: agent needs user approval for a tool call
 * - Agent response complete: session transitions from running → idle
 */
import { Notification, BrowserWindow } from 'electron';
import { configStore } from '../config/config-store';
import { log } from './logger';

/**
 * Get the main BrowserWindow instance (first non-destroyed window).
 */
function getMainWindow(): BrowserWindow | null {
  try {
    const windows = BrowserWindow.getAllWindows();
    return windows.find((w) => !w.isDestroyed()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Check whether the app window is currently focused by the user.
 */
function isAppFocused(): boolean {
  const win = getMainWindow();
  if (!win) return false;
  try {
    return win.isFocused();
  } catch {
    return true; // Assume focused if we can't determine — avoids spurious notifications
  }
}

/**
 * Bring the main window to the foreground and focus it.
 */
function focusApp(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Show a native notification if the app is not focused and notifications are enabled.
 * Returns true if a notification was shown, false otherwise.
 */
function showNotification(title: string, body: string): boolean {
  // Check if notifications are enabled in config
  try {
    if (!configStore.get('notificationsEnabled')) {
      return false;
    }
  } catch {
    return false;
  }

  // Only notify when the window is NOT focused
  if (isAppFocused()) {
    return false;
  }

  // Check if the system supports notifications
  try {
    if (!Notification.isSupported()) {
      log('[Notifications] Native notifications not supported on this system');
      return false;
    }
  } catch {
    return false;
  }

  try {
    const notification = new Notification({
      title,
      body,
      silent: false,
    });

    notification.on('click', () => {
      focusApp();
    });

    notification.show();
    return true;
  } catch {
    return false;
  }
}

/**
 * Notify the user that a permission request is pending.
 * Called when the agent needs approval for a tool call.
 */
export function notifyPermissionRequest(toolName: string): void {
  const shown = showNotification(
    'Permission Required',
    `Tool "${toolName}" needs your approval to proceed.`
  );
  if (shown) {
    log(`[Notifications] Permission request notification shown for tool: ${toolName}`);
  }
}

/**
 * Notify the user that the agent has finished responding.
 * Called when a session transitions from running → idle.
 */
export function notifyAgentComplete(sessionTitle?: string): void {
  const body = sessionTitle
    ? `Task completed in "${sessionTitle}".`
    : 'The agent has finished responding.';
  const shown = showNotification('Task Completed', body);
  if (shown) {
    log('[Notifications] Agent complete notification shown');
  }
}
